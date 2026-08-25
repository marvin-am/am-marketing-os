import { isDomainError } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  allowedNumberSignatures,
  assertNoInventedNumbers,
  explainMetrics,
  extractNumberTokens,
  findInventedNumbers,
  renderFactsBlockDe,
  type ExplainFacts,
} from './explain';
import { FixtureTextProvider } from './provider/fixture-text';
import type { PipelineDeps } from './pipeline/types';

const facts: ExplainFacts = {
  titleDe: 'Kampagnenvergleich Funnel-Format',
  periodDe: '01.07.2026 bis 31.07.2026',
  facts: [
    { label: 'Submission-Rate Variante A', valueDe: '4,2 %', noteDe: '84 von 2.000 Sessions' },
    { label: 'Submission-Rate Variante B', valueDe: '3,1 %', noteDe: '62 von 2.000 Sessions' },
    { label: 'Terminquote Variante A', valueDe: '38 %' },
  ],
  dataQualityDe: 'Attributionsabdeckung 0,74, Kohorte noch nicht ausgereift.',
};

function deps(provider = new FixtureTextProvider()): PipelineDeps & { text: FixtureTextProvider } {
  let counter = 0;
  return {
    text: provider,
    now: () => '2026-08-25T12:00:00.000Z',
    newId: () => `job-${++counter}`,
  };
}

describe('renderFactsBlockDe', () => {
  it('renders every fact with its note and the data-quality line', () => {
    const block = renderFactsBlockDe(facts);
    expect(block).toContain('Kampagnenvergleich Funnel-Format');
    expect(block).toContain('- Submission-Rate Variante A: 4,2 % (84 von 2.000 Sessions)');
    expect(block).toContain('Datenqualität: Attributionsabdeckung 0,74');
  });
});

describe('number guard', () => {
  it('extracts German and machine formatted numbers', () => {
    expect(extractNumberTokens('4,2 % von 2.000 Sessions bei 0.74')).toEqual([
      '4,2',
      '2.000',
      '0.74',
    ]);
  });

  it('treats formatting variants of the same digits as the same number', () => {
    const allowed = allowedNumberSignatures('Wert: 1.234,5');
    expect(allowed.has('12345')).toBe(true);
    expect(findInventedNumbers('Der Wert lag bei 1234.5.', 'Wert: 1.234,5')).toEqual([]);
  });

  it('accepts an explanation that only reuses supplied numbers', () => {
    const block = renderFactsBlockDe(facts);
    expect(
      findInventedNumbers(
        { text: 'Variante A liegt mit 4,2 % über Variante B mit 3,1 %.' },
        block,
      ),
    ).toEqual([]);
  });

  it('flags a number that is not in the facts', () => {
    const block = renderFactsBlockDe(facts);
    expect(findInventedNumbers('Der Unterschied beträgt rund 27 Prozent.', block)).toEqual(['27']);
  });

  it('flags an altered number even when its digits are a subset', () => {
    const block = renderFactsBlockDe(facts);
    // "4" is a slice of "4,2" but not a number the facts state.
    expect(findInventedNumbers('Variante A erreicht 4 Prozent.', block)).toEqual(['4']);
  });

  it('allows purely qualitative German prose', () => {
    const block = renderFactsBlockDe(facts);
    expect(
      findInventedNumbers('Variante A liegt deutlich über Variante B, zwei Wochen nach Start.', block),
    ).toEqual([]);
  });

  it('assertNoInventedNumbers throws AI_OUTPUT_INVALID with the offending tokens', () => {
    expect.assertions(3);
    try {
      assertNoInventedNumbers({ explanationDe: 'Der CPL sank auf 18,40 Euro.' }, renderFactsBlockDe(facts));
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('AI_OUTPUT_INVALID');
        expect(error.details.inventedNumbers).toEqual(['18,40']);
      }
    }
  });
});

describe('explainMetrics', () => {
  it('returns a validated explanation and a succeeded job', async () => {
    const d = deps();
    const { job, output } = await explainMetrics({ facts, questionDe: 'Woher kommt der Unterschied?' }, d);

    expect(job.status).toBe('SUCCEEDED');
    expect(job.promptId).toBe('analytics.explain');
    expect(job.repairAttempts).toBe(0);
    expect(output.drivingFactorsDe.length).toBeGreaterThan(0);
    expect(findInventedNumbers(output, renderFactsBlockDe(facts))).toEqual([]);
  });

  it('rejects an explanation containing an invented number', async () => {
    expect.assertions(4);
    // The fixture explanation is number-free, so the *facts* are narrowed until
    // one of its own words counts as invented: the guard, not the corpus, is
    // what is under test.
    const narrowedFacts: ExplainFacts = { titleDe: 'Ohne Zahlen', facts: [] };
    const provider = new FixtureTextProvider();
    const d = deps(provider);

    const withNumber = {
      ...narrowedFacts,
      facts: [{ label: 'Hinweis', valueDe: 'ohne Zahlenangabe' }],
    };

    try {
      await explainMetrics(
        {
          facts: withNumber,
          questionDe: 'Nenne bitte die Abweichung in Prozent.',
        },
        {
          ...d,
          text: {
            kind: 'fixture',
            model: 'stub',
            generateStructured: (request) =>
              Promise.resolve({
                data: {
                  explanationDe:
                    'Die Submission-Rate lag bei 4,2 Prozent und damit klar über der Vergleichsvariante.',
                  drivingFactorsDe: ['Der Übergang zur Terminvereinbarung unterscheidet sich.'],
                  nextHypothesisDe:
                    'Eine direkte Terminauswahl auf der Bestätigungsseite erhöht den Anteil der Gespräche.',
                  nextTestDe:
                    'Nur die Bestätigungsseite variieren, das Formular in beiden Armen unverändert lassen.',
                  caveatDe: 'Die Kohorte ist noch nicht ausgereift.',
                } as never,
                raw: '{}',
                issues: [],
                model: 'stub',
                finishReason: 'completed',
                refusal: null,
                usage: null,
                requestHash: request.schemaName,
              }),
          },
        },
      );
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('AI_OUTPUT_INVALID');
        const issues = error.details.issues as string[];
        expect(issues.some((entry) => entry.includes('4,2'))).toBe(true);
        expect(issues.some((entry) => entry.includes('qualitativ'))).toBe(true);
      }
    }
  });
});
