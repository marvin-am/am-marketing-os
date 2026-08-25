/**
 * Contract tests for the live Graph API adapter.
 *
 * `fetch` is always stubbed — these tests never touch the network. What they
 * pin down is the wire contract: the pinned API version, the bearer header, the
 * cursor semantics, and the fact that a mutation with the flags off does not
 * even reach `fetch`.
 */
import { describe, expect, it, vi } from 'vitest';
import { type DomainError, SAFE_DEFAULT_FLAGS } from '@am/domain';
import { buildDraftPlan } from './draft';
import { LiveMetaProvider, formEncode } from './live-provider';
import { isDryRun } from './provider';

const WRITES_ON = {
  ...SAFE_DEFAULT_FLAGS,
  demoMode: false,
  externalWritesEnabled: true,
  metaMutationsEnabled: true,
  metaCapiEnabled: true,
};

interface StubResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function stubFetch(responses: StubResponse[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 200, body: { data: [] } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  });
  return { impl, calls };
}

function provider(
  fetchImpl: ReturnType<typeof stubFetch>['impl'],
  flags = WRITES_ON,
  maxAttempts = 3,
) {
  return new LiveMetaProvider({
    apiVersion: 'v23.0',
    accessToken: 'EAAG-secret-token',
    adAccountId: 'act_1094732810554371',
    currency: 'EUR',
    pixelId: '1180347629945512',
    pageId: '104882736611905',
    flags,
    fetchImpl,
    retry: {
      maxAttempts,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      jitterRatio: 0,
      sleep: async () => undefined,
    },
  });
}

function metaError(code: number, message = 'error') {
  return { error: { message, type: 'OAuthException', code, fbtrace_id: 'trace' } };
}

/* -------------------------------------------------------------------------- */

describe('transport', () => {
  it('refuses to construct without an API version or credentials', () => {
    expect(
      () =>
        new LiveMetaProvider({
          apiVersion: '',
          accessToken: 't',
          adAccountId: 'act_1',
          flags: WRITES_ON,
        }),
    ).toThrowError(/META_API_VERSION/);
    expect(
      () =>
        new LiveMetaProvider({
          apiVersion: 'v23.0',
          accessToken: '',
          adAccountId: '',
          flags: WRITES_ON,
        }),
    ).toThrowError(/nicht verbunden/);
  });

  it('pins the API version and sends the token as a bearer header, never in the URL', async () => {
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    await provider(impl).importCampaigns();

    expect(calls[0].url).toContain('https://graph.facebook.com/v23.0/act_1094732810554371/campaigns');
    expect(calls[0].url).not.toContain('EAAG-secret-token');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer EAAG-secret-token');
  });

  it('treats paging.next as the only "there is more" signal', async () => {
    const { impl } = stubFetch([
      {
        body: {
          data: [{ id: '1', name: 'A' }],
          // `after` is present on the last page too — without `next` we stop.
          paging: { cursors: { after: 'CURSOR_A' } },
        },
      },
    ]);
    const page = await provider(impl).importCampaigns();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('follows the cursor when paging.next is present', async () => {
    const { impl, calls } = stubFetch([
      {
        body: {
          data: [{ id: '1', name: 'A' }],
          paging: { cursors: { after: 'CURSOR_A' }, next: 'https://graph.facebook.com/next' },
        },
      },
      { body: { data: [{ id: '2', name: 'B' }] } },
    ]);
    const live = provider(impl);
    const first = await live.importCampaigns();
    expect(first.nextCursor).toBe('CURSOR_A');

    await live.importCampaigns({ cursor: first.nextCursor });
    expect(calls[1].url).toContain('after=CURSOR_A');
  });

  it('requests daily insights with time_increment=1 and a JSON time_range', async () => {
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    await provider(impl).fetchInsightsDaily({
      level: 'ad',
      since: '2026-06-01',
      until: '2026-06-30',
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('level')).toBe('ad');
    expect(url.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(url.searchParams.get('time_range') ?? '{}')).toEqual({
      since: '2026-06-01',
      until: '2026-06-30',
    });
  });

  it('tags every raw payload with the pinned API version', async () => {
    const { impl } = stubFetch([{ body: { data: [{ id: '1', name: 'A' }] } }]);
    const page = await provider(impl).importCampaigns();
    expect(page.raw[0]).toMatchObject({ provider: 'META', kind: 'CAMPAIGN', apiVersion: 'v23.0' });
  });
});

/* -------------------------------------------------------------------------- */

describe('error handling', () => {
  it('retries a throttled response and finally surfaces PROVIDER_RATE_LIMITED', async () => {
    const { impl } = stubFetch([
      { status: 429, body: metaError(17), headers: { 'retry-after': '2' } },
      { status: 429, body: metaError(17), headers: { 'retry-after': '2' } },
      { status: 429, body: metaError(17), headers: { 'retry-after': '2' } },
    ]);

    let thrown: unknown;
    try {
      await provider(impl).importCampaigns();
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(error.retryable).toBe(true);
    expect(error.details.delays_ms).toEqual([2_000, 2_000]);
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('recovers when the throttling clears', async () => {
    const { impl } = stubFetch([
      { status: 429, body: metaError(613) },
      { body: { data: [{ id: '1', name: 'A' }] } },
    ]);
    const page = await provider(impl).importCampaigns();
    expect(page.items).toHaveLength(1);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permission error and reports it in German', async () => {
    const { impl } = stubFetch([{ status: 400, body: metaError(200, 'Permissions error') }]);

    let thrown: unknown;
    try {
      await provider(impl).importCampaigns();
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.messageDe).toContain('Berechtigungen');
    expect(error.messageDe).not.toContain('Permissions error');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('does not retry an expired token', async () => {
    const { impl } = stubFetch([{ status: 400, body: metaError(190) }]);
    await expect(provider(impl).importCampaigns()).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('rejects an unexpected response shape rather than guessing', async () => {
    const { impl } = stubFetch([{ body: { data: [{ name: 'no id' }] } }]);
    await expect(provider(impl).importCampaigns()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('refuses to download an asset from a host that is not a Meta CDN', async () => {
    const { impl } = stubFetch([]);
    await expect(
      provider(impl).downloadCreativeAsset('https://evil.example.com/pixel.png'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(impl).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('mutations respect the feature flags', () => {
  it('returns a DryRunResult and never calls fetch when writes are disabled', async () => {
    const { impl } = stubFetch([]);
    const live = provider(impl, SAFE_DEFAULT_FLAGS);

    const paused = await live.pauseEntity({
      ref: { level: 'ADSET', externalId: '23852' },
      idempotencyKey: 'pause-23852',
    });
    const budget = await live.updateBudget({
      ref: { level: 'ADSET', externalId: '23852' },
      dailyBudgetMinor: 24_000,
      currency: 'EUR',
      idempotencyKey: 'scale-23852',
    });
    const capi = await live.sendCapiEvents({
      destinationId: '1180347629945512',
      events: [
        {
          event_name: 'Lead',
          event_time: 1_780_000_000,
          action_source: 'website',
          user_data: {},
        },
      ],
    });

    expect(isDryRun(paused)).toBe(true);
    expect(isDryRun(budget)).toBe(true);
    expect(isDryRun(capi)).toBe(true);
    expect(impl).not.toHaveBeenCalled();
  });

  it('writes and then re-reads the object before reporting a confirmation', async () => {
    const { impl, calls } = stubFetch([
      { body: { success: true } },
      { body: { id: '23852', name: 'Kaltpublikum', status: 'PAUSED', daily_budget: '15000' } },
    ]);

    const result = await provider(impl).pauseEntity({
      ref: { level: 'ADSET', externalId: '23852' },
      idempotencyKey: 'pause-23852',
    });

    expect(isDryRun(result)).toBe(false);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('status=PAUSED');
    // The second call is the read-back that turns a 200 into a confirmation.
    expect(calls[1].init?.method).toBe('GET');
    expect(calls).toHaveLength(2);
  });

  it('posts CAPI events to the /events edge with a JSON data array', async () => {
    const { impl, calls } = stubFetch([{ body: { events_received: 1, fbtrace_id: 'trace' } }]);
    const result = await provider(impl).sendCapiEvents({
      destinationId: '1180347629945512',
      events: [
        {
          event_name: 'Lead',
          event_time: 1_780_000_000,
          event_id: 'abc',
          action_source: 'website',
          user_data: {},
        },
      ],
      testEventCode: 'TEST123',
    });

    expect(isDryRun(result)).toBe(false);
    expect(calls[0].url).toContain('/v23.0/1180347629945512/events');
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(JSON.parse(body.get('data') ?? '[]')[0].event_id).toBe('abc');
    expect(body.get('test_event_code')).toBe('TEST123');
  });
});

/* -------------------------------------------------------------------------- */

describe('paused draft creation', () => {
  const plan = buildDraftPlan({
    idempotencyKey: 'draft-key-000001',
    apiVersion: 'v23.0',
    adAccountId: 'act_1094732810554371',
    currency: 'EUR',
    now: '2026-06-30T08:00:00.000Z',
    campaign: { name: 'Kampagne', objective: 'OUTCOME_LEADS', dailyBudgetMinor: null },
    adSets: [
      {
        key: 'as_1',
        name: 'Ad-Set',
        dailyBudgetMinor: 15_000,
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        targeting: { countries: ['DE'] },
        startTime: '2026-07-01T06:00:00.000Z',
      },
    ],
    creatives: [
      {
        key: 'cr_1',
        name: 'Creative',
        primaryText: 'Ein hinreichend langer Primärtext für die Validierung.',
        headline: 'Headline',
        callToAction: 'LEARN_MORE',
        imageHash: 'abc123',
      },
    ],
    ads: [{ key: 'ad_1', name: 'Ad', adSetKey: 'as_1', creativeKey: 'cr_1' }],
    tracking: {
      pixelId: '1180347629945512',
      pageId: '104882736611905',
      destinationBaseUrl: 'https://funnel.am-beratung.de/analyse',
      launchToken: 'token',
      utm: { campaign: 'analyse' },
    },
  });

  it('creates campaign, ad set, creative and ad — each PAUSED', async () => {
    const { impl, calls } = stubFetch([
      { body: { id: '120_campaign' } },
      { body: { id: '120_adset' } },
      { body: { id: '120_creative' } },
      { body: { id: '120_ad' } },
    ]);

    const result = await provider(impl).createPausedDraftCampaign(plan);
    expect(isDryRun(result)).toBe(false);
    if (isDryRun(result)) throw new Error('unreachable');

    expect(result.state).toBe('CREATED');
    expect(result.campaign?.externalId).toBe('120_campaign');
    expect(result.adSets[0].externalId).toBe('120_adset');
    expect(result.creatives[0].externalId).toBe('120_creative');
    expect(result.ads[0].externalId).toBe('120_ad');

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v23.0/act_1094732810554371/campaigns',
      '/v23.0/act_1094732810554371/adsets',
      '/v23.0/act_1094732810554371/adcreatives',
      '/v23.0/act_1094732810554371/ads',
    ]);

    for (const call of calls) {
      const body = new URLSearchParams(String(call.init?.body));
      if (body.has('status')) expect(body.get('status')).toBe('PAUSED');
    }
  });

  it('reports PARTIAL with the ids that were actually created', async () => {
    const { impl } = stubFetch([
      { body: { id: '120_campaign' } },
      { status: 400, body: metaError(100, 'Invalid targeting') },
    ]);

    const result = await provider(impl, WRITES_ON, 1).createPausedDraftCampaign(plan);
    if (isDryRun(result)) throw new Error('unreachable');

    expect(result.ok).toBe(false);
    expect(result.state).toBe('PARTIAL');
    expect(result.campaign?.externalId).toBe('120_campaign');
    expect(result.adSets).toHaveLength(0);
    expect(result.errorDe).toContain('mindestens ein Feld ist ungültig');
  });

  it('recovers an existing draft from the idempotency marker in the campaign name', async () => {
    const { impl } = stubFetch([
      { body: { data: [{ id: '120_campaign', name: 'Kampagne [AM:draft-key-000001]' }] } },
      { body: { data: [{ id: '120_adset', name: 'Ad-Set' }] } },
      { body: { data: [{ id: '120_ad', name: 'Ad', creative: { id: '120_creative' } }] } },
    ]);

    const found = await provider(impl).findDraftByIdempotencyKey('draft-key-000001');
    expect(found?.campaign?.externalId).toBe('120_campaign');
    expect(found?.ads[0].externalId).toBe('120_ad');
    expect(found?.creatives[0].externalId).toBe('120_creative');
  });
});

/* -------------------------------------------------------------------------- */

describe('formEncode', () => {
  it('keeps scalars readable and serialises nested structures as JSON', () => {
    expect(
      formEncode({
        status: 'PAUSED',
        daily_budget: 15_000,
        promoted_object: { pixel_id: '1', custom_event_type: 'LEAD' },
        omitted: null,
      }),
    ).toEqual({
      status: 'PAUSED',
      daily_budget: '15000',
      promoted_object: '{"pixel_id":"1","custom_event_type":"LEAD"}',
    });
  });
});
