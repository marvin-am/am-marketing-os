/**
 * Text measurement, wrapping and auto-fit.
 *
 * Every headline in this system is German, operator-editable and rendered into a
 * fixed pixel box. "Wirtschaftlichkeitsberechnung in 90 Sekunden" must not spill
 * out of a 1080px canvas, and it must not be silently clipped either — so the
 * layout shrinks, wraps, hard-breaks over-long compounds and, only as a last
 * resort, ellipsises. Every path returns a block whose measured extent is
 * guaranteed to sit inside the requested box.
 */

import { advanceWidth, metricsFor, type FontMetrics, type FontWeight } from './fonts';
import { normalizeWhitespace } from './xml';

export interface TextStyle {
  fontSize: number;
  weight: FontWeight;
  /** Extra tracking in px, added after every glyph except the last. */
  letterSpacing: number;
  /** Line box height as a multiple of the font size. */
  lineHeight: number;
  uppercase: boolean;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 48,
  weight: 'bold',
  letterSpacing: 0,
  lineHeight: 1.12,
  uppercase: false,
};

/** Smallest line box we ever emit, relative to the font size. */
const MIN_LINE_HEIGHT = 0.95;

export interface MeasureOptions {
  weight: FontWeight;
  fontSize: number;
  letterSpacing?: number;
}

/** Width of a single line in px, from real per-glyph advances. */
export function measureLineWidth(text: string, options: MeasureOptions): number {
  const metrics = metricsFor(options.weight);
  const letterSpacing = options.letterSpacing ?? 0;
  let units = 0;
  let glyphs = 0;
  for (const char of text) {
    units += advanceWidth(metrics, char.codePointAt(0)!);
    glyphs++;
  }
  if (glyphs === 0) return 0;
  return (units * options.fontSize) / metrics.unitsPerEm + letterSpacing * (glyphs - 1);
}

/** Vertical extents of one line box, in px. */
export interface LineBoxMetrics {
  lineHeightPx: number;
  ascentPx: number;
  descentPx: number;
  /** Distance from the top of the line box to the baseline. */
  baselineOffset: number;
}

export function lineBoxMetrics(fontSize: number, lineHeight: number, weight: FontWeight): LineBoxMetrics {
  const metrics: FontMetrics = metricsFor(weight);
  const effective = Math.max(lineHeight, MIN_LINE_HEIGHT);
  const lineHeightPx = fontSize * effective;
  const ascentPx = (metrics.ascender * fontSize) / metrics.unitsPerEm;
  const descentPx = (-metrics.descender * fontSize) / metrics.unitsPerEm;
  const halfLeading = Math.max(0, (lineHeightPx - (ascentPx + descentPx)) / 2);
  return { lineHeightPx, ascentPx, descentPx, baselineOffset: halfLeading + ascentPx };
}

/* -------------------------------------------------------------------------- */
/* Wrapping                                                                    */
/* -------------------------------------------------------------------------- */

export interface WrapOptions extends MeasureOptions {
  maxWidth: number;
  uppercase?: boolean;
}

/**
 * Hard-breaks a token that is wider than the line on its own. German compounds
 * do this regularly; a hyphen is appended so the break reads as a break rather
 * than as a typo.
 */
function breakLongToken(token: string, options: WrapOptions): string[] {
  const chars = [...token];
  const pieces: string[] = [];
  let current = '';
  for (const char of chars) {
    const candidate = `${current}${char}`;
    // The hyphen has to fit on the line too, so it is measured with the piece.
    const width = measureLineWidth(`${candidate}-`, options);
    if (current.length > 0 && width > options.maxWidth) {
      pieces.push(`${current}-`);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Greedy word wrap against a real measured width. */
export function wrapText(text: string, options: WrapOptions): string[] {
  const normalized = normalizeWhitespace(options.uppercase ? text.toUpperCase() : text);
  if (normalized.length === 0) return [];
  if (options.maxWidth <= 0) return [normalized];

  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  const pushCurrent = (): void => {
    if (current.length > 0) {
      lines.push(current);
      current = '';
    }
  };

  for (const word of words) {
    if (word.length === 0) continue;
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (measureLineWidth(candidate, options) <= options.maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (measureLineWidth(word, options) <= options.maxWidth) {
      current = word;
      continue;
    }
    const pieces = breakLongToken(word, options);
    for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]!);
    current = pieces[pieces.length - 1] ?? '';
  }
  pushCurrent();
  return lines;
}

/** Shortens a line until it fits, appending a horizontal ellipsis. */
export function truncateToWidth(text: string, options: MeasureOptions & { maxWidth: number }): string {
  if (measureLineWidth(text, options) <= options.maxWidth) return text;
  const chars = [...text];
  let end = chars.length;
  while (end > 0) {
    const candidate = `${chars.slice(0, end).join('').trimEnd()}…`;
    if (measureLineWidth(candidate, options) <= options.maxWidth) return candidate;
    end--;
  }
  return '…';
}

/* -------------------------------------------------------------------------- */
/* Auto-fit                                                                    */
/* -------------------------------------------------------------------------- */

export interface FitBox {
  width: number;
  height: number;
}

export interface AutoFitOptions {
  weight: FontWeight;
  maxFontSize: number;
  minFontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  /** Tracking as a fraction of the font size; resolved per candidate size. */
  letterSpacingEm?: number;
  maxLines?: number;
  uppercase?: boolean;
}

export interface TextBlock {
  lines: string[];
  fontSize: number;
  weight: FontWeight;
  letterSpacing: number;
  lineHeightPx: number;
  /** Baseline of the first line, measured from the top of the block. */
  firstBaseline: number;
  /** Widest measured line, in px. */
  width: number;
  /** Total block height, in px. */
  height: number;
  /** True when the copy did not fit even at the minimum size. */
  truncated: boolean;
}

export const EMPTY_TEXT_BLOCK: TextBlock = {
  lines: [],
  fontSize: 0,
  weight: 'regular',
  letterSpacing: 0,
  lineHeightPx: 0,
  firstBaseline: 0,
  width: 0,
  height: 0,
  truncated: false,
};

function layout(
  lines: string[],
  fontSize: number,
  options: AutoFitOptions,
  letterSpacing: number,
): TextBlock {
  const box = lineBoxMetrics(fontSize, options.lineHeight, options.weight);
  let width = 0;
  for (const line of lines) {
    width = Math.max(
      width,
      measureLineWidth(line, { weight: options.weight, fontSize, letterSpacing }),
    );
  }
  return {
    lines,
    fontSize,
    weight: options.weight,
    letterSpacing,
    lineHeightPx: box.lineHeightPx,
    firstBaseline: box.baselineOffset,
    width,
    height: lines.length * box.lineHeightPx,
    truncated: false,
  };
}

function resolveLetterSpacing(options: AutoFitOptions, fontSize: number): number {
  if (options.letterSpacingEm !== undefined) return options.letterSpacingEm * fontSize;
  return options.letterSpacing ?? 0;
}

/**
 * Finds the largest font size at which `text` wraps inside `box`.
 *
 * `fits(size)` is monotone — a larger size never wraps into fewer or narrower
 * lines — so a binary search over integer sizes is exact. When even the minimum
 * size overflows, the block is truncated to the lines that fit and the last one
 * is ellipsised, and `truncated` is set so the caller can surface a warning
 * instead of shipping clipped copy unnoticed.
 */
export function autoFitText(text: string, box: FitBox, options: AutoFitOptions): TextBlock {
  const source = normalizeWhitespace(options.uppercase ? text.toUpperCase() : text);
  if (source.length === 0) return { ...EMPTY_TEXT_BLOCK, weight: options.weight };

  const minSize = Math.max(1, Math.floor(options.minFontSize));
  const maxSize = Math.max(minSize, Math.floor(options.maxFontSize));

  const attempt = (fontSize: number): TextBlock => {
    const letterSpacing = resolveLetterSpacing(options, fontSize);
    const lines = wrapText(source, {
      weight: options.weight,
      fontSize,
      letterSpacing,
      maxWidth: box.width,
      uppercase: options.uppercase,
    });
    return layout(lines, fontSize, options, letterSpacing);
  };

  const fits = (block: TextBlock): boolean =>
    block.width <= box.width + 0.5 &&
    block.height <= box.height + 0.5 &&
    (options.maxLines === undefined || block.lines.length <= options.maxLines);

  let low = minSize;
  let high = maxSize;
  let best: TextBlock | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const block = attempt(mid);
    if (fits(block)) {
      best = block;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best) return best;

  // Nothing fits: lay out at the minimum size and cut to the available lines.
  const fallback = attempt(minSize);
  const maxLinesByHeight = Math.max(1, Math.floor((box.height + 0.5) / fallback.lineHeightPx));
  const maxLines = Math.min(maxLinesByHeight, options.maxLines ?? maxLinesByHeight);
  if (fallback.lines.length <= maxLines) {
    return { ...fallback, truncated: false };
  }

  const kept = fallback.lines.slice(0, maxLines);
  const lastIndex = kept.length - 1;
  const remainder = fallback.lines.slice(maxLines).join(' ');
  const merged = `${kept[lastIndex] ?? ''} ${remainder}`.trim();
  kept[lastIndex] = truncateToWidth(merged, {
    weight: options.weight,
    fontSize: minSize,
    letterSpacing: fallback.letterSpacing,
    maxWidth: box.width,
  });
  const block = layout(kept, minSize, options, fallback.letterSpacing);
  return { ...block, truncated: true };
}

/** Auto-fit constrained to a single line — used for figures, CTAs and labels. */
export function fitSingleLine(
  text: string,
  box: FitBox,
  options: Omit<AutoFitOptions, 'maxLines'>,
): TextBlock {
  return autoFitText(text, box, { ...options, maxLines: 1 });
}

/** Reports whether a laid-out block sits fully inside a box. */
export function blockFitsInside(block: TextBlock, box: FitBox): boolean {
  return block.width <= box.width + 0.5 && block.height <= box.height + 0.5;
}
