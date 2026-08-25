import { type RecommendationFact } from '@am/domain';
import { type ResolvedSlice, type RuleContext } from '../context';
import {
  buildRecommendation,
  factFromMetric,
  formatCount,
  formatPercent,
  maturityCaveatDe,
  metaObjectsFor,
  type RecommendationRule,
} from './rule';

/**
 * Pattern rules — where the numbers point, rather than what to switch off.
 *
 * These three read the same two ratios in different combinations, and the
 * combination is the diagnosis:
 *
 *   CTR good, submission rate poor  → the click was earned, the funnel loses
 *                                     them. The offer is fine; the messaging
 *                                     after the click does not keep its promise.
 *   CTR poor across *every* concept → six different executions of the same
 *                                     angle all failed. The angle is wrong, not
 *                                     the execution.
 *   CTR mixed, funnel healthy       → the angle works and the funnel works; some
 *                                     concepts execute it better than others.
 *
 * None of them propose a live change, which is why they all carry LOW risk: they
 * propose *work*, and the work goes through the normal approval pipeline.
 */

/** Creatives with enough impressions for their CTR to mean anything. */
function readableCreatives(ctx: RuleContext): ResolvedSlice[] {
  return ctx.creatives.filter(
    (slice) => slice.counters.impressions >= ctx.benchmarks.minImpressionsForCtrSignal,
  );
}

function ctrOf(slice: ResolvedSlice): number | null {
  return slice.metrics.ctr.value;
}

/* -------------------------------------------------------------------------- */
/* Good CTR, poor submission rate → the funnel, not the creative               */
/* -------------------------------------------------------------------------- */

export const KEEP_OFFER_CHANGE_MESSAGING: RecommendationRule = {
  id: 'KEEP_OFFER_CHANGE_MESSAGING',
  action: 'KEEP_OFFER_CHANGE_MESSAGING',
  rank: 70,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    const counters = ctx.campaign.counters;
    if (counters.impressions < ctx.benchmarks.minImpressionsForCtrSignal) return null;
    if (counters.funnelSessions < ctx.benchmarks.minSessionsForFunnelSignal) return null;

    const ctr = ctx.campaign.metrics.ctr.value;
    const submissionRate = ctx.campaign.metrics.submission_rate.value;
    if (ctr === null || submissionRate === null) return null;

    if (ctr < ctx.benchmarks.ctrBenchmark) return null;
    if (submissionRate >= ctx.benchmarks.submissionRateBenchmark) return null;

    const facts: RecommendationFact[] = [
      factFromMetric(ctx.campaign.metrics, 'ctr', {
        label: 'CTR (Link-Klicks / Impressionen)',
        comparisonLabel: 'CTR-Benchmark',
        comparisonValue: ctx.benchmarks.ctrBenchmark,
      }),
      factFromMetric(ctx.campaign.metrics, 'submission_rate', {
        label: 'Submission-Rate (Leads / Funnel-Sessions)',
        comparisonLabel: 'Submission-Benchmark',
        comparisonValue: ctx.benchmarks.submissionRateBenchmark,
      }),
      factFromMetric(ctx.campaign.metrics, 'form_start_rate', {
        label: 'Formularstartrate (Formularstarts / Funnel-Sessions)',
      }),
      factFromMetric(ctx.campaign.metrics, 'step_dropoff', {
        label: 'Step-Abbruchrate über alle Schritte',
      }),
    ];

    return buildRecommendation({
      ctx,
      ruleId: KEEP_OFFER_CHANGE_MESSAGING.id,
      action: 'KEEP_OFFER_CHANGE_MESSAGING',
      scopeKey: ctx.campaignId,
      titleDe: `Offer beibehalten, Kommunikation nach dem Klick überarbeiten (CTR ${formatPercent(ctr, 2)}, Submission-Rate ${formatPercent(submissionRate, 1)})`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Das Offer unverändert lassen und die Kommunikation zwischen Anzeige und Formular überarbeiten — Versprechen der Anzeige, Headline des Funnels und die ersten Formularschritte aneinander angleichen. ` +
        `Die CTR von ${formatPercent(ctr, 2)} liegt über dem Benchmark von ${formatPercent(ctx.benchmarks.ctrBenchmark, 2)}: Das Angebot wird geklickt. Die Submission-Rate von ${formatPercent(submissionRate, 1)} liegt unter dem Benchmark von ${formatPercent(ctx.benchmarks.submissionRateBenchmark, 1)}: ` +
        `Von ${formatCount(counters.funnelSessions)} Funnel-Sessions führen nur ${formatCount(counters.leads)} zu einem Lead. Der Verlust entsteht nach dem Klick, nicht davor — ein neues Creative würde das Problem nicht adressieren.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit den konfigurierten Benchmarks: CTR ≥ ${formatPercent(ctx.benchmarks.ctrBenchmark, 2)} und Submission-Rate ≥ ${formatPercent(ctx.benchmarks.submissionRateBenchmark, 1)}, jeweils auf Kampagnenebene.`,
      uncertaintyDe:
        `Beobachtungsbasis: ${formatCount(counters.impressions)} Impressionen und ${formatCount(counters.funnelSessions)} Funnel-Sessions. Kein Kausalnachweis — die Zuordnung des Verlusts zum Funnel folgt aus der Position im Trichter, nicht aus einem Test. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe:
        'Es wird keine laufende Auslieferung verändert. Die neue Funnel-Version muss vor dem Livegang die Freigabe und die Launch-QA durchlaufen.',
      affectedMetaObjects: metaObjectsFor([ctx.campaign]),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Poor CTR across every concept → the angle                                   */
/* -------------------------------------------------------------------------- */

export const TEST_NEW_ANGLE: RecommendationRule = {
  id: 'TEST_NEW_ANGLE',
  action: 'TEST_NEW_ANGLE',
  rank: 90,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    const readable = readableCreatives(ctx);
    if (readable.length < ctx.benchmarks.minConceptsForAngleSignal) return null;

    const allBelow = readable.every((slice) => {
      const ctr = ctrOf(slice);
      return ctr !== null && ctr < ctx.benchmarks.ctrBenchmark;
    });
    if (!allBelow) return null;

    const best = readable.reduce((a, b) => ((ctrOf(a) ?? 0) >= (ctrOf(b) ?? 0) ? a : b));
    const facts: RecommendationFact[] = [
      factFromMetric(ctx.campaign.metrics, 'ctr', {
        label: `CTR über alle ${readable.length} Konzepte`,
        comparisonLabel: 'CTR-Benchmark',
        comparisonValue: ctx.benchmarks.ctrBenchmark,
      }),
      factFromMetric(best.metrics, 'ctr', {
        label: `Bestes Konzept „${best.label}" — CTR`,
        comparisonLabel: 'CTR-Benchmark',
        comparisonValue: ctx.benchmarks.ctrBenchmark,
      }),
      factFromMetric(ctx.campaign.metrics, 'cpm', {
        label: 'CPM (Spend / Impressionen × 1.000)',
        currency: ctx.currency,
      }),
    ];

    return buildRecommendation({
      ctx,
      ruleId: TEST_NEW_ANGLE.id,
      action: 'TEST_NEW_ANGLE',
      scopeKey: ctx.campaignId,
      titleDe: `Neuen Angle testen: alle ${readable.length} Konzepte unter dem CTR-Benchmark`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Einen neuen Angle entwickeln und als eigene Kampagne testen, statt weitere Creatives zum bestehenden Angle zu produzieren. ` +
        `Alle ${readable.length} ausgelieferten Konzepte liegen unter dem CTR-Benchmark von ${formatPercent(ctx.benchmarks.ctrBenchmark, 2)}; das beste („${best.label}") erreicht ${formatPercent(ctrOf(best) ?? 0, 2)}. ` +
        `Sechs unterschiedliche Ausführungen desselben Angles scheitern nicht an der Ausführung — die Perspektive selbst trifft die Zielgruppe nicht.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen mit dem CTR-Benchmark von ${formatPercent(ctx.benchmarks.ctrBenchmark, 2)}, angewendet auf jedes Konzept mit mindestens ${formatCount(ctx.benchmarks.minImpressionsForCtrSignal)} Impressionen.`,
      uncertaintyDe:
        `Beobachtungsbasis: ${readable.length} Konzepte mit je mindestens ${formatCount(ctx.benchmarks.minImpressionsForCtrSignal)} Impressionen. Ein schwacher Angle und eine falsch geschnittene Zielgruppe erzeugen dasselbe Bild; beides ist hier nicht unterscheidbar. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe:
        'Es wird keine laufende Auslieferung verändert. Ein neuer Angle durchläuft die vollständige Strategie- und Asset-Freigabe.',
      affectedMetaObjects: metaObjectsFor(readable),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Mixed CTR with a healthy funnel → iterate on what works                     */
/* -------------------------------------------------------------------------- */

export const NEW_CREATIVE_ITERATION: RecommendationRule = {
  id: 'NEW_CREATIVE_ITERATION',
  action: 'NEW_CREATIVE_ITERATION',
  rank: 80,
  scope: 'CAMPAIGN',

  evaluate(ctx: RuleContext) {
    const readable = readableCreatives(ctx);
    if (readable.length < 2) return null;

    const winners = readable.filter((slice) => (ctrOf(slice) ?? 0) >= ctx.benchmarks.ctrBenchmark);
    const losers = readable.filter((slice) => {
      const ctr = ctrOf(slice);
      return ctr !== null && ctr < ctx.benchmarks.ctrBenchmark;
    });
    if (winners.length === 0 || losers.length === 0) return null;

    const submissionRate = ctx.campaign.metrics.submission_rate.value;
    if (submissionRate === null || submissionRate < ctx.benchmarks.submissionRateBenchmark) return null;
    if (ctx.campaign.counters.funnelSessions < ctx.benchmarks.minSessionsForFunnelSignal) return null;

    const best = winners.reduce((a, b) => ((ctrOf(a) ?? 0) >= (ctrOf(b) ?? 0) ? a : b));
    const worst = losers.reduce((a, b) => ((ctrOf(a) ?? 1) <= (ctrOf(b) ?? 1) ? a : b));

    const facts: RecommendationFact[] = [
      factFromMetric(best.metrics, 'ctr', {
        label: `Bestes Konzept „${best.label}" — CTR`,
        comparisonLabel: 'CTR-Benchmark',
        comparisonValue: ctx.benchmarks.ctrBenchmark,
      }),
      factFromMetric(worst.metrics, 'ctr', {
        label: `Schwächstes Konzept „${worst.label}" — CTR`,
        comparisonLabel: 'CTR-Benchmark',
        comparisonValue: ctx.benchmarks.ctrBenchmark,
      }),
      factFromMetric(ctx.campaign.metrics, 'submission_rate', {
        label: 'Submission-Rate (Leads / Funnel-Sessions)',
        comparisonLabel: 'Submission-Benchmark',
        comparisonValue: ctx.benchmarks.submissionRateBenchmark,
      }),
    ];

    return buildRecommendation({
      ctx,
      ruleId: NEW_CREATIVE_ITERATION.id,
      action: 'NEW_CREATIVE_ITERATION',
      scopeKey: `${ctx.campaignId}:${best.key}`,
      titleDe: `Creative-Iteration auf „${best.label}" (CTR ${formatPercent(ctrOf(best) ?? 0, 2)} gegenüber ${formatPercent(ctrOf(worst) ?? 0, 2)})`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Eine neue Iteration auf Basis des Konzepts „${best.label}" erstellen — Hook und Bildidee beibehalten, Varianten in Copy und Motiv ableiten — und die ${losers.length} schwächeren Konzepte auslaufen lassen. ` +
        `„${best.label}" erreicht ${formatPercent(ctrOf(best) ?? 0, 2)} CTR, „${worst.label}" nur ${formatPercent(ctrOf(worst) ?? 0, 2)}, bei einem Benchmark von ${formatPercent(ctx.benchmarks.ctrBenchmark, 2)}. ` +
        `Die Submission-Rate liegt mit ${formatPercent(submissionRate, 1)} über dem Benchmark — Angle und Funnel funktionieren, die Konzepte setzen sie unterschiedlich gut um.`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen wurden ${readable.length} Konzepte mit mindestens ${formatCount(ctx.benchmarks.minImpressionsForCtrSignal)} Impressionen gegen den CTR-Benchmark von ${formatPercent(ctx.benchmarks.ctrBenchmark, 2)}.`,
      uncertaintyDe:
        `Beobachtungsbasis: ${formatCount(best.counters.impressions)} Impressionen für das beste und ${formatCount(worst.counters.impressions)} für das schwächste Konzept. Die Auslieferung wurde von Meta optimiert — der CTR-Unterschied ist kein randomisierter Vergleich. ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe:
        'Es wird keine laufende Auslieferung verändert. Neue Iterationen benötigen Diversitätsprüfung und Asset-Freigabe vor dem Launch.',
      affectedMetaObjects: metaObjectsFor([best, ...losers]),
    });
  },
};
