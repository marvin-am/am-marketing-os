import { describe, expect, it } from 'vitest';
import {
  adAccountPath,
  bareAccountId,
  buildGraphUrl,
  externalKey,
  mapAd,
  mapAdCreative,
  mapAdSet,
  mapCampaign,
  mapInsightsRow,
  metaAdCreativeSchema,
  metaAdSchema,
  metaAdSetSchema,
  metaCampaignSchema,
  metaInsightsRowSchema,
  metaListResponseSchema,
  parseMajorUnitsToMinor,
  parseMinorUnits,
  toEntityStatus,
} from './types';

/* -------------------------------------------------------------------------- */

describe('Graph URL building', () => {
  it('pins the API version and drops empty parameters', () => {
    const url = buildGraphUrl('v23.0', 'act_123/campaigns', {
      fields: 'id,name',
      limit: 100,
      after: null,
      filtering: '',
    });
    expect(url).toBe('https://graph.facebook.com/v23.0/act_123/campaigns?fields=id%2Cname&limit=100');
  });

  it('normalises the ad account prefix in both directions', () => {
    expect(adAccountPath('123')).toBe('act_123');
    expect(adAccountPath('act_123')).toBe('act_123');
    expect(bareAccountId('act_123')).toBe('123');
    expect(externalKey('120330')).toBe('META:120330');
  });
});

/* -------------------------------------------------------------------------- */

describe('unit conversions', () => {
  it('reads budget fields as minor units and insights money as major units', () => {
    // `daily_budget: "5000"` is 50,00 EUR.
    expect(parseMinorUnits('5000')).toBe(5_000);
    // `spend: "12.34"` is 12,34 EUR.
    expect(parseMajorUnitsToMinor('12.34')).toBe(1_234);
    expect(parseMinorUnits('')).toBeNull();
    expect(parseMajorUnitsToMinor(null)).toBeNull();
  });

  it('maps an unknown status to PAUSED rather than ACTIVE', () => {
    expect(toEntityStatus('ACTIVE')).toBe('ACTIVE');
    expect(toEntityStatus('paused')).toBe('PAUSED');
    expect(toEntityStatus('SOMETHING_NEW')).toBe('PAUSED');
    expect(toEntityStatus(null)).toBe('PAUSED');
  });
});

/* -------------------------------------------------------------------------- */

describe('entity mapping', () => {
  it('maps a campaign, including its minor-unit budget', () => {
    const wire = metaCampaignSchema.parse({
      id: '23851000000000001',
      account_id: 'act_1094732810554371',
      name: 'Potenzialanalyse',
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      effective_status: 'CAMPAIGN_PAUSED',
      buying_type: 'AUCTION',
      daily_budget: '25000',
      special_ad_categories: [],
      created_time: '2026-01-05T09:00:00+0000',
      start_time: '2026-01-06T09:00:00+0000',
    });
    const record = mapCampaign(wire, 'EUR');

    expect(record.externalId).toBe('23851000000000001');
    expect(record.status).toBe('PAUSED');
    expect(record.dailyBudget).toEqual({ amountMinor: 25_000, currency: 'EUR' });
    expect(record.lifetimeBudget).toBeNull();
    expect(record.createdAt).toBe('2026-01-05T09:00:00.000Z');
  });

  it('maps an ad set with its promoted object', () => {
    const wire = metaAdSetSchema.parse({
      id: '23852000000000001',
      campaign_id: '23851000000000001',
      name: 'Kaltpublikum',
      status: 'ACTIVE',
      daily_budget: '12500',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      promoted_object: { pixel_id: '1180347629945512', custom_event_type: 'LEAD' },
      targeting: { geo_locations: { countries: ['DE'] } },
    });
    const record = mapAdSet(wire, 'EUR');

    expect(record.promotedPixelId).toBe('1180347629945512');
    expect(record.promotedCustomEventType).toBe('LEAD');
    expect(record.dailyBudget?.amountMinor).toBe(12_500);
  });

  it('maps an ad and its creative reference', () => {
    const record = mapAd(
      metaAdSchema.parse({
        id: '23853000000000001',
        adset_id: '23852000000000001',
        campaign_id: '23851000000000001',
        name: 'Problem/Schmerz',
        status: 'PAUSED',
        creative: { id: '23854000000000001' },
      }),
    );
    expect(record.creativeExternalId).toBe('23854000000000001');
    expect(record.adSetExternalId).toBe('23852000000000001');
  });

  it('flattens an object_story_spec into a creative record', () => {
    const record = mapAdCreative(
      metaAdCreativeSchema.parse({
        id: '23854000000000001',
        name: 'Creative',
        url_tags: 'meta_ad_id={{ad.id}}',
        object_story_spec: {
          page_id: '104882736611905',
          instagram_actor_id: '17841409876543210',
          link_data: {
            link: 'https://funnel.am-beratung.de/potenzialanalyse',
            message: 'Primärtext',
            name: 'Headline',
            description: 'Beschreibung',
            image_hash: 'abc123',
            call_to_action: { type: 'LEARN_MORE', value: { link: 'https://funnel.am-beratung.de' } },
          },
        },
      }),
    );

    expect(record.pageId).toBe('104882736611905');
    expect(record.instagramActorId).toBe('17841409876543210');
    expect(record.primaryText).toBe('Primärtext');
    expect(record.headline).toBe('Headline');
    expect(record.callToActionType).toBe('LEARN_MORE');
    expect(record.imageHash).toBe('abc123');
    expect(record.urlTags).toBe('meta_ad_id={{ad.id}}');
  });
});

/* -------------------------------------------------------------------------- */

describe('insights mapping', () => {
  const wire = metaInsightsRowSchema.parse({
    date_start: '2026-06-01',
    date_stop: '2026-06-01',
    account_id: 'act_1094732810554371',
    account_currency: 'EUR',
    campaign_id: '23851000000000001',
    adset_id: '23852000000000001',
    ad_id: '23853000000000001',
    ad_name: 'Problem/Schmerz',
    // Meta delivers every one of these as a string.
    impressions: '10000',
    reach: '7000',
    frequency: '1.428571',
    clicks: '250',
    inline_link_clicks: '150',
    spend: '120.50',
    ctr: '2.5',
    cpc: '0.8033',
    cpm: '12.05',
    actions: [
      { action_type: 'lead', value: '12' },
      { action_type: 'post_engagement', value: '340' },
    ],
  });

  it('coerces string numerics and converts spend into minor units', () => {
    const row = mapInsightsRow(wire, 'ad', 'EUR');
    expect(row.impressions).toBe(10_000);
    expect(row.linkClicks).toBe(150);
    expect(row.spend).toEqual({ amountMinor: 12_050, currency: 'EUR' });
    expect(row.date).toBe('2026-06-01');
    expect(row.level).toBe('ad');
    expect(row.externalId).toBe('23853000000000001');
  });

  it('recomputes rates so numerator and denominator travel with the value', () => {
    const row = mapInsightsRow(wire, 'ad', 'EUR');
    expect(row.ctr).toEqual({ numerator: 250, denominator: 10_000, value: 0.025 });
    expect(row.linkCtr).toEqual({ numerator: 150, denominator: 10_000, value: 0.015 });
    expect(row.cpc?.amountMinor).toBe(Math.round(12_050 / 150));
    expect(row.cpm?.amountMinor).toBe(Math.round((12_050 / 10_000) * 1000));
  });

  it('counts only lead action types', () => {
    const row = mapInsightsRow(wire, 'ad', 'EUR');
    expect(row.leads).toBe(12);
    expect(row.cpl?.amountMinor).toBe(Math.round(12_050 / 12));
  });

  it('never divides by zero', () => {
    const empty = metaInsightsRowSchema.parse({
      date_start: '2026-06-02',
      date_stop: '2026-06-02',
      ad_id: '1',
      impressions: '0',
      clicks: '0',
      inline_link_clicks: '0',
      spend: '0',
    });
    const row = mapInsightsRow(empty, 'ad', 'EUR');
    expect(row.ctr.value).toBeNull();
    expect(row.cpc).toBeNull();
    expect(row.cpm).toBeNull();
    expect(row.cpl).toBeNull();
  });

  it('reads the list envelope and its cursors', () => {
    const parsed = metaListResponseSchema(metaCampaignSchema).parse({
      data: [{ id: '1', name: 'A' }],
      paging: { cursors: { before: 'B', after: 'A' }, next: 'https://graph.facebook.com/next' },
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.paging?.cursors?.after).toBe('A');
  });
});
