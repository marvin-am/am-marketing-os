import {
  emailDomain,
  isFreemailDomain,
  normalizeEmail,
  normalizePhoneE164,
  nowIso,
  type ConditionOperator,
  type Currency,
  type IsoTimestamp,
  type SalesEventType,
  type VqEvaluation,
  type VqStatus,
} from '@am/domain';
import type {
  AcquisitionSnapshotInput,
  CanonicalEventDraft,
  LeadSubmission,
  ObjectSnapshot,
  PropertyBag,
  WritablePropertyBag,
} from '../types';
import {
  HUBSPOT_STANDARD_PROPERTIES,
  type AcquisitionFieldKey,
  type FieldTransform,
  type HubspotMappingDocument,
  type PropertyValueEventRule,
  type StageEventRule,
} from './schema';

/**
 * Translation between the customer's HubSpot and our canonical sales model.
 *
 * The single most important rule lives here: an event is emitted only on a real
 * state transition. A repeated sync that observes the same stage produces
 * nothing (spec §22, acceptance criterion 32).
 */

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function readProperty(properties: PropertyBag, property: string | null | undefined): string | null {
  if (!property) return null;
  const value = properties[property];
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Parses HubSpot timestamps: ISO-8601 or epoch milliseconds. */
export function parseHubspotTimestamp(raw: string | null): IsoTimestamp | null {
  if (!raw) return null;
  if (/^\d{10,16}$/.test(raw)) {
    const asNumber = Number(raw);
    const ms = raw.length <= 11 ? asNumber * 1000 : asNumber;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Normalises a numeric string: strips thousand separators and settles on `.` as
 * the decimal separator, whichever convention the portal used.
 */
function normalizeNumericString(raw: string): string {
  const cleaned = raw.replace(/\s/g, '').replace(/[^0-9.,-]/g, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  if (lastDot === -1 && lastComma === -1) return cleaned;
  if (lastComma > lastDot) return cleaned.replace(/\./g, '').replace(',', '.');
  return cleaned.replace(/,/g, '');
}

/**
 * Converts a CRM amount into integer minor units.
 *
 * The decimal string is split rather than multiplied by 100: `1.005 * 100` is
 * `100.49999999999999` in binary floating point, and rounding drift across
 * thousands of deals quietly corrupts ROAS (AGENTS.md, "Money").
 */
export function amountToMinor(raw: string | null, unit: 'MAJOR' | 'MINOR'): number | null {
  if (raw === null) return null;
  const normalized = normalizeNumericString(raw);
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(normalized);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return null;

  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] === '' ? '0' : match[2];
  const fraction = match[3] ?? '';

  if (unit === 'MINOR') {
    const value = Number(`${whole}.${fraction || '0'}`);
    return Number.isFinite(value) ? sign * Math.round(value) : null;
  }

  const cents = `${fraction}00`.slice(0, 2);
  const rest = fraction.slice(2);
  let minor = Number(whole) * 100 + Number(cents);
  if (rest.length > 0 && Number(rest[0]) >= 5) minor += 1;
  return Number.isFinite(minor) ? sign * minor : null;
}

function resolveCurrency(properties: PropertyBag, mapping: HubspotMappingDocument): Currency {
  const raw = readProperty(properties, mapping.revenue.currencyProperty);
  if (raw && /^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();
  return mapping.revenue.fallbackCurrency;
}

/**
 * A company is created only for a domain we can actually attribute to a
 * business. Freemail never qualifies — auto-creating "gmail.com Ltd." corrupts
 * the CRM in a way that is very hard to undo (spec §22).
 */
export function isVerifiedCorporateDomain(
  email: string,
  mapping: HubspotMappingDocument,
): boolean {
  const domain = emailDomain(normalizeEmail(email));
  if (!domain) return false;
  if (!domain.includes('.')) return false;
  if (isFreemailDomain(domain)) return false;
  const extra = mapping.company.additionalFreemailDomains.map((d) => d.toLowerCase());
  return !extra.includes(domain);
}

export function shouldCreateCompany(email: string, mapping: HubspotMappingDocument): boolean {
  switch (mapping.company.mode) {
    case 'NEVER':
      return false;
    case 'ALWAYS':
      return emailDomain(normalizeEmail(email)) !== null;
    case 'VERIFIED_CORPORATE_DOMAIN_ONLY':
    default:
      return isVerifiedCorporateDomain(email, mapping);
  }
}

/** True when the given canonical event is the configured deal trigger. */
export function shouldCreateDeal(
  mapping: HubspotMappingDocument,
  event: SalesEventType,
): boolean {
  return mapping.dealCreation.trigger === event;
}

/* -------------------------------------------------------------------------- */
/* Condition evaluation                                                        */
/* -------------------------------------------------------------------------- */

export function evaluateCondition(
  value: string | null,
  operator: ConditionOperator,
  values: readonly string[],
): boolean {
  const compare = values.map((v) => v.trim().toLowerCase());
  const actual = value === null ? null : value.trim().toLowerCase();

  switch (operator) {
    case 'IS_EMPTY':
      return actual === null;
    case 'IS_NOT_EMPTY':
      return actual !== null;
    case 'EQUALS':
      return actual !== null && compare.includes(actual);
    case 'NOT_EQUALS':
      return actual === null || !compare.includes(actual);
    case 'IN':
      return actual !== null && compare.includes(actual);
    case 'NOT_IN':
      return actual === null || !compare.includes(actual);
    case 'GREATER_THAN': {
      const numeric = Number(actual);
      const threshold = Number(compare[0]);
      return Number.isFinite(numeric) && Number.isFinite(threshold) && numeric > threshold;
    }
    case 'LESS_THAN': {
      const numeric = Number(actual);
      const threshold = Number(compare[0]);
      return Number.isFinite(numeric) && Number.isFinite(threshold) && numeric < threshold;
    }
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Transitions → canonical events                                              */
/* -------------------------------------------------------------------------- */

export interface ToCanonicalEventsInput {
  /** The previous observation, or `null` on first sight of the object. */
  before: ObjectSnapshot | null;
  after: ObjectSnapshot;
  mapping: HubspotMappingDocument;
  /** Where the observation came from; defaults to the object type. */
  sourceObject?: CanonicalEventDraft['sourceObject'];
  /** Event types already recorded for this object, for once/terminal rules. */
  emittedEventTypes?: readonly SalesEventType[];
  /** Webhook or sync record id, so an event can be traced back and replayed. */
  sourceEventId?: string | null;
}

function inferSourceObject(
  snapshot: ObjectSnapshot,
  mapping: HubspotMappingDocument,
): CanonicalEventDraft['sourceObject'] {
  if (snapshot.objectType === mapping.objects.deal) return 'DEAL';
  if (snapshot.objectType === mapping.objects.contact) return 'CONTACT';
  return 'INTERNAL';
}

function resolveOccurredAt(
  properties: PropertyBag,
  occurredAtProperty: string | null,
  fallback: IsoTimestamp,
): IsoTimestamp {
  return (
    parseHubspotTimestamp(readProperty(properties, occurredAtProperty)) ??
    parseHubspotTimestamp(readProperty(properties, HUBSPOT_STANDARD_PROPERTIES.lastModified)) ??
    fallback
  );
}

function stageOf(snapshot: ObjectSnapshot | null, mapping: HubspotMappingDocument): string | null {
  if (!snapshot) return null;
  return readProperty(snapshot.properties, mapping.pipeline.stageProperty);
}

function ruleApplies(
  rule: StageEventRule,
  snapshot: ObjectSnapshot,
  mapping: HubspotMappingDocument,
): boolean {
  if (rule.objectType !== snapshot.objectType) return false;
  if (rule.pipelineId) {
    const pipeline = readProperty(snapshot.properties, mapping.pipeline.pipelineProperty);
    if (pipeline && pipeline !== rule.pipelineId) return false;
  }
  return true;
}

function dedupeKeyFor(
  snapshot: ObjectSnapshot,
  type: SalesEventType,
  newState: string,
  occurredAt: IsoTimestamp,
  collapseRepeats: boolean,
): string {
  const base = `${snapshot.objectType}:${snapshot.objectId}:${type}:${newState}`;
  // A terminal or once-only rule collapses every repeat onto a single key; an
  // ordinary rule keeps the transition time so a genuine re-entry is its own
  // event while a replayed webhook is not.
  return collapseRepeats ? base : `${base}:${occurredAt}`;
}

/**
 * Diffs two snapshots and returns the canonical events the transition implies.
 *
 * Returns an empty array when nothing actually changed — including when the
 * same sync runs a hundred times against an unchanged CRM.
 */
export function toCanonicalEvents(input: ToCanonicalEventsInput): CanonicalEventDraft[] {
  const { before, after, mapping } = input;
  const emitted = new Set<SalesEventType>(input.emittedEventTypes ?? []);
  const sourceObject = input.sourceObject ?? inferSourceObject(after, mapping);
  const sourceEventId = input.sourceEventId ?? null;
  const drafts: CanonicalEventDraft[] = [];

  const beforeStage = stageOf(before, mapping);
  const afterStage = stageOf(after, mapping);

  /* --- stage transitions -------------------------------------------------- */
  if (afterStage !== null && afterStage !== beforeStage) {
    for (const rule of mapping.stageEvents) {
      if (rule.stageId !== afterStage) continue;
      if (!ruleApplies(rule, after, mapping)) continue;
      if (rule.terminal && emitted.has(rule.event)) continue;

      const occurredAt = resolveOccurredAt(
        after.properties,
        rule.occurredAtProperty,
        after.observedAt,
      );
      drafts.push({
        type: rule.event,
        occurredAt,
        sourceObject,
        hubspotObjectId: after.objectId,
        previousState: beforeStage,
        newState: afterStage,
        mappingVersion: mapping.version,
        ...revenueFor(rule.event, after, mapping),
        ruleId: rule.id,
        dedupeKey: dedupeKeyFor(after, rule.event, afterStage, occurredAt, rule.terminal),
        sourceEventId,
      });
      emitted.add(rule.event);
    }

    /* --- revenue recognition is stage driven but rule independent ---------- */
    if (
      mapping.revenue.recognizedStageIds.includes(afterStage) &&
      !drafts.some((d) => d.type === 'REVENUE_RECOGNIZED') &&
      !emitted.has('REVENUE_RECOGNIZED')
    ) {
      const occurredAt = resolveOccurredAt(
        after.properties,
        mapping.revenue.recognizedAtProperty,
        after.observedAt,
      );
      drafts.push({
        type: 'REVENUE_RECOGNIZED',
        occurredAt,
        sourceObject,
        hubspotObjectId: after.objectId,
        previousState: beforeStage,
        newState: afterStage,
        mappingVersion: mapping.version,
        ...revenueFor('REVENUE_RECOGNIZED', after, mapping),
        ruleId: 'revenue.recognizedStageIds',
        dedupeKey: dedupeKeyFor(after, 'REVENUE_RECOGNIZED', afterStage, occurredAt, true),
        sourceEventId,
      });
      emitted.add('REVENUE_RECOGNIZED');
    }

    /* --- no-show stages ---------------------------------------------------- */
    if (
      mapping.lostRules.noShowStageIds.includes(afterStage) &&
      !drafts.some((d) => d.type === 'VQ_NO_SHOW')
    ) {
      const occurredAt = resolveOccurredAt(after.properties, null, after.observedAt);
      drafts.push({
        type: 'VQ_NO_SHOW',
        occurredAt,
        sourceObject,
        hubspotObjectId: after.objectId,
        previousState: beforeStage,
        newState: afterStage,
        mappingVersion: mapping.version,
        amountMinor: null,
        currency: null,
        ruleId: 'lostRules.noShowStageIds',
        dedupeKey: dedupeKeyFor(after, 'VQ_NO_SHOW', afterStage, occurredAt, false),
        sourceEventId,
      });
    }
  }

  /* --- property value transitions ---------------------------------------- */
  for (const rule of mapping.propertyValueEvents) {
    if (rule.objectType !== after.objectType) continue;
    const afterValue = readProperty(after.properties, rule.property);
    const beforeValue = before ? readProperty(before.properties, rule.property) : null;
    if (afterValue === beforeValue) continue;

    const matchesAfter = evaluateCondition(afterValue, rule.operator, rule.values);
    if (!matchesAfter) continue;
    const matchedBefore =
      before !== null && evaluateCondition(beforeValue, rule.operator, rule.values);
    if (matchedBefore) continue;
    if (rule.once && emitted.has(rule.event)) continue;

    const occurredAt = resolveOccurredAt(
      after.properties,
      rule.occurredAtProperty,
      after.observedAt,
    );
    const newState = `${rule.property}=${afterValue ?? ''}`;
    drafts.push({
      type: rule.event,
      occurredAt,
      sourceObject,
      hubspotObjectId: after.objectId,
      previousState: beforeValue === null ? null : `${rule.property}=${beforeValue}`,
      newState,
      mappingVersion: mapping.version,
      ...revenueFor(rule.event, after, mapping),
      ruleId: rule.id,
      dedupeKey: dedupeKeyFor(after, rule.event, newState, occurredAt, rule.once),
      sourceEventId,
    });
    emitted.add(rule.event);
  }

  /* --- no-show property -------------------------------------------------- */
  const noShowRule = noShowPropertyTransition(before, after, mapping);
  if (noShowRule && !drafts.some((d) => d.type === 'VQ_NO_SHOW')) {
    drafts.push({ ...noShowRule, sourceObject, sourceEventId });
  }

  return drafts;
}

function noShowPropertyTransition(
  before: ObjectSnapshot | null,
  after: ObjectSnapshot,
  mapping: HubspotMappingDocument,
): Omit<CanonicalEventDraft, 'sourceObject' | 'sourceEventId'> | null {
  const property = mapping.lostRules.noShowProperty;
  if (!property || mapping.lostRules.noShowValues.length === 0) return null;
  const afterValue = readProperty(after.properties, property);
  const beforeValue = before ? readProperty(before.properties, property) : null;
  if (afterValue === beforeValue) return null;
  if (!evaluateCondition(afterValue, 'IN', mapping.lostRules.noShowValues)) return null;
  if (before && evaluateCondition(beforeValue, 'IN', mapping.lostRules.noShowValues)) return null;

  const occurredAt = resolveOccurredAt(after.properties, null, after.observedAt);
  const newState = `${property}=${afterValue ?? ''}`;
  return {
    type: 'VQ_NO_SHOW',
    occurredAt,
    hubspotObjectId: after.objectId,
    previousState: beforeValue === null ? null : `${property}=${beforeValue}`,
    newState,
    mappingVersion: mapping.version,
    amountMinor: null,
    currency: null,
    ruleId: 'lostRules.noShowProperty',
    dedupeKey: dedupeKeyFor(after, 'VQ_NO_SHOW', newState, occurredAt, false),
  };
}

const REVENUE_BEARING_EVENTS: readonly SalesEventType[] = ['CLOSED_WON', 'REVENUE_RECOGNIZED'];

function revenueFor(
  event: SalesEventType,
  snapshot: ObjectSnapshot,
  mapping: HubspotMappingDocument,
): { amountMinor: number | null; currency: Currency | null } {
  if (!REVENUE_BEARING_EVENTS.includes(event)) return { amountMinor: null, currency: null };
  const amountMinor = amountToMinor(
    readProperty(snapshot.properties, mapping.revenue.amountProperty),
    mapping.revenue.amountUnit,
  );
  if (amountMinor === null) return { amountMinor: null, currency: null };
  return { amountMinor, currency: resolveCurrency(snapshot.properties, mapping) };
}

/* -------------------------------------------------------------------------- */
/* Write payloads                                                              */
/* -------------------------------------------------------------------------- */

export function applyTransform(
  value: string | number | boolean | readonly string[] | null | undefined,
  transform: FieldTransform,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const joined = value.join(transform === 'JOIN_SEMICOLON' ? ';' : ',');
    return joined.length === 0 ? null : joined;
  }
  const scalar = value as string | number | boolean;

  switch (transform) {
    case 'TRIM':
      return String(scalar).trim();
    case 'LOWERCASE':
      return String(scalar).trim().toLowerCase();
    case 'UPPERCASE':
      return String(scalar).trim().toUpperCase();
    case 'EMAIL_NORMALIZE':
      return normalizeEmail(String(scalar));
    case 'PHONE_E164':
      return normalizePhoneE164(String(scalar)) ?? String(scalar).trim();
    case 'JOIN_SEMICOLON':
      return String(scalar);
    case 'BOOLEAN_YES_NO':
      return scalar ? 'Ja' : 'Nein';
    case 'BOOLEAN_TRUE_FALSE':
      return scalar ? 'true' : 'false';
    case 'NUMBER': {
      const numeric = Number(scalar);
      return Number.isFinite(numeric) ? numeric : null;
    }
    case 'ISO_DATE': {
      const parsed = parseHubspotTimestamp(String(scalar));
      return parsed ? parsed.slice(0, 10) : null;
    }
    case 'NONE':
    default:
      return typeof scalar === 'boolean' ? scalar : String(scalar);
  }
}

/** Values a form field mapping may draw on beside the answers themselves. */
function submissionSourceValues(
  submission: LeadSubmission,
): Record<string, string | number | boolean | readonly string[] | null> {
  return {
    email: submission.email,
    first_name: submission.firstName ?? null,
    last_name: submission.lastName ?? null,
    phone: submission.phone ?? null,
    company_name: submission.companyName ?? null,
    ...submission.answers,
  };
}

function acquisitionValues(
  acquisition: AcquisitionSnapshotInput | null | undefined,
): Partial<Record<AcquisitionFieldKey, string | null>> {
  if (!acquisition) return {};
  const a = acquisition as unknown as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const value = a[key];
    return value === null || value === undefined ? null : String(value);
  };
  return {
    campaign_id: pick('campaign_id'),
    campaign_version_id: pick('campaign_version_id'),
    angle_id: pick('angle_id'),
    angle_version_id: pick('angle_version_id'),
    offer_id: pick('offer_id'),
    offer_version_id: pick('offer_version_id'),
    creative_id: pick('creative_id'),
    creative_version_id: pick('creative_version_id'),
    funnel_id: pick('funnel_id'),
    funnel_version_id: pick('funnel_version_id'),
    form_id: pick('form_id'),
    form_version_id: pick('form_version_id'),
    experiment_id: pick('experiment_id'),
    experiment_arm_id: pick('experiment_arm_id'),
    utm_source: pick('utm_source'),
    utm_medium: pick('utm_medium'),
    utm_campaign: pick('utm_campaign'),
    utm_content: pick('utm_content'),
    utm_term: pick('utm_term'),
    fbclid: pick('fbclid'),
    fbc: pick('fbc'),
    fbp: pick('fbp'),
    meta_campaign_id: pick('meta_campaign_id'),
    meta_adset_id: pick('meta_adset_id'),
    meta_ad_id: pick('meta_ad_id'),
    landing_url: pick('landing_url'),
    referrer: pick('referrer'),
    channel: pick('channel'),
    attribution_confidence: pick('confidence'),
    submission_id: pick('submissionId'),
    attribution_snapshot_id: pick('snapshotId'),
  };
}

/** Builds the acquisition property bag for one scope. Only mapped slots. */
export function toAcquisitionProperties(
  acquisition: AcquisitionSnapshotInput | null | undefined,
  mapping: HubspotMappingDocument,
  scope: 'contact' | 'deal',
): Record<string, string> {
  const slots = acquisitionValues(acquisition);
  const targets =
    scope === 'contact' ? mapping.acquisition.contactProperties : mapping.acquisition.dealProperties;
  const bag: Record<string, string> = {};
  for (const [slot, property] of Object.entries(targets)) {
    const value = slots[slot as AcquisitionFieldKey];
    if (value === null || value === undefined || value === '') continue;
    bag[property] = value;
  }
  return bag;
}

export interface ToContactPropertiesOptions {
  acquisition?: AcquisitionSnapshotInput | null;
  /** False on a later touch: create-only fields are then left out. */
  includeCreateOnly?: boolean;
}

/**
 * Builds the contact write payload from mapped fields only. An unmapped answer
 * is never guessed into a property — a wrong CRM property is worse than a
 * missing one.
 */
export function toContactProperties(
  submission: LeadSubmission,
  mapping: HubspotMappingDocument,
  options: ToContactPropertiesOptions = {},
): WritablePropertyBag {
  const includeCreateOnly = options.includeCreateOnly ?? true;
  const bag: WritablePropertyBag = {};
  const identifier = mapping.contactIdentifier;

  const email =
    identifier.normalization === 'EMAIL_LOWERCASE'
      ? normalizeEmail(submission.email)
      : submission.email.trim();
  bag[identifier.property] = email;

  if (identifier.personIdProperty) bag[identifier.personIdProperty] = submission.personId;
  if (identifier.firstNameProperty && submission.firstName) {
    bag[identifier.firstNameProperty] = submission.firstName.trim();
  }
  if (identifier.lastNameProperty && submission.lastName) {
    bag[identifier.lastNameProperty] = submission.lastName.trim();
  }
  if (identifier.phoneProperty && submission.phone) {
    bag[identifier.phoneProperty] = normalizePhoneE164(submission.phone) ?? submission.phone.trim();
  }
  if (includeCreateOnly && identifier.leadSourceProperty && identifier.leadSourceValue) {
    bag[identifier.leadSourceProperty] = identifier.leadSourceValue;
  }

  const sources = submissionSourceValues(submission);
  for (const field of mapping.formFieldMappings) {
    if (field.objectType !== mapping.objects.contact) continue;
    if (field.writeOnce && !includeCreateOnly) continue;
    const transformed = applyTransform(sources[field.fieldKey], field.transform);
    if (transformed === null || transformed === '') continue;
    bag[field.property] = transformed;
  }

  Object.assign(bag, toAcquisitionProperties(options.acquisition, mapping, 'contact'));

  if (submission.isTestLead && mapping.testLead.markerProperty) {
    bag[mapping.testLead.markerProperty] = mapping.testLead.markerValue;
  }
  return bag;
}

export function toCompanyProperties(
  submission: LeadSubmission,
  mapping: HubspotMappingDocument,
): WritablePropertyBag {
  const domain = emailDomain(normalizeEmail(submission.email));
  const bag: WritablePropertyBag = {};
  if (domain) bag[mapping.company.domainProperty] = domain;
  bag[mapping.company.nameProperty] = submission.companyName?.trim() || (domain ?? '');
  if (submission.isTestLead && mapping.testLead.markerProperty) {
    bag[mapping.testLead.markerProperty] = mapping.testLead.markerValue;
  }
  return bag;
}

export interface ToDealPropertiesInput {
  submission: LeadSubmission;
  mapping: HubspotMappingDocument;
  amOpportunityId: string;
  acquisition?: AcquisitionSnapshotInput | null;
  stageId?: string | null;
  amountMinor?: number | null;
  currency?: Currency | null;
  campaignLabel?: string | null;
  offerLabel?: string | null;
  closeDate?: IsoTimestamp | null;
  includeCreateOnly?: boolean;
}

export function renderDealName(
  template: string,
  values: Record<string, string | null | undefined>,
): string {
  const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_all, token: string) => {
    const value = values[token];
    return value === null || value === undefined ? '' : value;
  });
  const collapsed = rendered.replace(/\s+/g, ' ').replace(/(^[\s–-]+)|([\s–-]+$)/g, '').trim();
  return collapsed.length > 0 ? collapsed.slice(0, 200) : 'Lead';
}

export function toDealProperties(input: ToDealPropertiesInput): WritablePropertyBag {
  const { mapping, submission } = input;
  const includeCreateOnly = input.includeCreateOnly ?? true;
  const bag: WritablePropertyBag = {};

  const fullName = [submission.firstName, submission.lastName]
    .filter((p): p is string => Boolean(p && p.trim().length > 0))
    .join(' ');
  const normalized = normalizeEmail(submission.email);

  bag[HUBSPOT_STANDARD_PROPERTIES.dealName] = renderDealName(mapping.dealCreation.nameTemplate, {
    firstName: submission.firstName ?? null,
    lastName: submission.lastName ?? null,
    fullName: fullName || normalized,
    email: normalized,
    emailDomain: emailDomain(normalized),
    company: submission.companyName ?? null,
    campaign: input.campaignLabel ?? null,
    offer: input.offerLabel ?? null,
    submissionId: submission.submissionId,
    opportunityId: input.amOpportunityId,
    date: submission.submittedAt.slice(0, 10),
  });

  if (mapping.pipeline.pipelineId) {
    bag[mapping.pipeline.pipelineProperty] = mapping.pipeline.pipelineId;
  }
  const stage = input.stageId ?? mapping.pipeline.defaultStageId;
  if (stage) bag[mapping.pipeline.stageProperty] = stage;

  if (mapping.dealCreation.opportunityIdProperty) {
    bag[mapping.dealCreation.opportunityIdProperty] = input.amOpportunityId;
  }
  if (mapping.dealCreation.submissionIdProperty) {
    bag[mapping.dealCreation.submissionIdProperty] = submission.submissionId;
  }
  if (mapping.dealCreation.personIdProperty) {
    bag[mapping.dealCreation.personIdProperty] = submission.personId;
  }
  if (mapping.dealCreation.closeDateProperty && input.closeDate) {
    bag[mapping.dealCreation.closeDateProperty] = input.closeDate;
  }

  if (
    input.amountMinor !== null &&
    input.amountMinor !== undefined &&
    mapping.revenue.amountProperty
  ) {
    // Sent as a fixed-decimal string so no float artefact reaches the CRM.
    bag[mapping.revenue.amountProperty] =
      mapping.revenue.amountUnit === 'MINOR'
        ? String(input.amountMinor)
        : (input.amountMinor / 100).toFixed(2);
  }
  if (input.currency && mapping.revenue.currencyProperty) {
    bag[mapping.revenue.currencyProperty] = input.currency;
  }

  const sources = submissionSourceValues(submission);
  for (const field of mapping.formFieldMappings) {
    if (field.objectType !== mapping.objects.deal) continue;
    if (field.writeOnce && !includeCreateOnly) continue;
    const transformed = applyTransform(sources[field.fieldKey], field.transform);
    if (transformed === null || transformed === '') continue;
    bag[field.property] = transformed;
  }

  Object.assign(bag, toAcquisitionProperties(input.acquisition, mapping, 'deal'));

  if (submission.isTestLead && mapping.testLead.markerProperty) {
    bag[mapping.testLead.markerProperty] = mapping.testLead.markerValue;
  }
  return bag;
}

/* -------------------------------------------------------------------------- */
/* VQ evaluation                                                               */
/* -------------------------------------------------------------------------- */

export interface ResolveVqOptions {
  /** Injected clock so the evaluation is reproducible in tests. */
  now?: IsoTimestamp;
  /** Current deal stage, used when the portal models VQ through stages only. */
  stageId?: string | null;
}

const STAGE_EVENT_TO_VQ: Readonly<Partial<Record<SalesEventType, VqStatus>>> = {
  VQ_SCHEDULED: 'SCHEDULED',
  VQ_ATTENDED: 'ATTENDED',
  VQ_NO_SHOW: 'NO_SHOW',
  VQ_PASSED: 'PASSED',
  VQ_REJECTED: 'REJECTED',
};

/**
 * Produces a reproducible VQ evaluation: the same properties and the same
 * mapping version always yield the same status, score and reason codes. The
 * model version is frozen so a historical "qualified" decision stays auditable
 * after the qualification rules change (spec §22).
 */
export function resolveVqEvaluation(
  objectProps: PropertyBag,
  mapping: HubspotMappingDocument,
  options: ResolveVqOptions = {},
): VqEvaluation {
  const reasonCodes: string[] = [];
  let status: VqStatus = 'NOT_SCHEDULED';

  const rawStatus = readProperty(objectProps, mapping.vq.statusProperty);
  if (rawStatus !== null) {
    const mapped = matchStatusValue(rawStatus, mapping);
    if (mapped) {
      status = mapped;
    } else {
      reasonCodes.push('VQ_STATUS_UNMAPPED');
    }
  } else if (mapping.vq.statusProperty) {
    reasonCodes.push('VQ_STATUS_MISSING');
  }

  if (status === 'NOT_SCHEDULED' && options.stageId) {
    const stageRule = mapping.stageEvents.find((r) => r.stageId === options.stageId);
    const fromStage = stageRule ? STAGE_EVENT_TO_VQ[stageRule.event] : undefined;
    if (fromStage) status = fromStage;
  }

  if (status === 'NOT_SCHEDULED' && mapping.vq.scheduledAtProperty) {
    const scheduledAt = parseHubspotTimestamp(
      readProperty(objectProps, mapping.vq.scheduledAtProperty),
    );
    if (scheduledAt) status = 'SCHEDULED';
  }

  let score: number | null = null;
  const rawScore = readProperty(objectProps, mapping.vq.scoreProperty);
  if (rawScore !== null) {
    const numeric = Number(rawScore.replace(',', '.'));
    if (Number.isFinite(numeric)) {
      const span = mapping.vq.scoreMax - mapping.vq.scoreMin;
      const normalized =
        span === 0 ? 0 : ((numeric - mapping.vq.scoreMin) / span) * 100;
      score = Math.round(Math.min(100, Math.max(0, normalized)) * 100) / 100;
    } else {
      reasonCodes.push('VQ_SCORE_INVALID');
    }
  } else if (mapping.vq.scoreProperty) {
    reasonCodes.push('VQ_SCORE_MISSING');
  }

  const rawReasons = readProperty(objectProps, mapping.vq.reasonCodeProperty);
  if (rawReasons) {
    for (const code of rawReasons.split(mapping.vq.reasonCodeSeparator)) {
      const trimmed = code.trim().slice(0, 64);
      if (trimmed.length > 0 && !reasonCodes.includes(trimmed)) reasonCodes.push(trimmed);
    }
  }

  const lostReason = readProperty(objectProps, mapping.lostRules.lostReasonProperty);
  if (
    lostReason &&
    mapping.lostRules.disqualifiedReasonValues.some(
      (v) => v.trim().toLowerCase() === lostReason.toLowerCase(),
    )
  ) {
    status = 'REJECTED';
    if (!reasonCodes.includes('DISQUALIFIED')) reasonCodes.push('DISQUALIFIED');
  }

  return {
    vq_status: status,
    vq_score: score,
    vq_reason_codes: reasonCodes.slice(0, 20),
    vq_model_version: vqModelVersion(mapping),
    vq_evaluated_at: options.now ?? nowIso(),
  };
}

export function vqModelVersion(mapping: HubspotMappingDocument): string {
  return (mapping.vq.modelVersion ?? `hubspot-mapping-v${mapping.version}`).slice(0, 40);
}

function matchStatusValue(raw: string, mapping: HubspotMappingDocument): VqStatus | null {
  const needle = raw.trim().toLowerCase();
  for (const [value, status] of Object.entries(mapping.vq.statusValueMap)) {
    if (value.trim().toLowerCase() === needle) return status;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Rule lookup helpers                                                         */
/* -------------------------------------------------------------------------- */

export function stageForEvent(
  mapping: HubspotMappingDocument,
  event: SalesEventType,
): StageEventRule | null {
  return mapping.stageEvents.find((r) => r.event === event) ?? null;
}

export function rulesForEvent(
  mapping: HubspotMappingDocument,
  event: SalesEventType,
): { stages: StageEventRule[]; properties: PropertyValueEventRule[] } {
  return {
    stages: mapping.stageEvents.filter((r) => r.event === event),
    properties: mapping.propertyValueEvents.filter((r) => r.event === event),
  };
}
