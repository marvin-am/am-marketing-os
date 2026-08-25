import { beforeAll, describe, expect, it } from 'vitest';
import { METRIC_CATALOG, type IsoTimestamp, type MetricKey } from '@am/domain';
import { ROLLUP_DIMENSIONS, sumCounters, type MetricCounters } from '@am/experiments';
import type { AnalyticsPort, DateRange } from '../src/server/analytics-port';

/**
 * The `AnalyticsPort` contract, as a suite.
 *
 * Every claim here is one the three analytics screens render as a fact, and none
 * of them is about a particular store. Running the identical suite against the
 * fixture and against Postgres is what makes "the fixture is the demo-mode
 * implementation of the same port" a checked statement rather than an intention:
 * a live implementation that summed rates, double-counted a creative row into
 * the total, or rendered a zero denominator as 0 % would pass its own tests and
 * fail this one.
 *
 * A uuid that is syntactically valid but absent, so the "unknown experiment"
 * case exercises a miss rather than a malformed-input error.
 */
const ABSENT_EXPERIMENT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const MS_PER_DAY = 86_400_000;

function daysBetween(range: DateRange): number {
  return Math.round((Date.parse(range.to) - Date.parse(range.from)) / MS_PER_DAY) + 1;
}

export interface AnalyticsContractSubject {
  port: AnalyticsPort;
  range: DateRange;
  now: IsoTimestamp;
}

export function describeAnalyticsPortContract(
  name: string,
  load: () => Promise<AnalyticsContractSubject>,
): void {
  describe(`AnalyticsPort contract — ${name}`, () => {
    let subject: AnalyticsContractSubject;

    beforeAll(async () => {
      subject = await load();
    });

    it('returns one series point per UTC day of the range, in order', async () => {
      const { port, range, now } = subject;
      const overview = await port.getPerformanceOverview({ range, campaignId: null, now });

      expect(overview.range).toEqual(range);
      expect(overview.series).toHaveLength(daysBetween(range));
      expect(overview.series[0].date).toBe(range.from);
      expect(overview.series.at(-1)?.date).toBe(range.to);

      const dates = overview.series.map((point) => point.date);
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBe(dates.length);
    });

    it('totals the counters the series carries, and never sums a rate', async () => {
      const { port, range, now } = subject;
      const overview = await port.getPerformanceOverview({ range, campaignId: null, now });

      const summed: MetricCounters = sumCounters(overview.series.map((point) => point.counters));
      expect(overview.total.counters).toEqual(summed);

      // A rate is recomputed from the summed counters, so CTR over the period is
      // clicks/impressions of the period — not the mean of the daily CTRs.
      const ctr = overview.total.metrics.ctr;
      expect(ctr.numerator).toBe(summed.linkClicks);
      expect(ctr.denominator).toBe(summed.impressions);
    });

    it('renders a zero denominator as unknown, never as zero', async () => {
      const { port, range, now } = subject;
      const overview = await port.getPerformanceOverview({ range, campaignId: null, now });

      for (const point of [overview.total, ...overview.series]) {
        for (const key of Object.keys(point.metrics) as MetricKey[]) {
          const value = point.metrics[key];
          expect(value.metric).toBe(key);
          expect(['IMMATURE', 'PARTIAL', 'MATURE']).toContain(value.maturity);
          if (value.denominator === 0) {
            expect(value.value).toBeNull();
          }
        }
      }
    });

    it('quotes attribution coverage only beside the metrics that were attributed', async () => {
      const { port, range, now } = subject;
      const overview = await port.getPerformanceOverview({ range, campaignId: null, now });
      const snapshot = overview.total;

      if (snapshot.attributionCoverage !== null) {
        expect(snapshot.attributionCoverage).toBeGreaterThanOrEqual(0);
        expect(snapshot.attributionCoverage).toBeLessThanOrEqual(1);
      }
      expect(snapshot.attributedRecords).toBeGreaterThanOrEqual(0);

      for (const key of Object.keys(snapshot.metrics) as MetricKey[]) {
        const expected =
          METRIC_CATALOG[key].latency === 'CRM_DELAYED' ? snapshot.attributionCoverage : null;
        expect(snapshot.metrics[key].attributionCoverage).toBe(expected);
      }
    });

    it('accounts for every day of the range in the CRM delay statement', async () => {
      const { port, range, now } = subject;
      const overview = await port.getPerformanceOverview({ range, campaignId: null, now });
      const days = daysBetween(range);
      const delay = overview.crmDelay;

      expect(delay.matureDays + delay.partialDays + delay.immatureDays).toBe(days);
      expect(delay.notYetMature.denominator).toBe(days);
      expect(delay.notYetMature.numerator).toBe(delay.partialDays + delay.immatureDays);
      expect(delay.crmMaturityDays).toBeGreaterThan(0);
      if (delay.maturityCutoff !== null) {
        expect(delay.maturityCutoff >= range.from).toBe(true);
        expect(delay.maturityCutoff <= range.to).toBe(true);
      }
    });

    it('returns all four breakdowns, sorted by spend, without double counting', async () => {
      const { port, range, now } = subject;
      const [overview, breakdowns] = await Promise.all([
        port.getPerformanceOverview({ range, campaignId: null, now }),
        port.getBreakdowns({ range, campaignId: null, now }),
      ]);

      expect(breakdowns.map((breakdown) => breakdown.dimension)).toEqual([...ROLLUP_DIMENSIONS]);

      for (const breakdown of breakdowns) {
        for (const row of breakdown.rows) {
          expect(row.dimension).toBe(breakdown.dimension);
          expect(row.key).not.toBe('');
          expect(row.labelDe).not.toBe('');
        }
        const spends = breakdown.rows.map((row) => row.counters.spendMinor);
        expect([...spends].sort((a, b) => b - a)).toEqual(spends);
      }

      // The campaign breakdown partitions the same rows the total is built from,
      // so the two must agree exactly. A creative-level row folded into the total
      // as well would show up here as a mismatch.
      const campaigns = breakdowns.find((breakdown) => breakdown.dimension === 'CAMPAIGN');
      const campaignSpend = (campaigns?.rows ?? []).reduce(
        (total, row) => total + row.counters.spendMinor,
        0,
      );
      expect(campaignSpend).toBe(overview.total.counters.spendMinor);
    });

    it('states the window the step analysis actually covered', async () => {
      const { port, range, now } = subject;
      const dropOff = await port.getFunnelDropOff({
        range,
        campaignId: null,
        funnelVersionId: null,
        now,
      });

      expect(dropOff.window.to).toBe(range.to);
      expect(dropOff.window.from >= range.from).toBe(true);
      expect(dropOff.windowTruncated).toBe(dropOff.window.from > range.from);
      expect(dropOff.noteDe === null).toBe(!dropOff.windowTruncated);

      for (const step of dropOff.analysis.steps) {
        expect(step.completed).toBeLessThanOrEqual(step.viewed);
        expect(step.completionRate.denominator).toBe(step.viewed);
        if (step.viewed === 0) expect(step.completionRate.value).toBeNull();
      }
    });

    it('lists campaigns with a delivery span, newest last day first', async () => {
      const campaigns = await subject.port.listCampaigns();
      const lastDays = campaigns.map((campaign) => campaign.lastDay);
      expect([...lastDays].sort().reverse()).toEqual(lastDays);
      expect(new Set(campaigns.map((campaign) => campaign.id)).size).toBe(campaigns.length);
      for (const campaign of campaigns) {
        expect(campaign.firstDay <= campaign.lastDay).toBe(true);
        expect(campaign.labelDe).not.toBe('');
      }
    });

    it('never names a winner the verdict does not support', async () => {
      const summaries = await subject.port.listExperiments(subject.now);

      for (const summary of summaries) {
        expect(summary.observations).toHaveLength(summary.arms.length);
        const result = summary.evaluation.result;
        if (result.verdict !== 'WINNER' && result.verdict !== 'PROVISIONAL') {
          expect(result.winning_arm_id).toBeNull();
          expect(summary.winningArmLabelDe).toBeNull();
        }
        if (summary.winningArmLabelDe !== null) {
          expect(summary.arms.map((arm) => arm.label)).toContain(summary.winningArmLabelDe);
        }
      }
    });

    it('returns null for an experiment that does not exist', async () => {
      await expect(
        subject.port.getExperiment(ABSENT_EXPERIMENT_ID, subject.now),
      ).resolves.toBeNull();
    });

    it('carries a metric snapshot for every arm of an experiment it returns', async () => {
      const summaries = await subject.port.listExperiments(subject.now);
      const first = summaries[0];
      if (!first) return;

      const detail = await subject.port.getExperiment(first.experiment.id, subject.now);
      expect(detail).not.toBeNull();
      for (const arm of detail!.arms) {
        expect(detail!.armMetrics[arm.id]).toBeDefined();
        expect(detail!.armMetrics[arm.id].metrics.spend.currency).not.toBe('');
      }
    });

    it('orders learning cards newest period first and never asserts a confidence', async () => {
      const cards = await subject.port.listLearningCards();
      const ends = cards.map((card) => card.periodEnd ?? '');
      expect([...ends].sort().reverse()).toEqual(ends);
      for (const card of cards) {
        expect(['FACT', 'INDICATION', 'HYPOTHESIS']).toContain(card.confidence);
        if (card.confidence === 'FACT') {
          expect(card.dataMaturity).toBe('MATURE');
        }
      }
    });
  });
}
