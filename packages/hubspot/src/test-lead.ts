import {
  canWriteHubspot,
  newId,
  nowIso,
  type FeatureFlags,
  type HealthStatus,
  type IsoTimestamp,
  type Uuid,
} from '@am/domain';
import type { Logger } from '@am/observability';
import {
  missingRequiredMappings,
  requiredMappingsComplete,
  type HubspotMappingDocument,
} from './mapping/schema';
import type { HubspotProvider } from './provider';
import { isDryRunOutcome } from './provider-types';
import { mappedContactProperties, mappedDealProperties, syncLead, type SyncStore } from './sync';
import type { AcquisitionSnapshotInput, LeadSubmission } from './types';

/**
 * The wizard's end-to-end probe.
 *
 * It sends one clearly marked test lead, then verifies through the API that the
 * contact, the deal and the contact↔deal association actually exist. Its success
 * is a live-launch gate: a green mapping alone is not evidence that the portal
 * accepts our writes.
 */

export const TEST_LEAD_STEP_KEYS = [
  'mapping_complete',
  'writes_enabled',
  'contact_created',
  'deal_created',
  'contact_deal_association',
  'cleanup',
] as const;
export type TestLeadStepKey = (typeof TEST_LEAD_STEP_KEYS)[number];

export const TEST_LEAD_STEP_LABELS_DE: Readonly<Record<TestLeadStepKey, string>> = {
  mapping_complete: 'Pflichtmapping vollständig',
  writes_enabled: 'Schreibzugriffe freigegeben',
  contact_created: 'Testkontakt angelegt',
  deal_created: 'Test-Deal angelegt',
  contact_deal_association: 'Verknüpfung Kontakt ↔ Deal',
  cleanup: 'Testdaten gekennzeichnet',
};

export interface TestLeadStep {
  key: TestLeadStepKey;
  labelDe: string;
  status: HealthStatus;
  detailDe: string;
}

export type TestLeadStatus = 'PASS' | 'FAIL' | 'DRY_RUN' | 'AWAITING_EXTERNAL_INPUT';

export interface TestLeadResult {
  status: TestLeadStatus;
  dryRun: boolean;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp;
  steps: TestLeadStep[];
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  associationVerified: boolean;
  cleanup: 'MARKED' | 'NONE';
  email: string;
  messagesDe: string[];
  /** Only `true` unlocks the live launch. */
  gatePassed: boolean;
}

export interface TestLeadInput {
  mapping: HubspotMappingDocument;
  initiatedBy: Uuid;
  /** Overrides the address derived from the mapping. */
  emailOverride?: string;
}

export interface TestLeadDeps {
  provider: HubspotProvider;
  store: SyncStore;
  flags: FeatureFlags;
  now?: () => IsoTimestamp;
  newUuid?: () => Uuid;
  logger?: Logger;
}

export function isTestLeadGatePassed(result: TestLeadResult | null | undefined): boolean {
  return result?.gatePassed === true;
}

/** Builds the probe address. The domain must come from the mapping. */
export function testLeadEmail(mapping: HubspotMappingDocument, token: string): string | null {
  if (!mapping.testLead.emailDomain) return null;
  return `${mapping.testLead.emailLocalPart}+${token}@${mapping.testLead.emailDomain}`.toLowerCase();
}

export async function runTestLead(
  input: TestLeadInput,
  deps: TestLeadDeps,
): Promise<TestLeadResult> {
  const now = deps.now ?? nowIso;
  const newUuid = deps.newUuid ?? (() => newId<Uuid>());
  const startedAt = now();
  const { mapping } = input;
  const steps: TestLeadStep[] = [];
  const messagesDe: string[] = [];

  const finish = (status: TestLeadStatus, extra: Partial<TestLeadResult> = {}): TestLeadResult => ({
    status,
    dryRun: status === 'DRY_RUN',
    startedAt,
    finishedAt: now(),
    steps,
    contactId: null,
    companyId: null,
    dealId: null,
    associationVerified: false,
    cleanup: 'NONE',
    email: extra.email ?? '',
    messagesDe,
    gatePassed: status === 'PASS',
    ...extra,
  });

  /* --- 1. mapping --------------------------------------------------------- */
  if (!requiredMappingsComplete(mapping)) {
    const missing = missingRequiredMappings(mapping);
    steps.push({
      key: 'mapping_complete',
      labelDe: TEST_LEAD_STEP_LABELS_DE.mapping_complete,
      status: 'AWAITING_EXTERNAL_INPUT',
      detailDe: `Es fehlen noch ${missing.length} Pflichtangabe(n): ${missing
        .slice(0, 3)
        .map((i) => i.messageDe)
        .join(' ')}`,
    });
    messagesDe.push('Der Test-Lead wurde nicht gesendet, weil das Pflichtmapping unvollständig ist.');
    return finish('AWAITING_EXTERNAL_INPUT');
  }
  steps.push({
    key: 'mapping_complete',
    labelDe: TEST_LEAD_STEP_LABELS_DE.mapping_complete,
    status: 'PASS',
    detailDe: `Mapping-Version ${mapping.version} ist vollständig.`,
  });

  /* --- 2. address --------------------------------------------------------- */
  const token = newUuid().replace(/-/g, '').slice(0, 12);
  const email = input.emailOverride ?? testLeadEmail(mapping, token);
  if (!email) {
    steps.push({
      key: 'contact_created',
      labelDe: TEST_LEAD_STEP_LABELS_DE.contact_created,
      status: 'AWAITING_EXTERNAL_INPUT',
      detailDe: 'Für den Test-Lead ist keine E-Mail-Domain hinterlegt.',
    });
    messagesDe.push('Bitte im Schritt „Test-Lead“ eine E-Mail-Domain hinterlegen.');
    return finish('AWAITING_EXTERNAL_INPUT');
  }

  const submission: LeadSubmission = {
    submissionId: newUuid(),
    personId: newUuid(),
    email,
    firstName: mapping.testLead.firstName,
    lastName: mapping.testLead.lastName,
    phone: null,
    companyName: null,
    answers: { email, first_name: mapping.testLead.firstName, last_name: mapping.testLead.lastName },
    submittedAt: startedAt,
    isTestLead: true,
  };
  const acquisition: AcquisitionSnapshotInput = {
    snapshotId: newUuid(),
    submissionId: submission.submissionId,
    channel: 'DIRECT',
    confidence: 'UNKNOWN',
  };

  /* --- 3. send ------------------------------------------------------------ */
  const writesEnabled = canWriteHubspot(deps.flags);
  const sync = await syncLead(
    {
      submission,
      acquisition,
      mapping,
      // Force the deal path so the association can be verified end to end.
      triggerEvent: mapping.dealCreation.trigger,
      campaignLabel: 'Test-Lead',
    },
    { provider: deps.provider, store: deps.store, flags: deps.flags, now, newUuid, logger: deps.logger },
  );

  if (!writesEnabled || sync.dryRun) {
    steps.push({
      key: 'writes_enabled',
      labelDe: TEST_LEAD_STEP_LABELS_DE.writes_enabled,
      status: 'AWAITING_EXTERNAL_INPUT',
      detailDe:
        'HubSpot-Schreibzugriffe sind deaktiviert. Der Test-Lead wurde als Dry-Run vorbereitet, aber nicht gesendet.',
    });
    messagesDe.push(
      'Dry-Run – nicht ausgeführt. Der Live-Launch bleibt gesperrt, bis ein echter Test-Lead erfolgreich war.',
    );
    return finish('DRY_RUN', { email });
  }
  steps.push({
    key: 'writes_enabled',
    labelDe: TEST_LEAD_STEP_LABELS_DE.writes_enabled,
    status: 'PASS',
    detailDe: 'Schreibzugriffe sind freigegeben.',
  });

  if (sync.status === 'FAILED_RETRYING' || sync.status === 'DEAD_LETTER') {
    steps.push({
      key: 'contact_created',
      labelDe: TEST_LEAD_STEP_LABELS_DE.contact_created,
      status: 'FAIL',
      detailDe: sync.retry.lastErrorDe ?? 'Die Übertragung ist fehlgeschlagen.',
    });
    messagesDe.push('Der Test-Lead konnte nicht an HubSpot übertragen werden.');
    return finish('FAIL', { email });
  }

  /* --- 4. verify contact -------------------------------------------------- */
  const contact = await deps.provider.searchContactByEmail({
    objectType: mapping.objects.contact,
    identifierProperty: mapping.contactIdentifier.property,
    identifierValue: email,
    properties: mappedContactProperties(mapping),
  });
  steps.push({
    key: 'contact_created',
    labelDe: TEST_LEAD_STEP_LABELS_DE.contact_created,
    status: contact ? 'PASS' : 'FAIL',
    detailDe: contact
      ? `Kontakt ${contact.id} wurde in HubSpot gefunden.`
      : 'Der Testkontakt konnte in HubSpot nicht gefunden werden.',
  });

  /* --- 5. verify deal ----------------------------------------------------- */
  const dealId = sync.opportunity?.hubspotDealId ?? null;
  const deals = dealId
    ? await deps.provider.batchReadObjects({
        objectType: mapping.objects.deal,
        ids: [dealId],
        properties: mappedDealProperties(mapping),
      })
    : [];
  const deal = deals[0] ?? null;
  steps.push({
    key: 'deal_created',
    labelDe: TEST_LEAD_STEP_LABELS_DE.deal_created,
    status: deal ? 'PASS' : 'FAIL',
    detailDe: deal
      ? `Deal ${deal.id} wurde in HubSpot gefunden.`
      : 'Der Test-Deal konnte in HubSpot nicht gefunden werden.',
  });

  /* --- 6. verify association --------------------------------------------- */
  let associationVerified = false;
  if (contact && deal) {
    const associations = await deps.provider.batchReadAssociations({
      fromObjectType: mapping.objects.contact,
      toObjectType: mapping.objects.deal,
      fromObjectIds: [contact.id],
    });
    associationVerified = associations.some((a) => a.toObjectIds.includes(deal.id));
  }
  steps.push({
    key: 'contact_deal_association',
    labelDe: TEST_LEAD_STEP_LABELS_DE.contact_deal_association,
    status: associationVerified ? 'PASS' : 'FAIL',
    detailDe: associationVerified
      ? 'Kontakt und Deal sind in HubSpot verknüpft.'
      : 'Zwischen Testkontakt und Test-Deal besteht keine Verknüpfung.',
  });

  /* --- 7. mark as test data ---------------------------------------------- */
  let cleanup: TestLeadResult['cleanup'] = 'NONE';
  const markerProperty = mapping.testLead.markerProperty;
  if (markerProperty && mapping.testLead.cleanup !== 'NONE') {
    if (contact) {
      await deps.provider.upsertContact({
        objectType: mapping.objects.contact,
        objectId: contact.id,
        properties: { [markerProperty]: mapping.testLead.markerValue },
        idempotencyKey: `testlead:contact:${contact.id}`,
      });
    }
    if (deal) {
      const outcome = await deps.provider.updateDeal({
        objectType: mapping.objects.deal,
        objectId: deal.id,
        properties: { [markerProperty]: mapping.testLead.markerValue },
        idempotencyKey: `testlead:deal:${deal.id}`,
      });
      if (!isDryRunOutcome(outcome)) cleanup = 'MARKED';
    } else if (contact) {
      cleanup = 'MARKED';
    }
    steps.push({
      key: 'cleanup',
      labelDe: TEST_LEAD_STEP_LABELS_DE.cleanup,
      status: cleanup === 'MARKED' ? 'PASS' : 'WARN',
      detailDe:
        cleanup === 'MARKED'
          ? `Die Testdatensätze sind über „${markerProperty}“ als Testdaten gekennzeichnet und aus der Auswertung ausgeschlossen.`
          : 'Die Testdatensätze konnten nicht gekennzeichnet werden.',
    });
    if (mapping.testLead.cleanup === 'ARCHIVE') {
      messagesDe.push(
        'Hinweis: Das Archivieren von Datensätzen ist nicht Teil der Integration. Die Testdaten wurden gekennzeichnet und müssen in HubSpot manuell archiviert werden.',
      );
    }
  } else {
    steps.push({
      key: 'cleanup',
      labelDe: TEST_LEAD_STEP_LABELS_DE.cleanup,
      status: 'WARN',
      detailDe:
        'Es ist keine Eigenschaft zur Kennzeichnung von Testdaten hinterlegt; der Testdatensatz bleibt unmarkiert.',
    });
  }

  const failed = steps.some((s) => s.status === 'FAIL');
  if (failed) {
    messagesDe.push('Der Test-Lead war nicht erfolgreich. Der Live-Launch bleibt gesperrt.');
  } else {
    messagesDe.push('Der Test-Lead war erfolgreich. Kontakt, Deal und Verknüpfung wurden geprüft.');
  }

  return finish(failed ? 'FAIL' : 'PASS', {
    email,
    contactId: contact?.id ?? null,
    companyId: sync.lead.hubspotCompanyId,
    dealId: deal?.id ?? null,
    associationVerified,
    cleanup,
  });
}
