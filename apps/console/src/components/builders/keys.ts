/**
 * Stable spec keys derived from German labels.
 *
 * A spec key (`specKeySchema` in `@am/domain`) is lowercase `a-z0-9_`, starts
 * with a letter and is at most 64 characters. Operators never type one: the
 * builder derives it from the visible German label **once**, at creation time,
 * and freezes it afterwards.
 *
 * Freezing matters most for answer options. The option id is what routing
 * rules, qualification rules, analytics rollups and the CRM store; rewriting it
 * after a version has been published would silently reinterpret every
 * historical answer that carried the old id. The label may be rewritten freely,
 * because nothing but a human reads it.
 */

const TRANSLITERATIONS: readonly (readonly [RegExp, string])[] = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
  [/€/g, ' eur '],
  [/%/g, ' prozent '],
  [/&/g, ' und '],
  [/[àáâãå]/g, 'a'],
  [/[èéêë]/g, 'e'],
  [/[ìíîï]/g, 'i'],
  [/[òóôõ]/g, 'o'],
  [/[ùúû]/g, 'u'],
  [/ç/g, 'c'],
  [/ñ/g, 'n'],
];

export const MAX_KEY_LENGTH = 64;

/**
 * Turns a German label into a spec key. Never throws: an unusable label falls
 * back to `fallback`, so an operator can always create the element and rename
 * the visible label afterwards.
 */
export function deriveKey(label: string, fallback = 'wert'): string {
  let value = label.toLowerCase();
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    value = value.replace(pattern, replacement);
  }
  value = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (value.length === 0) return fallback;
  if (!/^[a-z]/.test(value)) value = `${fallback}_${value}`;

  const trimmed = value.slice(0, MAX_KEY_LENGTH).replace(/_+$/, '');
  return trimmed.length === 0 ? fallback : trimmed;
}

/** Appends `_2`, `_3`, … until the key is free inside `taken`. */
export function uniqueKey(candidate: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(candidate)) return candidate;

  for (let counter = 2; counter < 1000; counter += 1) {
    const suffix = `_${counter}`;
    const next = `${candidate.slice(0, MAX_KEY_LENGTH - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!used.has(next)) return next;
  }
  /* Practically unreachable — a spec is capped far below 1000 siblings. */
  return `${candidate.slice(0, MAX_KEY_LENGTH - 14)}_${Date.now().toString(36)}`;
}

export function deriveUniqueKey(
  label: string,
  taken: Iterable<string>,
  fallback = 'wert',
): string {
  return uniqueKey(deriveKey(label, fallback), taken);
}

/** Reason codes are `GROSS_MIT_UNTERSTRICH`; derived the same way, then upcased. */
export function deriveReasonCode(label: string, fallback = 'grund'): string {
  return deriveKey(label, fallback).toUpperCase();
}

/** Page slugs use hyphens rather than underscores. */
export function deriveSlug(label: string, fallback = 'seite'): string {
  const key = deriveKey(label, fallback).replace(/_/g, '-');
  return key.replace(/^-+|-+$/g, '') || fallback;
}
