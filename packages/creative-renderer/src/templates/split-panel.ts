/**
 * `split-panel` — motif on one side, solid brand panel on the other.
 *
 * The motif never carries type here: the headline, subline and CTA sit on an
 * opaque brand field, which makes legibility a property of the palette rather
 * than of whatever the image model happened to generate. Built for
 * CONCRETE_RESULT and OBJECTION_HANDLING, where the words do the work.
 *
 * The split axis follows the canvas: side-by-side at 1:1, stacked at 4:5 and
 * 9:16, where a vertical split would leave two unreadably narrow columns.
 */

import { type CanvasGeometry, type Rect } from '../geometry';
import type { BrandTokens, TextFitReport } from '../types';
import {
  contentOr,
  ctaPill,
  drawTextBlock,
  fitBody,
  fitHeadline,
  fitLabel,
  fitReport,
  rect,
  svgDocument,
  textBlockBounds,
  wordmark,
  type CreativeTemplate,
  type TemplateContrastPlan,
  type TemplateInput,
  type TemplateLayout,
} from './shared';

/** Fraction of the canvas the solid panel occupies, per ratio. */
const PANEL_FRACTION: Readonly<Record<string, number>> = {
  '1:1': 0.48,
  '4:5': 0.46,
  '9:16': 0.5,
};

interface Split {
  axis: 'vertical' | 'horizontal';
  panel: Rect;
  accentBar: Rect;
}

function splitFor(canvas: CanvasGeometry): Split {
  const fraction = PANEL_FRACTION[canvas.ratio] ?? 0.48;
  const barThickness = Math.max(6, Math.round(canvas.unit * 0.6));
  if (canvas.ratio === '1:1') {
    const panelWidth = Math.round(canvas.width * fraction);
    const panelX = canvas.width - panelWidth;
    return {
      axis: 'vertical',
      panel: { x: panelX, y: 0, width: panelWidth, height: canvas.height },
      accentBar: { x: panelX - barThickness, y: 0, width: barThickness, height: canvas.height },
    };
  }
  const panelHeight = Math.round(canvas.height * fraction);
  const panelY = canvas.height - panelHeight;
  return {
    axis: 'horizontal',
    panel: { x: 0, y: panelY, width: canvas.width, height: panelHeight },
    accentBar: { x: 0, y: panelY - barThickness, width: canvas.width, height: barThickness },
  };
}

/** Panel area intersected with the safe rectangle, plus internal padding. */
function panelContentBox(canvas: CanvasGeometry, split: Split): Rect {
  const { safe, unit } = canvas;
  const left = Math.max(split.panel.x, safe.x);
  const top = Math.max(split.panel.y, safe.y);
  const right = Math.min(split.panel.x + split.panel.width, safe.x + safe.width);
  const bottom = Math.min(split.panel.y + split.panel.height, safe.y + safe.height);
  const padding = split.axis === 'vertical' ? unit * 0.6 : unit * 0.4;
  return {
    x: left + padding,
    y: top + padding,
    width: Math.max(unit * 4, right - left - padding * 2),
    height: Math.max(unit * 6, bottom - top - padding * 2),
  };
}

function plan(canvas: CanvasGeometry, tokens: BrandTokens): TemplateContrastPlan {
  const split = splitFor(canvas);
  return {
    sampleRect: split.panel,
    textColor: tokens.onPrimary,
    scrimColor: tokens.accent,
    baseOpacity: 0,
    largeText: false,
    // All copy sits on the opaque brand field.
    opaqueBackdrop: tokens.primary,
  };
}

function layout(input: TemplateInput): TemplateLayout {
  const { canvas, tokens, content } = input;
  const { unit } = canvas;
  const split = splitFor(canvas);
  const box = panelContentBox(canvas, split);
  const fits: TextFitReport[] = [];
  const bounds: Rect[] = [];

  const textColor = input.overlayTextColor;

  /* Wordmark pinned to the top of the panel. */
  const mark = wordmark({
    text: contentOr(tokens.wordmark, ''),
    x: box.x,
    y: box.y,
    maxWidth: box.width,
    fontSize: Math.round(unit * 1.6),
    color: textColor,
    fontStack: tokens.fontStack,
  });
  if (mark.bounds.width > 0) bounds.push(mark.bounds);
  const afterMark = mark.bounds.height > 0 ? mark.bounds.height + unit * 1.6 : 0;

  /* CTA anchored to the bottom of the panel. */
  const ctaHeight = Math.round(unit * 3.9);
  const ctaTop = box.y + box.height - ctaHeight;
  const cta = ctaPill({
    label: content.callToAction,
    x: box.x,
    y: ctaTop,
    maxWidth: box.width,
    height: ctaHeight,
    fill: tokens.background,
    textColor: tokens.primary,
    fontStack: tokens.fontStack,
  });
  fits.push(cta.fit);
  bounds.push(cta.bounds);

  const stackTop = box.y + afterMark;
  const stackBottom = ctaTop - unit * 2;

  const kickerText = contentOr(content.kicker, '');
  const kickerBox = { width: box.width, height: unit * 2 };
  const kickerBlock = kickerText.length > 0 ? fitLabel(kickerText, kickerBox) : null;
  if (kickerBlock) fits.push(fitReport('kicker', kickerBlock, kickerBox));
  const kickerTop = stackTop;
  const afterKicker = kickerBlock ? kickerBlock.height + unit * 1.2 : 0;

  const sublineText = contentOr(content.subline, '');
  const sublineBox = { width: box.width, height: unit * 7 };
  const sublineBlock = sublineText.length > 0 ? fitBody(sublineText, sublineBox, { maxLines: 4 }) : null;
  if (sublineBlock) fits.push(fitReport('subline', sublineBlock, sublineBox));
  const sublineHeight = sublineBlock ? sublineBlock.height + unit * 1.4 : 0;

  const headlineBox = {
    width: box.width,
    height: Math.max(unit * 5, stackBottom - stackTop - afterKicker - sublineHeight),
  };
  const headlineBlock = fitHeadline(content.headline, headlineBox, {
    maxFontSize: Math.round(box.width * 0.155),
    minFontSize: 26,
  });
  fits.push(fitReport('headline', headlineBlock, headlineBox));

  const headlineTop = kickerTop + afterKicker;
  const sublineTop = headlineTop + headlineBlock.height + unit * 1.4;

  if (kickerBlock) bounds.push(textBlockBounds({ block: kickerBlock, x: box.x, y: kickerTop }));
  bounds.push(textBlockBounds({ block: headlineBlock, x: box.x, y: headlineTop }));
  if (sublineBlock) bounds.push(textBlockBounds({ block: sublineBlock, x: box.x, y: sublineTop }));

  const body = [
    rect({ ...split.accentBar, fill: tokens.accent }),
    rect({ ...split.panel, fill: tokens.primary }),
    mark.svg,
    kickerBlock
      ? drawTextBlock({
          block: kickerBlock,
          x: box.x,
          y: kickerTop,
          fill: textColor,
          fontStack: tokens.fontStack,
          opacity: 0.85,
        })
      : '',
    drawTextBlock({
      block: headlineBlock,
      x: box.x,
      y: headlineTop,
      fill: textColor,
      fontStack: tokens.fontStack,
    }),
    sublineBlock
      ? drawTextBlock({
          block: sublineBlock,
          x: box.x,
          y: sublineTop,
          fill: textColor,
          fontStack: tokens.fontStack,
          opacity: 0.94,
        })
      : '',
    cta.svg,
  ]
    .filter((part) => part.length > 0)
    .join('');

  return { svg: svgDocument(canvas, body), fits, bounds };
}

export const splitPanelTemplate: CreativeTemplate = {
  id: 'split-panel',
  labelDe: 'Split-Panel (Motiv + Farbfläche)',
  plan,
  layout,
  render: (input) => layout(input).svg,
};

/** Pure `(input) => SVGString`. */
export function renderSplitPanel(input: TemplateInput): string {
  return layout(input).svg;
}
