import { z } from 'zod';
import {
  type campaignErrorStateSchema,
  type campaignStateSchema,
  confidenceLabelSchema,
  creativePrincipleSchema,
  evidenceKindSchema,
  funnelKindSchema,
  aspectRatioSchema,
} from './enums';
import { uuidSchema } from './ids';
import { metricDefinitionSchema, metricKeySchema } from './metrics';
import { currencySchema, shortTextSchema } from './primitives';

/* -------------------------------------------------------------------------- */
/* State machine                                                               */
/* -------------------------------------------------------------------------- */

type CampaignState = z.infer<typeof campaignStateSchema>;

/**
 * Legal business-state transitions (spec §10). Error states are *not* part of
 * this graph — they are recorded on a separate column so a failed Meta sync can
 * never erase the fact that a campaign is STRATEGY_APPROVED.
 */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignState, readonly CampaignState[]>> = {
  IDEA: ['PROPOSED', 'ARCHIVED'],
  PROPOSED: ['STRATEGY_REVIEW', 'IDEA', 'ARCHIVED'],
  STRATEGY_REVIEW: ['STRATEGY_APPROVED', 'PROPOSED', 'ARCHIVED'],
  STRATEGY_APPROVED: ['ASSET_GENERATION', 'STRATEGY_REVIEW', 'ARCHIVED'],
  ASSET_GENERATION: ['ASSET_REVIEW', 'STRATEGY_APPROVED', 'ARCHIVED'],
  ASSET_REVIEW: ['TEST_PLAN_REVIEW', 'ASSET_GENERATION', 'ARCHIVED'],
  TEST_PLAN_REVIEW: ['READY_FOR_LAUNCH_QA', 'ASSET_REVIEW', 'ARCHIVED'],
  READY_FOR_LAUNCH_QA: ['READY_FOR_META_DRAFT', 'TEST_PLAN_REVIEW', 'ARCHIVED'],
  READY_FOR_META_DRAFT: ['META_DRAFT_CREATED', 'READY_FOR_LAUNCH_QA', 'ARCHIVED'],
  META_DRAFT_CREATED: ['SCHEDULED', 'LIVE', 'READY_FOR_META_DRAFT', 'ARCHIVED'],
  SCHEDULED: ['LIVE', 'META_DRAFT_CREATED', 'ARCHIVED'],
  LIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['LIVE', 'COMPLETED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransition(from: CampaignState, to: CampaignState): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function nextStates(from: CampaignState): readonly CampaignState[] {
  return CAMPAIGN_TRANSITIONS[from];
}

/** German labels used across the console. Code stays English, UI stays German. */
export const CAMPAIGN_STATE_LABELS_DE: Readonly<Record<CampaignState, string>> = {
  IDEA: 'Idee',
  PROPOSED: 'Vorgeschlagen',
  STRATEGY_REVIEW: 'Strategie in Prüfung',
  STRATEGY_APPROVED: 'Strategie freigegeben',
  ASSET_GENERATION: 'Assets werden erzeugt',
  ASSET_REVIEW: 'Assets in Prüfung',
  TEST_PLAN_REVIEW: 'Testplan in Prüfung',
  READY_FOR_LAUNCH_QA: 'Bereit für Launch-QA',
  READY_FOR_META_DRAFT: 'Bereit für Meta-Entwurf',
  META_DRAFT_CREATED: 'Meta-Entwurf erstellt (pausiert)',
  SCHEDULED: 'Geplant',
  LIVE: 'Live',
  PAUSED: 'Pausiert',
  COMPLETED: 'Abgeschlossen',
  ARCHIVED: 'Archiviert',
};

export const CAMPAIGN_ERROR_LABELS_DE: Readonly<
  Record<z.infer<typeof campaignErrorStateSchema>, string>
> = {
  GENERATION_FAILED: 'Generierung fehlgeschlagen',
  PUBLISH_FAILED: 'Veröffentlichung fehlgeschlagen',
  META_SYNC_FAILED: 'Meta-Synchronisation fehlgeschlagen',
  TRACKING_FAILED: 'Tracking fehlerhaft',
  HUBSPOT_SYNC_FAILED: 'HubSpot-Synchronisation fehlgeschlagen',
};

/* -------------------------------------------------------------------------- */
/* Proposal building blocks                                                    */
/* -------------------------------------------------------------------------- */

export const audienceSpecSchema = z.object({
  /** Short internal name, e.g. "Geschäftsführung Handwerk 10–50 MA". */
  name: shortTextSchema,
  description: z.string().min(20).max(1200),
  /** Reference to an approved ICP where one exists. */
  audienceSegmentId: uuidSchema.nullable().default(null),
  companySizeRange: z.string().max(120).nullable().default(null),
  industries: z.array(z.string().max(120)).max(20).default([]),
  roles: z.array(z.string().max(120)).max(20).default([]),
  /** Region targeting expressed in business terms, not Meta ids. */
  geo: z.string().max(200).default('Deutschland'),
  painPoints: z.array(z.string().max(300)).min(1).max(10),
  exclusions: z.array(z.string().max(300)).max(10).default([]),
});
export type AudienceSpec = z.infer<typeof audienceSpecSchema>;

export const angleSpecSchema = z.object({
  /** The perspective through which problem and solution are viewed. */
  name: shortTextSchema,
  /** One-sentence statement of the perspective itself, not the offer. */
  perspective: z.string().min(20).max(600),
  rationale: z.string().min(20).max(1200),
  /** Terms that make this angle findable in the historical vector index. */
  keywords: z.array(z.string().max(60)).min(2).max(12),
});
export type AngleSpec = z.infer<typeof angleSpecSchema>;

export const OFFER_TYPES = [
  'POTENTIAL_ANALYSIS',
  'BENCHMARK',
  'AUDIT',
  'STRATEGY_CALL',
  'CALCULATOR',
  'CHECKLIST',
  'LEAD_MAGNET',
] as const;
export const offerTypeSchema = z.enum(OFFER_TYPES);
export type OfferType = z.infer<typeof offerTypeSchema>;

export const OFFER_TYPE_LABELS_DE: Readonly<Record<OfferType, string>> = {
  POTENTIAL_ANALYSIS: 'Kostenlose Potenzialanalyse',
  BENCHMARK: 'Benchmark',
  AUDIT: 'Individueller Audit',
  STRATEGY_CALL: 'Strategiegespräch',
  CALCULATOR: 'Rechner',
  CHECKLIST: 'Checkliste',
  LEAD_MAGNET: 'Lead Magnet',
};

export const offerSpecSchema = z.object({
  name: shortTextSchema,
  type: offerTypeSchema,
  /** What the prospect actually receives in exchange for their data. */
  valueExchange: z.string().min(20).max(800),
  deliverable: z.string().min(10).max(600),
  /** Effort/time promise shown on the funnel, e.g. "2 Minuten". */
  effortPromise: z.string().max(120).nullable().default(null),
  qualificationIntent: z.string().min(10).max(600),
});
export type OfferSpec = z.infer<typeof offerSpecSchema>;

export const evidenceReferenceSchema = z.object({
  /** Id of the approved evidence item, case study, testimonial or campaign. */
  evidenceItemId: uuidSchema.nullable().default(null),
  kind: evidenceKindSchema,
  summary: z.string().min(5).max(600),
  /** Where this came from — a campaign id, a document, an approved statistic. */
  sourceRef: z.string().max(200).nullable().default(null),
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const claimSpecSchema = z.object({
  text: z.string().min(5).max(400),
  /**
   * Either the claim is backed by an evidence reference, or it is explicitly
   * flagged as a hypothesis. `claimSpecSchema` enforces exactly that (spec §9).
   */
  evidence: evidenceReferenceSchema.nullable().default(null),
  confidence: confidenceLabelSchema,
  /** Set when the claim is unsupported and must be rendered as a hypothesis. */
  requiresHypothesisLabel: z.boolean().default(false),
});
export type ClaimSpec = z.infer<typeof claimSpecSchema>;

export const claimSpecStrictSchema = claimSpecSchema.refine(
  (c) => c.evidence !== null || c.requiresHypothesisLabel || c.confidence === 'HYPOTHESIS',
  {
    message:
      'Jeder Claim benötigt entweder eine Evidence-Referenz oder die Kennzeichnung als Hypothese.',
    path: ['evidence'],
  },
);

export const similarCampaignReferenceSchema = z.object({
  campaignId: uuidSchema,
  campaignName: z.string().max(200),
  /** Cosine similarity of the angle embedding, 0..1. */
  similarity: z.number().min(0).max(1),
  ranAt: z.string().max(40).nullable().default(null),
  outcomeSummary: z.string().max(600).nullable().default(null),
  attributionLevel: z.string().max(40).nullable().default(null),
});
export type SimilarCampaignReference = z.infer<typeof similarCampaignReferenceSchema>;

/* -------------------------------------------------------------------------- */
/* Creative concepts                                                           */
/* -------------------------------------------------------------------------- */

export const metaCopySchema = z.object({
  /** Meta primary text. Kept well below the truncation threshold. */
  primaryText: z.string().min(30).max(500),
  headline: z.string().min(5).max(60),
  description: z.string().min(5).max(120),
  callToAction: z.string().min(2).max(40),
});
export type MetaCopy = z.infer<typeof metaCopySchema>;

export const creativeConceptSchema = z.object({
  /** Stable key inside the proposal so arms can reference it before ids exist. */
  key: z.string().regex(/^concept_[1-9][0-9]?$/),
  name: shortTextSchema,
  principle: creativePrincipleSchema,
  /** The visual idea in words — what a designer would sketch. */
  visualIdea: z.string().min(30).max(1000),
  /**
   * Prompt for the base motif. Must not request logos, headlines or UI text:
   * all typography is composed deterministically afterwards (spec §13).
   */
  imagePrompt: z.string().min(30).max(2000),
  copy: metaCopySchema,
  /** Why this concept should work — the testable assumption. */
  hypothesis: z.string().min(20).max(800),
  rationale: z.string().min(20).max(1000),
  /** Which proof this concept leans on, if any. */
  proofUsed: z.string().max(400).nullable().default(null),
  /** The promise the funnel must keep after the click. */
  funnelPromise: z.string().min(10).max(400),
  altText: z.string().min(10).max(300),
  aspectRatios: z.array(aspectRatioSchema).min(2).default(['1:1', '4:5']),
  claims: z.array(claimSpecSchema).max(10).default([]),
});
export type CreativeConcept = z.infer<typeof creativeConceptSchema>;

/* -------------------------------------------------------------------------- */
/* Funnel proposals                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Strategy-level funnel proposal (pipeline step 9). The concrete
 * `MultiStepFormSpec` / `LandingPageSpec` is generated in step 10 by
 * `@am/funnel-schema` and attached to the funnel version — keeping this package
 * free of a circular dependency.
 */
export const funnelProposalSchema = z.object({
  key: z.string().regex(/^funnel_[1-9]$/),
  kind: funnelKindSchema,
  name: shortTextSchema,
  rationale: z.string().min(20).max(1000),
  hypothesis: z.string().min(20).max(800),
  /** Headline promise the funnel opens with. */
  promise: z.string().min(10).max(300),
  /** Number of qualification questions for MULTI_STEP_FORM (4..7, default 5). */
  qualificationQuestionCount: z.number().int().min(4).max(7).default(5),
  /** Outline of the qualification questions in business language. */
  questionOutline: z.array(z.string().min(5).max(300)).max(7).default([]),
  resultConcept: z.string().min(10).max(600),
});
export type FunnelProposal = z.infer<typeof funnelProposalSchema>;

/* -------------------------------------------------------------------------- */
/* Experiment plan and budget                                                  */
/* -------------------------------------------------------------------------- */

export const experimentPlanSchema = z.object({
  kind: z.enum(['CREATIVE_EXPLORATION', 'FUNNEL_EXPERIMENT', 'BUNDLED_FUNNEL_TEST']),
  hypothesis: z.string().min(20).max(800),
  /** The single variable under test. */
  testVariable: z.string().min(3).max(200),
  controlKey: z.string().min(1).max(60),
  variantKeys: z.array(z.string().min(1).max(60)).min(1).max(8),
  primaryMetric: metricKeySchema,
  secondaryMetrics: z.array(metricKeySchema).max(8).default([]),
  guardrailMetrics: z.array(metricKeySchema).max(8).default([]),
  minRuntimeDays: z.number().int().min(1).max(90).default(7),
  maxRuntimeDays: z.number().int().min(1).max(180).default(21),
  minSessionsPerArm: z.number().int().min(1).default(200),
  minConversionsPerArm: z.number().int().min(1).default(20),
  /** Days to wait before CRM outcomes for this cohort count as mature. */
  crmMaturityDays: z.number().int().min(0).max(180).default(21),
  stopRules: z.array(z.string().min(5).max(400)).min(1).max(10),
  scaleRules: z.array(z.string().min(5).max(400)).min(1).max(10),
  /** Set when eligibility questions change — results are not comparable. */
  eligibilityChanging: z.boolean().default(false),
});
export type ExperimentPlan = z.infer<typeof experimentPlanSchema>;

export const budgetProposalSchema = z.object({
  dailyBudgetMinor: z.number().int().min(0),
  currency: currencySchema.default('EUR'),
  /** Total budget the test is expected to consume before a decision. */
  testBudgetMinor: z.number().int().min(0),
  rationale: z.string().min(10).max(800),
  targetCplMinor: z.number().int().min(0).nullable().default(null),
  targetCostPerQualifiedVqMinor: z.number().int().min(0).nullable().default(null),
});
export type BudgetProposal = z.infer<typeof budgetProposalSchema>;

/* -------------------------------------------------------------------------- */
/* CampaignProposal                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The structured output of the AI campaign pipeline (spec §12). Validated by
 * this schema at the provider boundary — an unparseable model response is a
 * failed job, never a partially applied proposal.
 */
export const campaignProposalSchema = z.object({
  campaignName: shortTextSchema,
  audience: audienceSpecSchema,
  angle: angleSpecSchema,
  offer: offerSpecSchema,
  coreMessage: z.string().min(20).max(600),
  hypothesis: z.string().min(20).max(1000),
  historicalEvidence: z.array(evidenceReferenceSchema).max(20).default([]),
  similarPastCampaigns: z.array(similarCampaignReferenceSchema).max(20).default([]),
  differentiationFromPast: z.string().min(20).max(1500),
  claims: z.array(claimSpecSchema).max(20).default([]),
  risks: z.array(z.string().min(5).max(500)).max(15).default([]),
  creativeConcepts: z.array(creativeConceptSchema).min(5).max(8),
  funnelProposals: z.array(funnelProposalSchema).min(2).max(4),
  experimentPlan: experimentPlanSchema,
  primaryMetric: metricDefinitionSchema,
  secondaryMetrics: z.array(metricDefinitionSchema).max(8).default([]),
  guardrailMetrics: z.array(metricDefinitionSchema).max(8).default([]),
  recommendedBudget: budgetProposalSchema,
});
export type CampaignProposal = z.infer<typeof campaignProposalSchema>;

/**
 * Generation defaults (spec §12). Six concepts by default, never fewer than
 * five approved before launch; at least two MULTI_STEP_FORM funnel variants.
 */
export const GENERATION_DEFAULTS = {
  creativeConceptCount: 6,
  minApprovedCreatives: 5,
  funnelVariantCount: 3,
  minMultiStepFormVariants: 2,
  defaultQualificationQuestions: 5,
  minQualificationQuestions: 4,
  maxQualificationQuestions: 7,
} as const;

/**
 * Structural check on the funnel mix required before a proposal may be
 * accepted. Deliberately a plain function, not a zod refinement, so the console
 * can surface a precise German reason for each violation.
 */
export function validateFunnelMix(proposals: readonly FunnelProposal[]): string[] {
  const problems: string[] = [];
  if (proposals.length < 2) {
    problems.push('Es müssen mindestens zwei Funnel-Varianten vorgeschlagen werden.');
  }
  const multiStep = proposals.filter((p) => p.kind === 'MULTI_STEP_FORM').length;
  if (multiStep < GENERATION_DEFAULTS.minMultiStepFormVariants) {
    problems.push(
      `Mindestens ${GENERATION_DEFAULTS.minMultiStepFormVariants} Varianten müssen vom Typ MULTI_STEP_FORM sein (aktuell ${multiStep}).`,
    );
  }
  const keys = new Set(proposals.map((p) => p.key));
  if (keys.size !== proposals.length) {
    problems.push('Funnel-Schlüssel müssen eindeutig sein.');
  }
  return problems;
}
