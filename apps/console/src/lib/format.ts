import type { DataMaturity, Money, Rate } from '@am/domain';

/**
 * German formatting helpers.
 *
 * The UI language is German throughout; code and identifiers stay English. All
 * formatting goes through `Intl` with an explicit `de-DE` locale rather than the
 * runtime default, so a server in another region renders identically.
 */

const numberFormatters = new Map<string, Intl.NumberFormat>();

function formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let existing = numberFormatters.get(key);
  if (!existing) {
    existing = new Intl.NumberFormat('de-DE', options);
    numberFormatters.set(key, existing);
  }
  return existing;
}

export function formatNumber(value: number | null, fractionDigits = 0): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return formatter({
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatCurrencyMinor(
  amountMinor: number | null,
  currency = 'EUR',
  fractionDigits = 2,
): string {
  if (amountMinor === null || !Number.isFinite(amountMinor)) return '–';
  return formatter({
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amountMinor / 100);
}

export function formatMoney(money: Money | null): string {
  if (!money) return '–';
  return formatCurrencyMinor(money.amountMinor, money.currency);
}

/**
 * A percentage is never rendered without its inputs being available nearby.
 * A null value (zero denominator) renders as "–", never "0 %" — a zero reads
 * as a measurement, a dash reads as "we have not measured this yet".
 */
export function formatPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return `${formatNumber(value * 100, fractionDigits)} %`;
}

export function formatRate(rate: Rate | null, fractionDigits = 1): string {
  if (!rate) return '–';
  return formatPercent(rate.value, fractionDigits);
}

/** The "12 / 340" line that accompanies every rate in the UI. */
export function formatRateBasis(rate: Rate | null): string {
  if (!rate) return '–';
  return `${formatNumber(rate.numerator)} / ${formatNumber(rate.denominator)}`;
}

export function formatRatio(value: number | null, fractionDigits = 2): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return `${formatNumber(value, fractionDigits)}×`;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const dateFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '–' : dateFormatter.format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '–' : dateTimeFormatter.format(date);
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

const relativeFormatter = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  const diff = date.getTime() - now;
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= ms) {
      return relativeFormatter.format(Math.round(diff / ms), unit);
    }
  }
  return 'gerade eben';
}

export function formatDuration(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '–';
  if (days < 1) return 'weniger als 1 Tag';
  const rounded = Math.round(days);
  return rounded === 1 ? '1 Tag' : `${formatNumber(rounded)} Tage`;
}

/* -------------------------------------------------------------------------- */
/* Domain labels                                                               */
/* -------------------------------------------------------------------------- */

export const MATURITY_EXPLANATION_DE: Readonly<Record<DataMaturity, string>> = {
  IMMATURE:
    'Die CRM-Ergebnisse dieser Kohorte sind noch nicht alt genug, um belastbar zu sein. Es wird kein Gewinner ausgerufen und nicht skaliert.',
  PARTIAL:
    'Ein Teil der CRM-Ergebnisse ist reif. Aussagen sind vorläufig und können sich noch verschieben.',
  MATURE:
    'Die CRM-Ergebnisse dieser Kohorte sind reif und können als belastbar behandelt werden.',
};

export function formatCoverage(coverage: number | null): string {
  if (coverage === null) return 'keine Daten';
  return `${formatNumber(coverage * 100, 0)} % exakt zugeordnet`;
}
