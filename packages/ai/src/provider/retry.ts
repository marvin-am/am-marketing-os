import { DomainError } from '@am/domain';
import { logger, sleep } from '@am/observability';

/**
 * Transport-level retry for the OpenAI adapters.
 *
 * This layer only handles *transport* failures — 429 and 5xx. A response that
 * arrives but does not match the schema is a semantic failure and is handled by
 * the pipeline's bounded repair turn, never here: silently re-rolling an
 * invalid generation would hide a broken prompt behind a latency spike.
 */

export interface RetryOptions {
  /** Attempts in total, including the first. Defaults to 4. */
  maxAttempts?: number;
  /** Delay before the first retry, in milliseconds. Defaults to 500. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff step. Defaults to 20 000. */
  maxDelayMs?: number;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
  /** Injected for tests; defaults to the observability `sleep`. */
  sleepFn?: (ms: number) => Promise<void>;
  operation?: string;
}

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status >= 500;

export function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** `retry-after` is seconds or an HTTP date; only the seconds form is honoured. */
export function retryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return null;
  const read = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name);
    }
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];
    return typeof value === 'string' ? value : null;
  };
  const raw = read('retry-after');
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** Full-jitter exponential backoff: `random(0, base * 2^attempt)`, capped. */
export function backoffDelayMs(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.round(options.random() * ceiling);
}

export function toDomainError(error: unknown, operation: string): DomainError {
  if (error instanceof DomainError) return error;
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new DomainError('PROVIDER_RATE_LIMITED', {
      details: { operation, status },
      cause: error,
    });
  }
  if (status === 401 || status === 403) {
    return new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe: 'Der OpenAI-Zugang ist nicht oder nicht korrekt konfiguriert.',
      details: { operation, status },
      cause: error,
    });
  }
  return new DomainError('PROVIDER_ERROR', {
    details: { operation, status, message },
    cause: error,
  });
}

/**
 * Runs `fn`, retrying 429 and 5xx with exponential backoff plus full jitter.
 * Anything else fails immediately. The final failure is always surfaced as a
 * `DomainError` so callers never have to know about the OpenAI SDK.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 20_000;
  const random = options.random ?? Math.random;
  const sleepFn = options.sleepFn ?? sleep;
  const operation = options.operation ?? 'openai.call';

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = statusOf(error);
      const isLast = attempt === maxAttempts - 1;
      if (status === null || !RETRYABLE_STATUS(status) || isLast) {
        throw toDomainError(error, operation);
      }
      const delay = retryAfterMs(error) ?? backoffDelayMs(attempt, { baseDelayMs, maxDelayMs, random });
      logger.warn('openai_retry', {
        operation,
        attempt: attempt + 1,
        max_attempts: maxAttempts,
        status,
        delay_ms: delay,
      });
      await sleepFn(delay);
    }
  }
  throw toDomainError(lastError, operation);
}
