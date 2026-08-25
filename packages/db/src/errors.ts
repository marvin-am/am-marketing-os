/**
 * Database error translation.
 *
 * Every failure that reaches a caller is a `DomainError` with a German
 * `messageDe` — no bare Postgres string ever reaches the UI (spec §33).
 */
import { DomainError, type DomainErrorCode } from '@am/domain';

/** Custom SQLSTATEs raised by our own trigger and RPC code. */
export const AM_SQLSTATE = {
  /** A published version was updated or deleted. */
  IMMUTABLE_VERSION: 'AM001',
  /** Referenced object does not exist or is not published. */
  NOT_FOUND: 'AM004',
  /** Malformed RPC payload. */
  INVALID_PAYLOAD: 'AM005',
} as const;

const PG_CODE_MAP: Record<string, DomainErrorCode> = {
  '23505': 'CONFLICT', // unique_violation
  '23503': 'VALIDATION_FAILED', // foreign_key_violation
  '23514': 'VALIDATION_FAILED', // check_violation
  '23502': 'VALIDATION_FAILED', // not_null_violation
  '22P02': 'VALIDATION_FAILED', // invalid_text_representation
  '42501': 'FORBIDDEN', // insufficient_privilege — RLS said no
  '40001': 'CONFLICT', // serialization_failure
  '40P01': 'CONFLICT', // deadlock_detected
  '57014': 'INTERNAL', // query_canceled
  PGRST116: 'NOT_FOUND', // PostgREST: no rows for .single()
  [AM_SQLSTATE.IMMUTABLE_VERSION]: 'IMMUTABLE_VERSION',
  [AM_SQLSTATE.NOT_FOUND]: 'NOT_FOUND',
  [AM_SQLSTATE.INVALID_PAYLOAD]: 'VALIDATION_FAILED',
};

/** Anything shaped like a PostgREST or `pg` error. */
export interface DatabaseErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
  constraint?: string | null;
}

function isDatabaseErrorLike(value: unknown): value is DatabaseErrorLike {
  return typeof value === 'object' && value !== null && ('code' in value || 'message' in value);
}

/**
 * Constraint-specific German messages. A raw "duplicate key value violates
 * unique constraint" is useless to an operator; naming the actual rule is not.
 */
const CONSTRAINT_MESSAGES_DE: Record<string, string> = {
  form_submissions_attempt_unique:
    'Diese Übermittlung wurde bereits verarbeitet. Es wurde nur ein Lead angelegt.',
  outbox_events_dedup_unique:
    'Dieses Ereignis wurde bereits eingereiht und wird nicht doppelt versendet.',
  experiment_assignments_unique:
    'Dieser Besucher ist dem Experiment bereits zugewiesen; die Variante bleibt stabil.',
  experiment_exposures_unique: 'Diese Ausspielung wurde für diese Session bereits gezählt.',
  campaigns_slug_unique: 'Es existiert bereits eine Kampagne mit diesem Kurznamen.',
  approvals_active_key: 'Für diesen Bereich existiert bereits eine offene oder erteilte Freigabe.',
  leads_submission_unique: 'Zu dieser Übermittlung existiert bereits ein Lead.',
  attribution_snapshots_submission_unique:
    'Für diese Übermittlung existiert bereits ein Attributions-Snapshot.',
  meta_insights_daily_unique: 'Für diesen Tag und dieses Objekt liegen bereits Insights vor.',
  hubspot_stage_history_unique: 'Diese Stufenänderung wurde bereits erfasst.',
};

function constraintFrom(error: DatabaseErrorLike): string | null {
  if (error.constraint) return error.constraint;
  const haystack = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = /"([a-z0-9_]+)"/i.exec(haystack);
  return match ? match[1] : null;
}

/**
 * Converts a driver error into a `DomainError`. Unknown errors become INTERNAL
 * rather than leaking a Postgres message into the UI.
 */
export function toDomainError(error: unknown, context: string): DomainError {
  if (error instanceof DomainError) return error;

  if (isDatabaseErrorLike(error)) {
    const code = error.code ?? '';
    const domainCode = PG_CODE_MAP[code] ?? 'INTERNAL';
    const constraint = constraintFrom(error);
    const specific = constraint ? CONSTRAINT_MESSAGES_DE[constraint] : undefined;

    // Our own triggers already speak German; pass their message straight through.
    const messageDe =
      specific ??
      (code === AM_SQLSTATE.IMMUTABLE_VERSION ||
      code === AM_SQLSTATE.NOT_FOUND ||
      code === AM_SQLSTATE.INVALID_PAYLOAD
        ? (error.message ?? undefined)
        : undefined);

    return new DomainError(domainCode, {
      messageDe,
      details: {
        context,
        pgCode: code || null,
        constraint,
        hint: error.hint ?? null,
      },
      cause: error,
    });
  }

  return new DomainError('INTERNAL', {
    details: { context },
    cause: error,
  });
}

/** `{ data, error }` unwrapping used by every repository method. */
export function unwrapResult<T>(
  result: { data: T | null; error: DatabaseErrorLike | null },
  context: string,
): T {
  if (result.error) throw toDomainError(result.error, context);
  if (result.data === null || result.data === undefined) {
    throw new DomainError('NOT_FOUND', { details: { context } });
  }
  return result.data;
}

/** Same, but `null` is a legitimate answer (a `maybeSingle()` lookup). */
export function unwrapMaybe<T>(
  result: { data: T | null; error: DatabaseErrorLike | null },
  context: string,
): T | null {
  if (result.error) throw toDomainError(result.error, context);
  return result.data ?? null;
}

export function unwrapList<T>(
  result: { data: T[] | null; error: DatabaseErrorLike | null },
  context: string,
): T[] {
  if (result.error) throw toDomainError(result.error, context);
  return result.data ?? [];
}

/** Thrown when a repository is used while Supabase is not configured. */
export function notConfigured(operation: string): DomainError {
  return new DomainError('PROVIDER_NOT_CONFIGURED', {
    messageDe:
      'Die Datenbank ist nicht konfiguriert. Im Demo-Modus läuft das Produkt gegen die In-Memory-Datenbank.',
    details: { operation, provider: 'SUPABASE' },
  });
}
