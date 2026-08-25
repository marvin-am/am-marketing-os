import { describe, expect, it } from 'vitest';
import { rate } from '@am/domain';
import {
  formatCoverage,
  formatCurrencyMinor,
  formatDate,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRate,
  formatRateBasis,
  formatRatio,
  formatRelative,
} from './format';

/** German formatting uses a comma decimal separator and a dot for thousands. */
const nbsp = /[\s\u00A0\u202F\u2009]/gu;
const normalize = (value: string) => value.replace(nbsp, ' ');

describe('numbers', () => {
  it('formats with German separators', () => {
    expect(formatNumber(1234567)).toBe('1.234.567');
    expect(formatNumber(3.456, 2)).toBe('3,46');
  });

  it('renders a dash rather than a number for missing data', () => {
    expect(formatNumber(null)).toBe('–');
    expect(formatNumber(Number.NaN)).toBe('–');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('–');
  });
});

describe('currency', () => {
  it('converts minor units to euros', () => {
    expect(normalize(formatCurrencyMinor(123456))).toBe('1.234,56 €');
  });

  it('honours a non-euro currency', () => {
    expect(normalize(formatCurrencyMinor(5000, 'USD'))).toContain('50,00');
  });

  it('dashes on missing money', () => {
    expect(formatCurrencyMinor(null)).toBe('–');
    expect(formatMoney(null)).toBe('–');
    expect(normalize(formatMoney({ amountMinor: 999, currency: 'EUR' }))).toBe('9,99 €');
  });
});

describe('rates', () => {
  it('renders a percentage with its basis', () => {
    const r = rate(12, 340);
    expect(normalize(formatRate(r))).toBe('3,5 %');
    expect(formatRateBasis(r)).toBe('12 / 340');
  });

  it('never renders a zero denominator as 0 %', () => {
    const empty = rate(0, 0);
    expect(formatRate(empty)).toBe('–');
    expect(formatPercent(null)).toBe('–');
  });

  it('still shows the basis for an unmeasurable rate', () => {
    expect(formatRateBasis(rate(0, 0))).toBe('0 / 0');
  });

  it('formats a ratio with a multiplication sign', () => {
    expect(normalize(formatRatio(4.237))).toBe('4,24×');
    expect(formatRatio(null)).toBe('–');
  });
});

describe('dates', () => {
  it('formats German dates', () => {
    expect(formatDate('2026-03-09T10:00:00.000Z')).toBe('09.03.2026');
  });

  it('dashes on missing or invalid input', () => {
    expect(formatDate(null)).toBe('–');
    expect(formatDate('not-a-date')).toBe('–');
    expect(formatDate(undefined)).toBe('–');
  });

  it('formats relative times in German', () => {
    const now = Date.parse('2026-03-09T12:00:00.000Z');
    expect(formatRelative('2026-03-09T10:00:00.000Z', now)).toMatch(/Stunde/);
    // `numeric: 'auto'` prefers the idiomatic word over "vor 2 Tagen".
    expect(formatRelative('2026-03-07T12:00:00.000Z', now)).toBe('vorgestern');
    expect(formatRelative('2026-02-01T12:00:00.000Z', now)).toMatch(/Monat/);
    expect(formatRelative('2026-03-09T11:59:50.000Z', now)).toBe('gerade eben');
  });

  it('pluralises durations correctly', () => {
    expect(formatDuration(1)).toBe('1 Tag');
    expect(formatDuration(14)).toBe('14 Tage');
    expect(formatDuration(0.4)).toBe('weniger als 1 Tag');
    expect(formatDuration(null)).toBe('–');
  });
});

describe('attribution coverage', () => {
  it('states coverage as a share', () => {
    expect(formatCoverage(0.82)).toBe('82 % exakt zugeordnet');
  });

  it('distinguishes no data from zero coverage', () => {
    expect(formatCoverage(null)).toBe('keine Daten');
    expect(formatCoverage(0)).toBe('0 % exakt zugeordnet');
  });
});
