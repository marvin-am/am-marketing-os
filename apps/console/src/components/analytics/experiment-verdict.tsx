import * as React from 'react';
import {
  type ArmObservation,
  DATA_MATURITY_LABELS_DE,
  EXPERIMENT_VERDICT_LABELS_DE,
  type ExperimentResult,
  type ExperimentVerdict,
} from '@am/domain';
import { EXPERIMENT_REASON_LABELS_DE, type MaturityAssessment } from '@am/experiments';
import {
  Alert,
  type AlertTone,
  AlertDescription,
  AlertTitle,
  DataMaturityBadge,
  StatusBadge,
} from '@am/ui';
import { CircleCheckBig, CircleDashed } from 'lucide-react';
import { formatDate, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { InterpretationWarnings } from './interpretation-warnings';

/* -------------------------------------------------------------------------- */
/* Verdict presentation                                                        */
/* -------------------------------------------------------------------------- */

interface VerdictAppearance {
  tone: AlertTone;
  /** One German sentence stating exactly what the verdict does and does not say. */
  headlineDe: string;
}

const VERDICT: Readonly<Record<ExperimentVerdict, VerdictAppearance>> = {
  WINNER: {
    tone: 'success',
    headlineDe:
      'Gewinner. Alle Entscheidungsschwellen sind erfüllt und die CRM-Kohorte ist ausgereift.',
  },
  PROVISIONAL: {
    tone: 'warning',
    headlineDe:
      'Kein Gewinner. Die Variante führt statistisch, aber die CRM-Ergebnisse der Kohorte sind noch nicht reif — das Ergebnis kann sich noch verschieben.',
  },
  NO_DIFFERENCE: {
    tone: 'neutral',
    headlineDe:
      'Kein entscheidungsrelevanter Unterschied. Keine Variante schlägt die Kontrolle deutlich genug, um einen Wechsel zu rechtfertigen.',
  },
  INCONCLUSIVE: {
    tone: 'neutral',
    headlineDe:
      'Nicht eindeutig. Die geforderte Gewinnwahrscheinlichkeit wurde nicht erreicht — weder für die Variante noch gegen sie.',
  },
  INSUFFICIENT_DATA: {
    tone: 'destructive',
    headlineDe:
      'Datenbasis zu klein. Es wird kein Ergebnis ausgewiesen, weil die Mindestvolumina noch nicht erreicht sind.',
  },
};

/**
 * The verdict as the console's single lifecycle badge. The badge alone never
 * carries the meaning — `ExperimentVerdictPanel` states in German what each
 * verdict does and does not claim.
 */
export function ExperimentVerdictBadge({
  verdict,
  className,
}: {
  verdict: ExperimentVerdict;
  className?: string;
}): React.JSX.Element {
  return (
    <StatusBadge
      kind="verdict"
      state={verdict}
      data-verdict={verdict}
      className={className}
      aria-label={`Urteil: ${EXPERIMENT_VERDICT_LABELS_DE[verdict]}`}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Threshold checklist                                                         */
/* -------------------------------------------------------------------------- */

interface ThresholdCheck {
  id: string;
  labelDe: string;
  requiredDe: string;
  achievedDe: string;
  met: boolean;
  /** German sentence naming the gap. Only set when `met` is false. */
  gapDe: string | null;
}

function smallestArm(observations: readonly ArmObservation[], pick: (o: ArmObservation) => number) {
  return observations.reduce<{ label: string; value: number } | null>((worst, observation) => {
    const value = pick(observation);
    if (!worst || value < worst.value) return { label: observation.label, value };
    return worst;
  }, null);
}

export function thresholdChecks(
  result: ExperimentResult,
  observations: readonly ArmObservation[],
  maturity: MaturityAssessment,
): ThresholdCheck[] {
  const thresholds = result.thresholds;
  const checks: ThresholdCheck[] = [];

  const runtimeMet = result.runtimeDays >= thresholds.minRuntimeDays;
  checks.push({
    id: 'runtime',
    labelDe: 'Mindestlaufzeit',
    requiredDe: formatDuration(thresholds.minRuntimeDays),
    achievedDe: formatDuration(result.runtimeDays),
    met: runtimeMet,
    gapDe: runtimeMet
      ? null
      : `Es fehlen noch ${formatDuration(thresholds.minRuntimeDays - result.runtimeDays)}.`,
  });

  const weakestSessions = smallestArm(observations, (o) => o.sessions);
  const sessionsMet = result.arms.length > 0 && result.arms.every((arm) => arm.meetsMinSessions);
  checks.push({
    id: 'sessions',
    labelDe: 'Sessions je Arm',
    requiredDe: `${formatNumber(thresholds.minSessionsPerArm)} je Arm`,
    achievedDe: weakestSessions
      ? `${formatNumber(weakestSessions.value)} (${weakestSessions.label})`
      : '–',
    met: sessionsMet,
    gapDe:
      sessionsMet || !weakestSessions
        ? null
        : `„${weakestSessions.label}“ fehlen ${formatNumber(
            Math.max(0, thresholds.minSessionsPerArm - weakestSessions.value),
          )} Sessions.`,
  });

  const weakestConversions = result.arms.reduce<{ label: string; value: number } | null>(
    (worst, arm) => {
      const value = arm.conversionRate.numerator;
      if (!worst || value < worst.value) return { label: arm.label, value };
      return worst;
    },
    null,
  );
  const conversionsMet =
    result.arms.length > 0 && result.arms.every((arm) => arm.meetsMinConversions);
  checks.push({
    id: 'conversions',
    labelDe: 'Conversions je Arm',
    requiredDe: `${formatNumber(thresholds.minConversionsPerArm)} je Arm`,
    achievedDe: weakestConversions
      ? `${formatNumber(weakestConversions.value)} (${weakestConversions.label})`
      : '–',
    met: conversionsMet,
    gapDe:
      conversionsMet || !weakestConversions
        ? null
        : `„${weakestConversions.label}“ fehlen ${formatNumber(
            Math.max(0, thresholds.minConversionsPerArm - weakestConversions.value),
          )} Conversions.`,
  });

  const leader = result.arms.reduce<(typeof result.arms)[number] | null>(
    (best, arm) => (!best || arm.probabilityBest > best.probabilityBest ? arm : best),
    null,
  );
  const probabilityMet = result.reasons.includes('WIN_PROBABILITY_MET');
  checks.push({
    id: 'probability',
    labelDe: 'Gewinnwahrscheinlichkeit',
    requiredDe: `≥ ${formatPercent(thresholds.minWinProbability, 0)}`,
    achievedDe: leader ? `${formatPercent(leader.probabilityBest)} (${leader.label})` : '–',
    met: probabilityMet,
    gapDe: probabilityMet
      ? null
      : 'Kein Arm erreicht die geforderte Gewinnwahrscheinlichkeit. Mehr Daten oder ein größerer Effekt sind nötig.',
  });

  const liftMet = result.reasons.includes('RELATIVE_LIFT_MET');
  const leaderLift = leader?.relativeLiftVsControl ?? null;
  checks.push({
    id: 'lift',
    labelDe: 'Relevanter Uplift',
    requiredDe: `≥ ${formatPercent(thresholds.minRelativeLift, 0)}`,
    achievedDe: leaderLift === null ? '–' : formatPercent(leaderLift),
    met: liftMet,
    gapDe: liftMet
      ? null
      : 'Der Unterschied bleibt unter der Relevanzschwelle — statistisch belegbar heißt hier nicht praktisch relevant.',
  });

  const matureMet = result.maturity === 'MATURE';
  checks.push({
    id: 'maturity',
    labelDe: 'CRM-Reifefenster',
    requiredDe: formatDuration(maturity.windowDays),
    achievedDe: `${DATA_MATURITY_LABELS_DE[result.maturity]} · ${formatDuration(maturity.ageDays)} alt`,
    met: matureMet,
    gapDe: matureMet
      ? null
      : `Belastbar frühestens am ${formatDate(maturity.earliestMatureAt)} — noch ${formatDuration(
          maturity.remainingDays,
        )}.`,
  });

  return checks;
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

export interface ExperimentVerdictPanelProps {
  result: ExperimentResult;
  observations: readonly ArmObservation[];
  maturity: MaturityAssessment;
  winningArmLabelDe: string | null;
}

function reasonLabelDe(code: string): string {
  return (EXPERIMENT_REASON_LABELS_DE as Readonly<Record<string, string>>)[code] ?? code;
}

/**
 * The verdict, told honestly.
 *
 * `PROVISIONAL` never renders as a winner: it says in German that the CRM
 * outcomes are not mature and that no winner is being called. `INSUFFICIENT_DATA`
 * names each unmet gate and the exact remaining gap. `WINNER` is the only state
 * that shows a winning arm, and it shows the thresholds it cleared alongside it.
 */
export function ExperimentVerdictPanel({
  result,
  observations,
  maturity,
  winningArmLabelDe,
}: ExperimentVerdictPanelProps): React.JSX.Element {
  const appearance = VERDICT[result.verdict];
  const checks = thresholdChecks(result, observations, maturity);
  const unmet = checks.filter((check) => !check.met);

  return (
    <div className="flex flex-col gap-4">
      <Alert tone={appearance.tone} data-verdict={result.verdict}>
        <AlertTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <ExperimentVerdictBadge verdict={result.verdict} />
          <DataMaturityBadge maturity={result.maturity} />
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2 text-sm leading-relaxed text-foreground">
          <p>{appearance.headlineDe}</p>

          {result.verdict === 'WINNER' && winningArmLabelDe ? (
            <p>
              Gewinnender Arm: <strong>{winningArmLabelDe}</strong>.
            </p>
          ) : null}

          {result.verdict === 'PROVISIONAL' ? (
            <>
              <p>
                <strong>Dies ist kein Gewinner.</strong> Führender Arm: {winningArmLabelDe ?? '–'}.
                Bis zur Reife der CRM-Kohorte wird kein Gewinner ausgerufen und nicht auf Basis
                dieses Ergebnisses skaliert.
              </p>
              <p>
                Belastbare Aussagen frühestens am {formatDate(maturity.earliestMatureAt)} — noch{' '}
                {formatDuration(maturity.remainingDays)}.
              </p>
            </>
          ) : null}

          {result.verdict === 'INSUFFICIENT_DATA' ? (
            <div className="flex flex-col gap-1">
              <p>Es fehlt konkret:</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {unmet.length === 0 ? (
                  <li>Die Auswertung liegt noch nicht vor.</li>
                ) : (
                  unmet.map((check) => (
                    <li key={check.id}>
                      <strong>{check.labelDe}:</strong> {check.gapDe ?? 'Schwelle nicht erreicht.'}{' '}
                      <span className="text-muted-foreground" data-am-numeric="">
                        (gefordert {check.requiredDe}, erreicht {check.achievedDe})
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}

          {result.reasons.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              {result.reasons.map((reason) => (
                <li key={reason}>{reasonLabelDe(reason)}</li>
              ))}
            </ul>
          ) : null}
        </AlertDescription>
      </Alert>

      <InterpretationWarnings codes={result.interpretationWarnings} />

      <ThresholdChecklist checks={checks} />
    </div>
  );
}

export function ThresholdChecklist({
  checks,
}: {
  checks: readonly ThresholdCheck[];
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Entscheidungsschwellen und ihr Erfüllungsstand</caption>
        <thead className="[&_tr]:border-b [&_tr]:border-border">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">
              Schwelle
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">
              Gefordert
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">
              Erreicht
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-2 text-left font-medium text-foreground">
                {check.labelDe}
              </th>
              <td data-am-numeric="" className="px-3 py-2 text-muted-foreground">
                {check.requiredDe}
              </td>
              <td data-am-numeric="" className="px-3 py-2 text-foreground">
                {check.achievedDe}
              </td>
              <td className="px-3 py-2">
                {check.met ? (
                  <span className="inline-flex items-center gap-1.5 text-success">
                    <CircleCheckBig aria-hidden="true" className="size-3.5" />
                    Erfüllt
                  </span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    <span className="inline-flex items-center gap-1.5 text-warning">
                      <CircleDashed aria-hidden="true" className="size-3.5" />
                      Nicht erfüllt
                    </span>
                    {check.gapDe ? (
                      <span className="text-xs text-muted-foreground">{check.gapDe}</span>
                    ) : null}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
