import {
  costPer,
  type DataMaturity,
  METRIC_CATALOG,
  METRIC_KEYS,
  type MetricKey,
  type MetricValue,
  rate,
  type Rate,
} from '@am/domain';

/**
 * Deterministic computation of every metric in `METRIC_CATALOG` from raw
 * counters.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Never a bare number.** Every result is a `MetricValue` carrying its
 *    numerator, denominator, maturity and attribution coverage, so the console
 *    can render "12 / 340" beside "3,5 %" and can never show a rate whose base
 *    the reader cannot see (acceptance criterion 19).
 * 2. **A zero denominator yields `value: null`.** Not `0`, which reads as a
 *    measured "nothing happened" rather than "nothing was measured".
 *
 * Money stays in integer minor units throughout. Per-unit costs are rounded
 * once, at the point of division, via `costPer` from `@am/domain`.
 */

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The raw, additive counters every metric is derived from. Additive on purpose:
 * a daily rollup is the element-wise sum of its rows, and a cumulative rollup is
 * the sum of its days. Rates are never summed — they are recomputed from summed
 * counters, which is why they are absent here.
 */
export interface MetricCounters {
  impressions: number;
  linkClicks: number;
  spendMinor: number;
  /** Distinct sessions that saw the funnel. */
  funnelSessions: number;
  /** Distinct sessions that started the form. */
  formStarts: number;
  /** Step impressions across all steps (denominator of the drop-off rate). */
  formStepViews: number;
  /** Step completions across all steps. */
  formStepCompletions: number;
  /** Accepted submissions. */
  leads: number;
  vqScheduled: number;
  vqAttended: number;
  qualifiedVq: number;
  opportunities: number;
  closedWon: number;
  revenueMinor: number;
}

export const EMPTY_METRIC_COUNTERS: Readonly<MetricCounters> = Object.freeze({
  impressions: 0,
  linkClicks: 0,
  spendMinor: 0,
  funnelSessions: 0,
  formStarts: 0,
  formStepViews: 0,
  formStepCompletions: 0,
  leads: 0,
  vqScheduled: 0,
  vqAttended: 0,
  qualifiedVq: 0,
  opportunities: 0,
  closedWon: 0,
  revenueMinor: 0,
});

export function emptyCounters(): MetricCounters {
  return { ...EMPTY_METRIC_COUNTERS };
}

export function addCounters(a: MetricCounters, b: MetricCounters): MetricCounters {
  return {
    impressions: a.impressions + b.impressions,
    linkClicks: a.linkClicks + b.linkClicks,
    spendMinor: a.spendMinor + b.spendMinor,
    funnelSessions: a.funnelSessions + b.funnelSessions,
    formStarts: a.formStarts + b.formStarts,
    formStepViews: a.formStepViews + b.formStepViews,
    formStepCompletions: a.formStepCompletions + b.formStepCompletions,
    leads: a.leads + b.leads,
    vqScheduled: a.vqScheduled + b.vqScheduled,
    vqAttended: a.vqAttended + b.vqAttended,
    qualifiedVq: a.qualifiedVq + b.qualifiedVq,
    opportunities: a.opportunities + b.opportunities,
    closedWon: a.closedWon + b.closedWon,
    revenueMinor: a.revenueMinor + b.revenueMinor,
  };
}

export function sumCounters(rows: readonly MetricCounters[]): MetricCounters {
  return rows.reduce<MetricCounters>((acc, row) => addCounters(acc, row), emptyCounters());
}

/* -------------------------------------------------------------------------- */
/* Maturity + coverage context                                                 */
/* -------------------------------------------------------------------------- */

export interface MetricContext {
  /** Maturity of the CRM cohort behind these counters. */
  crmMaturity: DataMaturity;
  /** Share of the underlying records with EXACT/HIGH_CONFIDENCE attribution. */
  attributionCoverage?: number | null;
  currency?: string;
}

export const DEFAULT_METRIC_CONTEXT: MetricContext = {
  crmMaturity: 'IMMATURE',
  attributionCoverage: null,
  currency: 'EUR',
};

/**
 * Maturity of one metric, derived from its catalogue latency.
 *
 * - `IMMEDIATE` — delivery and first-party funnel data; complete within hours.
 * - `SHORT` — depends on accepted submissions, which settle within a day, so it
 *   is at worst PARTIAL while the CRM cohort is still filling.
 * - `CRM_DELAYED` — exactly as mature as the cohort itself.
 */
export function metricMaturity(key: MetricKey, ctx: MetricContext): DataMaturity {
  const latency = METRIC_CATALOG[key].latency;
  if (latency === 'CRM_DELAYED') return ctx.crmMaturity;
  if (latency === 'SHORT') return ctx.crmMaturity === 'MATURE' ? 'MATURE' : 'PARTIAL';
  return 'MATURE';
}

/**
 * Attribution coverage only qualifies metrics that had to be attributed back to
 * the campaign — the CRM-delayed ones. Impressions, clicks and spend come
 * straight from Meta and funnel events carry a signed launch token, so quoting
 * a coverage share next to them would be noise.
 */
export function metricAttributionCoverage(key: MetricKey, ctx: MetricContext): number | null {
  return METRIC_CATALOG[key].latency === 'CRM_DELAYED' ? (ctx.attributionCoverage ?? null) : null;
}

/* -------------------------------------------------------------------------- */
/* Construction helpers                                                        */
/* -------------------------------------------------------------------------- */

function makeValue(
  key: MetricKey,
  ctx: MetricContext,
  parts: { numerator: number | null; denominator: number | null; value: number | null; currency?: string | null },
): MetricValue {
  return {
    metric: key,
    numerator: parts.numerator,
    denominator: parts.denominator,
    value: parts.value,
    currency: parts.currency ?? null,
    maturity: metricMaturity(key, ctx),
    attributionCoverage: metricAttributionCoverage(key, ctx),
  };
}

/** A plain count: the value is the numerator, there is no denominator. */
function countValue(key: MetricKey, ctx: MetricContext, count: number): MetricValue {
  return makeValue(key, ctx, { numerator: count, denominator: null, value: count });
}

/** A money total in integer minor units. */
function moneyValue(key: MetricKey, ctx: MetricContext, amountMinor: number): MetricValue {
  return makeValue(key, ctx, {
    numerator: amountMinor,
    denominator: null,
    value: amountMinor,
    currency: ctx.currency ?? 'EUR',
  });
}

/** A rate. Zero denominator → `value: null`. */
function rateValue(
  key: MetricKey,
  ctx: MetricContext,
  numerator: number,
  denominator: number,
): MetricValue {
  const r: Rate = rate(numerator, denominator);
  return makeValue(key, ctx, { numerator: r.numerator, denominator: r.denominator, value: r.value });
}

/**
 * A cost-per-unit in integer minor units. `costPer` rounds once, here, so the
 * rest of the system never carries fractional cents.
 */
function costPerValue(
  key: MetricKey,
  ctx: MetricContext,
  spendMinor: number,
  units: number,
): MetricValue {
  const currency = ctx.currency ?? 'EUR';
  const computed = costPer(spendMinor, units, currency);
  return makeValue(key, ctx, {
    numerator: spendMinor,
    denominator: units,
    value: computed.value === null ? null : computed.value.amountMinor,
    currency,
  });
}

/* -------------------------------------------------------------------------- */
/* The catalogue implementation                                                */
/* -------------------------------------------------------------------------- */

/** CPM multiplies the per-impression cost by this factor. */
const CPM_FACTOR = 1000;

/**
 * Compute a single catalogue metric.
 *
 * Every branch mirrors the `formula` string in `METRIC_CATALOG`, which is what
 * the UI renders beneath the number — the two must never drift apart.
 */
export function computeMetric(
  key: MetricKey,
  counters: MetricCounters,
  ctx: MetricContext = DEFAULT_METRIC_CONTEXT,
): MetricValue {
  switch (key) {
    case 'impressions':
      return countValue(key, ctx, counters.impressions);
    case 'link_clicks':
      return countValue(key, ctx, counters.linkClicks);
    case 'ctr':
      return rateValue(key, ctx, counters.linkClicks, counters.impressions);
    case 'cpc':
      return costPerValue(key, ctx, counters.spendMinor, counters.linkClicks);
    case 'cpm': {
      // Spend / impressions × 1000. Numerator and denominator stay the readable
      // pair "Spend / Impressionen"; the ×1000 lives in the value, as in the
      // catalogue formula.
      const currency = ctx.currency ?? 'EUR';
      return makeValue(key, ctx, {
        numerator: counters.spendMinor,
        denominator: counters.impressions,
        value:
          counters.impressions > 0
            ? Math.round((counters.spendMinor / counters.impressions) * CPM_FACTOR)
            : null,
        currency,
      });
    }
    case 'spend':
      return moneyValue(key, ctx, counters.spendMinor);
    case 'funnel_sessions':
      return countValue(key, ctx, counters.funnelSessions);
    case 'form_start_rate':
      return rateValue(key, ctx, counters.formStarts, counters.funnelSessions);
    case 'step_dropoff':
      // 1 − completed/viewed, expressed as (viewed − completed) / viewed so the
      // numerator is the number of people actually lost.
      return rateValue(
        key,
        ctx,
        Math.max(0, counters.formStepViews - counters.formStepCompletions),
        counters.formStepViews,
      );
    case 'submission_rate':
      return rateValue(key, ctx, counters.leads, counters.funnelSessions);
    case 'leads':
      return countValue(key, ctx, counters.leads);
    case 'cpl':
      return costPerValue(key, ctx, counters.spendMinor, counters.leads);
    case 'vq_scheduled':
      return countValue(key, ctx, counters.vqScheduled);
    case 'vq_scheduled_rate':
      return rateValue(key, ctx, counters.vqScheduled, counters.leads);
    case 'show_rate':
      return rateValue(key, ctx, counters.vqAttended, counters.vqScheduled);
    case 'qualified_vq':
      return countValue(key, ctx, counters.qualifiedVq);
    case 'qualified_vq_rate':
      return rateValue(key, ctx, counters.qualifiedVq, counters.vqAttended);
    case 'cost_per_qualified_vq':
      return costPerValue(key, ctx, counters.spendMinor, counters.qualifiedVq);
    case 'opportunities':
      return countValue(key, ctx, counters.opportunities);
    case 'opportunity_rate':
      return rateValue(key, ctx, counters.opportunities, counters.leads);
    case 'closed_won':
      return countValue(key, ctx, counters.closedWon);
    case 'close_rate':
      return rateValue(key, ctx, counters.closedWon, counters.opportunities);
    case 'cac':
      return costPerValue(key, ctx, counters.spendMinor, counters.closedWon);
    case 'revenue':
      return moneyValue(key, ctx, counters.revenueMinor);
    case 'roas':
      // A ratio, not money: attributed revenue per unit of spend. Both sides are
      // minor units, so the currency cancels.
      return makeValue(key, ctx, {
        numerator: counters.revenueMinor,
        denominator: counters.spendMinor,
        value: counters.spendMinor > 0 ? counters.revenueMinor / counters.spendMinor : null,
      });
  }
}

export type MetricValueMap = Record<MetricKey, MetricValue>;

/** Compute the whole catalogue in one pass. Key order follows `METRIC_KEYS`. */
export function computeAllMetrics(
  counters: MetricCounters,
  ctx: MetricContext = DEFAULT_METRIC_CONTEXT,
): MetricValueMap {
  const result = {} as MetricValueMap;
  for (const key of METRIC_KEYS) {
    result[key] = computeMetric(key, counters, ctx);
  }
  return result;
}

/** Convenience for the rules engine: the numeric value or `null`. */
export function metricNumber(values: MetricValueMap, key: MetricKey): number | null {
  return values[key].value;
}
