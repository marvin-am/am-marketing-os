import { type z } from 'zod';
import { shortHash, stableJson } from '../hash';
import { zodToStrictJsonSchema } from '../json-schema';

/**
 * Versioned prompt registry types.
 *
 * A prompt is a *record*, not a string constant, because an `ai_jobs` row has
 * to be able to say exactly which prompt produced an output — long after the
 * prompt has been edited. Version plus content hash gives that: the version is
 * bumped deliberately, the hash catches every edit, deliberate or not.
 */

export const PIPELINE_STEPS = [
  'CONTEXT_SUMMARY',
  'HISTORY_FRAMING',
  'ANGLE_IDEATION',
  'ANGLE_DISTINCTNESS',
  'OFFER_DEVELOPMENT',
  'CORE_MESSAGE',
  'CREATIVE_CONCEPTION',
  'META_COPY',
  'FUNNEL_STRATEGY',
  'FUNNEL_SPEC',
  'CLAIM_GUARDRAIL_CHECK',
  'CAMPAIGN_PACKAGE',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** Step order is the pipeline order; index + 1 is the number used in the UI. */
export const PIPELINE_STEP_ORDER: Readonly<Record<PipelineStep, number>> = Object.fromEntries(
  PIPELINE_STEPS.map((step, index) => [step, index + 1]),
) as Record<PipelineStep, number>;

export const PIPELINE_STEP_LABELS_DE: Readonly<Record<PipelineStep, string>> = {
  CONTEXT_SUMMARY: 'Kontext zusammenfassen',
  HISTORY_FRAMING: 'Historische Ähnlichkeitssuche vorbereiten',
  ANGLE_IDEATION: 'Angles entwickeln',
  ANGLE_DISTINCTNESS: 'Angle-Eigenständigkeit prüfen',
  OFFER_DEVELOPMENT: 'Angebot ausarbeiten',
  CORE_MESSAGE: 'Kernbotschaft formulieren',
  CREATIVE_CONCEPTION: 'Creative-Konzepte entwickeln',
  META_COPY: 'Meta-Texte schreiben',
  FUNNEL_STRATEGY: 'Funnel-Strategie festlegen',
  FUNNEL_SPEC: 'Funnel-Spezifikation erzeugen',
  CLAIM_GUARDRAIL_CHECK: 'Claims und Guardrails prüfen',
  CAMPAIGN_PACKAGE: 'Kampagnenpaket finalisieren',
};

export type PromptCapability = 'TEXT' | 'IMAGE' | 'EMBEDDING';

export interface PromptDefinition<TInput, TOutput> {
  /** Stable, dot-separated identifier. Never reused for different content. */
  id: string;
  /** Bumped by hand whenever the intent of the prompt changes. */
  version: string;
  capability: PromptCapability;
  /** The pipeline step this prompt serves; `null` for standalone helpers. */
  step: PipelineStep | null;
  /** English instruction; the *generated content* is German. */
  systemPrompt: string;
  buildUserPrompt(input: TInput): string;
  outputSchema: z.ZodType<TOutput>;
  /** Omitted for reasoning models, which reject the parameter. */
  temperature?: number;
  /** Short German note shown in the console next to a generation. */
  purposeDe: string;
}

/** Convenience alias for a registry entry whose types are not yet narrowed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPromptDefinition = PromptDefinition<any, any>;

/**
 * Content hash of everything that can change what a model sees: the system
 * prompt, the user-prompt builder's source and the emitted JSON Schema.
 * Recorded on `ai_jobs` so a stale output can be spotted after a prompt edit
 * that did not come with a version bump.
 */
export function promptContentHash(prompt: AnyPromptDefinition): string {
  return shortHash(
    stableJson({
      id: prompt.id,
      version: prompt.version,
      system: prompt.systemPrompt,
      builder: prompt.buildUserPrompt.toString(),
      schema: zodToStrictJsonSchema(prompt.outputSchema),
      temperature: prompt.temperature ?? null,
    }),
    16,
  );
}

/** `id@version#hash` — the exact string persisted on an `ai_jobs` row. */
export function promptFingerprint(prompt: AnyPromptDefinition): string {
  return `${prompt.id}@${prompt.version}#${promptContentHash(prompt)}`;
}
