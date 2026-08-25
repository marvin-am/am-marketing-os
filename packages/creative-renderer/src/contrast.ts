/**
 * WCAG AA enforcement for text over a photographic motif.
 *
 * A base motif is whatever the image model produced: it can be bright, dark or
 * both inside the same text box. Rather than trusting a fixed 40 % black scrim,
 * the composer samples the crop under each text region, derives a conservative
 * backdrop, and then *solves* for the smallest scrim that carries the text over
 * the AA threshold. If no scrim of the intended colour can do it, the scrim
 * colour is swapped; if that still fails, the text colour is. Every adjustment
 * is recorded so the rendition can show what happened and why.
 */

import { blendOver, bestContrastColor, contrastRatio, svgColor, type Rgb } from './color';

/** WCAG 2.1 AA thresholds. */
export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3;
/** Above this px size, bold text counts as "large" for AA. */
export const LARGE_TEXT_MIN_PX_BOLD = 24;
export const LARGE_TEXT_MIN_PX_REGULAR = 30;

export function aaTargetFor(fontSizePx: number, bold: boolean): number {
  const threshold = bold ? LARGE_TEXT_MIN_PX_BOLD : LARGE_TEXT_MIN_PX_REGULAR;
  return fontSizePx >= threshold ? WCAG_AA_LARGE : WCAG_AA_NORMAL;
}

export function meetsWcagAa(ratio: number, target: number = WCAG_AA_NORMAL): boolean {
  // Rounded to two decimals the way the WCAG tooling reports it.
  return Math.round(ratio * 100) / 100 >= target;
}

export interface LegibilityRequest {
  /** Colour actually behind the text before any scrim (sampled or a panel). */
  backdrop: Rgb | string;
  textColor: string;
  /** The scrim colour the template would like to use. */
  scrimColor: string;
  /** Opacity the design starts from; the solver only ever raises it. */
  baseOpacity: number;
  /** Hard ceiling so a "scrim" never becomes an opaque block by accident. */
  maxOpacity?: number;
  target: number;
  /** Alternative scrim colours tried in order when the preferred one cannot win. */
  fallbackScrims?: readonly string[];
  /** Text colours tried as a last resort. */
  fallbackTextColors?: readonly string[];
}

export interface LegibilityResolution {
  textColor: string;
  scrimColor: string;
  opacity: number;
  /** Colour the text is actually drawn on after the scrim is applied. */
  effectiveBackdrop: string;
  ratio: number;
  target: number;
  passes: boolean;
  /** Human-readable German notes about every change the solver made. */
  adjustments: string[];
}

const OPACITY_STEP = 0.02;
const DEFAULT_MAX_OPACITY = 0.94;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function solveOpacity(
  request: LegibilityRequest,
  scrimColor: string,
  textColor: string,
): { opacity: number; ratio: number; backdrop: Rgb; passes: boolean } {
  const maxOpacity = round2(request.maxOpacity ?? DEFAULT_MAX_OPACITY);
  const start = round2(Math.min(Math.max(request.baseOpacity, 0), maxOpacity));
  let best = {
    opacity: start,
    ratio: 0,
    backdrop: blendOver(scrimColor, request.backdrop, start),
    passes: false,
  };

  const steps = Math.max(0, Math.ceil((maxOpacity - start) / OPACITY_STEP));
  for (let step = 0; step <= steps; step++) {
    // The opacity is rounded *before* it is evaluated, so the ratio reported on
    // the rendition is the ratio of the scrim the template actually draws.
    const alpha = Math.min(maxOpacity, round2(start + step * OPACITY_STEP));
    const backdrop = blendOver(scrimColor, request.backdrop, alpha);
    const ratio = contrastRatio(textColor, backdrop);
    if (ratio > best.ratio) {
      best = { opacity: alpha, ratio, backdrop, passes: meetsWcagAa(ratio, request.target) };
    }
    if (meetsWcagAa(ratio, request.target)) {
      return { opacity: alpha, ratio, backdrop, passes: true };
    }
  }
  return best;
}

/**
 * Raises the scrim (and, if it must, changes scrim or text colour) until the
 * text clears AA. Pure: the caller supplies the sampled backdrop.
 */
export function resolveLegibility(request: LegibilityRequest): LegibilityResolution {
  const adjustments: string[] = [];
  const fallbackScrims = request.fallbackScrims ?? ['#000000', '#FFFFFF'];
  const fallbackTextColors = request.fallbackTextColors ?? ['#FFFFFF', '#111111'];

  const primary = solveOpacity(request, request.scrimColor, request.textColor);
  if (primary.passes) {
    if (primary.opacity > request.baseOpacity + 1e-9) {
      adjustments.push(
        `Abdunklung von ${Math.round(request.baseOpacity * 100)} % auf ${Math.round(primary.opacity * 100)} % erhöht.`,
      );
    }
    return {
      textColor: request.textColor,
      scrimColor: request.scrimColor,
      opacity: primary.opacity,
      effectiveBackdrop: svgColor(primary.backdrop),
      ratio: round2(primary.ratio),
      target: request.target,
      passes: true,
      adjustments,
    };
  }

  for (const scrim of fallbackScrims) {
    if (scrim.toUpperCase() === request.scrimColor.toUpperCase()) continue;
    const attempt = solveOpacity(request, scrim, request.textColor);
    if (attempt.passes) {
      adjustments.push(
        `Overlay-Farbe von ${request.scrimColor.toUpperCase()} auf ${scrim.toUpperCase()} gewechselt (Deckkraft ${Math.round(attempt.opacity * 100)} %).`,
      );
      return {
        textColor: request.textColor,
        scrimColor: scrim,
        opacity: attempt.opacity,
        effectiveBackdrop: svgColor(attempt.backdrop),
        ratio: round2(attempt.ratio),
        target: request.target,
        passes: true,
        adjustments,
      };
    }
  }

  // Last resort: keep the intended scrim, change the text colour instead.
  const maxOpacity = round2(request.maxOpacity ?? DEFAULT_MAX_OPACITY);
  const settledBackdrop = blendOver(request.scrimColor, request.backdrop, maxOpacity);
  const swap = bestContrastColor(settledBackdrop, fallbackTextColors);
  if (meetsWcagAa(swap.ratio, request.target)) {
    adjustments.push(
      `Textfarbe von ${request.textColor.toUpperCase()} auf ${swap.color.toUpperCase()} gewechselt, um AA zu erreichen.`,
    );
    return {
      textColor: swap.color,
      scrimColor: request.scrimColor,
      opacity: round2(maxOpacity),
      effectiveBackdrop: svgColor(settledBackdrop),
      ratio: round2(swap.ratio),
      target: request.target,
      passes: true,
      adjustments,
    };
  }

  adjustments.push(
    `Kontrast bleibt unter AA (${round2(primary.ratio)}:1 statt ${request.target}:1) – Motiv oder Farbtokens prüfen.`,
  );
  return {
    textColor: request.textColor,
    scrimColor: request.scrimColor,
    opacity: round2(primary.opacity),
    effectiveBackdrop: svgColor(primary.backdrop),
    ratio: round2(primary.ratio),
    target: request.target,
    passes: false,
    adjustments,
  };
}

/**
 * Conservative backdrop estimate for a photographic region.
 *
 * A mean alone is optimistic: a text box averaging mid-grey can still contain a
 * bright highlight right behind a white word. Shifting the mean by one standard
 * deviation *towards* the text colour models that worst case without needing a
 * per-pixel scan.
 */
export function worstCaseBackdrop(
  mean: Rgb,
  stdev: Rgb,
  textColor: string,
  sigma = 1,
): Rgb {
  const towardsLight = contrastRatio(textColor, '#000000') > contrastRatio(textColor, '#FFFFFF');
  const shift = (m: number, s: number): number =>
    towardsLight ? Math.min(255, m + sigma * s) : Math.max(0, m - sigma * s);
  return { r: shift(mean.r, stdev.r), g: shift(mean.g, stdev.g), b: shift(mean.b, stdev.b) };
}
