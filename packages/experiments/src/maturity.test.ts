import { describe, expect, it } from 'vitest';
import { assessMaturity, isMatureForDecision, weakestMaturity } from './maturity';

const START = '2026-03-01T00:00:00.000Z';

function at(days: number): string {
  return new Date(Date.parse(START) + days * 86_400_000).toISOString();
}

describe('assessMaturity', () => {
  it('is IMMATURE before the CRM window has elapsed', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(5),
      crmMaturityDays: 21,
      observedOutcomes: 0,
    });
    expect(result.maturity).toBe('IMMATURE');
    expect(result.matureFraction).toBeCloseTo(5 / 21, 10);
    expect(result.remainingDays).toBe(16);
    expect(result.earliestMatureAt).toBe(at(21));
  });

  it('is IMMATURE past the halfway point while no outcome has arrived', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(18),
      crmMaturityDays: 21,
      observedOutcomes: 0,
    });
    expect(result.maturity).toBe('IMMATURE');
    expect(result.reasonsDe.join(' ')).toContain('noch keine CRM-Ergebnisse');
  });

  it('is PARTIAL past the halfway point once outcomes are arriving', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(14),
      crmMaturityDays: 21,
      observedOutcomes: 3,
    });
    expect(result.maturity).toBe('PARTIAL');
    expect(result.matureFraction).toBeCloseTo(14 / 21, 10);
  });

  it('is MATURE once the window has fully elapsed', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(21),
      crmMaturityDays: 21,
      observedOutcomes: 0,
    });
    expect(result.maturity).toBe('MATURE');
    expect(result.matureFraction).toBe(1);
    expect(result.remainingDays).toBe(0);
  });

  it('treats "matured with zero outcomes" as a finding, not as missing data', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(30),
      crmMaturityDays: 21,
      observedOutcomes: 0,
    });
    expect(result.maturity).toBe('MATURE');
    expect(result.reasonsDe.join(' ')).toContain('belastbares Ergebnis');
  });

  it('lets a longer expected lag override the configured window', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(25),
      crmMaturityDays: 21,
      expectedLagDays: 40,
      observedOutcomes: 4,
    });
    expect(result.windowDays).toBe(40);
    expect(result.maturity).toBe('PARTIAL');
    expect(result.earliestMatureAt).toBe(at(40));
  });

  it('is MATURE immediately when the window is zero days', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: START,
      crmMaturityDays: 0,
      observedOutcomes: 0,
    });
    expect(result.maturity).toBe('MATURE');
    expect(result.matureFraction).toBe(1);
  });

  it('clamps a cohort dated in the future to zero age', () => {
    const result = assessMaturity({
      cohortStartedAt: at(10),
      now: START,
      crmMaturityDays: 21,
      observedOutcomes: 0,
    });
    expect(result.ageDays).toBe(0);
    expect(result.maturity).toBe('IMMATURE');
  });

  it('honours a custom partial threshold', () => {
    const result = assessMaturity({
      cohortStartedAt: START,
      now: at(5),
      crmMaturityDays: 21,
      observedOutcomes: 2,
      partialThreshold: 0.2,
    });
    expect(result.maturity).toBe('PARTIAL');
  });

  it('always produces German reasons', () => {
    for (const days of [1, 14, 30]) {
      const result = assessMaturity({
        cohortStartedAt: START,
        now: at(days),
        crmMaturityDays: 21,
        observedOutcomes: 2,
      });
      expect(result.reasonsDe.length).toBeGreaterThan(0);
      for (const reason of result.reasonsDe) expect(reason.length).toBeGreaterThan(10);
    }
  });

  it('is deterministic', () => {
    const input = { cohortStartedAt: START, now: at(9), crmMaturityDays: 21, observedOutcomes: 1 };
    expect(assessMaturity(input)).toEqual(assessMaturity(input));
  });
});

describe('isMatureForDecision', () => {
  it('accepts only MATURE — PARTIAL is explicitly not enough', () => {
    expect(isMatureForDecision('MATURE')).toBe(true);
    expect(isMatureForDecision('PARTIAL')).toBe(false);
    expect(isMatureForDecision('IMMATURE')).toBe(false);
  });
});

describe('weakestMaturity', () => {
  it('returns the least mature of a set', () => {
    expect(weakestMaturity(['MATURE', 'PARTIAL', 'MATURE'])).toBe('PARTIAL');
    expect(weakestMaturity(['MATURE', 'IMMATURE'])).toBe('IMMATURE');
    expect(weakestMaturity(['MATURE', 'MATURE'])).toBe('MATURE');
  });

  it('is IMMATURE for an empty set', () => {
    expect(weakestMaturity([])).toBe('IMMATURE');
  });
});
