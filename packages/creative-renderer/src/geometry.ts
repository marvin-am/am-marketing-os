/**
 * Canvas geometry and Meta safe areas.
 *
 * Meta renders its own chrome over a creative: the profile row and the CTA bar
 * in feed, and a much larger top/bottom band in Stories and Reels. Anything the
 * template puts into those bands is either covered or cropped, so every layout
 * works against the safe rectangle rather than the full canvas.
 */

import { type AspectRatio } from '@am/domain';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in 0..1 canvas coordinates. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CanvasGeometry {
  ratio: AspectRatio;
  width: number;
  height: number;
  /** Safe rectangle after Meta's UI zones and the brand margin. */
  safe: Rect;
  insets: Insets;
  /** Layout unit derived from the canvas width; all spacing is a multiple. */
  unit: number;
}

/** Output pixel dimensions per ratio. Width is fixed at Meta's 1080px rail. */
export const RATIO_DIMENSIONS: Readonly<Record<AspectRatio, { width: number; height: number }>> = {
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '9:16': { width: 1080, height: 1920 },
};

/**
 * Safe-area insets as a fraction of the respective axis.
 *
 * Feed placements only need a comfortable brand margin. 9:16 reserves Meta's
 * documented Stories/Reels zones: roughly the top 14 % for the profile row and
 * the bottom 20 % for the swipe-up and CTA furniture.
 */
export const SAFE_AREA_FRACTIONS: Readonly<Record<AspectRatio, Insets>> = {
  '1:1': { top: 0.06, right: 0.06, bottom: 0.06, left: 0.06 },
  '4:5': { top: 0.055, right: 0.06, bottom: 0.055, left: 0.06 },
  '9:16': { top: 0.14, right: 0.06, bottom: 0.2, left: 0.06 },
};

function roundTo(value: number, step = 2): number {
  return Math.round(value / step) * step;
}

export function canvasFor(ratio: AspectRatio): CanvasGeometry {
  const { width, height } = RATIO_DIMENSIONS[ratio];
  const fractions = SAFE_AREA_FRACTIONS[ratio];
  const insets: Insets = {
    top: roundTo(height * fractions.top),
    right: roundTo(width * fractions.right),
    bottom: roundTo(height * fractions.bottom),
    left: roundTo(width * fractions.left),
  };
  return {
    ratio,
    width,
    height,
    insets,
    safe: {
      x: insets.left,
      y: insets.top,
      width: width - insets.left - insets.right,
      height: height - insets.top - insets.bottom,
    },
    unit: Math.round(width / 90),
  };
}

/** Every supported canvas, in the order the console displays them. */
export function allCanvases(ratios: readonly AspectRatio[]): CanvasGeometry[] {
  return ratios.map(canvasFor);
}

export function insetRect(rect: Rect, amount: number | Partial<Insets>): Rect {
  const insets: Insets =
    typeof amount === 'number'
      ? { top: amount, right: amount, bottom: amount, left: amount }
      : { top: 0, right: 0, bottom: 0, left: 0, ...amount };
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width: Math.max(0, rect.width - insets.left - insets.right),
    height: Math.max(0, rect.height - insets.top - insets.bottom),
  };
}

export function rectContains(outer: Rect, inner: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

export function normalizeRect(rect: Rect, canvas: CanvasGeometry): NormalizedRect {
  return {
    x: rect.x / canvas.width,
    y: rect.y / canvas.height,
    width: rect.width / canvas.width,
    height: rect.height / canvas.height,
  };
}

export function denormalizeRect(rect: NormalizedRect, canvas: CanvasGeometry): Rect {
  return {
    x: rect.x * canvas.width,
    y: rect.y * canvas.height,
    width: rect.width * canvas.width,
    height: rect.height * canvas.height,
  };
}

/** Clamps a rect to integer pixels inside `bounds`, keeping at least 1px. */
export function clampRectToPixels(rect: Rect, bounds: { width: number; height: number }): Rect {
  const x = Math.min(Math.max(0, Math.round(rect.x)), Math.max(0, bounds.width - 1));
  const y = Math.min(Math.max(0, Math.round(rect.y)), Math.max(0, bounds.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width), bounds.width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height), bounds.height - y)),
  };
}

/* -------------------------------------------------------------------------- */
/* Focus point                                                                 */
/* -------------------------------------------------------------------------- */

export interface FocusPoint {
  /** 0 = left edge, 1 = right edge. */
  x: number;
  /** 0 = top edge, 1 = bottom edge. */
  y: number;
}

export const CENTER_FOCUS: FocusPoint = { x: 0.5, y: 0.5 };

export interface CoverCrop {
  /** Size the source is scaled to before extraction. */
  scaledWidth: number;
  scaledHeight: number;
  /** Extraction window inside the scaled image. */
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * Computes a cover crop that keeps `focus` as close to its relative position as
 * the target box allows. Deterministic integer arithmetic — the same source and
 * focus point always produce byte-identical crops.
 */
export function coverCrop(
  source: { width: number; height: number },
  target: { width: number; height: number },
  focus: FocusPoint = CENTER_FOCUS,
): CoverCrop {
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('Das Basismotiv hat keine gültigen Abmessungen.');
  }
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const scaledWidth = Math.max(target.width, Math.ceil(source.width * scale));
  const scaledHeight = Math.max(target.height, Math.ceil(source.height * scale));

  const focusX = Math.min(1, Math.max(0, focus.x));
  const focusY = Math.min(1, Math.max(0, focus.y));

  const left = Math.round(focusX * scaledWidth - target.width / 2);
  const top = Math.round(focusY * scaledHeight - target.height / 2);

  return {
    scaledWidth,
    scaledHeight,
    scale,
    left: Math.min(Math.max(0, left), scaledWidth - target.width),
    top: Math.min(Math.max(0, top), scaledHeight - target.height),
    width: target.width,
    height: target.height,
  };
}
