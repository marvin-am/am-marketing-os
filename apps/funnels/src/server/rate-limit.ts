import { getServerEnv } from '@am/config';
import { newId } from '@am/domain';
import { createRateLimiter, rateLimitKeysFor, takeAll, type RateLimiter } from '@am/tracking';

/**
 * Per-instance token buckets for the two public write endpoints.
 *
 * Deliberately module-level rather than per-request: a limiter recreated on
 * every request limits nothing. The buckets live in this process only, so what
 * is bounded is one caller against one instance — a caller spread across n
 * warm instances gets n budgets, and the durable limit belongs next to the
 * durable store and is the lead's to wire when `@am/db` lands. Everything below
 * is nonetheless real: an unbounded collector is a free amplification endpoint.
 *
 * The keys the buckets hang off are what makes them binding at all. They come
 * from `rateLimitKeysFor`, which always folds in the client address — the part
 * of a request a caller cannot mint for itself — so dropping or rotating the
 * visitor cookie cannot buy a fresh budget.
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

export { rateLimitKeysFor, takeAll };

let salt: string | null = null;

/**
 * Salt for the identifiers that go into a rate-limit key.
 *
 * An unsalted SHA-256 of an IPv4 address is reversible by exhaustive search in
 * seconds, which would put the address back into the key it was hashed to keep
 * out (rule 7). `TRACKING_SIGNING_SECRET` is used when configured; otherwise a
 * value generated for this process, which suffices because the buckets it keys
 * do not outlive the process either. A shared store would have to use the
 * configured secret — two instances deriving different keys for the same caller
 * would each hand out a full budget.
 */
export function rateLimitSalt(): string {
  salt ??= getServerEnv().TRACKING_SIGNING_SECRET ?? newId();
  return salt;
}

/**
 * Best-effort client address. Never logged, never stored — only hashed.
 *
 * `X-Forwarded-For` accumulates left to right, so the first entry is the client
 * and every entry after it is a proxy hop — bucketing on one of those would put
 * a whole network, or every request that reaches this app, into one bucket. The
 * value is only as trustworthy as the edge in front of this app: a deployment
 * that forwards a client-supplied header unchanged gets a spoofable key. The
 * platform-specific headers are a fallback for an edge that sets no
 * `X-Forwarded-For` at all, not a second opinion on one that does.
 *
 * `null` means the address is unknown, which `rateLimitKeysFor` turns into one
 * shared bucket — never into an unlimited one.
 */
export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const direct = (headers.get('x-real-ip') ?? headers.get('cf-connecting-ip'))?.trim();
  return direct && direct.length > 0 ? direct : null;
}

export function resetRateLimiters(): void {
  collectLimiter.reset();
  submitLimiter.reset();
}
