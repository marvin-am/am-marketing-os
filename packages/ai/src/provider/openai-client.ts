import { getModelConfig } from '@am/config';
import { DomainError } from '@am/domain';
import OpenAI from 'openai';

/**
 * Single place where an OpenAI client is constructed.
 *
 * `maxRetries: 0` is deliberate: retries belong to `withRetry`, which logs each
 * attempt through `@am/observability` and converts the final failure into a
 * `DomainError`. Letting the SDK retry silently underneath would hide rate
 * limiting from the integration health view.
 */

let cached: OpenAI | null = null;

export function getOpenAiClient(): OpenAI {
  if (cached) return cached;
  const config = getModelConfig();
  if (!config.apiKey) {
    throw new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe: 'Die OpenAI-Integration ist noch nicht verbunden.',
      details: { provider: 'OPENAI' },
    });
  }
  cached = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? undefined,
    maxRetries: 0,
    timeout: 180_000,
  });
  return cached;
}

/** Test seam — also used after `resetConfigCache()`. */
export function resetOpenAiClient(): void {
  cached = null;
}
