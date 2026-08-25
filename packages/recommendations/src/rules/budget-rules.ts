import {
  DEFAULT_ROLE_BUDGET_LIMITS,
  METRIC_CATALOG,
  type MetricKey,
  type RecommendationFact,
  type RiskLevel,
} from '@am/domain';
import { isMatureForDecision } from '@am/experiments';
import { evaluateBudgetChange, maxAllowedDailyBudget } from '../budget';
import { type RuleContext } from '../context';
import {
  buildRecommendation,
  factFromMetric,
  formatMinor,
  formatPercent,
  maturityCaveatDe,
  metaObjectsFor,
  type RecommendationRule,
} from './rule';

/**
 * Budget rules.
 *
 * The asymmetry between them is the point. `SCALE_BUDGET` has to clear six
 * independent gates including a fully matured CRM cohort; `DECREASE_BUDGET`
 * needs one guardrail breach and enough leads to know the breach is real.
 * Spending more on numbers that have not finished arriving is the single most
 * expensive mistake available to this system, so the scale gate is the strictest
 * thing in the package.
 */

/** Is a metric at or better than its target, judged by the catalogue direction? */
export function isTargetMet(metric: MetricKey, value: number | null, target: number | null): boolean {
  if (value === null || target === null || !Number.isFinite(value)) return false;
  return METRIC_CATALOG[metric].direction === 'LOWER_IS_BETTER' ? value <= target : value >= target;
}

interface TargetCheck {
  metric: MetricKey;
  value: number | null;
  target: number | null;
  met: boolean;
}

/**
 * The metric the scale decision is actually made on: the campaign's declared
 * primary metric when it carries a target, otherwise the cost per qualified VQ.
 * Without either there is no basis and the rule stays silent.
 */
function resolveTargetCheck(ctx: RuleContext): TargetCheck | null {
  const { primaryMetric, primaryMetricTarget, targetCostPerQualifiedVqMinor } = ctx.targets;

  if (primaryMetricTarget !== null) {
    const value = ctx.campaign.metrics[primaryMetric].value;
    return {
      metric: primaryMetric,
      value,
      target: primaryMetricTarget,
      met: isTargetMet(primaryMetric, value, primaryMetricTarget),
    };
  }

  if (targetCostPerQualifiedVqMinor !== null) {
    const value = ctx.campaign.metrics.cost_per_qualified_vq.value;
    return {
      metric: 'cost_per_qualified_vq',
      value,
      target: targetCostPerQualifiedVqMinor,
      met: isTargetMet('cost_per_qualified_vq', value, targetCostPerQualifiedVqMinor),
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Scale                                                                       */
/* -------------------------------------------------------------------------- */

export const SCALE_BUDGET: RecommendationRule = {
  id: 'SCALE_BUDGET',
  action: 'INCREASE_BUDGET',
  rank: 60,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    // Gate 1 — CRM maturity. Non-negotiable and checked first, so a reader of
    // this function sees it before anything else.
    if (ctx.config.requireMatureCrmForScale && !isMatureForDecision(ctx.crmMaturity)) return null;

    // Gate 2 — no guardrail may be breached.
    if (ctx.guardrailBreaches.length > 0) return null;

    // Gate 3 — enough data for the leading and the business signal.
    const counters = ctx.campaign.counters;
    if (counters.leads < ctx.config.minLeadsForLeadingSignals) return null;
    if (counters.qualifiedVq < ctx.benchmarks.minQualifiedVqForScale) return null;

    // Gate 4 — the target the campaign is steered against is actually met.
    const check = resolveTargetCheck(ctx);
    if (check === null || !check.met) return null;

    // Gate 5 — there is a budget to scale and headroom to scale it into.
    const currentDailyMinor = ctx.budget.currentDailyMinor;
    if (currentDailyMinor <= 0) return null;

    const limit = (ctx.budget.limits ?? DEFAULT_ROLE_BUDGET_LIMITS)[ctx.budget.role];
    const desiredDailyMinor = Math.round(currentDailyMinor * (1 + ctx.config.scaleStepPct));
    const ceilingMinor = maxAllowedDailyBudget(limit, currentDailyMinor, ctx.budget.policy);
    const proposedDailyMinor = Math.min(desiredDailyMinor, ceilingMinor);
    if (proposedDailyMinor <= currentDailyMinor) return null;

    // Gate 6 — the 24 h cooldown and the role's authority.
    const decision = evaluateBudgetChange({
      role: ctx.budget.role,
      currentDailyMinor,
      proposedDailyMinor,
      recentScales: ctx.budget.recentScales,
      now: ctx.now,
      limits: ctx.budget.limits,
      policy: ctx.budget.policy,
      currency: ctx.currency,
    });
    if (decision.decision === 'REFUSE') return null;

    const changePct = (proposedDailyMinor - currentDailyMinor) / currentDailyMinor;
    const clamped = proposedDailyMinor < desiredDailyMinor;
    const definition = METRIC_CATALOG[check.metric];

    const facts: RecommendationFact[] = [
      factFromMetric(ctx.campaign.metrics, check.metric, {
        label: `${definition.label} (${definition.formula})`,
        comparisonLabel: `Ziel ${definition.label}`,
        comparisonValue: check.target,
        currency: ctx.currency,
      }),
      factFromMetric(ctx.campaign.metrics, 'cost_per_qualified_vq', {
        label: 'Kosten je qualifiziertem VQ',
        comparisonLabel: 'Zielkosten je qualifiziertem VQ',
        comparisonValue: ctx.targets.targetCostPerQualifiedVqMinor,
        currency: ctx.currency,
      }),
      factFromMetric(ctx.campaign.metrics, 'qualified_vq_rate', { label: 'Qualifizierungsrate' }),
      factFromMetric(ctx.campaign.metrics, 'submission_rate', { label: 'Submission-Rate' }),
    ];

    const risk: RiskLevel = decision.decision === 'REQUIRES_APPROVAL' ? 'HIGH' : 'MEDIUM';

    return buildRecommendation({
      ctx,
      ruleId: SCALE_BUDGET.id,
      action: 'INCREASE_BUDGET',
      scopeKey: ctx.campaignId,
      titleDe: `Budget erhöhen: ${formatMinor(currentDailyMinor, ctx.currency)} → ${formatMinor(proposedDailyMinor, ctx.currency)} pro Tag`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Tagesbudget der Kampagne „${ctx.campaignName}" von ${formatMinor(currentDailyMinor, ctx.currency)} auf ${formatMinor(proposedDailyMinor, ctx.currency)} anheben (+${formatPercent(changePct, 0)}). ` +
        `Grundlage: ${definition.label} erreicht das Ziel, kein Guardrail ist verletzt, ${counters.leads} Leads und ${counters.qualifiedVq} qualifizierte VQs liegen vor, und die CRM-Kohorte ist seit dem ${ctx.maturity.earliestMatureAt.slice(0, 10)} vollständig ausgereift. ` +
        (clamped
          ? `Der reguläre Schritt von +${formatPercent(ctx.config.scaleStepPct, 0)} wurde auf das zulässige Maximum begrenzt. `
          : '') +
        (decision.decision === 'REQUIRES_APPROVAL' ? `${decision.messageDe} ` : '') +
        'Die Ausführung erfolgt erst nach ausdrücklicher Bestätigung.'.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit dem Zielwert für ${definition.label} und dem aktuellen Tagesbudget von ${formatMinor(currentDailyMinor, ctx.currency)}. Skalierungsschritt: ${formatPercent(ctx.config.scaleStepPct, 0)}, Cooldown ${ctx.config.scaleCooldownHours} Stunden.`,
      uncertaintyDe:
        `Beobachtungsbasis: ${counters.leads} Leads, ${counters.qualifiedVq} qualifizierte VQs, ${counters.closedWon} Abschlüsse. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk,
      riskNoteDe:
        `Eine Budgeterhöhung setzt die Lernphase der Kampagne teilweise zurück und kann den CPL kurzfristig anheben. ${decision.decision === 'REQUIRES_APPROVAL' ? 'Vor der Ausführung ist eine dokumentierte Budget-Freigabe erforderlich.' : ''}`.slice(0, 600),
      affectedMetaObjects: metaObjectsFor([ctx.campaign]).map((object) => ({
        ...object,
        currentDailyBudgetMinor: object.currentDailyBudgetMinor ?? currentDailyMinor,
        proposedDailyBudgetMinor: proposedDailyMinor,
      })),
      proposedBudgetChangePct: changePct,
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Decrease                                                                    */
/* -------------------------------------------------------------------------- */

export const DECREASE_BUDGET_ON_GUARDRAIL_BREACH: RecommendationRule = {
  id: 'DECREASE_BUDGET_ON_GUARDRAIL_BREACH',
  action: 'DECREASE_BUDGET',
  rank: 30,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    if (ctx.guardrailBreaches.length === 0) return null;

    // A breach on a CRM-delayed metric is only real once the cohort has matured.
    // Reacting to a half-arrived cost figure means reacting to arithmetic, not
    // to performance.
    const actionable = ctx.guardrailBreaches.filter(
      (breach) =>
        METRIC_CATALOG[breach.metric].latency !== 'CRM_DELAYED' || isMatureForDecision(ctx.crmMaturity),
    );
    if (actionable.length === 0) return null;

    const counters = ctx.campaign.counters;
    if (counters.leads < ctx.config.minLeadsForLeadingSignals) return null;

    const currentDailyMinor = ctx.budget.currentDailyMinor;
    if (currentDailyMinor <= 0) return null;

    const proposedDailyMinor = Math.max(0, Math.round(currentDailyMinor * (1 - ctx.config.scaleStepPct)));
    const changePct = (proposedDailyMinor - currentDailyMinor) / currentDailyMinor;

    const facts: RecommendationFact[] = actionable.map((breach) =>
      factFromMetric(ctx.campaign.metrics, breach.metric, {
        label: `${METRIC_CATALOG[breach.metric].label} — Guardrail verletzt`,
        comparisonLabel: 'Guardrail-Limit',
        comparisonValue: breach.limit,
        currency: ctx.currency,
      }),
    );
    facts.push(factFromMetric(ctx.campaign.metrics, 'submission_rate', { label: 'Submission-Rate' }));

    const breachNames = actionable.map((breach) => METRIC_CATALOG[breach.metric].label).join(', ');

    return buildRecommendation({
      ctx,
      ruleId: DECREASE_BUDGET_ON_GUARDRAIL_BREACH.id,
      action: 'DECREASE_BUDGET',
      scopeKey: `${ctx.campaignId}:${actionable.map((b) => b.metric).sort().join('+')}`,
      titleDe: `Budget reduzieren: Guardrail verletzt (${breachNames})`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Tagesbudget der Kampagne „${ctx.campaignName}" von ${formatMinor(currentDailyMinor, ctx.currency)} auf ${formatMinor(proposedDailyMinor, ctx.currency)} senken (${formatPercent(changePct, 0)}). ` +
        `Verletzte Guardrails: ${actionable.map((breach) => breach.messageDe).join(' ')} ` +
        `Die Datenbasis ist mit ${counters.leads} Leads ausreichend, um die Verletzung als belastbar zu behandeln.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit den konfigurierten Guardrail-Limits der Kampagne und dem aktuellen Tagesbudget von ${formatMinor(currentDailyMinor, ctx.currency)}.`,
      uncertaintyDe:
        `Beobachtungsbasis: ${counters.leads} Leads bei ${formatMinor(counters.spendMinor, ctx.currency)} Spend. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe:
        'Eine Budgetsenkung verringert das Datenvolumen und verlängert damit laufende Tests. Sie ist jederzeit rückgängig zu machen.',
      affectedMetaObjects: metaObjectsFor([ctx.campaign]).map((object) => ({
        ...object,
        currentDailyBudgetMinor: object.currentDailyBudgetMinor ?? currentDailyMinor,
        proposedDailyBudgetMinor: proposedDailyMinor,
      })),
      proposedBudgetChangePct: changePct,
    });
  },
};
