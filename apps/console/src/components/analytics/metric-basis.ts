import { METRIC_CATALOG, type MetricKey, type MetricValue, type Rate } from '@am/domain';
import { formatCurrencyMinor, formatNumber } from '@/lib/format';

/**
 * The "12 / 340" line that sits under every number in the console.
 *
 * `MetricTile` renders numerator and denominator as plain counts, which is right
 * for a rate and wrong for a money-per-unit metric: a CPL whose numerator is
 * 1.305.465 minor units would read as 1,3 million of something. This module
 * formats each side in its own unit and names both, so the basis is legible
 * rather than merely present.
 */

interface BasisNouns {
  numerator: string;
  denominator: string;
}

const BASIS_NOUNS_DE: Partial<Record<MetricKey, BasisNouns>> = {
  ctr: { numerator: 'Link-Klicks', denominator: 'Impressionen' },
  cpc: { numerator: 'Spend', denominator: 'Link-Klicks' },
  cpm: { numerator: 'Spend', denominator: 'Impressionen' },
  form_start_rate: { numerator: 'Formularstarts', denominator: 'Sessions' },
  step_dropoff: { numerator: 'verlorene Steps', denominator: 'gesehene Steps' },
  submission_rate: { numerator: 'Leads', denominator: 'Sessions' },
  cpl: { numerator: 'Spend', denominator: 'Leads' },
  vq_scheduled_rate: { numerator: 'terminierte VQs', denominator: 'Leads' },
  show_rate: { numerator: 'stattgefundene VQs', denominator: 'terminierte VQs' },
  qualified_vq_rate: { numerator: 'qualifizierte VQs', denominator: 'stattgefundene VQs' },
  cost_per_qualified_vq: { numerator: 'Spend', denominator: 'qualifizierte VQs' },
  opportunity_rate: { numerator: 'Opportunities', denominator: 'Leads' },
  close_rate: { numerator: 'Abschlüsse', denominator: 'Opportunities' },
  cac: { numerator: 'Spend', denominator: 'Abschlüsse' },
  roas: { numerator: 'attribuierter Umsatz', denominator: 'Spend' },
};

/** Which side of the fraction is money, in integer minor units. */
function moneySides(metric: MetricKey): { numerator: boolean; denominator: boolean } {
  const unit = METRIC_CATALOG[metric].unit;
  if (metric === 'roas') return { numerator: true, denominator: true };
  if (unit === 'MONEY') return { numerator: true, denominator: false };
  return { numerator: false, denominator: false };
}

function side(value: number, isMoney: boolean, currency: string): string {
  return isMoney ? formatCurrencyMinor(value, currency) : formatNumber(value);
}

/**
 * The full basis of a metric value, or the catalogue formula when the metric is
 * a plain count and has no denominator to show.
 */
export function metricBasisDe(value: MetricValue): string {
  const definition = METRIC_CATALOG[value.metric];
  if (value.numerator === null || value.denominator === null) return definition.formula;

  const money = moneySides(value.metric);
  const currency = value.currency ?? 'EUR';
  const nouns = BASIS_NOUNS_DE[value.metric];

  const left = side(value.numerator, money.numerator, currency);
  const right = side(value.denominator, money.denominator, currency);

  if (!nouns) return `${left} / ${right}`;
  return `${left} ${nouns.numerator} / ${right} ${nouns.denominator}`;
}

/** The same line for a bare `Rate`, which is always a count over a count. */
export function rateBasisDe(value: Rate, nouns?: BasisNouns): string {
  const left = formatNumber(value.numerator);
  const right = formatNumber(value.denominator);
  if (!nouns) return `${left} / ${right}`;
  return `${left} ${nouns.numerator} / ${right} ${nouns.denominator}`;
}

/**
 * German note appended when a rate cannot be computed. A zero denominator is
 * never rendered as 0 % — it is a missing measurement, not a measured nothing.
 */
export function noDenominatorNoteDe(value: MetricValue): string | null {
  if (value.value !== null) return null;
  if (value.denominator === null) return null;
  if (value.denominator > 0) return null;
  const nouns = BASIS_NOUNS_DE[value.metric];
  const what = nouns ? nouns.denominator : 'Bezugsgröße';
  return `Kein Nenner: ${what} = 0. Es wird kein Wert ausgewiesen.`;
}
