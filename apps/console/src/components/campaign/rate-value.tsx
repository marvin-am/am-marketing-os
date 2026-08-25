'use client';

import * as React from 'react';
import type { DataMaturity, MetricKey, MetricValue, Rate } from '@am/domain';
import {
  cn,
  DataMaturityBadge,
  formatMetricValueDe,
  formatPercentDe,
  metricBasisDe,
  noDenominatorNoteDe,
  NO_VALUE,
} from '@am/ui';
import { formatNumber } from '@/lib/format';

/**
 * A rate, told the way this product tells rates: the percentage and the
 * "12 / 340" it was computed from, side by side, always. A zero denominator
 * renders "–" rather than "0 %", because a zero reads as a measurement
 * (acceptance criterion 19, AGENTS.md "Rates").
 */
export interface RateValueProps extends React.HTMLAttributes<HTMLSpanElement> {
  rate: Rate;
  /** Rendered before the basis, e.g. "Leads". */
  basisLabelDe?: string;
  fractionDigits?: number;
  /** Stack the basis under the value instead of beside it. */
  stacked?: boolean;
}

export function RateValue({
  rate,
  basisLabelDe,
  fractionDigits = 1,
  stacked = false,
  className,
  ...props
}: RateValueProps) {
  const basis = `${formatNumber(rate.numerator)} / ${formatNumber(rate.denominator)}`;
  const zeroDenominator = rate.denominator === 0;

  return (
    <span
      data-am-rate=""
      className={cn(
        'gap-x-2 gap-y-0.5',
        stacked ? 'inline-flex flex-col items-start' : 'inline-flex flex-wrap items-baseline',
        className,
      )}
      {...props}
    >
      <span data-am-numeric="" className="font-medium tabular-nums text-foreground">
        {formatPercentDe(rate.value, fractionDigits)}
      </span>
      <span data-am-rate-basis="" className="text-xs tabular-nums text-muted-foreground">
        {basisLabelDe ? `${basisLabelDe}: ` : ''}
        {basis}
        {zeroDenominator ? ` – kein Nenner, daher ${NO_VALUE}` : ''}
      </span>
    </span>
  );
}

export interface MetricValueInlineProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: MetricValue;
  /** Show the maturity badge next to the number. Default: true. */
  withMaturity?: boolean;
}

/** The same discipline for a full `MetricValue` envelope, inline. */
export function MetricValueInline({
  value,
  withMaturity = true,
  className,
  ...props
}: MetricValueInlineProps) {
  const display = formatMetricValueDe(value.metric, value.value, value.currency, 'minor');
  /* Each side in its own unit and both named: a CPL of 11,47 € annotated
     "158.264 / 138" reads as 158 thousand of something. */
  const basis =
    value.numerator !== null && value.denominator !== null ? metricBasisDe(value) : null;
  const noDenominatorNote = noDenominatorNoteDe(value);

  return (
    <span
      data-am-metric={value.metric}
      className={cn('inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5', className)}
      {...props}
    >
      <span data-am-numeric="" className="font-medium tabular-nums text-foreground">
        {display}
      </span>
      {basis ? (
        <span data-am-rate-basis="" className="text-xs tabular-nums text-muted-foreground">
          {basis}
          {value.value === null ? ` ${noDenominatorNote ?? `– kein Nenner, daher ${NO_VALUE}`}` : ''}
        </span>
      ) : null}
      {withMaturity ? <MaturityChip maturity={value.maturity} /> : null}
    </span>
  );
}

function MaturityChip({ maturity }: { maturity: DataMaturity }) {
  return <DataMaturityBadge maturity={maturity} withHint={false} />;
}

/** Money in minor units, formatted for the metric it belongs to. */
export function metricDisplay(
  metric: MetricKey,
  value: number | null,
  currency: string | null,
): string {
  return formatMetricValueDe(metric, value, currency, 'minor');
}
