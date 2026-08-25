import { describe, expect, it } from 'vitest';
import {
  clampRangeToHistory,
  createAnalyticsFixturePort,
  isoDateOfDay,
  dayIndexOf,
} from '@/server/analytics-fixtures';

/**
 * The fixture is a stand-in for the rollup tables, so the properties the screens
 * depend on are asserted here rather than assumed: a mature experiment, an
 * immature one, one below the volume gates, and counters that never contradict
 * themselves.
 */

const NOW = '2026-08-25T09:00:00.000Z';
const port = createAnalyticsFixturePort({ now: NOW });

function rangeEndingNow(days: number) {
  const end = dayIndexOf(NOW);
  return { from: isoDateOfDay(end - (days - 1)), to: isoDateOfDay(end) };
}

describe('analytics fixture — performance', () => {
  it('produces a full 30-day series with counters that never exceed their funnel stage', async () => {
    const overview = await port.getPerformanceOverview({ range: rangeEndingNow(30), now: NOW });

    expect(overview.series).toHaveLength(30);
    expect(overview.total.counters.spendMinor).toBeGreaterThan(0);
    expect(overview.total.counters.leads).toBeGreaterThan(0);

    const c = overview.total.counters;
    expect(c.formStarts).toBeLessThanOrEqual(c.funnelSessions);
    expect(c.leads).toBeLessThanOrEqual(c.formStarts);
    expect(c.vqAttended).toBeLessThanOrEqual(c.vqScheduled);
    expect(c.qualifiedVq).toBeLessThanOrEqual(c.vqAttended);
    expect(c.opportunities).toBeLessThanOrEqual(c.qualifiedVq);
    expect(c.closedWon).toBeLessThanOrEqual(c.opportunities);
  });

  it('reports the immature tail of the period rather than hiding it', async () => {
    const overview = await port.getPerformanceOverview({ range: rangeEndingNow(30), now: NOW });

    expect(overview.crmDelay.crmMaturityDays).toBe(21);
    expect(overview.crmDelay.notYetMature.denominator).toBe(30);
    expect(overview.crmDelay.notYetMature.numerator).toBeGreaterThan(0);
    expect(overview.crmDelay.reasonsDe.length).toBeGreaterThan(0);
    // The whole period is only as mature as its youngest cohort.
    expect(overview.total.maturity).not.toBe('MATURE');
  });

  it('is deterministic for the same instant', async () => {
    const a = await port.getPerformanceOverview({ range: rangeEndingNow(14), now: NOW });
    const b = await createAnalyticsFixturePort({ now: NOW }).getPerformanceOverview({
      range: rangeEndingNow(14),
      now: NOW,
    });
    expect(a.total.counters).toEqual(b.total.counters);
  });

  it('breaks down by all four rollup dimensions', async () => {
    const breakdowns = await port.getBreakdowns({ range: rangeEndingNow(30), now: NOW });
    expect(breakdowns.map((b) => b.dimension)).toEqual([
      'CAMPAIGN',
      'CREATIVE',
      'FUNNEL',
      'EXPERIMENT_ARM',
    ]);
    for (const breakdown of breakdowns) {
      expect(breakdown.rows.length).toBeGreaterThan(0);
      for (const row of breakdown.rows) {
        expect(row.labelDe).not.toBe(row.key);
      }
    }
  });

  it('analyses funnel steps with validation failures and reports excluded traffic', async () => {
    const dropOff = await port.getFunnelDropOff({ range: rangeEndingNow(30), now: NOW });

    expect(dropOff.analysis.steps.length).toBeGreaterThan(1);
    expect(dropOff.analysis.topValidationFailures.length).toBeGreaterThan(0);
    expect(dropOff.analysis.excludedEvents).toBeGreaterThan(0);
    expect(dropOff.windowTruncated).toBe(false);

    for (const step of dropOff.analysis.steps) {
      expect(step.completed).toBeLessThanOrEqual(step.viewed);
      expect(step.dropOffRate.denominator).toBe(step.viewed);
    }
  });

  it('states that the step analysis covers a shorter window than a long range', async () => {
    const dropOff = await port.getFunnelDropOff({ range: rangeEndingNow(180), now: NOW });
    expect(dropOff.windowTruncated).toBe(true);
    expect(dropOff.noteDe).toContain('31 Tage');
  });

  it('clamps a range to the generated history', () => {
    const clamped = clampRangeToHistory({ from: '2000-01-01', to: '2099-01-01' }, NOW);
    expect(clamped.from >= '2025-02-01').toBe(true);
    expect(clamped.to).toBe('2026-08-25');
  });
});

describe('analytics fixture — experiments', () => {
  it('offers a mature winner, an immature provisional lead and an under-powered test', async () => {
    const experiments = await port.listExperiments(NOW);
    const byId = new Map(experiments.map((entry) => [entry.experiment.id, entry]));

    const mature = byId.get('exp-formular-kurz-vs-lang');
    expect(mature?.evaluation.result.maturity).toBe('MATURE');
    expect(mature?.evaluation.result.verdict).toBe('WINNER');
    expect(mature?.winningArmLabelDe).toBeTruthy();

    const provisional = byId.get('exp-bundle-angebot-hybrid');
    expect(provisional?.evaluation.result.maturity).not.toBe('MATURE');
    expect(provisional?.evaluation.result.verdict).toBe('PROVISIONAL');
    expect(provisional?.evaluation.result.interpretationWarnings).toContain(
      'BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED',
    );

    const small = byId.get('exp-creative-exploration-kurzumfrage');
    expect(small?.evaluation.result.verdict).toBe('INSUFFICIENT_DATA');
    expect(small?.evaluation.result.winning_arm_id).toBeNull();
    expect(small?.evaluation.result.interpretationWarnings).toContain(
      'META_OPTIMISED_DELIVERY_NOT_RANDOMISED',
    );

    const gate = byId.get('exp-qualifizierungs-gate');
    expect(gate?.evaluation.result.verdict).toBe('INCONCLUSIVE');
    expect(gate?.evaluation.result.interpretationWarnings).toContain(
      'ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST',
    );
  });

  it('records which volume gate each under-powered arm missed', async () => {
    const detail = await port.getExperiment('exp-creative-exploration-kurzumfrage', NOW);
    const arms = detail?.evaluation.result.arms ?? [];
    expect(arms.some((arm) => !arm.meetsMinSessions)).toBe(true);
    expect(arms.every((arm) => !arm.meetsMinConversions)).toBe(true);
    expect(detail?.evaluation.result.reasons).toContain('MIN_RUNTIME_NOT_REACHED');
  });

  it('carries per-arm observations and metric envelopes on the detail', async () => {
    const detail = await port.getExperiment('exp-formular-kurz-vs-lang', NOW);
    expect(detail).not.toBeNull();
    expect(detail?.observations).toHaveLength(2);
    for (const arm of detail?.arms ?? []) {
      const snapshot = detail?.armMetrics[arm.id];
      expect(snapshot?.metrics.submission_rate.denominator).toBeGreaterThan(0);
      expect(snapshot?.attributionCoverage).not.toBeNull();
    }
  });

  it('returns null for an unknown experiment', async () => {
    expect(await port.getExperiment('exp-does-not-exist', NOW)).toBeNull();
  });
});

describe('analytics fixture — learnings', () => {
  it('derives every confidence label rather than asserting one', async () => {
    const cards = await port.listLearningCards();
    expect(cards.length).toBeGreaterThanOrEqual(6);

    const labels = new Set(cards.map((card) => card.confidence));
    expect(labels.has('FACT')).toBe(true);
    expect(labels.has('INDICATION')).toBe(true);
    expect(labels.has('HYPOTHESIS')).toBe(true);

    for (const card of cards) {
      if (card.dataMaturity === 'IMMATURE') expect(card.confidence).toBe('HYPOTHESIS');
    }
  });
});
