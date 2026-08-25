/**
 * German-aware text normalisation shared by the diversity checker, the
 * similarity helpers and the fixture embedding provider.
 *
 * Everything here is deterministic and dependency-free: two runs over the same
 * string always produce the same tokens, which is what makes the fixture
 * providers and the diversity thresholds reproducible in CI.
 */

/**
 * High-frequency German function words plus the marketing filler that appears
 * in almost every ad. Leaving these in would make any two German ad texts look
 * ~40 % similar and quietly defeat the diversity check.
 */
export const GERMAN_STOPWORDS: ReadonlySet<string> = new Set([
  'aber', 'alle', 'allen', 'aller', 'alles', 'als', 'also', 'am', 'an', 'andere', 'anderen',
  'auch', 'auf', 'aus', 'bei', 'beim', 'bin', 'bis', 'bist', 'da', 'damit', 'dann', 'das',
  'dass', 'dein', 'deine', 'dem', 'den', 'denn', 'der', 'des', 'dessen', 'die', 'dies',
  'diese', 'diesem', 'diesen', 'dieser', 'dieses', 'doch', 'dort', 'du', 'durch', 'ein',
  'eine', 'einem', 'einen', 'einer', 'eines', 'er', 'es', 'etwas', 'euer', 'eure', 'fuer',
  'ganz', 'gar', 'gegen', 'gibt', 'hab', 'habe', 'haben', 'hat', 'hatte', 'hier', 'hin',
  'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'im', 'immer', 'in', 'ins', 'ist', 'ja',
  'jede', 'jeden', 'jeder', 'jetzt', 'kann', 'kein', 'keine', 'koennen', 'machen', 'man',
  'mehr', 'mein', 'meine', 'mit', 'muessen', 'nach', 'nicht', 'nichts', 'noch', 'nun',
  'nur', 'ob', 'oder', 'ohne', 'schon', 'sehr', 'sein', 'seine', 'seit', 'sich', 'sie',
  'sind', 'so', 'soll', 'sollen', 'sondern', 'sonst', 'ueber', 'um', 'und', 'uns',
  'unser', 'unsere', 'unter', 'viel', 'viele', 'vom', 'von', 'vor', 'waere', 'war',
  'waren', 'was', 'wenn', 'wer', 'werden', 'wie', 'wieder', 'wir', 'wird', 'wo',
  'wollen', 'wurde', 'wurden', 'zu', 'zum', 'zur', 'zwar', 'zwischen',
]);

/** Folds umlauts and diacritics so "Prozesse" and "prozesse" share a token. */
export function foldGerman(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export interface TokenizeOptions {
  /** Drop German function words. Defaults to true. */
  removeStopwords?: boolean;
  /** Minimum token length kept. Defaults to 3. */
  minLength?: number;
}

export function tokenize(input: string, options: TokenizeOptions = {}): string[] {
  const removeStopwords = options.removeStopwords ?? true;
  const minLength = options.minLength ?? 3;
  return foldGerman(input)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= minLength)
    .filter((token) => !removeStopwords || !GERMAN_STOPWORDS.has(token));
}

export function tokenSet(input: string, options?: TokenizeOptions): Set<string> {
  return new Set(tokenize(input, options));
}

/** Character n-grams over the folded string — catches morphological variants. */
export function shingles(input: string, size = 4): Set<string> {
  const folded = foldGerman(input).replace(/[^a-z0-9]+/g, ' ').trim();
  const result = new Set<string>();
  if (folded.length < size) {
    if (folded.length > 0) result.add(folded);
    return result;
  }
  for (let i = 0; i + size <= folded.length; i++) {
    result.add(folded.slice(i, i + size));
  }
  return result;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Lexical similarity of two German texts: token overlap blended with character
 * shingles. Token overlap alone is brittle for compounds
 * ("Mitarbeitergewinnung" vs. "Mitarbeiter gewinnen"); shingles alone
 * over-reports on shared morphology. The blend behaves sensibly for both.
 */
export function lexicalSimilarity(a: string, b: string): number {
  const tokenScore = jaccard(tokenSet(a), tokenSet(b));
  const shingleScore = jaccard(shingles(a), shingles(b));
  return 0.6 * tokenScore + 0.4 * shingleScore;
}

/** First sentence of a copy block — the hook the reader actually stops on. */
export function firstSentence(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^[\s\S]{0,240}?[.!?…](\s|$)/);
  return (match ? match[0] : trimmed.slice(0, 240)).trim();
}

export function clampText(input: string, max: number): string {
  const trimmed = input.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
