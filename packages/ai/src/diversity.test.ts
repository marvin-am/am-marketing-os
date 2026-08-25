import { isDomainError, type CreativePrinciple } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  assertLaunchDiversity,
  checkCreativeDiversity,
  DIVERSITY_DEFAULTS,
  type DiversityConcept,
} from './diversity';
import { fixtureConceptDrafts, fixtureMetaCopy } from './provider/fixture-content';
import { FixtureEmbeddingProvider } from './provider/fixture-embedding';

const embeddings = new FixtureEmbeddingProvider();

/** The six fixture concepts with their fixture copy attached. */
function variedConcepts(seed = 0): DiversityConcept[] {
  const drafts = fixtureConceptDrafts(seed);
  const copies = fixtureMetaCopy(seed);
  return drafts.map((draft, index) => ({
    key: draft.key,
    principle: draft.principle,
    visualIdea: draft.visualIdea,
    imagePrompt: draft.imagePrompt,
    proofUsed: draft.proofUsed,
    funnelPromise: draft.funnelPromise,
    copy: copies.copies[index]!.copy,
  }));
}

/** Six concepts that say the same thing with a swapped adjective. */
function nearIdenticalConcepts(): DiversityConcept[] {
  const fillers = ['schnell', 'zügig', 'rasch', 'flott', 'prompt', 'umgehend'];
  return fillers.map((filler, index) => ({
    key: `concept_${index + 1}`,
    principle: 'PROBLEM_PAIN' as CreativePrinciple,
    visualIdea:
      'Ein leerer Betriebshof am Morgen mit zwei geparkten Transportern und geschlossenem Rolltor.',
    imagePrompt:
      'Fotorealistische Aufnahme eines leeren Betriebshofs am Morgen mit zwei geparkten Transportern und geschlossenem Rolltor.',
    proofUsed: null,
    funnelPromise: 'Sie sehen in zwei Minuten, wo Ihr Bewerbungsablauf Kandidaten verliert.',
    copy: {
      primaryText: `Offene Stellen kosten Sie Termine. Wir zeigen Ihnen ${filler}, wo Ihr Bewerbungsablauf Kandidaten verliert, und welchen Schritt Sie zuerst ändern sollten.`,
      headline: `Offene Stellen kosten Termine (${filler})`,
      description: 'Kostenlose Potenzialanalyse für Handwerksbetriebe.',
      callToAction: 'Analyse starten',
    },
  }));
}

describe('checkCreativeDiversity', () => {
  it('passes a genuinely varied set of six concepts', async () => {
    const report = await checkCreativeDiversity(variedConcepts(), { embeddings });

    expect(report.distinctCount).toBe(6);
    expect(report.blocked).toBe(false);
    expect(report.pairs).toHaveLength(15);
    expect(report.pairs.every((pair) => !pair.tooSimilar)).toBe(true);
    expect(report.principlesUsed).toHaveLength(6);
    expect(report.reasonsDe).toEqual([]);
  });

  it('stays comfortably below the pair threshold on the varied set', async () => {
    const report = await checkCreativeDiversity(variedConcepts(), { embeddings });
    const worst = Math.max(...report.pairs.map((pair) => pair.overall));
    // Headroom matters: a set that only just passes would flip on a reword.
    expect(worst).toBeLessThan(DIVERSITY_DEFAULTS.pair - 0.15);
  });

  it('blocks six near-identical concepts', async () => {
    const report = await checkCreativeDiversity(nearIdenticalConcepts(), { embeddings });

    expect(report.distinctCount).toBe(1);
    expect(report.blocked).toBe(true);
    expect(report.pairs.every((pair) => pair.tooSimilar)).toBe(true);
    expect(report.pairs.every((pair) => pair.samePrinciple)).toBe(true);
    expect(report.reasonsDe[0]).toContain('konzeptionell unterschiedliche Creatives');
    expect(report.reasonsDe.some((reason) => reason.includes('concept_1 und concept_2'))).toBe(true);
  });

  it('blocks when only four clusters survive', async () => {
    const concepts = variedConcepts();
    // Make concepts 5 and 6 restatements of 1 and 2 respectively.
    concepts[4] = { ...concepts[0]!, key: 'concept_5' };
    concepts[5] = { ...concepts[1]!, key: 'concept_6' };

    const report = await checkCreativeDiversity(concepts, { embeddings });
    expect(report.distinctCount).toBe(4);
    expect(report.blocked).toBe(true);
  });

  it('works without an embedding provider, on lexical overlap alone', async () => {
    const varied = await checkCreativeDiversity(variedConcepts());
    const identical = await checkCreativeDiversity(nearIdenticalConcepts());

    expect(varied.blocked).toBe(false);
    expect(identical.blocked).toBe(true);
  });

  it('does not treat two concepts without a proof as sharing one', async () => {
    const report = await checkCreativeDiversity(variedConcepts(), { embeddings });
    const withoutProof = report.pairs.filter((pair) => pair.proof === 0);
    expect(withoutProof.length).toBeGreaterThan(0);
  });

  it('flags a repeated communication principle', async () => {
    const concepts = variedConcepts();
    concepts[5] = { ...concepts[5]!, principle: concepts[0]!.principle };

    const report = await checkCreativeDiversity(concepts, { embeddings });
    expect(report.principlesUsed).toHaveLength(5);
    expect(report.reasonsDe.some((reason) => reason.includes('Kommunikationsprinzipien'))).toBe(true);
  });
});

describe('assertLaunchDiversity', () => {
  it('returns the report when the set clears the bar', async () => {
    const report = await assertLaunchDiversity(variedConcepts(), { embeddings });
    expect(report.distinctCount).toBe(6);
  });

  it('throws DIVERSITY_INSUFFICIENT for near-identical concepts', async () => {
    expect.assertions(3);
    try {
      await assertLaunchDiversity(nearIdenticalConcepts(), { embeddings });
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('DIVERSITY_INSUFFICIENT');
        expect(error.details.distinctCount).toBe(1);
      }
    }
  });
});
