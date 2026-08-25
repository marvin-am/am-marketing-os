import type {
  AngleSpec,
  AngleVerdict,
  CreativeConcept,
  CreativePrinciple,
  FunnelProposal,
  MetricKey,
  OfferSpec,
  SimilarCampaignReference,
} from '@am/domain';
import type {
  ContextSummary,
  CoreMessage,
  CreativeConceptDraft,
  HistoryFraming,
} from './schemas';

/**
 * The only object a prompt may read from.
 *
 * `buildContext()` in `../pipeline/context` is the sole producer: it assembles
 * an `AiContextBundle` into a rendered German block and asserts that no lead,
 * CRM or PII value came along. Prompts take this type and nothing wider, so
 * there is no code path from a submission row into a model.
 */
export interface PromptContext {
  /** Rendered, PII-free German context block handed to the model verbatim. */
  contextBlock: string;
  brandName: string;
  /** Guardrail rules in German, restated in every prompt that writes copy. */
  guardrailsDe: readonly string[];
  /** The operator's brief for this campaign. */
  briefDe: string;
  /** Hash of the assembled context — recorded on the `ai_jobs` row. */
  contextHash: string;
}

export interface ContextSummaryInput {
  context: PromptContext;
}

export interface HistoryFramingInput {
  context: PromptContext;
  summary: ContextSummary;
}

export interface AngleIdeationInput {
  context: PromptContext;
  summary: ContextSummary;
  framing: HistoryFraming;
  /** Angle names already used recently — computed, not remembered by the model. */
  recentAngleNames: readonly string[];
}

export interface AngleDistinctnessInput {
  context: PromptContext;
  candidate: AngleSpec;
  /** Computed by `checkAngleDistinctness`; the model may not revise it. */
  verdict: AngleVerdict;
  verdictLabelDe: string;
  /** Names only — the raw cosine never reaches the prompt. */
  similarCampaignNames: readonly string[];
}

export interface OfferDevelopmentInput {
  context: PromptContext;
  summary: ContextSummary;
  angle: AngleSpec;
}

export interface CoreMessageInput {
  context: PromptContext;
  angle: AngleSpec;
  offer: OfferSpec;
}

export interface CreativeConceptionInput {
  context: PromptContext;
  angle: AngleSpec;
  offer: OfferSpec;
  coreMessage: CoreMessage;
  conceptCount: number;
  principles: readonly CreativePrinciple[];
  /** Set on a diversity-driven regeneration. */
  diversityFeedbackDe?: readonly string[];
}

export interface MetaCopyInput {
  context: PromptContext;
  angle: AngleSpec;
  offer: OfferSpec;
  coreMessage: CoreMessage;
  concepts: readonly CreativeConceptDraft[];
}

export interface FunnelStrategyInput {
  context: PromptContext;
  angle: AngleSpec;
  offer: OfferSpec;
  coreMessage: CoreMessage;
  funnelCount: number;
  minMultiStepForms: number;
  minQuestions: number;
  maxQuestions: number;
}

export interface FunnelSpecInput {
  context: PromptContext;
  funnel: FunnelProposal;
  offer: OfferSpec;
  coreMessage: CoreMessage;
  /** The concept whose promise this funnel has to keep after the click. */
  leadConcept: CreativeConcept | null;
}

export interface ClaimReviewInput {
  context: PromptContext;
  concepts: readonly CreativeConcept[];
  coreMessage: CoreMessage;
  offer: OfferSpec;
}

export interface CampaignPackageInput {
  context: PromptContext;
  angle: AngleSpec;
  offer: OfferSpec;
  coreMessage: CoreMessage;
  concepts: readonly CreativeConcept[];
  funnels: readonly FunnelProposal[];
  similarPastCampaigns: readonly SimilarCampaignReference[];
  /** The metric catalogue keys the model may choose from. */
  metricOptions: readonly MetricKey[];
}

export interface MetricExplanationInput {
  /** Rendered, deterministic facts. Every figure the answer may use is here. */
  factsBlockDe: string;
  questionDe: string;
}
