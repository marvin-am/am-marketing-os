import { describe, expect, it } from 'vitest';
import {
  bootstrapMeanDifference,
  bootstrapStatistic,
  compareRevenue,
  DEFAULT_REVENUE_CONFIG,
  estimateRevenue,
  medianOf,
  mulberry32,
  trimmedMeanOf,
} from './revenue';

/** Deterministic pseudo-sample generator so the fixtures stay readable. */
function sample(n: number, seedOffset: number, base: number, spread: number): number[] {
  const random = mulberry32(0xabcd + seedOffset);
  return Array.from({ length: n }, () => Math.round(base + random() * spread));
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays inside [0, 1)', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('medianOf / trimmedMeanOf', () => {
  it('computes the median for odd and even samples', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([])).toBeNull();
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    medianOf(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('trims the extremes', () => {
    const values = [0, 10, 10, 10, 10, 10, 10, 10, 10, 1000];
    expect(trimmedMeanOf(values, 0.1)).toBe(10);
    expect(trimmedMeanOf(values, 0)).toBe(108);
  });
});

describe('estimateRevenue', () => {
  it('always reports n alongside every figure', () => {
    const estimate = estimateRevenue({ key: 'variant', amountsMinor: [100_000, 200_000, 300_000] });
    expect(estimate.n).toBe(3);
    expect(estimate.totalMinor).toBe(600_000);
    expect(estimate.meanMinor).toBe(200_000);
    expect(estimate.medianMinor).toBe(200_000);
  });

  it('keeps every amount in integer minor units', () => {
    const estimate = estimateRevenue({ key: 'v', amountsMinor: [100_001, 200_002, 300_004] });
    for (const value of [estimate.meanMinor, estimate.medianMinor, estimate.trimmedMeanMinor]) {
      expect(Number.isInteger(value as number)).toBe(true);
    }
    expect(Number.isInteger(estimate.meanCi?.lowerMinor as number)).toBe(true);
  });

  it('marks a sample below the minimum observation count as insufficient', () => {
    const estimate = estimateRevenue({ key: 'v', amountsMinor: sample(12, 1, 100_000, 50_000) });
    expect(estimate.sufficient).toBe(false);
    expect(estimate.reasonsDe.join(' ')).toContain('Umsatzbeobachtungen');
  });

  it('marks a sample at the minimum as sufficient', () => {
    const estimate = estimateRevenue({ key: 'v', amountsMinor: sample(30, 2, 100_000, 50_000) });
    expect(estimate.n).toBe(30);
    expect(estimate.sufficient).toBe(true);
  });

  it('flags a tail-dominated sample and says so in German', () => {
    const estimate = estimateRevenue({
      key: 'v',
      amountsMinor: [10_000, 10_000, 10_000, 10_000, 5_000_000],
    });
    expect(estimate.heavyTail).toBe(true);
    expect(estimate.topShare.numerator).toBe(5_000_000);
    expect(estimate.reasonsDe.join(' ')).toContain('Ausreißer');
    // Median and trimmed mean expose what the mean hides.
    expect(estimate.meanMinor).toBeGreaterThan(1_000_000);
    expect(estimate.medianMinor).toBe(10_000);
  });

  it('does not flag an evenly spread sample', () => {
    const estimate = estimateRevenue({ key: 'v', amountsMinor: sample(40, 3, 100_000, 20_000) });
    expect(estimate.heavyTail).toBe(false);
  });

  it('handles an empty sample without dividing by zero', () => {
    const estimate = estimateRevenue({ key: 'v', amountsMinor: [] });
    expect(estimate.n).toBe(0);
    expect(estimate.meanMinor).toBeNull();
    expect(estimate.medianMinor).toBeNull();
    expect(estimate.meanCi).toBeNull();
    expect(estimate.topShare.value).toBeNull();
    expect(estimate.sufficient).toBe(false);
  });

  it('is deterministic — the same sample yields the same interval', () => {
    const values = sample(40, 4, 100_000, 400_000);
    expect(estimateRevenue({ key: 'v', amountsMinor: values })).toEqual(
      estimateRevenue({ key: 'v', amountsMinor: values }),
    );
  });

  it('brackets the mean with its bootstrap interval', () => {
    const values = sample(60, 5, 200_000, 100_000);
    const estimate = estimateRevenue({ key: 'v', amountsMinor: values });
    expect(estimate.meanCi).not.toBeNull();
    expect(estimate.meanCi?.lowerMinor).toBeLessThanOrEqual(estimate.meanMinor as number);
    expect(estimate.meanCi?.upperMinor).toBeGreaterThanOrEqual(estimate.meanMinor as number);
    expect(estimate.meanCi?.mass).toBe(0.9);
  });
});

describe('compareRevenue', () => {
  it('never declares a winner below the minimum observation count', () => {
    // A crushing nominal difference on far too few deals.
    const comparison = compareRevenue(
      { key: 'variant', amountsMinor: [900_000, 950_000, 1_000_000, 980_000] },
      { key: 'control', amountsMinor: [10_000, 12_000, 11_000, 9_000] },
    );
    expect(comparison.verdict).toBe('INSUFFICIENT_DATA');
    expect(comparison.reasonsDe.join(' ')).toContain('nicht belastbar');
    // The numbers are still reported — they are just not a verdict.
    expect(comparison.meanDifferenceMinor).toBeGreaterThan(0);
    expect(comparison.variant.n).toBe(4);
  });

  it('declares the variant better when the interval clears zero on enough data', () => {
    const comparison = compareRevenue(
      { key: 'variant', amountsMinor: sample(60, 10, 400_000, 60_000) },
      { key: 'control', amountsMinor: sample(60, 11, 100_000, 60_000) },
    );
    expect(comparison.verdict).toBe('VARIANT_BETTER');
    expect(comparison.differenceCi?.lowerMinor).toBeGreaterThan(0);
    expect(comparison.relativeLift).toBeGreaterThan(1);
  });

  it('declares the control better when the interval sits below zero', () => {
    const comparison = compareRevenue(
      { key: 'variant', amountsMinor: sample(60, 12, 100_000, 60_000) },
      { key: 'control', amountsMinor: sample(60, 13, 400_000, 60_000) },
    );
    expect(comparison.verdict).toBe('CONTROL_BETTER');
    expect(comparison.differenceCi?.upperMinor).toBeLessThan(0);
  });

  it('returns NO_DIFFERENCE when the interval spans zero', () => {
    const comparison = compareRevenue(
      { key: 'variant', amountsMinor: sample(60, 14, 200_000, 100_000) },
      { key: 'control', amountsMinor: sample(60, 15, 200_000, 100_000) },
    );
    expect(comparison.verdict).toBe('NO_DIFFERENCE');
    expect(comparison.differenceCi?.lowerMinor).toBeLessThanOrEqual(0);
    expect(comparison.differenceCi?.upperMinor).toBeGreaterThanOrEqual(0);
  });

  it('warns about a heavy tail even when it does declare a direction', () => {
    const variantValues = [...sample(59, 16, 50_000, 10_000), 40_000_000];
    const comparison = compareRevenue(
      { key: 'variant', amountsMinor: variantValues },
      { key: 'control', amountsMinor: sample(60, 17, 50_000, 10_000) },
    );
    expect(comparison.variant.heavyTail).toBe(true);
    expect(comparison.reasonsDe.join(' ')).toContain('Umsatz-Tail');
  });

  it('is deterministic', () => {
    const variant = { key: 'variant', amountsMinor: sample(40, 18, 200_000, 90_000) };
    const control = { key: 'control', amountsMinor: sample(40, 19, 180_000, 90_000) };
    expect(compareRevenue(variant, control)).toEqual(compareRevenue(variant, control));
  });

  it('honours a configured minimum', () => {
    const config = { ...DEFAULT_REVENUE_CONFIG, minObservations: 4 };
    const comparison = compareRevenue(
      { key: 'variant', amountsMinor: [900_000, 950_000, 1_000_000, 980_000] },
      { key: 'control', amountsMinor: [10_000, 12_000, 11_000, 9_000] },
      config,
    );
    expect(comparison.verdict).toBe('VARIANT_BETTER');
  });
});

describe('bootstrap helpers', () => {
  it('returns null below two observations', () => {
    expect(bootstrapStatistic([5], () => 5, DEFAULT_REVENUE_CONFIG)).toBeNull();
    expect(bootstrapMeanDifference([1], [1, 2], DEFAULT_REVENUE_CONFIG)).toBeNull();
  });

  it('produces the same interval on repeated calls', () => {
    const values = sample(30, 20, 100_000, 50_000);
    const first = bootstrapStatistic(
      values,
      (r) => r.reduce((s, v) => s + v, 0) / r.length,
      DEFAULT_REVENUE_CONFIG,
    );
    const second = bootstrapStatistic(
      values,
      (r) => r.reduce((s, v) => s + v, 0) / r.length,
      DEFAULT_REVENUE_CONFIG,
    );
    expect(second).toEqual(first);
  });

  it('narrows the interval as the sample grows', () => {
    const small = bootstrapStatistic(
      sample(10, 21, 100_000, 200_000),
      (r) => r.reduce((s, v) => s + v, 0) / r.length,
      DEFAULT_REVENUE_CONFIG,
    );
    const large = bootstrapStatistic(
      sample(200, 21, 100_000, 200_000),
      (r) => r.reduce((s, v) => s + v, 0) / r.length,
      DEFAULT_REVENUE_CONFIG,
    );
    const smallWidth = (small as { lowerMinor: number; upperMinor: number });
    const largeWidth = (large as { lowerMinor: number; upperMinor: number });
    expect(largeWidth.upperMinor - largeWidth.lowerMinor).toBeLessThan(
      smallWidth.upperMinor - smallWidth.lowerMinor,
    );
  });
});
