import {
  DomainError,
  RETRY_POLICY,
  canWriteHubspot,
  emailDomain,
  fnv1a32,
  isDomainError,
  newId,
  nextRetryDelayMs,
  normalizeEmail,
  nowIso,
  type Currency,
  type DryRunResult,
  type FeatureFlags,
  type IsoTimestamp,
  type SalesEventType,
  type SyncStatus,
  type Uuid,
} from '@am/domain';
import type { Logger } from '@am/observability';
import {
  requiredMappingsComplete,
  type HubspotMappingDocument,
} from './mapping/schema';
import {
  shouldCreateCompany,
  shouldCreateDeal,
  toAcquisitionProperties,
  toCompanyProperties,
  toContactProperties,
  toDealProperties,
} from './mapping/translate';
import type { HubspotProvider } from './provider';
import { isDryRunOutcome, type HubspotObjectRecord, type WriteOutcome } from './provider-types';
import {
  emptyRetry,
  type AcquisitionSnapshotInput,
  type CanonicalEventDraft,
  type LeadRecord,
  type LeadSubmission,
  type ObjectSnapshot,
  type OpportunityRecord,
  type PropertyBag,
  type ReconciliationDiscrepancy,
  type RetryMetadata,
  type WritablePropertyBag,
} from './types';

/**
 * Outbound synchronisation.
 *
 * Supabase is written first; this module only produces the CRM operations and
 * consumes the outbox. It therefore never imports `@am/db` — persistence
 * arrives through the injected `SyncStore` port.
 */

/** Shown instead of an id in a dry-run preview: the record does not exist yet. */
export const DRY_RUN_PLACEHOLDER_ID = '(wird beim Schreiben erzeugt)';

/* -------------------------------------------------------------------------- */
/* Store port                                                                  */
/* -------------------------------------------------------------------------- */

export interface RevenueEventDraft {
  opportunityId: Uuid;
  occurredAt: IsoTimestamp;
  amountMinor: number;
  currency: Currency;
  kind: 'BOOKED' | 'RECOGNIZED' | 'ADJUSTMENT';
  reconciliationDeltaMinor: number | null;
}

/**
 * Everything this package needs from persistence.
 *
 * `withLock` is not optional: ten concurrent syncs of the same submission must
 * collapse onto one contact, one deal and one lead event, and that guarantee has
 * to come from the store (a row lock / advisory lock in Postgres). All writes
 * are expected to be idempotent by their natural key.
 */
export interface SyncStore {
  /** Serialises work on a logical key. Must be re-entrant-safe per process. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;

  findLeadBySubmission(submissionId: Uuid): Promise<LeadRecord | null>;
  saveLead(lead: LeadRecord): Promise<void>;

  findOpportunityByPerson(personId: Uuid): Promise<OpportunityRecord | null>;
  findOpportunityBySubmission(submissionId: Uuid): Promise<OpportunityRecord | null>;
  findOpportunityByDealId(hubspotDealId: string): Promise<OpportunityRecord | null>;
  saveOpportunity(opportunity: OpportunityRecord): Promise<void>;

  /** Appends only drafts whose `dedupeKey` is new. Returns what was appended. */
  appendSalesEvents(events: readonly CanonicalEventDraft[]): Promise<CanonicalEventDraft[]>;
  hasSalesEvent(dedupeKey: string): Promise<boolean>;
  /** Event types already recorded for an object, for terminal/once rules. */
  listSalesEventTypes(hubspotObjectId: string): Promise<SalesEventType[]>;

  /** Our mirror of a CRM object, used to detect genuine transitions. */
  loadMirror(objectType: string, objectId: string): Promise<ObjectSnapshot | null>;
  saveMirror(snapshot: ObjectSnapshot): Promise<void>;
  listMirrored(objectType: string): Promise<ObjectSnapshot[]>;

  recordDiscrepancy(discrepancy: ReconciliationDiscrepancy): Promise<void>;
  appendRevenueEvent(event: RevenueEventDraft): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Result shapes                                                               */
/* -------------------------------------------------------------------------- */

export const SYNC_STEPS = [
  'CONTACT',
  'COMPANY',
  'CONTACT_COMPANY_ASSOCIATION',
  'DEAL',
  'CONTACT_DEAL_ASSOCIATION',
  'COMPANY_DEAL_ASSOCIATION',
  'LEAD_EVENT',
] as const;
export type SyncStep = (typeof SYNC_STEPS)[number];

export type SyncOperationOutcome = 'PERFORMED' | 'DRY_RUN' | 'SKIPPED' | 'UNCHANGED' | 'FAILED';

export interface SyncOperation {
  step: SyncStep;
  outcome: SyncOperationOutcome;
  objectId: string | null;
  detailDe: string;
}

export interface SyncLeadResult {
  status: SyncStatus;
  /** True when nothing was actually written because the flags are off. */
  dryRun: boolean;
  lead: LeadRecord;
  opportunity: OpportunityRecord | null;
  /** Logical events produced by *this* run. Empty on a repeat. */
  events: CanonicalEventDraft[];
  operations: SyncOperation[];
  dryRuns: DryRunResult[];
  retry: RetryMetadata;
  messagesDe: string[];
}

export interface SyncLeadInput {
  submission: LeadSubmission;
  acquisition: AcquisitionSnapshotInput;
  mapping: HubspotMappingDocument;
  /**
   * The canonical event this run represents. A form submit is
   * `FORM_COMPLETED`; a deal is created only when this equals the mapped
   * trigger, so a second submission never produces a second deal.
   */
  triggerEvent?: SalesEventType;
  campaignLabel?: string | null;
  offerLabel?: string | null;
}

export interface SyncDeps {
  provider: HubspotProvider;
  store: SyncStore;
  flags: FeatureFlags;
  now?: () => IsoTimestamp;
  newUuid?: () => Uuid;
  logger?: Logger;
}

/* -------------------------------------------------------------------------- */
/* Property helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Every contact property the mapping can read or write. */
export function mappedContactProperties(mapping: HubspotMappingDocument): string[] {
  const props = new Set<string>([mapping.contactIdentifier.property]);
  for (const key of [
    mapping.contactIdentifier.personIdProperty,
    mapping.contactIdentifier.firstNameProperty,
    mapping.contactIdentifier.lastNameProperty,
    mapping.contactIdentifier.phoneProperty,
    mapping.contactIdentifier.leadSourceProperty,
    mapping.vq.statusProperty,
    mapping.vq.scoreProperty,
    mapping.vq.reasonCodeProperty,
    mapping.vq.scheduledAtProperty,
    mapping.testLead.markerProperty,
  ]) {
    if (key) props.add(key);
  }
  for (const field of mapping.formFieldMappings) {
    if (field.objectType === mapping.objects.contact) props.add(field.property);
  }
  for (const property of Object.values(mapping.acquisition.contactProperties)) props.add(property);
  for (const rule of mapping.propertyValueEvents) {
    if (rule.objectType === mapping.objects.contact) props.add(rule.property);
  }
  return [...props];
}

/** Every deal property the mapping can read or write. */
export function mappedDealProperties(mapping: HubspotMappingDocument): string[] {
  const props = new Set<string>([
    mapping.pipeline.pipelineProperty,
    mapping.pipeline.stageProperty,
  ]);
  for (const key of [
    mapping.dealCreation.opportunityIdProperty,
    mapping.dealCreation.submissionIdProperty,
    mapping.dealCreation.personIdProperty,
    mapping.dealCreation.closeDateProperty,
    mapping.revenue.amountProperty,
    mapping.revenue.currencyProperty,
    mapping.revenue.recognizedAtProperty,
    mapping.lostRules.lostReasonProperty,
    mapping.lostRules.noShowProperty,
    mapping.testLead.markerProperty,
  ]) {
    if (key) props.add(key);
  }
  for (const field of mapping.formFieldMappings) {
    if (field.objectType === mapping.objects.deal) props.add(field.property);
  }
  for (const property of Object.values(mapping.acquisition.dealProperties)) props.add(property);
  for (const rule of mapping.propertyValueEvents) {
    if (rule.objectType === mapping.objects.deal) props.add(rule.property);
  }
  return [...props];
}

/**
 * Strips write-once values that the CRM already carries.
 *
 * The acquisition snapshot is bound at first contact and must survive every
 * later touch (spec §22): a second submission from the same person may add new
 * information but may never rewrite which campaign acquired them.
 */
export function preserveAcquisition(
  existing: PropertyBag | null,
  incoming: WritablePropertyBag,
  mapping: HubspotMappingDocument,
  scope: 'contact' | 'deal',
): WritablePropertyBag {
  if (!existing) return { ...incoming };

  const protectedProperties = new Set<string>();
  if (mapping.acquisition.writeOnce) {
    const targets =
      scope === 'contact'
        ? mapping.acquisition.contactProperties
        : mapping.acquisition.dealProperties;
    for (const property of Object.values(targets)) protectedProperties.add(property);
  }
  for (const field of mapping.formFieldMappings) {
    const objectType = scope === 'contact' ? mapping.objects.contact : mapping.objects.deal;
    if (field.writeOnce && field.objectType === objectType) protectedProperties.add(field.property);
  }
  if (mapping.contactIdentifier.leadSourceProperty && scope === 'contact') {
    protectedProperties.add(mapping.contactIdentifier.leadSourceProperty);
  }

  const result: WritablePropertyBag = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (protectedProperties.has(key)) {
      const current = existing[key];
      if (current !== undefined && current !== null && String(current).trim().length > 0) continue;
    }
    result[key] = value;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* syncLead                                                                    */
/* -------------------------------------------------------------------------- */

export async function syncLead(input: SyncLeadInput, deps: SyncDeps): Promise<SyncLeadResult> {
  const now = deps.now ?? nowIso;
  const newUuid = deps.newUuid ?? (() => newId<Uuid>());
  const { mapping, submission } = input;
  const triggerEvent: SalesEventType = input.triggerEvent ?? 'FORM_COMPLETED';
  const writesEnabled = canWriteHubspot(deps.flags);

  // A partially configured portal must never receive real leads.
  if (writesEnabled && !requiredMappingsComplete(mapping)) {
    throw new DomainError('MAPPING_INCOMPLETE', {
      messageDe:
        'Das HubSpot-Mapping ist unvollständig. Der Lead wurde gespeichert, aber nicht an HubSpot übertragen.',
      details: { submissionId: submission.submissionId, mappingVersion: mapping.version },
    });
  }

  return deps.store.withLock(`hubspot:lead:${submission.submissionId}`, async () => {
    const operations: SyncOperation[] = [];
    const dryRuns: DryRunResult[] = [];
    const messagesDe: string[] = [];

    const normalizedEmail = normalizeEmail(submission.email);
    let lead =
      (await deps.store.findLeadBySubmission(submission.submissionId)) ??
      createLeadRecord(submission, normalizedEmail, now(), newUuid);

    try {
      /* --- contact ------------------------------------------------------- */
      let contactId = lead.hubspotContactId;
      if (contactId && lead.syncStatus === 'SYNCED') {
        operations.push({
          step: 'CONTACT',
          outcome: 'UNCHANGED',
          objectId: contactId,
          detailDe: 'Der Kontakt ist bereits synchronisiert.',
        });
      } else {
        const existing = await deps.provider.searchContactByEmail({
          objectType: mapping.objects.contact,
          identifierProperty: mapping.contactIdentifier.property,
          identifierValue: normalizedEmail,
          properties: mappedContactProperties(mapping),
        });

        const desired = toContactProperties(submission, mapping, {
          acquisition: input.acquisition,
          includeCreateOnly: existing === null,
        });
        const properties = preserveAcquisition(
          existing?.properties ?? null,
          desired,
          mapping,
          'contact',
        );

        const outcome = await deps.provider.upsertContact({
          objectType: mapping.objects.contact,
          objectId: existing?.id ?? null,
          idProperty: mapping.contactIdentifier.property,
          idValue: normalizedEmail,
          properties,
          idempotencyKey: `contact:${lead.amPersonId}`,
        });
        const record = collect(operations, dryRuns, 'CONTACT', outcome, {
          performedDe: existing ? 'Kontakt aktualisiert.' : 'Kontakt angelegt.',
          dryRunDe: 'Kontakt würde angelegt bzw. aktualisiert (Dry-Run – nicht ausgeführt).',
        });
        contactId = record?.id ?? null;
        if (record) await mirrorRecord(deps.store, record);
      }
      lead = { ...lead, hubspotContactId: contactId, updatedAt: now() };

      /* --- company ------------------------------------------------------- */
      let companyId = lead.hubspotCompanyId;
      const domain = emailDomain(normalizedEmail);
      if (!shouldCreateCompany(submission.email, mapping)) {
        operations.push({
          step: 'COMPANY',
          outcome: 'SKIPPED',
          objectId: null,
          detailDe:
            mapping.company.mode === 'NEVER'
              ? 'Die Unternehmensregel ist deaktiviert.'
              : `Für „${domain ?? 'unbekannte Domain'}“ wird kein Unternehmen angelegt (Freemail- oder ungültige Domain).`,
        });
      } else if (companyId) {
        operations.push({
          step: 'COMPANY',
          outcome: 'UNCHANGED',
          objectId: companyId,
          detailDe: 'Das Unternehmen ist bereits verknüpft.',
        });
      } else {
        const outcome = await deps.provider.upsertCompany({
          objectType: mapping.objects.company,
          idProperty: mapping.company.domainProperty,
          idValue: domain,
          properties: toCompanyProperties(submission, mapping),
          idempotencyKey: `company:${domain}`,
        });
        const record = collect(operations, dryRuns, 'COMPANY', outcome, {
          performedDe: `Unternehmen für „${domain}“ angelegt bzw. aktualisiert.`,
          dryRunDe: `Unternehmen für „${domain}“ würde angelegt (Dry-Run – nicht ausgeführt).`,
        });
        companyId = record?.id ?? null;

        if (mapping.company.associateContactToCompany) {
          const association = await deps.provider.createAssociation({
            fromObjectType: mapping.objects.contact,
            fromObjectId: contactId ?? DRY_RUN_PLACEHOLDER_ID,
            toObjectType: mapping.objects.company,
            toObjectId: companyId ?? DRY_RUN_PLACEHOLDER_ID,
            associationCategory: mapping.company.associationCategory,
            associationTypeId: mapping.company.contactToCompanyAssociationTypeId,
            idempotencyKey: `assoc:contact-company:${lead.amPersonId}`,
          });
          collect(operations, dryRuns, 'CONTACT_COMPANY_ASSOCIATION', association, {
            performedDe: 'Kontakt mit Unternehmen verknüpft.',
            dryRunDe: 'Kontakt würde mit Unternehmen verknüpft (Dry-Run – nicht ausgeführt).',
          });
        }
      }
      lead = { ...lead, hubspotCompanyId: companyId, updatedAt: now() };

      /* --- deal ----------------------------------------------------------- */
      const dealResult = await ensureOpportunity(
        { ...input, triggerEvent },
        deps,
        { contactId, companyId, now, newUuid },
        operations,
        dryRuns,
      );

      /* --- lead event ----------------------------------------------------- */
      const leadEvent: CanonicalEventDraft = {
        type: 'FORM_COMPLETED',
        occurredAt: submission.submittedAt,
        sourceObject: 'INTERNAL',
        hubspotObjectId: contactId,
        previousState: null,
        newState: 'FORM_COMPLETED',
        mappingVersion: mapping.version,
        amountMinor: null,
        currency: null,
        ruleId: 'internal.form_completed',
        dedupeKey: `submission:${submission.submissionId}:FORM_COMPLETED`,
        sourceEventId: submission.submissionId,
      };
      const appended = await deps.store.appendSalesEvents([leadEvent, ...dealResult.events]);
      operations.push({
        step: 'LEAD_EVENT',
        outcome: appended.length > 0 ? 'PERFORMED' : 'UNCHANGED',
        objectId: contactId,
        detailDe:
          appended.length > 0
            ? `${appended.length} kanonische(s) Ereignis(se) geschrieben.`
            : 'Keine neuen Ereignisse — der Zustand hat sich nicht geändert.',
      });

      /* --- persist -------------------------------------------------------- */
      const isDry = dryRuns.length > 0 || !writesEnabled;
      lead = {
        ...lead,
        syncStatus: isDry ? 'PENDING' : 'SYNCED',
        retry: emptyRetry(RETRY_POLICY.maxAttempts),
        updatedAt: now(),
      };
      await deps.store.saveLead(lead);
      if (dealResult.opportunity) await deps.store.saveOpportunity(dealResult.opportunity);

      if (isDry) {
        messagesDe.push(
          'Dry-Run – nicht ausgeführt. Es wurde nichts nach HubSpot geschrieben, weil externe Schreibzugriffe deaktiviert sind.',
        );
      }

      return {
        status: lead.syncStatus,
        dryRun: isDry,
        lead,
        opportunity: dealResult.opportunity,
        events: appended,
        operations,
        dryRuns,
        retry: lead.retry,
        messagesDe,
      };
    } catch (error) {
      const failed = await handleSyncFailure(lead, error, { now, store: deps.store });
      deps.logger?.warn('hubspot_sync_failed', {
        submission_id: submission.submissionId,
        status: failed.syncStatus,
        error_code: failed.retry.lastErrorCode,
      });
      operations.push({
        step: 'CONTACT',
        outcome: 'FAILED',
        objectId: null,
        detailDe: failed.retry.lastErrorDe ?? 'Die Übertragung ist fehlgeschlagen.',
      });
      return {
        status: failed.syncStatus,
        dryRun: false,
        lead: failed,
        opportunity: null,
        events: [],
        operations,
        dryRuns,
        retry: failed.retry,
        messagesDe: [
          failed.syncStatus === 'DEAD_LETTER'
            ? 'Die Übertragung an HubSpot ist endgültig fehlgeschlagen. Der Lead bleibt vollständig gespeichert.'
            : 'Die Übertragung an HubSpot ist fehlgeschlagen und wird automatisch wiederholt. Der Lead bleibt vollständig gespeichert.',
        ],
      };
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Opportunity                                                                 */
/* -------------------------------------------------------------------------- */

interface OpportunityContext {
  contactId: string | null;
  companyId: string | null;
  now: () => IsoTimestamp;
  newUuid: () => Uuid;
}

interface OpportunityOutcome {
  opportunity: OpportunityRecord | null;
  events: CanonicalEventDraft[];
}

/**
 * Creates the deal only when the mapped trigger fires — never one deal per form
 * submit. The acquisition snapshot is frozen onto the opportunity at creation.
 */
async function ensureOpportunity(
  input: SyncLeadInput & { triggerEvent: SalesEventType },
  deps: SyncDeps,
  context: OpportunityContext,
  operations: SyncOperation[],
  dryRuns: DryRunResult[],
): Promise<OpportunityOutcome> {
  const { mapping, submission } = input;

  if (!shouldCreateDeal(mapping, input.triggerEvent)) {
    operations.push({
      step: 'DEAL',
      outcome: 'SKIPPED',
      objectId: null,
      detailDe: `Kein Deal: der Auslöser ist „${mapping.dealCreation.trigger}“, dieses Ereignis ist „${input.triggerEvent}“.`,
    });
    return { opportunity: null, events: [] };
  }

  const existing =
    mapping.dealCreation.mode === 'ONE_PER_SUBMISSION'
      ? await deps.store.findOpportunityBySubmission(submission.submissionId)
      : await deps.store.findOpportunityByPerson(submission.personId);

  if (existing?.hubspotDealId) {
    operations.push({
      step: 'DEAL',
      outcome: 'UNCHANGED',
      objectId: existing.hubspotDealId,
      detailDe: 'Für diese Person besteht bereits eine Opportunity.',
    });
    return { opportunity: existing, events: [] };
  }

  const at = context.now();
  const opportunity: OpportunityRecord = existing ?? {
    id: context.newUuid(),
    amOpportunityId: context.newUuid(),
    amPersonId: submission.personId,
    acquisitionSubmissionId: submission.submissionId,
    acquisitionSnapshotId: input.acquisition.snapshotId,
    createdAt: at,
    updatedAt: at,
    hubspotDealId: null,
    pipeline: mapping.pipeline.pipelineId,
    stage: mapping.pipeline.defaultStageId,
    amountMinor: null,
    currency: null,
    closedWonAt: null,
    closedLostAt: null,
    syncStatus: 'PENDING',
    retry: emptyRetry(RETRY_POLICY.maxAttempts),
    // Frozen at creation; `preserveAcquisition` keeps later touches out.
    acquisitionProperties: toAcquisitionProperties(input.acquisition, mapping, 'deal'),
  };

  const properties = toDealProperties({
    submission,
    mapping,
    amOpportunityId: opportunity.amOpportunityId,
    acquisition: input.acquisition,
    campaignLabel: input.campaignLabel ?? null,
    offerLabel: input.offerLabel ?? null,
  });

  const outcome = await deps.provider.createDeal({
    objectType: mapping.objects.deal,
    properties,
    idempotencyKey: `deal:${opportunity.amOpportunityId}`,
  });
  const dealRecord = collect(operations, dryRuns, 'DEAL', outcome, {
    performedDe: 'Deal angelegt.',
    dryRunDe: 'Deal würde angelegt (Dry-Run – nicht ausgeführt).',
  });
  const dealId = dealRecord?.id ?? null;
  if (dealRecord) await mirrorRecord(deps.store, dealRecord);

  const association = await deps.provider.createAssociation({
    fromObjectType: mapping.objects.contact,
    fromObjectId: context.contactId ?? DRY_RUN_PLACEHOLDER_ID,
    toObjectType: mapping.objects.deal,
    toObjectId: dealId ?? DRY_RUN_PLACEHOLDER_ID,
    associationCategory: mapping.dealCreation.associationCategory,
    associationTypeId: mapping.dealCreation.contactToDealAssociationTypeId,
    idempotencyKey: `assoc:contact-deal:${opportunity.amOpportunityId}`,
  });
  collect(operations, dryRuns, 'CONTACT_DEAL_ASSOCIATION', association, {
    performedDe: 'Kontakt mit Deal verknüpft.',
    dryRunDe: 'Kontakt würde mit Deal verknüpft (Dry-Run – nicht ausgeführt).',
  });

  if (context.companyId) {
    const companyAssociation = await deps.provider.createAssociation({
      fromObjectType: mapping.objects.company,
      fromObjectId: context.companyId,
      toObjectType: mapping.objects.deal,
      toObjectId: dealId ?? DRY_RUN_PLACEHOLDER_ID,
      associationCategory: mapping.dealCreation.associationCategory,
      associationTypeId: mapping.dealCreation.companyToDealAssociationTypeId,
      idempotencyKey: `assoc:company-deal:${opportunity.amOpportunityId}`,
    });
    collect(operations, dryRuns, 'COMPANY_DEAL_ASSOCIATION', companyAssociation, {
      performedDe: 'Unternehmen mit Deal verknüpft.',
      dryRunDe: 'Unternehmen würde mit Deal verknüpft (Dry-Run – nicht ausgeführt).',
    });
  }

  const updated: OpportunityRecord = {
    ...opportunity,
    hubspotDealId: dealId,
    syncStatus: dealId ? 'SYNCED' : 'PENDING',
    updatedAt: at,
  };

  const events: CanonicalEventDraft[] = [
    {
      type: 'OPPORTUNITY_CREATED',
      occurredAt: at,
      sourceObject: 'INTERNAL',
      hubspotObjectId: dealId,
      previousState: null,
      newState: mapping.pipeline.defaultStageId ?? 'OPPORTUNITY_CREATED',
      mappingVersion: mapping.version,
      amountMinor: null,
      currency: null,
      ruleId: 'internal.opportunity_created',
      dedupeKey: `opportunity:${updated.amOpportunityId}:OPPORTUNITY_CREATED`,
      sourceEventId: submission.submissionId,
    },
  ];

  return { opportunity: updated, events };
}

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

export async function handleSyncFailure(
  lead: LeadRecord,
  error: unknown,
  deps: { now: () => IsoTimestamp; store: SyncStore },
): Promise<LeadRecord> {
  const attempt = lead.retry.attempt + 1;
  const domainError = isDomainError(error) ? error : null;
  const retryable = domainError?.retryable ?? false;
  // `shouldDeadLetter` from `@am/domain` types its second parameter as the
  // literal policy value; the per-lead budget is compared directly instead.
  const exhausted = attempt >= lead.retry.maxAttempts;
  const status: SyncStatus = !retryable || exhausted ? 'DEAD_LETTER' : 'FAILED_RETRYING';

  const retryAfterMs = readRetryAfterMs(domainError);
  const delayMs =
    retryAfterMs ?? nextRetryDelayMs(attempt, fnv1a32(lead.submissionId), RETRY_POLICY);

  // One clock read: the backoff has to be measurable against `updatedAt`.
  const failedAt = deps.now();

  const updated: LeadRecord = {
    ...lead,
    syncStatus: status,
    updatedAt: failedAt,
    retry: {
      attempt,
      maxAttempts: lead.retry.maxAttempts,
      nextAttemptAt:
        status === 'FAILED_RETRYING'
          ? new Date(Date.parse(failedAt) + delayMs).toISOString()
          : null,
      lastErrorCode: domainError?.code ?? 'INTERNAL',
      lastErrorDe:
        domainError?.messageDe ?? 'Bei der Übertragung an HubSpot ist ein Fehler aufgetreten.',
    },
  };
  await deps.store.saveLead(updated);
  return updated;
}

function readRetryAfterMs(error: DomainError | null): number | null {
  const raw = error?.details?.retryAfterMs;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function createLeadRecord(
  submission: LeadSubmission,
  normalizedEmail: string,
  at: IsoTimestamp,
  newUuid: () => Uuid,
): LeadRecord {
  return {
    id: newUuid(),
    amPersonId: submission.personId,
    submissionId: submission.submissionId,
    createdAt: at,
    updatedAt: at,
    hubspotContactId: null,
    hubspotCompanyId: null,
    syncStatus: 'PENDING',
    retry: emptyRetry(RETRY_POLICY.maxAttempts),
    vq: null,
    normalizedEmail,
    isTestLead: submission.isTestLead === true,
  };
}

/** Records an operation and returns the written record, or `null` on a dry run. */
function collect<T extends HubspotObjectRecord | { fromObjectId: string }>(
  operations: SyncOperation[],
  dryRuns: DryRunResult[],
  step: SyncStep,
  outcome: WriteOutcome<T>,
  messages: { performedDe: string; dryRunDe: string },
): T | null {
  if (isDryRunOutcome(outcome)) {
    dryRuns.push(outcome);
    operations.push({
      step,
      outcome: 'DRY_RUN',
      objectId: null,
      detailDe: messages.dryRunDe,
    });
    return null;
  }
  const value = outcome.result;
  const id = (value as Partial<HubspotObjectRecord>).id;
  const objectId = typeof id === 'string' ? id : null;
  operations.push({ step, outcome: 'PERFORMED', objectId, detailDe: messages.performedDe });
  return value;
}

/**
 * Mirrors what we just wrote. Without this baseline the next reconciliation
 * would read the object for the first time and re-emit the transition we have
 * already recorded.
 */
async function mirrorRecord(store: SyncStore, record: HubspotObjectRecord): Promise<void> {
  await store.saveMirror({
    objectType: record.objectType,
    objectId: record.id,
    properties: { ...record.properties },
    observedAt: record.updatedAt,
  });
}
