import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@am/config';
import {
  buildLaunchUrl,
  emptyTrackingContext,
  getLaunchTokenSecret,
  LAUNCH_TOKEN_PARAM,
  packUuid,
  parseLandingUrl,
  signLaunchToken,
  unpackUuid,
  verifyLaunchToken,
} from './tokens';

const SECRET = 'unit-test-signing-secret-0123456789';
const OTHER_SECRET = 'a-completely-different-secret-value';
const NOW = new Date('2026-03-01T10:00:00.000Z');

function samplePayload() {
  return {
    campaign_id: randomUUID(),
    campaign_version_id: randomUUID(),
    creative_version_id: randomUUID(),
    funnel_version_id: randomUUID(),
    form_version_id: randomUUID(),
    experiment_id: randomUUID(),
  };
}

describe('packUuid / unpackUuid', () => {
  it('round-trips losslessly in 22 characters', () => {
    for (let i = 0; i < 200; i++) {
      const uuid = randomUUID();
      const packed = packUuid(uuid);
      expect(packed).toHaveLength(22);
      expect(unpackUuid(packed)).toBe(uuid);
    }
  });

  it('rejects anything that is not a UUID', () => {
    expect(() => packUuid('nope')).toThrow();
    expect(unpackUuid('short')).toBeNull();
  });
});

describe('signLaunchToken / verifyLaunchToken', () => {
  it('round-trips every internal id', () => {
    const payload = samplePayload();
    const token = signLaunchToken(payload, SECRET, { now: NOW });

    const verified = verifyLaunchToken(token, SECRET, { now: NOW });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    expect(verified.value.campaign_id).toBe(payload.campaign_id);
    expect(verified.value.campaign_version_id).toBe(payload.campaign_version_id);
    expect(verified.value.creative_version_id).toBe(payload.creative_version_id);
    expect(verified.value.funnel_version_id).toBe(payload.funnel_version_id);
    expect(verified.value.form_version_id).toBe(payload.form_version_id);
    expect(verified.value.experiment_id).toBe(payload.experiment_id);
    // Ids that were not signed stay null — never guessed.
    expect(verified.value.angle_id).toBeNull();
  });

  it('is URL-safe and version-prefixed', () => {
    const token = signLaunchToken(samplePayload(), SECRET, { now: NOW });
    expect(token.startsWith('v1.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('rejects a tampered payload', () => {
    const token = signLaunchToken(samplePayload(), SECRET, { now: NOW });
    const parts = token.split('.') as [string, string, string];
    const version = parts[0];
    const signature = parts[2];

    // Attacker rewrites the campaign id and keeps the original signature.
    const forgedBody = Buffer.from(
      JSON.stringify({ c: packUuid(randomUUID()), i: 0, e: 4_102_444_800 }),
      'utf8',
    ).toString('base64url');
    const forged = `${version}.${forgedBody}.${signature}`;

    const result = verifyLaunchToken(forged, SECRET, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a tampered signature', () => {
    const token = signLaunchToken(samplePayload(), SECRET, { now: NOW });
    const [version, body, signature] = token.split('.') as [string, string, string];
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    const result = verifyLaunchToken(`${version}.${body}.${flipped}`, SECRET, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a token signed with another secret', () => {
    const token = signLaunchToken(samplePayload(), OTHER_SECRET, { now: NOW });
    const result = verifyLaunchToken(token, SECRET, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects an expired token', () => {
    const token = signLaunchToken(samplePayload(), SECRET, { now: NOW, ttlSeconds: 60 });

    const stillValid = verifyLaunchToken(token, SECRET, {
      now: new Date(NOW.getTime() + 59_000),
    });
    expect(stillValid.ok).toBe(true);

    const expired = verifyLaunchToken(token, SECRET, { now: new Date(NOW.getTime() + 61_000) });
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.error.details.reason).toBe('EXPIRED');
    expect(expired.error.messageDe).toContain('abgelaufen');
  });

  it('rejects an unknown version prefix', () => {
    const token = signLaunchToken(samplePayload(), SECRET, { now: NOW });
    const result = verifyLaunchToken(`v2${token.slice(2)}`, SECRET, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details.reason).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects malformed input and a missing secret', () => {
    expect(verifyLaunchToken('not-a-token', SECRET).ok).toBe(false);
    expect(verifyLaunchToken('', SECRET).ok).toBe(false);

    const noSecret = verifyLaunchToken(
      signLaunchToken(samplePayload(), SECRET, { now: NOW }),
      null,
      { now: NOW },
    );
    expect(noSecret.ok).toBe(false);
    if (noSecret.ok) return;
    expect(noSecret.error.details.reason).toBe('MISSING_SECRET');
  });

  it('refuses to sign with a weak secret', () => {
    expect(() => signLaunchToken(samplePayload(), 'short')).toThrow();
  });
});

describe('getLaunchTokenSecret', () => {
  afterEach(() => {
    delete process.env.TRACKING_SIGNING_SECRET;
    resetConfigCache();
  });

  it('reads the configured secret', () => {
    process.env.TRACKING_SIGNING_SECRET = SECRET;
    resetConfigCache();
    expect(getLaunchTokenSecret()).toBe(SECRET);
  });

  it('returns null rather than a weak or missing secret', () => {
    resetConfigCache();
    expect(getLaunchTokenSecret()).toBeNull();

    process.env.TRACKING_SIGNING_SECRET = 'too-short';
    resetConfigCache();
    expect(getLaunchTokenSecret()).toBeNull();
  });
});

describe('buildLaunchUrl', () => {
  const token = signLaunchToken(samplePayload(), SECRET, { now: NOW });

  it('carries the token and the whitelisted marketing parameters', () => {
    const url = new URL(
      buildLaunchUrl('https://funnel.example.com/l/steuer', token, {
        utm_source: 'facebook',
        utm_medium: 'paid_social',
        utm_campaign: 'q1-steuerkanzlei',
      }),
    );

    expect(url.searchParams.get(LAUNCH_TOKEN_PARAM)).toBe(token);
    expect(url.searchParams.get('utm_source')).toBe('facebook');
    expect(url.searchParams.get('utm_medium')).toBe('paid_social');
  });

  it('keeps Meta macros substitutable', () => {
    const url = buildLaunchUrl('https://funnel.example.com/l/steuer', token, {
      utm_content: '{{ad.id}}',
      meta_ad_id: '{{ad.id}}',
    });
    expect(url).toContain('utm_content={{ad.id}}');
    expect(url).not.toContain('%7B%7B');
  });

  it('refuses a non-HTTPS destination', () => {
    expect(() => buildLaunchUrl('http://funnel.example.com/l/x', token)).toThrow();
    expect(() => buildLaunchUrl('nonsense', token)).toThrow();
  });
});

describe('parseLandingUrl', () => {
  it('recovers trusted ids from a valid token', () => {
    const payload = samplePayload();
    const token = signLaunchToken(payload, SECRET, { now: NOW });
    const url = buildLaunchUrl('https://funnel.example.com/l/steuer', token, {
      utm_source: 'facebook',
      fbclid: 'IwAR-abc123',
    });

    const parsed = parseLandingUrl(url, { secret: SECRET, now: NOW });
    expect(parsed.tokenValid).toBe(true);
    expect(parsed.trusted.campaign_id).toBe(payload.campaign_id);
    expect(parsed.marketingParams.utm_source).toBe('facebook');
    expect(parsed.marketingParams.fbclid).toBe('IwAR-abc123');
  });

  it('never lets an untrusted query parameter override a token id', () => {
    const payload = samplePayload();
    const attackerCampaignId = randomUUID();
    const token = signLaunchToken(payload, SECRET, { now: NOW });
    const url =
      buildLaunchUrl('https://funnel.example.com/l/steuer', token, { utm_campaign: 'organic' }) +
      `&campaign_id=${attackerCampaignId}` +
      `&creative_version_id=${randomUUID()}` +
      `&experiment_arm_id=${randomUUID()}`;

    const parsed = parseLandingUrl(url, { secret: SECRET, now: NOW });

    expect(parsed.trusted.campaign_id).toBe(payload.campaign_id);
    expect(parsed.trusted.campaign_id).not.toBe(attackerCampaignId);
    expect(parsed.trusted.creative_version_id).toBe(payload.creative_version_id);
    expect(parsed.trusted.experiment_arm_id).toBeNull();
    expect(parsed.ignoredTrustedParams).toEqual(
      expect.arrayContaining(['campaign_id', 'creative_version_id', 'experiment_arm_id']),
    );
    // The untrusted value is still kept for reporting, just not as an id.
    expect(parsed.marketingParams.utm_campaign).toBe('organic');
  });

  it('yields no trusted ids when the token does not verify', () => {
    const token = signLaunchToken(samplePayload(), OTHER_SECRET, { now: NOW });
    const url = buildLaunchUrl('https://funnel.example.com/l/steuer', token, {
      utm_source: 'facebook',
    });

    const parsed = parseLandingUrl(url, { secret: SECRET, now: NOW });
    expect(parsed.tokenPresent).toBe(true);
    expect(parsed.tokenValid).toBe(false);
    expect(parsed.trusted).toEqual(emptyTrackingContext());
    expect(parsed.marketingParams.utm_source).toBe('facebook');
  });

  it('handles a URL without a token at all', () => {
    const parsed = parseLandingUrl('https://funnel.example.com/l/steuer?utm_source=newsletter', {
      secret: SECRET,
    });
    expect(parsed.tokenPresent).toBe(false);
    expect(parsed.tokenRejection).toBeNull();
    expect(parsed.trusted).toEqual(emptyTrackingContext());
    expect(parsed.marketingParams.utm_source).toBe('newsletter');
  });
});
