/**
 * Transactional outbox helpers (spec §24).
 *
 * The invariant: a business write and its outbox row land in the same
 * transaction. That is what makes "a HubSpot outage never loses a lead" true
 * without a distributed transaction — the lead is committed, the dispatch is a
 * queued row, and a worker drains it later with retries and a dead-letter tail.
 *
 * Two paths exist, deliberately:
 *   * `submitLeadTransactional()` — the funnel runtime. One RPC does the whole
 *     write, so there is no window where a submission exists without its outbox
 *     row.
 *   * `enqueueOutboxEvent()` — everything else (CRM stage transitions, budget
 *     commands). Callers already inside a `pg` transaction should use
 *     `ENQUEUE_OUTBOX_EVENT_SQL` from `./sql` instead.
 */
import {
  nextRetryDelayMs,
  shouldDeadLetter,
  RETRY_POLICY,
  fnv1a32,
  type OutboxDestination,
  type OutboxState,
} from '@am/domain';
import type { DbClient } from './client';
import { toDomainError, unwrapList, unwrapMaybe } from './errors';
import { sha256Hex } from './crypto';
import type { JsonObject, OutboxEventRow, Uuid } from './types';

export interface EnqueueOutboxInput {
  workspace_id: Uuid;
  destination: OutboxDestination;
  /** Deterministic dispatch id — a retry, a replay and a re-sync collapse onto it. */
  event_id: string;
  /** Meta dataset for CAPI; empty string for HubSpot. Never null. */
  dataset_id?: string;
  event_name: string;
  /** Business time of the event, never the retry time. */
  event_time: string;
  payload?: JsonObject;
  /** Optional: derived from `payload` when omitted. */
  payload_hash?: string;
  campaign_id?: Uuid | null;
  submission_id?: Uuid | null;
  lead_id?: Uuid | null;
  opportunity_id?: Uuid | null;
}

export interface EnqueueOutboxResult {
  event: OutboxEventRow;
  /** False when the deterministic id already existed — a deduplicated replay. */
  created: boolean;
}

/** Stable hash over the payload; used for change detection and audit. */
export function outboxPayloadHash(payload: JsonObject): string {
  return sha256Hex(canonicalJson(payload));
}

function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (Array.isArray(input)) return input.map(walk);
    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/**
 * Enqueues one event. Idempotent on `(destination, dataset_id, event_id)`:
 * calling it twice with the same deterministic id returns the existing row with
 * `created: false` rather than queueing a second dispatch.
 */
export async function enqueueOutboxEvent(
  client: DbClient,
  input: EnqueueOutboxInput,
): Promise<EnqueueOutboxResult> {
  const payload = input.payload ?? {};
  const row = {
    workspace_id: input.workspace_id,
    destination: input.destination,
    event_id: input.event_id,
    dataset_id: input.dataset_id ?? '',
    event_name: input.event_name,
    event_time: input.event_time,
    payload,
    payload_hash: input.payload_hash ?? outboxPayloadHash(payload),
    status: 'PENDING' satisfies OutboxState,
    attempt_count: 0,
    next_attempt_at: new Date().toISOString(),
    campaign_id: input.campaign_id ?? null,
    submission_id: input.submission_id ?? null,
    lead_id: input.lead_id ?? null,
    opportunity_id: input.opportunity_id ?? null,
  };

  const inserted = await client
    .from('outbox_events')
    .insert(row)
    .select('*')
    .maybeSingle();

  // 23505: the deterministic id already exists. That is a successful dedup.
  if (inserted.error && inserted.error.code !== '23505') {
    throw toDomainError(inserted.error, 'outbox.enqueue');
  }

  if (!inserted.error && inserted.data) {
    return { event: inserted.data as OutboxEventRow, created: true };
  }

  const existing = await client
    .from('outbox_events')
    .select('*')
    .eq('destination', row.destination)
    .eq('dataset_id', row.dataset_id)
    .eq('event_id', row.event_id)
    .maybeSingle();

  const event = unwrapMaybe(existing, 'outbox.enqueue.lookup');
  if (!event) throw toDomainError(inserted.error ?? null, 'outbox.enqueue');
  return { event: event as OutboxEventRow, created: false };
}

export interface ClaimOutboxOptions {
  /** One destination. Omit both this and `destinations` to drain all of them. */
  destination?: OutboxDestination;
  /** Several destinations in one claim — the dispatcher's normal case. */
  destinations?: readonly OutboxDestination[];
  limit?: number;
  /** Identifies the worker holding the claim; shows up in the console. */
  worker?: string;
}

/** Normalises the two spellings into the array the RPC takes, or `null` for all. */
export function resolveClaimDestinations(options: ClaimOutboxOptions): OutboxDestination[] | null {
  const list = [
    ...(options.destinations ?? []),
    ...(options.destination ? [options.destination] : []),
  ];
  const unique = [...new Set(list)];
  return unique.length > 0 ? unique : null;
}

/**
 * Claims due events.
 *
 * Delegates to `public.claim_outbox_events`, which runs
 * `SELECT … FOR UPDATE SKIP LOCKED` and marks the rows `PROCESSING` in the same
 * statement (see `CLAIM_OUTBOX_EVENTS_SQL` in `./sql` for the exact SQL). Several
 * workers can therefore drain the same queue without ever handling the same event
 * twice.
 *
 * With no destination filter the dispatcher gets one mixed batch instead of one
 * round trip per destination.
 */
export async function claimPendingOutboxEvents(
  client: DbClient,
  options: ClaimOutboxOptions = {},
): Promise<OutboxEventRow[]> {
  const result = await client.rpc('claim_outbox_events', {
    p_destinations: resolveClaimDestinations(options),
    p_limit: options.limit ?? 25,
    p_worker: options.worker ?? 'worker',
  });
  return unwrapList(result, 'outbox.claim') as OutboxEventRow[];
}

/** Releases events a crashed worker left `PROCESSING`. */
export async function reclaimStaleOutboxEvents(
  client: DbClient,
  olderThan = '15 minutes',
): Promise<number> {
  const result = await client.rpc('reclaim_stale_outbox_events', { p_older_than: olderThan });
  if (result.error) throw toDomainError(result.error, 'outbox.reclaim');
  return typeof result.data === 'number' ? result.data : 0;
}

async function patchOutbox(
  client: DbClient,
  id: Uuid,
  patch: Record<string, unknown>,
  context: string,
): Promise<OutboxEventRow> {
  const result = await client.from('outbox_events').update(patch).eq('id', id).select('*').maybeSingle();
  const row = unwrapMaybe(result, context);
  if (!row) throw toDomainError({ code: 'PGRST116', message: 'Outbox-Eintrag nicht gefunden.' }, context);
  return row as OutboxEventRow;
}

/** The request left the process. Not yet a provider confirmation. */
export function markSent(
  client: DbClient,
  id: Uuid,
  providerResponseRedacted?: unknown,
): Promise<OutboxEventRow> {
  return patchOutbox(
    client,
    id,
    {
      status: 'SENT' satisfies OutboxState,
      sent_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      provider_response_redacted: providerResponseRedacted ?? null,
    },
    'outbox.markSent',
  );
}

/** The provider confirmed receipt. Only now may the UI show it as delivered. */
export function markAccepted(
  client: DbClient,
  id: Uuid,
  providerResponseRedacted?: unknown,
): Promise<OutboxEventRow> {
  return patchOutbox(
    client,
    id,
    {
      status: 'ACCEPTED' satisfies OutboxState,
      sent_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      provider_response_redacted: providerResponseRedacted ?? null,
    },
    'outbox.markAccepted',
  );
}

export interface RetryDecision {
  status: Extract<OutboxState, 'FAILED_RETRYING' | 'DEAD_LETTER'>;
  attemptCount: number;
  nextAttemptAt: string | null;
  delayMs: number | null;
}

/**
 * Pure retry arithmetic, exposed so the scheduler and the console agree on when
 * the next attempt is due. Jitter is derived from the event id, so a replay of
 * the same event schedules identically.
 */
export function planRetry(
  event: Pick<OutboxEventRow, 'event_id' | 'attempt_count'>,
  now: Date = new Date(),
  policy = RETRY_POLICY,
): RetryDecision {
  const attemptCount = event.attempt_count;
  if (shouldDeadLetter(attemptCount, policy.maxAttempts)) {
    return { status: 'DEAD_LETTER', attemptCount, nextAttemptAt: null, delayMs: null };
  }
  const delayMs = nextRetryDelayMs(attemptCount, fnv1a32(event.event_id), policy);
  return {
    status: 'FAILED_RETRYING',
    attemptCount,
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
    delayMs,
  };
}

/**
 * Records a failed attempt and schedules the next one — or dead-letters the
 * event once the attempt budget is exhausted.
 */
export async function markFailed(
  client: DbClient,
  event: Pick<OutboxEventRow, 'id' | 'event_id' | 'attempt_count'>,
  error: string,
  options: { now?: Date; providerResponseRedacted?: unknown } = {},
): Promise<{ event: OutboxEventRow; decision: RetryDecision }> {
  const decision = planRetry(event, options.now ?? new Date());
  const updated = await patchOutbox(
    client,
    event.id,
    {
      status: decision.status,
      next_attempt_at: decision.nextAttemptAt,
      last_error: error.slice(0, 2000),
      locked_at: null,
      locked_by: null,
      provider_response_redacted: options.providerResponseRedacted ?? null,
    },
    'outbox.markFailed',
  );
  return { event: updated, decision };
}

/** Gives up on an event immediately — a permanent provider rejection. */
export function markDeadLetter(
  client: DbClient,
  id: Uuid,
  reason: string,
  providerResponseRedacted?: unknown,
): Promise<OutboxEventRow> {
  return patchOutbox(
    client,
    id,
    {
      status: 'DEAD_LETTER' satisfies OutboxState,
      next_attempt_at: null,
      last_error: reason.slice(0, 2000),
      locked_at: null,
      locked_by: null,
      provider_response_redacted: providerResponseRedacted ?? null,
    },
    'outbox.markDeadLetter',
  );
}

/* -------------------------------------------------------------------------- */
/* The transactional lead submit                                               */
/* -------------------------------------------------------------------------- */

export interface SubmitLeadAnswer {
  field_key: string;
  step_key?: string | null;
  /** Never EMAIL/PHONE/FIRST_NAME/LAST_NAME — the table's CHECK rejects those. */
  field_type: string;
  pii_class?: 'QUALIFICATION' | 'OPERATIONAL';
  qualification_class?: string;
  value_text?: string | null;
  value_number?: number | null;
  value_bool?: boolean | null;
  value_options?: string[] | null;
  score_contribution?: number | null;
}

export interface SubmitLeadPii {
  key_version: number;
  /** base64 */
  iv: string;
  auth_tag: string;
  ciphertext: string;
  email_hash?: string | null;
  phone_hash?: string | null;
  email_domain?: string | null;
}

export interface SubmitLeadInput {
  /** Client-generated per submit intent. THE idempotency key. */
  submission_attempt_id: Uuid;
  published_funnel_id: Uuid;
  form_instance_id?: Uuid | null;
  form_version_id?: Uuid | null;
  visitor_id?: Uuid | null;
  session_id?: Uuid | null;
  experiment_id?: Uuid | null;
  experiment_arm_id?: Uuid | null;
  state?: string;
  submitted_at?: string;
  environment?: string;
  traffic_kind?: string;
  consent_version_id?: Uuid | null;
  consent_status?: string;
  consent_purposes?: string[];
  consent_text_hash?: string | null;
  spam_score?: number | null;
  spam_reason?: string | null;
  validation_error_codes?: string[];
  answers_hash?: string | null;
  status_reason_de?: string | null;
  actor_label?: string;
  correlation_id?: string | null;
  answers?: SubmitLeadAnswer[];
  pii?: SubmitLeadPii | null;
  attribution?: Record<string, unknown>;
  outbox?: {
    destination: OutboxDestination;
    event_id: string;
    dataset_id?: string;
    event_name?: string;
    event_time?: string;
    payload?: JsonObject;
    payload_hash: string;
  } | null;
}

export interface SubmitLeadResult {
  submission_id: Uuid;
  /** False when this attempt id had already been processed. */
  created: boolean;
  state: string;
  attribution_snapshot_id: Uuid | null;
  outbox_event_id: Uuid | null;
}

/**
 * Writes submission, answers, encrypted PII, status history, attribution
 * snapshot and the outbox row in one database transaction.
 *
 * Ten concurrent identical submits produce exactly one submission and exactly
 * one outbox row: the unique constraint on `submission_attempt_id` decides the
 * winner and the losers get that row back.
 */
export async function submitLeadTransactional(
  client: DbClient,
  input: SubmitLeadInput,
): Promise<SubmitLeadResult> {
  const result = await client.rpc('submit_lead_transactional', { p_payload: input });
  if (result.error) throw toDomainError(result.error, 'submissions.submitLeadTransactional');
  return result.data as SubmitLeadResult;
}
