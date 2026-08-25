/**
 * Domain error taxonomy.
 *
 * Every user-facing surface renders `messageDe`; logs and audit records keep
 * `code` plus redacted `details`. No error path is allowed to produce an empty
 * page or a bare stack trace (spec §33).
 */
export type DomainErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'CONFLICT'
  | 'IMMUTABLE_VERSION'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALIDATED'
  | 'LAUNCH_BLOCKED'
  | 'BUDGET_LIMIT_EXCEEDED'
  | 'EXTERNAL_WRITES_DISABLED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'MAPPING_INCOMPLETE'
  | 'SPAM_REJECTED'
  | 'RATE_LIMITED'
  | 'DIVERSITY_INSUFFICIENT'
  | 'AI_OUTPUT_INVALID'
  | 'INTERNAL';

export interface DomainErrorOptions {
  messageDe?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Whether a retry of the identical request could plausibly succeed. */
  retryable?: boolean;
}

const DEFAULT_MESSAGES_DE: Record<DomainErrorCode, string> = {
  VALIDATION_FAILED: 'Die Eingaben sind unvollständig oder ungültig.',
  NOT_FOUND: 'Der angeforderte Datensatz wurde nicht gefunden.',
  FORBIDDEN: 'Ihre Rolle erlaubt diese Aktion nicht.',
  UNAUTHENTICATED: 'Bitte melden Sie sich an.',
  CONFLICT: 'Der Datensatz wurde zwischenzeitlich geändert.',
  IMMUTABLE_VERSION: 'Diese Version ist veröffentlicht und kann nicht mehr geändert werden.',
  APPROVAL_REQUIRED: 'Für diesen Schritt fehlt eine Freigabe.',
  APPROVAL_INVALIDATED: 'Eine inhaltliche Änderung hat die bestehende Freigabe ungültig gemacht.',
  LAUNCH_BLOCKED: 'Die Launch-QA ist noch nicht vollständig grün.',
  BUDGET_LIMIT_EXCEEDED: 'Die Budgetänderung überschreitet Ihr Rollenlimit.',
  EXTERNAL_WRITES_DISABLED: 'Externe Schreibzugriffe sind derzeit deaktiviert (Dry-Run-Modus).',
  PROVIDER_NOT_CONFIGURED: 'Die Integration ist noch nicht verbunden.',
  PROVIDER_ERROR: 'Der externe Anbieter hat einen Fehler zurückgegeben.',
  PROVIDER_RATE_LIMITED: 'Der externe Anbieter hat das Anfragelimit begrenzt.',
  MAPPING_INCOMPLETE: 'Das HubSpot-Mapping ist unvollständig.',
  SPAM_REJECTED: 'Die Übermittlung wurde als Spam eingestuft.',
  RATE_LIMITED: 'Zu viele Anfragen. Bitte versuchen Sie es in Kürze erneut.',
  DIVERSITY_INSUFFICIENT:
    'Es liegen weniger als fünf konzeptionell unterschiedliche Creatives vor.',
  AI_OUTPUT_INVALID: 'Die KI-Ausgabe entsprach nicht dem erwarteten Schema.',
  INTERNAL: 'Es ist ein unerwarteter Fehler aufgetreten.',
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly messageDe: string;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: DomainErrorCode, options: DomainErrorOptions = {}) {
    super(options.messageDe ?? DEFAULT_MESSAGES_DE[code], { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.messageDe = options.messageDe ?? DEFAULT_MESSAGES_DE[code];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE_CODES.includes(code);
  }

  toJSON() {
    return {
      code: this.code,
      messageDe: this.messageDe,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

const RETRYABLE_CODES: readonly DomainErrorCode[] = [
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED',
  'RATE_LIMITED',
  'CONFLICT',
  'INTERNAL',
];

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function domainErrorMessageDe(error: unknown): string {
  if (isDomainError(error)) return error.messageDe;
  return DEFAULT_MESSAGES_DE.INTERNAL;
}

/* -------------------------------------------------------------------------- */
/* Result type                                                                 */
/* -------------------------------------------------------------------------- */

export type Result<T, E = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export function mapResult<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.value)) : result;
}
