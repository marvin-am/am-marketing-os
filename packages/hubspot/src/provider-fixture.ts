import {
  DomainError,
  canWriteHubspot,
  dryRun,
  nowIso,
  type DryRunResult,
  type FeatureFlags,
  type IsoTimestamp,
} from '@am/domain';
import type { PropertyBag } from './types';
import {
  performed,
  type AssociationReadResult,
  type AssociationRecord,
  type BatchReadAssociationsInput,
  type BatchReadInput,
  type ChangeCursor,
  type CreateAssociationInput,
  type CreateDealInput,
  type HubspotObjectRecord,
  type ObjectTypeDefinition,
  type PipelineDefinition,
  type PropertyDefinition,
  type ProviderConnectionProbe,
  type RecentChangePage,
  type SearchContactInput,
  type UpdateObjectInput,
  type UpsertObjectInput,
  type WriteOutcome,
} from './provider-types';

/**
 * A deterministic in-memory CRM.
 *
 * It is realistic on purpose — real property names, a pipeline with stages,
 * associations as their own records — but it never pretends a real portal is
 * connected: `health()` reports `FIXTURE`, never `CONNECTED`.
 *
 * The stage ids below are HubSpot's own out-of-the-box sales pipeline. They are
 * fixture data, not an assumption about the customer's portal; the mapping
 * document is what translates whatever stages actually exist.
 */

const FIXTURE_PORTAL_ID = 'fixture-portal';
const FIRST_OBJECT_ID = 900000001;

export interface FixtureFailureInjection {
  outageRemaining: number;
  rateLimitRemaining: number;
  rateLimitRetryAfterMs: number;
  validationRemaining: number;
  validationOperations: string[] | null;
  validationMessageDe: string;
}

export interface FixtureProviderOptions {
  flags: FeatureFlags;
  /** Injected clock keeps fixture output byte-for-byte reproducible in tests. */
  clock?: () => IsoTimestamp;
  seed?: FixtureSeed;
}

export interface FixtureSeedObject {
  objectType: string;
  id?: string;
  properties: Record<string, string>;
}

export interface FixtureSeedAssociation {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  associationTypeId?: number | null;
}

export interface FixtureSeed {
  objects?: FixtureSeedObject[];
  associations?: FixtureSeedAssociation[];
  pipelines?: PipelineDefinition[];
  properties?: Record<string, PropertyDefinition[]>;
}

interface StoredObject {
  id: string;
  objectType: string;
  properties: Record<string, string>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  archived: boolean;
}

/** HubSpot's default deal pipeline, used as fixture data only. */
export const FIXTURE_PIPELINE: PipelineDefinition = {
  id: 'default',
  label: 'Sales Pipeline',
  objectType: 'deals',
  displayOrder: 0,
  stages: [
    { id: 'appointmentscheduled', label: 'Termin vereinbart', displayOrder: 0, isClosed: false, probability: 0.2 },
    { id: 'qualifiedtobuy', label: 'Qualifiziert', displayOrder: 1, isClosed: false, probability: 0.4 },
    { id: 'presentationscheduled', label: 'Präsentation geplant', displayOrder: 2, isClosed: false, probability: 0.6 },
    { id: 'decisionmakerboughtin', label: 'Entscheider überzeugt', displayOrder: 3, isClosed: false, probability: 0.8 },
    { id: 'contractsent', label: 'Vertrag versendet', displayOrder: 4, isClosed: false, probability: 0.9 },
    { id: 'closedwon', label: 'Gewonnen', displayOrder: 5, isClosed: true, probability: 1 },
    { id: 'closedlost', label: 'Verloren', displayOrder: 6, isClosed: true, probability: 0 },
  ],
};

function property(
  name: string,
  label: string,
  type = 'string',
  fieldType = 'text',
  options: { label: string; value: string }[] = [],
  hasUniqueValue = false,
): PropertyDefinition {
  return {
    name,
    label,
    type,
    fieldType,
    groupName: null,
    options,
    hasUniqueValue,
    calculated: false,
    archived: false,
  };
}

export const FIXTURE_PROPERTIES: Record<string, PropertyDefinition[]> = {
  contacts: [
    property('email', 'E-Mail', 'string', 'text', [], true),
    property('firstname', 'Vorname'),
    property('lastname', 'Nachname'),
    property('phone', 'Telefonnummer'),
    property('company', 'Unternehmen'),
    property('lifecyclestage', 'Lifecycle-Phase', 'enumeration', 'select', [
      { label: 'Lead', value: 'lead' },
      { label: 'Marketing Qualified Lead', value: 'marketingqualifiedlead' },
      { label: 'Sales Qualified Lead', value: 'salesqualifiedlead' },
      { label: 'Kunde', value: 'customer' },
    ]),
    property('hs_lastmodifieddate', 'Zuletzt geändert', 'datetime', 'date'),
    property('am_person_id', 'A&M Personen-ID', 'string', 'text', [], true),
    property('am_submission_id', 'A&M Submission-ID'),
    property('am_campaign_id', 'A&M Kampagnen-ID'),
    property('am_campaign_version_id', 'A&M Kampagnenversions-ID'),
    property('am_angle_id', 'A&M Angle-ID'),
    property('am_offer_id', 'A&M Offer-ID'),
    property('am_creative_id', 'A&M Creative-ID'),
    property('am_funnel_id', 'A&M Funnel-ID'),
    property('am_funnel_version_id', 'A&M Funnelversions-ID'),
    property('am_experiment_id', 'A&M Experiment-ID'),
    property('am_experiment_arm_id', 'A&M Experimentarm-ID'),
    property('am_utm_source', 'UTM Source'),
    property('am_utm_medium', 'UTM Medium'),
    property('am_utm_campaign', 'UTM Campaign'),
    property('am_utm_content', 'UTM Content'),
    property('am_test_record', 'Testdatensatz'),
    property('vq_status', 'VQ-Status', 'enumeration', 'select', [
      { label: 'Terminiert', value: 'terminiert' },
      { label: 'Stattgefunden', value: 'stattgefunden' },
      { label: 'Nicht erschienen', value: 'nicht_erschienen' },
      { label: 'Qualifiziert', value: 'qualifiziert' },
      { label: 'Abgelehnt', value: 'abgelehnt' },
    ]),
    property('vq_score', 'VQ-Score', 'number', 'number'),
    property('vq_reason_codes', 'VQ-Gründe'),
    property('vq_scheduled_at', 'VQ-Termin', 'datetime', 'date'),
  ],
  companies: [
    property('name', 'Name'),
    property('domain', 'Domain', 'string', 'text', [], true),
    property('hs_lastmodifieddate', 'Zuletzt geändert', 'datetime', 'date'),
    property('am_test_record', 'Testdatensatz'),
  ],
  deals: [
    property('dealname', 'Deal-Name'),
    property('amount', 'Betrag', 'number', 'number'),
    property('deal_currency_code', 'Währung'),
    property('dealstage', 'Deal-Phase', 'enumeration', 'select'),
    property('pipeline', 'Pipeline', 'enumeration', 'select'),
    property('closedate', 'Abschlussdatum', 'datetime', 'date'),
    property('hs_lastmodifieddate', 'Zuletzt geändert', 'datetime', 'date'),
    property('closed_lost_reason', 'Verlustgrund'),
    property('am_opportunity_id', 'A&M Opportunity-ID', 'string', 'text', [], true),
    property('am_person_id', 'A&M Personen-ID'),
    property('am_submission_id', 'A&M Submission-ID'),
    property('am_campaign_id', 'A&M Kampagnen-ID'),
    property('am_campaign_version_id', 'A&M Kampagnenversions-ID'),
    property('am_funnel_version_id', 'A&M Funnelversions-ID'),
    property('am_test_record', 'Testdatensatz'),
  ],
};

export const FIXTURE_OBJECT_TYPES: ObjectTypeDefinition[] = [
  { objectType: 'contacts', singularLabel: 'Kontakt', pluralLabel: 'Kontakte', custom: false },
  { objectType: 'companies', singularLabel: 'Unternehmen', pluralLabel: 'Unternehmen', custom: false },
  { objectType: 'deals', singularLabel: 'Deal', pluralLabel: 'Deals', custom: false },
];

export class FixtureHubspotProvider {
  private readonly flags: FeatureFlags;
  private readonly clock: () => IsoTimestamp;
  private readonly objects = new Map<string, StoredObject>();
  private readonly associations: AssociationRecord[] = [];
  private readonly pipelines: PipelineDefinition[];
  private readonly properties: Record<string, PropertyDefinition[]>;
  private nextId = FIRST_OBJECT_ID;

  private failure: FixtureFailureInjection = {
    outageRemaining: 0,
    rateLimitRemaining: 0,
    rateLimitRetryAfterMs: 2_000,
    validationRemaining: 0,
    validationOperations: null,
    validationMessageDe: 'HubSpot hat die Anfrage abgelehnt: Pflichtfeld fehlt.',
  };

  /** Every call the provider has served, for assertions in tests. */
  readonly calls: { operation: string; at: IsoTimestamp }[] = [];

  constructor(options: FixtureProviderOptions) {
    this.flags = options.flags;
    this.clock = options.clock ?? nowIso;
    this.pipelines = options.seed?.pipelines ?? [FIXTURE_PIPELINE];
    this.properties = options.seed?.properties ?? FIXTURE_PROPERTIES;
    for (const seeded of options.seed?.objects ?? []) this.seedObject(seeded);
    for (const association of options.seed?.associations ?? []) {
      this.addAssociation({
        fromObjectType: association.fromObjectType,
        fromObjectId: association.fromObjectId,
        toObjectType: association.toObjectType,
        toObjectId: association.toObjectId,
        associationCategory: 'HUBSPOT_DEFINED',
        associationTypeId: association.associationTypeId ?? null,
      });
    }
  }

  /**
   * Stores an association and its inverse.
   *
   * HubSpot associations are readable from either side, so a link written as
   * contact→deal is also returned when reading deal→contact. The inverse keeps
   * `associationTypeId: null` because the type ids are directional and the
   * inverse id is not something we may invent.
   */
  private addAssociation(record: AssociationRecord): void {
    const push = (candidate: AssociationRecord): void => {
      const exists = this.associations.some(
        (a) =>
          a.fromObjectType === candidate.fromObjectType &&
          a.fromObjectId === candidate.fromObjectId &&
          a.toObjectType === candidate.toObjectType &&
          a.toObjectId === candidate.toObjectId,
      );
      if (!exists) this.associations.push(candidate);
    };

    push(record);
    push({
      fromObjectType: record.toObjectType,
      fromObjectId: record.toObjectId,
      toObjectType: record.fromObjectType,
      toObjectId: record.fromObjectId,
      associationCategory: record.associationCategory,
      associationTypeId: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Test seams                                                              */
  /* ---------------------------------------------------------------------- */

  /** Makes every subsequent call fail as if HubSpot were unreachable. */
  simulateOutage(enabled: boolean | { times: number }): void {
    this.failure.outageRemaining =
      typeof enabled === 'boolean' ? (enabled ? Number.MAX_SAFE_INTEGER : 0) : enabled.times;
  }

  /** Makes the next `times` calls answer 429 with a `Retry-After`. */
  simulateRateLimit(options: { times?: number; retryAfterMs?: number } = {}): void {
    this.failure.rateLimitRemaining = options.times ?? 1;
    this.failure.rateLimitRetryAfterMs = options.retryAfterMs ?? 2_000;
  }

  /** Makes the next `times` matching write calls fail validation. */
  simulateValidationError(
    options: { times?: number; operations?: string[]; messageDe?: string } = {},
  ): void {
    this.failure.validationRemaining = options.times ?? 1;
    this.failure.validationOperations = options.operations ?? null;
    if (options.messageDe) this.failure.validationMessageDe = options.messageDe;
  }

  clearFailures(): void {
    this.failure = {
      outageRemaining: 0,
      rateLimitRemaining: 0,
      rateLimitRetryAfterMs: 2_000,
      validationRemaining: 0,
      validationOperations: null,
      validationMessageDe: 'HubSpot hat die Anfrage abgelehnt: Pflichtfeld fehlt.',
    };
  }

  /** All stored objects of a type, for assertions. */
  listAll(objectType: string): HubspotObjectRecord[] {
    return [...this.objects.values()]
      .filter((o) => o.objectType === objectType && !o.archived)
      .map(toRecord);
  }

  listAssociations(): AssociationRecord[] {
    return this.associations.map((a) => ({ ...a }));
  }

  /** Directly mutates a stored object — used to simulate CRM-side changes. */
  patchObject(objectId: string, properties: Record<string, string>): HubspotObjectRecord {
    const stored = this.objects.get(objectId);
    if (!stored) {
      throw new DomainError('NOT_FOUND', {
        messageDe: 'Der Fixture-Datensatz existiert nicht.',
        details: { objectId },
      });
    }
    Object.assign(stored.properties, properties);
    stored.updatedAt = this.clock();
    stored.properties.hs_lastmodifieddate = stored.updatedAt;
    return toRecord(stored);
  }

  seedObject(seed: FixtureSeedObject): HubspotObjectRecord {
    const id = seed.id ?? String(this.nextId++);
    const at = this.clock();
    const stored: StoredObject = {
      id,
      objectType: seed.objectType,
      properties: { ...seed.properties, hs_object_id: id, hs_lastmodifieddate: at },
      createdAt: at,
      updatedAt: at,
      archived: false,
    };
    this.objects.set(id, stored);
    return toRecord(stored);
  }

  /* ---------------------------------------------------------------------- */
  /* Failure gate                                                            */
  /* ---------------------------------------------------------------------- */

  private guard(operation: string): void {
    this.calls.push({ operation, at: this.clock() });

    if (this.failure.outageRemaining > 0) {
      if (this.failure.outageRemaining !== Number.MAX_SAFE_INTEGER) {
        this.failure.outageRemaining -= 1;
      }
      throw new DomainError('PROVIDER_ERROR', {
        messageDe: 'HubSpot ist derzeit nicht erreichbar.',
        details: { operation, simulated: 'OUTAGE' },
        retryable: true,
      });
    }

    if (this.failure.rateLimitRemaining > 0) {
      this.failure.rateLimitRemaining -= 1;
      throw new DomainError('PROVIDER_RATE_LIMITED', {
        messageDe: 'HubSpot hat das Anfragelimit begrenzt. Die Synchronisation wird wiederholt.',
        details: {
          operation,
          simulated: 'RATE_LIMIT',
          retryAfterMs: this.failure.rateLimitRetryAfterMs,
        },
        retryable: true,
      });
    }

    const matchesOperation =
      this.failure.validationOperations === null ||
      this.failure.validationOperations.includes(operation);
    if (this.failure.validationRemaining > 0 && matchesOperation) {
      this.failure.validationRemaining -= 1;
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: this.failure.validationMessageDe,
        details: { operation, simulated: 'VALIDATION' },
      });
    }
  }

  private blocked(operation: string, wouldSend: Record<string, unknown>): DryRunResult {
    return dryRun(
      'HUBSPOT',
      operation,
      wouldSend,
      'HubSpot-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / HUBSPOT_WRITES_ENABLED = false).',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async health(): Promise<ProviderConnectionProbe> {
    this.guard('hubspot.health');
    return {
      reachable: true,
      // Never CONNECTED: a fixture must not look like a real portal.
      state: 'FIXTURE',
      grantedScopes: [],
      accountLabel: 'Fixture-Portal (Demo-Daten)',
      portalId: FIXTURE_PORTAL_ID,
      detailDe: 'Es läuft der Fixture-Modus. Es besteht keine Verbindung zu einem HubSpot-Portal.',
      checkedAt: this.clock(),
    };
  }

  async listObjectTypes(): Promise<ObjectTypeDefinition[]> {
    this.guard('hubspot.listObjectTypes');
    return FIXTURE_OBJECT_TYPES.map((t) => ({ ...t }));
  }

  async listProperties(objectType: string): Promise<PropertyDefinition[]> {
    this.guard('hubspot.listProperties');
    return (this.properties[objectType] ?? []).map((p) => ({ ...p }));
  }

  async listPipelines(objectType = 'deals'): Promise<PipelineDefinition[]> {
    this.guard('hubspot.listPipelines');
    return this.pipelines
      .filter((p) => p.objectType === objectType)
      .map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s })) }));
  }

  async batchReadObjects(input: BatchReadInput): Promise<HubspotObjectRecord[]> {
    this.guard('hubspot.batchReadObjects');
    const wanted = new Set(input.properties);
    const found: HubspotObjectRecord[] = [];

    for (const id of input.ids) {
      const stored = input.idProperty
        ? this.findByProperty(input.objectType, input.idProperty, id)
        : this.objects.get(id);
      if (!stored || stored.objectType !== input.objectType || stored.archived) continue;
      const record = toRecord(stored);
      const properties: PropertyBag = {};
      for (const key of wanted) properties[key] = record.properties[key] ?? null;
      found.push({ ...record, properties });
    }
    return found;
  }

  async searchContactByEmail(input: SearchContactInput): Promise<HubspotObjectRecord | null> {
    this.guard('hubspot.searchContactByEmail');
    const stored = this.findByProperty(
      input.objectType,
      input.identifierProperty,
      input.identifierValue,
    );
    if (!stored) return null;
    const record = toRecord(stored);
    const properties: PropertyBag = {};
    for (const key of input.properties) properties[key] = record.properties[key] ?? null;
    return { ...record, properties };
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  private upsert(
    operation: string,
    input: UpsertObjectInput,
  ): WriteOutcome<HubspotObjectRecord> {
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        objectType: input.objectType,
        objectId: input.objectId ?? null,
        idProperty: input.idProperty ?? null,
        idValue: input.idValue ?? null,
        properties: input.properties,
        idempotencyKey: input.idempotencyKey,
      });
    }
    this.guard(operation);

    const existing =
      (input.objectId ? this.objects.get(input.objectId) : undefined) ??
      (input.idProperty && input.idValue
        ? this.findByProperty(input.objectType, input.idProperty, input.idValue)
        : undefined);

    const at = this.clock();
    const stringified = stringifyProperties(input.properties);

    if (existing) {
      Object.assign(existing.properties, stringified);
      existing.updatedAt = at;
      existing.properties.hs_lastmodifieddate = at;
      return performed(toRecord(existing));
    }

    const id = String(this.nextId++);
    const stored: StoredObject = {
      id,
      objectType: input.objectType,
      properties: { ...stringified, hs_object_id: id, hs_lastmodifieddate: at },
      createdAt: at,
      updatedAt: at,
      archived: false,
    };
    this.objects.set(id, stored);
    return performed(toRecord(stored));
  }

  async upsertContact(input: UpsertObjectInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    return this.upsert('hubspot.upsertContact', input);
  }

  async upsertCompany(input: UpsertObjectInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    return this.upsert('hubspot.upsertCompany', input);
  }

  async createDeal(input: CreateDealInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    const operation = 'hubspot.createDeal';
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        objectType: input.objectType,
        properties: input.properties,
        idempotencyKey: input.idempotencyKey,
      });
    }
    this.guard(operation);

    const at = this.clock();
    const id = String(this.nextId++);
    const stored: StoredObject = {
      id,
      objectType: input.objectType,
      properties: {
        ...stringifyProperties(input.properties),
        hs_object_id: id,
        hs_lastmodifieddate: at,
      },
      createdAt: at,
      updatedAt: at,
      archived: false,
    };
    this.objects.set(id, stored);
    return performed(toRecord(stored));
  }

  async updateDeal(input: UpdateObjectInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    const operation = 'hubspot.updateDeal';
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        objectType: input.objectType,
        objectId: input.objectId,
        properties: input.properties,
        idempotencyKey: input.idempotencyKey,
      });
    }
    this.guard(operation);

    const stored = this.objects.get(input.objectId);
    if (!stored) {
      throw new DomainError('NOT_FOUND', {
        messageDe: 'Der Deal wurde in HubSpot nicht gefunden.',
        details: { objectId: input.objectId },
      });
    }
    Object.assign(stored.properties, stringifyProperties(input.properties));
    stored.updatedAt = this.clock();
    stored.properties.hs_lastmodifieddate = stored.updatedAt;
    return performed(toRecord(stored));
  }

  async createAssociation(
    input: CreateAssociationInput,
  ): Promise<WriteOutcome<AssociationRecord>> {
    const operation = 'hubspot.createAssociation';
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        fromObjectType: input.fromObjectType,
        fromObjectId: input.fromObjectId,
        toObjectType: input.toObjectType,
        toObjectId: input.toObjectId,
        associationCategory: input.associationCategory,
        associationTypeId: input.associationTypeId,
        idempotencyKey: input.idempotencyKey,
      });
    }
    this.guard(operation);

    const record: AssociationRecord = {
      fromObjectType: input.fromObjectType,
      fromObjectId: input.fromObjectId,
      toObjectType: input.toObjectType,
      toObjectId: input.toObjectId,
      associationCategory: input.associationCategory,
      associationTypeId: input.associationTypeId,
    };
    this.addAssociation(record);
    return performed(record);
  }

  async batchReadAssociations(
    input: BatchReadAssociationsInput,
  ): Promise<AssociationReadResult[]> {
    this.guard('hubspot.batchReadAssociations');
    return input.fromObjectIds.map((fromObjectId) => ({
      fromObjectId,
      toObjectIds: this.associations
        .filter(
          (a) =>
            a.fromObjectType === input.fromObjectType &&
            a.fromObjectId === fromObjectId &&
            a.toObjectType === input.toObjectType,
        )
        .map((a) => a.toObjectId),
    }));
  }

  async listRecentChanges(cursor: ChangeCursor | null): Promise<RecentChangePage> {
    this.guard('hubspot.listRecentChanges');
    const objectType = cursor?.objectType ?? 'deals';
    const since = cursor?.since ?? '1970-01-01T00:00:00.000Z';
    const sinceMs = Date.parse(since);

    const changed = [...this.objects.values()]
      .filter((o) => o.objectType === objectType && Date.parse(o.updatedAt) >= sinceMs)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));

    const changes = changed.map((o) => ({
      objectType,
      objectId: o.id,
      occurredAt: o.updatedAt,
      changedProperties: [] as string[],
    }));

    const latest = changes.length > 0 ? changes[changes.length - 1].occurredAt : since;
    return {
      changes,
      nextCursor: { since: latest, after: null, objectType },
      hasMore: false,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private findByProperty(
    objectType: string,
    property: string,
    value: string,
  ): StoredObject | undefined {
    const needle = value.trim().toLowerCase();
    return [...this.objects.values()].find(
      (o) =>
        o.objectType === objectType &&
        !o.archived &&
        (o.properties[property] ?? '').trim().toLowerCase() === needle,
    );
  }
}

function stringifyProperties(
  properties: Record<string, string | number | boolean>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) out[key] = String(value);
  return out;
}

function toRecord(stored: StoredObject): HubspotObjectRecord {
  const properties: PropertyBag = {};
  for (const [key, value] of Object.entries(stored.properties)) properties[key] = value;
  return {
    id: stored.id,
    objectType: stored.objectType,
    properties,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    archived: stored.archived,
  };
}
