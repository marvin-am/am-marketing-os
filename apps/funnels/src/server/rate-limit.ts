import { createRateLimiter, rateLimitKeyFor, type RateLimiter } from '@am/tracking';

/**
 * Per-instance token buckets for the two public write endpoints.
 *
 * Deliberately module-level rather than per-request: a limiter recreated on
 * every request limits nothing. Serverless instances are short-lived and there
 * may be many of them, so this bounds a single abusive client per instance
 * rather than globally — the durable limit belongs next to the durable store
 * and is the lead's to wire when `@am/db` lands. Everything below is
 * nonetheless real: an unbounded collector is a free amplification endpoint.
 */

/** 60 events of burst, refilling at one per second. */
export const collectLimiter: RateLimiter = createRateLimiter({
  capacity: 60,
  refillPerSecond: 1,
});

/**
 * Submissions are rare and expensive: ten in a burst, refilling at one every
 * six minutes, which matches the `maxAttemptsPerHour: 10` a generated spec
 * carries.
 */
export const submitLimiter: RateLimiter = createRateLimiter({
  capacity: 10,
  refillPerSecond: 1 / 360,
});

export { rateLimitKeyFor };

/** Best-effort client address. Never logged, never stored — only hashed. */
export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip');
}

export function resetRateLimiters(): void {
  collectLimiter.reset();
  submitLimiter.reset();
}
