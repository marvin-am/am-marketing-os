/**
 * Shared building blocks for the controlled template library.
 *
 * Templates are pure functions from a resolved input to an SVG string. They may
 * not read configuration, touch the filesystem, call a model or reach for a
 * clock — everything they need arrives in `TemplateInput`, which is what makes
 * the whole renderer reproducible and every layout unit-testable without ever
 * rasterising a pixel.
 */

import { type CanvasGeometry, type Rect } from '../geometry';
import { escapeXml } from '../xml';
import {
  autoFitText,
  fitSingleLine,
  lineBoxMetrics,
  measureLineWidth,
  type AutoFitOptions,
  type TextBlock,
} from '../text';
import type { BrandTokens, CreativeContent, TemplateId, TextFitReport } from '../types';

/* -------------------------------------------------------------------------- */
/* Template contract                                                           */
/* -------------------------------------------------------------------------- */

export interface ResolvedScrim {
  color: string;
  opacity: number;
}

export interface TemplateInput {
  canvas: CanvasGeometry;
  tokens: BrandTokens;
  content: CreativeContent;
  /** Scrim after the contrast solver has had its say. */
  scrim: ResolvedScrim;
  /** Colour for text drawn over the motif, after the contrast solver. */
  overlayTextColor: string;
}

/**
 * What the composer needs to know *before* rendering, so it can sample the motif
 * and solve for a scrim that clears WCAG AA.
 */
export interface TemplateContrastPlan {
  /** Motif region behind the contrast-critical text. */
  sampleRect: Rect;
  textColor: string;
  scrimColor: string;
  baseOpacity: number;
  /** Critical text is large per WCAG (≥ 24px bold), so AA large applies. */
  largeText: boolean;
  /**
   * Set when the critical text sits on an opaque field rather than on the motif.
   * The composer then checks against this colour and skips motif sampling.
   */
  opaqueBackdrop: string | null;
}

export interface TemplateLayout {
  svg: string;
  fits: TextFitReport[];
  /** Bounding boxes of every text block actually drawn. */
  bounds: Rect[];
}

export interface CreativeTemplate {
  id: TemplateId;
  labelDe: string;
  plan(canvas: CanvasGeometry, tokens: BrandTokens): TemplateContrastPlan;
  /** Pure `(input) => SVGString`. */
  render(input: TemplateInput): string;
  /** The same layout, with its measurements exposed. */
  layout(input: TemplateInput): TemplateLayout;
}

/* -------------------------------------------------------------------------- */
/* Numeric formatting                                                          */
/* -------------------------------------------------------------------------- */

/** Two decimals, no exponent, no trailing zeros — stable across runs. */
export function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/* -------------------------------------------------------------------------- */
/* SVG primitives                                                              */
/* -------------------------------------------------------------------------- */

export function svgDocument(canvas: CanvasGeometry, body: string, defs = ''): string {
  const viewBox = `0 0 ${canvas.width} ${canvas.height}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="${viewBox}">`,
    defs.length > 0 ? `<defs>${defs}</defs>` : '',
    body,
    '</svg>',
  ]
    .filter((part) => part.length > 0)
    .join('');
}

export interface RectOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  opacity?: number;
  rx?: number;
}

export function rect(options: RectOptions): string {
  const parts = [
    `x="${fmt(options.x)}"`,
    `y="${fmt(options.y)}"`,
    `width="${fmt(Math.max(0, options.width))}"`,
    `height="${fmt(Math.max(0, options.height))}"`,
    `fill="${escapeXml(options.fill)}"`,
  ];
  if (options.rx !== undefined && options.rx > 0) parts.push(`rx="${fmt(options.rx)}"`);
  if (options.opacity !== undefined && options.opacity < 1) {
    parts.push(`fill-opacity="${fmt(options.opacity)}"`);
  }
  return `<rect ${parts.join(' ')}/>`;
}

export function circle(cx: number, cy: number, r: number, fill: string, opacity = 1): string {
  const opacityAttr = opacity < 1 ? ` fill-opacity="${fmt(opacity)}"` : '';
  return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${escapeXml(fill)}"${opacityAttr}/>`;
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  strokeWidth: number,
  opacity = 1,
): string {
  const opacityAttr = opacity < 1 ? ` stroke-opacity="${fmt(opacity)}"` : '';
  return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${escapeXml(stroke)}" stroke-width="${fmt(strokeWidth)}"${opacityAttr}/>`;
}

export function path(d: string, fill: string, opacity = 1): string {
  const opacityAttr = opacity < 1 ? ` fill-opacity="${fmt(opacity)}"` : '';
  return `<path d="${escapeXml(d)}" fill="${escapeXml(fill)}"${opacityAttr}/>`;
}

export function strokePath(d: string, stroke: string, strokeWidth: number, opacity = 1): string {
  const opacityAttr = opacity < 1 ? ` stroke-opacity="${fmt(opacity)}"` : '';
  return `<path d="${escapeXml(d)}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${opacityAttr}/>`;
}

/**
 * Check and cross marks are drawn as vectors, not as ✓/✗ glyphs: those are
 * missing from several of the metric-compatible sans faces and would silently
 * render as tofu on a worker with a different font set.
 */
export function checkMark(cx: number, cy: number, size: number, color: string): string {
  const h = size / 2;
  const d = `M ${fmt(cx - h)} ${fmt(cy + h * 0.05)} L ${fmt(cx - h * 0.2)} ${fmt(cy + h * 0.62)} L ${fmt(cx + h)} ${fmt(cy - h * 0.62)}`;
  return strokePath(d, color, Math.max(2, size * 0.16));
}

export function crossMark(cx: number, cy: number, size: number, color: string): string {
  const h = size * 0.36;
  const d = `M ${fmt(cx - h)} ${fmt(cy - h)} L ${fmt(cx + h)} ${fmt(cy + h)} M ${fmt(cx + h)} ${fmt(cy - h)} L ${fmt(cx - h)} ${fmt(cy + h)}`;
  return strokePath(d, color, Math.max(2, size * 0.16));
}

/** Vertical gradient from transparent to `color` at `opacity`. */
export function verticalScrimGradient(id: string, color: string, opacity: number): string {
  return [
    `<linearGradient id="${escapeXml(id)}" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="${escapeXml(color)}" stop-opacity="0"/>`,
    `<stop offset="0.45" stop-color="${escapeXml(color)}" stop-opacity="${fmt(opacity * 0.55)}"/>`,
    `<stop offset="1" stop-color="${escapeXml(color)}" stop-opacity="${fmt(opacity)}"/>`,
    '</linearGradient>',
  ].join('');
}

export function gradientRect(id: string, area: Rect): string {
  return `<rect x="${fmt(area.x)}" y="${fmt(area.y)}" width="${fmt(area.width)}" height="${fmt(area.height)}" fill="url(#${escapeXml(id)})"/>`;
}

/**
 * A scrim that reaches its full, *solved* opacity across the whole text area and
 * only fades above it.
 *
 * This matters: the contrast solver models a flat overlay. A gradient that is
 * still ramping up where the headline sits would make the reported ratio a
 * fiction, so the ramp is confined to a band above the text.
 */
export function scrimBand(
  id: string,
  area: Rect,
  fadeHeight: number,
  color: string,
  opacity: number,
): { defs: string; body: string } {
  if (opacity <= 0) return { defs: '', body: '' };
  const fade = Math.max(0, fadeHeight);
  const defs = fade > 0 ? verticalScrimGradient(id, color, opacity) : '';
  const body = [
    fade > 0
      ? gradientRect(id, { x: area.x, y: Math.max(0, area.y - fade), width: area.width, height: fade })
      : '',
    rect({ ...area, fill: color, opacity }),
  ]
    .filter((part) => part.length > 0)
    .join('');
  return { defs, body };
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export type TextAnchor = 'start' | 'middle' | 'end';

export interface DrawTextOptions {
  block: TextBlock;
  /** Anchor x. With `middle` this is the centre, with `end` the right edge. */
  x: number;
  /** Top edge of the text block. */
  y: number;
  fill: string;
  fontStack: string;
  anchor?: TextAnchor;
  opacity?: number;
}

export function drawTextBlock(options: DrawTextOptions): string {
  const { block } = options;
  if (block.lines.length === 0) return '';
  const anchor = options.anchor ?? 'start';
  const attributes = [
    `font-family="${escapeXml(options.fontStack)}"`,
    `font-size="${fmt(block.fontSize)}"`,
    `font-weight="${block.weight === 'bold' ? '700' : '400'}"`,
    `fill="${escapeXml(options.fill)}"`,
  ];
  if (anchor !== 'start') attributes.push(`text-anchor="${anchor}"`);
  if (block.letterSpacing !== 0) attributes.push(`letter-spacing="${fmt(block.letterSpacing)}"`);
  if (options.opacity !== undefined && options.opacity < 1) {
    attributes.push(`fill-opacity="${fmt(options.opacity)}"`);
  }
  const prefix = attributes.join(' ');

  return block.lines
    .map((text, index) => {
      const baseline = options.y + block.firstBaseline + index * block.lineHeightPx;
      return `<text ${prefix} x="${fmt(options.x)}" y="${fmt(baseline)}">${escapeXml(text)}</text>`;
    })
    .join('');
}

/** Bounding box of a block drawn with `drawTextBlock`. */
export function textBlockBounds(options: {
  block: TextBlock;
  x: number;
  y: number;
  anchor?: TextAnchor;
}): Rect {
  const anchor = options.anchor ?? 'start';
  const left =
    anchor === 'start'
      ? options.x
      : anchor === 'middle'
        ? options.x - options.block.width / 2
        : options.x - options.block.width;
  return { x: left, y: options.y, width: options.block.width, height: options.block.height };
}

export function fitReport(slot: string, block: TextBlock, box: { width: number; height: number }): TextFitReport {
  return {
    slot,
    fontSizePx: block.fontSize,
    lines: block.lines.length,
    widthPx: block.width,
    heightPx: block.height,
    boxWidthPx: box.width,
    boxHeightPx: box.height,
    truncated: block.truncated,
  };
}

/* -------------------------------------------------------------------------- */
/* Composite elements                                                          */
/* -------------------------------------------------------------------------- */

export interface CtaPillOptions {
  label: string;
  /** Left edge, or centre when `anchor` is `middle`. */
  x: number;
  y: number;
  maxWidth: number;
  height: number;
  fill: string;
  textColor: string;
  fontStack: string;
  /** `start` places the left edge at `x`, `middle` the centre, `end` the right edge. */
  anchor?: TextAnchor;
}

export interface CtaPillResult {
  svg: string;
  bounds: Rect;
  fit: TextFitReport;
}

/** A solid CTA button sized to its label, never wider than `maxWidth`. */
export function ctaPill(options: CtaPillOptions): CtaPillResult {
  const paddingX = options.height * 0.55;
  const innerBox = { width: options.maxWidth - paddingX * 2, height: options.height * 0.62 };
  const block = fitSingleLine(options.label, innerBox, {
    weight: 'bold',
    maxFontSize: Math.round(options.height * 0.42),
    minFontSize: Math.max(12, Math.round(options.height * 0.24)),
    lineHeight: 1,
    letterSpacingEm: 0.01,
    uppercase: false,
  });
  const labelWidth = block.width;
  const width = Math.min(options.maxWidth, labelWidth + paddingX * 2);
  const anchor = options.anchor ?? 'start';
  const left = anchor === 'middle' ? options.x - width / 2 : anchor === 'end' ? options.x - width : options.x;
  const bounds: Rect = { x: left, y: options.y, width, height: options.height };

  const baseline =
    options.y + options.height / 2 + lineBoxMetrics(block.fontSize, 1, 'bold').ascentPx * 0.38;
  const svg = [
    rect({ ...bounds, fill: options.fill, rx: options.height / 2 }),
    `<text font-family="${escapeXml(options.fontStack)}" font-size="${fmt(block.fontSize)}" font-weight="700" fill="${escapeXml(options.textColor)}" text-anchor="middle"${block.letterSpacing !== 0 ? ` letter-spacing="${fmt(block.letterSpacing)}"` : ''} x="${fmt(left + width / 2)}" y="${fmt(baseline)}">${escapeXml(block.lines[0] ?? options.label)}</text>`,
  ].join('');

  return { svg, bounds, fit: fitReport('cta', block, innerBox) };
}

export interface WordmarkOptions {
  text: string;
  x: number;
  y: number;
  maxWidth: number;
  fontSize: number;
  color: string;
  fontStack: string;
  anchor?: TextAnchor;
}

/**
 * The wordmark is drawn as letter-spaced type rather than as an image: the model
 * must never render a logo, and a text wordmark stays crisp at every ratio.
 */
export function wordmark(options: WordmarkOptions): { svg: string; bounds: Rect } {
  const block = fitSingleLine(options.text, { width: options.maxWidth, height: options.fontSize * 1.4 }, {
    weight: 'bold',
    maxFontSize: options.fontSize,
    minFontSize: Math.max(10, Math.round(options.fontSize * 0.6)),
    lineHeight: 1.1,
    letterSpacingEm: 0.14,
    uppercase: true,
  });
  return {
    svg: drawTextBlock({
      block,
      x: options.x,
      y: options.y,
      fill: options.color,
      fontStack: options.fontStack,
      anchor: options.anchor,
    }),
    bounds: textBlockBounds({ block, x: options.x, y: options.y, anchor: options.anchor }),
  };
}

/** Circular avatar slot with initials — used when no portrait is licensed. */
export function avatarSlot(options: {
  initials: string;
  cx: number;
  cy: number;
  radius: number;
  fill: string;
  textColor: string;
  fontStack: string;
}): string {
  const fontSize = Math.round(options.radius * 0.86);
  const width = measureLineWidth(options.initials, { weight: 'bold', fontSize });
  const scaled = width > options.radius * 1.4 ? Math.round((fontSize * options.radius * 1.4) / width) : fontSize;
  const baseline = options.cy + (lineBoxMetrics(scaled, 1, 'bold').ascentPx - scaled * 0.5) * 0.9;
  return [
    circle(options.cx, options.cy, options.radius, options.fill),
    `<text font-family="${escapeXml(options.fontStack)}" font-size="${fmt(scaled)}" font-weight="700" fill="${escapeXml(options.textColor)}" text-anchor="middle" x="${fmt(options.cx)}" y="${fmt(baseline)}">${escapeXml(options.initials)}</text>`,
  ].join('');
}

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Auto-fit tuned for headlines: bold, tight leading, generous size range. */
export function fitHeadline(
  text: string,
  box: { width: number; height: number },
  overrides: Partial<AutoFitOptions> = {},
): TextBlock {
  return autoFitText(text, box, {
    weight: 'bold',
    maxFontSize: Math.round(box.width * 0.16),
    minFontSize: 26,
    lineHeight: 1.08,
    letterSpacingEm: -0.015,
    ...overrides,
  });
}

/** Auto-fit tuned for supporting copy. */
export function fitBody(
  text: string,
  box: { width: number; height: number },
  overrides: Partial<AutoFitOptions> = {},
): TextBlock {
  return autoFitText(text, box, {
    weight: 'regular',
    maxFontSize: Math.round(box.width * 0.062),
    minFontSize: 18,
    lineHeight: 1.32,
    ...overrides,
  });
}

/** Auto-fit tuned for small uppercase labels (kickers, column headers). */
export function fitLabel(
  text: string,
  box: { width: number; height: number },
  overrides: Partial<AutoFitOptions> = {},
): TextBlock {
  return autoFitText(text, box, {
    weight: 'bold',
    maxFontSize: Math.round(box.height * 0.72),
    minFontSize: 13,
    lineHeight: 1.1,
    letterSpacingEm: 0.1,
    uppercase: true,
    maxLines: 1,
    ...overrides,
  });
}

/** Shorthand for the parts of the content object templates fall back on. */
export function contentOr(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export { autoFitText, fitSingleLine, measureLineWidth, lineBoxMetrics };
export type { TextBlock, AutoFitOptions };
export type { CreativeContent, BrandTokens };
