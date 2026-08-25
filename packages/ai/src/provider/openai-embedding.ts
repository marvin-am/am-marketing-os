import { getModelConfig } from '@am/config';
import { DomainError } from '@am/domain';
import { instrumented } from '@am/observability';
import type OpenAI from 'openai';
import { getOpenAiClient } from './openai-client';
import { withRetry, type RetryOptions } from './retry';
import type { EmbeddingProvider } from './types';

/**
 * `EmbeddingProvider` backed by the embeddings API. The dimension is
 * configurable so the pgvector column and the provider can be changed together;
 * the default matches `text-embedding-3-large`.
 */

export interface OpenAiEmbeddingProviderOptions {
  client?: OpenAI;
  model?: string;
  /** Requested output dimension. Omit to accept the model's native size. */
  dimensions?: number;
  /** Inputs per request. The API caps batch size; 96 is comfortably below it. */
  batchSize?: number;
  retry?: RetryOptions;
}

/**
 * The width comes from configuration, not from the model's native size:
 * `knowledge_embeddings.embedding` is `vector(1536)` because pgvector cannot
 * index above 2000 dimensions, and a mismatch here fails every insert.
 */
function configuredDimensions(): number {
  return getModelConfig().embeddingDimensions;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly options: OpenAiEmbeddingProviderOptions;

  constructor(options: OpenAiEmbeddingProviderOptions = {}) {
    this.options = options;
    this.model = options.model ?? getModelConfig().embedding;
    this.dimensions = options.dimensions ?? configuredDimensions();
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = this.options.client ?? getOpenAiClient();
    const batchSize = this.options.batchSize ?? 96;
    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      const response = await instrumented(
        'OPENAI',
        'embeddings.create',
        () =>
          withRetry(
            () =>
              client.embeddings.create({
                model: this.model,
                input: batch,
                encoding_format: 'float',
                ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
              }),
            { ...this.options.retry, operation: 'embeddings.create' },
          ),
        (value) => ({ count: value.data.length, model: value.model }),
      );

      // The API documents index-ordered results, but sorting makes the mapping
      // from input to vector explicit rather than assumed.
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length) {
        throw new DomainError('PROVIDER_ERROR', {
          messageDe: 'Der Embedding-Anbieter hat eine unvollständige Antwort geliefert.',
          details: { expected: batch.length, received: ordered.length },
        });
      }
      for (const item of ordered) vectors.push(item.embedding);
    }

    return vectors;
  }
}
