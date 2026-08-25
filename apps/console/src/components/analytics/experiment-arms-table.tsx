import * as React from 'react';
import type { ArmObservation, ArmResult, ExperimentArm, ExperimentThresholds } from '@am/domain';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@am/ui';
import { CircleCheckBig, CircleDashed } from 'lucide-react';
import { formatCurrencyMinor, formatNumber, formatPercent } from '@/lib/format';
import type { BreakdownRow, MetricSnapshot } from '@/server/analytics-port';
import { BreakdownTable } from './breakdown-table';
import {
  VizStyles,
} from './chart-theme';
import {
  VIZ_SERIES,
} from './chart-tokens';

/* -------------------------------------------------------------------------- */
/* Credible interval                                                           */
/* -------------------------------------------------------------------------- */

export interface CredibleIntervalBarProps {
  lower: number;
  upper: number;
  mean: number;
  /** Shared domain across all arms, so the bars are comparable. */
  domain: [number, number];
  colorVar: string;
  labelDe: string;
}

/**
 * The 95 % credible interval as a strip on a shared scale.
 *
 * Purely supplementary: the same three numbers stand in the cell beside it, so
 * nothing depends on reading a position or a colour. Overlapping strips are the
 * fastest way to see that two arms have not actually separated.
 */
export function CredibleIntervalBar({
  lower,
  upper,
  mean,
  domain,
  colorVar,
  labelDe,
}: CredibleIntervalBarProps): React.JSX.Element {
  const span = Math.max(domain[1] - domain[0], Number.EPSILON);
  const clamp = (value: number) => Math.min(100, Math.max(0, ((value - domain[0]) / span) * 100));
  const left = clamp(lower);
  const right = clamp(upper);

  return (
    <span
      role="img"
      aria-label={`${labelDe}: Glaubwürdigkeitsintervall von ${formatPercent(lower)} bis ${formatPercent(
        upper,
      )}, Posterior-Mittel ${formatPercent(mean)}`}
      className="relative block h-2 w-32 rounded-full bg-muted"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 rounded-full"
        style={{
          left: `${left}%`,
          width: `${Math.max(2, right - left)}%`,
          backgroundColor: colorVar,
        }}
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface"
        style={{ left: `${clamp(mean)}%`, backgroundColor: colorVar }}
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Gate marker                                                                 */
/* -------------------------------------------------------------------------- */

function GateCell({
  met,
  achieved,
  required,
  unitDe,
}: {
  met: boolean;
  achieved: number;
  required: number;
  unitDe: string;
}): React.JSX.Element {
  return (
    <span className="flex flex-col items-end gap-0.5 leading-tight">
      <span
        className={
          met
            ? 'inline-flex items-center gap-1 text-xs text-success'
            : 'inline-flex items-center gap-1 text-xs text-warning'
        }
      >
        {met ? (
          <CircleCheckBig aria-hidden="true" className="size-3.5" />
        ) : (
          <CircleDashed aria-hidden="true" className="size-3.5" />
        )}
        {met ? 'erreicht' : 'nicht erreicht'}
      </span>
      <span data-am-numeric="" className="text-[0.6875rem] text-muted-foreground">
        {formatNumber(achieved)} / {formatNumber(required)} {unitDe}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Arms table                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExperimentArmsTableProps {
  arms: readonly ArmResult[];
  observations: readonly ArmObservation[];
  thresholds: ExperimentThresholds;
  /** Arm that leads on P(best), for the marker in the label column. */
  leadingArmId: string | null;
  /** Only set when the verdict actually declares a winner. */
  winningArmId: string | null;
}

/**
 * Per-arm statistics.
 *
 * The conversion rate is always shown with its numerator and denominator, and
 * the two volume gates are shown as "erreicht / nicht erreicht" with the exact
 * counts, so an arm that leads on P(best) but sits below the minimum can never
 * be read as a result.
 */
export function ExperimentArmsTable({
  arms,
  observations,
  thresholds,
  leadingArmId,
  winningArmId,
}: ExperimentArmsTableProps): React.JSX.Element {
  const observationById = new Map(
    observations.map((observation) => [observation.arm_id, observation]),
  );

  const bounds = arms.reduce<[number, number]>(
    (acc, arm) => [
      Math.min(acc[0], arm.credibleInterval[0]),
      Math.max(acc[1], arm.credibleInterval[1]),
    ],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  );
  const domain: [number, number] =
    Number.isFinite(bounds[0]) && Number.isFinite(bounds[1]) && bounds[1] > bounds[0]
      ? [
          Math.max(0, bounds[0] - (bounds[1] - bounds[0]) * 0.1),
          bounds[1] + (bounds[1] - bounds[0]) * 0.1,
        ]
      : [0, 1];

  return (
    <div data-am-viz="">
      <VizStyles />
      <Table caption="Ergebnisse je Experimentarm mit Bezugsgrößen, Posterior und Volumenschwellen">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Arm</TableHead>
            <TableHead scope="col" className="text-right">
              Sessions
            </TableHead>
            <TableHead scope="col" className="text-right">
              Ausspielungen
            </TableHead>
            <TableHead scope="col" className="text-right">
              Conversions
            </TableHead>
            <TableHead scope="col" className="text-right">
              Conversion-Rate
            </TableHead>
            <TableHead scope="col" className="text-right">
              Posterior-Mittel
            </TableHead>
            <TableHead scope="col">95 %-Intervall</TableHead>
            <TableHead scope="col" className="text-right">
              P(bester Arm)
            </TableHead>
            <TableHead scope="col" className="text-right">
              Uplift vs. Kontrolle
            </TableHead>
            <TableHead scope="col" className="text-right">
              Mindest-Sessions
            </TableHead>
            <TableHead scope="col" className="text-right">
              Mindest-Conversions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {arms.map((arm, index) => {
            const observation = observationById.get(arm.arm_id);
            const color = VIZ_SERIES[index % VIZ_SERIES.length];
            return (
              <TableRow key={arm.arm_id} data-arm-key={arm.arm_key}>
                <TableCell className="align-top">
                  <span className="flex flex-col gap-1 leading-tight">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: color }}
                      />
                      {arm.label}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {arm.is_control ? (
                        <Badge tone="outline" size="sm">
                          Kontrolle
                        </Badge>
                      ) : null}
                      {arm.arm_id === winningArmId ? (
                        <Badge tone="success" size="sm">
                          Gewinner
                        </Badge>
                      ) : arm.arm_id === leadingArmId ? (
                        <Badge tone="neutral" size="sm">
                          führend, kein Gewinner
                        </Badge>
                      ) : null}
                    </span>
                  </span>
                </TableCell>
                <TableCell data-am-numeric="" className="align-top text-right">
                  {formatNumber(observation?.sessions ?? null)}
                </TableCell>
                <TableCell data-am-numeric="" className="align-top text-right">
                  {formatNumber(observation?.exposures ?? null)}
                </TableCell>
                <TableCell data-am-numeric="" className="align-top text-right">
                  {formatNumber(arm.conversionRate.numerator)}
                </TableCell>
                <TableCell className="align-top text-right">
                  <span className="flex flex-col items-end leading-tight">
                    <span data-am-numeric="" className="font-medium text-foreground">
                      {formatPercent(arm.conversionRate.value)}
                    </span>
                    <span data-am-numeric="" className="text-[0.6875rem] text-muted-foreground">
                      {formatNumber(arm.conversionRate.numerator)} /{' '}
                      {formatNumber(arm.conversionRate.denominator)}
                    </span>
                  </span>
                </TableCell>
                <TableCell data-am-numeric="" className="align-top text-right">
                  {formatPercent(arm.posteriorMean, 2)}
                </TableCell>
                <TableCell className="align-top">
                  <span className="flex flex-col gap-1">
                    <CredibleIntervalBar
                      lower={arm.credibleInterval[0]}
                      upper={arm.credibleInterval[1]}
                      mean={arm.posteriorMean}
                      domain={domain}
                      colorVar={color}
                      labelDe={arm.label}
                    />
                    <span data-am-numeric="" className="text-[0.6875rem] text-muted-foreground">
                      {formatPercent(arm.credibleInterval[0], 2)} –{' '}
                      {formatPercent(arm.credibleInterval[1], 2)}
                    </span>
                  </span>
                </TableCell>
                <TableCell data-am-numeric="" className="align-top text-right">
                  {formatPercent(arm.probabilityBest)}
                </TableCell>
                <TableCell data-am-numeric="" className="align-top text-right">
                  {arm.is_control ? (
                    <span className="text-muted-foreground">Referenz</span>
                  ) : (
                    formatPercent(arm.relativeLiftVsControl)
                  )}
                </TableCell>
                <TableCell className="align-top text-right">
                  <GateCell
                    met={arm.meetsMinSessions}
                    achieved={observation?.sessions ?? 0}
                    required={thresholds.minSessionsPerArm}
                    unitDe="Sessions"
                  />
                </TableCell>
                <TableCell className="align-top text-right">
                  <GateCell
                    met={arm.meetsMinConversions}
                    achieved={arm.conversionRate.numerator}
                    required={thresholds.minConversionsPerArm}
                    unitDe="Conversions"
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Business metrics per arm                                                    */
/* -------------------------------------------------------------------------- */

export interface ExperimentArmMetricsTableProps {
  arms: readonly ExperimentArm[];
  armMetrics: Record<string, MetricSnapshot>;
}

/** The full metric catalogue per arm, using the same table as every breakdown. */
export function ExperimentArmMetricsTable({
  arms,
  armMetrics,
}: ExperimentArmMetricsTableProps): React.JSX.Element {
  const rows: BreakdownRow[] = arms
    .filter((arm) => armMetrics[arm.id])
    .map((arm) => ({
      dimension: 'EXPERIMENT_ARM' as const,
      key: arm.id,
      labelDe: arm.label,
      contextDe: arm.is_control ? 'Kontrolle' : 'Variante',
      experimentId: arm.experiment_id,
      ...armMetrics[arm.id],
    }));

  return (
    <BreakdownTable
      rows={rows}
      entityLabelDe="Arm"
      captionDe="Kennzahlen je Experimentarm mit Datenreife und Attributionsabdeckung"
    />
  );
}

/** Spend per arm, formatted for the compact header line of the detail view. */
export function armSpendDe(observation: ArmObservation | undefined): string {
  return formatCurrencyMinor(observation?.spend_minor ?? null);
}
