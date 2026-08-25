/**
 * Font metrics.
 *
 * Auto-fitting a German headline needs to know how wide the text will actually
 * be. Guessing "about 1.8 characters per em" breaks the moment a headline says
 * "Wirtschaftlichkeitsberechnung" instead of "Mehr Umsatz", so this module
 * carries real per-glyph advance widths in 1/1000 em — the same units the AFM
 * files of the base-14 fonts use.
 *
 * The tables describe Helvetica. Arial, Liberation Sans and Nimbus Sans are all
 * metric-compatible with it, which is exactly the stack the SVG asks for — so a
 * width computed here matches what librsvg later rasterises, on a designer's Mac
 * and on a headless Linux worker alike.
 */

export const FONT_WEIGHTS = ['regular', 'bold'] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export interface FontMetrics {
  /** Family name for diagnostics; the SVG uses the full stack. */
  readonly family: string;
  readonly weight: FontWeight;
  /** Design units per em. All advances are expressed in these units. */
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly capHeight: number;
  readonly xHeight: number;
  /** Advance used for a codepoint the table does not know. */
  readonly defaultWidth: number;
  readonly widths: ReadonlyMap<number, number>;
}

type WidthGroup = readonly [chars: string, width: number];

/** Helvetica advance widths in 1/1000 em, grouped by shared width. */
const HELVETICA_REGULAR: readonly WidthGroup[] = [
  ['  ', 278],
  ['!', 278],
  ['"', 355],
  ['#$', 556],
  ['%', 889],
  ['&', 667],
  ["'", 191],
  ['()', 333],
  ['*', 389],
  ['+<=>', 584],
  [',.', 278],
  ['-', 333],
  ['/', 278],
  ['0123456789', 556],
  [':;', 278],
  ['?', 556],
  ['@', 1015],
  ['I', 278],
  ['J', 500],
  ['L', 556],
  ['FTZ', 611],
  ['ABEKPSVXY', 667],
  ['CDHNRU', 722],
  ['GOQ', 778],
  ['M', 833],
  ['W', 944],
  ['[\\]', 278],
  ['^', 469],
  ['_', 556],
  ['`', 333],
  ['ijl', 222],
  ['ft', 278],
  ['r', 333],
  ['cksvxyz', 500],
  ['abdeghnopqu', 556],
  ['w', 722],
  ['m', 833],
  ['{}', 334],
  ['|', 260],
  ['~', 584],
];

/** Helvetica-Bold advance widths in 1/1000 em. */
const HELVETICA_BOLD: readonly WidthGroup[] = [
  ['  ', 278],
  ['!', 333],
  ['"', 474],
  ['#$', 556],
  ['%', 889],
  ['&', 722],
  ["'", 238],
  ['()', 333],
  ['*', 389],
  ['+<=>', 584],
  [',.', 278],
  ['-', 333],
  ['/', 278],
  ['0123456789', 556],
  [':;', 333],
  ['?', 611],
  ['@', 975],
  ['I', 278],
  ['J', 556],
  ['EFLTZ', 611],
  ['PSVXY', 667],
  ['ABCDHKNRU', 722],
  ['GOQ', 778],
  ['M', 833],
  ['W', 944],
  ['[]', 333],
  ['\\', 278],
  ['^', 584],
  ['_', 556],
  ['`', 333],
  ['ijl', 278],
  ['ft', 333],
  ['r', 389],
  ['z', 500],
  ['aceksvxy', 556],
  ['bdghnopqu', 611],
  ['w', 778],
  ['m', 889],
  ['{}', 389],
  ['|', 280],
  ['~', 584],
];

/**
 * Punctuation and symbols beyond ASCII that show up in German ad copy. Anything
 * not listed here falls back to its NFD base letter — `ä` inherits `a`, which is
 * exactly how the real fonts behave, because a combining accent adds no advance.
 */
const EXTRA_REGULAR: readonly WidthGroup[] = [
  ['«»', 556],
  ['°', 400],
  ['µ', 556],
  ['·', 278],
  ['×÷', 584],
  ['ß', 556],
  ['æ', 889],
  ['Æ', 1000],
  ['ø', 611],
  ['Ø', 778],
  ['œ', 944],
  ['Œ', 1000],
  ['–', 556],
  ['—', 1000],
  ['‘’‚', 222],
  ['“”„', 333],
  ['†‡', 556],
  ['•', 350],
  ['…', 1000],
  ['€', 556],
  ['™', 1000],
  ['©®', 737],
  ['→←', 700],
  ['✓✗', 620],
];

const EXTRA_BOLD: readonly WidthGroup[] = [
  ['«»', 556],
  ['°', 400],
  ['µ', 611],
  ['·', 278],
  ['×÷', 584],
  ['ß', 611],
  ['æ', 889],
  ['Æ', 1000],
  ['ø', 611],
  ['Ø', 778],
  ['œ', 944],
  ['Œ', 1000],
  ['–', 556],
  ['—', 1000],
  ['‘’‚', 278],
  ['“”„', 500],
  ['†‡', 556],
  ['•', 350],
  ['…', 1000],
  ['€', 556],
  ['™', 1000],
  ['©®', 737],
  ['→←', 700],
  ['✓✗', 660],
];

function buildWidths(...tables: ReadonlyArray<readonly WidthGroup[]>): Map<number, number> {
  const widths = new Map<number, number>();
  for (const table of tables) {
    for (const [chars, width] of table) {
      for (const char of chars) widths.set(char.codePointAt(0)!, width);
    }
  }
  return widths;
}

export const HELVETICA_METRICS: Readonly<Record<FontWeight, FontMetrics>> = {
  regular: {
    family: 'Helvetica',
    weight: 'regular',
    unitsPerEm: 1000,
    ascender: 718,
    descender: -207,
    capHeight: 718,
    xHeight: 523,
    defaultWidth: 556,
    widths: buildWidths(HELVETICA_REGULAR, EXTRA_REGULAR),
  },
  bold: {
    family: 'Helvetica-Bold',
    weight: 'bold',
    unitsPerEm: 1000,
    ascender: 718,
    descender: -207,
    capHeight: 718,
    xHeight: 532,
    defaultWidth: 611,
    widths: buildWidths(HELVETICA_BOLD, EXTRA_BOLD),
  },
};

export function metricsFor(weight: FontWeight): FontMetrics {
  return HELVETICA_METRICS[weight];
}

/**
 * Advance width of a single codepoint in font units.
 *
 * Unknown codepoints are decomposed first — `ä` becomes `a` plus a combining
 * accent, and the accent contributes nothing — before the family default kicks
 * in.
 */
export function advanceWidth(metrics: FontMetrics, codePoint: number): number {
  const direct = metrics.widths.get(codePoint);
  if (direct !== undefined) return direct;

  // Combining marks and zero-width characters take no space.
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
  if (codePoint === 0x200b || codePoint === 0x00ad || codePoint === 0xfeff) return 0;

  const char = String.fromCodePoint(codePoint);
  const decomposed = char.normalize('NFD');
  if (decomposed !== char) {
    let total = 0;
    for (const part of decomposed) {
      const cp = part.codePointAt(0)!;
      if (cp >= 0x0300 && cp <= 0x036f) continue;
      total += metrics.widths.get(cp) ?? metrics.defaultWidth;
    }
    if (total > 0) return total;
  }
  return metrics.defaultWidth;
}

/**
 * The default SVG font stack. Every family listed is metric-compatible with the
 * table above, so a measured width holds whichever one the host resolves.
 */
export const DEFAULT_FONT_STACK =
  "'Liberation Sans', 'Helvetica Neue', Helvetica, Arial, 'Nimbus Sans', sans-serif";
