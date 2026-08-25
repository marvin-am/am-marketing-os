/**
 * Deterministic derivation of template slots from a creative concept.
 *
 * A concept carries Meta copy plus a few narrative fields; a template needs a
 * kicker, a figure, a caption, a source line, a quote, a comparison pair. None
 * of that is asked of a model a second time — it is derived here with plain
 * string rules, so the same concept always produces the same creative, and an
 * operator editing the headline in the console sees exactly what will render.
 */

import type { CreativeConcept, CreativePrinciple, MetaCopy } from '@am/domain';
import { creativeContentSchema, type CreativeContent } from './types';
import { normalizeWhitespace } from './xml';

/** Eyebrow label per communication principle. */
export const PRINCIPLE_KICKERS_DE: Readonly<Record<CreativePrinciple, string>> = {
  PROBLEM_PAIN: 'Das Problem',
  CONCRETE_RESULT: 'Das Ergebnis',
  COMPARISON_ALTERNATIVE: 'Der Vergleich',
  PROOF_CASE_DATAPOINT: 'Der Beleg',
  OBJECTION_HANDLING: 'Der Einwand',
  CONTRARIAN_INSIGHT: 'Die These',
};

/** German column labels for the comparison layout, per principle. */
export const COMPARISON_LABELS_DE = {
  left: 'Ohne System',
  right: 'Mit System',
} as const;

/**
 * A number plus its unit, as it appears in German ad copy: `38 %`, `3,4×`,
 * `12.500 €`, `90 Sekunden`. Deliberately conservative — a false positive would
 * put a meaningless figure at 260px on the canvas.
 */
const FIGURE_PATTERN =
  /(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(%|×|x\b|€|EUR|Punkte|Tage|Stunden|Std\.|Minuten|Min\.|Sekunden|Sek\.)?/u;

export interface ExtractedFigure {
  /** The figure as it should be set, e.g. `38 %`. */
  value: string;
  /** What is left of the sentence once the figure is lifted out. */
  caption: string;
  source: 'headline' | 'description' | 'primaryText' | 'proof';
}

export function extractFigure(concept: {
  headline: string;
  description: string;
  primaryText: string;
  proofUsed?: string | null;
}): ExtractedFigure | null {
  const candidates: ReadonlyArray<[ExtractedFigure['source'], string]> = [
    ['headline', concept.headline],
    ['description', concept.description],
    ['proof', concept.proofUsed ?? ''],
    ['primaryText', concept.primaryText],
  ];
  for (const [source, text] of candidates) {
    const normalized = normalizeWhitespace(text);
    if (normalized.length === 0) continue;
    const match = FIGURE_PATTERN.exec(normalized);
    if (!match || match.index === undefined) continue;
    const [, number, unit] = match;
    if (!number) continue;
    const value = unit ? `${number} ${unit}`.replace(' ×', '×').replace(' x', '×') : number;
    if (value.length > 12) continue;
    const caption = normalizeWhitespace(
      `${normalized.slice(0, match.index)}${normalized.slice(match.index + match[0].length)}`,
    ).replace(/^[–—,;:.\s]+/u, '');
    return { value, caption, source };
  }
  return null;
}

/** First sentence of a paragraph, without the trailing punctuation. */
export function firstSentence(text: string, maxLength = 160): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return '';
  const match = /^(.+?[.!?])(\s|$)/u.exec(normalized);
  const sentence = match?.[1] ?? normalized;
  const trimmed = sentence.replace(/[.!?]+$/u, '').trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Shortens to a clause that fits a comparison bullet. */
function bullet(text: string, maxLength = 96): string {
  const normalized = firstSentence(text, maxLength);
  return normalized.length > 0 ? normalized : '';
}

export interface ContentDerivationOptions {
  /** Used for the `Mit <Marke>` comparison label and the default attribution. */
  brandName?: string;
  /** Explicit slot values always win over derivation. */
  overrides?: Partial<CreativeContent>;
}

/** Builds every template slot from Meta copy alone. */
export function contentFromCopy(
  copy: MetaCopy,
  principle: CreativePrinciple,
  options: ContentDerivationOptions = {},
): CreativeContent {
  const figure = extractFigure({
    headline: copy.headline,
    description: copy.description,
    primaryText: copy.primaryText,
  });
  const brandName = normalizeWhitespace(options.brandName ?? '');
  const derived: CreativeContent = creativeContentSchema.parse({
    headline: normalizeWhitespace(copy.headline),
    subline: normalizeWhitespace(copy.description) || null,
    callToAction: normalizeWhitespace(copy.callToAction),
    kicker: PRINCIPLE_KICKERS_DE[principle],
    statValue: figure?.value ?? null,
    statCaption: figure?.caption || normalizeWhitespace(copy.headline),
    sourceLine: null,
    quote: null,
    attributionName: brandName.length > 0 ? brandName : null,
    attributionRole: null,
    attributionInitials: null,
    comparison: {
      left: { label: COMPARISON_LABELS_DE.left, items: [bullet(copy.primaryText)] },
      right: {
        label: brandName.length > 0 ? `Mit ${brandName}` : COMPARISON_LABELS_DE.right,
        items: [bullet(copy.description)],
      },
    },
  });
  return applyOverrides(derived, options.overrides);
}

/** Builds every template slot from a full creative concept. */
export function contentFromConcept(
  concept: CreativeConcept,
  options: ContentDerivationOptions = {},
): CreativeContent {
  const base = contentFromCopy(concept.copy, concept.principle, {
    ...options,
    overrides: undefined,
  });
  const brandName = normalizeWhitespace(options.brandName ?? '');
  const figure = extractFigure({
    headline: concept.copy.headline,
    description: concept.copy.description,
    primaryText: concept.copy.primaryText,
    proofUsed: concept.proofUsed,
  });
  const proof = normalizeWhitespace(concept.proofUsed ?? '');

  const derived: CreativeContent = creativeContentSchema.parse({
    ...base,
    statValue: figure?.value ?? base.statValue,
    statCaption: figure?.caption || base.statCaption,
    sourceLine: proof.length > 0 ? `Quelle: ${firstSentence(proof, 120)}` : null,
    quote: proof.length > 0 ? firstSentence(proof, 220) : null,
    comparison: {
      left: {
        label: COMPARISON_LABELS_DE.left,
        items: [bullet(concept.copy.primaryText), bullet(concept.hypothesis)].filter(
          (item) => item.length > 0,
        ),
      },
      right: {
        label: brandName.length > 0 ? `Mit ${brandName}` : COMPARISON_LABELS_DE.right,
        items: [bullet(concept.funnelPromise), bullet(concept.copy.description)].filter(
          (item) => item.length > 0,
        ),
      },
    },
  });
  return applyOverrides(derived, options.overrides);
}

function applyOverrides(
  content: CreativeContent,
  overrides: Partial<CreativeContent> | undefined,
): CreativeContent {
  if (!overrides) return content;
  const merged: Record<string, unknown> = { ...content };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return creativeContentSchema.parse(merged);
}

/**
 * Slots a given template must have real content for. Used to warn rather than to
 * silently ship a creative whose central element is a fallback.
 */
export const REQUIRED_SLOTS: Readonly<Record<string, readonly (keyof CreativeContent)[]>> = {
  'bold-statement': ['headline', 'callToAction'],
  'split-panel': ['headline', 'callToAction'],
  'data-point': ['statValue', 'statCaption', 'callToAction'],
  'quote-proof': ['quote', 'attributionName', 'callToAction'],
  'comparison': ['comparison', 'headline', 'callToAction'],
};

/** German warnings for every required slot the derivation could not fill. */
export function missingSlotWarnings(
  template: string,
  content: CreativeContent,
): string[] {
  const required = REQUIRED_SLOTS[template] ?? [];
  const warnings: string[] = [];
  for (const slot of required) {
    const value = content[slot];
    const empty =
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim().length === 0);
    if (empty) {
      warnings.push(
        `Template "${template}": Slot "${slot}" ist leer – es wird ein Ersatzinhalt gerendert.`,
      );
    }
  }
  return warnings;
}
