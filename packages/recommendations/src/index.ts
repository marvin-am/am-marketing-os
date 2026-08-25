/**
 * `@am/recommendations` — the deterministic decision engine.
 *
 * Three properties define this package:
 *
 * 1. **It proposes, it never executes.** Every output is a `Recommendation` in
 *    state `OPEN`. A human accepts it and a separate command path performs the
 *    write, subject to `EXTERNAL_WRITES_ENABLED` and role authority.
 * 2. **Every number is computed, never written by a model.** The AI layer may
 *    later attach `explanationDe` and `nextHypothesisDe`; it can never
 *    contribute a figure, a threshold or an action.
 * 3. **Same input, identical output.** Ids are derived from what a proposal is
 *    about, `now` is an input, and every ordering is total. Two runs a month
 *    apart on the same data produce the same bytes.
 *
 * The invariant that outranks the others: **no scale proposal is ever made on
 * immature CRM outcomes.** See `SCALE_BUDGET` in `rules/budget-rules.ts`.
 */

export {
  generateRecommendations,
  type RecommendationEngineResult,
  type RankedRecommendation,
} from './engine';

export {
  resolveContext,
  type RecommendationContext,
  type RuleContext,
  type PerformanceSlice,
  type ResolvedSlice,
  type CampaignTargets,
  type BudgetContext,
  type ResolvedBudgetContext,
  type ExperimentContextEntry,
} from './context';

export {
  evaluateBudgetChange,
  maxAllowedDailyBudget,
  DEFAULT_BUDGET_POLICY,
  BUDGET_REASON_CODES,
  type BudgetPolicy,
  type BudgetChangeInput,
  type BudgetDecision,
  type BudgetDecisionKind,
  type BudgetReasonCode,
  type ScaleAction,
} from './budget';

export {
  DEFAULT_RECOMMENDATION_BENCHMARKS,
  ROLE_LABELS_DE,
  roleLabelsDe,
  type RecommendationBenchmarks,
} from './config';

export { deterministicUuid, recommendationId } from './ids';

export {
  RECOMMENDATION_RULES,
  RULE_IDS,
  // Individual rules, exported so each can be tested and toggled on its own.
  PAUSE_NO_LEAD_ABOVE_TARGET_CPL,
  PAUSE_NO_QUALIFIED_VQ,
  SCALE_BUDGET,
  DECREASE_BUDGET_ON_GUARDRAIL_BREACH,
  CONCLUDE_EXPERIMENT,
  PAUSE_CREATIVE_UNDERPERFORMING,
  PAUSE_FUNNEL_ARM_UNDERPERFORMING,
  KEEP_OFFER_CHANGE_MESSAGING,
  NEW_CREATIVE_ITERATION,
  TEST_NEW_ANGLE,
  COLLECT_MORE_DATA,
  // Rule authoring surface.
  buildRecommendation,
  factFromMetric,
  metricsFor,
  metricsForSlices,
  metaObjectsFor,
  maturityCaveatDe,
  isTargetMet,
  type RecommendationRule,
  type RuleScope,
  type BuildRecommendationInput,
} from './rules';
