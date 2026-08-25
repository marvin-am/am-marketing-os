/**
 * `bold-statement` — full-bleed motif, heavy headline block bottom-left.
 *
 * The loudest of the five: nothing competes with the motif except one statement
 * set as large as it will go, anchored to a brand bar. Built for PROBLEM_PAIN
 * and CONTRARIAN_INSIGHT, where a single sentence has to land in a scrolling
 * feed before anything else is read.
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
  line,
  rect,
  scrimBand,
  svgDocument,
  textBlockBounds,
  wordmark,
  type CreativeTemplate,
  type TemplateContrastPlan,
  type TemplateInput,
  type TemplateLayout,
} from './shared';

const SCRIM_ID = 'am-bold-scrim';

function textArea(canvas: CanvasGeometry): Rect {
  const { safe } = canvas;
  // The statement lives in the lower half; the motif keeps the upper half.
  const top = safe.y + safe.height * 0.36;
  return { x: safe.x, y: top, width: safe.width, height: safe.y + safe.height - top };
}

function plan(canvas: CanvasGeometry, tokens: BrandTokens): TemplateContrastPlan {
  return {
    sampleRect: textArea(canvas),
    textColor: tokens.background,
    scrimColor: tokens.accent,
    baseOpacity: 0.5,
    // Headline, subline and wordmark are all ≥ 24px bold on a 1080px canvas.
    largeText: true,
    opaqueBackdrop: null,
  };
}

function layout(input: TemplateInput): TemplateLayout {
  const { canvas, tokens, content, scrim } = input;
  const { safe, unit } = canvas;
  const fits: TextFitReport[] = [];
  const bounds: Rect[] = [];

  const barWidth = Math.round(unit * 0.85);
  const barGap = Math.round(unit * 1.4);
  const textX = safe.x + barWidth + barGap;
  const textWidth = safe.width - barWidth - barGap;

  /* Bottom row: wordmark on the left, CTA on the right. */
  const ctaHeight = Math.round(unit * 3.9);
  const rowTop = safe.y + safe.height - ctaHeight;
  const cta = ctaPill({
    label: content.callToAction,
    x: safe.x + safe.width,
    y: rowTop,
    maxWidth: safe.width * 0.55,
    height: ctaHeight,
    fill: tokens.primary,
    textColor: tokens.onPrimary,
    fontStack: tokens.fontStack,
    anchor: 'end',
  });
  fits.push(cta.fit);
  bounds.push(cta.bounds);

  const mark = wordmark({
    text: contentOr(tokens.wordmark, ''),
    x: textX,
    y: rowTop + ctaHeight * 0.28,
    maxWidth: Math.max(unit * 4, safe.width - cta.bounds.width - unit * 2),
    fontSize: Math.round(unit * 1.7),
    color: input.overlayTextColor,
    fontStack: tokens.fontStack,
  });
  if (mark.bounds.width > 0) bounds.push(mark.bounds);

  const ruleY = rowTop - unit * 1.6;
  const contentBottom = ruleY - unit * 1.7;

  /* Text stack, laid out from the bottom up. */
  const sublineText = contentOr(content.subline, '');
  const sublineBox = { width: textWidth, height: unit * 6.4 };
  const sublineBlock = sublineText.length > 0 ? fitBody(sublineText, sublineBox, { maxLines: 3 }) : null;
  if (sublineBlock) fits.push(fitReport('subline', sublineBlock, sublineBox));

  const sublineTop = contentBottom - (sublineBlock?.height ?? 0);
  const headlineBottom = sublineBlock ? sublineTop - unit * 1.3 : contentBottom;

  const kickerText = contentOr(content.kicker, '');
  const kickerBox = { width: textWidth, height: unit * 2.1 };
  const kickerBlock = kickerText.length > 0 ? fitLabel(kickerText, kickerBox) : null;
  if (kickerBlock) fits.push(fitReport('kicker', kickerBlock, kickerBox));

  const headlineTopLimit = safe.y + (kickerBlock ? kickerBlock.height + unit * 1.2 : 0);
  const headlineBox = {
    width: textWidth,
    height: Math.max(unit * 6, headlineBottom - headlineTopLimit),
  };
  const headlineBlock = fitHeadline(content.headline, headlineBox, {
    maxFontSize: Math.round(canvas.width * 0.115),
    minFontSize: 30,
  });
  fits.push(fitReport('headline', headlineBlock, headlineBox));

  const headlineTop = headlineBottom - headlineBlock.height;
  const kickerTop = headlineTop - (kickerBlock ? kickerBlock.height + unit * 1.1 : 0);

  bounds.push(textBlockBounds({ block: headlineBlock, x: textX, y: headlineTop }));
  if (kickerBlock) bounds.push(textBlockBounds({ block: kickerBlock, x: textX, y: kickerTop }));
  if (sublineBlock) bounds.push(textBlockBounds({ block: sublineBlock, x: textX, y: sublineTop }));

  /* Scrim covering everything from the kicker down. */
  const scrimTop = Math.max(0, Math.min(kickerTop, headlineTop) - unit * 1.5);
  const band = scrimBand(
    SCRIM_ID,
    { x: 0, y: scrimTop, width: canvas.width, height: canvas.height - scrimTop },
    // Never clip the ramp: a fade that starts off-canvas would already be
    // half-opaque at the top edge and would flatten the whole motif.
    Math.min(canvas.height * 0.26, scrimTop),
    scrim.color,
    scrim.opacity,
  );

  const barTop = Math.min(kickerTop, headlineTop);
  const barBottom = sublineBlock ? sublineTop + sublineBlock.height : headlineBottom;

  const body = [
    band.body,
    rect({
      x: safe.x,
      y: barTop,
      width: barWidth,
      height: Math.max(unit, barBottom - barTop),
      fill: tokens.primary,
    }),
    kickerBlock
      ? drawTextBlock({
          block: kickerBlock,
          x: textX,
          y: kickerTop,
          fill: tokens.primary,
          fontStack: tokens.fontStack,
        })
      : '',
    drawTextBlock({
      block: headlineBlock,
      x: textX,
      y: headlineTop,
      fill: input.overlayTextColor,
      fontStack: tokens.fontStack,
    }),
    sublineBlock
      ? drawTextBlock({
          block: sublineBlock,
          x: textX,
          y: sublineTop,
          fill: input.overlayTextColor,
          fontStack: tokens.fontStack,
          opacity: 0.92,
        })
      : '',
    line(safe.x, ruleY, safe.x + safe.width, ruleY, input.overlayTextColor, 2, 0.35),
    mark.svg,
    cta.svg,
  ]
    .filter((part) => part.length > 0)
    .join('');

  return { svg: svgDocument(canvas, body, band.defs), fits, bounds };
}

export const boldStatementTemplate: CreativeTemplate = {
  id: 'bold-statement',
  labelDe: 'Statement (vollflächig)',
  plan,
  layout,
  render: (input) => layout(input).svg,
};

/** Pure `(input) => SVGString`. */
export function renderBoldStatement(input: TemplateInput): string {
  return layout(input).svg;
}
