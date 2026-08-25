import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TRUSTWORTHY_CONFIDENCES, type Touchpoint } from '@am/domain';
import {
  buildAttributionSnapshot,
  isSnapshotTrustworthy,
  isUniquelyIdentifiedPaidMeta,
  preserveAcquisition,
  resolveChannel,
  resolveTouch,
  selectAcquisitionTouch,
  touchesInWindow,
} from './attribution';
import { emptyMarketingParams, signLaunchToken } from './tokens';

const SECRET = 'unit-test-signing-secret-0123456789';
const VISITOR = randomUUID();
const SESSION = randomUUID();
const LANDING = 'https://funnel.example.com/l/steuerkanzlei';
const SUBMITTED_AT = new Date('2026-03-01T12:00:00.000Z');

function metaTokenTouch(
  occurredAt: string,
  overrides: { campaignId?: string; creativeVersionId?: string } = {},
): Touchpoint {
  const at = new Date(occurredAt);
  const token = signLaunchToken(
    {
      campaign_id: overrides.campaignId ?? randomUUID(),
      campaign_version_id: randomUUID(),
      creative_version_id: overrides.creativeVersionId ?? randomUUID(),
      funnel_version_id: randomUUID(),
    },
    SECRET,
    { now: at },
  );

  return resolveTouch({
    visitorId: VISITOR,
    sessionId: SESSION,
    occurredAt,
    token,
    secret: SECRET,
    now: at,
    referrer: 'https://l.facebook.com/',
    landingUrl: LANDING,
    marketingParams: { utm_source: 'facebook', utm_medium: 'paid_social' },
  });
}

function plainTouch(occurredAt: string, referrer: string | null = null): Touchpoint {
  return resolveTouch({
    visitorId: VISITOR,
    sessionId: SESSION,
    occurredAt,
    referrer,
    landingUrl: LANDING,
  });
}

describe('resolveTouch', () => {
  it('trusts a signed token and marks the touch as paid Meta with EXACT confidence', () => {
    const campaignId = randomUUID();
    const touch = metaTokenTouch('2026-02-25T09:00:00.000Z', { campaignId });

    expect(touch.channel).toBe('META_PAID');
    expect(touch.confidence).toBe('EXACT');
    expect(touch.from_signed_token).toBe(true);
    expect(touch.campaign_id).toBe(campaignId);
  });

  it('never derives an internal id from a query parameter', () => {
    const touch = resolveTouch({
      visitorId: VISITOR,
      sessionId: SESSION,
      occurredAt: '2026-02-25T09:00:00.000Z',
      marketingParams: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'q1' },
      landingUrl: LANDING,
    });

    expect(touch.campaign_id).toBeNull();
    expect(touch.creative_version_id).toBeNull();
    expect(touch.from_signed_token).toBe(false);
    expect(touch.utm_campaign).toBe('q1');
  });

  it('ignores a token that does not verify', () => {
    const forged = signLaunchToken({ campaign_id: randomUUID() }, 'another-secret-value-here-ok');
    const touch = resolveTouch({
      visitorId: VISITOR,
      sessionId: SESSION,
      occurredAt: '2026-02-25T09:00:00.000Z',
      token: forged,
      secret: SECRET,
      landingUrl: LANDING,
    });

    expect(touch.from_signed_token).toBe(false);
    expect(touch.campaign_id).toBeNull();
    expect(touch.channel).toBe('DIRECT');
    expect(touch.confidence).toBe('UNKNOWN');
  });

  describe('confidence ladder', () => {
    const at = '2026-02-25T09:00:00.000Z';

    it('returns EXACT for a signed token', () => {
      expect(metaTokenTouch(at).confidence).toBe('EXACT');
    });

    it('returns EXACT for a Meta click id', () => {
      const touch = resolveTouch({
        visitorId: VISITOR,
        sessionId: SESSION,
        occurredAt: at,
        marketingParams: { fbclid: 'IwAR-xyz' },
        landingUrl: LANDING,
      });
      expect(touch.confidence).toBe('EXACT');
      expect(touch.channel).toBe('META_PAID');
    });

    it('returns EXACT for a campaign parameter that maps 1:1 onto one campaign', () => {
      const touch = resolveTouch({
        visitorId: VISITOR,
        sessionId: SESSION,
        occurredAt: at,
        marketingParams: { utm_source: 'facebook', utm_content: randomUUID() },
        landingUrl: LANDING,
      });
      expect(touch.confidence).toBe('EXACT');
    });

    it('returns HIGH_CONFIDENCE for generic UTMs plus a Meta referrer', () => {
      const touch = resolveTouch({
        visitorId: VISITOR,
        sessionId: SESSION,
        occurredAt: at,
        marketingParams: { utm_source: 'facebook', utm_medium: 'paid_social' },
        referrer: 'https://m.facebook.com/',
        landingUrl: LANDING,
      });
      expect(touch.confidence).toBe('HIGH_CONFIDENCE');
      expect(touch.channel).toBe('META_PAID');
    });

    it('returns MEDIUM_CONFIDENCE for generic UTMs alone', () => {
      const touch = resolveTouch({
        visitorId: VISITOR,
        sessionId: SESSION,
        occurredAt: at,
        marketingParams: { utm_source: 'newsletter', utm_medium: 'email' },
        landingUrl: LANDING,
      });
      expect(touch.confidence).toBe('MEDIUM_CONFIDENCE');
      expect(touch.channel).toBe('EMAIL');
    });

    it('returns LOW_CONFIDENCE for a Meta referrer alone', () => {
      const touch = plainTouch(at, 'https://www.instagram.com/');
      expect(touch.confidence).toBe('LOW_CONFIDENCE');
      expect(touch.channel).toBe('ORGANIC_SOCIAL');
    });

    it('never lets temporal proximity alone reach EXACT', () => {
      const touch = resolveTouch({
        visitorId: VISITOR,
        sessionId: SESSION,
        occurredAt: at,
        temporalProximity: true,
        landingUrl: LANDING,
      });
      expect(touch.confidence).toBe('LOW_CONFIDENCE');
      expect(TRUSTWORTHY_CONFIDENCES).not.toContain(touch.confidence);
      expect(touch.channel).toBe('DIRECT');
    });

    it('falls back to DIRECT/UNKNOWN when nothing identifies the visit', () => {
      const touch = plainTouch(at);
      expect(touch.channel).toBe('DIRECT');
      expect(touch.confidence).toBe('UNKNOWN');
    });
  });
});

describe('resolveChannel', () => {
  const base = { hasSignedToken: false, referrer: null, landingUrl: LANDING };

  it('does not treat a Meta source as paid without a paid signal', () => {
    expect(
      resolveChannel({
        ...base,
        marketingParams: { ...emptyMarketingParams(), utm_source: 'facebook' },
      }),
    ).toBe('ORGANIC_SOCIAL');
  });

  it('classifies search, referral and internal referrers', () => {
    const params = emptyMarketingParams();
    expect(resolveChannel({ ...base, marketingParams: params, referrer: 'https://www.google.de/' })).toBe(
      'ORGANIC_SEARCH',
    );
    expect(
      resolveChannel({ ...base, marketingParams: params, referrer: 'https://partner.example.org/blog' }),
    ).toBe('REFERRAL');
    expect(
      resolveChannel({ ...base, marketingParams: params, referrer: 'https://funnel.example.com/l/other' }),
    ).toBe('DIRECT');
  });

  it('classifies a Google click id as paid search', () => {
    expect(
      resolveChannel({
        ...base,
        marketingParams: emptyMarketingParams(),
        landingUrl: `${LANDING}?gclid=abc123`,
      }),
    ).toBe('GOOGLE_PAID');
  });
});

describe('buildAttributionSnapshot', () => {
  it('picks the last uniquely identified paid-Meta touch as acquisition', () => {
    const older = metaTokenTouch('2026-02-10T08:00:00.000Z');
    const acquisitionCampaign = randomUUID();
    const newer = metaTokenTouch('2026-02-20T08:00:00.000Z', { campaignId: acquisitionCampaign });
    const direct = plainTouch('2026-02-28T08:00:00.000Z');

    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [older, newer, direct],
      now: SUBMITTED_AT,
      consent: 'GRANTED',
    });

    expect(snapshot.acquisition_touch?.id).toBe(newer.id);
    expect(snapshot.campaign_id).toBe(acquisitionCampaign);
    expect(snapshot.channel).toBe('META_PAID');
    expect(snapshot.confidence).toBe('EXACT');
    expect(snapshot.level).toBe('LEAD_LINKED');
    expect(snapshot.first_touch?.id).toBe(older.id);
    expect(snapshot.last_touch?.id).toBe(direct.id);
    expect(snapshot.influenced_touch_ids).toEqual([older.id, direct.id]);
    expect(snapshot.consent_status).toBe('GRANTED');
    expect(snapshot.days_to_conversion).toBe(9.17);
    expect(isSnapshotTrustworthy(snapshot)).toBe(true);
  });

  it('excludes a touch outside the attribution window', () => {
    const outside = metaTokenTouch('2026-01-15T08:00:00.000Z'); // 45 days before
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [outside],
      now: SUBMITTED_AT,
      windowDays: 30,
    });

    expect(touchesInWindow([outside], { now: SUBMITTED_AT, windowDays: 30 })).toEqual([]);
    expect(snapshot.acquisition_touch).toBeNull();
    expect(snapshot.first_touch).toBeNull();
    expect(snapshot.channel).toBe('DIRECT');
    expect(snapshot.confidence).toBe('UNKNOWN');
    expect(snapshot.campaign_id).toBeNull();
    expect(snapshot.days_to_conversion).toBeNull();
    expect(snapshot.window_days).toBe(30);
    expect(isSnapshotTrustworthy(snapshot)).toBe(false);
  });

  it('includes that same touch when the window is widened', () => {
    const outside = metaTokenTouch('2026-01-15T08:00:00.000Z');
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [outside],
      now: SUBMITTED_AT,
      windowDays: 60,
    });

    expect(snapshot.acquisition_touch?.id).toBe(outside.id);
    expect(snapshot.window_days).toBe(60);
  });

  it('does not promote a merely plausible Meta touch to acquisition', () => {
    const plausible = resolveTouch({
      visitorId: VISITOR,
      sessionId: SESSION,
      occurredAt: '2026-02-20T08:00:00.000Z',
      marketingParams: { utm_source: 'facebook', utm_medium: 'paid_social' },
      referrer: 'https://www.facebook.com/',
      landingUrl: LANDING,
    });

    expect(plausible.channel).toBe('META_PAID');
    expect(plausible.confidence).toBe('HIGH_CONFIDENCE');
    expect(isUniquelyIdentifiedPaidMeta(plausible)).toBe(false);

    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [plausible],
      now: SUBMITTED_AT,
    });
    expect(snapshot.acquisition_touch).toBeNull();
    expect(snapshot.channel).toBe('META_PAID');
    expect(snapshot.confidence).toBe('HIGH_CONFIDENCE');
    expect(snapshot.level).toBe('TRAFFIC_LINKED');
  });

  it('ignores a touch that happened after the submission', () => {
    const later = metaTokenTouch('2026-03-02T08:00:00.000Z');
    expect(selectAcquisitionTouch([later], { now: SUBMITTED_AT })).toBeNull();
  });

  it('produces a frozen snapshot', () => {
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [metaTokenTouch('2026-02-20T08:00:00.000Z')],
      now: SUBMITTED_AT,
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.acquisition_touch)).toBe(true);
    expect(() => {
      (snapshot as { channel: string }).channel = 'DIRECT';
    }).toThrow();
  });

  it('defaults consent to UNKNOWN rather than assuming it', () => {
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [],
      now: SUBMITTED_AT,
    });
    expect(snapshot.consent_status).toBe('UNKNOWN');
    expect(snapshot.level).toBe('CREATIVE_ONLY');
  });
});

describe('preserveAcquisition', () => {
  it('never lets a later visit overwrite an existing acquisition', () => {
    const original = metaTokenTouch('2026-02-20T08:00:00.000Z');
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [original],
      now: SUBMITTED_AT,
    });

    const laterCampaign = randomUUID();
    const laterTouch = metaTokenTouch('2026-03-05T08:00:00.000Z', { campaignId: laterCampaign });
    const result = preserveAcquisition(snapshot, laterTouch);

    expect(result.changed).toBe(false);
    expect(result.outcome).toBe('PRESERVED');
    expect(result.snapshot).toBe(snapshot);
    expect(result.snapshot.acquisition_touch?.id).toBe(original.id);
    expect(result.snapshot.campaign_id).toBe(original.campaign_id);
    expect(result.snapshot.campaign_id).not.toBe(laterCampaign);
  });

  it('backfills a missing acquisition from evidence about the past', () => {
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [plainTouch('2026-02-28T08:00:00.000Z')],
      now: SUBMITTED_AT,
    });
    expect(snapshot.acquisition_touch).toBeNull();

    const lateArrival = metaTokenTouch('2026-02-25T08:00:00.000Z');
    const result = preserveAcquisition(snapshot, lateArrival);

    expect(result.changed).toBe(true);
    expect(result.outcome).toBe('BACKFILLED');
    expect(result.snapshot.acquisition_touch?.id).toBe(lateArrival.id);
    expect(result.snapshot.campaign_id).toBe(lateArrival.campaign_id);
    expect(result.snapshot.confidence).toBe('EXACT');
  });

  it('ignores a touch that does not qualify or lies after the submission', () => {
    const snapshot = buildAttributionSnapshot({
      submissionId: randomUUID(),
      touches: [],
      now: SUBMITTED_AT,
    });

    expect(preserveAcquisition(snapshot, plainTouch('2026-02-25T08:00:00.000Z')).outcome).toBe(
      'IGNORED',
    );
    expect(preserveAcquisition(snapshot, metaTokenTouch('2026-03-04T08:00:00.000Z')).outcome).toBe(
      'IGNORED',
    );
    expect(preserveAcquisition(snapshot, metaTokenTouch('2025-12-01T08:00:00.000Z')).outcome).toBe(
      'IGNORED',
    );
  });
});
