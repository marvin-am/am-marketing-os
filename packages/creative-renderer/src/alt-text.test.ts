import { describe, expect, it } from 'vitest';
import { CREATIVE_PRINCIPLES } from '@am/domain';
import {
  MAX_ALT_TEXT_LENGTH,
  altTextForConcept,
  buildAltText,
  clampAltText,
} from './alt-text';
import { contentFromConcept } from './content';
import { FIXTURE_BRAND_PROFILE, FIXTURE_CONCEPT, LONG_GERMAN_HEADLINE } from './fixtures';
import { TEMPLATE_IDS } from './types';

const content = contentFromConcept(FIXTURE_CONCEPT, { brandName: FIXTURE_BRAND_PROFILE.name });

describe('clampAltText', () => {
  it('leaves short text alone', () => {
    expect(clampAltText('Kurzer Text').text).toBe('Kurzer Text');
    expect(clampAltText('Kurzer Text').truncated).toBe(false);
  });

  it('cuts on a word boundary and marks the truncation', () => {
    const result = clampAltText(`${LONG_GERMAN_HEADLINE} ${LONG_GERMAN_HEADLINE}`, 80);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.text).not.toMatch(/\s…$/);
  });

  it('collapses whitespace', () => {
    expect(clampAltText('a   b\n c').text).toBe('a b c');
  });
});

describe('buildAltText', () => {
  it('prefers an operator-authored alt text', () => {
    const result = altTextForConcept(FIXTURE_CONCEPT, 'bold-statement', content);
    expect(result.source).toBe('EXPLICIT');
    expect(result.text).toBe(FIXTURE_CONCEPT.altText);
  });

  it('composes German alt text when none was authored', () => {
    const result = buildAltText({
      template: 'data-point',
      content,
      principle: 'PROOF_CASE_DATAPOINT',
      visualIdea: FIXTURE_CONCEPT.visualIdea,
      explicit: null,
    });
    expect(result.source).toBe('COMPOSED');
    expect(result.text).toMatch(/^Werbemotiv:/);
    expect(result.text).toContain('Kennzahl');
    expect(result.text).toContain('Zu sehen ist:');
    expect(result.text).toContain('Aussage: 38 %');
    expect(result.text).toContain('Handlungsaufforderung: Analyse starten');
    expect(result.length).toBe(result.text.length);
  });

  it('keeps the call to action even when the motif description is enormous', () => {
    const result = buildAltText({
      template: 'bold-statement',
      content,
      principle: 'PROBLEM_PAIN',
      visualIdea: LONG_GERMAN_HEADLINE.repeat(8),
      explicit: null,
    });
    expect(result.text.length).toBeLessThanOrEqual(MAX_ALT_TEXT_LENGTH);
    expect(result.text).toContain('Handlungsaufforderung: Analyse starten');
    expect(result.truncated).toBe(true);
  });

  it('stays inside the length limit for every template and principle', () => {
    for (const template of TEMPLATE_IDS) {
      for (const principle of CREATIVE_PRINCIPLES) {
        const result = buildAltText({
          template,
          content: { ...content, headline: LONG_GERMAN_HEADLINE, quote: LONG_GERMAN_HEADLINE },
          principle,
          visualIdea: `${FIXTURE_CONCEPT.visualIdea} ${LONG_GERMAN_HEADLINE}`,
          explicit: null,
        });
        expect(result.text.length).toBeGreaterThan(10);
        expect(result.text.length).toBeLessThanOrEqual(MAX_ALT_TEXT_LENGTH);
      }
    }
  });

  it('is deterministic — the same input always produces the same text', () => {
    const once = buildAltText({
      template: 'quote-proof',
      content,
      principle: 'OBJECTION_HANDLING',
      visualIdea: FIXTURE_CONCEPT.visualIdea,
      explicit: null,
    });
    const twice = buildAltText({
      template: 'quote-proof',
      content,
      principle: 'OBJECTION_HANDLING',
      visualIdea: FIXTURE_CONCEPT.visualIdea,
      explicit: null,
    });
    expect(twice).toEqual(once);
  });

  it('describes each template differently', () => {
    const texts = TEMPLATE_IDS.map(
      (template) =>
        buildAltText({ template, content, principle: 'CONCRETE_RESULT', explicit: null }).text,
    );
    expect(new Set(texts).size).toBe(TEMPLATE_IDS.length);
  });

  it('works without a motif description', () => {
    const result = buildAltText({
      template: 'split-panel',
      content,
      principle: 'CONCRETE_RESULT',
      visualIdea: null,
      explicit: null,
    });
    expect(result.text.length).toBeGreaterThan(10);
    expect(result.text).not.toContain('–  ');
  });

  it('honours a shorter caller limit', () => {
    const result = buildAltText({
      template: 'comparison',
      content,
      principle: 'COMPARISON_ALTERNATIVE',
      visualIdea: FIXTURE_CONCEPT.visualIdea,
      explicit: null,
      maxLength: 90,
    });
    expect(result.text.length).toBeLessThanOrEqual(90);
    expect(result.truncated).toBe(true);
  });
});
