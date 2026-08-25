import { METRIC_KEYS, type MetricKey } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  addCounters,
  computeAllMetrics,
  computeMetric,
  emptyCounters,
  metricAttributionCoverage,
  metricMaturity,
  metricNumber,
  sumCounters,
  type MetricContext,
  type MetricCounters,
} from './compute';

const CTX: MetricContext = { crmMaturity: 'MATURE', attributionCoverage: 0.9, currency: 'EUR' };

/** A full, internally consistent counter set for a healthy campaign. */
const COUNTERS: MetricCounters = {
  impressions: 50_000,
  linkClicks: 1_000,
  spendMinor: 120_000, // 1 200,00 €
  funnelSessions: 800,
  formStarts: 400,
  formStepViews: 1_600,
  formStepCompletions: 1_200,
  leads: 120,
  vqScheduled: 60,
  vqAttended: 45,
  qualifiedVq: 30,
  opportunities: 20,
  closedWon: 5,
  revenueMinor: 900_000, // 9 000,00 €
};

describe('computeMetric — formulas', () => {
  it('computes CTR as link clicks over impressions', () => {
    expect(computeMetric('ctr', COUNTERS, CTX)).toMatchObject({
      metric: 'ctr',
      numerator: 1_000,
      denominator: 50_000,
      value: 0.02,
    });
  });

  it('computes CPC as spend over link clicks, in integer minor units', () => {
    const cpc = computeMetric('cpc', COUNTERS, CTX);
    expect(cpc.numerator).toBe(120_000);
    expect(cpc.denominator).toBe(1_000);
    expect(cpc.value).toBe(120);
    expect(Number.isInteger(cpc.value as number)).toBe(true);
    expect(cpc.currency).toBe('EUR');
  });

  it('computes CPM as spend over impressions × 1000', () => {
    const cpm = computeMetric('cpm', COUNTERS, CTX);
    expect(cpm.numerator).toBe(120_000);
    expect(cpm.denominator).toBe(50_000);
    expect(cpm.value).toBe(2_400);
    expect(Number.isInteger(cpm.value as number)).toBe(true);
  });

  it('reports funnel sessions as a plain count with no denominator', () => {
    expect(computeMetric('funnel_sessions', COUNTERS, CTX)).toMatchObject({
      numerator: 800,
      denominator: null,
      value: 800,
    });
  });

  it('computes the form start rate over funnel sessions', () => {
    expect(computeMetric('form_start_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 400,
      denominator: 800,
      value: 0.5,
    });
  });

  it('computes the step drop-off as lost over viewed', () => {
    expect(computeMetric('step_dropoff', COUNTERS, CTX)).toMatchObject({
      numerator: 400,
      denominator: 1_600,
      value: 0.25,
    });
  });

  it('computes the submission rate as leads over funnel sessions', () => {
    expect(computeMetric('submission_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 120,
      denominator: 800,
      value: 0.15,
    });
  });

  it('computes CPL as spend over leads', () => {
    expect(computeMetric('cpl', COUNTERS, CTX)).toMatchObject({
      numerator: 120_000,
      denominator: 120,
      value: 1_000,
      currency: 'EUR',
    });
  });

  it('computes the VQ scheduling rate over leads', () => {
    expect(computeMetric('vq_scheduled_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 60,
      denominator: 120,
      value: 0.5,
    });
  });

  it('computes the show rate as attended over scheduled', () => {
    expect(computeMetric('show_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 45,
      denominator: 60,
      value: 0.75,
    });
  });

  it('computes the qualification rate as qualified over attended', () => {
    expect(computeMetric('qualified_vq_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 30,
      denominator: 45,
    });
    expect(computeMetric('qualified_vq_rate', COUNTERS, CTX).value).toBeCloseTo(30 / 45, 12);
  });

  it('computes the cost per qualified VQ', () => {
    expect(computeMetric('cost_per_qualified_vq', COUNTERS, CTX)).toMatchObject({
      numerator: 120_000,
      denominator: 30,
      value: 4_000,
    });
  });

  it('computes the opportunity rate over leads', () => {
    expect(computeMetric('opportunity_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 20,
      denominator: 120,
    });
  });

  it('computes the close rate as closed won over opportunities', () => {
    expect(computeMetric('close_rate', COUNTERS, CTX)).toMatchObject({
      numerator: 5,
      denominator: 20,
      value: 0.25,
    });
  });

  it('computes CAC as spend over closed won', () => {
    expect(computeMetric('cac', COUNTERS, CTX)).toMatchObject({
      numerator: 120_000,
      denominator: 5,
      value: 24_000,
    });
  });

  it('reports revenue as money in minor units', () => {
    expect(computeMetric('revenue', COUNTERS, CTX)).toMatchObject({
      numerator: 900_000,
      denominator: null,
      value: 900_000,
      currency: 'EUR',
    });
  });

  it('computes ROAS as revenue over spend, with no currency', () => {
    expect(computeMetric('roas', COUNTERS, CTX)).toMatchObject({
      numerator: 900_000,
      denominator: 120_000,
      value: 7.5,
      currency: null,
    });
  });

  it('rounds money to whole minor units exactly once', () => {
    const counters = { ...emptyCounters(), spendMinor: 1_000, leads: 3 };
    // 1000 / 3 = 333.33… → 333 cents, never 333.3333.
    expect(computeMetric('cpl', counters, CTX).value).toBe(333);
  });
});

describe('computeMetric — zero denominators', () => {
  it('yields value null, never 0, for every derived metric', () => {
    const zero = emptyCounters();
    const derived: MetricKey[] = [
      'ctr',
      'cpc',
      'cpm',
      'form_start_rate',
      'step_dropoff',
      'submission_rate',
      'cpl',
      'vq_scheduled_rate',
      'show_rate',
      'qualified_vq_rate',
      'cost_per_qualified_vq',
      'opportunity_rate',
      'close_rate',
      'cac',
      'roas',
    ];
    for (const key of derived) {
      const value = computeMetric(key, zero, CTX);
      expect(value.value, `${key} must be null on a zero denominator`).toBeNull();
      expect(value.denominator).toBe(0);
    }
  });

  it('still reports counts as 0 rather than null', () => {
    const zero = emptyCounters();
    for (const key of ['impressions', 'link_clicks', 'leads', 'funnel_sessions', 'closed_won'] as MetricKey[]) {
      expect(computeMetric(key, zero, CTX).value).toBe(0);
    }
  });

  it('distinguishes "no leads yet" from "zero conversion rate"', () => {
    const noSessions = { ...emptyCounters(), leads: 0, funnelSessions: 0 };
    const noLeads = { ...emptyCounters(), leads: 0, funnelSessions: 500 };
    expect(computeMetric('submission_rate', noSessions, CTX).value).toBeNull();
    expect(computeMetric('submission_rate', noLeads, CTX).value).toBe(0);
  });
});

describe('computeAllMetrics', () => {
  it('covers every key in the catalogue', () => {
    const all = computeAllMetrics(COUNTERS, CTX);
    expect(Object.keys(all).sort()).toEqual([...METRIC_KEYS].sort());
    for (const key of METRIC_KEYS) expect(all[key].metric).toBe(key);
  });

  it('never returns a bare number — numerator and denominator are always carried', () => {
    const all = computeAllMetrics(COUNTERS, CTX);
    for (const key of METRIC_KEYS) {
      expect(all[key]).toHaveProperty('numerator');
      expect(all[key]).toHaveProperty('denominator');
      expect(all[key]).toHaveProperty('value');
      expect(all[key]).toHaveProperty('maturity');
    }
  });

  it('exposes the raw value through metricNumber', () => {
    expect(metricNumber(computeAllMetrics(COUNTERS, CTX), 'ctr')).toBe(0.02);
  });

  it('is deterministic', () => {
    expect(computeAllMetrics(COUNTERS, CTX)).toEqual(computeAllMetrics(COUNTERS, CTX));
  });
});

describe('maturity and attribution propagation', () => {
  it('marks immediate metrics MATURE regardless of the CRM cohort', () => {
    const ctx: MetricContext = { crmMaturity: 'IMMATURE' };
    expect(metricMaturity('ctr', ctx)).toBe('MATURE');
    expect(metricMaturity('impressions', ctx)).toBe('MATURE');
    expect(metricMaturity('submission_rate', ctx)).toBe('MATURE');
  });

  it('caps short-latency metrics at PARTIAL while the cohort is filling', () => {
    expect(metricMaturity('cpl', { crmMaturity: 'IMMATURE' })).toBe('PARTIAL');
    expect(metricMaturity('cpl', { crmMaturity: 'PARTIAL' })).toBe('PARTIAL');
    expect(metricMaturity('cpl', { crmMaturity: 'MATURE' })).toBe('MATURE');
  });

  it('gives CRM-delayed metrics exactly the cohort maturity', () => {
    for (const maturity of ['IMMATURE', 'PARTIAL', 'MATURE'] as const) {
      expect(metricMaturity('cost_per_qualified_vq', { crmMaturity: maturity })).toBe(maturity);
      expect(metricMaturity('roas', { crmMaturity: maturity })).toBe(maturity);
    }
  });

  it('quotes attribution coverage only on attributed CRM metrics', () => {
    const ctx: MetricContext = { crmMaturity: 'MATURE', attributionCoverage: 0.62 };
    expect(metricAttributionCoverage('roas', ctx)).toBe(0.62);
    expect(metricAttributionCoverage('closed_won', ctx)).toBe(0.62);
    expect(metricAttributionCoverage('ctr', ctx)).toBeNull();
    expect(metricAttributionCoverage('impressions', ctx)).toBeNull();
  });
});

describe('counter arithmetic', () => {
  it('adds counters element-wise', () => {
    const sum = addCounters(COUNTERS, COUNTERS);
    expect(sum.impressions).toBe(100_000);
    expect(sum.revenueMinor).toBe(1_800_000);
  });

  it('sums a list starting from zero', () => {
    expect(sumCounters([])).toEqual(emptyCounters());
    expect(sumCounters([COUNTERS, COUNTERS, COUNTERS]).leads).toBe(360);
  });

  it('recomputes rates from summed counters rather than averaging them', () => {
    const busy: MetricCounters = { ...emptyCounters(), leads: 100, funnelSessions: 1_000 };
    const quiet: MetricCounters = { ...emptyCounters(), leads: 1, funnelSessions: 2 };
    const combined = computeMetric('submission_rate', sumCounters([busy, quiet]), CTX);
    // 101 / 1002, not the average of 10 % and 50 %.
    expect(combined.value).toBeCloseTo(101 / 1002, 12);
  });

  it('leaves the frozen empty counters untouched', () => {
    const fresh = emptyCounters();
    fresh.leads = 99;
    expect(emptyCounters().leads).toBe(0);
  });
});
