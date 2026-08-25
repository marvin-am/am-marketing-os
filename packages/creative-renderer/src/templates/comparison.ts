/**
 * `comparison` — two columns over the motif: without/with, before/after, us/them.
 *
 * The layout for COMPARISON_ALTERNATIVE. The two columns are opaque fields — a
 * neutral one on the left, the brand field on the right — so the item lists are
 * legible regardless of the motif; only the headline above them sits on the
 * scrim and is checked against it.
 *
 * Both columns stay side by side at every ratio. Stacking them at 9:16 would
 * turn a comparison into a list, which is a different argument.
 */

import { type CanvasGeometry, type Rect } from '../geometry';
import { bestContrastColor, mix, svgColor } from '../color';
import type { BrandTokens, TextFitReport } from '../types';
import {
  autoFitText,
  checkMark,
  contentOr,
  crossMark,
  ctaPill,
  drawTextBlock,
  fitHeadline,
  fitLabel,
  fitReport,
  rect,
  scrimBand,
  svgDocument,
  textBlockBounds,
  type CreativeTemplate,
  type TemplateContrastPlan,
  type TemplateInput,
  type TemplateLayout,
} from './shared';

const SCRIM_ID = 'am-compare-scrim';

/** Vertical share of the safe area taken by the headline block. */
const HEADLINE_FRACTION: Readonly<Record<string, number>> = {
  '1:1': 0.24,
  '4:5': 0.24,
  '9:16': 0.2,
};

function headlineBoxFor(canvas: CanvasGeometry): Rect {
  const { safe } = canvas;
  return {
    x: safe.x,
    y: safe.y,
    width: safe.width,
    height: safe.height * (HEADLINE_FRACTION[canvas.ratio] ?? 0.24),
  };
}

function plan(canvas: CanvasGeometry, tokens: BrandTokens): TemplateContrastPlan {
  const headline = headlineBoxFor(canvas);
  return {
    sampleRect: { x: 0, y: 0, width: canvas.width, height: headline.y + headline.height },
    textColor: tokens.background,
    scrimColor: tokens.accent,
    baseOpacity: 0.5,
    largeText: true,
    opaqueBackdrop: null,
  };
}

interface ColumnRender {
  svg: string;
  fits: TextFitReport[];
  bounds: Rect[];
}

function renderColumn(options: {
  area: Rect;
  label: string;
  items: readonly string[];
  fill: string;
  textColor: string;
  markerColor: string;
  positive: boolean;
  unit: number;
  fontStack: string;
  radius: number;
}): ColumnRender {
  const { area, unit } = options;
  const padding = unit * 1.5;
  const inner: Rect = {
    x: area.x + padding,
    y: area.y + padding,
    width: area.width - padding * 2,
    height: area.height - padding * 2,
  };
  const fits: TextFitReport[] = [];
  const bounds: Rect[] = [];

  const labelBox = { width: inner.width, height: unit * 1.9 };
  const labelBlock = fitLabel(options.label, labelBox, { maxFontSize: Math.round(unit * 1.55) });
  fits.push(fitReport(`column-label-${options.positive ? 'right' : 'left'}`, labelBlock, labelBox));
  bounds.push(textBlockBounds({ block: labelBlock, x: inner.x, y: inner.y }));

  const listTop = inner.y + labelBlock.height + unit * 1.4;
  const listHeight = Math.max(unit * 4, inner.y + inner.height - listTop);
  const count = Math.max(1, options.items.length);
  const itemGap = unit * 1.4;
  const maxItemHeight = Math.max(unit * 2, (listHeight - itemGap * (count - 1)) / count);
  const markerSize = Math.min(unit * 1.7, maxItemHeight * 0.6);
  const textX = inner.x + markerSize + unit * 0.9;
  const textWidth = Math.max(unit * 3, inner.width - markerSize - unit * 0.9);

  // Items are measured first, then centred as a group. Distributing them across
  // the full column would read as two unrelated statements rather than a list.
  const box = { width: textWidth, height: maxItemHeight };
  const blocks = options.items.map((item) =>
    autoFitText(item, box, {
      weight: 'regular',
      maxFontSize: Math.round(unit * 1.55),
      minFontSize: 14,
      lineHeight: 1.22,
      maxLines: 4,
    }),
  );
  const stackHeight =
    blocks.reduce((sum, block) => sum + block.height, 0) + itemGap * Math.max(0, count - 1);
  let cursor = listTop + Math.max(0, (listHeight - stackHeight) / 2);

  const rows = blocks.map((block, index) => {
    fits.push(fitReport(`column-item-${options.positive ? 'right' : 'left'}-${index}`, block, box));
    const top = cursor;
    cursor += block.height + itemGap;
    bounds.push(textBlockBounds({ block, x: textX, y: top }));
    const markerCy = top + block.firstBaseline - block.fontSize * 0.28;
    const marker = options.positive
      ? checkMark(inner.x + markerSize / 2, markerCy, markerSize, options.markerColor)
      : crossMark(inner.x + markerSize / 2, markerCy, markerSize, options.markerColor);
    return [
      marker,
      drawTextBlock({
        block,
        x: textX,
        y: top,
        fill: options.textColor,
        fontStack: options.fontStack,
      }),
    ].join('');
  });

  const svg = [
    rect({ ...area, fill: options.fill, rx: options.radius }),
    drawTextBlock({
      block: labelBlock,
      x: inner.x,
      y: inner.y,
      fill: options.textColor,
      fontStack: options.fontStack,
      opacity: 0.9,
    }),
    ...rows,
  ].join('');

  return { svg, fits, bounds };
}

function layout(input: TemplateInput): TemplateLayout {
  const { canvas, tokens, content, scrim } = input;
  const { safe, unit } = canvas;
  const fits: TextFitReport[] = [];
  const bounds: Rect[] = [];

  const headlineArea = headlineBoxFor(canvas);
  const headlineBlock = fitHeadline(content.headline, headlineArea, {
    maxFontSize: Math.round(canvas.width * 0.082),
    minFontSize: 24,
    maxLines: 3,
  });
  fits.push(fitReport('headline', headlineBlock, headlineArea));
  bounds.push(textBlockBounds({ block: headlineBlock, x: safe.x, y: headlineArea.y }));

  const ctaHeight = Math.round(unit * 3.9);
  const ctaTop = safe.y + safe.height - ctaHeight;
  const cta = ctaPill({
    label: content.callToAction,
    x: safe.x + safe.width / 2,
    y: ctaTop,
    maxWidth: safe.width * 0.86,
    height: ctaHeight,
    fill: tokens.primary,
    textColor: tokens.onPrimary,
    fontStack: tokens.fontStack,
    anchor: 'middle',
  });
  fits.push(cta.fit);
  bounds.push(cta.bounds);

  const columnsTop = headlineArea.y + headlineArea.height + unit * 1.4;
  const columnsBottom = ctaTop - unit * 2.2;
  const gap = unit * 1.3;
  const columnWidth = (safe.width - gap) / 2;
  const columnHeight = Math.max(unit * 8, columnsBottom - columnsTop);
  const radius = unit * 0.7;

  const pair = content.comparison ?? {
    left: { label: 'Ohne', items: [contentOr(content.subline, content.headline)] },
    right: { label: 'Mit', items: [contentOr(content.statCaption, content.callToAction)] },
  };

  // The "without" column is a neutral field derived from the brand pair, so it
  // reads as the muted alternative whatever the palette is.
  const negativeFill = svgColor(mix(tokens.foreground, tokens.background, 0.14));
  const negativeText = bestContrastColor(negativeFill, [
    tokens.background,
    tokens.foreground,
    '#FFFFFF',
    '#000000',
  ]).color;

  const left = renderColumn({
    area: { x: safe.x, y: columnsTop, width: columnWidth, height: columnHeight },
    label: pair.left.label,
    items: pair.left.items,
    fill: negativeFill,
    textColor: negativeText,
    markerColor: negativeText,
    positive: false,
    unit,
    fontStack: tokens.fontStack,
    radius,
  });
  const right = renderColumn({
    area: { x: safe.x + columnWidth + gap, y: columnsTop, width: columnWidth, height: columnHeight },
    label: pair.right.label,
    items: pair.right.items,
    fill: tokens.primary,
    textColor: tokens.onPrimary,
    markerColor: tokens.onPrimary,
    positive: true,
    unit,
    fontStack: tokens.fontStack,
    radius,
  });
  fits.push(...left.fits, ...right.fits);
  bounds.push(...left.bounds, ...right.bounds);

  const band = scrimBand(
    SCRIM_ID,
    { x: 0, y: 0, width: canvas.width, height: columnsTop },
    0,
    scrim.color,
    scrim.opacity,
  );
  const lowerScrim = rect({
    x: 0,
    y: columnsTop,
    width: canvas.width,
    height: canvas.height - columnsTop,
    fill: scrim.color,
    opacity: Math.min(scrim.opacity, 0.45),
  });

  const body = [
    band.body,
    lowerScrim,
    drawTextBlock({
      block: headlineBlock,
      x: safe.x,
      y: headlineArea.y,
      fill: input.overlayTextColor,
      fontStack: tokens.fontStack,
    }),
    left.svg,
    right.svg,
    cta.svg,
  ]
    .filter((part) => part.length > 0)
    .join('');

  return { svg: svgDocument(canvas, body, band.defs), fits, bounds };
}

export const comparisonTemplate: CreativeTemplate = {
  id: 'comparison',
  labelDe: 'Vergleich (zwei Spalten)',
  plan,
  layout,
  render: (input) => layout(input).svg,
};

/** Pure `(input) => SVGString`. */
export function renderComparison(input: TemplateInput): string {
  return layout(input).svg;
}
