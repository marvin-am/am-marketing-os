import { describe, expect, it } from 'vitest';
import * as ai from './index';

/**
 * Guards the public surface.
 *
 * ESM star re-exports drop a name silently when two modules export it, so a
 * collision introduced later would not fail the type-check — it would make an
 * export disappear at runtime. Naming the surface here turns that into a test
 * failure.
 */
const EXPECTED_EXPORTS = [
  // providers
  'OpenAiTextProvider',
  'OpenAiImageProvider',
  'OpenAiEmbeddingProvider',
  'FixtureTextProvider',
  'FixtureImageProvider',
  'FixtureEmbeddingProvider',
  'getTextProvider',
  'getImageProvider',
  'getEmbeddingProvider',
  'isFixtureMode',
  'resetProviderCache',
  'withRetry',
  // structured outputs
  'zodToStrictJsonSchema',
  'toResponseFormat',
  'findStrictSchemaViolations',
  // prompts
  'PIPELINE_STEPS',
  'PIPELINE_STEP_LABELS_DE',
  'PIPELINE_PROMPTS',
  'getPromptForStep',
  'getPromptById',
  'listPrompts',
  'promptContentHash',
  'promptFingerprint',
  // pipeline
  'buildContext',
  'assertContextFree',
  'findContextPiiViolations',
  'runStep',
  'runPrompt',
  'runCampaignPipeline',
  'regenerateStep',
  'buildStepInput',
  'assembleProposal',
  'toMultiStepFormSpec',
  'toLandingPageSpec',
  'toFunnelSpec',
  // analysis
  'checkCreativeDiversity',
  'assertLaunchDiversity',
  'assertDiversityReport',
  'DIVERSITY_DEFAULTS',
  'cosineSimilarity',
  'topKSimilar',
  'checkAngleDistinctness',
  'explainMetrics',
  'findInventedNumbers',
  'assertNoInventedNumbers',
  'renderFactsBlockDe',
  // fixtures
  'fixtureContextBundle',
] as const;

describe('@am/ai public surface', () => {
  it.each(EXPECTED_EXPORTS)('exports %s', (name) => {
    expect(ai[name]).toBeDefined();
  });

  it('exposes no model identifier as part of its API', () => {
    // Capability, not model: an id like "gpt-…" must never be a public constant.
    const modelLike = Object.entries(ai as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .filter(([, value]) => /^gpt-|^o\d|^text-embedding/.test(value as string));
    expect(modelLike).toEqual([]);
  });
});
