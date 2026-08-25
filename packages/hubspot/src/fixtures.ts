import { RETRY_POLICY, type IsoTimestamp, type SalesEventType, type Uuid } from '@am/domain';
import {
  mappingDocumentSchema,
  type HubspotMappingDocument,
  type HubspotMappingDocumentInput,
} from './mapping/schema';
import { FIXTURE_PIPELINE, type FixtureSeed } from './provider-fixture';
import type { RevenueEventDraft, SyncStore } from './sync';
import {
  emptyRetry,
  type AcquisitionSnapshotInput,
  type CanonicalEventDraft,
  type LeadRecord,
  type LeadSubmission,
  type ObjectSnapshot,
  type OpportunityRecord,
  type ReconciliationDiscrepancy,
} from './types';

/**
 * Fixture mapping and fixture CRM data.
 *
 * The real property names, VQ definition, pipeline and stages are not available
 * yet. This document stands in for them so the whole product — wizard, sync,
 * reconciliation, demo seed and E2E — is fully exercisable today, and is
 * replaced wholesale by the customer's mapping when it arrives. `source` is
 * `FIXTURE`, which is what keeps it from being mistaken for the real one.
 */

export const FIXTURE_MAPPING_ID = '5b2f0a8e-1d34-4a9f-9c1e-6f0a2b7d4c31';
export const FIXTURE_SUBMISSION_ID = 'a1f0c6d2-3b74-4f8e-9d21-7c5b8e0a1f44';
export const FIXTURE_PERSON_ID = 'c3d9e1b7-5a26-4f13-8b90-2e7d4c6a9f05';
export const FIXTURE_SNAPSHOT_ID = 'f7c1a4b9-8e52-4d06-9137-5a2b0c8e6d13';
export const FIXTURE_CAMPAIGN_ID = '1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28';
export const FIXTURE_CAMPAIGN_VERSION_ID = '2f5c8d01-3e74-4b26-9a8f-0d1e4c6b7f39';
export const FIXTURE_FUNNEL_VERSION_ID = '3a6d9e12-4f85-4c37-8b90-1e2f5d7c8a40';

const FIXTURE_CREATED_AT = '2026-01-08T09:00:00.000Z';

const FIXTURE_MAPPING_INPUT: HubspotMappingDocumentInput = {
  id: FIXTURE_MAPPING_ID,
  version: 1,
  status: 'PUBLISHED',
  publishedAt: FIXTURE_CREATED_AT,
  publishedBy: FIXTURE_PERSON_ID,
  createdAt: FIXTURE_CREATED_AT,
  createdBy: FIXTURE_PERSON_ID,
  source: 'FIXTURE',
  portalId: 'fixture-portal',
  notesDe:
    'Fixture-Mapping. Ersetzt das echte Mapping, sobald die HubSpot-Eigenschaften des Kunden vorliegen.',

  contactIdentifier: {
    property: 'email',
    normalization: 'EMAIL_LOWERCASE',
    personIdProperty: 'am_person_id',
    firstNameProperty: 'firstname',
    lastNameProperty: 'lastname',
    phoneProperty: 'phone',
    leadSourceProperty: 'lifecyclestage',
    leadSourceValue: 'lead',
  },
  company: {
    mode: 'VERIFIED_CORPORATE_DOMAIN_ONLY',
    domainProperty: 'domain',
    nameProperty: 'name',
    additionalFreemailDomains: [],
    associateContactToCompany: true,
    associationCategory: 'HUBSPOT_DEFINED',
    contactToCompanyAssociationTypeId: null,
  },
  pipeline: {
    pipelineId: FIXTURE_PIPELINE.id,
    pipelineLabel: FIXTURE_PIPELINE.label,
    pipelineProperty: 'pipeline',
    stageProperty: 'dealstage',
    defaultStageId: 'appointmentscheduled',
  },
  dealCreation: {
    trigger: 'VQ_SCHEDULED',
    mode: 'ONE_PER_OPPORTUNITY',
    nameTemplate: '{{fullName}} – {{campaign}}',
    opportunityIdProperty: 'am_opportunity_id',
    submissionIdProperty: 'am_submission_id',
    personIdProperty: 'am_person_id',
    closeDateProperty: 'closedate',
    associationCategory: 'HUBSPOT_DEFINED',
    contactToDealAssociationTypeId: null,
    companyToDealAssociationTypeId: null,
  },
  stageEvents: [
    {
      id: 'stage-appointment',
      stageId: 'appointmentscheduled',
      stageLabel: 'Termin vereinbart',
      event: 'VQ_SCHEDULED',
      terminal: true,
    },
    {
      id: 'stage-presentation',
      stageId: 'presentationscheduled',
      stageLabel: 'Präsentation geplant',
      event: 'VQ_ATTENDED',
      terminal: true,
    },
    {
      id: 'stage-qualified',
      stageId: 'qualifiedtobuy',
      stageLabel: 'Qualifiziert',
      event: 'VQ_PASSED',
      terminal: true,
    },
    {
      id: 'stage-decision',
      stageId: 'decisionmakerboughtin',
      stageLabel: 'Entscheider überzeugt',
      event: 'SALES_ACCEPTED',
      terminal: true,
    },
    {
      id: 'stage-contract',
      stageId: 'contractsent',
      stageLabel: 'Vertrag versendet',
      event: 'SALES_ACCEPTED',
      terminal: true,
    },
    {
      id: 'stage-won',
      stageId: 'closedwon',
      stageLabel: 'Gewonnen',
      event: 'CLOSED_WON',
      terminal: true,
      occurredAtProperty: 'closedate',
    },
    {
      id: 'stage-lost',
      stageId: 'closedlost',
      stageLabel: 'Verloren',
      event: 'CLOSED_LOST',
      terminal: true,
    },
  ],
  propertyValueEvents: [
    {
      id: 'vq-rejected',
      objectType: 'contacts',
      property: 'vq_status',
      operator: 'EQUALS',
      values: ['abgelehnt'],
      event: 'VQ_REJECTED',
      once: true,
    },
    {
      id: 'vq-no-show',
      objectType: 'contacts',
      property: 'vq_status',
      operator: 'EQUALS',
      values: ['nicht_erschienen'],
      event: 'VQ_NO_SHOW',
    },
  ],
  revenue: {
    amountProperty: 'amount',
    currencyProperty: 'deal_currency_code',
    fallbackCurrency: 'EUR',
    amountUnit: 'MAJOR',
    recognizedStageIds: ['closedwon'],
    recognizedAtProperty: 'closedate',
  },
  lostRules: {
    lostStageIds: ['closedlost'],
    lostReasonProperty: 'closed_lost_reason',
    disqualifiedReasonValues: ['Nicht qualifiziert'],
    noShowProperty: 'vq_status',
    noShowValues: ['nicht_erschienen'],
    noShowStageIds: [],
  },
  vq: {
    statusProperty: 'vq_status',
    statusValueMap: {
      terminiert: 'SCHEDULED',
      stattgefunden: 'ATTENDED',
      nicht_erschienen: 'NO_SHOW',
      qualifiziert: 'PASSED',
      abgelehnt: 'REJECTED',
    },
    scoreProperty: 'vq_score',
    scoreMin: 0,
    scoreMax: 100,
    reasonCodeProperty: 'vq_reason_codes',
    reasonCodeSeparator: ';',
    modelVersion: null,
    scheduledAtProperty: 'vq_scheduled_at',
  },
  acquisition: {
    contactProperties: {
      campaign_id: 'am_campaign_id',
      campaign_version_id: 'am_campaign_version_id',
      angle_id: 'am_angle_id',
      offer_id: 'am_offer_id',
      creative_id: 'am_creative_id',
      funnel_id: 'am_funnel_id',
      funnel_version_id: 'am_funnel_version_id',
      experiment_id: 'am_experiment_id',
      experiment_arm_id: 'am_experiment_arm_id',
      submission_id: 'am_submission_id',
      utm_source: 'am_utm_source',
      utm_medium: 'am_utm_medium',
      utm_campaign: 'am_utm_campaign',
      utm_content: 'am_utm_content',
    },
    dealProperties: {
      campaign_id: 'am_campaign_id',
      campaign_version_id: 'am_campaign_version_id',
      funnel_version_id: 'am_funnel_version_id',
      submission_id: 'am_submission_id',
    },
    writeOnce: true,
  },
  formFieldMappings: [
    { fieldKey: 'email', property: 'email', transform: 'EMAIL_NORMALIZE' },
    { fieldKey: 'first_name', property: 'firstname', transform: 'TRIM' },
    { fieldKey: 'last_name', property: 'lastname', transform: 'TRIM' },
    { fieldKey: 'phone', property: 'phone', transform: 'PHONE_E164' },
    { fieldKey: 'company_name', property: 'company', transform: 'TRIM' },
  ],
  testLead: {
    markerProperty: 'am_test_record',
    markerValue: 'AM_TEST_LEAD',
    emailLocalPart: 'am-marketing-os-test',
    // `.invalid` is reserved by RFC 2606 and can never reach a real inbox.
    emailDomain: 'fixture.invalid',
    firstName: 'AM',
    lastName: 'Testlead',
    cleanup: 'MARK_ONLY',
  },
  webhook: {
    subscribedObjectTypes: ['contacts', 'deals'],
    subscribedProperties: ['dealstage', 'amount', 'deal_currency_code', 'vq_status'],
    signatureVersion: 'v3',
    toleranceSeconds: 300,
  },
};

/** A complete, launch-ready fixture mapping. */
export const FIXTURE_MAPPING: HubspotMappingDocument =
  mappingDocumentSchema.parse(FIXTURE_MAPPING_INPUT);

/** A draft that still blocks the launch — used by the gate tests and the wizard. */
export const INCOMPLETE_FIXTURE_MAPPING: HubspotMappingDocument = mappingDocumentSchema.parse({
  ...FIXTURE_MAPPING_INPUT,
  version: 1,
  status: 'DRAFT',
  publishedAt: null,
  publishedBy: null,
  pipeline: { ...FIXTURE_MAPPING_INPUT.pipeline, pipelineId: null, defaultStageId: null },
  revenue: { ...FIXTURE_MAPPING_INPUT.revenue, amountProperty: null },
});

/* -------------------------------------------------------------------------- */
/* Submissions                                                                 */
/* -------------------------------------------------------------------------- */

export const FIXTURE_SUBMISSION: LeadSubmission = {
  submissionId: FIXTURE_SUBMISSION_ID,
  personId: FIXTURE_PERSON_ID,
  email: 'Nina.Weber@beispiel-gmbh.de',
  firstName: 'Nina',
  lastName: 'Weber',
  phone: '0170 1234567',
  companyName: 'Beispiel GmbH',
  answers: {
    email: 'Nina.Weber@beispiel-gmbh.de',
    first_name: 'Nina',
    last_name: 'Weber',
    phone: '0170 1234567',
    company_name: 'Beispiel GmbH',
    budget_range: '10000-25000',
  },
  submittedAt: '2026-02-03T10:15:00.000Z',
};

/** Same shape, freemail domain: must never trigger company creation. */
export const FIXTURE_FREEMAIL_SUBMISSION: LeadSubmission = {
  ...FIXTURE_SUBMISSION,
  submissionId: 'b2e5f8a1-6c39-4d72-8e40-1f7a3b9c5d26',
  personId: 'd4a8b0c6-7e51-4f93-8a27-3c6d9e1b4f70',
  email: 'nina.weber@gmail.com',
  companyName: null,
  answers: { ...FIXTURE_SUBMISSION.answers, email: 'nina.weber@gmail.com', company_name: null },
};

export const FIXTURE_ACQUISITION: AcquisitionSnapshotInput = {
  snapshotId: FIXTURE_SNAPSHOT_ID,
  submissionId: FIXTURE_SUBMISSION_ID,
  campaign_id: FIXTURE_CAMPAIGN_ID,
  campaign_version_id: FIXTURE_CAMPAIGN_VERSION_ID,
  funnel_version_id: FIXTURE_FUNNEL_VERSION_ID,
  utm_source: 'facebook',
  utm_medium: 'paid_social',
  utm_campaign: 'q1-neukunden',
  utm_content: 'hook-a',
  channel: 'META_PAID',
  confidence: 'EXACT',
  landing_url: 'https://funnel.example/lp/q1',
};

/* -------------------------------------------------------------------------- */
/* Fixture CRM                                                                 */
/* -------------------------------------------------------------------------- */

/** A small, realistic portal: leads across stages, one won, one lost. */
export function createFixtureCrmSeed(): FixtureSeed {
  return {
    pipelines: [FIXTURE_PIPELINE],
    objects: [
      {
        objectType: 'contacts',
        id: '801',
        properties: {
          email: 'thomas.krause@muster-bau.de',
          firstname: 'Thomas',
          lastname: 'Krause',
          phone: '+4915112345678',
          lifecyclestage: 'salesqualifiedlead',
          vq_status: 'qualifiziert',
          vq_score: '82',
          vq_reason_codes: 'BUDGET_OK;ZEITRAUM_OK',
          am_person_id: '9f1c7b30-4d82-4e56-8a19-0b3c7d5e2f61',
          am_campaign_id: FIXTURE_CAMPAIGN_ID,
        },
      },
      {
        objectType: 'contacts',
        id: '802',
        properties: {
          email: 'sabine.hoffmann@gmx.de',
          firstname: 'Sabine',
          lastname: 'Hoffmann',
          lifecyclestage: 'lead',
          vq_status: 'nicht_erschienen',
          am_person_id: '7c2e5a91-3f64-4b08-9d17-6e0a2c8b5f43',
        },
      },
      {
        objectType: 'companies',
        id: '901',
        properties: { name: 'Muster Bau GmbH', domain: 'muster-bau.de' },
      },
      {
        objectType: 'deals',
        id: '701',
        properties: {
          dealname: 'Thomas Krause – Q1 Neukunden',
          pipeline: 'default',
          dealstage: 'qualifiedtobuy',
          amount: '18500.00',
          deal_currency_code: 'EUR',
          am_opportunity_id: '6b0d3e82-5a17-4c94-8f26-1d7e9b0a3c58',
          am_person_id: '9f1c7b30-4d82-4e56-8a19-0b3c7d5e2f61',
          am_campaign_id: FIXTURE_CAMPAIGN_ID,
        },
      },
      {
        objectType: 'deals',
        id: '702',
        properties: {
          dealname: 'Sabine Hoffmann – Q1 Neukunden',
          pipeline: 'default',
          dealstage: 'closedlost',
          amount: '0',
          deal_currency_code: 'EUR',
          closed_lost_reason: 'Nicht qualifiziert',
          am_opportunity_id: '4e8a1c05-9b73-4d26-8017-2f5c6b3a9d84',
          am_person_id: '7c2e5a91-3f64-4b08-9d17-6e0a2c8b5f43',
        },
      },
    ],
    associations: [
      { fromObjectType: 'contacts', fromObjectId: '801', toObjectType: 'companies', toObjectId: '901' },
      { fromObjectType: 'contacts', fromObjectId: '801', toObjectType: 'deals', toObjectId: '701' },
      { fromObjectType: 'deals', fromObjectId: '701', toObjectType: 'contacts', toObjectId: '801' },
      { fromObjectType: 'contacts', fromObjectId: '802', toObjectType: 'deals', toObjectId: '702' },
      { fromObjectType: 'deals', fromObjectId: '702', toObjectType: 'contacts', toObjectId: '802' },
    ],
  };
}

/** A monotonic clock so fixture output is byte-for-byte reproducible. */
export function createFixtureClock(start = FIXTURE_CREATED_AT, stepMs = 1_000): () => IsoTimestamp {
  let current = Date.parse(start);
  return () => {
    const at = new Date(current).toISOString();
    current += stepMs;
    return at;
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory SyncStore                                                         */
/* -------------------------------------------------------------------------- */

export interface InMemorySyncStore extends SyncStore {
  readonly leads: Map<Uuid, LeadRecord>;
  readonly opportunities: Map<Uuid, OpportunityRecord>;
  readonly events: Map<string, CanonicalEventDraft>;
  readonly mirrors: Map<string, ObjectSnapshot>;
  readonly discrepancies: ReconciliationDiscrepancy[];
  readonly revenueEvents: RevenueEventDraft[];
  eventTypes(): SalesEventType[];
}

/**
 * Reference implementation of the `SyncStore` port.
 *
 * Exported so other packages, the demo seed and the E2E suite can run the whole
 * sync engine without a database. `withLock` is a real per-key mutex, which is
 * what makes the concurrency guarantees testable.
 */
export function createInMemorySyncStore(): InMemorySyncStore {
  const leads = new Map<Uuid, LeadRecord>();
  const opportunities = new Map<Uuid, OpportunityRecord>();
  const events = new Map<string, CanonicalEventDraft>();
  const mirrors = new Map<string, ObjectSnapshot>();
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const revenueEvents: RevenueEventDraft[] = [];
  const locks = new Map<string, Promise<unknown>>();

  const store: InMemorySyncStore = {
    leads,
    opportunities,
    events,
    mirrors,
    discrepancies,
    revenueEvents,

    eventTypes: () => [...events.values()].map((e) => e.type),

    async withLock(key, fn) {
      const previous = locks.get(key) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      // Keep the chain alive even when a caller rejects.
      locks.set(
        key,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },

    async findLeadBySubmission(submissionId) {
      return leads.get(submissionId) ?? null;
    },
    async saveLead(lead) {
      leads.set(lead.submissionId, { ...lead });
    },

    async findOpportunityByPerson(personId) {
      return [...opportunities.values()].find((o) => o.amPersonId === personId) ?? null;
    },
    async findOpportunityBySubmission(submissionId) {
      return (
        [...opportunities.values()].find((o) => o.acquisitionSubmissionId === submissionId) ?? null
      );
    },
    async findOpportunityByDealId(hubspotDealId) {
      return [...opportunities.values()].find((o) => o.hubspotDealId === hubspotDealId) ?? null;
    },
    async saveOpportunity(opportunity) {
      opportunities.set(opportunity.amOpportunityId, { ...opportunity });
    },

    async appendSalesEvents(drafts) {
      const appended: CanonicalEventDraft[] = [];
      for (const draft of drafts) {
        if (events.has(draft.dedupeKey)) continue;
        events.set(draft.dedupeKey, { ...draft });
        appended.push(draft);
      }
      return appended;
    },
    async hasSalesEvent(dedupeKey) {
      return events.has(dedupeKey);
    },
    async listSalesEventTypes(hubspotObjectId) {
      return [...events.values()]
        .filter((e) => e.hubspotObjectId === hubspotObjectId)
        .map((e) => e.type);
    },

    async loadMirror(objectType, objectId) {
      return mirrors.get(`${objectType}:${objectId}`) ?? null;
    },
    async saveMirror(snapshot) {
      mirrors.set(`${snapshot.objectType}:${snapshot.objectId}`, {
        ...snapshot,
        properties: { ...snapshot.properties },
      });
    },
    async listMirrored(objectType) {
      return [...mirrors.values()].filter((m) => m.objectType === objectType);
    },

    async recordDiscrepancy(discrepancy) {
      discrepancies.push(discrepancy);
    },
    async appendRevenueEvent(event) {
      revenueEvents.push(event);
    },
  };

  return store;
}

/** A fresh lead record, for stores and tests that need a starting point. */
export function fixtureLeadRecord(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: 'e5b1d7a3-2c48-4906-8f15-7b0e3a9c6d21',
    amPersonId: FIXTURE_PERSON_ID,
    submissionId: FIXTURE_SUBMISSION_ID,
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: FIXTURE_CREATED_AT,
    hubspotContactId: null,
    hubspotCompanyId: null,
    syncStatus: 'PENDING',
    retry: emptyRetry(RETRY_POLICY.maxAttempts),
    vq: null,
    normalizedEmail: 'nina.weber@beispiel-gmbh.de',
    isTestLead: false,
    ...overrides,
  };
}
