import { describe, expect, it } from 'vitest';
import { CREATIVE_PRINCIPLES } from '@am/domain';
import {
  PRINCIPLE_KICKERS_DE,
  contentFromConcept,
  contentFromCopy,
  extractFigure,
  firstSentence,
  missingSlotWarnings,
} from './content';
import { FIXTURE_BRAND_PROFILE, FIXTURE_CONCEPT } from './fixtures';
import { TEMPLATE_IDS, creativeContentSchema } from './types';

describe('extractFigure', () => {
  it('lifts a percentage out of the headline', () => {
    const figure = extractFigure({
      headline: '38 % mehr qualifizierte Anfragen',
      description: '',
      primaryText: '',
    });
    expect(figure?.value).toBe('38 %');
    expect(figure?.caption).toBe('mehr qualifizierte Anfragen');
    expect(figure?.source).toBe('headline');
  });

  it('handles German decimal commas and multipliers', () => {
    expect(
      extractFigure({ headline: '3,4× schneller im Angebot', description: '', primaryText: '' })
        ?.value,
    ).toBe('3,4×');
  });

  it('falls back to the description, then the proof, then the primary text', () => {
    const fromDescription = extractFigure({
      headline: 'Mehr Anfragen',
      description: 'In 90 Minuten startklar',
      primaryText: '',
    });
    expect(fromDescription?.source).toBe('description');
    expect(fromDescription?.value).toBe('90 Minuten');

    const fromProof = extractFigure({
      headline: 'Mehr Anfragen',
      description: 'Ohne Zahl',
      primaryText: 'Auch ohne',
      proofUsed: 'Auswertung von 42 Betrieben',
    });
    expect(fromProof?.source).toBe('proof');
    expect(fromProof?.value).toBe('42');
  });

  it('returns null when there is no figure at all', () => {
    expect(
      extractFigure({
        headline: 'Mehr Anfragen ohne Zahlen',
        description: 'Kein Wert',
        primaryText: 'Auch hier nicht',
      }),
    ).toBeNull();
  });
});

describe('firstSentence', () => {
  it('stops at the first full stop', () => {
    expect(firstSentence('Erster Satz. Zweiter Satz.')).toBe('Erster Satz');
  });

  it('handles text without punctuation', () => {
    expect(firstSentence('Ohne Punkt')).toBe('Ohne Punkt');
  });

  it('truncates over-long sentences', () => {
    expect(firstSentence('a'.repeat(300), 40)).toHaveLength(40);
  });
});

describe('contentFromCopy', () => {
  it('fills every slot a template can ask for', () => {
    const content = contentFromCopy(FIXTURE_CONCEPT.copy, 'PROOF_CASE_DATAPOINT', {
      brandName: 'A&M',
    });
    expect(() => creativeContentSchema.parse(content)).not.toThrow();
    expect(content.headline).toBe(FIXTURE_CONCEPT.copy.headline);
    expect(content.callToAction).toBe(FIXTURE_CONCEPT.copy.callToAction);
    expect(content.kicker).toBe(PRINCIPLE_KICKERS_DE.PROOF_CASE_DATAPOINT);
    expect(content.statValue).toBe('38 %');
    expect(content.comparison?.right.label).toBe('Mit A&M');
  });

  it('gives every principle its own kicker', () => {
    const kickers = CREATIVE_PRINCIPLES.map((principle) => PRINCIPLE_KICKERS_DE[principle]);
    expect(new Set(kickers).size).toBe(CREATIVE_PRINCIPLES.length);
  });

  it('is deterministic', () => {
    const a = contentFromCopy(FIXTURE_CONCEPT.copy, 'CONCRETE_RESULT', { brandName: 'A&M' });
    const b = contentFromCopy(FIXTURE_CONCEPT.copy, 'CONCRETE_RESULT', { brandName: 'A&M' });
    expect(b).toEqual(a);
  });
});

describe('contentFromConcept', () => {
  it('derives a source line and a quote from the proof', () => {
    const content = contentFromConcept(FIXTURE_CONCEPT, {
      brandName: FIXTURE_BRAND_PROFILE.name,
    });
    expect(content.sourceLine).toMatch(/^Quelle: /);
    expect(content.quote).toContain('42 Betrieben');
    expect(content.comparison?.left.items.length).toBeGreaterThan(0);
    expect(content.comparison?.right.items.length).toBeGreaterThan(0);
  });

  it('lets explicit overrides win', () => {
    const content = contentFromConcept(FIXTURE_CONCEPT, {
      brandName: 'A&M',
      overrides: { headline: 'Handgeschrieben', statValue: '12', sourceLine: null },
    });
    expect(content.headline).toBe('Handgeschrieben');
    expect(content.statValue).toBe('12');
    expect(content.sourceLine).toBeNull();
  });

  it('leaves the concept untouched', () => {
    const snapshot = JSON.stringify(FIXTURE_CONCEPT);
    contentFromConcept(FIXTURE_CONCEPT, { brandName: 'A&M' });
    expect(JSON.stringify(FIXTURE_CONCEPT)).toBe(snapshot);
  });
});

describe('missingSlotWarnings', () => {
  it('is silent when every required slot is filled', () => {
    const content = contentFromConcept(FIXTURE_CONCEPT, { brandName: 'A&M' });
    for (const template of TEMPLATE_IDS) {
      expect(missingSlotWarnings(template, content)).toEqual([]);
    }
  });

  it('names the empty slot in German', () => {
    const bare = creativeContentSchema.parse({ headline: 'Kurz', callToAction: 'Los' });
    const warnings = missingSlotWarnings('data-point', bare);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('statValue');
    expect(warnings.join(' ')).toContain('statCaption');
    expect(warnings[0]).toContain('Ersatzinhalt');
    expect(missingSlotWarnings('quote-proof', bare).join(' ')).toContain('quote');
  });
});
