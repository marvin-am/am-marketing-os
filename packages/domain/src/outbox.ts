import { z } from 'zod';
import { outboxDestinationSchema, outboxStateSchema } from './enums';
import { uuidSchema } from './ids';
import { isoTimestampSchema } from './primitives';

/**
 * Transactional outbox record (spec §24).
 *
 * The business transition and its outbox row are written in the *same* database
 * transaction. That is what guarantees "a HubSpot outage never loses a lead"
 * (acceptance criterion 30) without a distributed transaction.
 */
export const outboxEventSchema = z.object({
  /**
   * Deterministic dispatch id. For down-funnel CAPI events this is
   * `sha256(form_instance_id:event_type:transition_version)` so a retry, a
   * re-sync and a replay all collapse onto one provider event.
   */
  event_id: z.string().min(8).max(128),
  destination: outboxDestinationSchema,
  event_name: z.string().min(1).max(120),
  /** Business time of the event — never the retry time (spec §23). */
  event_time: isoTimestampSchema,
  payload_hash: z.string().length(64),
  status: outboxStateSchema,
  attempt_count: z.number().int().min(0).default(0),
  next_attempt_at: isoTimestampSchema.nullable().default(null),
  last_error: z.string().max(2000).nullable().default(null),
  /** Provider response with all PII redacted before storage. */
  provider_response_redacted: z.unknown().nullable().default(null),
  sent_at: isoTimestampSchema.nullable().default(null),
  created_at: isoTimestampSchema,

  /** Correlation for the console UI. */
  campaign_id: uuidSchema.nullable().default(null),
  submission_id: uuidSchema.nullable().default(null),
  opportunity_id: uuidSchema.nullable().default(null),
  dataset_id: z.string().max(64).nullable().default(null),
});
export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export const OUTBOX_TERMINAL_STATES: readonly z.infer<typeof outboxStateSchema>[] = [
  'ACCEPTED',
  'DEAD_LETTER',
  'EXPIRED',
];

export const RETRY_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 6 * 60 * 60 * 1000,
  /** Jitter fraction applied to each computed delay to avoid retry storms. */
  jitterRatio: 0.2,
} as const;

/**
 * Exponential backoff with deterministic jitter derived from the event id, so
 * that a replay of the same event schedules identically — important for tests
 * and for reasoning about a dead-letter backlog.
 */
export function nextRetryDelayMs(
  attempt: number,
  seed: number,
  policy: { baseDelayMs: number; maxDelayMs: number; jitterRatio: number } = RETRY_POLICY,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Map the seed to [-1, 1] deterministically.
  const normalized = ((seed % 2001) - 1000) / 1000;
  const jitter = capped * policy.jitterRatio * normalized;
  return Math.max(1_000, Math.round(capped + jitter));
}

export function shouldDeadLetter(attemptCount: number, maxAttempts = RETRY_POLICY.maxAttempts) {
  return attemptCount >= maxAttempts;
}

/* -------------------------------------------------------------------------- */
/* Deterministic event ids                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Canonical string that is hashed into a down-funnel CAPI `event_id`
 * (spec §23). Exposed separately so the same construction is testable without
 * async hashing.
 */
export function capiEventIdSource(
  formInstanceId: string,
  eventType: string,
  transitionVersion: number,
): string {
  return `${formInstanceId}:${eventType}:${transitionVersion}`;
}

/**
 * The initial website lead uses one shared id across browser pixel and server
 * CAPI so Meta can deduplicate the pair (spec §23). It is derived from the
 * submission, which exists exactly once per accepted lead.
 */
export function initialLeadEventIdSource(submissionId: string): string {
  return `lead:${submissionId}`;
}

export const OUTBOX_STATE_LABELS_DE: Readonly<Record<z.infer<typeof outboxStateSchema>, string>> = {
  PENDING: 'Ausstehend',
  PROCESSING: 'In Bearbeitung',
  SENT: 'Gesendet',
  ACCEPTED: 'Vom Provider bestätigt',
  FAILED_RETRYING: 'Fehlgeschlagen – Wiederholung',
  DEAD_LETTER: 'Dead Letter',
  EXPIRED: 'Abgelaufen',
};
