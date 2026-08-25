import {
  newId,
  nowIso,
  type Currency,
  type IsoTimestamp,
  type SalesEventType,
  type Uuid,
} from '@am/domain';
import type { Logger } from '@am/observability';
import type { HubspotMappingDocument } from './mapping/schema';
import { amountToMinor, toCanonicalEvents } from './mapping/translate';
import type { HubspotProvider } from './provider';
import type { ChangeCursor, HubspotObjectRecord } from './provider-types';
import { mappedContactProperties, mappedDealProperties, type SyncStore } from './sync';
import type {
  CanonicalEventDraft,
  ObjectSnapshot,
  OpportunityRecord,
  ReconciliationDiscrepancy,
} from './types';

/**
 * Hourly and daily reconciliation.
 *
 * Re-reads the mapped objects, diffs them against our mirror and emits only
 * genuine transitions. A value that changes *after* CONVERTED was dispatched is
 * a reconciliation discrepancy plus a revenue adjustment — never a second event
 * (spec §22/§23).
 */

export const RECONCILE_SCOPES = ['HOURLY', 'DAILY'] as const;
export type ReconcileScope = (typeof RECONCILE_SCOPES)[number];

export interface ReconcileInput {
  scope: ReconcileScope;
  mapping: HubspotMappingDocument;
  /** Watermark from the previous hourly run. */
  cursor?: ChangeCursor | null;
  /** Explicit ids to re-read; otherwise derived from the scope. */
  objectIds?: readonly string[];
  /**
   * Which mapped object to reconcile. Defaults to the deal object; pass the
   * contact object to re-check property-value rules that live on contacts.
   */
  objectType?: string;
}

export interface ReconcileDeps {
  provider: HubspotProvider;
  store: SyncStore;
  now?: () => IsoTimestamp;
  newUuid?: () => Uuid;
  logger?: Logger;
}

export interface ReconciliationReport {
  scope: ReconcileScope;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp;
  objectsRead: number;
  /** Genuine transitions written this run. */
  eventsEmitted: CanonicalEventDraft[];
  discrepancies: ReconciliationDiscrepancy[];
  nextCursor: ChangeCursor | null;
  /** What was corrected, in plain German, for the console's sync report. */
  correctionsDe: string[];
  messagesDe: string[];
}

export async function reconcile(
  input: ReconcileInput,
  deps: ReconcileDeps,
): Promise<ReconciliationReport> {
  const now = deps.now ?? nowIso;
  const newUuid = deps.newUuid ?? (() => newId<Uuid>());
  const startedAt = now();
  const { mapping } = input;
  const objectType = input.objectType ?? mapping.objects.deal;

  const eventsEmitted: CanonicalEventDraft[] = [];
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const correctionsDe: string[] = [];
  const messagesDe: string[] = [];

  /* --- decide what to look at ------------------------------------------- */
  let nextCursor: ChangeCursor | null = input.cursor ?? null;
  let ids: string[];

  if (input.objectIds) {
    ids = [...input.objectIds];
  } else if (input.scope === 'HOURLY') {
    const page = await deps.provider.listRecentChanges(
      input.cursor ?? { since: hourAgo(startedAt), after: null, objectType },
    );
    nextCursor = page.nextCursor;
    ids = page.changes.map((c) => c.objectId);
  } else {
    const mirrored = await deps.store.listMirrored(objectType);
    ids = mirrored.map((m) => m.objectId);
  }

  if (ids.length === 0) {
    return {
      scope: input.scope,
      startedAt,
      finishedAt: now(),
      objectsRead: 0,
      eventsEmitted: [],
      discrepancies: [],
      nextCursor,
      correctionsDe: [],
      messagesDe: ['Keine Änderungen seit dem letzten Abgleich.'],
    };
  }

  /* --- read the mapped objects ------------------------------------------ */
  const records = await deps.provider.batchReadObjects({
    objectType,
    ids,
    properties:
      objectType === mapping.objects.contact
        ? mappedContactProperties(mapping)
        : mappedDealProperties(mapping),
  });
  const byId = new Map(records.map((r) => [r.id, r]));

  for (const objectId of ids) {
    const record = byId.get(objectId);
    if (!record) {
      const mirror = await deps.store.loadMirror(objectType, objectId);
      if (mirror) {
        const discrepancy = makeDiscrepancy({
          id: newUuid(),
          kind: 'OBJECT_MISSING_IN_CRM',
          detectedAt: now(),
          objectType,
          hubspotObjectId: objectId,
          messageDe: `Der gespiegelte Datensatz ${objectId} (${objectType}) ist in HubSpot nicht mehr auffindbar.`,
          resolutionDe:
            'Der Spiegel bleibt erhalten; es wurde kein Ereignis erzeugt. Bitte den Datensatz in HubSpot prüfen.',
        });
        discrepancies.push(discrepancy);
        await deps.store.recordDiscrepancy(discrepancy);
      }
      continue;
    }

    const outcome = await reconcileOne(record, mapping, deps, {
      now,
      newUuid,
    });
    eventsEmitted.push(...outcome.events);
    discrepancies.push(...outcome.discrepancies);
    correctionsDe.push(...outcome.correctionsDe);
  }

  /* --- daily: verify the contact association still exists ---------------- */
  if (input.scope === 'DAILY' && objectType === mapping.objects.deal) {
    const associations = await deps.provider.batchReadAssociations({
      fromObjectType: objectType,
      toObjectType: mapping.objects.contact,
      fromObjectIds: ids,
    });
    for (const association of associations) {
      if (association.toObjectIds.length > 0) continue;
      const discrepancy = makeDiscrepancy({
        id: newUuid(),
        kind: 'ASSOCIATION_MISSING',
        detectedAt: now(),
        objectType,
        hubspotObjectId: association.fromObjectId,
        messageDe: `Der Deal ${association.fromObjectId} hat keine Verknüpfung zu einem Kontakt.`,
        resolutionDe:
          'Die Verknüpfung wurde nicht automatisch neu gesetzt; die Umsatzzuordnung dieses Deals ist unvollständig.',
      });
      discrepancies.push(discrepancy);
      await deps.store.recordDiscrepancy(discrepancy);
    }
  }

  if (eventsEmitted.length === 0 && discrepancies.length === 0) {
    messagesDe.push('Abgleich abgeschlossen: keine Abweichungen gefunden.');
  } else {
    messagesDe.push(
      `Abgleich abgeschlossen: ${eventsEmitted.length} echte Zustandsänderung(en), ${discrepancies.length} Abweichung(en).`,
    );
  }

  return {
    scope: input.scope,
    startedAt,
    finishedAt: now(),
    objectsRead: records.length,
    eventsEmitted,
    discrepancies,
    nextCursor,
    correctionsDe,
    messagesDe,
  };
}

/* -------------------------------------------------------------------------- */
/* One object                                                                  */
/* -------------------------------------------------------------------------- */

interface ReconcileOneOutcome {
  events: CanonicalEventDraft[];
  discrepancies: ReconciliationDiscrepancy[];
  correctionsDe: string[];
}

async function reconcileOne(
  record: HubspotObjectRecord,
  mapping: HubspotMappingDocument,
  deps: ReconcileDeps,
  clock: { now: () => IsoTimestamp; newUuid: () => Uuid },
): Promise<ReconcileOneOutcome> {
  const before = await deps.store.loadMirror(record.objectType, record.id);
  const after: ObjectSnapshot = {
    objectType: record.objectType,
    objectId: record.id,
    properties: record.properties,
    observedAt: record.updatedAt,
  };

  const opportunity = await deps.store.findOpportunityByDealId(record.id);
  const emitted = (await deps.store.listSalesEventTypes(record.id)) as SalesEventType[];

  const drafts = toCanonicalEvents({
    before,
    after,
    mapping,
    sourceObject: record.objectType === mapping.objects.contact ? 'CONTACT' : 'DEAL',
    emittedEventTypes: emitted,
    sourceEventId: `reconcile:${record.id}`,
  });

  const discrepancies: ReconciliationDiscrepancy[] = [];
  const correctionsDe: string[] = [];

  const crmAmountMinor = amountToMinor(
    valueOf(record, mapping.revenue.amountProperty),
    mapping.revenue.amountUnit,
  );
  const crmCurrency = currencyOf(record, mapping);
  const alreadyConverted =
    opportunity?.closedWonAt !== null && opportunity?.closedWonAt !== undefined;

  /* --- drift after a dispatched conversion -------------------------------- */
  let suppressed: CanonicalEventDraft[] = drafts;
  if (alreadyConverted && opportunity) {
    suppressed = drafts.filter((d) => d.type !== 'CLOSED_WON');

    if (crmAmountMinor !== null && crmAmountMinor !== opportunity.amountMinor) {
      const delta = crmAmountMinor - (opportunity.amountMinor ?? 0);
      const discrepancy = makeDiscrepancy({
        id: clock.newUuid(),
        kind: 'REVENUE_CHANGED_AFTER_CONVERSION',
        detectedAt: clock.now(),
        objectType: record.objectType,
        hubspotObjectId: record.id,
        opportunityId: opportunity.amOpportunityId,
        mirroredValue: String(opportunity.amountMinor ?? 0),
        crmValue: String(crmAmountMinor),
        deltaMinor: delta,
        currency: crmCurrency,
        messageDe: `Der Deal-Wert hat sich nach der bereits gemeldeten Conversion um ${delta} (Minor Units) geändert.`,
        resolutionDe:
          'Es wurde eine Umsatzkorrektur gebucht. Es wurde bewusst kein zweites CLOSED_WON-Ereignis erzeugt.',
      });
      discrepancies.push(discrepancy);
      await deps.store.recordDiscrepancy(discrepancy);
      await deps.store.appendRevenueEvent({
        opportunityId: opportunity.amOpportunityId,
        occurredAt: clock.now(),
        amountMinor: crmAmountMinor,
        currency: crmCurrency,
        kind: 'ADJUSTMENT',
        reconciliationDeltaMinor: delta,
      });
      correctionsDe.push(
        `Deal ${record.id}: Umsatzkorrektur um ${delta} Minor Units gebucht, kein Doppelereignis.`,
      );
    }

    if (opportunity.currency && crmCurrency !== opportunity.currency) {
      const discrepancy = makeDiscrepancy({
        id: clock.newUuid(),
        kind: 'CURRENCY_CHANGED',
        detectedAt: clock.now(),
        objectType: record.objectType,
        hubspotObjectId: record.id,
        opportunityId: opportunity.amOpportunityId,
        mirroredValue: opportunity.currency,
        crmValue: crmCurrency,
        currency: crmCurrency,
        messageDe: `Die Währung des Deals wurde nach der Conversion von ${opportunity.currency} auf ${crmCurrency} geändert.`,
        resolutionDe: 'Die Änderung wurde protokolliert; bestehende Ereignisse bleiben unverändert.',
      });
      discrepancies.push(discrepancy);
      await deps.store.recordDiscrepancy(discrepancy);
    }
  }

  /* --- stage moved but no rule matched ------------------------------------ */
  const beforeStage = before?.properties[mapping.pipeline.stageProperty] ?? null;
  const afterStage = record.properties[mapping.pipeline.stageProperty] ?? null;
  if (
    afterStage !== null &&
    afterStage !== beforeStage &&
    suppressed.length === 0 &&
    !alreadyConverted
  ) {
    const discrepancy = makeDiscrepancy({
      id: clock.newUuid(),
      kind: 'STAGE_DRIFT',
      detectedAt: clock.now(),
      objectType: record.objectType,
      hubspotObjectId: record.id,
      opportunityId: opportunity?.amOpportunityId ?? null,
      mirroredValue: beforeStage,
      crmValue: afterStage,
      messageDe: `Die Stage des Deals wurde auf „${afterStage}“ geändert, dafür ist kein kanonisches Ereignis gemappt.`,
      resolutionDe:
        'Der Spiegel wurde nachgezogen; bitte das Mapping um diese Stage ergänzen, falls sie relevant ist.',
    });
    discrepancies.push(discrepancy);
    await deps.store.recordDiscrepancy(discrepancy);
  }

  const appended =
    suppressed.length > 0 ? await deps.store.appendSalesEvents(suppressed) : [];
  await deps.store.saveMirror(after);

  if (opportunity) {
    await deps.store.saveOpportunity(
      applyToOpportunity(opportunity, appended, {
        stage: afterStage,
        pipeline: record.properties[mapping.pipeline.pipelineProperty] ?? null,
        amountMinor: crmAmountMinor,
        currency: crmCurrency,
        at: clock.now(),
        alreadyConverted,
      }),
    );
  }

  return { events: appended, discrepancies, correctionsDe };
}

function applyToOpportunity(
  opportunity: OpportunityRecord,
  appended: readonly CanonicalEventDraft[],
  update: {
    stage: string | null;
    pipeline: string | null;
    amountMinor: number | null;
    currency: Currency;
    at: IsoTimestamp;
    alreadyConverted: boolean;
  },
): OpportunityRecord {
  const won = appended.find((e) => e.type === 'CLOSED_WON');
  const lost = appended.find((e) => e.type === 'CLOSED_LOST');
  return {
    ...opportunity,
    stage: update.stage ?? opportunity.stage,
    pipeline: update.pipeline ?? opportunity.pipeline,
    amountMinor: update.amountMinor ?? opportunity.amountMinor,
    currency: update.currency,
    closedWonAt: opportunity.closedWonAt ?? won?.occurredAt ?? null,
    closedLostAt: opportunity.closedLostAt ?? lost?.occurredAt ?? null,
    syncStatus: 'SYNCED',
    updatedAt: update.at,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function valueOf(record: HubspotObjectRecord, property: string | null): string | null {
  if (!property) return null;
  const value = record.properties[property];
  return value === undefined || value === null || value === '' ? null : value;
}

function currencyOf(record: HubspotObjectRecord, mapping: HubspotMappingDocument): Currency {
  const raw = valueOf(record, mapping.revenue.currencyProperty);
  return raw && /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : mapping.revenue.fallbackCurrency;
}

function makeDiscrepancy(
  partial: Pick<
    ReconciliationDiscrepancy,
    'id' | 'kind' | 'detectedAt' | 'objectType' | 'hubspotObjectId' | 'messageDe' | 'resolutionDe'
  > &
    Partial<ReconciliationDiscrepancy>,
): ReconciliationDiscrepancy {
  return {
    opportunityId: null,
    leadId: null,
    mirroredValue: null,
    crmValue: null,
    deltaMinor: null,
    currency: null,
    ...partial,
  };
}

function hourAgo(at: IsoTimestamp): IsoTimestamp {
  return new Date(Date.parse(at) - 60 * 60 * 1000).toISOString();
}
