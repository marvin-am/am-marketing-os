import {
  METRIC_CATALOG,
  type MetricKey,
  type MetricValue,
  type Money,
  type Rate,
} from '@am/domain';

/**
 * The single character the product uses for "no measurement". A rate with a
 * zero denominator is *not* 0 % — it is unknown, and must never be rendered as
 * a number (spec §4.3, AGENTS.md "Rates").
 */
export const NO_VALUE = '–';

const LOCALE = 'de-DE';

export function formatNumberDe(
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return new Intl.NumberFormat(LOCALE, options).format(value);
}

/** Whole counts: "1.204". */
export function formatCountDe(value: number | null | undefined): string {
  return formatNumberDe(value, { maximumFractionDigits: 0 });
}

/** A 0–1 fraction as a German percentage: "3,5 %". */
export function formatPercentDe(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return `${formatNumberDe(value * 100, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} %`;
}

/** Money held as integer minor units: "1.234,56 €". */
export function formatMoneyMinorDe(
  amountMinor: number | null | undefined,
  currency = 'EUR',
): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor)) {
    return NO_VALUE;
  }
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
  }).format(amountMinor / 100);
}

export function formatMoneyDe(value: Money | null | undefined): string {
  if (!value) return NO_VALUE;
  return formatMoneyMinorDe(value.amountMinor, value.currency);
}

/** Unitless ratios such as ROAS: "4,2×". */
export function formatRatioDe(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return `${formatNumberDe(value, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}×`;
}

/**
 * The numerator/denominator line that sits under every rate. Rendered even
 * when the value itself is unknown, because "0 / 0" is the explanation for the
 * dash above it.
 */
export function formatFractionDe(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): string | null {
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined) return null;
  return `${formatCountDe(numerator)} / ${formatCountDe(denominator)}`;
}

export function formatRateDe(value: Rate | null | undefined, fractionDigits = 1): string {
  if (!value) return NO_VALUE;
  return formatPercentDe(value.value, fractionDigits);
}

export function formatDateTimeDe(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatDateDe(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' }).format(date);
}

/** Whether a value is a `Rate` rather than a full `MetricValue`. */
export function isRate(value: Rate | MetricValue): value is Rate {
  return !('metric' in value);
}

/**
 * Money-valued metrics carry integer minor units, like every other amount in
 * the system. A caller holding major units can say so explicitly.
 */
export type ValueScale = 'minor' | 'major';

/**
 * Renders a metric according to its catalogue unit. Never invents a number: a
 * null value is always {@link NO_VALUE}.
 */
export function formatMetricValueDe(
  metric: MetricKey,
  value: number | null,
  currency: string | null = null,
  scale: ValueScale = 'minor',
): string {
  if (value === null || !Number.isFinite(value)) return NO_VALUE;
  switch (METRIC_CATALOG[metric].unit) {
    case 'RATE':
      return formatPercentDe(value);
    case 'MONEY':
      return formatMoneyMinorDe(scale === 'minor' ? value : value * 100, currency ?? 'EUR');
    case 'RATIO':
      return formatRatioDe(value);
    case 'COUNT':
    default:
      return formatCountDe(value);
  }
}

/** German label for a metric key, straight from the domain catalogue. */
export function metricLabelDe(metric: MetricKey): string {
  return METRIC_CATALOG[metric].label;
}

/** The human-readable formula shown beside every metric. */
export function metricFormulaDe(metric: MetricKey): string {
  return METRIC_CATALOG[metric].formula;
}
