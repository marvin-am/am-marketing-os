/**
 * Pixel + Conversions API.
 *
 * Three rules shape this module:
 *
 * 1. **One source of truth.** The browser pixel payload and the server event are
 *    produced by the same function. They therefore cannot drift in event name
 *    or event id, which is exactly what Meta deduplicates on.
 * 2. **Business time, never retry time.** `event_time` is always derived from
 *    the business timestamp handed in. A retry re-sends the same event with the
 *    same time and the same id.
 * 3. **Nothing free-text, nothing unhashed.** `custom_data` is a closed schema,
 *    so a qualification answer physically cannot reach the wire; identifiers are
 *    normalised and SHA-256 hashed; IP and user agent travel only with consent.
 *
 * Documented limits (see the report for which of these could be verified
 * against Meta's primary documentation and which come from secondary sources):
 *
 * - Web events are rejected when `event_time` is more than **7 days** in the
 *   past. Offline / dataset events allow up to **62 days**.
 * - Pixel and server events deduplicate on `event_name` + `event_id` within a
 *   **48-hour** window.
 */
import {
  type CapiStage,
  type ConsentRecord,
  type FeatureFlags,
  type Money,
  type SalesEventType,
  DomainError,
  ONCE_PER_OPPORTUNITY_STAGES,
  SALES_EVENT_TO_CAPI_STAGE,
  capiEventIdSource,
  findPiiViolations,
  initialLeadEventIdSource,
  mayUseForAdMeasurement,
  normalizeEmail,
  normalizePhoneE164,
  nowIso,
  sha256Hex,
} from '@am/domain';
import { logger } from '@am/observability';
import { assertOutboundAllowed } from './import-mode';
import type { CapiDispatchResult, MetaProvider, MutationOutcome } from './provider';
import {
  type CapiActionSource,
  type CapiCustomData,
  type CapiServerEvent,
  type CapiUserData,
  type PixelPayload,
  capiCustomDataSchema,
  capiServerEventSchema,
  capiUserDataSchema,
  pixelPayloadSchema,
} from './types';

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** Web / `action_source: 'website'` events older than this are refused by Meta. */
export const CAPI_MAX_EVENT_AGE_DAYS = 7;

/** Offline / dataset events (CRM stage changes) may reach further back. */
export const CAPI_OFFLINE_MAX_EVENT_AGE_DAYS = 62;

/** Pixel↔server deduplication window on (`event_name`, `event_id`). */
export const CAPI_DEDUP_WINDOW_HOURS = 48;

/** Tolerated clock skew for an event that appears to be in the future. */
export const CAPI_FUTURE_SKEW_MS = 60_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function toUnixSeconds(iso: string): number {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Der Ereigniszeitpunkt ist kein gültiger Zeitstempel.',
      details: { value: iso },
    });
  }
  return Math.floor(ms / 1000);
}

/**
 * Refuses an event whose business time Meta would reject.
 *
 * This is the guard that stops a historical import from being replayed to Meta
 * with a fabricated "now" timestamp: the honest answer is that the event is too
 * old to send, not a rewritten timestamp (AGENTS.md rule 1).
 */
export function assertEventTimeAcceptable(
  eventTime: string,
  now: string = nowIso(),
  maxAgeDays: number = CAPI_MAX_EVENT_AGE_DAYS,
): void {
  const eventMs = new Date(eventTime).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Der Ereigniszeitpunkt ist kein gültiger Zeitstempel.',
      details: { event_time: eventTime, now },
    });
  }

  if (eventMs > nowMs + CAPI_FUTURE_SKEW_MS) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Der Ereigniszeitpunkt liegt in der Zukunft und wurde nicht gesendet.',
      details: { event_time: eventTime, now },
    });
  }

  const ageDays = (nowMs - eventMs) / MS_PER_DAY;
  if (ageDays > maxAgeDays) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: `Das Ereignis ist ${Math.floor(ageDays)} Tage alt. Meta akzeptiert höchstens ${maxAgeDays} Tage; es wurde nicht gesendet und der Zeitstempel wurde nicht verändert.`,
      retryable: false,
      details: {
        event_time: eventTime,
        now,
        age_days: Number(ageDays.toFixed(2)),
        max_age_days: maxAgeDays,
      },
    });
  }
}

export function maxAgeDaysFor(actionSource: CapiActionSource): number {
  return actionSource === 'website' ? CAPI_MAX_EVENT_AGE_DAYS : CAPI_OFFLINE_MAX_EVENT_AGE_DAYS;
}

/* -------------------------------------------------------------------------- */
/* Event names                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `Lead` is Meta's standard event for the initial website lead. The three
 * down-funnel stages are custom events; the names are configurable because they
 * must match whatever is registered in Events Manager, and a mismatch silently
 * costs optimisation signal rather than erroring.
 */
export const CAPI_STAGE_EVENT_NAMES: Readonly<Record<CapiStage, string>> = {
  INITIAL_LEAD: 'Lead',
  MARKETING_QUALIFIED_LEAD: 'MarketingQualifiedLead',
  SALES_OPPORTUNITY: 'SalesOpportunity',
  CONVERTED: 'Converted',
};

export function capiStageEventName(
  stage: CapiStage,
  overrides?: Partial<Record<CapiStage, string>>,
): string {
  return overrides?.[stage] ?? CAPI_STAGE_EVENT_NAMES[stage];
}

export function stageForSalesEvent(type: SalesEventType): CapiStage | null {
  return SALES_EVENT_TO_CAPI_STAGE[type] ?? null;
}

export function isOncePerOpportunity(stage: CapiStage): boolean {
  return ONCE_PER_OPPORTUNITY_STAGES.includes(stage);
}

/* -------------------------------------------------------------------------- */
/* Normalisation + hashing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Meta's normalisation rules. Hashing is deterministic, so a single uppercase
 * letter that we normalise differently makes the field contribute nothing.
 */
export function normalizeEmailForMeta(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = normalizeEmail(raw);
  return normalized.includes('@') ? normalized : null;
}

/** E.164 without the leading `+`: country code plus digits, nothing else. */
export function normalizePhoneForMeta(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e164 = normalizePhoneE164(raw);
  if (!e164) return null;
  return e164.replace(/^\+/, '');
}

/** Lowercase, punctuation removed, internal whitespace collapsed. */
export function normalizeNameForMeta(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/** Lowercase, all whitespace and punctuation removed ("Bad Homburg" → "badhomburg"). */
export function normalizeCityForMeta(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  return normalized.length > 0 ? normalized : null;
}

export function normalizeStateForMeta(raw: string | null | undefined): string | null {
  return normalizeCityForMeta(raw);
}

/**
 * Lowercase, whitespace and separators removed. US ZIP+4 is truncated to the
 * leading five digits; German five-digit codes pass through unchanged.
 */
export function normalizeZipForMeta(
  raw: string | null | undefined,
  country?: string | null,
): string | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[\s\-.]/g, '');
  if (normalized.length === 0) return null;
  if ((country ?? '').toLowerCase() === 'us') return normalized.slice(0, 5);
  return normalized;
}

/** ISO-3166-1 alpha-2, lowercase. */
export function normalizeCountryForMeta(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(normalized) ? normalized : null;
}

export async function hashForMeta(value: string | null): Promise<string | undefined> {
  if (value === null || value.length === 0) return undefined;
  return sha256Hex(value);
}

/**
 * Meta's `fbc` cookie format: `fb.<subdomainIndex>.<creationTimeMs>.<fbclid>`.
 * Derived server-side when the browser cookie is missing but the click id was
 * captured on the landing URL.
 */
export function deriveFbc(
  fbclid: string | null | undefined,
  clickTimeMs: number,
  subdomainIndex = 1,
): string | null {
  if (!fbclid) return null;
  return `fb.${subdomainIndex}.${Math.floor(clickTimeMs)}.${fbclid}`;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export interface LeadIdentity {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  /** ISO-3166-1 alpha-2. Defaults to `de` for our market. */
  country?: string | null;
  /** Stable internal person id. Hashed before it is sent. */
  externalId?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  fbclid?: string | null;
  /** Milliseconds of the click, used only to derive `fbc` from `fbclid`. */
  fbclidObservedAtMs?: number | null;
  /** Sent only when consent for ad measurement was granted. */
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  /** Meta lead-ad id, for the conversion-leads CRM integration. Not hashed. */
  leadId?: string | null;
}

export interface CapiConsent {
  /** `mayUseForAdMeasurement(record)` from `@am/domain`. */
  adMeasurement: boolean;
}

export function consentFromRecord(record: ConsentRecord | null): CapiConsent {
  return { adMeasurement: mayUseForAdMeasurement(record) };
}

/**
 * Builds `user_data`: hashed identifiers, raw click identifiers, and IP/user
 * agent only when consent for ad measurement was granted. There is deliberately
 * no way to pass an already-hashed value in — hashing happens here so the
 * normalisation cannot be bypassed.
 */
export async function buildUserData(
  identity: LeadIdentity,
  consent: CapiConsent,
  options: {
    /**
     * Used to synthesise `fbc` when only an `fbclid` was captured. Callers pass
     * the event's business time so the derived cookie is deterministic — a
     * retry must not produce a different `fbc` than the first attempt.
     */
    fallbackClickTimeMs?: number;
  } = {},
): Promise<CapiUserData> {
  const country = normalizeCountryForMeta(identity.country ?? 'de');

  const userData: CapiUserData = {
    em: await hashForMeta(normalizeEmailForMeta(identity.email)),
    ph: await hashForMeta(normalizePhoneForMeta(identity.phone)),
    fn: await hashForMeta(normalizeNameForMeta(identity.firstName)),
    ln: await hashForMeta(normalizeNameForMeta(identity.lastName)),
    ct: await hashForMeta(normalizeCityForMeta(identity.city)),
    st: await hashForMeta(normalizeStateForMeta(identity.state)),
    zp: await hashForMeta(normalizeZipForMeta(identity.postalCode, country)),
    country: await hashForMeta(country),
    external_id: await hashForMeta(identity.externalId ?? null),
  };

  const fbc =
    identity.fbc ??
    deriveFbc(
      identity.fbclid,
      identity.fbclidObservedAtMs ?? options.fallbackClickTimeMs ?? Date.now(),
    ) ??
    undefined;
  if (fbc) userData.fbc = fbc;
  if (identity.fbp) userData.fbp = identity.fbp;
  if (identity.leadId) userData.lead_id = identity.leadId;

  // IP address and user agent are personal data with no consent-free basis here.
  if (consent.adMeasurement) {
    if (identity.clientIpAddress) userData.client_ip_address = identity.clientIpAddress;
    if (identity.clientUserAgent) userData.client_user_agent = identity.clientUserAgent;
  }

  for (const key of Object.keys(userData) as (keyof CapiUserData)[]) {
    if (userData[key] === undefined) delete userData[key];
  }

  return capiUserDataSchema.parse(userData);
}

/* -------------------------------------------------------------------------- */
/* Custom data                                                                 */
/* -------------------------------------------------------------------------- */

function customDataFrom(input: {
  value?: Money | null;
  contentName?: string | null;
  leadEventSource?: string | null;
  eventSource?: string | null;
  orderId?: string | null;
  status?: string | null;
}): CapiCustomData | undefined {
  const data: CapiCustomData = {};
  if (input.value) {
    data.value = input.value.amountMinor / 100;
    data.currency = input.value.currency;
  }
  if (input.contentName) data.content_name = input.contentName;
  if (input.leadEventSource) data.lead_event_source = input.leadEventSource;
  if (input.eventSource) data.event_source = input.eventSource;
  if (input.orderId) data.order_id = input.orderId;
  if (input.status) data.status = input.status;
  const parsed = capiCustomDataSchema.parse(data);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * `custom_data` is a closed schema, so a free-text answer cannot get through by
 * construction. This guard catches the remaining risk: someone stuffing a
 * sentence into `content_name` or `status`.
 */
export function assertNoSensitiveCustomData(customData: CapiCustomData | undefined): void {
  if (!customData) return;
  const violations = findPiiViolations(customData);
  const longText = Object.entries(customData).filter(
    ([, value]) => typeof value === 'string' && value.length > 120,
  );
  if (violations.length > 0 || longText.length > 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe:
        'Das CAPI-Ereignis enthält Freitext oder personenbezogene Daten in den Zusatzfeldern und wurde nicht gesendet.',
      details: { violations, long_fields: longText.map(([key]) => key) },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Initial website lead — pixel and server from one source                     */
/* -------------------------------------------------------------------------- */

export interface InitialLeadInput {
  submissionId: string;
  pixelId: string;
  /** Business time of the submission. Never the dispatch or retry time. */
  occurredAt: string;
  eventSourceUrl: string;
  identity: LeadIdentity;
  consent: CapiConsent;
  eventName?: string;
  actionSource?: CapiActionSource;
  value?: Money | null;
  contentName?: string | null;
  leadEventSource?: string | null;
}

export interface InitialLeadEventPair {
  eventId: string;
  eventName: string;
  /** Handed to `fbq('track', eventName, customData, { eventID })` in the browser. */
  pixel: PixelPayload;
  server: CapiServerEvent;
}

/**
 * Derives the shared event id for the initial website lead.
 *
 * The canonical string comes from `@am/domain` (`lead:<submission_id>`); it is
 * hashed so no internal uuid leaves the system, and so it has the same shape as
 * every down-funnel id.
 */
export async function initialLeadEventId(submissionId: string): Promise<string> {
  return sha256Hex(initialLeadEventIdSource(submissionId));
}

/**
 * The single source of truth for the initial lead. `buildPixelPayload` and
 * `buildServerEvent` both delegate here, which is what guarantees that the
 * browser and the server agree on `event_name` and `event_id`.
 */
export async function buildInitialLeadEvent(
  input: InitialLeadInput,
): Promise<InitialLeadEventPair> {
  const eventId = await initialLeadEventId(input.submissionId);
  const eventName = input.eventName ?? CAPI_STAGE_EVENT_NAMES.INITIAL_LEAD;
  const actionSource = input.actionSource ?? 'website';

  const customData = customDataFrom({
    value: input.value ?? null,
    contentName: input.contentName ?? null,
    leadEventSource: input.leadEventSource ?? null,
  });
  assertNoSensitiveCustomData(customData);

  const server = capiServerEventSchema.parse({
    event_name: eventName,
    event_time: toUnixSeconds(input.occurredAt),
    event_id: eventId,
    event_source_url: input.eventSourceUrl,
    action_source: actionSource,
    user_data: await buildUserData(input.identity, input.consent, {
      fallbackClickTimeMs: new Date(input.occurredAt).getTime(),
    }),
    custom_data: customData,
  });

  const pixel = pixelPayloadSchema.parse({
    pixelId: input.pixelId,
    eventName,
    eventID: eventId,
    customData,
  });

  return { eventId, eventName, pixel, server };
}

export async function buildPixelPayload(input: InitialLeadInput): Promise<PixelPayload> {
  return (await buildInitialLeadEvent(input)).pixel;
}

export async function buildServerEvent(input: InitialLeadInput): Promise<CapiServerEvent> {
  return (await buildInitialLeadEvent(input)).server;
}

/** True when the pair would deduplicate at Meta. Used by the contract tests. */
export function willDeduplicate(pixel: PixelPayload, server: CapiServerEvent): boolean {
  return pixel.eventID === server.event_id && pixel.eventName === server.event_name;
}

/* -------------------------------------------------------------------------- */
/* Down-funnel stages                                                          */
/* -------------------------------------------------------------------------- */

export interface StageEventInput {
  /** Stable form instance the transition belongs to. */
  formInstanceId: string;
  /** Monotonic version of this transition; a correction increments it. */
  transitionVersion: number;
  stage: CapiStage;
  /** Business time of the CRM transition. */
  occurredAt: string;
  identity: LeadIdentity;
  consent: CapiConsent;
  actionSource?: CapiActionSource;
  value?: Money | null;
  opportunityId?: string | null;
  /** Name of the CRM the stage change came from, e.g. "HubSpot". */
  crmName?: string | null;
  eventNameOverrides?: Partial<Record<CapiStage, string>>;
}

/**
 * `event_id = sha256(form_instance_id:event_type:transition_version)`
 * (spec §23). The canonical string is built by `capiEventIdSource` in
 * `@am/domain`, with the semantic CAPI stage as the event type — the stage is
 * the stable name, whereas the CRM's own stage labels change.
 */
export async function stageEventId(
  formInstanceId: string,
  stage: CapiStage,
  transitionVersion: number,
): Promise<string> {
  return sha256Hex(capiEventIdSource(formInstanceId, stage, transitionVersion));
}

export async function buildStageEvent(input: StageEventInput): Promise<CapiServerEvent> {
  const eventId = await stageEventId(input.formInstanceId, input.stage, input.transitionVersion);
  const eventName = capiStageEventName(input.stage, input.eventNameOverrides);
  const actionSource = input.actionSource ?? 'system_generated';

  if (input.stage === 'CONVERTED' && (!input.value || input.value.amountMinor <= 0)) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe:
        'Ein CONVERTED-Ereignis benötigt den gebuchten Wert und die Währung. Es wurde nicht gesendet.',
      details: { stage: input.stage, opportunity_id: input.opportunityId ?? null },
    });
  }

  const customData = customDataFrom({
    value: input.value ?? null,
    leadEventSource: input.crmName ?? null,
    eventSource: input.crmName ? 'crm' : null,
    orderId: input.stage === 'CONVERTED' ? (input.opportunityId ?? null) : null,
    status: input.stage,
  });
  assertNoSensitiveCustomData(customData);

  return capiServerEventSchema.parse({
    event_name: eventName,
    event_time: toUnixSeconds(input.occurredAt),
    event_id: eventId,
    action_source: actionSource,
    user_data: await buildUserData(input.identity, input.consent, {
      fallbackClickTimeMs: new Date(input.occurredAt).getTime(),
    }),
    custom_data: customData,
  });
}

/* -------------------------------------------------------------------------- */
/* CONVERTED — exactly once per opportunity                                    */
/* -------------------------------------------------------------------------- */

export interface ConvertedDispatchRecord {
  opportunityId: string;
  eventId: string;
  dispatchedAt: string;
  /** The value that was actually reported to Meta. */
  amountMinor: number;
  currency: string;
  /** The closed-won business timestamp that was reported. */
  closedWonAt: string;
}

export interface ConvertedLedger {
  get(opportunityId: string): Promise<ConvertedDispatchRecord | null>;
  put(record: ConvertedDispatchRecord): Promise<void>;
}

export function createInMemoryConvertedLedger(): ConvertedLedger {
  const entries = new Map<string, ConvertedDispatchRecord>();
  return {
    get: async (opportunityId) => entries.get(opportunityId) ?? null,
    put: async (record) => {
      entries.set(record.opportunityId, record);
    },
  };
}

export interface ReconciliationDiscrepancy {
  kind: 'CONVERTED_ALREADY_DISPATCHED' | 'CONVERTED_VALUE_CHANGED';
  opportunityId: string;
  dispatchedAmountMinor: number;
  currentAmountMinor: number;
  /** `current − dispatched`, matching `revenue_events.reconciliation_delta_minor`. */
  deltaMinor: number;
  currency: string;
  detectedAt: string;
  noteDe: string;
}

export type ConvertedOutcome =
  | {
      dispatched: true;
      event: CapiServerEvent;
      record: ConvertedDispatchRecord;
      discrepancy: null;
    }
  | {
      dispatched: false;
      event: null;
      record: ConvertedDispatchRecord;
      discrepancy: ReconciliationDiscrepancy;
    };

export interface ConvertedEventInput extends Omit<StageEventInput, 'stage'> {
  opportunityId: string;
  /** Closed-won business time. Also used as `occurredAt`. */
  closedWonAt: string;
  value: Money;
}

/**
 * Prepares the CONVERTED event, or refuses it.
 *
 * A second closed-won for the same opportunity never produces a second event:
 * a changed deal value becomes a `ReconciliationDiscrepancy` the console shows
 * next to the revenue figure. Sending CONVERTED twice would double-count
 * revenue inside Meta's optimiser and inside our own ROAS.
 */
export async function prepareConvertedEvent(
  input: ConvertedEventInput,
  ledger: ConvertedLedger,
  now: string = nowIso(),
): Promise<ConvertedOutcome> {
  const existing = await ledger.get(input.opportunityId);

  if (existing) {
    const deltaMinor = input.value.amountMinor - existing.amountMinor;
    const changed = deltaMinor !== 0 || input.value.currency !== existing.currency;
    return {
      dispatched: false,
      event: null,
      record: existing,
      discrepancy: {
        kind: changed ? 'CONVERTED_VALUE_CHANGED' : 'CONVERTED_ALREADY_DISPATCHED',
        opportunityId: input.opportunityId,
        dispatchedAmountMinor: existing.amountMinor,
        currentAmountMinor: input.value.amountMinor,
        deltaMinor,
        currency: existing.currency,
        detectedAt: now,
        noteDe: changed
          ? `Der Dealwert hat sich nach dem CONVERTED-Versand um ${(deltaMinor / 100).toFixed(2)} ${input.value.currency} geändert. Es wurde kein zweites CONVERTED gesendet; die Differenz ist als Abgleich vermerkt.`
          : 'Für diese Opportunity wurde bereits ein CONVERTED gesendet. Es wurde kein zweites Ereignis erzeugt.',
      },
    };
  }

  const event = await buildStageEvent({
    ...input,
    stage: 'CONVERTED',
    occurredAt: input.closedWonAt,
    value: input.value,
  });

  const record: ConvertedDispatchRecord = {
    opportunityId: input.opportunityId,
    eventId: event.event_id as string,
    dispatchedAt: now,
    amountMinor: input.value.amountMinor,
    currency: input.value.currency,
    closedWonAt: input.closedWonAt,
  };
  await ledger.put(record);

  return { dispatched: true, event, record, discrepancy: null };
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

function hashPreview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `sha256:${value.slice(0, 8)}…`;
}

/**
 * The only representation of a CAPI payload that may be logged or persisted.
 * Hashes are truncated (a full hash is a stable pseudonymous identifier), raw
 * identifiers are reduced to presence flags, and the URL loses its query string
 * because launch tokens and UTMs live there.
 */
export function redactCapiPayload(event: CapiServerEvent): Record<string, unknown> {
  const user = event.user_data;
  let sourceUrl: string | null = null;
  if (event.event_source_url) {
    try {
      const parsed = new URL(event.event_source_url);
      sourceUrl = `${parsed.origin}${parsed.pathname}`;
    } catch {
      sourceUrl = '[unparsbar]';
    }
  }

  return {
    event_name: event.event_name,
    event_time: event.event_time,
    event_id: event.event_id ?? null,
    action_source: event.action_source,
    event_source_url: sourceUrl,
    user_data: {
      em: hashPreview(user.em) ?? null,
      ph: hashPreview(user.ph) ?? null,
      fn: hashPreview(user.fn) ?? null,
      ln: hashPreview(user.ln) ?? null,
      ct: hashPreview(user.ct) ?? null,
      st: hashPreview(user.st) ?? null,
      zp: hashPreview(user.zp) ?? null,
      country: hashPreview(user.country) ?? null,
      external_id: hashPreview(user.external_id) ?? null,
      fbp: user.fbp ? '[vorhanden]' : null,
      fbc: user.fbc ? '[vorhanden]' : null,
      lead_id: user.lead_id ? '[vorhanden]' : null,
      client_ip_address: user.client_ip_address ? '[redigiert]' : null,
      client_user_agent: user.client_user_agent ? '[redigiert]' : null,
    },
    custom_data: event.custom_data ?? null,
  };
}

/** Stable hash of the full payload, for the outbox `payload_hash` column. */
export async function capiPayloadHash(event: CapiServerEvent): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(event)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Proof that the server-side pipeline ran before dispatch. CAPI is never fired
 * from the request that received the form — only after spam scoring and
 * validation have completed (spec §23).
 */
export interface DispatchGate {
  spamChecked: boolean;
  spamAccepted: boolean;
  validated: boolean;
}

export function assertServerSideValidated(gate: DispatchGate): void {
  if (!gate.spamChecked || !gate.validated) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe:
        'Das Ereignis wurde noch nicht serverseitig geprüft. Ohne abgeschlossene Spam- und Validitätsprüfung wird nichts an Meta gesendet.',
      details: { spam_checked: gate.spamChecked, validated: gate.validated },
    });
  }
  if (!gate.spamAccepted) {
    throw new DomainError('SPAM_REJECTED', {
      messageDe:
        'Die Übermittlung wurde als Spam eingestuft. Es wurde kein Ereignis an Meta gesendet.',
      details: { spam_accepted: false },
    });
  }
}

export interface CapiDispatchOptions {
  destinationId: string;
  gate: DispatchGate;
  now?: string;
  /** Overrides the per-`action_source` default. */
  maxAgeDays?: number;
  testEventCode?: string | null;
}

/**
 * Validates and dispatches a batch.
 *
 * Guard order is deliberate: the validation gate and the import-mode guard run
 * before anything else, then per-event validation, and only then the provider —
 * which performs its own flag check and returns a `DryRunResult` when writes are
 * disabled.
 */
export async function dispatchCapiEvents(
  events: readonly CapiServerEvent[],
  provider: MetaProvider,
  flags: FeatureFlags,
  options: CapiDispatchOptions,
): Promise<MutationOutcome<CapiDispatchResult>> {
  if (events.length === 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Es wurden keine Ereignisse zum Senden übergeben.',
    });
  }

  assertServerSideValidated(options.gate);
  assertOutboundAllowed('meta.capi_dispatch');

  const now = options.now ?? nowIso();
  const validated = events.map((event) => {
    const parsed = capiServerEventSchema.parse(event);
    assertEventTimeAcceptable(
      new Date(parsed.event_time * 1000).toISOString(),
      now,
      options.maxAgeDays ?? maxAgeDaysFor(parsed.action_source),
    );
    assertNoSensitiveCustomData(parsed.custom_data);
    return parsed;
  });

  logger.info('capi_dispatch_prepared', {
    provider: 'META',
    destination_id: options.destinationId,
    event_count: validated.length,
    // Only ever the redacted view — never the raw payload (AGENTS.md rule 7).
    events: validated.map(redactCapiPayload),
    flags_allow_dispatch: flags.externalWritesEnabled && flags.metaCapiEnabled,
  });

  return provider.sendCapiEvents({
    destinationId: options.destinationId,
    events: validated,
    testEventCode: options.testEventCode ?? null,
  });
}
