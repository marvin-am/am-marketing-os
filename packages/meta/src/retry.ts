/**
 * Rate-limit aware retry.
 *
 * Meta's throttling is bursty and the useful signal is not the HTTP status but
 * the `Retry-After` / `X-Business-Use-Case-Usage` hint. The rule implemented
 * here: honour an explicit hint when Meta gives one, otherwise fall back to the
 * same deterministic exponential backoff the outbox uses (`nextRetryDelayMs`
 * from `@am/domain`), so a replayed operation schedules identically.
 */
import { DomainError, fnv1a32, nextRetryDelayMs } from '@am/domain';
import { retryAfterMsOf } from './errors';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  /** Injectable so tests never actually wait. */
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_META_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
  /** Every delay actually waited, in order. Surfaced so a command can prove it. */
  delaysMs: number[];
}

function isRetryable(error: unknown): boolean {
  return error instanceof DomainError && error.retryable;
}

/**
 * Runs `fn`, retrying retryable provider errors with backoff. A non-retryable
 * error (validation, permission, expired token) is thrown immediately — waiting
 * would not change the answer.
 */
export async function withRateLimitRetry<T>(
  operation: string,
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_META_RETRY,
): Promise<RetryOutcome<T>> {
  const seed = fnv1a32(operation);
  const delaysMs: number[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, config.maxAttempts); attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt, delaysMs };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= config.maxAttempts) break;

      const hinted = retryAfterMsOf(error);
      const backoff = nextRetryDelayMs(attempt, seed, {
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
        jitterRatio: config.jitterRatio,
      });
      const delay = Math.min(config.maxDelayMs, hinted ?? backoff);
      delaysMs.push(delay);
      await config.sleep(delay);
    }
  }

  if (lastError instanceof DomainError) {
    throw new DomainError(lastError.code, {
      messageDe: lastError.messageDe,
      retryable: lastError.retryable,
      cause: lastError,
      details: { ...lastError.details, attempts: delaysMs.length + 1, delays_ms: delaysMs },
    });
  }
  throw lastError;
}
