import {
  type AffectedMetaObject,
  type ArmResult,
  EXPERIMENT_VERDICT_LABELS_DE,
  METRIC_CATALOG,
  type RecommendationActionKind,
  type RecommendationFact,
} from '@am/domain';
import { EXPERIMENT_WARNING_LABELS_DE, shouldConclude } from '@am/experiments';
import { type ExperimentContextEntry, type RuleContext } from '../context';
import {
  buildRecommendation,
  formatCount,
  formatPercent,
  maturityCaveatDe,
  type RecommendationRule,
} from './rule';

/**
 * Experiment-driven rules.
 *
 * These are invoked once per experiment by the engine, with `ctx.experiments`
 * narrowed to a single entry — so each rule stays a pure function of one
 * decision, and three concurrent experiments produce three separate proposals
 * rather than one merged and unreadable one.
 */

function currentExperiment(ctx: RuleContext): ExperimentContextEntry | null {
  return ctx.experiments.length > 0 ? ctx.experiments[0] : null;
}

/** A fact built from an arm's conversion rate — always numerator/denominator. */
function armFact(entry: ExperimentContextEntry, arm: ArmResult, label: string): RecommendationFact {
  return {
    metric: entry.evaluation.result.primary_metric,
    label: label.slice(0, 160),
    numerator: arm.conversionRate.numerator,
    denominator: arm.conversionRate.denominator,
    value: arm.conversionRate.value,
    currency: null,
    comparisonLabel: 'P(bester Arm)',
    comparisonValue: arm.probabilityBest,
  };
}

function warningsDe(entry: ExperimentContextEntry): string {
  const codes = entry.evaluation.result.interpretationWarnings;
  const known = codes
    .map((code) => EXPERIMENT_WARNING_LABELS_DE[code as keyof typeof EXPERIMENT_WARNING_LABELS_DE])
    .filter((text): text is string => Boolean(text));
  return known.join(' ');
}

function armObjects(
  entry: ExperimentContextEntry,
  armIds: readonly string[],
): AffectedMetaObject[] {
  const objects: AffectedMetaObject[] = [];
  for (const armId of armIds) {
    for (const object of entry.armMetaObjects?.[armId] ?? []) objects.push(object);
  }
  return objects.sort(
    (a, b) => a.level.localeCompare(b.level) || a.external_id.localeCompare(b.external_id),
  );
}

/* -------------------------------------------------------------------------- */
/* Conclude                                                                    */
/* -------------------------------------------------------------------------- */

export const CONCLUDE_EXPERIMENT: RecommendationRule = {
  id: 'CONCLUDE_EXPERIMENT',
  action: 'CONCLUDE_EXPERIMENT',
  rank: 50,
  scope: 'EXPERIMENT',

  evaluate(ctx: RuleContext) {
    const entry = currentExperiment(ctx);
    if (entry === null) return null;

    const result = entry.evaluation.result;
    const { conclude, reasons } = shouldConclude(result);
    if (!conclude) return null;

    const winner = result.arms.find((arm) => arm.arm_id === result.winning_arm_id) ?? null;
    const control = result.arms.find((arm) => arm.is_control) ?? null;
    const definition = METRIC_CATALOG[result.primary_metric];

    const facts: RecommendationFact[] = [];
    if (winner) facts.push(armFact(entry, winner, `Gewinner-Arm „${winner.label}" — ${definition.label}`));
    if (control) facts.push(armFact(entry, control, `Kontrollarm „${control.label}" — ${definition.label}`));
    if (facts.length === 0) {
      for (const arm of result.arms) facts.push(armFact(entry, arm, `Arm „${arm.label}" — ${definition.label}`));
    }
    if (facts.length === 0) return null;

    const winnerDecided = reasons.includes('WINNER_DECIDED');
    const maxRuntime = reasons.includes('MAX_RUNTIME_REACHED');

    const uncertainty = winner
      ? `P(bester Arm) = ${formatPercent(winner.probabilityBest, 1)} bei einem Schwellenwert von ${formatPercent(result.thresholds.minWinProbability, 0)}; 95-%-Kredibilitätsintervall der Conversion-Rate ${formatPercent(winner.credibleInterval[0], 1)} bis ${formatPercent(winner.credibleInterval[1], 1)}.`
      : `Kein Arm hat die geforderte Gewinnwahrscheinlichkeit von ${formatPercent(result.thresholds.minWinProbability, 0)} erreicht.`;

    return buildRecommendation({
      ctx,
      ruleId: CONCLUDE_EXPERIMENT.id,
      action: 'CONCLUDE_EXPERIMENT',
      scopeKey: entry.experimentId,
      titleDe: `Experiment beenden: „${entry.name}" — ${EXPERIMENT_VERDICT_LABELS_DE[result.verdict]}`.slice(0, 200),
      summaryDe:
        `Vorgeschlagene Aktion: Das Experiment „${entry.name}" beenden und das Ergebnis als Learning festhalten. ` +
        (winnerDecided && winner
          ? `Der Arm „${winner.label}" gewinnt mit ${formatCount(winner.conversionRate.numerator)} von ${formatCount(winner.conversionRate.denominator)} (${formatPercent(winner.conversionRate.value ?? 0, 1)}) gegenüber der Kontrolle. `
          : '') +
        (maxRuntime
          ? `Die maximale Laufzeit von ${result.thresholds.maxRuntimeDays} Tagen ist nach ${Math.round(result.runtimeDays)} Tagen erreicht. `
          : '') +
        `Urteil: ${EXPERIMENT_VERDICT_LABELS_DE[result.verdict]}. ${warningsDe(entry)}`.slice(0, 1200),
      facts,
      comparisonBasisDe: `Verglichen wurde der führende Arm gegen den Kontrollarm auf der Primärmetrik ${definition.label} (${definition.formula}), Schwellenwerte: P(bester Arm) ≥ ${formatPercent(result.thresholds.minWinProbability, 0)}, relativer Uplift ≥ ${formatPercent(result.thresholds.minRelativeLift, 0)}.`.slice(0, 400),
      uncertaintyDe: `${uncertainty} ${maturityCaveatDe(ctx)}`.slice(0, 400),
      risk: 'LOW',
      riskNoteDe: winnerDecided
        ? 'Das Beenden friert den Arm-Zustand ein. Die Interpretationshinweise des Experiments gelten unverändert für das festgehaltene Learning.'
        : 'Ohne eindeutiges Ergebnis wird das Experiment ohne Gewinner beendet; die Hypothese bleibt offen.',
      affectedMetaObjects: armObjects(
        entry,
        result.arms.map((arm) => arm.arm_id),
      ),
      experimentId: entry.experimentId,
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Pause a materially and significantly worse arm                              */
/* -------------------------------------------------------------------------- */

/**
 * "Materially worse" and "significantly worse" are separate tests, and an arm
 * has to fail all three checks before it is proposed for pausing:
 *
 * - *material*: at least `materialWorseRelative` below the control in relative
 *   terms — a 2 % shortfall is not worth an action even when it is certain;
 * - *separated*: the arm's entire 95 % credible interval sits below the
 *   control's entire 95 % credible interval. Comparing against the control's
 *   point estimate instead would fire on arms that are merely probably behind,
 *   while the control's own uncertainty is still wide;
 * - *improbable*: the arm's P(best) is at or below the complement of the
 *   configured win threshold, so the bar for pausing an arm is tied to the same
 *   number that decides a winner rather than to a second, invented constant.
 */
function losingArms(entry: ExperimentContextEntry, ctx: RuleContext): ArmResult[] {
  const result = entry.evaluation.result;
  if (result.verdict === 'INSUFFICIENT_DATA') return [];

  const control = result.arms.find((arm) => arm.is_control);
  if (!control) return [];

  return result.arms.filter(
    (arm) =>
      !arm.is_control &&
      arm.meetsMinSessions &&
      (arm.relativeLiftVsControl ?? 0) <= -ctx.benchmarks.materialWorseRelative &&
      arm.credibleInterval[1] < control.credibleInterval[0] &&
      arm.probabilityBest <= 1 - result.thresholds.minWinProbability,
  );
}

function buildPauseArmRule(
  id: string,
  action: RecommendationActionKind,
  rank: number,
  appliesToKind: (kind: ExperimentContextEntry['kind']) => boolean,
  nounDe: string,
): RecommendationRule {
  return {
    id,
    action,
    rank,
    scope: 'EXPERIMENT',

    evaluate(ctx: RuleContext) {
      const entry = currentExperiment(ctx);
      if (entry === null || !appliesToKind(entry.kind)) return null;

      const losers = losingArms(entry, ctx);
      if (losers.length === 0) return null;

      const result = entry.evaluation.result;
      const control = result.arms.find((arm) => arm.is_control);
      if (!control) return null;

      const definition = METRIC_CATALOG[result.primary_metric];
      const facts: RecommendationFact[] = [
        ...losers.map((arm) =>
          armFact(entry, arm, `${nounDe} „${arm.label}" — ${definition.label}`),
        ),
        armFact(entry, control, `Kontrolle „${control.label}" — ${definition.label}`),
      ];

      const worst = losers.reduce((a, b) =>
        (a.relativeLiftVsControl ?? 0) <= (b.relativeLiftVsControl ?? 0) ? a : b,
      );

      return buildRecommendation({
        ctx,
        ruleId: id,
        action,
        scopeKey: `${entry.experimentId}:${losers.map((arm) => arm.arm_id).sort().join('+')}`,
        titleDe: `${nounDe} pausieren: „${worst.label}" liegt ${formatPercent(Math.abs(worst.relativeLiftVsControl ?? 0), 0)} unter der Kontrolle`.slice(0, 200),
        summaryDe:
          `Vorgeschlagene Aktion: ${losers.length === 1 ? `Den ${nounDe} „${worst.label}"` : `Die ${losers.length} ${nounDe}s ${losers.map((arm) => `„${arm.label}"`).join(', ')}`} im Experiment „${entry.name}" pausieren und den Traffic auf die verbleibenden Arme umlenken. ` +
          losers
            .map(
              (arm) =>
                `„${arm.label}": ${formatCount(arm.conversionRate.numerator)} / ${formatCount(arm.conversionRate.denominator)} (${formatPercent(arm.conversionRate.value ?? 0, 1)}), ${formatPercent(Math.abs(arm.relativeLiftVsControl ?? 0), 0)} unter der Kontrolle.`,
            )
            .join(' ')
            .slice(0, 700) +
          ` ${warningsDe(entry)}`.slice(0, 1200),
        facts,
        comparisonBasisDe: `Verglichen mit dem Kontrollarm „${control.label}" (${formatCount(control.conversionRate.numerator)} / ${formatCount(control.conversionRate.denominator)}) auf der Primärmetrik ${definition.label}. Schwellen: mindestens ${formatPercent(ctx.benchmarks.materialWorseRelative, 0)} Rückstand, keine Überschneidung der 95-%-Intervalle.`.slice(0, 400),
        uncertaintyDe:
          `Das 95-%-Kredibilitätsintervall von „${worst.label}" (${formatPercent(worst.credibleInterval[0], 1)} bis ${formatPercent(worst.credibleInterval[1], 1)}) liegt vollständig unterhalb des Intervalls der Kontrolle (${formatPercent(control.credibleInterval[0], 1)} bis ${formatPercent(control.credibleInterval[1], 1)}); P(bester Arm) = ${formatPercent(worst.probabilityBest, 1)}. ${maturityCaveatDe(ctx)}`.slice(0, 400),
        risk: 'MEDIUM',
        riskNoteDe: `Das Pausieren eines Arms beendet dessen Datenerhebung. Bei einem gebündelten Test lässt sich nachträglich nicht mehr trennen, welche Komponente den Rückstand verursacht hat.`,
        affectedMetaObjects: armObjects(
          entry,
          losers.map((arm) => arm.arm_id),
        ),
        experimentId: entry.experimentId,
      });
    },
  };
}

export const PAUSE_CREATIVE_UNDERPERFORMING = buildPauseArmRule(
  'PAUSE_CREATIVE',
  'PAUSE_CREATIVE',
  40,
  (kind) => kind === 'CREATIVE_EXPLORATION',
  'Creative-Arm',
);

export const PAUSE_FUNNEL_ARM_UNDERPERFORMING = buildPauseArmRule(
  'PAUSE_FUNNEL_ARM',
  'PAUSE_FUNNEL_ARM',
  45,
  (kind) => kind === 'FUNNEL_EXPERIMENT' || kind === 'BUNDLED_FUNNEL_TEST',
  'Funnelarm',
);
