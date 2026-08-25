import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelConfig, resetConfigCache } from '@am/config';
import { FixtureEmbeddingProvider, OpenAiEmbeddingProvider } from '../src';

/**
 * The embedding width has to agree in three places at once: the configured
 * value, both provider implementations, and the `vector(n)` column the vectors
 * are written into.
 *
 * A mismatch is not a subtle bug — every insert fails — but it is easy to
 * reintroduce, because each of the three lives in a different package. These
 * assertions are the thing that stops that.
 */
describe('embedding width', () => {
  beforeEach(() => {
    delete process.env.OPENAI_EMBEDDING_DIMENSIONS;
    resetConfigCache();
  });

  it('defaults to 1536, the width pgvector can index', () => {
    expect(getModelConfig().embeddingDimensions).toBe(1536);
  });

  it('is what the live provider requests', () => {
    expect(new OpenAiEmbeddingProvider().dimensions).toBe(getModelConfig().embeddingDimensions);
  });

  it('is what the fixture provider produces', async () => {
    const provider = new FixtureEmbeddingProvider();
    expect(provider.dimensions).toBe(getModelConfig().embeddingDimensions);

    const [vector] = await provider.embed(['Kostenlose Potenzialanalyse für Geschäftsführer']);
    expect(vector).toHaveLength(getModelConfig().embeddingDimensions);
  });

  it('matches the column the migration declares', () => {
    const migrations = join(import.meta.dirname, '..', '..', '..', 'supabase', 'migrations');
    const sql = readFileSync(join(migrations, '0003_brand_knowledge.sql'), 'utf8');

    const declared = /embedding\s+(?:public\.)?vector\((\d+)\)/i.exec(sql);
    expect(declared, 'no vector(n) embedding column found in 0003_brand_knowledge.sql').not.toBeNull();
    expect(Number(declared![1])).toBe(getModelConfig().embeddingDimensions);
  });

  it('honours an explicit override', () => {
    process.env.OPENAI_EMBEDDING_DIMENSIONS = '256';
    resetConfigCache();
    expect(new OpenAiEmbeddingProvider().dimensions).toBe(256);
  });
});
