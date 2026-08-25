import { ANGLE_DISTINCTNESS, type AngleSpec } from '@am/domain';
import { describe, expect, it } from 'vitest';
import { FixtureEmbeddingProvider } from './provider/fixture-embedding';
import type { EmbeddingProvider } from './provider/types';
import {
  angleEmbeddingText,
  checkAngleDistinctness,
  cosineSimilarity,
  matchesFilter,
  topKSimilar,
  type StoredEmbedding,
} from './similarity';

/** A provider that returns a fixed vector, so the classifier is under test. */
function stubEmbeddings(vector: number[]): EmbeddingProvider {
  return {
    kind: 'fixture',
    model: 'stub',
    dimensions: vector.length,
    embed: (texts) => Promise.resolve(texts.map(() => vector)),
  };
}

/** Unit vector at `angle` radians from [1, 0]; cosine with [1,0] is cos(angle). */
function unitAt(similarity: number): number[] {
  return [similarity, Math.sqrt(Math.max(0, 1 - similarity * similarity))];
}

function record(
  id: string,
  similarity: number,
  overrides: Partial<StoredEmbedding['metadata']> = {},
): StoredEmbedding {
  return {
    id,
    vector: unitAt(similarity),
    metadata: {
      campaignId: `00000000-0000-4000-8000-0000000000${id.slice(-2)}`,
      campaignName: `Kampagne ${id}`,
      angleName: 'Planbarkeit statt Personalsuche',
      offerName: 'Potenzialanalyse',
      ranAt: '2026-06-01T00:00:00+00:00',
      outcomeSummary: 'Abgeschlossen',
      attributionLevel: 'LEAD_LINKED',
      text: 'historischer Angle',
      ...overrides,
    },
  };
}

const candidate: AngleSpec = {
  name: 'Erstkontakt als Nadelöhr',
  perspective:
    'Nicht die Stellenanzeige entscheidet über Bewerbungen, sondern was in den ersten Stunden danach passiert.',
  rationale:
    'Die Betriebe optimieren fast ausschließlich die Anzeige und übersehen den Ablauf unmittelbar danach.',
  keywords: ['Erstkontakt', 'Reaktionszeit', 'Bewerbungsablauf'],
};

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is 0 when either vector is empty of magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('never leaves [0, 1], so a stored similarity always validates', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
    expect(cosineSimilarity([3, 4], [3, 4])).toBeLessThanOrEqual(1);
  });

  it('rejects vectors of different length', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/unterschiedlicher Länge/);
  });
});

describe('topKSimilar', () => {
  const history = [record('rec-01', 0.95), record('rec-02', 0.7), record('rec-03', 0.4)];

  it('returns the nearest records in descending order', () => {
    const hits = topKSimilar([1, 0], history, { k: 2 });
    expect(hits.map((hit) => hit.record.id)).toEqual(['rec-01', 'rec-02']);
    expect(hits[0]!.similarity).toBeCloseTo(0.95, 6);
  });

  it('applies the minimum similarity filter', () => {
    const hits = topKSimilar([1, 0], history, { filter: { minSimilarity: 0.8 } });
    expect(hits).toHaveLength(1);
  });

  it('filters by date range, angle and offer', () => {
    const mixed = [
      record('rec-04', 0.9, { ranAt: '2024-01-01T00:00:00+00:00' }),
      record('rec-05', 0.9, { angleName: 'Ein anderer Angle' }),
      record('rec-06', 0.9, { offerName: 'Benchmark' }),
      record('rec-07', 0.9),
    ];

    expect(
      topKSimilar([1, 0], mixed, { filter: { from: '2026-01-01T00:00:00+00:00' } }).map(
        (hit) => hit.record.id,
      ),
    ).toEqual(['rec-05', 'rec-06', 'rec-07']);

    expect(
      topKSimilar([1, 0], mixed, {
        filter: { angleName: 'planbarkeit statt personalsuche' },
      }).map((hit) => hit.record.id),
    ).toEqual(['rec-04', 'rec-06', 'rec-07']);

    expect(
      topKSimilar([1, 0], mixed, { filter: { offerName: 'Potenzialanalyse' } }).map(
        (hit) => hit.record.id,
      ),
    ).toEqual(['rec-04', 'rec-05', 'rec-07']);
  });

  it('excludes records without a run date from a windowed search', () => {
    const undated = record('rec-08', 0.9, { ranAt: null });
    expect(matchesFilter(undated, { recencyDays: 180, now: '2026-08-25T00:00:00+00:00' })).toBe(
      false,
    );
    expect(matchesFilter(undated, {})).toBe(true);
  });
});

describe('checkAngleDistinctness', () => {
  const history = [record('rec-01', 0.5)];
  const now = '2026-08-25T00:00:00+00:00';

  it('returns TOO_SIMILAR above the block threshold', async () => {
    const result = await checkAngleDistinctness(candidate, [record('rec-a', 0.96)], {
      embeddings: stubEmbeddings([1, 0]),
      now,
    });

    expect(result.maxSimilarity).toBeGreaterThan(ANGLE_DISTINCTNESS.blockThreshold);
    expect(result.verdict).toBe('TOO_SIMILAR');
    expect(result.verdictLabelDe).toBe('Zu ähnlich – bitte neu entwickeln');
    expect(result.similarCampaigns[0]!.campaignName).toBe('Kampagne rec-a');
    expect(result.explanationDe).toContain('zu nah an');
  });

  it('returns ITERATION above the iteration threshold', async () => {
    const result = await checkAngleDistinctness(candidate, [record('rec-b', 0.85)], {
      embeddings: stubEmbeddings([1, 0]),
      now,
    });

    expect(result.maxSimilarity).toBeGreaterThan(ANGLE_DISTINCTNESS.iterationThreshold);
    expect(result.maxSimilarity).toBeLessThan(ANGLE_DISTINCTNESS.blockThreshold);
    expect(result.verdict).toBe('ITERATION');
    expect(result.explanationDe).toContain('Iteration');
  });

  it('returns DISTINCT below both thresholds', async () => {
    const result = await checkAngleDistinctness(candidate, history, {
      embeddings: stubEmbeddings([1, 0]),
      now,
    });

    expect(result.verdict).toBe('DISTINCT');
    expect(result.explanationDe).toContain('eigenständig');
  });

  it('is DISTINCT with an explicit note when the index is empty', async () => {
    const result = await checkAngleDistinctness(candidate, [], {
      embeddings: stubEmbeddings([1, 0]),
      now,
    });

    expect(result.verdict).toBe('DISTINCT');
    expect(result.maxSimilarity).toBe(0);
    expect(result.similarCampaigns).toEqual([]);
    expect(result.explanationDe).toContain('keine vergleichbaren früheren Kampagnen');
  });

  it('ignores campaigns outside the recency window', async () => {
    const result = await checkAngleDistinctness(
      candidate,
      [record('rec-old', 0.99, { ranAt: '2024-01-01T00:00:00+00:00' })],
      { embeddings: stubEmbeddings([1, 0]), now },
    );
    expect(result.verdict).toBe('DISTINCT');
  });

  it('scores a reworded angle as more similar than an unrelated one, on real embeddings', async () => {
    const embeddings = new FixtureEmbeddingProvider();
    const reworded: AngleSpec = {
      ...candidate,
      name: 'Der Erstkontakt ist das Nadelöhr',
      perspective:
        'Nicht die Stellenanzeige entscheidet über Bewerbungen, sondern was in den ersten Stunden nach dem Interesse passiert.',
    };
    const unrelated: AngleSpec = {
      name: 'Maschinenpark modernisieren',
      perspective:
        'Der Engpass liegt in veralteten Maschinen, deren Wartung ganze Produktionstage kostet.',
      rationale: 'Investitionen in den Maschinenpark amortisieren sich über weniger Stillstand.',
      keywords: ['Maschinenpark', 'Wartung', 'Stillstand'],
    };

    const [base, near, far] = await embeddings.embed([
      angleEmbeddingText(candidate),
      angleEmbeddingText(reworded),
      angleEmbeddingText(unrelated),
    ]);

    const nearScore = cosineSimilarity(base!, near!);
    const farScore = cosineSimilarity(base!, far!);
    expect(nearScore).toBeGreaterThan(0.8);
    expect(farScore).toBeLessThan(0.3);
    expect(nearScore).toBeGreaterThan(farScore);
  });
});
