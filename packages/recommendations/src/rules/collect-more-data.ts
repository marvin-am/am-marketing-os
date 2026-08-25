import { type RecommendationFact } from '@am/domain';
import { isMatureForDecision } from '@am/experiments';
import { type RuleContext } from '../context';
import {
  buildRecommendation,
  factFromMetric,
  formatCount,
  maturityCaveatDe,
  metaObjectsFor,
  type RecommendationRule,
} from './rule';

/**
 * The honest default.
 *
 * When no rule fires, the correct output is not an empty list and it is
 * certainly not `CONTINUE` dressed up as an insight. It is a statement of what
 * is still missing and when it will be there. An operator who opens the console
 * and sees nothing assumes the system is broken; one who sees "3 of the required
 * 5 leads, CRM data complete from 22.03." knows exactly where things stand.
 *
 * The engine emits this rule only when nothing else fired.
 */
export const COLLECT_MORE_DATA: RecommendationRule = {
  id: 'COLLECT_MORE_DATA',
  action: 'COLLECT_MORE_DATA',
  rank: 100,
  scope: 'CAMPAIGN',
  fallback: true,

  evaluate(ctx: RuleContext) {
    const counters = ctx.campaign.counters;
    const missing: string[] = [];

    if (counters.leads < ctx.config.minLeadsForLeadingSignals) {
      missing.push(
        `${formatCount(counters.leads)} von ${formatCount(ctx.config.minLeadsForLeadingSignals)} Leads, die für eine Aussage auf Basis der Frühindikatoren nötig sind`,
      );
    }
    if (counters.funnelSessions < ctx.benchmarks.minSessionsForFunnelSignal) {
      missing.push(
        `${formatCount(counters.funnelSessions)} von ${formatCount(ctx.benchmarks.minSessionsForFunnelSignal)} Funnel-Sessions für eine Funnel-Aussage`,
      );
    }
    if (counters.impressions < ctx.benchmarks.minImpressionsForCtrSignal) {
      missing.push(
        `${formatCount(counters.impressions)} von ${formatCount(ctx.benchmarks.minImpressionsForCtrSignal)} Impressionen für eine CTR-Aussage`,
      );
    }
    if (!isMatureForDecision(ctx.crmMaturity)) {
      missing.push(
        `vollständige CRM-Ergebnisse — die Kohorte ist zu ${Math.round(ctx.maturity.matureFraction * 100)} % ausgereift und vollständig ab dem ${ctx.maturity.earliestMatureAt.slice(0, 10)}`,
      );
    }

    const shortfallDe =
      missing.length > 0
        ? `Es fehlen: ${missing.join('; ')}.`
        : 'Alle Schwellenwerte sind erreicht, aber keine Regel zeigt einen belastbaren Handlungsbedarf — die Kampagne läuft im erwarteten Rahmen.';

    const facts: RecommendationFact[] = [
      factFromMetric(ctx.campaign.metrics, 'submission_rate', {
        label: 'Submission-Rate (Leads / Funnel-Sessions)',
      }),
      factFromMetric(ctx.campaign.metrics, 'ctr', { label: 'CTR (Link-Klicks / Impressionen)' }),
      factFromMetric(ctx.campaign.metrics, 'cpl', {
        label: 'CPL (Spend / Leads)',
        comparisonLabel: 'Ziel-CPL',
        comparisonValue: ctx.targets.targetCplMinor,
        currency: ctx.currency,
      }),
    ];

    return buildRecommendation({
      ctx,
      ruleId: COLLECT_MORE_DATA.id,
      action: 'COLLECT_MORE_DATA',
      scopeKey: ctx.campaignId,
      titleDe: 'Weiter Daten sammeln — noch keine belastbare Entscheidung möglich',
      summaryDe:
        `Vorgeschlagene Aktion: Die Kampagne „${ctx.campaignName}" unverändert weiterlaufen lassen und keine Budget- oder Pausierungsentscheidung treffen. ${shortfallDe} ` +
        `Aktueller Stand: ${formatCount(counters.impressions)} Impressionen, ${formatCount(counters.funnelSessions)} Funnel-Sessions, ${formatCount(counters.leads)} Leads, ${formatCount(counters.qualifiedVq)} qualifizierte VQs.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit den konfigurierten Mindestmengen für belastbare Aussagen: ${formatCount(ctx.config.minLeadsForLeadingSignals)} Leads, ${formatCount(ctx.benchmarks.minSessionsForFunnelSignal)} Funnel-Sessions, ${formatCount(ctx.benchmarks.minImpressionsForCtrSignal)} Impressionen und ein abgeschlossenes CRM-Reifefenster.`.slice(0, 400),
      uncertaintyDe:
        `Die vorliegenden Werte sind Zwischenstände, keine Ergebnisse. Eine Hochrechnung auf den Endstand ist auf dieser Basis nicht zulässig. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe:
        'Abwarten kostet Budget, das weiter in eine noch unbewertete Auslieferung fließt. Bei knappem Testbudget ist eine bewusste Verkleinerung der Auslieferung die Alternative.',
      affectedMetaObjects: metaObjectsFor([ctx.campaign]),
    });
  },
};
