import { DomainError } from '@am/domain';
import {
  angleDistinctnessPrompt,
  angleIdeationPrompt,
  campaignPackagePrompt,
  claimReviewPrompt,
  contextSummaryPrompt,
  coreMessagePrompt,
  creativeConceptionPrompt,
  funnelSpecPrompt,
  funnelStrategyPrompt,
  historyFramingPrompt,
  metaCopyPrompt,
  metricExplanationPrompt,
  offerDevelopmentPrompt,
} from './definitions';
import {
  promptContentHash,
  promptFingerprint,
  type AnyPromptDefinition,
  type PipelineStep,
} from './types';

/**
 * The prompt registry.
 *
 * One prompt per pipeline step plus the standalone explanation helper. Lookup
 * happens by step (for the pipeline) or by id (for replaying a historical
 * `ai_jobs` row), never by importing a definition into feature code — that is
 * what keeps prompt selection auditable.
 */

export const PIPELINE_PROMPTS: Readonly<Record<PipelineStep, AnyPromptDefinition>> = {
  CONTEXT_SUMMARY: contextSummaryPrompt,
  HISTORY_FRAMING: historyFramingPrompt,
  ANGLE_IDEATION: angleIdeationPrompt,
  ANGLE_DISTINCTNESS: angleDistinctnessPrompt,
  OFFER_DEVELOPMENT: offerDevelopmentPrompt,
  CORE_MESSAGE: coreMessagePrompt,
  CREATIVE_CONCEPTION: creativeConceptionPrompt,
  META_COPY: metaCopyPrompt,
  FUNNEL_STRATEGY: funnelStrategyPrompt,
  FUNNEL_SPEC: funnelSpecPrompt,
  CLAIM_GUARDRAIL_CHECK: claimReviewPrompt,
  CAMPAIGN_PACKAGE: campaignPackagePrompt,
};

export const STANDALONE_PROMPTS: readonly AnyPromptDefinition[] = [metricExplanationPrompt];

export const ALL_PROMPTS: readonly AnyPromptDefinition[] = [
  ...Object.values(PIPELINE_PROMPTS),
  ...STANDALONE_PROMPTS,
];

const BY_ID: ReadonlyMap<string, AnyPromptDefinition> = new Map(
  ALL_PROMPTS.map((prompt) => [prompt.id, prompt]),
);

export function getPromptForStep(step: PipelineStep): AnyPromptDefinition {
  return PIPELINE_PROMPTS[step];
}

export function getPromptById(id: string): AnyPromptDefinition {
  const prompt = BY_ID.get(id);
  if (!prompt) {
    throw new DomainError('NOT_FOUND', {
      messageDe: 'Der angeforderte Prompt ist nicht registriert.',
      details: { promptId: id },
    });
  }
  return prompt;
}

export interface PromptRegistryEntry {
  id: string;
  version: string;
  step: PipelineStep | null;
  capability: AnyPromptDefinition['capability'];
  contentHash: string;
  fingerprint: string;
  purposeDe: string;
}

/**
 * A serialisable view of the registry — rendered in the console's prompt list
 * and compared against the `prompt_version` recorded on an `ai_jobs` row.
 */
export function listPrompts(): PromptRegistryEntry[] {
  return ALL_PROMPTS.map((prompt) => ({
    id: prompt.id,
    version: prompt.version,
    step: prompt.step,
    capability: prompt.capability,
    contentHash: promptContentHash(prompt),
    fingerprint: promptFingerprint(prompt),
    purposeDe: prompt.purposeDe,
  }));
}

export { metricExplanationPrompt };
