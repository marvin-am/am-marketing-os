import { DECREASE_BUDGET_ON_GUARDRAIL_BREACH, SCALE_BUDGET } from './budget-rules';
import { COLLECT_MORE_DATA } from './collect-more-data';
import {
  CONCLUDE_EXPERIMENT,
  PAUSE_CREATIVE_UNDERPERFORMING,
  PAUSE_FUNNEL_ARM_UNDERPERFORMING,
} from './experiment-rules';
import { PAUSE_NO_LEAD_ABOVE_TARGET_CPL, PAUSE_NO_QUALIFIED_VQ } from './pause';
import { KEEP_OFFER_CHANGE_MESSAGING, NEW_CREATIVE_ITERATION, TEST_NEW_ANGLE } from './patterns';
import { type RecommendationRule } from './rule';

export { isTargetMet } from './budget-rules';
export {
  buildRecommendation,
  factFromMetric,
  hasRealBasis,
  metricsFor,
  metricsForSlices,
  metaObjectsFor,
  maturityCaveatDe,
  formatMinor,
  formatPercent,
  formatCount,
  type BuildRecommendationInput,
  type RecommendationRule,
  type RuleScope,
} from './rule';

export {
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
};

/**
 * The rule set, in output order.
 *
 * Order is stop-loss → guardrail → losing arm → conclusion → scale → creative
 * direction → the honest default. It reflects what an operator opening the
 * console at 9 a.m. needs to see first: money currently being wasted, before an
 * opportunity to spend more.
 */
export const RECOMMENDATION_RULES: readonly RecommendationRule[] = [
  PAUSE_NO_LEAD_ABOVE_TARGET_CPL, // 10
  PAUSE_NO_QUALIFIED_VQ, // 20
  DECREASE_BUDGET_ON_GUARDRAIL_BREACH, // 30
  PAUSE_CREATIVE_UNDERPERFORMING, // 40
  PAUSE_FUNNEL_ARM_UNDERPERFORMING, // 45
  CONCLUDE_EXPERIMENT, // 50
  SCALE_BUDGET, // 60
  KEEP_OFFER_CHANGE_MESSAGING, // 70
  NEW_CREATIVE_ITERATION, // 80
  TEST_NEW_ANGLE, // 90
  COLLECT_MORE_DATA, // 100 — fallback only
];

export const RULE_IDS: readonly string[] = RECOMMENDATION_RULES.map((rule) => rule.id);
