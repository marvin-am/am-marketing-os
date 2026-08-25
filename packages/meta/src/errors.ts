/**
 * Meta error-code mapping.
 *
 * The Graph API answers with HTTP 400 for almost everything, so the HTTP status
 * carries very little information — the `error.code` / `error.error_subcode`
 * pair is what actually distinguishes "your token expired" from "you are being
 * throttled" from "that field is invalid". Mapping happens once, here, so that
 * every caller can branch on a `DomainErrorCode` and every operator sees the
 * same German sentence for the same underlying condition.
 */
import { DomainError, type DomainErrorCode } from '@am/domain';
import { metaErrorBodySchema } from './types';

/* -------------------------------------------------------------------------- */
/* Code tables                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Throttling codes.
 *
 * - 4   — application-level request limit
 * - 17  — user-level request limit ("User request limit reached")
 * - 32  — page-level request limit
 * - 613 — "Calls to this api have exceeded the rate limit"
 * - 80000..80014 — business-use-case rate limits (ads management, insights, …)
 */
export const META_RATE_LIMIT_CODES: readonly number[] = [4, 17, 32, 613];

export function isBusinessUseCaseRateLimitCode(code: number): boolean {
  return code >= 80000 && code <= 80014;
}

/** OAuth / token problems. 190 is the classic expired-or-invalidated token. */
export const META_AUTH_CODES: readonly number[] = [102, 190, 458, 459, 460, 463, 467];

/** Permission and capability problems — a scope or a role is missing. */
export const META_PERMISSION_CODES: readonly number[] = [3, 10, 200, 272, 294, 298, 299, 368];

/** Transient server-side problems worth retrying. */
export const META_TRANSIENT_CODES: readonly number[] = [1, 2];

/* -------------------------------------------------------------------------- */
/* Parsed error                                                                */
/* -------------------------------------------------------------------------- */

export interface MetaApiErrorInfo {
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  type: string | null;
  /** Meta's English developer message. Never shown to an operator verbatim. */
  message: string;
  /** Meta's user-facing message when present; may be localised by Meta. */
  userMessage: string | null;
  fbtraceId: string | null;
  /** Milliseconds to wait before a retry could plausibly succeed. */
  retryAfterMs: number | null;
}

export function parseMetaErrorBody(httpStatus: number, body: unknown): MetaApiErrorInfo {
  const parsed = metaErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      httpStatus,
      code: null,
      subcode: null,
      type: null,
      message: typeof body === 'string' ? body.slice(0, 500) : 'Unbekannte Meta-Antwort',
      userMessage: null,
      fbtraceId: null,
      retryAfterMs: null,
    };
  }
  const error = parsed.data.error;
  return {
    httpStatus,
    code: error.code ?? null,
    subcode: error.error_subcode ?? null,
    type: error.type ?? null,
    message: error.message,
    userMessage: error.error_user_msg ?? error.error_user_title ?? null,
    fbtraceId: error.fbtrace_id ?? null,
    retryAfterMs: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Rate-limit headers                                                          */
/* -------------------------------------------------------------------------- */

interface HeaderLike {
  get(name: string): string | null;
}

/**
 * Meta signals throttling in three different ways depending on the edge:
 *
 * 1. A standard `Retry-After` header (seconds) on 429 responses.
 * 2. `X-Business-Use-Case-Usage` — JSON keyed by business id, each entry
 *    carrying `estimated_time_to_regain_access` in **minutes**.
 * 3. `X-Ad-Account-Usage` — `{ acc_id_util_pct }`, a soft signal only.
 *
 * All three are read; the largest concrete wait wins. `null` means "no explicit
 * hint", and the caller falls back to exponential backoff.
 */
export function retryAfterFromHeaders(headers: HeaderLike | null | undefined): number | null {
  if (!headers) return null;
  const candidates: number[] = [];

  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) candidates.push(seconds * 1000);
  }

  const buc = headers.get('x-business-use-case-usage');
  if (buc) {
    try {
      const parsed: unknown = JSON.parse(buc);
      if (parsed && typeof parsed === 'object') {
        for (const entries of Object.values(parsed as Record<string, unknown>)) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const minutes = (entry as { estimated_time_to_regain_access?: unknown })
              .estimated_time_to_regain_access;
            if (typeof minutes === 'number' && minutes > 0) candidates.push(minutes * 60_000);
          }
        }
      }
    } catch {
      // A malformed header is a hint we simply do not have.
    }
  }

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

export interface MetaErrorContext {
  operation: string;
  headers?: HeaderLike | null;
}

function classify(info: MetaApiErrorInfo): { code: DomainErrorCode; messageDe: string } {
  const code = info.code ?? 0;

  if (
    info.httpStatus === 429 ||
    META_RATE_LIMIT_CODES.includes(code) ||
    isBusinessUseCaseRateLimitCode(code)
  ) {
    return {
      code: 'PROVIDER_RATE_LIMITED',
      messageDe:
        'Meta hat das Anfragelimit erreicht. Die Anfrage wird automatisch mit Verzögerung erneut versucht.',
    };
  }

  if (META_AUTH_CODES.includes(code) || info.httpStatus === 401) {
    return {
      code: 'PROVIDER_NOT_CONFIGURED',
      messageDe:
        'Das Meta-Zugriffstoken ist abgelaufen oder wurde widerrufen. Bitte die Meta-Verbindung in den Einstellungen neu autorisieren.',
    };
  }

  if (META_PERMISSION_CODES.includes(code) || info.httpStatus === 403) {
    return {
      code: 'FORBIDDEN',
      messageDe:
        'Meta hat den Zugriff verweigert: Dem verbundenen Konto fehlen die erforderlichen Berechtigungen für dieses Werbekonto.',
    };
  }

  if (code === 100) {
    return {
      code: 'VALIDATION_FAILED',
      messageDe: 'Meta hat die Anfrage abgelehnt: mindestens ein Feld ist ungültig.',
    };
  }

  if (META_TRANSIENT_CODES.includes(code) || info.httpStatus >= 500) {
    return {
      code: 'PROVIDER_ERROR',
      messageDe:
        'Meta ist derzeit nicht erreichbar oder hat einen temporären Fehler gemeldet. Der Vorgang wird erneut versucht.',
    };
  }

  return {
    code: 'PROVIDER_ERROR',
    messageDe: 'Meta hat einen Fehler zurückgegeben. Details stehen im Fehlerprotokoll.',
  };
}

/**
 * Turns a Meta error response into a `DomainError`. The English developer
 * message is preserved in `details` for the log; the operator sees `messageDe`.
 */
export function mapMetaError(
  httpStatus: number,
  body: unknown,
  context: MetaErrorContext,
): DomainError {
  const info = parseMetaErrorBody(httpStatus, body);
  const retryAfterMs = retryAfterFromHeaders(context.headers);
  const { code, messageDe } = classify(info);

  return new DomainError(code, {
    messageDe,
    retryable: code === 'PROVIDER_RATE_LIMITED' || code === 'PROVIDER_ERROR',
    details: {
      provider: 'META',
      operation: context.operation,
      http_status: httpStatus,
      meta_code: info.code,
      meta_subcode: info.subcode,
      meta_type: info.type,
      meta_message: info.message,
      meta_user_message: info.userMessage,
      fbtrace_id: info.fbtraceId,
      retry_after_ms: retryAfterMs,
    },
  });
}

/** Network / abort failures never reach `mapMetaError` — they land here. */
export function mapMetaTransportError(error: unknown, operation: string): DomainError {
  if (error instanceof DomainError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new DomainError('PROVIDER_ERROR', {
    messageDe: 'Die Verbindung zu Meta ist fehlgeschlagen. Der Vorgang wird erneut versucht.',
    retryable: true,
    cause: error,
    details: { provider: 'META', operation, reason },
  });
}

/** Reads the retry hint back off a mapped error. */
export function retryAfterMsOf(error: unknown): number | null {
  if (!(error instanceof DomainError)) return null;
  const value = error.details.retry_after_ms;
  return typeof value === 'number' && value > 0 ? value : null;
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'PROVIDER_RATE_LIMITED';
}
