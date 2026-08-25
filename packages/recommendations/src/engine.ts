import { type Recommendation, type RiskLevel } from '@am/domain';
import { type RecommendationContext, resolveContext, type RuleContext } from './context';
import { RECOMMENDATION_RULES } from './rules';
import { type RecommendationRule } from './rules/rule';

/**
 * The deterministic recommendation engine.
 *
 * Runs every rule, deduplicates proposals that would touch the same object with
 * the same action, ranks the survivors, and marks anything still open from a
 * previous run that no rule reproduced as `SUPERSEDED`.
 *
 * Nothing here executes. The output is a list of proposals; a human accepts one
 * and a separate command path performs the write, subject to
 * `EXTERNAL_WRITES_ENABLED` and the role's budget authority.
 *
 * Determinism is a tested property, not an aspiration: rule order is fixed,
 * experiments are iterated in id order, ids are derived from (campaign, rule,
 * scope) rather than generated, `created_at` comes from `ctx.now`, and every
 * sort comparator falls through to a total order.
 */

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export interface RankedRecommendation {
  recommendation: Recommendation;
  ruleId: string;
  rank: number;
}

export interface RecommendationEngineResult {
  /** Open proposals, best-first. */
  recommendations: Recommendation[];
  /** The same list with its ranking metadata, for debugging and audit. */
  ranked: RankedRecommendation[];
  /** Previously open proposals that no rule reproduced, marked SUPERSEDED. */
  superseded: Recommendation[];
  /** Ids of the rules that produced something. */
  firedRuleIds: string[];
  /** Ids of every rule that was evaluated, in evaluation order. */
  evaluatedRuleIds: string[];
  /** Proposals dropped because a higher-ranked rule already covered the object. */
  deduplicatedRuleIds: string[];
}

/** Narrow a context to exactly one experiment, for experiment-scoped rules. */
function scopeToExperiment(ctx: RuleContext, index: number): RuleContext {
  return { ...ctx, experiments: [ctx.experiments[index]] };
}

/**
 * The identity a dedupe compares on: the action plus the concrete Meta objects
 * it would touch. Two rules proposing "pause ad 123" is one decision, and the
 * higher-ranked rule owns it.
 */
function dedupeKey(recommendation: Recommendation): string {
  const objects = recommendation.affectedMetaObjects
    .map((object) => `${object.level}:${object.external_id}`)
    .sort()
    .join(',');
  return `${recommendation.action}|${recommendation.experiment_id ?? '-'}|${objects}`;
}

export function generateRecommendations(
  context: RecommendationContext,
  rules: readonly RecommendationRule[] = RECOMMENDATION_RULES,
): RecommendationEngineResult {
  const ctx = resolveContext(context);

  const ordered = [...rules].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const evaluatedRuleIds: string[] = [];
  const produced: RankedRecommendation[] = [];
  const fallbacks: RankedRecommendation[] = [];

  for (const rule of ordered) {
    evaluatedRuleIds.push(rule.id);

    const results: Recommendation[] = [];
    if (rule.scope === 'EXPERIMENT') {
      // Fan out over experiments; `ctx.experiments` is already id-sorted.
      for (let index = 0; index < ctx.experiments.length; index++) {
        const candidate = rule.evaluate(scopeToExperiment(ctx, index));
        if (candidate) results.push(candidate);
      }
    } else {
      const candidate = rule.evaluate(ctx);
      if (candidate) results.push(candidate);
    }

    for (const recommendation of results) {
      const entry: RankedRecommendation = { recommendation, ruleId: rule.id, rank: rule.rank };
      if (rule.fallback) fallbacks.push(entry);
      else produced.push(entry);
    }
  }

  /* ---- Deduplicate ------------------------------------------------------- */

  const seenIds = new Set<string>();
  const seenTargets = new Set<string>();
  const kept: RankedRecommendation[] = [];
  const deduplicatedRuleIds: string[] = [];

  // `produced` is already in rank order, so the first entry to claim a target is
  // by definition the highest-priority one.
  for (const entry of produced) {
    if (seenIds.has(entry.recommendation.id)) {
      deduplicatedRuleIds.push(entry.ruleId);
      continue;
    }
    const target = dedupeKey(entry.recommendation);
    // An empty object list is not a claim on anything, so it never collides.
    const hasTarget = entry.recommendation.affectedMetaObjects.length > 0;
    if (hasTarget && seenTargets.has(target)) {
      deduplicatedRuleIds.push(entry.ruleId);
      continue;
    }
    seenIds.add(entry.recommendation.id);
    if (hasTarget) seenTargets.add(target);
    kept.push(entry);
  }

  // The fallback speaks only when nothing else did.
  if (kept.length === 0) kept.push(...fallbacks);

  /* ---- Rank -------------------------------------------------------------- */

  const ranked = kept.sort(
    (a, b) =>
      a.rank - b.rank ||
      RISK_ORDER[a.recommendation.risk] - RISK_ORDER[b.recommendation.risk] ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.recommendation.id.localeCompare(b.recommendation.id),
  );

  const recommendations = ranked.map((entry) => entry.recommendation);

  /* ---- Supersede --------------------------------------------------------- */

  const liveIds = new Set(recommendations.map((recommendation) => recommendation.id));
  const superseded = ctx.openRecommendations
    .filter(
      (open) => open.campaign_id === ctx.campaignId && open.state === 'OPEN' && !liveIds.has(open.id),
    )
    .map((open) => ({ ...open, state: 'SUPERSEDED' as const }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    recommendations,
    ranked,
    superseded,
    firedRuleIds: ranked.map((entry) => entry.ruleId),
    evaluatedRuleIds,
    deduplicatedRuleIds,
  };
}
