import { z } from 'zod';
import {
  commandStateSchema,
  dataMaturitySchema,
  recommendationActionSchema,
  recommendationStateSchema,
  riskLevelSchema,
} from './enums';
import { uuidSchema } from './ids';
import { metricKeySchema, type rateSchema } from './metrics';
import { isoTimestampSchema } from './primitives';

/**
 * A single piece of computed evidence behind a recommendation. Numerator and
 * denominator are mandatory so the console never shows a bare percentage
 * (acceptance criteria 19 and 21).
 */
export const recommendationFactSchema = z.object({
  metric: metricKeySchema,
  label: z.string().min(1).max(160),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  value: z.number().nullable(),
  currency: z.string().max(3).nullable().default(null),
  /** What the value is being judged against — a target, control arm or period. */
  comparisonLabel: z.string().max(160).nullable().default(null),
  comparisonValue: z.number().nullable().default(null),
});
export type RecommendationFact = z.infer<typeof recommendationFactSchema>;

/** The concrete external objects a recommendation would touch, if executed. */
export const affectedMetaObjectSchema = z.object({
  level: z.enum(['CAMPAIGN', 'ADSET', 'AD']),
  external_id: z.string().max(64),
  name: z.string().max(300),
  currentStatus: z.string().max(40).nullable().default(null),
  currentDailyBudgetMinor: z.number().int().nullable().default(null),
  proposedDailyBudgetMinor: z.number().int().nullable().default(null),
});
export type AffectedMetaObject = z.infer<typeof affectedMetaObjectSchema>;

/**
 * A recommendation is produced by the deterministic rules engine. The action
 * and every number originate from computed data; the AI layer may only add
 * `explanationDe` and `nextHypothesis` (spec §25).
 */
export const recommendationSchema = z.object({
  id: uuidSchema,
  campaign_id: uuidSchema,
  experiment_id: uuidSchema.nullable().default(null),
  created_at: isoTimestampSchema,

  action: recommendationActionSchema,
  state: recommendationStateSchema.default('OPEN'),
  /** Rule that fired, e.g. `PAUSE_NO_LEAD_ABOVE_1_5X_TARGET_CPL`. */
  ruleId: z.string().min(1).max(80),
  titleDe: z.string().min(1).max(200),
  /** Deterministic, data-derived summary. Always present. */
  summaryDe: z.string().min(1).max(1200),
  /**
   * Optional model-written explanation. Never a source of numbers — the console
   * renders it visually separated and labelled as an AI explanation.
   */
  explanationDe: z.string().max(2000).nullable().default(null),
  nextHypothesisDe: z.string().max(1000).nullable().default(null),

  facts: z.array(recommendationFactSchema).min(1),
  comparisonBasisDe: z.string().min(1).max(400),
  maturity: dataMaturitySchema,
  attributionCoverage: z.number().min(0).max(1).nullable().default(null),
  /** Statistical uncertainty statement, e.g. a credible interval or "n/a". */
  uncertaintyDe: z.string().min(1).max(400),

  risk: riskLevelSchema,
  riskNoteDe: z.string().max(600).nullable().default(null),

  affectedMetaObjects: z.array(affectedMetaObjectSchema).default([]),
  /** Budget delta, when the action changes spend. */
  proposedBudgetChangePct: z.number().nullable().default(null),

  /** Set once the operator confirms and the command is dispatched. */
  execution: z
    .object({
      command_state: commandStateSchema,
      executed_at: isoTimestampSchema.nullable(),
      executed_by: uuidSchema.nullable(),
      provider_confirmed_at: isoTimestampSchema.nullable(),
      error: z.string().max(1000).nullable(),
    })
    .nullable()
    .default(null),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const RECOMMENDATION_ACTION_LABELS_DE: Readonly<
  Record<z.infer<typeof recommendationActionSchema>, string>
> = {
  CONTINUE: 'Weiterlaufen lassen',
  PAUSE_CREATIVE: 'Creative pausieren',
  PAUSE_FUNNEL_ARM: 'Funnelarm pausieren',
  INCREASE_BUDGET: 'Budget erhöhen',
  DECREASE_BUDGET: 'Budget reduzieren',
  CONCLUDE_EXPERIMENT: 'Experiment beenden',
  NEW_CREATIVE_ITERATION: 'Neue Creative-Iteration',
  TEST_NEW_ANGLE: 'Neuen Angle testen',
  KEEP_OFFER_CHANGE_MESSAGING: 'Offer beibehalten, Kommunikation wechseln',
  COLLECT_MORE_DATA: 'Mehr Daten sammeln',
};

/**
 * Initial rule configuration (spec §25). Every threshold is persisted in
 * Settings; these are the seed values.
 */
export const recommendationConfigSchema = z.object({
  /** Pause warning when spend exceeds this multiple of target CPL with 0 leads. */
  noLeadSpendMultiple: z.number().min(0).default(1.5),
  /** Pause warning when spend exceeds this multiple of target cost/qual. VQ. */
  noQualifiedVqSpendMultiple: z.number().min(0).default(2.0),
  /** Default scale step. */
  scaleStepPct: z.number().min(0).max(1).default(0.2),
  /** Minimum hours between two scale actions on the same object. */
  scaleCooldownHours: z.number().int().min(0).default(24),
  /** Scale is blocked while CRM outcomes are not mature. */
  requireMatureCrmForScale: z.boolean().default(true),
  /** Minimum leads before any leading-indicator recommendation is emitted. */
  minLeadsForLeadingSignals: z.number().int().min(0).default(5),
});
export type RecommendationConfig = z.infer<typeof recommendationConfigSchema>;

export const DEFAULT_RECOMMENDATION_CONFIG: RecommendationConfig = {
  noLeadSpendMultiple: 1.5,
  noQualifiedVqSpendMultiple: 2.0,
  scaleStepPct: 0.2,
  scaleCooldownHours: 24,
  requireMatureCrmForScale: true,
  minLeadsForLeadingSignals: 5,
};

/** Convenience constructor keeping numerator/denominator discipline. */
export function factFromRate(
  metric: z.infer<typeof metricKeySchema>,
  label: string,
  r: z.infer<typeof rateSchema>,
  comparison?: { label: string; value: number },
): RecommendationFact {
  return {
    metric,
    label,
    numerator: r.numerator,
    denominator: r.denominator,
    value: r.value,
    currency: null,
    comparisonLabel: comparison?.label ?? null,
    comparisonValue: comparison?.value ?? null,
  };
}
