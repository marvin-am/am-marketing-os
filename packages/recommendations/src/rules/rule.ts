import {
  type AffectedMetaObject,
  DATA_MATURITY_LABELS_DE,
  formatMoneyDe,
  money,
  type MetricKey,
  METRIC_CATALOG,
  type Recommendation,
  type RecommendationActionKind,
  type RecommendationFact,
  recommendationSchema,
  type RiskLevel,
} from '@am/domain';
import {
  computeAllMetrics,
  type MetricCounters,
  type MetricValueMap,
  sumCounters,
} from '@am/experiments';
import { type ResolvedSlice, type RuleContext } from '../context';
import { recommendationId } from '../ids';

/**
 * The rule contract and the one constructor every rule builds through.
 *
 * Routing every proposal through `buildRecommendation` is what makes the
 * evidence invariants structural rather than a convention someone remembers:
 * a proposal without a real numerator/denominator fact, without a comparison
 * basis or without an uncertainty statement cannot be constructed at all.
 */

export type RuleScope = 'CAMPAIGN' | 'EXPERIMENT';

export interface RecommendationRule {
  /** Stable machine id, persisted on the recommendation. */
  id: string;
  action: RecommendationActionKind;
  /**
   * Fixed output rank. Lower means "look at this first" — stop-loss before
   * guardrails before conclusions before scaling before creative direction.
   */
  rank: number;
  /**
   * `EXPERIMENT`-scoped rules are invoked once per experiment, with
   * `ctx.experiments` narrowed to exactly that one.
   */
  scope: RuleScope;
  /** Only emitted when no other rule fired. */
  fallback?: boolean;
  evaluate(ctx: RuleContext): Recommendation | null;
}

/* -------------------------------------------------------------------------- */
/* Fact helpers                                                                */
/* -------------------------------------------------------------------------- */

/** A fact taken straight from a computed metric, keeping its numerator pair. */
export function factFromMetric(
  metrics: MetricValueMap,
  metric: MetricKey,
  options: {
    label?: string;
    comparisonLabel?: string;
    comparisonValue?: number | null;
    currency?: string;
  } = {},
): RecommendationFact {
  const value = metrics[metric];
  const definition = METRIC_CATALOG[metric];
  const isMoney = definition.unit === 'MONEY';
  return {
    metric,
    label: options.label ?? `${definition.label} (${definition.formula})`.slice(0, 160),
    numerator: value.numerator,
    denominator: value.denominator,
    value: value.value,
    currency: isMoney ? (options.currency ?? value.currency ?? 'EUR') : null,
    comparisonLabel: options.comparisonLabel ?? null,
    comparisonValue: options.comparisonValue ?? null,
  };
}

/** True when a fact shows both sides of its division. */
export function hasRealBasis(candidate: RecommendationFact): boolean {
  return candidate.numerator !== null && candidate.denominator !== null;
}

/** Metrics for an arbitrary counter set, in this context's maturity frame. */
export function metricsFor(ctx: RuleContext, counters: MetricCounters): MetricValueMap {
  return computeAllMetrics(counters, {
    crmMaturity: ctx.crmMaturity,
    attributionCoverage: ctx.attributionCoverage,
    currency: ctx.currency,
  });
}

/** Combined metrics across several slices — used when a rule names a group. */
export function metricsForSlices(ctx: RuleContext, slices: readonly ResolvedSlice[]): MetricValueMap {
  return metricsFor(ctx, sumCounters(slices.map((slice) => slice.counters)));
}

/** All Meta objects a group of slices maps onto, de-duplicated and ordered. */
export function metaObjectsFor(slices: readonly ResolvedSlice[]): AffectedMetaObject[] {
  const seen = new Set<string>();
  const objects: AffectedMetaObject[] = [];
  for (const slice of slices) {
    for (const object of slice.metaObjects) {
      const identity = `${object.level} ${object.external_id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      objects.push(object);
    }
  }
  return objects.sort(
    (a, b) => a.level.localeCompare(b.level) || a.external_id.localeCompare(b.external_id),
  );
}

/* -------------------------------------------------------------------------- */
/* German phrasing helpers                                                     */
/* -------------------------------------------------------------------------- */

export function formatMinor(amountMinor: number, currency: string): string {
  return formatMoneyDe(money(amountMinor, currency));
}

export function formatPercent(value: number, fractionDigits = 1): string {
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value * 100)} %`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('de-DE').format(value);
}

/**
 * The maturity and attribution caveat that goes onto every proposal. This is
 * the sentence that stops "CAC 240 €" from being read as a settled fact when it
 * rests on a cohort that is three days old.
 */
export function maturityCaveatDe(ctx: RuleContext): string {
  const parts = [`Datenreife: ${DATA_MATURITY_LABELS_DE[ctx.crmMaturity]}`];
  if (ctx.crmMaturity !== 'MATURE') {
    parts.push(
      `CRM-Ergebnisse sind erst zu ${Math.round(ctx.maturity.matureFraction * 100)} % eingetroffen (vollständig ab ${ctx.maturity.earliestMatureAt.slice(0, 10)})`,
    );
  }
  if (ctx.attributionCoverage !== null) {
    parts.push(`Attributionsabdeckung ${formatPercent(ctx.attributionCoverage, 0)}`);
  } else {
    parts.push('Attributionsabdeckung nicht bestimmbar');
  }
  return `${parts.join('; ')}.`;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

export interface BuildRecommendationInput {
  ctx: RuleContext;
  ruleId: string;
  action: RecommendationActionKind;
  /** Identifies what the rule acted on; part of the deterministic id. */
  scopeKey: string;
  titleDe: string;
  summaryDe: string;
  facts: readonly RecommendationFact[];
  comparisonBasisDe: string;
  uncertaintyDe: string;
  risk: RiskLevel;
  riskNoteDe?: string | null;
  affectedMetaObjects?: readonly AffectedMetaObject[];
  proposedBudgetChangePct?: number | null;
  experimentId?: string | null;
}

/**
 * Build and validate a recommendation.
 *
 * Throws when an invariant is violated — a rule that cannot produce evidence has
 * a bug, and shipping a proposal with an empty fact list would be worse than
 * failing the job.
 */
export function buildRecommendation(input: BuildRecommendationInput): Recommendation {
  if (input.facts.length === 0) {
    throw new Error(`Rule ${input.ruleId} produced no facts — every recommendation needs evidence.`);
  }
  if (!input.facts.some(hasRealBasis)) {
    throw new Error(
      `Rule ${input.ruleId} produced no fact with both a numerator and a denominator — a bare value is not evidence.`,
    );
  }

  const candidate: Recommendation = {
    id: recommendationId(input.ctx.campaignId, input.ruleId, input.scopeKey),
    campaign_id: input.ctx.campaignId,
    experiment_id: input.experimentId ?? null,
    created_at: input.ctx.now,

    action: input.action,
    state: 'OPEN',
    ruleId: input.ruleId,
    titleDe: input.titleDe,
    summaryDe: input.summaryDe,
    explanationDe: null,
    nextHypothesisDe: null,

    facts: [...input.facts],
    comparisonBasisDe: input.comparisonBasisDe,
    maturity: input.ctx.crmMaturity,
    attributionCoverage: input.ctx.attributionCoverage,
    uncertaintyDe: input.uncertaintyDe,

    risk: input.risk,
    riskNoteDe: input.riskNoteDe ?? null,

    affectedMetaObjects: [...(input.affectedMetaObjects ?? [])],
    proposedBudgetChangePct: input.proposedBudgetChangePct ?? null,
    execution: null,
  };

  // Validating here means a malformed proposal fails loudly at generation time
  // rather than silently at the database boundary.
  return recommendationSchema.parse(candidate);
}
