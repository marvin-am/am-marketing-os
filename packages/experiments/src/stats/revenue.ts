import { rate, type Rate } from '@am/domain';

/**
 * Revenue statistics — deliberately separate from, and far more conservative
 * than, the conversion-rate machinery in `beta-binomial.ts`.
 *
 * Two properties make booked revenue a different problem:
 *
 * 1. **Heavy tail.** A handful of deals carry most of the value. The sample mean
 *    of twelve deals is dominated by whichever one happened to be large, so a
 *    normal-theory interval is meaningless and a "+180 % revenue" headline is
 *    usually one deal.
 * 2. **Long lag.** Revenue lands weeks after the click. A revenue comparison run
 *    before the cohort has matured compares a nearly complete arm against an
 *    almost empty one.
 *
 * The response here: report n on every single figure, never declare a winner
 * below `minObservations`, use a percentile bootstrap (no distributional
 * assumption) with a fixed seed, and report the median and trimmed mean beside
 * the mean so a tail-driven average is visible rather than implied.
 *
 * All amounts are integer minor units (cents), in and out.
 */

/* -------------------------------------------------------------------------- */
/* Seeded PRNG                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Used instead of `Math.random` for one reason: a recommendation has to be
 * reproducible. The same sample re-bootstrapped next week must yield the same
 * interval, or the console would appear to change its mind on unchanged data.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface RevenueConfig {
  /** No winner is ever declared on fewer observations than this, per arm. */
  minObservations: number;
  /** Bootstrap resamples. Fixed, so the interval is reproducible. */
  resamples: number;
  /** Mass of the reported percentile interval. */
  ciMass: number;
  /** PRNG seed. Fixed by default — change only to study estimator stability. */
  seed: number;
  /** Fraction trimmed from each end for the trimmed mean. */
  trimFraction: number;
  /**
   * Revenue share of the single largest observation above which the sample is
   * flagged as tail-dominated.
   */
  heavyTailTopShare: number;
}

export const DEFAULT_REVENUE_CONFIG: RevenueConfig = {
  minObservations: 30,
  resamples: 2000,
  ciMass: 0.9,
  seed: 0x5eed_1234,
  trimFraction: 0.1,
  heavyTailTopShare: 0.4,
};

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface RevenueSample {
  /** Arm key / creative key / whatever the caller is comparing. */
  key: string;
  label?: string;
  /**
   * One entry per *converted opportunity*, in minor units. Zero-revenue
   * outcomes belong in here too — dropping them silently inflates the mean.
   */
  amountsMinor: readonly number[];
  currency?: string;
}

export interface RevenueInterval {
  lowerMinor: number;
  upperMinor: number;
  mass: number;
}

export interface RevenueEstimate {
  key: string;
  label: string;
  currency: string;
  /** Number of observations. Reported on every figure, without exception. */
  n: number;
  totalMinor: number;
  meanMinor: number | null;
  medianMinor: number | null;
  trimmedMeanMinor: number | null;
  /** Bootstrap percentile interval of the mean. Null below two observations. */
  meanCi: RevenueInterval | null;
  /** Revenue share of the single largest observation. */
  topShare: Rate;
  heavyTail: boolean;
  /** True once n ≥ `minObservations`. A winner requires this on both arms. */
  sufficient: boolean;
  reasonsDe: string[];
}

export type RevenueVerdict =
  | 'INSUFFICIENT_DATA'
  | 'NO_DIFFERENCE'
  | 'VARIANT_BETTER'
  | 'CONTROL_BETTER';

export interface RevenueComparison {
  variant: RevenueEstimate;
  control: RevenueEstimate;
  /** Difference of means, variant − control, in minor units. */
  meanDifferenceMinor: number | null;
  /** Bootstrap percentile interval of that difference. */
  differenceCi: RevenueInterval | null;
  relativeLift: number | null;
  verdict: RevenueVerdict;
  reasonsDe: string[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Median of a numeric sample. Sorts a copy — the input is never mutated. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Symmetric trimmed mean — the standard blunt instrument against a heavy tail. */
export function trimmedMeanOf(values: readonly number[], trimFraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * Math.min(Math.max(trimFraction, 0), 0.49));
  const kept = sorted.slice(cut, sorted.length - cut);
  return kept.length === 0 ? mean(sorted) : mean(kept);
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = p * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sortedValues.length - 1);
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Percentile bootstrap of an arbitrary statistic over one sample.
 *
 * Deterministic given the seed: the resample indices are drawn from a seeded
 * mulberry32 stream, in a fixed order.
 */
export function bootstrapStatistic(
  values: readonly number[],
  statistic: (resample: readonly number[]) => number,
  config: Pick<RevenueConfig, 'resamples' | 'ciMass' | 'seed'>,
): RevenueInterval | null {
  if (values.length < 2) return null;

  const random = mulberry32(config.seed);
  const draws: number[] = new Array(config.resamples);
  const buffer: number[] = new Array(values.length);

  for (let r = 0; r < config.resamples; r++) {
    for (let i = 0; i < values.length; i++) {
      buffer[i] = values[Math.floor(random() * values.length) % values.length];
    }
    draws[r] = statistic(buffer);
  }

  draws.sort((a, b) => a - b);
  const tail = (1 - config.ciMass) / 2;
  return {
    lowerMinor: Math.round(percentile(draws, tail)),
    upperMinor: Math.round(percentile(draws, 1 - tail)),
    mass: config.ciMass,
  };
}

/**
 * Two-sample percentile bootstrap of the difference of means. Each arm is
 * resampled independently from its own seeded stream, so the result is
 * deterministic and the two streams cannot align by accident.
 */
export function bootstrapMeanDifference(
  variantValues: readonly number[],
  controlValues: readonly number[],
  config: Pick<RevenueConfig, 'resamples' | 'ciMass' | 'seed'>,
): RevenueInterval | null {
  if (variantValues.length < 2 || controlValues.length < 2) return null;

  const randomVariant = mulberry32(config.seed);
  const randomControl = mulberry32(config.seed ^ 0x9e3779b9);
  const draws: number[] = new Array(config.resamples);

  for (let r = 0; r < config.resamples; r++) {
    let variantSum = 0;
    for (let i = 0; i < variantValues.length; i++) {
      variantSum += variantValues[Math.floor(randomVariant() * variantValues.length) % variantValues.length];
    }
    let controlSum = 0;
    for (let i = 0; i < controlValues.length; i++) {
      controlSum += controlValues[Math.floor(randomControl() * controlValues.length) % controlValues.length];
    }
    draws[r] = variantSum / variantValues.length - controlSum / controlValues.length;
  }

  draws.sort((a, b) => a - b);
  const tail = (1 - config.ciMass) / 2;
  return {
    lowerMinor: Math.round(percentile(draws, tail)),
    upperMinor: Math.round(percentile(draws, 1 - tail)),
    mass: config.ciMass,
  };
}

/* -------------------------------------------------------------------------- */
/* Estimation                                                                  */
/* -------------------------------------------------------------------------- */

export function estimateRevenue(
  sample: RevenueSample,
  config: RevenueConfig = DEFAULT_REVENUE_CONFIG,
): RevenueEstimate {
  const values = sample.amountsMinor.map((v) => (Number.isFinite(v) ? v : 0));
  const n = values.length;
  const totalMinor = sum(values);
  const largest = n === 0 ? 0 : Math.max(...values);
  const topShare = rate(largest, totalMinor);
  const heavyTail =
    n > 0 && topShare.value !== null && topShare.value >= config.heavyTailTopShare;

  const reasonsDe: string[] = [];
  const sufficient = n >= config.minObservations;

  if (n === 0) {
    reasonsDe.push('Keine Umsatzbeobachtungen vorhanden (n = 0).');
  } else if (!sufficient) {
    reasonsDe.push(
      `Nur ${n} von mindestens ${config.minObservations} benötigten Umsatzbeobachtungen — Umsatzaussagen bleiben eine Indikation.`,
    );
  }
  if (heavyTail && topShare.value !== null) {
    reasonsDe.push(
      `Ein einzelner Abschluss trägt ${(topShare.value * 100).toFixed(0)} % des Umsatzes — der Mittelwert ist von diesem Ausreißer dominiert.`,
    );
  }

  const meanCi =
    n >= 2
      ? bootstrapStatistic(values, (resample) => mean(resample), config)
      : null;

  return {
    key: sample.key,
    label: sample.label ?? sample.key,
    currency: sample.currency ?? 'EUR',
    n,
    totalMinor,
    meanMinor: n > 0 ? Math.round(totalMinor / n) : null,
    medianMinor: n > 0 ? Math.round(medianOf(values) as number) : null,
    trimmedMeanMinor: n > 0 ? Math.round(trimmedMeanOf(values, config.trimFraction) as number) : null,
    meanCi,
    topShare,
    heavyTail,
    sufficient,
    reasonsDe,
  };
}

/**
 * Compare two revenue samples.
 *
 * A winner is declared only when **both** arms carry at least
 * `minObservations` observations *and* the bootstrap interval of the mean
 * difference excludes zero. Anything else is `INSUFFICIENT_DATA` or
 * `NO_DIFFERENCE` — never a directional claim dressed up as a result.
 */
export function compareRevenue(
  variantSample: RevenueSample,
  controlSample: RevenueSample,
  config: RevenueConfig = DEFAULT_REVENUE_CONFIG,
): RevenueComparison {
  const variant = estimateRevenue(variantSample, config);
  const control = estimateRevenue(controlSample, config);

  const reasonsDe: string[] = [];
  const meanDifferenceMinor =
    variant.meanMinor !== null && control.meanMinor !== null
      ? variant.meanMinor - control.meanMinor
      : null;

  const relativeLift =
    variant.meanMinor !== null && control.meanMinor !== null && control.meanMinor > 0
      ? (variant.meanMinor - control.meanMinor) / control.meanMinor
      : null;

  const differenceCi = bootstrapMeanDifference(
    variantSample.amountsMinor,
    controlSample.amountsMinor,
    config,
  );

  if (!variant.sufficient || !control.sufficient) {
    reasonsDe.push(
      `Umsatzvergleich nicht belastbar: Variante n = ${variant.n}, Kontrolle n = ${control.n}, erforderlich sind je ${config.minObservations}.`,
    );
    return {
      variant,
      control,
      meanDifferenceMinor,
      differenceCi,
      relativeLift,
      verdict: 'INSUFFICIENT_DATA',
      reasonsDe,
    };
  }

  if (differenceCi === null) {
    reasonsDe.push('Für ein Bootstrap-Intervall werden mindestens zwei Beobachtungen je Arm benötigt.');
    return {
      variant,
      control,
      meanDifferenceMinor,
      differenceCi,
      relativeLift,
      verdict: 'INSUFFICIENT_DATA',
      reasonsDe,
    };
  }

  if (variant.heavyTail || control.heavyTail) {
    reasonsDe.push(
      'Schwerer Umsatz-Tail: Das Ergebnis hängt an wenigen großen Abschlüssen und sollte vor einer Budgetentscheidung erneut geprüft werden.',
    );
  }

  if (differenceCi.lowerMinor > 0) {
    reasonsDe.push(
      `Das ${Math.round(differenceCi.mass * 100)} %-Bootstrap-Intervall der Mittelwertdifferenz liegt vollständig über null.`,
    );
    return {
      variant,
      control,
      meanDifferenceMinor,
      differenceCi,
      relativeLift,
      verdict: 'VARIANT_BETTER',
      reasonsDe,
    };
  }

  if (differenceCi.upperMinor < 0) {
    reasonsDe.push(
      `Das ${Math.round(differenceCi.mass * 100)} %-Bootstrap-Intervall der Mittelwertdifferenz liegt vollständig unter null.`,
    );
    return {
      variant,
      control,
      meanDifferenceMinor,
      differenceCi,
      relativeLift,
      verdict: 'CONTROL_BETTER',
      reasonsDe,
    };
  }

  reasonsDe.push(
    `Das ${Math.round(differenceCi.mass * 100)} %-Bootstrap-Intervall der Mittelwertdifferenz schließt null ein — kein belastbarer Umsatzunterschied.`,
  );
  return {
    variant,
    control,
    meanDifferenceMinor,
    differenceCi,
    relativeLift,
    verdict: 'NO_DIFFERENCE',
    reasonsDe,
  };
}
