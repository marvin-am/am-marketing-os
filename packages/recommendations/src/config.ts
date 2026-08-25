import { type Role } from '@am/domain';

/**
 * Thresholds the pattern rules compare against.
 *
 * `DEFAULT_RECOMMENDATION_CONFIG` in `@am/domain` covers the money and cooldown
 * rules; these are the additional performance benchmarks the creative/funnel
 * diagnosis rules need. Both are persisted in Settings — the values here are
 * only seeds, and every rule reads them from its context rather than closing
 * over a constant.
 */
export interface RecommendationBenchmarks {
  /** CTR at or above which a creative counts as "the hook works". */
  ctrBenchmark: number;
  /** Submission rate at or above which the funnel counts as healthy. */
  submissionRateBenchmark: number;
  /** Impressions a creative needs before its CTR is read as a signal. */
  minImpressionsForCtrSignal: number;
  /** Funnel sessions needed before a funnel-side conclusion is drawn. */
  minSessionsForFunnelSignal: number;
  /** Concepts that must all underperform before the angle itself is blamed. */
  minConceptsForAngleSignal: number;
  /** Relative shortfall against control that counts as materially worse. */
  materialWorseRelative: number;
  /** Qualified VQs required before a scale proposal may be made. */
  minQualifiedVqForScale: number;
  /** Attribution coverage below which every proposal carries a caveat. */
  minAttributionCoverage: number;
}

export const DEFAULT_RECOMMENDATION_BENCHMARKS: RecommendationBenchmarks = {
  ctrBenchmark: 0.01,
  submissionRateBenchmark: 0.15,
  minImpressionsForCtrSignal: 2_000,
  minSessionsForFunnelSignal: 200,
  minConceptsForAngleSignal: 5,
  materialWorseRelative: 0.3,
  minQualifiedVqForScale: 1,
  minAttributionCoverage: 0.7,
};

/** German role names, used wherever a refusal has to name who may approve. */
export const ROLE_LABELS_DE: Readonly<Record<Role, string>> = {
  VIEWER: 'Betrachter',
  MARKETING_OPERATOR: 'Marketing-Operator',
  CREATIVE_REVIEWER: 'Creative-Reviewer',
  MARKETING_LEAD: 'Marketing-Lead',
  REVOPS: 'RevOps',
  EXECUTIVE: 'Geschäftsführung',
  ADMIN: 'Administrator',
};

export function roleLabelsDe(roles: readonly Role[]): string {
  return roles.map((role) => ROLE_LABELS_DE[role]).join(', ');
}
