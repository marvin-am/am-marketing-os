import { resolveProviderMode } from '@am/config';
import { FixtureEmbeddingProvider } from './fixture-embedding';
import { FixtureImageProvider } from './fixture-image';
import { FixtureTextProvider } from './fixture-text';
import { OpenAiEmbeddingProvider } from './openai-embedding';
import { OpenAiImageProvider } from './openai-image';
import { OpenAiTextProvider } from './openai-text';
import { resetOpenAiClient } from './openai-client';
import type { EmbeddingProvider, ImageProvider, TextProvider } from './types';

/**
 * Fixture-vs-live selection happens here and nowhere else (AGENTS.md,
 * "Fixtures and demo mode"). Feature code calls `getTextProvider()` and never
 * learns which implementation it received or which model backs it.
 *
 * Instances are memoised so a pipeline run reuses one HTTP client, and
 * `resetProviderCache()` exists for tests that flip `DEMO_MODE`.
 */

let textProvider: TextProvider | null = null;
let imageProvider: ImageProvider | null = null;
let embeddingProvider: EmbeddingProvider | null = null;

export function getTextProvider(): TextProvider {
  if (!textProvider) {
    textProvider =
      resolveProviderMode('OPENAI') === 'LIVE' ? new OpenAiTextProvider() : new FixtureTextProvider();
  }
  return textProvider;
}

export function getImageProvider(): ImageProvider {
  if (!imageProvider) {
    imageProvider =
      resolveProviderMode('OPENAI') === 'LIVE'
        ? new OpenAiImageProvider()
        : new FixtureImageProvider();
  }
  return imageProvider;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!embeddingProvider) {
    embeddingProvider =
      resolveProviderMode('OPENAI') === 'LIVE'
        ? new OpenAiEmbeddingProvider()
        : new FixtureEmbeddingProvider();
  }
  return embeddingProvider;
}

/** True when the AI capabilities are served by fixtures rather than OpenAI. */
export function isFixtureMode(): boolean {
  return resolveProviderMode('OPENAI') === 'FIXTURE';
}

/** Test seam — call after `resetConfigCache()` when the environment changes. */
export function resetProviderCache(): void {
  textProvider = null;
  imageProvider = null;
  embeddingProvider = null;
  resetOpenAiClient();
}
