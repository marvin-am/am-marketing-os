/**
 * German alt text, composed deterministically.
 *
 * Never a model call. Alt text is an accessibility obligation and it ends up in
 * the Meta ad object, so it has to be stable across re-renders: the same concept
 * must not describe itself differently on Tuesday. Composition is plain string
 * assembly from fields an operator can see and edit.
 */

import type { CreativeConcept, CreativePrinciple } from '@am/domain';
import { normalizeWhitespace } from './xml';
import type { CreativeContent, TemplateId } from './types';

/** Meta accepts more, but long alt text is read aloud in full — keep it tight. */
export const MAX_ALT_TEXT_LENGTH = 300;
export const MIN_ALT_TEXT_LENGTH = 10;

/** How each template presents its content, in one German clause. */
const TEMPLATE_DESCRIPTIONS_DE: Readonly<Record<TemplateId, string>> = {
  'bold-statement': 'Bildmotiv mit großer Aussage im unteren Bildbereich',
  'split-panel': 'Bildmotiv neben einer farbigen Fläche mit Text',
  'data-point': 'abgedunkeltes Bildmotiv mit einer großen Kennzahl',
  'quote-proof': 'Bildmotiv mit einer Zitatkarte',
  'comparison': 'Bildmotiv mit einer Gegenüberstellung in zwei Spalten',
};

const PRINCIPLE_DESCRIPTIONS_DE: Readonly<Record<CreativePrinciple, string>> = {
  PROBLEM_PAIN: 'Es benennt ein konkretes Problem.',
  CONCRETE_RESULT: 'Es zeigt ein konkretes Ergebnis.',
  COMPARISON_ALTERNATIVE: 'Es stellt zwei Vorgehensweisen gegenüber.',
  PROOF_CASE_DATAPOINT: 'Es belegt eine Aussage mit einer Kennzahl.',
  OBJECTION_HANDLING: 'Es entkräftet einen häufigen Einwand.',
  CONTRARIAN_INSIGHT: 'Es stellt eine verbreitete Annahme infrage.',
};

export interface AltTextInput {
  template: TemplateId;
  content: CreativeContent;
  principle: CreativePrinciple;
  /** Motif description in words — the concept's `visualIdea`. */
  visualIdea?: string | null;
  /** An operator-authored alt text always wins. */
  explicit?: string | null;
  maxLength?: number;
}

export interface AltTextResult {
  text: string;
  length: number;
  truncated: boolean;
  /** Where the text came from, for the console to show. */
  source: 'EXPLICIT' | 'COMPOSED';
}

/** Trims to `maxLength` on a word boundary, appending an ellipsis. */
export function clampAltText(text: string, maxLength = MAX_ALT_TEXT_LENGTH): {
  text: string;
  truncated: boolean;
} {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return { text: normalized, truncated: false };
  const cut = normalized.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return { text: `${base.replace(/[,;:.\s]+$/u, '')}…`, truncated: true };
}

function sentence(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return '';
  return /[.!?…]$/u.test(normalized) ? normalized : `${normalized}.`;
}

/**
 * Composes alt text as: what the image is, what is in it, what it says, why, and
 * what it asks for.
 *
 * The clauses are budgeted rather than concatenated-then-cut. A 1000-character
 * motif description must not push the call to action out of a screen reader's
 * earshot, so the fixed clauses claim their space first and the motif
 * description takes whatever is left — or is dropped entirely.
 */
export function buildAltText(input: AltTextInput): AltTextResult {
  const maxLength = input.maxLength ?? MAX_ALT_TEXT_LENGTH;

  const explicit = normalizeWhitespace(input.explicit ?? '');
  if (explicit.length >= MIN_ALT_TEXT_LENGTH) {
    const clamped = clampAltText(explicit, maxLength);
    return {
      text: clamped.text,
      length: clamped.text.length,
      truncated: clamped.truncated,
      source: 'EXPLICIT',
    };
  }

  let truncated = false;
  const cost = (clause: string): number => (clause.length > 0 ? clause.length + 1 : 0);

  /* 1. The medium — always kept, it is a handful of characters. */
  const mediumClause = sentence(`Werbemotiv: ${TEMPLATE_DESCRIPTIONS_DE[input.template]}`);
  let remaining = maxLength - mediumClause.length;

  /* 2. The call to action — the only actionable part, so it is claimed next. */
  const cta = normalizeWhitespace(input.content.callToAction);
  const ctaCandidate = cta.length > 0 ? sentence(`Handlungsaufforderung: ${cta}`) : '';
  const ctaClause = cost(ctaCandidate) <= remaining ? ctaCandidate : '';
  remaining -= cost(ctaClause);

  /* 3. What the creative actually says. */
  const statement = normalizeWhitespace(
    input.template === 'data-point' && input.content.statValue
      ? `${input.content.statValue} ${input.content.statCaption ?? input.content.headline}`
      : input.template === 'quote-proof' && input.content.quote
        ? `Zitat: ${input.content.quote}`
        : input.content.headline,
  );
  let statementClause = '';
  if (statement.length > 0) {
    const budget = remaining - 'Aussage: .'.length - 1;
    if (budget >= 12) {
      const clamped = clampAltText(statement, budget);
      truncated = truncated || clamped.truncated;
      statementClause = sentence(`Aussage: ${clamped.text}`);
      remaining -= cost(statementClause);
    } else {
      truncated = true;
    }
  }

  /* 4. Why this creative exists. */
  const principleCandidate = PRINCIPLE_DESCRIPTIONS_DE[input.principle];
  const principleClause = cost(principleCandidate) <= remaining ? principleCandidate : '';
  if (principleClause.length === 0) truncated = true;
  remaining -= cost(principleClause);

  /* 5. The motif description, with whatever space is left. */
  const motif = normalizeWhitespace(input.visualIdea ?? '');
  let motifClause = '';
  if (motif.length > 0) {
    const budget = remaining - 'Zu sehen ist: .'.length - 1;
    if (budget >= 20) {
      const clamped = clampAltText(motif, budget);
      truncated = truncated || clamped.truncated;
      motifClause = sentence(`Zu sehen ist: ${clamped.text}`);
    } else {
      truncated = true;
    }
  }

  const text = [mediumClause, motifClause, statementClause, principleClause, ctaClause]
    .filter((clause) => clause.length > 0)
    .join(' ');
  const clamped = clampAltText(text, maxLength);
  return {
    text: clamped.text,
    length: clamped.text.length,
    truncated: truncated || clamped.truncated,
    source: 'COMPOSED',
  };
}

/** Convenience wrapper for a full concept. */
export function altTextForConcept(
  concept: CreativeConcept,
  template: TemplateId,
  content: CreativeContent,
  maxLength = MAX_ALT_TEXT_LENGTH,
): AltTextResult {
  return buildAltText({
    template,
    content,
    principle: concept.principle,
    visualIdea: concept.visualIdea,
    explicit: concept.altText,
    maxLength,
  });
}
