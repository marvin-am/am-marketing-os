/**
 * `data-point` — motif dimmed, one oversized figure, a caption and a source line.
 *
 * The layout that carries a PROOF_CASE_DATAPOINT: the number is the creative.
 * Because a statistic without a source is exactly the kind of unbacked claim the
 * system refuses to publish, the source line is a first-class slot rather than
 * fine print — and it is small, regular-weight text, which is why this template
 * asks the contrast solver for the strict AA threshold.
 */

import { type CanvasGeometry, type Rect } from '../geometry';
import type { BrandTokens, TextFitReport } from '../types';
import {
  contentOr,
  ctaPill,
  drawTextBlock,
  fitBody,
  fitLabel,
  fitReport,
  fitSingleLine,
  line,
  rect,
  svgDocument,
  textBlockBounds,
  wordmark,
  type CreativeTemplate,
  type TemplateContrastPlan,
  type TemplateInput,
  type TemplateLayout,
} from './shared';

function plan(canvas: CanvasGeometry, tokens: BrandTokens): TemplateContrastPlan {
  return {
    // A flat scrim covers the whole canvas, so the whole canvas is sampled.
    sampleRect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    textColor: tokens.background,
    scrimColor: tokens.accent,
    baseOpacity: 0.55,
    // The source line is small regular type: hold the 4.5:1 threshold.
    largeText: false,
    opaqueBackdrop: null,
  };
}

function layout(input: TemplateInput): TemplateLayout {
  const { canvas, tokens, content, scrim } = input;
  const { safe, unit } = canvas;
  const fits: TextFitReport[] = [];
  const bounds: Rect[] = [];
  const centerX = safe.x + safe.width / 2;
  const textColor = input.overlayTextColor;

  /* Bottom-anchored furniture first. */
  const sourceText = contentOr(content.sourceLine, '');
  const sourceBox = { width: safe.width, height: unit * 2.6 };
  const sourceBlock =
    sourceText.length > 0
      ? fitBody(sourceText, sourceBox, {
          maxFontSize: Math.round(unit * 1.25),
          minFontSize: 15,
          maxLines: 2,
          lineHeight: 1.25,
        })
      : null;
  if (sourceBlock) fits.push(fitReport('source', sourceBlock, sourceBox));

  const sourceTop = safe.y + safe.height - (sourceBlock?.height ?? 0);
  const ctaHeight = Math.round(unit * 3.9);
  const ctaTop = sourceTop - (sourceBlock ? unit * 1.6 : 0) - ctaHeight;
  const cta = ctaPill({
    label: content.callToAction,
    x: centerX,
    y: ctaTop,
    maxWidth: safe.width * 0.8,
    height: ctaHeight,
    fill: tokens.primary,
    textColor: tokens.onPrimary,
    fontStack: tokens.fontStack,
    anchor: 'middle',
  });
  fits.push(cta.fit);
  bounds.push(cta.bounds);
  if (sourceBlock) {
    bounds.push(textBlockBounds({ block: sourceBlock, x: centerX, y: sourceTop, anchor: 'middle' }));
  }

  /* Top-anchored wordmark. */
  const mark = wordmark({
    text: contentOr(tokens.wordmark, ''),
    x: centerX,
    y: safe.y,
    maxWidth: safe.width,
    fontSize: Math.round(unit * 1.6),
    color: textColor,
    fontStack: tokens.fontStack,
    anchor: 'middle',
  });
  if (mark.bounds.width > 0) bounds.push(mark.bounds);

  /* Centre block: kicker, figure, rule, caption. */
  const blockTop = safe.y + (mark.bounds.height > 0 ? mark.bounds.height + unit * 2.4 : 0);
  const blockBottom = ctaTop - unit * 2.4;
  const available = Math.max(unit * 10, blockBottom - blockTop);

  const kickerText = contentOr(content.kicker, '');
  const kickerBox = { width: safe.width, height: unit * 2 };
  const kickerBlock = kickerText.length > 0 ? fitLabel(kickerText, kickerBox) : null;
  if (kickerBlock) fits.push(fitReport('kicker', kickerBlock, kickerBox));

  const captionText = contentOr(content.statCaption, content.headline);
  const captionBox = { width: safe.width * 0.94, height: available * 0.34 };
  const captionBlock = fitBody(captionText, captionBox, {
    weight: 'bold',
    maxFontSize: Math.round(canvas.width * 0.058),
    minFontSize: 22,
    maxLines: 3,
    lineHeight: 1.2,
  });
  fits.push(fitReport('caption', captionBlock, captionBox));

  const figureText = contentOr(content.statValue, '—');
  const figureBox = {
    width: safe.width,
    height: Math.max(
      unit * 6,
      available - (kickerBlock ? kickerBlock.height + unit * 1.4 : 0) - captionBlock.height - unit * 4.4,
    ),
  };
  const figureBlock = fitSingleLine(figureText, figureBox, {
    weight: 'bold',
    maxFontSize: Math.round(canvas.height * 0.26),
    minFontSize: 60,
    lineHeight: 1,
    letterSpacingEm: -0.03,
  });
  fits.push(fitReport('figure', figureBlock, figureBox));

  const stackHeight =
    (kickerBlock ? kickerBlock.height + unit * 1.4 : 0) +
    figureBlock.height +
    unit * 2.2 +
    captionBlock.height;
  const stackTop = blockTop + Math.max(0, (available - stackHeight) / 2);

  const kickerTop = stackTop;
  const figureTop = kickerTop + (kickerBlock ? kickerBlock.height + unit * 1.4 : 0);
  const ruleY = figureTop + figureBlock.height + unit * 1.1;
  const captionTop = ruleY + unit * 1.1;

  if (kickerBlock) {
    bounds.push(textBlockBounds({ block: kickerBlock, x: centerX, y: kickerTop, anchor: 'middle' }));
  }
  bounds.push(textBlockBounds({ block: figureBlock, x: centerX, y: figureTop, anchor: 'middle' }));
  bounds.push(textBlockBounds({ block: captionBlock, x: centerX, y: captionTop, anchor: 'middle' }));

  const ruleWidth = Math.min(safe.width * 0.34, Math.max(unit * 6, figureBlock.width * 0.5));

  const body = [
    rect({ x: 0, y: 0, width: canvas.width, height: canvas.height, fill: scrim.color, opacity: scrim.opacity }),
    mark.svg,
    kickerBlock
      ? drawTextBlock({
          block: kickerBlock,
          x: centerX,
          y: kickerTop,
          fill: tokens.primary,
          fontStack: tokens.fontStack,
          anchor: 'middle',
        })
      : '',
    drawTextBlock({
      block: figureBlock,
      x: centerX,
      y: figureTop,
      fill: textColor,
      fontStack: tokens.fontStack,
      anchor: 'middle',
    }),
    line(centerX - ruleWidth / 2, ruleY, centerX + ruleWidth / 2, ruleY, tokens.primary, Math.max(4, unit * 0.4)),
    drawTextBlock({
      block: captionBlock,
      x: centerX,
      y: captionTop,
      fill: textColor,
      fontStack: tokens.fontStack,
      anchor: 'middle',
    }),
    cta.svg,
    sourceBlock
      ? drawTextBlock({
          block: sourceBlock,
          x: centerX,
          y: sourceTop,
          fill: textColor,
          fontStack: tokens.fontStack,
          anchor: 'middle',
          opacity: 0.88,
        })
      : '',
  ]
    .filter((part) => part.length > 0)
    .join('');

  return { svg: svgDocument(canvas, body), fits, bounds };
}

export const dataPointTemplate: CreativeTemplate = {
  id: 'data-point',
  labelDe: 'Kennzahl (Zahl im Fokus)',
  plan,
  layout,
  render: (input) => layout(input).svg,
};

/** Pure `(input) => SVGString`. */
export function renderDataPoint(input: TemplateInput): string {
  return layout(input).svg;
}
