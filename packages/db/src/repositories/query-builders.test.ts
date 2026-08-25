import { describe, expect, it } from 'vitest';
import type { DbClient } from '../client';
import { groupBy, indexBy, normalizePage, toPage, uniqueIds } from './base';
import { SupabaseCampaignRepository } from './campaigns';
import { SupabaseSubmissionRepository, foldFunnelCounts } from './submissions';
import { SupabaseOutboxRepository } from './outbox';
import { SupabaseRollupRepository, isRollupEligible } from './rollups';
import { SupabaseJobsRepository } from './jobs';
import { resolveClaimDestinations } from '../outbox';
import { SupabaseMetaRepository, foldSpendTotals } from './meta';
import { SupabaseExperimentRepository, isCrmMature } from './experiments';
import { SupabaseAuditRepository } from './audit';
import { SupabaseFunnelRepository } from './funnels';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type MetaInsightsDailyRow } from '../types';

interface RecordedCall {
  method: string;
  args: unknown[];
}

const CHAIN_METHODS = [
  'select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'is', 'ilike', 'like',
  'overlaps', 'contains', 'not', 'order', 'range', 'limit', 'insert', 'update', 'upsert', 'delete',
] as const;

/**
 * A recording stand-in for the PostgREST builder.
 *
 * The repositories are thin translators from domain intent to a query; the thing
 * worth testing is that the translation is right — the right table, the right
 * filters, the right ordering, the right range.
 */
function fakeClient(response: { data?: unknown; error?: unknown; count?: number | null } = {}) {
  const calls: RecordedCall[] = [];
  const settled = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const builder: Record<string, unknown> = {
    then: (resolve: (value: typeof settled) => unknown) => Promise.resolve(settled).then(resolve),
    single: () => {
      calls.push({ method: 'single', args: [] });
      return Promise.resolve(settled);
    },
    maybeSingle: () => {
      calls.push({ method: 'maybeSingle', args: [] });
      return Promise.resolve(settled);
    },
  };

  for (const method of CHAIN_METHODS) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }

  const client = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ method: 'rpc', args: [fn, args] });
      return Promise.resolve(settled);
    },
  };

  const find = (method: string) => calls.filter((call) => call.method === method);
  const filters = () =>
    Object.fromEntries(find('eq').map((call) => [String(call.args[0]), call.args[1]])) as Record<string, unknown>;

  return { client: client as unknown as DbClient, calls, find, filters };
}

describe('pagination helpers', () => {
  it('applies the default limit and clamps to the maximum', () => {
    expect(normalizePage(undefined)).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(normalizePage({ limit: 5_000 })).toEqual({ limit: MAX_PAGE_LIMIT, offset: 0 });
    expect(normalizePage({ limit: 0, offset: -10 })).toEqual({ limit: 1, offset: 0 });
  });

  it('derives hasMore from the total when the count is known', () => {
    expect(toPage([1, 2, 3], 10, 3, 0).hasMore).toBe(true);
    expect(toPage([1, 2, 3], 3, 3, 0).hasMore).toBe(false);
    // Without a count, a full page is assumed to have more behind it.
    expect(toPage([1, 2, 3], null, 3, 0).hasMore).toBe(true);
    expect(toPage([1, 2], null, 3, 0).hasMore).toBe(false);
  });

  it('groups and indexes without an N+1', () => {
    const rows = [
      { id: 'a', parent: 'p1' },
      { id: 'b', parent: 'p1' },
      { id: 'c', parent: 'p2' },
      { id: 'd', parent: null },
    ];
    const grouped = groupBy(rows, (row) => row.parent);
    expect(grouped.get('p1')).toHaveLength(2);
    expect(grouped.get('p2')).toHaveLength(1);
    expect(grouped.has('null')).toBe(false);

    // indexBy keeps the first occurrence, which is why callers order first.
    expect(indexBy(rows, (row) => row.parent).get('p1')?.id).toBe('a');
  });

  it('uniqueIds drops empties and duplicates before an .in() filter', () => {
    expect(uniqueIds(['a', 'a', '', null, undefined, 'b'])).toEqual(['a', 'b']);
    expect(uniqueIds([])).toEqual([]);
  });
});

describe('campaign query builder', () => {
  it('filters by workspace, excludes archived by default and paginates', async () => {
    const { client, calls, filters, find } = fakeClient({ data: [], count: 0 });
    await new SupabaseCampaignRepository(client).list({ workspaceId: 'ws-1', limit: 10, offset: 20 });

    expect(calls[0]).toEqual({ method: 'from', args: ['campaigns'] });
    expect(filters()).toEqual({ workspace_id: 'ws-1' });
    expect(find('neq')[0].args).toEqual(['state', 'ARCHIVED']);
    expect(find('range')[0].args).toEqual([20, 29]);
    expect(find('order')[0].args).toEqual(['updated_at', { ascending: false }]);
  });

  it('honours an explicit state filter instead of the archived exclusion', async () => {
    const { client, find } = fakeClient({ data: [], count: 0 });
    await new SupabaseCampaignRepository(client).list({ workspaceId: 'ws-1', states: ['LIVE', 'PAUSED'] });

    expect(find('in')[0].args).toEqual(['state', ['LIVE', 'PAUSED']]);
    expect(find('neq')).toHaveLength(0);
  });

  it('turns a search term into a case-insensitive name match', async () => {
    const { client, find } = fakeClient({ data: [], count: 0 });
    await new SupabaseCampaignRepository(client).list({ workspaceId: 'ws-1', search: 'Handwerk' });
    expect(find('ilike')[0].args).toEqual(['name', '%Handwerk%']);
  });

  it('sorts ascending by the requested column', async () => {
    const { client, find } = fakeClient({ data: [], count: 0 });
    await new SupabaseCampaignRepository(client).list({ workspaceId: 'ws-1', orderBy: 'name', direction: 'asc' });
    expect(find('order')[0].args).toEqual(['name', { ascending: true }]);
  });

  it('loads versions for many campaigns in one query', async () => {
    const { client, find, calls } = fakeClient({ data: [] });
    await new SupabaseCampaignRepository(client).loadVersionsForCampaigns(['c1', 'c2', 'c1']);
    expect(calls.filter((call) => call.method === 'from')).toHaveLength(1);
    expect(find('in')[0].args).toEqual(['campaign_id', ['c1', 'c2']]);
  });

  it('short-circuits a batched loader with no ids', async () => {
    const { client, calls } = fakeClient({ data: [] });
    const result = await new SupabaseCampaignRepository(client).loadVersionsForCampaigns([]);
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('only publishes a DRAFT version, so a published one cannot be re-published', async () => {
    const { client, find } = fakeClient({ data: { id: 'v1', campaign_id: 'c1' } });
    await new SupabaseCampaignRepository(client).publishVersion('v1', 'user-1');
    const eqArgs = find('eq').map((call) => call.args);
    expect(eqArgs).toContainEqual(['id', 'v1']);
    expect(eqArgs).toContainEqual(['state', 'DRAFT']);
  });

  it('rejects an approval without a content hash before touching the database', async () => {
    const { client, calls } = fakeClient({ data: null });
    await expect(
      new SupabaseCampaignRepository(client).decideApproval('a1', { state: 'APPROVED', actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });
});

describe('submission query builder', () => {
  it('defaults to production traffic only', async () => {
    const { client, filters } = fakeClient({ data: [], count: 0 });
    await new SupabaseSubmissionRepository(client).listSubmissions({ workspaceId: 'ws-1' });
    expect(filters().traffic_kind).toBe('PRODUCTION');
  });

  it('can include preview and test traffic explicitly', async () => {
    const { client, filters } = fakeClient({ data: [], count: 0 });
    await new SupabaseSubmissionRepository(client).listSubmissions({ workspaceId: 'ws-1', productionOnly: false });
    expect(filters().traffic_kind).toBeUndefined();
  });

  it('applies a time range on the submission time, not the sync time', async () => {
    const { client, find } = fakeClient({ data: [], count: 0 });
    await new SupabaseSubmissionRepository(client).listSubmissions({
      workspaceId: 'ws-1',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(find('gte')[0].args).toEqual(['submitted_at', '2026-01-01T00:00:00.000Z']);
    expect(find('lte')[0].args).toEqual(['submitted_at', '2026-02-01T00:00:00.000Z']);
  });

  it('submits a lead through the transactional RPC', async () => {
    const { client, find } = fakeClient({ data: { submission_id: 's1', created: true } });
    await new SupabaseSubmissionRepository(client).submitLead({
      submission_attempt_id: 'attempt-1',
      published_funnel_id: 'pf-1',
    });
    expect(find('rpc')[0].args[0]).toBe('submit_lead_transactional');
  });

  it('never lets an update rewrite the acquisition binding', async () => {
    const { client, find } = fakeClient({ data: { id: 'o1' } });
    await new SupabaseSubmissionRepository(client).updateOpportunity('o1', {
      stage: 'closedwon',
      acquisition_submission_id: 'hacked',
      acquisition_snapshot_id: 'hacked',
    });
    const patch = find('update')[0].args[0] as Record<string, unknown>;
    expect(patch).toEqual({ stage: 'closedwon' });
  });
});

describe('funnel counts fold', () => {
  it('counts every stage and carries the denominators', () => {
    const counts = foldFunnelCounts(
      [
        { id: 's1', state: 'ACCEPTED' },
        { id: 's2', state: 'HUBSPOT_SYNCED' },
        { id: 's3', state: 'REJECTED_SPAM' },
      ],
      [
        { id: 'l1', submission_id: 's1', vq_status: 'PASSED' },
        { id: 'l2', submission_id: 's2', vq_status: 'NO_SHOW' },
      ],
      [
        { id: 'o1', lead_id: 'l1', amount_minor: 4_500_00, closed_won_at: '2026-05-01T00:00:00.000Z', closed_lost_at: null },
        { id: 'o2', lead_id: 'l1', amount_minor: 2_000_00, closed_won_at: null, closed_lost_at: '2026-05-02T00:00:00.000Z' },
      ],
      [
        { submission_id: 's1', confidence: 'EXACT' },
        { submission_id: 's2', confidence: 'LOW_CONFIDENCE' },
      ],
    );

    expect(counts.submissions).toBe(3);
    expect(counts.leads).toBe(2); // the spam rejection is not a lead
    expect(counts.vq_scheduled).toBe(2);
    expect(counts.vq_attended).toBe(1);
    expect(counts.vq_no_show).toBe(1);
    expect(counts.qualified_vq).toBe(1);
    expect(counts.opportunities).toBe(2);
    expect(counts.closed_won).toBe(1);
    expect(counts.closed_lost).toBe(1);
    expect(counts.revenue_minor).toBe(4_500_00);
    expect(counts.trustworthy_attributions).toBe(1);
  });
});

describe('outbox query builder', () => {
  it('claims through the SKIP LOCKED RPC rather than a plain select', async () => {
    const { client, find } = fakeClient({ data: [] });
    await new SupabaseOutboxRepository(client).claim({ destination: 'HUBSPOT', limit: 5, worker: 'w1' });
    expect(find('rpc')[0].args).toEqual([
      'claim_outbox_events',
      { p_destinations: ['HUBSPOT'], p_limit: 5, p_worker: 'w1' },
    ]);
  });

  it('drains every destination in one claim when none is named', async () => {
    const { client, find } = fakeClient({ data: [] });
    await new SupabaseOutboxRepository(client).claim({ worker: 'pump' });
    expect(find('rpc')[0].args[1]).toMatchObject({ p_destinations: null, p_worker: 'pump' });
  });

  it('merges and de-duplicates the two destination spellings', () => {
    expect(resolveClaimDestinations({ destinations: ['HUBSPOT', 'META_CAPI'], destination: 'HUBSPOT' })).toEqual([
      'HUBSPOT',
      'META_CAPI',
    ]);
    expect(resolveClaimDestinations({})).toBeNull();
  });

  it('looks a row up by the full dedup key', async () => {
    const { client, filters } = fakeClient({ data: null });
    await new SupabaseOutboxRepository(client).getByDedupKey('META_CAPI', 'DS-1', 'capi:1');
    expect(filters()).toEqual({ destination: 'META_CAPI', dataset_id: 'DS-1', event_id: 'capi:1' });
  });

  it('looks a row up without a dataset id, newest first', async () => {
    const { client, filters, find } = fakeClient({ data: [] });
    await new SupabaseOutboxRepository(client).getByEventId('HUBSPOT', 'lead:abc');
    expect(filters()).toEqual({ destination: 'HUBSPOT', event_id: 'lead:abc' });
    expect(find('order')[0].args).toEqual(['created_at', { ascending: false }]);
    expect(find('limit')[0].args).toEqual([1]);
  });
});

describe('rollup query builder', () => {
  it('upserts on the generated dimension key so a recompute overwrites', async () => {
    const { client, find } = fakeClient({ data: [{ id: 'r1' }] });
    const written = await new SupabaseRollupRepository(client).upsertDaily([
      { workspace_id: 'ws-1', day: '2026-08-01', campaign_id: 'c1' },
    ]);
    expect(written).toBe(1);
    expect(find('upsert')[0].args[1]).toEqual({ onConflict: 'workspace_id,day,dimension_key' });
    expect((find('upsert')[0].args[0] as { computed_at?: string }[])[0].computed_at).toBeTypeOf('string');
  });

  it('refuses a row that claims to include non-production traffic', async () => {
    const { client, calls } = fakeClient({ data: [] });
    await expect(
      new SupabaseRollupRepository(client).upsertDaily([
        { workspace_id: 'ws-1', day: '2026-08-01', traffic_scope: 'PREVIEW' } as never,
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('narrows to one dimension and its ids', async () => {
    const { client, find } = fakeClient({ data: [] });
    await new SupabaseRollupRepository(client).query({
      workspaceId: 'ws-1',
      since: '2026-08-01',
      until: '2026-08-31',
      dimension: 'creative_version',
      ids: ['cv1', 'cv1', 'cv2'],
    });
    expect(find('in')[0].args).toEqual(['creative_version_id', ['cv1', 'cv2']]);
    expect(find('gte')[0].args).toEqual(['day', '2026-08-01']);
  });

  it('falls back to "dimension present" when no ids are given', async () => {
    const { client, find } = fakeClient({ data: [] });
    await new SupabaseRollupRepository(client).query({ workspaceId: 'ws-1', dimension: 'experiment_arm' });
    expect(find('not')[0].args).toEqual(['experiment_arm_id', 'is', null]);
  });

  it('asks the database which days are stale', async () => {
    const { client, find } = fakeClient({ data: ['2026-08-01', '2026-08-03'] });
    const days = await new SupabaseRollupRepository(client).daysNeedingRecompute('ws-1', '2026-08-01', '2026-08-31');
    expect(find('rpc')[0].args).toEqual([
      'rollup_days_needing_recompute',
      { p_workspace_id: 'ws-1', p_since: '2026-08-01', p_until: '2026-08-31' },
    ]);
    expect(days).toEqual(['2026-08-01', '2026-08-03']);
  });

  it('only PRODUCTION traffic is rollup-eligible', () => {
    expect(isRollupEligible('PRODUCTION')).toBe(true);
    for (const kind of ['PREVIEW', 'INTERNAL', 'BOT', 'TEST'] as const) {
      expect(isRollupEligible(kind)).toBe(false);
    }
  });
});

describe('job locks', () => {
  it('acquires through the atomic RPC', async () => {
    const { client, find } = fakeClient({ data: true });
    expect(await new SupabaseJobsRepository(client).tryAcquireJobLock('outbox', 'w1', 90)).toBe(true);
    expect(find('rpc')[0].args).toEqual([
      'try_acquire_job_lock',
      { p_key: 'outbox', p_holder: 'w1', p_ttl_seconds: 90 },
    ]);
  });

  it('treats anything but an explicit true as "not acquired"', async () => {
    const { client } = fakeClient({ data: null });
    expect(await new SupabaseJobsRepository(client).tryAcquireJobLock('outbox', 'w1')).toBe(false);
  });

  it('releases by key and holder, so it cannot steal another holder’s lock', async () => {
    const { client, find } = fakeClient({ data: false });
    await new SupabaseJobsRepository(client).releaseJobLock('outbox', 'w2');
    expect(find('rpc')[0].args).toEqual(['release_job_lock', { p_key: 'outbox', p_holder: 'w2' }]);
  });
});

describe('CRM maturity', () => {
  const thresholds = { crmMaturityDays: 21 };

  it('is false until the configured window has elapsed', () => {
    expect(isCrmMature({ concluded_at: '2026-08-10T00:00:00.000Z', thresholds }, '2026-08-25T00:00:00.000Z')).toBe(false);
    expect(isCrmMature({ concluded_at: '2026-08-01T00:00:00.000Z', thresholds }, '2026-08-25T00:00:00.000Z')).toBe(true);
  });

  it('uses the thresholds the experiment actually ran with, not today’s default', () => {
    expect(isCrmMature({ concluded_at: '2026-08-20T00:00:00.000Z', thresholds: { crmMaturityDays: 1 } }, '2026-08-25T00:00:00.000Z')).toBe(true);
  });

  it('falls back to the domain default when the stored thresholds are unusable', () => {
    expect(isCrmMature({ concluded_at: '2026-08-24T00:00:00.000Z', thresholds: {} }, '2026-08-25T00:00:00.000Z')).toBe(false);
    expect(isCrmMature({ concluded_at: '2026-01-01T00:00:00.000Z', thresholds: {} }, '2026-08-25T00:00:00.000Z')).toBe(true);
  });

  it('is never mature without a conclusion date', () => {
    expect(isCrmMature({ concluded_at: null, thresholds }, '2026-08-25T00:00:00.000Z')).toBe(false);
  });
});

describe('meta query builder', () => {
  it('upserts external objects on (provider, external_id)', async () => {
    const { client, find } = fakeClient({ data: [{ id: 'm1' }] });
    await new SupabaseMetaRepository(client).upsertCampaigns([
      { workspace_id: 'ws-1', meta_account_id: 'acct', external_id: '123', name: 'X' },
    ]);
    expect(find('upsert')[0].args[1]).toEqual({ onConflict: 'provider,external_id' });
  });

  it('skips the round trip for an empty batch', async () => {
    const { client, calls } = fakeClient({ data: [] });
    expect(await new SupabaseMetaRepository(client).upsertCampaigns([])).toEqual([]);
    expect(await new SupabaseMetaRepository(client).upsertInsightsDaily([])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('narrows insights by level and date range', async () => {
    const { client, filters, find } = fakeClient({ data: [] });
    await new SupabaseMetaRepository(client).listInsights({
      workspaceId: 'ws-1',
      level: 'AD',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(filters()).toEqual({ workspace_id: 'ws-1', level: 'AD' });
    expect(find('gte')[0].args).toEqual(['date_start', '2026-01-01']);
    expect(find('lte')[0].args).toEqual(['date_start', '2026-01-31']);
  });

  it('sums spend in integer minor units and counts distinct days', () => {
    const rows = [
      { spend_minor: 1_234, impressions: 100, clicks: 5, link_clicks: 3, currency: 'EUR', date_start: '2026-01-01' },
      { spend_minor: 4_321, impressions: 400, clicks: 9, link_clicks: 6, currency: 'EUR', date_start: '2026-01-01' },
      { spend_minor: 1_000, impressions: 90, clicks: 2, link_clicks: 1, currency: 'EUR', date_start: '2026-01-02' },
    ] satisfies Pick<
      MetaInsightsDailyRow,
      'spend_minor' | 'impressions' | 'clicks' | 'link_clicks' | 'currency' | 'date_start'
    >[];
    expect(foldSpendTotals(rows)).toEqual({
      spend_minor: 6_555,
      impressions: 590,
      clicks: 16,
      link_clicks: 10,
      currency: 'EUR',
      days: 2,
    });
  });
});

describe('experiment query builder', () => {
  it('assigns through the RPC so the unique constraint decides', async () => {
    const { client, find } = fakeClient({ data: 'arm-1' });
    const armId = await new SupabaseExperimentRepository(client).assign('exp-1', 'vis-1', 'arm-2', 0.5);
    expect(find('rpc')[0].args).toEqual([
      'assign_experiment_arm',
      { p_experiment_id: 'exp-1', p_visitor_id: 'vis-1', p_arm_id: 'arm-2', p_bucket: 0.5 },
    ]);
    // The RPC's answer wins over the proposed arm.
    expect(armId).toBe('arm-1');
  });

  it('reports whether an exposure was newly recorded', async () => {
    const truthy = fakeClient({ data: true });
    const falsy = fakeClient({ data: false });
    expect(await new SupabaseExperimentRepository(truthy.client).recordExposure('e', 'v', 's', 'a')).toBe(true);
    expect(await new SupabaseExperimentRepository(falsy.client).recordExposure('e', 'v', 's', 'a')).toBe(false);
  });

  it('refuses to conclude with a WINNER but no winning arm', async () => {
    const { client, calls } = fakeClient({ data: null });
    await expect(
      new SupabaseExperimentRepository(client).conclude('e1', 'WINNER', null, 'u1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });
});

describe('funnel runtime read', () => {
  it('reads a published funnel through the SECURITY DEFINER RPC, not a join', async () => {
    const { client, find, calls } = fakeClient({ data: { published_funnel_id: 'pf-1' } });
    await new SupabaseFunnelRepository(client).getPublishedBySlug('potenzialanalyse-v1');
    expect(find('rpc')[0].args).toEqual(['get_published_funnel', { p_slug: 'potenzialanalyse-v1' }]);
    expect(calls.filter((call) => call.method === 'from')).toHaveLength(0);
  });
});

describe('audit repository', () => {
  it('redacts before and after payloads before they are written', async () => {
    const { client, find } = fakeClient({ data: { id: 'a1' } });
    await new SupabaseAuditRepository(client).append({
      workspace_id: 'ws-1',
      action: 'campaign.created',
      actor_label: 'system',
      entity_type: 'campaign',
      entity_id: 'c1',
      summary_de: 'Kampagne angelegt.',
      after: { email: 'lead@example.de', name: 'Muster', size: 42 },
    });

    const inserted = find('insert')[0].args[0] as { after: Record<string, unknown> };
    expect(inserted.after.email).toBe('[redacted]');
    expect(inserted.after.size).toBe(42);
  });

  it('leaves a null payload null rather than redacting it into an object', async () => {
    const { client, find } = fakeClient({ data: { id: 'a1' } });
    await new SupabaseAuditRepository(client).append({
      workspace_id: 'ws-1',
      action: 'settings.changed',
      actor_label: 'system',
      entity_type: 'settings',
      entity_id: 'ws-1',
      summary_de: 'Einstellungen geändert.',
    });
    const inserted = find('insert')[0].args[0] as { before: unknown; after: unknown };
    expect(inserted.before).toBeNull();
    expect(inserted.after).toBeNull();
  });
});

describe('error translation', () => {
  it('turns a unique violation into a German CONFLICT', async () => {
    const { client } = fakeClient({
      error: { code: '23505', message: 'duplicate key value violates unique constraint "campaigns_slug_unique"' },
    });
    await expect(
      new SupabaseCampaignRepository(client).create({ workspace_id: 'ws-1', name: 'X', slug: 'x' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      messageDe: 'Es existiert bereits eine Kampagne mit diesem Kurznamen.',
    });
  });

  it('turns an RLS denial into FORBIDDEN', async () => {
    const { client } = fakeClient({ error: { code: '42501', message: 'permission denied for table campaigns' } });
    await expect(
      new SupabaseCampaignRepository(client).list({ workspaceId: 'ws-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('passes an immutability trigger message straight through', async () => {
    const { client } = fakeClient({
      error: { code: 'AM001', message: 'Veröffentlichte Version ist unveränderlich. Geänderte Spalten: spec.' },
    });
    await expect(
      new SupabaseCampaignRepository(client).update('c1', { name: 'X' }),
    ).rejects.toMatchObject({
      code: 'IMMUTABLE_VERSION',
      messageDe: 'Veröffentlichte Version ist unveränderlich. Geänderte Spalten: spec.',
    });
  });
});
