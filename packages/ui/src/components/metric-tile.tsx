'use client';

import * as React from 'react';
import {
  METRIC_CATALOG,
  METRIC_MEASUREMENT_LABELS_DE,
  type DataMaturity,
  type MetricDirection,
  type MetricKey,
  type MetricValue,
  type Rate,
} from '@am/domain';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  formatCountDe,
  formatMetricValueDe,
  formatMoneyMinorDe,
  formatNumberDe,
  formatPercentDe,
  isRate,
  NO_VALUE,
  type ValueScale,
} from '../lib/format';
import { metricBasisDe, noDenominatorNoteDe } from '../lib/metric-basis';
import { AttributionCoverageBadge } from './attribution-coverage-badge';
import { DataMaturityBadge } from './data-maturity-badge';
import { InfoHint } from './tooltip';

/** Renders a target delta in the unit of the metric it belongs to. */
export function formatDeltaDe(
  delta: number,
  metric: MetricKey | null,
  currency: string | null,
  scale: ValueScale,
): string {
  const sign = delta > 0 ? '+' : '';
  const unit = metric ? METRIC_CATALOG[metric].unit : 'RATE';
  switch (unit) {
    case 'RATE':
      return `${sign}${formatNumberDe(delta * 100, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })} pp`;
    case 'MONEY':
      return `${sign}${formatMoneyMinorDe(scale === 'minor' ? delta : delta * 100, currency ?? 'EUR')}`;
    case 'RATIO':
      return `${sign}${formatNumberDe(delta, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    case 'COUNT':
    default:
      return `${sign}${formatCountDe(delta)}`;
  }
}

export interface MetricTileProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** A computed `Rate` or a full `MetricValue` envelope from `@am/domain`. */
  value: Rate | MetricValue;
  /**
   * Metric key driving label, unit, formula and target direction. A
   * `MetricValue` supplies it; a bare `Rate` needs `metric` or `label`.
   */
  metric?: MetricKey;
  /** Overrides the catalogue label. Required when nothing supplies a metric key. */
  label?: string;
  /** Overrides the maturity carried by a `MetricValue`; required for a `Rate`. */
  maturity?: DataMaturity;
  /** Overrides the coverage carried by a `MetricValue`. */
  attributionCoverage?: number | null;
  /** Target the campaign is steered against, in the metric's own unit. */
  target?: number | null;
  targetLabel?: string;
  /** Which way is good when no metric key supplies a direction. */
  targetDirection?: MetricDirection;
  /** Money metrics carry integer minor units unless told otherwise. */
  valueScale?: ValueScale;
  /** Overrides the catalogue formula shown under the value. */
  denominatorLabel?: React.ReactNode;
  /** German explanation behind the "?" next to the label. */
  hint?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md';
}

/**
 * One number, told honestly.
 *
 * The tile *always* renders the numerator and denominator underneath the value
 * and a data-maturity badge beside the label, so nobody can read "3,5 %"
 * without also seeing "12 / 340" and how reliable that is (acceptance
 * criterion 19, spec §4.3). A rate with a zero denominator shows "–", never 0.
 */
export const MetricTile = React.forwardRef<HTMLDivElement, MetricTileProps>(function MetricTile(
  {
    className,
    value,
    metric,
    label,
    maturity,
    attributionCoverage,
    target = null,
    targetLabel = 'Ziel',
    targetDirection,
    valueScale = 'minor',
    denominatorLabel,
    hint,
    footer,
    size = 'md',
    ...props
  },
  ref,
) {
  const labelId = React.useId();
  const asMetricValue = isRate(value) ? null : value;
  const metricKey: MetricKey | null = asMetricValue?.metric ?? metric ?? null;
  const definition = metricKey ? METRIC_CATALOG[metricKey] : null;

  const numerator = value.numerator;
  const denominator = value.denominator;
  const numericValue = value.value;
  const currency = asMetricValue?.currency ?? null;

  const resolvedMaturity = maturity ?? asMetricValue?.maturity ?? null;
  const resolvedCoverage =
    attributionCoverage !== undefined
      ? attributionCoverage
      : (asMetricValue?.attributionCoverage ?? null);

  const resolvedLabel = label ?? definition?.label ?? String(metricKey ?? '');
  const displayValue = metricKey
    ? formatMetricValueDe(metricKey, numericValue, currency, valueScale)
    : formatPercentDe(numericValue);

  /* A MetricValue knows its own units, so its basis is formatted per side and
     named; a bare Rate is a count over a count and needs no unit. */
  const fraction = asMetricValue
    ? metricBasisDe(asMetricValue)
    : numerator !== null && denominator !== null
      ? `${formatCountDe(numerator)} / ${formatCountDe(denominator)}`
      : null;
  const noDenominatorNote = asMetricValue ? noDenominatorNoteDe(asMetricValue) : null;

  const direction: MetricDirection =
    targetDirection ?? definition?.direction ?? 'HIGHER_IS_BETTER';

  const delta = target !== null && numericValue !== null ? numericValue - target : null;
  const onTarget = delta !== null && Math.abs(delta) < Number.EPSILON;
  const better =
    delta === null ? null : direction === 'HIGHER_IS_BETTER' ? delta >= 0 : delta <= 0;
  const DeltaIcon = onTarget ? Minus : delta !== null && delta > 0 ? TrendingUp : TrendingDown;

  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={labelId}
      data-metric={metricKey ?? undefined}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-surface',
        size === 'sm' ? 'p-3.5' : 'p-4',
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          id={labelId}
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {resolvedLabel}
        </span>
        {(hint ?? definition) ? (
          <InfoHint label={`Erklärung zu ${resolvedLabel}`}>
            {hint ?? `Berechnung: ${definition?.formula}`}
          </InfoHint>
        ) : null}
        {definition?.measurement === 'DERIVED' ? (
          /* An estimate rendered identically to an observation invites a
             decision it cannot carry, so the marker sits on the number itself
             rather than in a footnote someone has to go looking for. */
          <span
            data-am-derived=""
            title="Diese Kennzahl ist abgeleitet, nicht gemessen."
            className="rounded-sm border border-border px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {METRIC_MEASUREMENT_LABELS_DE.DERIVED}
          </span>
        ) : null}
        {resolvedMaturity ? (
          <DataMaturityBadge maturity={resolvedMaturity} withHint={false} className="ml-auto" />
        ) : null}
      </div>

      <p
        data-am-numeric=""
        data-am-metric-value=""
        className={cn(
          'font-semibold leading-none tracking-tight text-foreground',
          size === 'sm' ? 'text-xl' : 'text-2xl',
          numericValue === null && 'text-muted-foreground',
        )}
      >
        {displayValue}
      </p>

      {/* The basis of the number is never optional. */}
      <p
        data-am-numeric=""
        data-am-metric-basis=""
        className="text-xs leading-snug text-muted-foreground"
      >
        {denominatorLabel ?? fraction ?? definition?.formula ?? 'Keine Bezugsgröße hinterlegt'}
        {numericValue === null && fraction ? (
          <span className="ml-1">{noDenominatorNote ?? `– kein Nenner, daher ${NO_VALUE}`}</span>
        ) : null}
      </p>

      {delta !== null ? (
        <p
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium',
            onTarget ? 'text-muted-foreground' : better ? 'text-success' : 'text-destructive',
          )}
        >
          <DeltaIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            {targetLabel}{' '}
            {metricKey
              ? formatMetricValueDe(metricKey, target, currency, valueScale)
              : formatPercentDe(target)}
          </span>
          <span aria-hidden="true">·</span>
          <span data-am-numeric="">
            {formatDeltaDe(delta, metricKey, currency, valueScale)}
            <span className="sr-only">
              {' '}
              {onTarget ? 'auf Ziel' : better ? 'besser als Ziel' : 'schlechter als Ziel'}
            </span>
          </span>
        </p>
      ) : null}

      {resolvedCoverage !== null ? (
        <div className="pt-0.5">
          <AttributionCoverageBadge coverage={resolvedCoverage} withHint={false} />
        </div>
      ) : null}

      {footer ? <div className="pt-1 text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  );
});
