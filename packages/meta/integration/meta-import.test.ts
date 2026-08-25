/**
 * Contract tests for the historical import, against the fixture provider.
 * No network, no database — the sink is the in-memory reference implementation
 * whose `Map` semantics mirror `ON CONFLICT (provider, external_id) DO UPDATE`.
 */
import { describe, expect, it } from 'vitest';
import { type DomainError, SAFE_DEFAULT_FLAGS } from '@am/domain';
import {
  FIXTURE_ANCHOR,
  FIXTURE_CAMPAIGN_COUNT,
  FixtureMetaProvider,
  assertNoDuplicateInserts,
  createInMemoryImportSink,
  entityKey,
  insightsKey,
  runHistoricalImport,
} from '../src/index';

const NOW = FIXTURE_ANCHOR;
const WINDOW = { since: '2024-06-30', until: '2026-06-30' };

function fixture(options: Record<string, unknown> = {}) {
  return new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS, pageSize: 25, ...options });
}

/* -------------------------------------------------------------------------- */

describe('importing the same data twice yields zero duplicates', () => {
  it('inserts on the first run and only updates on the second', async () => {
    const sink = createInMemoryImportSink();

    const first = await runHistoricalImport(fixture(), sink, { months: 24, now: NOW });
    const sizesAfterFirst = {
      campaigns: sink.campaigns.size,
      adSets: sink.adSets.size,
      ads: sink.ads.size,
      creatives: sink.creatives.size,
      insights: sink.insights.size,
    };

    expect(first.totals.inserted).toBe(
      sizesAfterFirst.campaigns +
        sizesAfterFirst.adSets +
        sizesAfterFirst.ads +
        sizesAfterFirst.creatives +
        sizesAfterFirst.insights,
    );
    expect(first.totals.updated).toBe(0);

    // A completely fresh provider instance — same deterministic dataset.
    const second = await runHistoricalImport(fixture(), sink, { months: 24, now: NOW });

    expect(second.totals.inserted).toBe(0);
    expect(second.totals.updated).toBe(first.totals.inserted);
    expect(() => assertNoDuplicateInserts(second)).not.toThrow();

    expect({
      campaigns: sink.campaigns.size,
      adSets: sink.adSets.size,
      ads: sink.ads.size,
      creatives: sink.creatives.size,
      insights: sink.insights.size,
    }).toEqual(sizesAfterFirst);
  });

  it('keys every mirrored row on (provider, external_id)', async () => {
    const sink = createInMemoryImportSink();
    await runHistoricalImport(fixture(), sink, { months: 24, now: NOW });

    for (const [key, campaign] of sink.campaigns) {
      expect(key).toBe(entityKey(campaign.externalId));
    }
    for (const [key, row] of sink.insights) {
      expect(key).toBe(insightsKey(row));
    }
    expect(sink.campaigns.size).toBe(FIXTURE_CAMPAIGN_COUNT);
  });

  it('stores raw payloads separately from the mapped records', async () => {
    const sink = createInMemoryImportSink();
    const summary = await runHistoricalImport(fixture(), sink, { months: 24, now: NOW });

    expect(sink.rawPayloads.length).toBe(summary.totals.rawPayloads);
    expect(sink.rawPayloads.length).toBe(summary.totals.itemsSeen);
    const kinds = new Set(sink.rawPayloads.map((raw) => raw.kind));
    expect(kinds).toEqual(new Set(['CAMPAIGN', 'ADSET', 'AD', 'AD_CREATIVE', 'INSIGHTS_DAILY']));
  });
});

/* -------------------------------------------------------------------------- */

describe('insights pagination assembles the full range', () => {
  it('walks every cursor and reaches the same rows as one large page', async () => {
    const paged = fixture({ pageSize: 25 });
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = await paged.fetchInsightsDaily({
        level: 'ad',
        since: WINDOW.since,
        until: WINDOW.until,
        cursor,
      });
      pages++;
      collected.push(...page.items.map(insightsKey));
      cursor = page.nextCursor;
    } while (cursor !== null);

    const single = await fixture({ pageSize: 100_000 }).fetchInsightsDaily({
      level: 'ad',
      since: WINDOW.since,
      until: WINDOW.until,
      limit: 100_000,
    });

    expect(pages).toBeGreaterThan(1);
    expect(collected).toHaveLength(single.items.length);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toEqual(single.items.map(insightsKey));
  });

  it('covers the whole requested window and only the requested window', async () => {
    const page = await fixture({ pageSize: 100_000 }).fetchInsightsDaily({
      level: 'ad',
      since: WINDOW.since,
      until: WINDOW.until,
      limit: 100_000,
    });

    const dates = page.items.map((row) => row.date).sort();
    expect(dates[0] >= WINDOW.since).toBe(true);
    expect(dates[dates.length - 1] <= WINDOW.until).toBe(true);
    // Eighteen months of history means the first day is well before the window end.
    expect(dates[0] < '2025-06-01').toBe(true);

    const narrow = await fixture({ pageSize: 100_000 }).fetchInsightsDaily({
      level: 'ad',
      since: '2026-06-01',
      until: '2026-06-10',
      limit: 100_000,
    });
    expect(narrow.items.every((row) => row.date >= '2026-06-01' && row.date <= '2026-06-10')).toBe(
      true,
    );
    expect(narrow.items.length).toBeLessThan(page.items.length);
  });

  it('aggregates correctly when a higher level is requested', async () => {
    const provider = fixture({ pageSize: 100_000 });
    const ads = await provider.fetchInsightsDaily({
      level: 'ad',
      since: '2026-06-01',
      until: '2026-06-10',
      limit: 100_000,
    });
    const campaigns = await provider.fetchInsightsDaily({
      level: 'campaign',
      since: '2026-06-01',
      until: '2026-06-10',
      limit: 100_000,
    });

    const adSpend = ads.items.reduce((sum, row) => sum + row.spend.amountMinor, 0);
    const campaignSpend = campaigns.items.reduce((sum, row) => sum + row.spend.amountMinor, 0);

    expect(campaignSpend).toBe(adSpend);
    expect(campaigns.items.length).toBeLessThan(ads.items.length);
    expect(campaigns.items.every((row) => row.level === 'campaign')).toBe(true);
    // Rates keep their numerator and denominator after aggregation.
    for (const row of campaigns.items) {
      expect(row.ctr.numerator).toBe(row.clicks);
      expect(row.ctr.denominator).toBe(row.impressions);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('resumability', () => {
  it('continues from the stored watermark after a truncated run', async () => {
    const sink = createInMemoryImportSink();

    const partial = await runHistoricalImport(fixture({ pageSize: 2 }), sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
      maxPagesPerScope: 1,
    });

    expect(partial.scopes[0].truncated).toBe(true);
    expect(sink.campaigns.size).toBe(2);
    const watermark = sink.watermarks.get('CAMPAIGNS');
    expect(watermark?.cursor).toBe('2');
    expect(watermark?.completedAt).toBeNull();

    const resumed = await runHistoricalImport(fixture({ pageSize: 2 }), sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
    });

    expect(sink.campaigns.size).toBe(FIXTURE_CAMPAIGN_COUNT);
    expect(resumed.totals.inserted).toBe(4);
    expect(sink.watermarks.get('CAMPAIGNS')?.completedAt).not.toBeNull();
  });

  it('starts from the top when resume is disabled, still without duplicates', async () => {
    const sink = createInMemoryImportSink();
    await runHistoricalImport(fixture({ pageSize: 2 }), sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
      maxPagesPerScope: 1,
    });

    const restarted = await runHistoricalImport(fixture({ pageSize: 2 }), sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
      resume: false,
    });

    expect(restarted.totals.updated).toBe(2);
    expect(restarted.totals.inserted).toBe(4);
    expect(sink.campaigns.size).toBe(FIXTURE_CAMPAIGN_COUNT);
  });
});

/* -------------------------------------------------------------------------- */

describe('failure injection', () => {
  it('surfaces a rate limit as PROVIDER_RATE_LIMITED', async () => {
    const provider = fixture({ simulateRateLimit: true });
    let thrown: unknown;
    try {
      await runHistoricalImport(provider, createInMemoryImportSink(), { months: 24, now: NOW });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(error.retryable).toBe(true);
    expect(error.messageDe).toContain('Anfragelimit');
  });

  it('maps a permission error onto a clear German message', async () => {
    const provider = fixture({ simulatePermissionError: true });
    let thrown: unknown;
    try {
      await runHistoricalImport(provider, createInMemoryImportSink(), { months: 24, now: NOW });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.retryable).toBe(false);
    expect(error.messageDe).toBe(
      'Meta hat den Zugriff verweigert: Dem verbundenen Konto fehlen die erforderlichen Berechtigungen für dieses Werbekonto.',
    );
  });

  it('recovers once a transient failure clears', async () => {
    const provider = fixture({ simulateTransientFailure: 2 });
    const sink = createInMemoryImportSink();

    await expect(
      runHistoricalImport(provider, sink, { months: 24, now: NOW, scopes: ['CAMPAIGNS'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    provider.clearSimulatedFailures();
    const summary = await runHistoricalImport(provider, sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
    });
    expect(summary.totals.inserted).toBe(FIXTURE_CAMPAIGN_COUNT);
  });
});
