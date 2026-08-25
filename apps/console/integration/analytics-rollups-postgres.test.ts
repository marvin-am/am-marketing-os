import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveAnalyticsPort } from '../src/server/analytics-live';
import { createAnalyticsFixturePort } from '../src/server/analytics-fixtures';
import type { AnalyticsPort, DateRange } from '../src/server/analytics-port';
import { HAS_DATABASE, announceSkip } from '../../../supabase/tests/harness';
import {
  UNSEEDED_WORKSPACE_ID,
  setupConsoleDatabase,
  type ConsoleHarness,
} from './console-pg-harness';
import { describeAnalyticsPortContract } from './analytics-port-contract';

/**
 * The live `AnalyticsPort` against a real Postgres.
 *
 * The claim under test is the one the Performance screen makes on every render:
 * the number on the tile is the number the rollup table holds. Every assertion
 * therefore compares the port's output against a SQL aggregate issued on the same
 * database rather than against a constant written into the test — a constant
 * would only pin today's arithmetic, not the reading.
 *
 * The rollup rows are written by the test because `supabase/seed/seed.sql`
 * contains none: `performance_rollups` is filled by the daily job, and a seed
 * that pre-baked it would make the dashboards look populated on a database where
 * the job had never run.
 *
 * Skips cleanly without `DATABASE_URL` (AGENTS.md). Everything happens in the
 * harness's own scratch database, which is dropped afterwards.
 */

const NOW = '2026-08-25T09:00:00.000Z';
const RANGE: DateRange = { from: '2026-08-15', to: '2026-08-24' };

/** Five delivery days, then five quiet ones — so an empty day is exercised too. */
const DELIVERY_DAYS = ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'];

if (!HAS_DATABASE) announceSkip('apps/console/integration/analytics-rollups-postgres.test.ts');

describe.skipIf(!HAS_DATABASE)('live AnalyticsPort over performance_rollups', () => {
  let console_: ConsoleHarness;
  let port: AnalyticsPort;
  let campaignId: string;
  let creativeVersionId: string;

  beforeAll(async () => {
    console_ = await setupConsoleDatabase('analytics_rollups', { applySeed: true });

    const campaign = await console_.sql.query<{ id: string }>(
      `select id from public.campaigns order by created_at limit 1`,
    );
    campaignId = campaign.rows[0].id;

    const creative = await console_.sql.query<{ id: string }>(
      `select id from public.creative_versions where campaign_id = $1 order by version limit 1`,
      [campaignId],
    );
    creativeVersionId = creative.rows[0].id;

    const workspace = await console_.sql.query<{ id: string }>(
      `select workspace_id as id from public.campaigns where id = $1`,
      [campaignId],
    );

    for (const [index, day] of DELIVERY_DAYS.entries()) {
      // Campaign grain: what the total and the series are built from.
      await console_.sql.query(
        `insert into public.performance_rollups
           (workspace_id, day, campaign_id, impressions, link_clicks, spend_minor,
            funnel_sessions, form_views, form_starts, step_completions, leads,
            vq_scheduled, vq_attended, qualified_vq, opportunities, closed_won,
            revenue_minor, attribution_coverage, data_maturity)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          workspace.rows[0].id,
          day,
          campaignId,
          10_000 + index * 1_000,
          400 + index * 20,
          120_00 + index * 10_00,
          300 + index * 10,
          260 + index * 10,
          180 + index * 8,
          150 + index * 6,
          // The last delivery day has no lead at all, so a cost per lead with a
          // zero denominator has to be rendered as unknown somewhere.
          index === DELIVERY_DAYS.length - 1 ? 0 : 8 + index,
          index === DELIVERY_DAYS.length - 1 ? 0 : 5 + index,
          index === DELIVERY_DAYS.length - 1 ? 0 : 4 + index,
          index === DELIVERY_DAYS.length - 1 ? 0 : 2 + index,
          index === DELIVERY_DAYS.length - 1 ? 0 : 1,
          index === 0 ? 1 : 0,
          index === 0 ? 950_000 : 0,
          index === DELIVERY_DAYS.length - 1 ? null : 0.8,
          index < 2 ? 'MATURE' : 'PARTIAL',
        ],
      );

      // Creative grain for the same day. It must never reach the total.
      await console_.sql.query(
        `insert into public.performance_rollups
           (workspace_id, day, campaign_id, creative_version_id, impressions, link_clicks,
            spend_minor, leads, data_maturity)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'PARTIAL')`,
        [
          workspace.rows[0].id,
          day,
          campaignId,
          creativeVersionId,
          5_000 + index * 500,
          200 + index * 10,
          60_00 + index * 5_00,
          index === DELIVERY_DAYS.length - 1 ? 0 : 4 + index,
        ],
      );
    }

    // The fallback id deliberately is not the seeded workspace: the port has to
    // find the workspace by slug, or every number below would be zero.
    port = createLiveAnalyticsPort({
      db: console_.db,
      workspaceId: UNSEEDED_WORKSPACE_ID,
      now: NOW,
    });
  });

  afterAll(async () => {
    await console_?.teardown();
  });

  it('totals exactly what the campaign-grain rows hold', async () => {
    const overview = await port.getPerformanceOverview({
      range: RANGE,
      campaignId: null,
      now: NOW,
    });

    const expected = await console_.sql.query<{
      spend: number;
      leads: number;
      impressions: number;
      clicks: number;
      revenue: number;
    }>(
      `select coalesce(sum(spend_minor), 0)::bigint as spend,
              coalesce(sum(leads), 0)::bigint as leads,
              coalesce(sum(impressions), 0)::bigint as impressions,
              coalesce(sum(link_clicks), 0)::bigint as clicks,
              coalesce(sum(revenue_minor), 0)::bigint as revenue
         from public.performance_rollups
        where day between $1 and $2
          and campaign_id is not null
          and creative_version_id is null
          and funnel_version_id is null
          and experiment_arm_id is null`,
      [RANGE.from, RANGE.to],
    );

    const row = expected.rows[0];
    expect(overview.total.counters.spendMinor).toBe(Number(row.spend));
    expect(overview.total.counters.leads).toBe(Number(row.leads));
    expect(overview.total.counters.impressions).toBe(Number(row.impressions));
    expect(overview.total.counters.linkClicks).toBe(Number(row.clicks));
    expect(overview.total.counters.revenueMinor).toBe(Number(row.revenue));

    // And the creative rows for the same days are genuinely in the table, so the
    // agreement above is a filter working rather than an absence of rows.
    const creativeSpend = await console_.sql.query<{ spend: number }>(
      `select coalesce(sum(spend_minor), 0)::bigint as spend
         from public.performance_rollups where creative_version_id is not null`,
    );
    expect(Number(creativeSpend.rows[0].spend)).toBeGreaterThan(0);
  });

  it('derives the cost per lead from the summed counters, not from the daily ones', async () => {
    const overview = await port.getPerformanceOverview({
      range: RANGE,
      campaignId: null,
      now: NOW,
    });

    const expected = await console_.sql.query<{ cpl: string }>(
      `select round(sum(spend_minor)::numeric / nullif(sum(leads), 0))::text as cpl
         from public.performance_rollups
        where day between $1 and $2
          and campaign_id is not null and creative_version_id is null`,
      [RANGE.from, RANGE.to],
    );

    expect(overview.total.metrics.cpl.value).toBe(Number(expected.rows[0].cpl));
    expect(overview.total.metrics.cpl.numerator).toBe(overview.total.counters.spendMinor);
    expect(overview.total.metrics.cpl.denominator).toBe(overview.total.counters.leads);
  });

  it('leaves a day without leads without a cost per lead', async () => {
    const overview = await port.getPerformanceOverview({
      range: RANGE,
      campaignId: null,
      now: NOW,
    });

    const leadless = overview.series.find((point) => point.date === DELIVERY_DAYS.at(-1));
    expect(leadless?.counters.spendMinor).toBeGreaterThan(0);
    expect(leadless?.counters.leads).toBe(0);
    expect(leadless?.metrics.cpl.value).toBeNull();

    // A day with no rollup row at all is still a point, and it is empty rather
    // than missing — the chart must show a gap, not a shorter axis.
    const quiet = overview.series.find((point) => point.date === '2026-08-24');
    expect(quiet).toBeDefined();
    expect(quiet?.counters.spendMinor).toBe(0);
    expect(quiet?.metrics.cpl.value).toBeNull();
  });

  it('breaks the same rows down by creative without touching the campaign total', async () => {
    const [overview, breakdowns] = await Promise.all([
      port.getPerformanceOverview({ range: RANGE, campaignId: null, now: NOW }),
      port.getBreakdowns({ range: RANGE, campaignId: null, now: NOW }),
    ]);

    const creative = breakdowns.find((breakdown) => breakdown.dimension === 'CREATIVE');
    const row = creative?.rows.find((candidate) => candidate.key === creativeVersionId);
    expect(row).toBeDefined();

    const expected = await console_.sql.query<{ spend: number }>(
      `select coalesce(sum(spend_minor), 0)::bigint as spend
         from public.performance_rollups
        where creative_version_id = $1 and day between $2 and $3`,
      [creativeVersionId, RANGE.from, RANGE.to],
    );
    expect(row!.counters.spendMinor).toBe(Number(expected.rows[0].spend));
    expect(row!.counters.spendMinor).not.toBe(overview.total.counters.spendMinor);

    const campaign = breakdowns.find((breakdown) => breakdown.dimension === 'CAMPAIGN');
    expect(campaign?.rows).toHaveLength(1);
    expect(campaign?.rows[0].key).toBe(campaignId);
    expect(campaign?.rows[0].counters.spendMinor).toBe(overview.total.counters.spendMinor);
  });

  it('reports the delivery span the table actually holds', async () => {
    const campaigns = await port.listCampaigns();
    const mine = campaigns.find((candidate) => candidate.id === campaignId);
    expect(mine).toBeDefined();

    const span = await console_.sql.query<{ first: string; last: string }>(
      `select min(day)::text as first, max(day)::text as last
         from public.performance_rollups where campaign_id = $1`,
      [campaignId],
    );
    expect(mine!.firstDay).toBe(span.rows[0].first);
    expect(mine!.lastDay).toBe(span.rows[0].last);

    const name = await console_.sql.query<{ name: string }>(
      `select name from public.campaigns where id = $1`,
      [campaignId],
    );
    expect(mine!.labelDe).toBe(name.rows[0].name);
  });

  it('never upgrades a row the rollup job stamped as immature', async () => {
    // A cohort from June is long past the 21-day window, so age alone would call
    // it MATURE. The stored verdict is the weaker one and has to win.
    const old = '2026-06-01';
    const workspace = await console_.sql.query<{ id: string }>(
      `select workspace_id as id from public.campaigns where id = $1`,
      [campaignId],
    );
    await console_.sql.query(
      `insert into public.performance_rollups
         (workspace_id, day, campaign_id, spend_minor, leads, qualified_vq,
          revenue_minor, attribution_coverage, data_maturity)
       values ($1, $2, $3, 50000, 10, 4, 250000, 0.9, 'IMMATURE')`,
      [workspace.rows[0].id, old, campaignId],
    );

    const query = { range: { from: old, to: old }, campaignId: null, now: NOW };
    const stamped = await port.getPerformanceOverview(query);
    expect(stamped.total.maturityAssessment.maturity).toBe('MATURE');
    expect(stamped.total.maturity).toBe('IMMATURE');
    expect(stamped.total.metrics.roas.maturity).toBe('IMMATURE');

    await console_.sql.query(
      `update public.performance_rollups set data_maturity = 'MATURE' where day = $1`,
      [old],
    );
    const released = await port.getPerformanceOverview(query);
    expect(released.total.maturity).toBe('MATURE');

    await console_.sql.query(`delete from public.performance_rollups where day = $1`, [old]);
  });

  it('returns the experiments and learning cards the database holds', async () => {
    const [experiments, cards] = await Promise.all([
      port.listExperiments(NOW),
      port.listLearningCards(),
    ]);

    const stored = await console_.sql.query<{ id: string; name: string }>(
      `select id, name from public.experiments`,
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(new Set(experiments.map((entry) => entry.experiment.id))).toEqual(
      new Set(stored.rows.map((row) => row.id)),
    );

    const armCounts = await console_.sql.query<{ experiment_id: string; total: number }>(
      `select experiment_id, count(*)::int as total from public.experiment_arms group by 1`,
    );
    const byExperiment = new Map(armCounts.rows.map((row) => [row.experiment_id, row.total]));
    for (const summary of experiments) {
      expect(summary.arms).toHaveLength(byExperiment.get(summary.experiment.id) ?? 0);
    }

    const storedCards = await console_.sql.query<{ id: string; title_de: string }>(
      `select id, title_de from public.learning_cards where superseded_by is null`,
    );
    expect(storedCards.rows.length).toBeGreaterThan(0);
    expect(new Set(cards.map((card) => card.id))).toEqual(
      new Set(storedCards.rows.map((row) => row.id)),
    );
    expect(cards[0].titleDe).toBe(
      storedCards.rows.find((row) => row.id === cards[0].id)?.title_de,
    );
  });

  it('says nothing about excluded traffic, because the table records none', async () => {
    const overview = await port.getPerformanceOverview({
      range: RANGE,
      campaignId: null,
      now: NOW,
    });
    /* The rollup job counts what it dropped and does not persist it, so the
       live read has no tally. `null` says that; zero would say nothing was
       excluded, which is a claim about the traffic rather than about the
       table. Pinned so that a future implementation inventing a number — in
       either direction — fails here. */
    expect(overview.exclusions).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The shared contract, against both implementations                           */
/* -------------------------------------------------------------------------- */

describeAnalyticsPortContract('fixture', async () => ({
  port: createAnalyticsFixturePort({ now: NOW }),
  range: RANGE,
  now: NOW,
}));

if (HAS_DATABASE) {
  let contract: ConsoleHarness | null = null;
  afterAll(async () => {
    await contract?.teardown();
  });

  describeAnalyticsPortContract('postgres', async () => {
    contract = await setupConsoleDatabase('analytics_contract', { applySeed: true });

    const campaign = await contract.sql.query<{ id: string; workspace_id: string }>(
      `select id, workspace_id from public.campaigns order by created_at limit 1`,
    );
    const arm = await contract.sql.query<{ id: string; experiment_id: string }>(
      `select id, experiment_id from public.experiment_arms order by sort_order limit 1`,
    );
    const funnel = await contract.sql.query<{ id: string }>(
      `select id from public.funnel_versions order by version limit 1`,
    );

    // One row per grain so the contract's "the campaign breakdown equals the
    // total" assertion is exercised against a table that also holds finer rows.
    for (const [index, day] of DELIVERY_DAYS.entries()) {
      await contract.sql.query(
        `insert into public.performance_rollups
           (workspace_id, day, campaign_id, impressions, link_clicks, spend_minor,
            funnel_sessions, form_views, form_starts, step_completions, leads,
            vq_scheduled, vq_attended, qualified_vq, opportunities, closed_won,
            revenue_minor, attribution_coverage, data_maturity)
         values ($1, $2, $3, 9000, 350, 90000, 250, 210, 150, 120, 7, 4, 3, 2, 1, $4, $5, 0.75, 'PARTIAL')`,
        [campaign.rows[0].workspace_id, day, campaign.rows[0].id, index === 0 ? 1 : 0, index === 0 ? 400_000 : 0],
      );
      await contract.sql.query(
        `insert into public.performance_rollups
           (workspace_id, day, campaign_id, funnel_version_id, spend_minor, leads, data_maturity)
         values ($1, $2, $3, $4, 30000, 3, 'PARTIAL')`,
        [campaign.rows[0].workspace_id, day, campaign.rows[0].id, funnel.rows[0].id],
      );
      await contract.sql.query(
        `insert into public.performance_rollups
           (workspace_id, day, campaign_id, experiment_id, experiment_arm_id,
            spend_minor, leads, data_maturity)
         values ($1, $2, $3, $4, $5, 20000, 2, 'PARTIAL')`,
        [
          campaign.rows[0].workspace_id,
          day,
          campaign.rows[0].id,
          arm.rows[0].experiment_id,
          arm.rows[0].id,
        ],
      );
    }

    return {
      port: createLiveAnalyticsPort({
        db: contract.db,
        workspaceId: UNSEEDED_WORKSPACE_ID,
        now: NOW,
      }),
      range: RANGE,
      now: NOW,
    };
  });
}
