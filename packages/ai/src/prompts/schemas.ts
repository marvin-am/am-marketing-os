import {
  angleSpecSchema,
  audienceSpecSchema,
  claimSpecSchema,
  confidenceLabelSchema,
  creativeConceptSchema,
  creativePrincipleSchema,
  experimentKindSchema,
  fieldTypeSchema,
  funnelKindSchema,
  funnelProposalSchema,
  metaCopySchema,
  metricKeySchema,
  offerSpecSchema,
  piiClassSchema,
  qualificationClassSchema,
  shortTextSchema,
  specKeySchema,
} from '@am/domain';
import { z } from 'zod';

/**
 * Output contracts for the twelve pipeline steps.
 *
 * Each schema is the single authority for its step: it drives the strict JSON
 * Schema sent to the Responses API, the validation of what comes back and the
 * TypeScript type the pipeline threads onward. Domain schemas are reused
 * wherever the step really does produce a domain object, so an accepted output
 * needs no translation layer that could drift.
 *
 * Numbers are conspicuously absent from these contracts. Budgets, runtimes,
 * sample sizes and thresholds are computed deterministically by the pipeline —
 * the model may name a metric and argue for a stop rule, never state a figure
 * (AGENTS.md rule 4).
 */

const conceptKeySchema = z.string().regex(/^concept_[1-9][0-9]?$/);

/* -------------------------------------------------------------------------- */
/* 1 — Context summarisation                                                   */
/* -------------------------------------------------------------------------- */

export const contextSummarySchema = z.object({
  brandSummaryDe: z.string().min(40).max(1500),
  audienceSummaryDe: z.string().min(40).max(1500),
  offerLandscapeDe: z.string().min(40).max(1500),
  approvedFacts: z
    .array(
      z.object({
        statementDe: z.string().min(5).max(400),
        sourceRef: z.string().max(200).nullable(),
        confidence: confidenceLabelSchema,
      }),
    )
    .max(20),
  guardrailNotesDe: z.array(z.string().min(5).max(300)).max(20),
  openQuestionsDe: z.array(z.string().min(5).max(300)).max(10),
});
export type ContextSummary = z.infer<typeof contextSummarySchema>;

/* -------------------------------------------------------------------------- */
/* 2 — Historical similarity search framing                                    */
/* -------------------------------------------------------------------------- */

export const historyFramingSchema = z.object({
  /** Retrieval probes — embedded verbatim, so they must read like real angles. */
  queryTextsDe: z.array(z.string().min(10).max(300)).min(2).max(6),
  focusDe: z.string().min(20).max(600),
  exclusionsDe: z.array(z.string().min(3).max(200)).max(10),
});
export type HistoryFraming = z.infer<typeof historyFramingSchema>;

/* -------------------------------------------------------------------------- */
/* 3 — Angle ideation                                                          */
/* -------------------------------------------------------------------------- */

export const angleIdeationSchema = z.object({
  angles: z.array(angleSpecSchema).min(3).max(6),
  recommendedAngleName: shortTextSchema,
  rationaleDe: z.string().min(20).max(1200),
});
export type AngleIdeation = z.infer<typeof angleIdeationSchema>;

/* -------------------------------------------------------------------------- */
/* 4 — Angle distinctness review                                               */
/* -------------------------------------------------------------------------- */

export const angleDistinctnessReviewSchema = z.object({
  differentiationDe: z.string().min(20).max(1200),
  /** A sharpened variant when the candidate was too close to a past angle. */
  sharpenedAngle: angleSpecSchema.nullable(),
  adjustmentsDe: z.array(z.string().min(5).max(300)).max(8),
});
export type AngleDistinctnessReview = z.infer<typeof angleDistinctnessReviewSchema>;

/* -------------------------------------------------------------------------- */
/* 5 — Offer development                                                       */
/* -------------------------------------------------------------------------- */

export const offerDevelopmentSchema = z.object({
  offer: offerSpecSchema,
  rationaleDe: z.string().min(20).max(1200),
  alternativesDe: z.array(z.string().min(5).max(300)).max(5),
});
export type OfferDevelopment = z.infer<typeof offerDevelopmentSchema>;

/* -------------------------------------------------------------------------- */
/* 6 — Core message                                                            */
/* -------------------------------------------------------------------------- */

export const coreMessageSchema = z.object({
  coreMessageDe: z.string().min(20).max(600),
  hypothesisDe: z.string().min(20).max(1000),
  proofPointsDe: z.array(z.string().min(5).max(300)).max(8),
  toneNotesDe: z.string().min(10).max(600),
});
export type CoreMessage = z.infer<typeof coreMessageSchema>;

/* -------------------------------------------------------------------------- */
/* 7 — Creative conception                                                     */
/* -------------------------------------------------------------------------- */

/** A concept before copywriting: the idea, the motif and the promise. */
export const creativeConceptDraftSchema = creativeConceptSchema.omit({
  copy: true,
  claims: true,
});
export type CreativeConceptDraft = z.infer<typeof creativeConceptDraftSchema>;

export const creativeConceptionSchema = z.object({
  concepts: z.array(creativeConceptDraftSchema).min(5).max(8),
  diversityNotesDe: z.array(z.string().min(5).max(300)).max(10),
});
export type CreativeConception = z.infer<typeof creativeConceptionSchema>;

/* -------------------------------------------------------------------------- */
/* 8 — Meta copy                                                               */
/* -------------------------------------------------------------------------- */

export const metaCopySetSchema = z.object({
  copies: z
    .array(z.object({ conceptKey: conceptKeySchema, copy: metaCopySchema }))
    .min(5)
    .max(8),
});
export type MetaCopySet = z.infer<typeof metaCopySetSchema>;

/* -------------------------------------------------------------------------- */
/* 9 — Funnel strategy                                                         */
/* -------------------------------------------------------------------------- */

export const funnelStrategySchema = z.object({
  funnels: z.array(funnelProposalSchema).min(2).max(4),
  rationaleDe: z.string().min(20).max(1200),
});
export type FunnelStrategy = z.infer<typeof funnelStrategySchema>;

/* -------------------------------------------------------------------------- */
/* 10 — Funnel spec draft                                                      */
/* -------------------------------------------------------------------------- */

export const SECTION_KINDS = [
  'HERO',
  'PROBLEM',
  'BENEFITS',
  'PROOF',
  'PROCESS',
  'FAQ',
  'CTA',
] as const;
export const sectionKindSchema = z.enum(SECTION_KINDS);

export const funnelSectionDraftSchema = z.object({
  kind: sectionKindSchema,
  headlineDe: z.string().min(3).max(160),
  bodyDe: z.string().min(10).max(1200),
  bulletsDe: z.array(z.string().min(3).max(200)).max(6),
});

export const funnelFieldDraftSchema = z.object({
  key: specKeySchema,
  labelDe: z.string().min(3).max(200),
  type: fieldTypeSchema,
  required: z.boolean(),
  helpTextDe: z.string().max(300).nullable(),
  options: z.array(z.object({ key: specKeySchema, labelDe: z.string().min(1).max(160) })).max(12),
  qualification: qualificationClassSchema,
  piiClass: piiClassSchema,
});

export const funnelStepDraftSchema = z.object({
  key: specKeySchema,
  titleDe: z.string().min(3).max(200),
  helpTextDe: z.string().max(400).nullable(),
  fields: z.array(funnelFieldDraftSchema).min(1).max(6),
});

/**
 * A renderer-agnostic funnel draft. The model describes structure and German
 * copy; it never emits HTML, CSS or JS (AGENTS.md rule 5). `@am/funnel-schema`
 * turns this into the concrete `LandingPageSpec` / `MultiStepFormSpec`.
 */
export const funnelSpecDraftSchema = z.object({
  funnelKey: z.string().regex(/^funnel_[1-9]$/),
  kind: funnelKindSchema,
  headlineDe: z.string().min(5).max(200),
  subheadlineDe: z.string().min(5).max(300),
  sections: z.array(funnelSectionDraftSchema).min(2).max(8),
  steps: z.array(funnelStepDraftSchema).max(8),
  ctaLabelDe: z.string().min(2).max(60),
  consentTextDe: z.string().min(20).max(1000),
  resultScreenDe: z.string().min(20).max(1000),
});
export type FunnelSpecDraft = z.infer<typeof funnelSpecDraftSchema>;

/* -------------------------------------------------------------------------- */
/* 11 — Claims and guardrails                                                  */
/* -------------------------------------------------------------------------- */

export const guardrailViolationSchema = z.object({
  severity: z.enum(['BLOCK', 'WARN']),
  ruleRef: z.string().max(200).nullable(),
  quote: z.string().min(1).max(400),
  reasonDe: z.string().min(5).max(600),
});
export type GuardrailViolation = z.infer<typeof guardrailViolationSchema>;

export const claimReviewSchema = z.object({
  claims: z.array(claimSpecSchema).max(20),
  violations: z.array(guardrailViolationSchema).max(20),
  risksDe: z.array(z.string().min(5).max(500)).max(15),
  /** The model's read; the pipeline recomputes it from `violations`. */
  blocked: z.boolean(),
});
export type ClaimReview = z.infer<typeof claimReviewSchema>;

/* -------------------------------------------------------------------------- */
/* 12 — Final campaign package                                                 */
/* -------------------------------------------------------------------------- */

export const campaignPackageSchema = z.object({
  campaignName: shortTextSchema,
  audience: audienceSpecSchema,
  differentiationFromPast: z.string().min(20).max(1500),
  risks: z.array(z.string().min(5).max(500)).max(15),
  experimentKind: experimentKindSchema,
  experimentHypothesisDe: z.string().min(20).max(800),
  testVariableDe: z.string().min(3).max(200),
  stopRulesDe: z.array(z.string().min(5).max(400)).min(1).max(10),
  scaleRulesDe: z.array(z.string().min(5).max(400)).min(1).max(10),
  primaryMetric: metricKeySchema,
  secondaryMetrics: z.array(metricKeySchema).max(8),
  guardrailMetrics: z.array(metricKeySchema).max(8),
  /** Prose only — every figure in the budget is computed, never generated. */
  budgetRationaleDe: z.string().min(10).max(800),
});
export type CampaignPackage = z.infer<typeof campaignPackageSchema>;

/* -------------------------------------------------------------------------- */
/* Narrow explanation helper (not part of the twelve-step pipeline)            */
/* -------------------------------------------------------------------------- */

export const metricExplanationSchema = z.object({
  explanationDe: z.string().min(20).max(1500),
  drivingFactorsDe: z.array(z.string().min(5).max(300)).min(1).max(6),
  nextHypothesisDe: z.string().min(20).max(600),
  nextTestDe: z.string().min(20).max(600),
  caveatDe: z.string().min(10).max(400),
});
export type MetricExplanation = z.infer<typeof metricExplanationSchema>;

/** Re-exported so consumers do not need a second import for the principle enum. */
export { creativePrincipleSchema };
