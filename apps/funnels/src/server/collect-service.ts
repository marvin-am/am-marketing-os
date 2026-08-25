import {
  DEFAULT_MAX_BATCH_SIZE,
  createExposureRegistry,
  createMemoryDedupeStore,
  findEventPiiViolations,
  ingestBatch,
  shouldRecordExposure,
  type EventDedupeStore,
  type ExposureRegistry,
  type RateLimiter,
  type RejectedEvent,
} from '@am/tracking';
import type { AppEnvironment, TrackingContext, TrafficKind } from '@am/domain';
import { logger } from '@am/observability';
import type { FunnelStore } from './ports';

/**
 * The first-party event collector.
 *
 * The browser never writes to a table. It posts a batch here, the server owns
 * every field that decides whether an event counts — `received_at`,
 * `environment`, `traffic_kind`, the visitor and session ids, and the internal
 * ids recovered from the signed launch token — and only then is anything
 * stored.
 *
 * Two rules are absolute:
 *
 * - **A payload carrying personal data is rejected outright.** Not sanitised
 *   and stored: a "cleaned" event teaches the emitting code that sending PII is
 *   survivable, and the next mistake is a lead's e-mail in a log drain.
 * - **The client cannot claim an identity.** `visitor_id` and `session_id` are
 *   overwritten from the server-resolved cookies, so a scripted POST cannot
 *   attribute events to someone else's visitor.
 */

/** Bounded in-process idempotency. The unique index on `event_id` is the real one. */
const defaultDedupe: EventDedupeStore = createMemoryDedupeStore();

/**
 * One exposure per (experiment, visitor, session). Assignment alone must never
 * produce one — see `assignment.ts`.
 */
const defaultExposures: ExposureRegistry = createExposureRegistry();

export interface CollectContext {
  environment: AppEnvironment;
  trafficKind: TrafficKind;
  visitorId: string;
  sessionId: string;
  /** Internal ids from a verified launch token. These win over the payload. */
  trusted: Partial<TrackingContext> | null;
  /** Hashed key — never a raw IP address (rule 7). */
  rateLimitKey: string;
  receivedAt?: string;
}

export interface CollectDependencies {
  store: FunnelStore;
  limiter?: RateLimiter;
  maxBatchSize?: number;
  /** Injectable so a test starts from a clean slate instead of a warm process. */
  dedupe?: EventDedupeStore;
  exposures?: ExposureRegistry;
}

export interface CollectResultBody {
  accepted: number;
  duplicates: number;
  rejected: RejectedEvent[];
  /** Exposures suppressed because the pair was already recorded this session. */
  suppressedExposures: number;
}

export interface CollectErrorBody {
  ok: false;
  code: 'VALIDATION_FAILED' | 'RATE_LIMITED';
  messageDe: string;
  /** Paths that tripped the PII guard. Keys and shapes only, never values. */
  violations?: string[];
}

export type CollectOutcome =
  | { ok: true; status: 200; body: CollectResultBody }
  | { ok: false; status: number; body: CollectErrorBody };

const PII_MESSAGE_DE =
  'Das Ereignis wurde abgelehnt: Es enthält personenbezogene Daten.';

function eventsFrom(rawBody: unknown): unknown[] | null {
  if (Array.isArray(rawBody)) return rawBody;
  if (rawBody && typeof rawBody === 'object' && Array.isArray((rawBody as { events?: unknown }).events)) {
    return (rawBody as { events: unknown[] }).events;
  }
  return null;
}

export async function collectEvents(
  rawBody: unknown,
  context: CollectContext,
  deps: CollectDependencies,
): Promise<CollectOutcome> {
  const events = eventsFrom(rawBody);
  if (!events) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        code: 'VALIDATION_FAILED',
        messageDe: 'Die Anfrage enthält keine Ereignisliste.',
      },
    };
  }

  /* The PII scan runs over the whole request before anything is parsed, so a
     batch that smuggles an `answers` blob is refused as a unit rather than
     having the offending event quietly dropped from an otherwise 200 response. */
  const violations = findEventPiiViolations(rawBody);
  if (violations.length > 0) {
    logger.warn('funnel.collect.rejected', { reason: 'PII_DETECTED', paths: violations });
    return {
      ok: false,
      status: 422,
      body: { ok: false, code: 'VALIDATION_FAILED', messageDe: PII_MESSAGE_DE, violations },
    };
  }

  /* Identity is the server's to decide. */
  const owned = events.map((event) =>
    event && typeof event === 'object' && !Array.isArray(event)
      ? { ...(event as Record<string, unknown>), visitor_id: context.visitorId, session_id: context.sessionId }
      : event,
  );

  const exposures = deps.exposures ?? defaultExposures;
  const result = ingestBatch(owned, {
    environment: context.environment,
    trafficKind: context.trafficKind,
    receivedAt: context.receivedAt,
    trusted: context.trusted,
    dedupe: deps.dedupe ?? defaultDedupe,
    limiter: deps.limiter,
    rateLimitKey: context.rateLimitKey,
    maxBatchSize: deps.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
  });

  let suppressedExposures = 0;
  const storable = result.accepted.filter((event) => {
    if (event.event_type !== 'experiment_exposed') return true;
    if (!event.experiment_id) return false;

    const decision = shouldRecordExposure({
      experimentId: event.experiment_id,
      visitorId: event.visitor_id,
      sessionId: event.session_id,
      /* The client only emits this once the assigned variant has painted. */
      rendered: true,
      isRecorded: (key) => exposures.has(key),
      trafficKind: event.traffic_kind,
    });

    if (!decision.record) {
      suppressedExposures += 1;
      return false;
    }
    exposures.add(decision.key);
    return true;
  });

  const written = await deps.store.recordEvents(storable);

  /* Step progress is derived from the events rather than from a second
     endpoint: one write path means the funnel drop-off report and the event
     stream cannot disagree about which step a visitor reached. */
  for (const event of storable) {
    if (event.event_type !== 'form_step_viewed' && event.event_type !== 'form_step_completed') {
      continue;
    }
    if (!event.form_instance_id || !event.step_id) continue;
    await deps.store.recordStepProgress({
      formInstanceId: event.form_instance_id,
      stepId: event.step_id,
      occurredAt: event.occurred_at,
      completed: event.event_type === 'form_step_completed',
    });
  }

  return {
    ok: true,
    status: 200,
    body: {
      accepted: written,
      duplicates: result.duplicates.length,
      rejected: result.rejected,
      suppressedExposures,
    },
  };
}
