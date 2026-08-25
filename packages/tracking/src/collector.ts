import { createHash } from 'node:crypto';
import {
  DomainError,
  EVENT_SCHEMA_VERSION,
  err,
  findPiiViolations,
  newId,
  nowIso,
  ok,
  trackingEventSchema,
  type AppEnvironment,
  type ConsentStatus,
  type DomainErrorCode,
  type Result,
  type TrackingContext,
  type TrackingEvent,
  type TrafficKind,
} from '@am/domain';
import { TRACKING_CONTEXT_KEYS, emptyTrackingContext } from './tokens';

/**
 * Event ingestion.
 *
 * Framework-agnostic by design — the Next route handler is a thin shell that
 * resolves identity and traffic kind, then calls `ingestBatch`. Everything that
 * decides whether an event is stored lives here, where it can be unit-tested
 * without a request object.
 */

/* -------------------------------------------------------------------------- */
/* PII guard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The hard PII guard (rule 7, acceptance criterion 29). An analytics payload
 * carrying a name, an e-mail, a phone number or a raw answer set is rejected
 * outright — never sanitised and stored, because a "cleaned" event teaches the
 * emitting code that sending PII is survivable.
 */
export function findEventPiiViolations(payload: unknown): string[] {
  return findPiiViolations(payload);
}

export function piiRejection(violations: readonly string[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    messageDe: 'Das Ereignis wurde abgelehnt: Es enthält personenbezogene Daten.',
    details: { reason: 'PII_DETECTED', violations: [...violations] },
  });
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

export interface CollectorContext {
  environment: AppEnvironment;
  /** Decided at the edge by `classifyTraffic`; the client never sets it. */
  trafficKind: TrafficKind;
  /** Server receive time. Defaults to now. */
  receivedAt?: string;
  /**
   * Internal ids recovered from a verified launch token. These win over
   * anything the payload claims — see `tokens.ts` for the trust rule.
   */
  trusted?: Partial<TrackingContext> | null;
  /**
   * Consent as the *server* knows it. The browser does not get to assert its
   * own consent status — that is the whole point of recording consent.
   */
  consentStatus?: TrackingEvent['consent_status'];
  /** Test seam for `event_id` generation. */
  generateId?: () => string;
  /** In-process idempotency guard; the database unique index is the real one. */
  dedupe?: EventDedupeStore;
  limiter?: RateLimiter;
  rateLimitKey?: string;
  maxBatchSize?: number;
}

export const DEFAULT_MAX_BATCH_SIZE = 50;

/**
 * Fills the server-owned fields, applies trusted ids and validates against
 * `trackingEventSchema`. The PII scan runs over the *raw* input, before the
 * schema strips unknown keys — otherwise an `answers` blob would be silently
 * dropped instead of loudly rejected.
 */
export function normalizeEvent(input: unknown, ctx: CollectorContext): Result<TrackingEvent> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(
      new DomainError('VALIDATION_FAILED', {
        messageDe: 'Das Ereignis hat kein gültiges Format.',
      }),
    );
  }

  const violations = findEventPiiViolations(input);
  if (violations.length > 0) return err(piiRejection(violations));

  const raw = input as Record<string, unknown>;
  const version = raw.event_schema_version;
  if (version !== undefined && version !== EVENT_SCHEMA_VERSION) {
    return err(
      new DomainError('VALIDATION_FAILED', {
        messageDe: 'Das Ereignis verwendet eine nicht unterstützte Schema-Version.',
        details: { received: version, expected: EVENT_SCHEMA_VERSION },
      }),
    );
  }

  const generateId = ctx.generateId ?? (() => newId());
  const eventId = typeof raw.event_id === 'string' && raw.event_id.length > 0
    ? raw.event_id
    : generateId();

  // Internal identifiers are server-owned. Everything the client claims for a
  // field in the tracking context is discarded before the trusted values are
  // applied — overlaying the token on top of the client's payload is not
  // enough, because a field the token happens not to carry would keep whatever
  // the browser sent.
  //
  // Without this, anyone could POST to the collector claiming any campaign,
  // creative or experiment arm and have it stored as production traffic:
  // inflating a campaign's sessions, skewing an experiment's denominators, and
  // asserting GRANTED consent nobody gave.
  const clientClaimed: Record<string, unknown> = { ...raw };
  for (const key of TRACKING_CONTEXT_KEYS) delete clientClaimed[key];
  delete clientClaimed.consent_status;

  const candidate: Record<string, unknown> = {
    ...clientClaimed,
    ...emptyTrackingContext(),
    event_id: eventId,
    event_schema_version: EVENT_SCHEMA_VERSION,
    received_at: ctx.receivedAt ?? nowIso(),
    environment: ctx.environment,
    traffic_kind: ctx.trafficKind,
    // Consent is a server-side fact recorded at submission, never a browser
    // assertion. An event may only report what the server already knows.
    consent_status: ctx.consentStatus ?? 'UNKNOWN',
  };

  if (ctx.trusted) {
    for (const [key, value] of Object.entries(ctx.trusted)) {
      if (value !== null && value !== undefined) candidate[key] = value;
    }
  }

  const parsed = trackingEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new DomainError('VALIDATION_FAILED', {
        messageDe: 'Das Ereignis entspricht nicht dem Ereignis-Schema.',
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
          })),
        },
      }),
    );
  }

  // Belt and braces: prove the row that is about to be stored is clean, not just
  // the payload that arrived.
  const storedViolations = findEventPiiViolations(parsed.data);
  if (storedViolations.length > 0) return err(piiRejection(storedViolations));

  return ok(parsed.data);
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                 */
/* -------------------------------------------------------------------------- */

export interface EventDedupeStore {
  has(eventId: string): boolean;
  add(eventId: string): void;
}

/**
 * Bounded in-memory dedupe. Serverless instances are short-lived and there may
 * be many of them, so this only removes the common case — a retried beacon or a
 * double flush hitting the same instance. Durable idempotency is the unique
 * index on `tracking_events.event_id`.
 */
export function createMemoryDedupeStore(maxEntries = 10_000): EventDedupeStore {
  const seen = new Set<string>();
  return {
    has: (eventId) => seen.has(eventId),
    add: (eventId) => {
      if (seen.size >= maxEntries) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.add(eventId);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

export interface TokenBucketState {
  tokens: number;
  updatedAtMs: number;
}

export interface RateLimitStore {
  read(key: string): TokenBucketState | undefined;
  write(key: string, state: TokenBucketState): void;
  clear(key?: string): void;
}

export function createMemoryRateLimitStore(maxKeys = 10_000): RateLimitStore {
  const buckets = new Map<string, TokenBucketState>();
  return {
    read: (key) => buckets.get(key),
    write: (key, state) => {
      if (!buckets.has(key) && buckets.size >= maxKeys) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      buckets.set(key, state);
    },
    clear: (key) => {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },
  };
}

/** 60 events of burst, refilling at one per second. */
export const DEFAULT_RATE_LIMIT_CAPACITY = 60;
export const DEFAULT_RATE_LIMIT_REFILL_PER_SECOND = 1;

export interface RateLimiterOptions {
  capacity?: number;
  refillPerSecond?: number;
  /** Swap in Redis/Postgres in production; the default is per-instance memory. */
  store?: RateLimitStore;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

export interface RateLimiter {
  readonly capacity: number;
  take(key: string, cost?: number, nowMs?: number): RateLimitDecision;
  reset(key?: string): void;
}

/**
 * Token bucket. Chosen over a fixed window because a legitimate funnel emits
 * events in bursts (a step change fires three events at once) and a fixed
 * window either rejects those bursts or has to be set so wide that it stops
 * limiting anything.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_RATE_LIMIT_CAPACITY);
  const refillPerSecond = Math.max(
    0,
    options.refillPerSecond ?? DEFAULT_RATE_LIMIT_REFILL_PER_SECOND,
  );
  const store = options.store ?? createMemoryRateLimitStore();

  return {
    capacity,
    take(key, cost = 1, nowMs = Date.now()) {
      const previous = store.read(key) ?? { tokens: capacity, updatedAtMs: nowMs };
      const elapsedSeconds = Math.max(0, (nowMs - previous.updatedAtMs) / 1000);
      const tokens = Math.min(capacity, previous.tokens + elapsedSeconds * refillPerSecond);

      if (tokens < cost) {
        store.write(key, { tokens, updatedAtMs: nowMs });
        const deficit = cost - tokens;
        return {
          allowed: false,
          remaining: Math.floor(tokens),
          retryAfterSeconds:
            refillPerSecond > 0 ? Math.ceil(deficit / refillPerSecond) : Number.POSITIVE_INFINITY,
          limit: capacity,
        };
      }

      store.write(key, { tokens: tokens - cost, updatedAtMs: nowMs });
      return {
        allowed: true,
        remaining: Math.floor(tokens - cost),
        retryAfterSeconds: 0,
        limit: capacity,
      };
    },
    reset(key) {
      store.clear(key);
    },
  };
}

/**
 * Rate-limit keys are hashed. An IP address is personal data and must never sit
 * in a cache key, a log line or a metric label (rule 7).
 */
export function hashIdentifier(value: string, salt = ''): string {
  return createHash('sha256').update(`${salt}:${value}`, 'utf8').digest('hex').slice(0, 32);
}

export function rateLimitKeyFor(input: {
  visitorId?: string | null;
  ipAddress?: string | null;
  salt?: string;
}): string {
  if (input.visitorId) return `v:${hashIdentifier(input.visitorId, input.salt)}`;
  if (input.ipAddress) return `i:${hashIdentifier(input.ipAddress, input.salt)}`;
  return 'anon';
}

/* -------------------------------------------------------------------------- */
/* Batch ingestion                                                             */
/* -------------------------------------------------------------------------- */

export interface RejectedEvent {
  index: number;
  reasonDe: string;
  code: DomainErrorCode;
  details: Record<string, unknown>;
}

export interface IngestBatchResult {
  accepted: TrackingEvent[];
  rejected: RejectedEvent[];
  /**
   * Event ids that were already known. A duplicate is not an error — the client
   * retried, which is exactly what it should do — so it is reported separately
   * and the caller still answers 200.
   */
  duplicates: string[];
}

function toRejection(index: number, error: DomainError): RejectedEvent {
  return {
    index,
    reasonDe: error.messageDe,
    code: error.code,
    details: error.details,
  };
}

/**
 * Validates and de-duplicates a batch.
 *
 * One bad event never fails the batch: each entry is accepted or rejected on its
 * own so that a single malformed payload from one browser cannot drop the
 * legitimate events queued beside it.
 */
export function ingestBatch(
  events: readonly unknown[],
  ctx: CollectorContext,
): IngestBatchResult {
  const accepted: TrackingEvent[] = [];
  const rejected: RejectedEvent[] = [];
  const duplicates: string[] = [];
  const maxBatchSize = ctx.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const batchLocalIds = new Set<string>();

  events.forEach((raw, index) => {
    if (index >= maxBatchSize) {
      rejected.push(
        toRejection(
          index,
          new DomainError('RATE_LIMITED', {
            messageDe: `Es werden höchstens ${maxBatchSize} Ereignisse pro Anfrage verarbeitet.`,
            details: { maxBatchSize },
          }),
        ),
      );
      return;
    }

    if (ctx.limiter) {
      const decision = ctx.limiter.take(ctx.rateLimitKey ?? 'anon');
      if (!decision.allowed) {
        rejected.push(
          toRejection(
            index,
            new DomainError('RATE_LIMITED', {
              details: { retryAfterSeconds: decision.retryAfterSeconds },
            }),
          ),
        );
        return;
      }
    }

    const normalized = normalizeEvent(raw, ctx);
    if (!normalized.ok) {
      rejected.push(toRejection(index, normalized.error));
      return;
    }

    const eventId = normalized.value.event_id;
    if (batchLocalIds.has(eventId) || ctx.dedupe?.has(eventId) === true) {
      duplicates.push(eventId);
      return;
    }

    batchLocalIds.add(eventId);
    ctx.dedupe?.add(eventId);
    accepted.push(normalized.value);
  });

  return { accepted, rejected, duplicates };
}

/* -------------------------------------------------------------------------- */
/* Server-derived abandonment                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_FORM_ABANDON_MINUTES = 30;

export interface FormInstanceActivity {
  form_instance_id: string;
  visitor_id: string;
  session_id: string;
  /** ISO-8601. */
  started_at: string;
  /** ISO-8601 timestamp of the last event seen for this instance. */
  last_activity_at: string;
  submitted: boolean;
  /** True once a `form_abandoned` event has already been derived. */
  abandoned_recorded?: boolean;
  /** Last step the visitor reached. */
  step_id?: string | null;
  environment?: AppEnvironment;
  traffic_kind?: TrafficKind;
  consent_status?: ConsentStatus;
  context?: Partial<TrackingContext> | null;
}

export interface DeriveAbandonedOptions {
  environment?: AppEnvironment;
  trafficKind?: TrafficKind;
  receivedAt?: string;
}

/**
 * Stable id for a derived event, so a re-run of the job produces the same
 * `event_id` and the insert is idempotent instead of duplicating abandonment.
 */
export function deterministicUuid(namespace: string, name: string): string {
  const bytes = createHash('sha256').update(`${namespace}:${name}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5-shaped
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Derives `form_abandoned` server-side.
 *
 * Explicitly *not* driven by `beforeunload`: that event does not fire reliably
 * on mobile Safari, fires spuriously on tab switches elsewhere, and cannot
 * distinguish "left the page" from "came back two minutes later". Abandonment
 * is instead defined as an inactivity window elapsing without a submission —
 * a definition that is reproducible from stored data, which means the number
 * can be recomputed and audited later.
 *
 * `occurred_at` is the moment the window elapsed, not the moment the job ran,
 * so that re-running a delayed job cannot shift yesterday's abandonment into
 * today's report.
 */
export function deriveAbandonedForms(
  instances: readonly FormInstanceActivity[],
  now: Date,
  inactivityMinutes: number = DEFAULT_FORM_ABANDON_MINUTES,
  options: DeriveAbandonedOptions = {},
): TrackingEvent[] {
  const nowMs = now.getTime();
  const inactivityMs = Math.max(1, inactivityMinutes) * 60_000;
  const receivedAt = options.receivedAt ?? now.toISOString();
  const events: TrackingEvent[] = [];

  for (const instance of instances) {
    if (instance.submitted || instance.abandoned_recorded === true) continue;

    const lastActivityMs = Date.parse(instance.last_activity_at);
    const startedMs = Date.parse(instance.started_at);
    if (!Number.isFinite(lastActivityMs) || !Number.isFinite(startedMs)) continue;
    if (nowMs - lastActivityMs < inactivityMs) continue;

    const candidate = {
      ...(instance.context ?? {}),
      event_id: deterministicUuid('form_abandoned', instance.form_instance_id),
      event_type: 'form_abandoned',
      event_schema_version: EVENT_SCHEMA_VERSION,
      occurred_at: new Date(lastActivityMs + inactivityMs).toISOString(),
      received_at: receivedAt,
      environment: instance.environment ?? options.environment ?? 'production',
      traffic_kind: instance.traffic_kind ?? options.trafficKind ?? 'PRODUCTION',
      visitor_id: instance.visitor_id,
      session_id: instance.session_id,
      form_instance_id: instance.form_instance_id,
      step_id: instance.step_id ?? null,
      consent_status: instance.consent_status ?? 'UNKNOWN',
      metadata: {
        inactivity_minutes: inactivityMinutes,
        seconds_on_form: Math.max(0, Math.round((lastActivityMs - startedMs) / 1000)),
      },
    };

    const parsed = trackingEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Ein abgebrochenes Formular konnte nicht in ein gültiges Ereignis übersetzt werden.',
        details: {
          form_instance_id: instance.form_instance_id,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      });
    }
    events.push(parsed.data);
  }

  return events;
}

/* -------------------------------------------------------------------------- */
/* Experiment exposure                                                         */
/* -------------------------------------------------------------------------- */

export function exposureKey(experimentId: string, visitorId: string, sessionId: string): string {
  return `${experimentId}:${visitorId}:${sessionId}`;
}

export interface ExposureRegistry {
  has(key: string): boolean;
  add(key: string): void;
  size(): number;
}

export function createExposureRegistry(maxEntries = 10_000): ExposureRegistry {
  const seen = new Set<string>();
  return {
    has: (key) => seen.has(key),
    add: (key) => {
      if (seen.size >= maxEntries) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.add(key);
    },
    size: () => seen.size,
  };
}

export type ExposureSkipReason =
  | 'NOT_RENDERED'
  | 'ALREADY_RECORDED'
  | 'NON_PRODUCTION_TRAFFIC';

export interface ShouldRecordExposureInput {
  experimentId: string;
  visitorId: string;
  sessionId: string;
  /** True only when the variant actually reached the screen. */
  rendered: boolean;
  isRecorded?: ReadonlySet<string> | ((key: string) => boolean);
  trafficKind?: TrafficKind;
}

export interface ExposureDecision {
  record: boolean;
  key: string;
  reason: ExposureSkipReason | null;
}

/**
 * An exposure is written on an actual render, exactly once per
 * (experiment, visitor, session) — acceptance criterion 12.
 *
 * Assignment alone must never produce one: a visitor bucketed into an arm they
 * never saw (redirect, bounce before paint, server-side prefetch) would dilute
 * that arm's conversion rate with impressions that never happened, which is the
 * classic way an A/B test quietly reports a loser as a winner.
 */
export function shouldRecordExposure(input: ShouldRecordExposureInput): ExposureDecision {
  const key = exposureKey(input.experimentId, input.visitorId, input.sessionId);

  if (!input.rendered) return { record: false, key, reason: 'NOT_RENDERED' };

  const trafficKind = input.trafficKind ?? 'PRODUCTION';
  if (trafficKind !== 'PRODUCTION') {
    return { record: false, key, reason: 'NON_PRODUCTION_TRAFFIC' };
  }

  const recorded =
    typeof input.isRecorded === 'function'
      ? input.isRecorded(key)
      : (input.isRecorded?.has(key) ?? false);
  if (recorded) return { record: false, key, reason: 'ALREADY_RECORDED' };

  return { record: true, key, reason: null };
}
