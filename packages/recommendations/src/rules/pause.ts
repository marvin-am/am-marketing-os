import { type RecommendationFact } from '@am/domain';
import { isMatureForDecision } from '@am/experiments';
import { type ResolvedSlice, type RuleContext } from '../context';
import {
  buildRecommendation,
  factFromMetric,
  formatCount,
  formatMinor,
  maturityCaveatDe,
  metaObjectsFor,
  metricsForSlices,
  type RecommendationRule,
} from './rule';

/**
 * Stop-loss rules.
 *
 * Both answer the same question — "are we buying nothing?" — at two different
 * points in the funnel, and both are deliberately asymmetric: they need far less
 * evidence to propose stopping than the scale rule needs to propose spending
 * more. Stopping is reversible and cheap; scaling on a wrong number is not.
 */

/* -------------------------------------------------------------------------- */
/* Spend above the target CPL without a single lead                            */
/* -------------------------------------------------------------------------- */

export const PAUSE_NO_LEAD_ABOVE_TARGET_CPL: RecommendationRule = {
  id: 'PAUSE_NO_LEAD_ABOVE_TARGET_CPL',
  action: 'PAUSE_CREATIVE',
  rank: 10,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    const targetCplMinor = ctx.targets.targetCplMinor;
    if (targetCplMinor === null || targetCplMinor <= 0) return null;

    const thresholdMinor = targetCplMinor * ctx.config.noLeadSpendMultiple;

    // Judge per creative where a breakdown exists; otherwise the campaign as a
    // whole, which is the same test at a coarser resolution.
    const slices: readonly ResolvedSlice[] = ctx.creatives.length > 0 ? ctx.creatives : [ctx.campaign];
    const offenders = slices.filter(
      (slice) => slice.counters.leads === 0 && slice.counters.spendMinor > thresholdMinor,
    );
    if (offenders.length === 0) return null;

    const metrics = metricsForSlices(ctx, offenders);
    const wastedMinor = offenders.reduce((sum, slice) => sum + slice.counters.spendMinor, 0);
    const names = offenders.map((slice) => slice.label).join(', ');

    const facts: RecommendationFact[] = [
      factFromMetric(metrics, 'cpl', {
        label: 'CPL — kein Lead trotz Spend',
        comparisonLabel: 'Ziel-CPL',
        comparisonValue: targetCplMinor,
        currency: ctx.currency,
      }),
      factFromMetric(metrics, 'submission_rate', {
        label: 'Submission-Rate (Leads / Funnel-Sessions)',
      }),
      factFromMetric(metrics, 'ctr', { label: 'CTR (Link-Klicks / Impressionen)' }),
    ];

    return buildRecommendation({
      ctx,
      ruleId: PAUSE_NO_LEAD_ABOVE_TARGET_CPL.id,
      action: 'PAUSE_CREATIVE',
      scopeKey: offenders.map((slice) => slice.key).sort().join('+'),
      titleDe: `Pausieren: ${formatMinor(wastedMinor, ctx.currency)} Spend ohne einen einzigen Lead`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: ${offenders.length === 1 ? 'Das Objekt' : `Die ${offenders.length} Objekte`} ${names} in Meta pausieren. ` +
        `Ausgegeben wurden ${formatMinor(wastedMinor, ctx.currency)} bei 0 Leads. Das ist mehr als das ${ctx.config.noLeadSpendMultiple}-Fache des Ziel-CPL von ${formatMinor(targetCplMinor, ctx.currency)} ` +
        `(Schwelle ${formatMinor(Math.round(thresholdMinor), ctx.currency)}). Ohne Lead lässt sich kein CPL berechnen — der Wert ist nicht hoch, sondern unbestimmt.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit dem hinterlegten Ziel-CPL von ${formatMinor(targetCplMinor, ctx.currency)} und der Regelschwelle vom ${ctx.config.noLeadSpendMultiple}-Fachen dieses Werts.`,
      uncertaintyDe:
        `Kein statistisches Intervall möglich: bei 0 Leads existiert kein Schätzwert für den CPL. Die Aussage stützt sich allein auf die ausgegebene Summe. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe:
        'Pausieren ist reversibel. Risiko: Bei sehr frischer Auslieferung kann ein später Lead noch eintreffen; die Lernphase des Objekts beginnt nach einer Reaktivierung neu.',
      affectedMetaObjects: metaObjectsFor(offenders.length > 0 ? offenders : [ctx.campaign]),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Spend above the target cost per qualified VQ without a qualified VQ         */
/* -------------------------------------------------------------------------- */

export const PAUSE_NO_QUALIFIED_VQ: RecommendationRule = {
  id: 'PAUSE_NO_QUALIFIED_VQ',
  action: 'PAUSE_CREATIVE',
  rank: 20,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    const targetMinor = ctx.targets.targetCostPerQualifiedVqMinor;
    if (targetMinor === null || targetMinor <= 0) return null;

    // The whole rule rests on "no qualified VQ arrived" being a fact rather than
    // a waiting room. Before the maturity window closes it is a waiting room.
    if (!isMatureForDecision(ctx.crmMaturity)) return null;

    const counters = ctx.campaign.counters;
    if (counters.qualifiedVq > 0) return null;

    const thresholdMinor = targetMinor * ctx.config.noQualifiedVqSpendMultiple;
    if (counters.spendMinor <= thresholdMinor) return null;

    const metrics = ctx.campaign.metrics;
    const facts: RecommendationFact[] = [
      factFromMetric(metrics, 'cost_per_qualified_vq', {
        label: 'Kosten je qualifiziertem VQ — kein qualifizierter VQ',
        comparisonLabel: 'Zielkosten je qualifiziertem VQ',
        comparisonValue: targetMinor,
        currency: ctx.currency,
      }),
      factFromMetric(metrics, 'vq_scheduled_rate', { label: 'VQ-Terminierungsrate (VQs / Leads)' }),
      factFromMetric(metrics, 'qualified_vq_rate', {
        label: 'Qualifizierungsrate (qualifizierte VQs / stattgefundene VQs)',
      }),
      factFromMetric(metrics, 'cpl', { label: 'CPL (Spend / Leads)', currency: ctx.currency }),
    ];

    return buildRecommendation({
      ctx,
      ruleId: PAUSE_NO_QUALIFIED_VQ.id,
      action: 'PAUSE_CREATIVE',
      scopeKey: ctx.campaignId,
      titleDe: `Pausieren: kein qualifizierter VQ nach ${formatMinor(counters.spendMinor, ctx.currency)} Spend`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Die Auslieferung der Kampagne „${ctx.campaignName}" in Meta pausieren. ` +
        `Bei ${formatMinor(counters.spendMinor, ctx.currency)} Spend und ${formatCount(counters.leads)} Leads ist kein einziger qualifizierter VQ entstanden. ` +
        `Die Kohorte hat das CRM-Reifefenster vollständig durchlaufen (seit ${ctx.maturity.earliestMatureAt.slice(0, 10)}) — das Ausbleiben ist damit ein Ergebnis und kein offener Datenstand. ` +
        `Der Spend liegt über dem ${ctx.config.noQualifiedVqSpendMultiple}-Fachen der Zielkosten von ${formatMinor(targetMinor, ctx.currency)}.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit den hinterlegten Zielkosten je qualifiziertem VQ von ${formatMinor(targetMinor, ctx.currency)} und der Regelschwelle vom ${ctx.config.noQualifiedVqSpendMultiple}-Fachen dieses Werts.`,
      uncertaintyDe:
        `Kein Schätzwert für die Kosten je qualifiziertem VQ, da der Nenner 0 ist. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'MEDIUM',
      riskNoteDe:
        'Ein Stopp beendet auch den Zufluss von Leads und damit den Lerneffekt. Vor der Ausführung prüfen, ob die Qualifizierungslogik im CRM korrekt gemappt ist — ein Mapping-Fehler sieht in diesen Zahlen identisch aus.',
      affectedMetaObjects: metaObjectsFor([ctx.campaign]),
    });
  },
};
