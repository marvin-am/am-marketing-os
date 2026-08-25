import { fnv1a32 } from '@am/domain';
import { shingles, tokenize } from '../text';
import type { EmbeddingProvider } from './types';

/**
 * Deterministic embedding provider.
 *
 * Not a random stub: it is a hashed bag-of-words projection (the "hashing
 * trick"). Every German token is hashed into one of `dimensions` buckets and
 * accumulated with a sublinear term weight; character shingles are added at a
 * lower weight so morphological variants of the same compound
 * ("Mitarbeitergewinnung" / "Mitarbeiter gewinnen") still land near each other.
 * The vector is then L2-normalised, so a dot product *is* the cosine.
 *
 * The consequence that matters: cosine similarity is genuinely higher for
 * related text and near zero for unrelated text, which makes the angle
 * distinctness and creative diversity tests real tests rather than assertions
 * about noise.
 *
 * All weights are non-negative, so cosine stays inside [0, 1] — the range
 * `similarCampaignReferenceSchema` requires.
 */

export interface FixtureEmbeddingProviderOptions {
  dimensions?: number;
  /** Weight applied to character shingles relative to tokens. */
  shingleWeight?: number;
  shingleSize?: number;
}

/** Matches the configured live width so both paths fit the same column. */
const DEFAULT_DIMENSIONS = 1536;

export class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'fixture' as const;
  readonly model = 'fixture-embedding-v1';
  readonly dimensions: number;

  private readonly shingleWeight: number;
  private readonly shingleSize: number;

  constructor(options: FixtureEmbeddingProviderOptions = {}) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.shingleWeight = options.shingleWeight ?? 0.3;
    this.shingleSize = options.shingleSize ?? 5;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  /** Synchronous seam — the diversity checker uses it without awaiting. */
  embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);

    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, count] of counts) {
      const index = fnv1a32(`t:${token}`) % this.dimensions;
      // Sublinear term weighting keeps a repeated word from dominating.
      vector[index] += 1 + Math.log(count);
    }

    for (const gram of shingles(text, this.shingleSize)) {
      const index = fnv1a32(`s:${gram}`) % this.dimensions;
      vector[index] += this.shingleWeight;
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    return vector.map((value) => value / norm);
  }
}
