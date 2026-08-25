import { fnv1a32 } from '@am/domain';

/**
 * Stable, synchronous content hashing for prompt fingerprints and `ai_jobs`
 * input/output hashes.
 *
 * These hashes answer "did this input change?" and "which prompt produced this
 * row?" — they are provenance markers, not a security boundary, so a fast
 * non-cryptographic hash is the right tool. `sha256Hex` from `@am/domain` is
 * async (WebCrypto) and would force every prompt-registry lookup to become a
 * promise for no benefit.
 */

const SALTS = ['am', 'am', 'am', 'am'] as const;

/** 128-bit stable digest rendered as 32 lowercase hex characters. */
export function stableHash(input: string): string {
  return SALTS.map((salt) =>
    fnv1a32(`${salt}${input}${salt}${input.length}`)
      .toString(16)
      .padStart(8, '0'),
  ).join('');
}

/**
 * Deterministic JSON serialisation with sorted object keys, so that two
 * structurally equal inputs hash identically regardless of property order.
 */
export function stableJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (Array.isArray(input)) return input.map(walk);
    if (input instanceof Date) return input.toISOString();
    if (typeof input === 'object') {
      const source = input as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue;
        result[key] = walk(source[key]);
      }
      return result;
    }
    if (typeof input === 'function') return `[function ${(input as { name?: string }).name ?? ''}]`;
    return input;
  };
  return JSON.stringify(walk(value));
}

export function hashUnknown(value: unknown): string {
  return stableHash(stableJson(value));
}

/** Short, human-quotable form used in UI badges and log lines. */
export function shortHash(input: string, length = 12): string {
  return stableHash(input).slice(0, length);
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded from a hash of the input so a
 * fixture provider returns byte-identical output for byte-identical input.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(input: string): number {
  return fnv1a32(input);
}

/** Deterministically picks one element of a non-empty list. */
export function pickDeterministic<T>(items: readonly T[], seed: number): T {
  if (items.length === 0) throw new Error('pickDeterministic requires a non-empty list');
  return items[seed % items.length] as T;
}
