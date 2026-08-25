/**
 * `quote-proof` — motif with a floating quote card, attribution and avatar slot.
 *
 * The card is opaque on purpose. A testimonial is the one place where a
 * half-legible line does real damage — it reads as a stock phrase rather than as
 * a named customer saying a specific thing — so the quote sits on the brand
 * background field with a guaranteed contrast ratio, and the motif provides
 * atmosphere behind it.
 *
 * The avatar is an initials disc, never a generated face: the model must not
 * invent a person who did not say this.
 */

import { type CanvasGeometry, type Rect } from '../geometry';
import type { BrandTokens, TextFitReport } from '../types';
import {
  avatarSlot,
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
  type CreativeTemplate,
  type TemplateContrastPlan,
  type TemplateInput,
  type TemplateLayout,
} from './shared';

/** Where the card sits vertically, as a fraction of the safe height. */
const CARD_TOP_FRACTION: Readonly<Record<string, number>> = {
  '1:1': 0.2,
  '4:5': 0.24,
  '9:16': 0.16,
};

function cardRect(canvas: CanvasGeometry): Rect {
  const { safe, unit } = canvas;
  const inset = unit * 0.5;
  const top = safe.y + safe.height * (CARD_TOP_FRACTION[canvas.ratio] ?? 0.2);
  const ctaReserve = unit * 6.4;
  const height = Math.max(unit * 16, safe.y + safe.height - ctaReserve - top);
  return { x: safe.x + inset, y: top, width: safe.width - inset * 2, height };
}

function plan(canvas: CanvasGeometry, tokens: BrandTokens): TemplateContrastPlan {
  return {
    sampleRect: cardRect(canvas),
    textColor: tokens.foreground,
    scrimColor: tokens.accent,
    // A light scrim for mood only — the card carries the legibility.
    baseOpacity: 0.22,
    largeText: false,
    opaqueBackdrop: tokens.background,
  };
}

function initialsFor(name: string, fallback: string | null): string {
  const explicit = (fallback ?? '').trim();
  if (explicit.length > 0) return explicit.toUpperCase().slice(0, 3);
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return '–';
  const letters = parts.slice(0, 2).map((part) => [...part][0] ?? '');
  return letters.join('').toUpperCase();
}

function layout(input: TemplateInput): TemplateLayout {
  const { canvas, tokens, content, scrim } = input;
  const { safe, unit } = canvas;
  const fits: TextFitReport[] = [];
  const bounds: Rect[] = [];

  const card = cardRect(canvas);
  const padding = unit * 2.2;
  const inner: Rect = {
    x: card.x + padding,
    y: card.y + padding,
    width: card.width - padding * 2,
    height: card.height - padding * 2,
  };
  const cardTextColor = input.overlayTextColor;

  /* Opening quotation mark, drawn as type in the brand primary. */
  const markSize = Math.round(unit * 8);
  const quoteGlyph = fitSingleLine('„', { width: inner.width, height: markSize * 1.6 }, {
    weight: 'bold',
    maxFontSize: markSize,
    minFontSize: Math.round(markSize * 0.6),
    lineHeight: 1,
  });
  // The German opening quote sits on the baseline, so only a fraction of its em
  // box is ink — reserve that, not the whole line height.
  const glyphHeight = markSize * 0.34;

  /* Attribution row pinned to the bottom of the card. */
  const avatarRadius = Math.round(unit * 2.1);
  const attributionName = contentOr(content.attributionName, contentOr(tokens.wordmark, 'A&M'));
  const attributionRole = contentOr(content.attributionRole, '');
  const rowHeight = avatarRadius * 2;
  const rowTop = inner.y + inner.height - rowHeight;
  const dividerY = rowTop - unit * 1.8;

  const nameBox = { width: inner.width - avatarRadius * 2 - unit * 1.6, height: unit * 2.1 };
  const nameBlock = fitSingleLine(attributionName, nameBox, {
    weight: 'bold',
    maxFontSize: Math.round(unit * 1.7),
    minFontSize: 15,
    lineHeight: 1.15,
  });
  fits.push(fitReport('attribution-name', nameBlock, nameBox));

  const roleBlock =
    attributionRole.length > 0
      ? fitSingleLine(attributionRole, nameBox, {
          weight: 'regular',
          maxFontSize: Math.round(unit * 1.45),
          minFontSize: 14,
          lineHeight: 1.15,
        })
      : null;
  if (roleBlock) fits.push(fitReport('attribution-role', roleBlock, nameBox));

  const textX = inner.x + avatarRadius * 2 + unit * 1.6;
  const attributionHeight = nameBlock.height + (roleBlock ? roleBlock.height + unit * 0.3 : 0);
  const attributionTop = rowTop + Math.max(0, (rowHeight - attributionHeight) / 2);

  bounds.push(textBlockBounds({ block: nameBlock, x: textX, y: attributionTop }));
  if (roleBlock) {
    bounds.push(
      textBlockBounds({ block: roleBlock, x: textX, y: attributionTop + nameBlock.height + unit * 0.3 }),
    );
  }

  /* The quote itself fills what is left, optically centred in that space. */
  const quoteAreaTop = inner.y + glyphHeight + unit * 1.2;
  const quoteBox = {
    width: inner.width,
    height: Math.max(unit * 6, dividerY - unit * 1.8 - quoteAreaTop),
  };
  const quoteText = contentOr(content.quote, content.headline);
  const quoteBlock = fitBody(quoteText, quoteBox, {
    weight: 'bold',
    maxFontSize: Math.round(inner.width * 0.105),
    minFontSize: 22,
    lineHeight: 1.24,
    letterSpacingEm: -0.01,
  });
  fits.push(fitReport('quote', quoteBlock, quoteBox));
  const quoteTop = quoteAreaTop + Math.max(0, (quoteBox.height - quoteBlock.height) / 2);
  bounds.push(textBlockBounds({ block: quoteBlock, x: inner.x, y: quoteTop }));

  /* Small brand label in the card's top-right corner. */
  const labelBox = { width: inner.width * 0.4, height: unit * 1.6 };
  const labelText = contentOr(content.kicker, contentOr(tokens.wordmark, ''));
  const labelBlock = labelText.length > 0 ? fitLabel(labelText, labelBox) : null;
  if (labelBlock) {
    fits.push(fitReport('card-label', labelBlock, labelBox));
    bounds.push(
      textBlockBounds({
        block: labelBlock,
        x: inner.x + inner.width,
        y: inner.y,
        anchor: 'end',
      }),
    );
  }

  /* CTA below the card, self-contained on a solid pill. */
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

  const accentWidth = Math.max(6, Math.round(unit * 0.6));

  const body = [
    rect({ x: 0, y: 0, width: canvas.width, height: canvas.height, fill: scrim.color, opacity: scrim.opacity }),
    rect({ ...card, fill: tokens.background, rx: unit * 0.8 }),
    rect({ x: card.x, y: card.y, width: accentWidth, height: card.height, fill: tokens.primary }),
    drawTextBlock({
      block: quoteGlyph,
      x: inner.x,
      y: inner.y - markSize * 0.18,
      fill: tokens.primary,
      fontStack: tokens.fontStack,
    }),
    labelBlock
      ? drawTextBlock({
          block: labelBlock,
          x: inner.x + inner.width,
          y: inner.y,
          fill: tokens.muted,
          fontStack: tokens.fontStack,
          anchor: 'end',
        })
      : '',
    drawTextBlock({
      block: quoteBlock,
      x: inner.x,
      y: quoteTop,
      fill: cardTextColor,
      fontStack: tokens.fontStack,
    }),
    line(inner.x, dividerY, inner.x + inner.width, dividerY, tokens.muted, 2, 0.6),
    avatarSlot({
      initials: initialsFor(attributionName, content.attributionInitials),
      cx: inner.x + avatarRadius,
      cy: rowTop + avatarRadius,
      radius: avatarRadius,
      fill: tokens.primary,
      textColor: tokens.onPrimary,
      fontStack: tokens.fontStack,
    }),
    drawTextBlock({
      block: nameBlock,
      x: textX,
      y: attributionTop,
      fill: cardTextColor,
      fontStack: tokens.fontStack,
    }),
    roleBlock
      ? drawTextBlock({
          block: roleBlock,
          x: textX,
          y: attributionTop + nameBlock.height + unit * 0.3,
          fill: tokens.muted,
          fontStack: tokens.fontStack,
        })
      : '',
    cta.svg,
  ]
    .filter((part) => part.length > 0)
    .join('');

  return { svg: svgDocument(canvas, body), fits, bounds };
}

export const quoteProofTemplate: CreativeTemplate = {
  id: 'quote-proof',
  labelDe: 'Zitat / Kundenstimme',
  plan,
  layout,
  render: (input) => layout(input).svg,
};

/** Pure `(input) => SVGString`. */
export function renderQuoteProof(input: TemplateInput): string {
  return layout(input).svg;
}
