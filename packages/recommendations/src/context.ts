import {
  type AffectedMetaObject,
  type DataMaturity,
  DEFAULT_RECOMMENDATION_CONFIG,
  type ExperimentKind,
  type IsoTimestamp,
  type MetricKey,
  type Recommendation,
  type RecommendationConfig,
  type Role,
  type RoleBudgetLimit,
} from '@am/domain';
import {
  computeAllMetrics,
  evaluateGuardrails,
  type ExperimentEvaluation,
  type GuardrailBreach,
  type GuardrailReading,
  type MaturityAssessment,
  type MetricContext,
  type MetricCounters,
  type MetricValueMap,
} from '@am/experiments';
import {
  DEFAULT_RECOMMENDATION_BENCHMARKS,
  type RecommendationBenchmarks,
} from './config';
import { type BudgetPolicy, DEFAULT_BUDGET_POLICY, type ScaleAction } from './budget';

/**
 * The input contract of the rules engine.
 *
 * Everything a rule may look at arrives here, already computed by
 * `@am/experiments`. Rules never fetch, never derive a metric from a raw row and
 * never read a clock — which is exactly what makes each one a pure function that
 * can be unit-tested in isolation.
 */

/* -------------------------------------------------------------------------- */
/* Raw context                                                                 */
/* -------------------------------------------------------------------------- */

/** One thing that can be judged and, if necessary, paused. */
export interface PerformanceSlice {
  /** Stable identifier — creative version id, arm id, campaign id. */
  key: string;
  /** German-facing name, rendered in the proposal. */
  label: string;
  counters: MetricCounters;
  /** The Meta objects this slice maps onto, if any are known. */
  metaObjects?: readonly AffectedMetaObject[];
}

export interface CampaignTargets {
  /** Target cost per lead, in minor units. */
  targetCplMinor: number | null;
  /** Target cost per qualified VQ, in minor units. */
  targetCostPerQualifiedVqMinor: number | null;
  /** The metric the campaign is steered against. */
  primaryMetric: MetricKey;
  /**
   * Target value for the primary metric — a fraction for rates, minor units for
   * money. `null` means "no target", and no scale proposal will be made.
   */
  primaryMetricTarget: number | null;
}

export interface BudgetContext {
  /** Role the proposal would be executed under. */
  role: Role;
  currentDailyMinor: number;
  recentScales?: readonly ScaleAction[];
  limits?: Readonly<Record<Role, RoleBudgetLimit>>;
  policy?: BudgetPolicy;
}

export interface ExperimentContextEntry {
  experimentId: string;
  name: string;
  kind: ExperimentKind;
  evaluation: ExperimentEvaluation;
  /** Meta objects per arm id, so a pause proposal can name real objects. */
  armMetaObjects?: Readonly<Record<string, readonly AffectedMetaObject[]>>;
}

export interface RecommendationContext {
  now: IsoTimestamp;
  campaignId: string;
  campaignName: string;
  currency?: string;
  config?: RecommendationConfig;
  benchmarks?: RecommendationBenchmarks;

  /** Campaign totals. Non-production traffic is already excluded upstream. */
  campaign: PerformanceSlice;
  /** Per-creative breakdown. Empty when Meta has not reported one yet. */
  creatives?: readonly PerformanceSlice[];
  /** Per-funnel-arm breakdown. */
  funnelArms?: readonly PerformanceSlice[];

  targets: CampaignTargets;
  guardrails?: readonly GuardrailReading[];
  maturity: MaturityAssessment;
  attributionCoverage?: number | null;
  budget: BudgetContext;
  experiments?: readonly ExperimentContextEntry[];

  /** Still-open proposals from an earlier run, for superseding. */
  openRecommendations?: readonly Recommendation[];

  /** Meta objects for the campaign itself — the fallback pause/scale target. */
  campaignMetaObjects?: readonly AffectedMetaObject[];
}

/* -------------------------------------------------------------------------- */
/* Resolved context                                                            */
/* -------------------------------------------------------------------------- */

/** A slice with its metrics computed once, so rules never recompute them. */
export interface ResolvedSlice extends PerformanceSlice {
  metrics: MetricValueMap;
  metaObjects: readonly AffectedMetaObject[];
}

export interface ResolvedBudgetContext extends BudgetContext {
  recentScales: readonly ScaleAction[];
  policy: BudgetPolicy;
}

/** What every rule receives. Fully populated — no optional plumbing. */
export interface RuleContext {
  now: IsoTimestamp;
  campaignId: string;
  campaignName: string;
  currency: string;
  config: RecommendationConfig;
  benchmarks: RecommendationBenchmarks;

  campaign: ResolvedSlice;
  creatives: readonly ResolvedSlice[];
  funnelArms: readonly ResolvedSlice[];

  targets: CampaignTargets;
  guardrails: readonly GuardrailReading[];
  guardrailBreaches: readonly GuardrailBreach[];
  maturity: MaturityAssessment;
  crmMaturity: DataMaturity;
  attributionCoverage: number | null;
  budget: ResolvedBudgetContext;
  experiments: readonly ExperimentContextEntry[];
  openRecommendations: readonly Recommendation[];
}

function resolveSlice(slice: PerformanceSlice, metricContext: MetricContext): ResolvedSlice {
  return {
    ...slice,
    metrics: computeAllMetrics(slice.counters, metricContext),
    metaObjects: slice.metaObjects ?? [],
  };
}

/**
 * Fill in defaults and precompute everything the rules read. Deterministic and
 * order-stable: slices are sorted by key so the engine's output cannot depend on
 * the order rows came back from the database.
 */
export function resolveContext(ctx: RecommendationContext): RuleContext {
  const currency = ctx.currency ?? 'EUR';
  const attributionCoverage = ctx.attributionCoverage ?? null;
  const metricContext: MetricContext = {
    crmMaturity: ctx.maturity.maturity,
    attributionCoverage,
    currency,
  };

  const byKey = (a: PerformanceSlice, b: PerformanceSlice): number => a.key.localeCompare(b.key);

  return {
    now: ctx.now,
    campaignId: ctx.campaignId,
    campaignName: ctx.campaignName,
    currency,
    config: ctx.config ?? DEFAULT_RECOMMENDATION_CONFIG,
    benchmarks: ctx.benchmarks ?? DEFAULT_RECOMMENDATION_BENCHMARKS,
    campaign: resolveSlice(
      { ...ctx.campaign, metaObjects: ctx.campaign.metaObjects ?? ctx.campaignMetaObjects ?? [] },
      metricContext,
    ),
    creatives: [...(ctx.creatives ?? [])].sort(byKey).map((slice) => resolveSlice(slice, metricContext)),
    funnelArms: [...(ctx.funnelArms ?? [])].sort(byKey).map((slice) => resolveSlice(slice, metricContext)),
    targets: ctx.targets,
    guardrails: ctx.guardrails ?? [],
    guardrailBreaches: evaluateGuardrails(ctx.guardrails ?? []),
    maturity: ctx.maturity,
    crmMaturity: ctx.maturity.maturity,
    attributionCoverage,
    budget: {
      ...ctx.budget,
      recentScales: ctx.budget.recentScales ?? [],
      policy: ctx.budget.policy ?? DEFAULT_BUDGET_POLICY,
    },
    experiments: [...(ctx.experiments ?? [])].sort((a, b) =>
      a.experimentId.localeCompare(b.experimentId),
    ),
    openRecommendations: ctx.openRecommendations ?? [],
  };
}
