import { describe, expect, it } from 'vitest';
import { SAFE_DEFAULT_FLAGS } from '@am/domain';
import {
  LAUNCH_TOKEN_PARAM,
  META_DYNAMIC_URL_TAGS,
  allDraftObjects,
  buildDestinationUrl,
  buildDraftPlan,
  createInMemoryDraftStore,
  createPausedDraft,
  draftAdPayload,
  draftAdSetPayload,
  draftCampaignPayload,
  draftCreativePayload,
  draftPlanPreview,
  extractIdempotencyKey,
} from './draft';
import { FixtureMetaProvider } from './fixture-provider';
import { isDryRun } from './provider';

const NOW = '2026-06-30T08:00:00.000Z';
const IDEMPOTENCY_KEY = 'campaign-v7-draft-2026-06-30';

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: IDEMPOTENCY_KEY,
    apiVersion: 'v23.0',
    adAccountId: '1094732810554371',
    currency: 'EUR',
    now: NOW,
    campaign: {
      name: 'Potenzialanalyse Handwerk',
      objective: 'OUTCOME_LEADS' as const,
      dailyBudgetMinor: null,
    },
    adSets: [
      {
        key: 'as_kalt',
        name: 'Kaltpublikum Entscheider',
        dailyBudgetMinor: 15_000,
        optimizationGoal: 'OFFSITE_CONVERSIONS' as const,
        targeting: {
          countries: ['DE'],
          ageMin: 30,
          ageMax: 60,
          placements: { publisherPlatforms: ['facebook', 'instagram'] as const },
        },
        startTime: '2026-07-01T06:00:00.000Z',
      },
    ],
    creatives: [
      {
        key: 'cr_problem',
        name: 'Problem/Schmerz 1:1',
        primaryText: 'Ihre Auslastung schwankt, aber Ihre Fixkosten nicht. Das lässt sich rechnen.',
        headline: 'Kostenlose Potenzialanalyse',
        description: 'In zwei Minuten zur Einschätzung',
        callToAction: 'LEARN_MORE' as const,
        imageHash: 'abc123',
        utmContent: 'problem-schmerz-1x1',
      },
    ],
    ads: [{ key: 'ad_1', name: 'Problem/Schmerz 1:1', adSetKey: 'as_kalt', creativeKey: 'cr_problem' }],
    tracking: {
      pixelId: '1180347629945512',
      pageId: '104882736611905',
      instagramActorId: '17841409876543210',
      destinationBaseUrl: 'https://funnel.am-beratung.de/potenzialanalyse',
      launchToken: 'signed.launch.token',
      utm: { campaign: 'potenzialanalyse-handwerk' },
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('destination URL', () => {
  it('carries the signed launch token and the UTM parameters', () => {
    const url = new URL(
      buildDestinationUrl({
        baseUrl: 'https://funnel.am-beratung.de/potenzialanalyse',
        launchToken: 'signed.launch.token',
        utm: {
          source: 'meta',
          medium: 'paid_social',
          campaign: 'potenzialanalyse-handwerk',
          content: 'problem-schmerz',
          term: null,
        },
      }),
    );

    expect(url.searchParams.get(LAUNCH_TOKEN_PARAM)).toBe('signed.launch.token');
    expect(url.searchParams.get('utm_source')).toBe('meta');
    expect(url.searchParams.get('utm_medium')).toBe('paid_social');
    expect(url.searchParams.get('utm_campaign')).toBe('potenzialanalyse-handwerk');
    expect(url.searchParams.get('utm_content')).toBe('problem-schmerz');
    expect(url.searchParams.get('utm_term')).toBeNull();
  });

  it('refuses a non-HTTPS destination', () => {
    expect(() =>
      buildDestinationUrl({
        baseUrl: 'http://funnel.am-beratung.de',
        launchToken: 't',
        utm: { source: 'meta', medium: 'paid_social', campaign: 'x', content: null, term: null },
      }),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('buildDraftPlan', () => {
  it('resolves a complete, reviewable plan with every object paused', () => {
    const plan = buildDraftPlan(planInput());

    expect(plan.campaign.status).toBe('PAUSED');
    expect(plan.adSets.every((a) => a.status === 'PAUSED')).toBe(true);
    expect(plan.ads.every((a) => a.status === 'PAUSED')).toBe(true);
    expect(plan.adAccountId).toBe('act_1094732810554371');
    expect(plan.apiVersion).toBe('v23.0');
  });

  it('embeds the idempotency key in the campaign name so a remote lookup can find it', () => {
    const plan = buildDraftPlan(planInput());
    expect(plan.campaign.name).toContain('[AM:');
    expect(extractIdempotencyKey(plan.campaign.name)).toBe(IDEMPOTENCY_KEY);
  });

  it('resolves the destination URL and the dynamic URL tags per creative', () => {
    const plan = buildDraftPlan(planInput());
    const creative = plan.creatives[0];

    expect(creative.destinationUrl).toContain('am_t=signed.launch.token');
    expect(creative.destinationUrl).toContain('utm_content=problem-schmerz-1x1');
    expect(creative.urlTags).toBe(META_DYNAMIC_URL_TAGS);
    expect(creative.urlTags).toContain('meta_ad_id={{ad.id}}');
  });

  it('rejects an ad that points at an unknown ad set', () => {
    expect(() =>
      buildDraftPlan(
        planInput({
          ads: [{ key: 'ad_1', name: 'x', adSetKey: 'does_not_exist', creativeKey: 'cr_problem' }],
        }),
      ),
    ).toThrowError(/unbekanntes Ad-Set/);
  });

  it('rejects a budget set on both campaign and ad-set level', () => {
    expect(() =>
      buildDraftPlan(
        planInput({
          campaign: {
            name: 'Doppelbudget',
            objective: 'OUTCOME_LEADS' as const,
            dailyBudgetMinor: 30_000,
          },
        }),
      ),
    ).toThrowError(/Tagesbudget/);
  });

  it('rejects a creative without an image or a video', () => {
    expect(() =>
      buildDraftPlan(
        planInput({
          creatives: [
            {
              key: 'cr_problem',
              name: 'ohne Motiv',
              primaryText: 'Text lang genug für die Validierung dieses Creatives.',
              headline: 'Titel',
              callToAction: 'LEARN_MORE' as const,
            },
          ],
        }),
      ),
    ).toThrowError(/image_hash/);
  });
});

/* -------------------------------------------------------------------------- */

describe('Graph API payloads', () => {
  const plan = buildDraftPlan(planInput());

  it('creates the campaign paused with an explicit special-ad-category declaration', () => {
    const payload = draftCampaignPayload(plan);
    expect(payload.status).toBe('PAUSED');
    expect(payload.objective).toBe('OUTCOME_LEADS');
    expect(payload.special_ad_categories).toEqual([]);
    expect(payload.buying_type).toBe('AUCTION');
    expect(payload.daily_budget).toBeUndefined();
  });

  it('creates the ad set paused with a promoted object and a minor-unit budget', () => {
    const payload = draftAdSetPayload(plan, plan.adSets[0], '120330');
    expect(payload.status).toBe('PAUSED');
    expect(payload.campaign_id).toBe('120330');
    expect(payload.daily_budget).toBe('15000');
    expect(payload.promoted_object).toEqual({
      pixel_id: '1180347629945512',
      custom_event_type: 'LEAD',
    });
    expect(payload.billing_event).toBe('IMPRESSIONS');
    expect(payload.optimization_goal).toBe('OFFSITE_CONVERSIONS');
    expect(payload.targeting).toMatchObject({
      geo_locations: { countries: ['DE'] },
      age_min: 30,
      age_max: 60,
      publisher_platforms: ['facebook', 'instagram'],
    });
  });

  it('builds an object_story_spec with the resolved link and url_tags', () => {
    const payload = draftCreativePayload(plan, plan.creatives[0]) as Record<string, unknown>;
    const spec = payload.object_story_spec as Record<string, unknown>;
    const linkData = spec.link_data as Record<string, unknown>;

    expect(spec.page_id).toBe('104882736611905');
    expect(spec.instagram_actor_id).toBe('17841409876543210');
    expect(linkData.image_hash).toBe('abc123');
    expect(String(linkData.link)).toContain('am_t=signed.launch.token');
    expect(payload.url_tags).toBe(META_DYNAMIC_URL_TAGS);
  });

  it('creates the ad paused and bound to the creative', () => {
    const payload = draftAdPayload(plan, plan.ads[0], '120440', '120550');
    expect(payload.status).toBe('PAUSED');
    expect(payload.adset_id).toBe('120440');
    expect(payload.creative).toEqual({ creative_id: '120550' });
  });

  it('previews exactly the requests that would be sent', () => {
    const preview = draftPlanPreview(plan);
    const requests = preview.requests as { edge: string; body: Record<string, unknown> }[];

    expect(requests.map((r) => r.edge)).toEqual([
      'act_1094732810554371/campaigns',
      'act_1094732810554371/adsets',
      'act_1094732810554371/adcreatives',
      'act_1094732810554371/ads',
    ]);
    expect(requests.filter((r) => 'status' in r.body).every((r) => r.body.status === 'PAUSED')).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('createPausedDraft', () => {
  const writesOn = {
    ...SAFE_DEFAULT_FLAGS,
    demoMode: false,
    externalWritesEnabled: true,
    metaMutationsEnabled: true,
  };

  it('returns a DryRunResult and performs no write when flags are off', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const plan = buildDraftPlan(planInput());

    const result = await createPausedDraft(plan, provider, SAFE_DEFAULT_FLAGS);

    expect(isDryRun(result)).toBe(true);
    if (!isDryRun(result)) throw new Error('unreachable');
    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe('META');
    expect(result.operation).toBe('meta.create_paused_draft_campaign');
    expect(result.blockedByDe).toContain('deaktiviert');
    expect(await provider.findDraftByIdempotencyKey(IDEMPOTENCY_KEY)).toBeNull();
  });

  it('creates every object paused when writes are enabled', async () => {
    const provider = new FixtureMetaProvider({ flags: writesOn });
    const plan = buildDraftPlan(planInput());

    const result = await createPausedDraft(plan, provider, writesOn);

    expect(isDryRun(result)).toBe(false);
    if (isDryRun(result)) throw new Error('unreachable');
    expect(result.state).toBe('CREATED');
    expect(result.campaign?.externalId).toMatch(/^\d+$/);
    expect(allDraftObjects(result).length).toBe(4);
    expect(allDraftObjects(result).every((object) => object.status === 'PAUSED')).toBe(true);
  });

  it('never creates a second campaign for the same idempotency key', async () => {
    const provider = new FixtureMetaProvider({ flags: writesOn });
    const store = createInMemoryDraftStore();
    const plan = buildDraftPlan(planInput());

    const first = await createPausedDraft(plan, provider, writesOn, { store });
    const second = await createPausedDraft(plan, provider, writesOn, { store });

    if (isDryRun(first) || isDryRun(second)) throw new Error('unreachable');
    expect(second.campaign?.externalId).toBe(first.campaign?.externalId);
    expect(second.ads.map((a) => a.externalId)).toEqual(first.ads.map((a) => a.externalId));
  });
});
