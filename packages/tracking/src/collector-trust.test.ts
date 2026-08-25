import { describe, expect, it } from 'vitest';
import type { CollectorContext } from './collector';
import { ingestBatch, normalizeEvent } from './collector';

/**
 * The collector's trust boundary.
 *
 * An adversarial review found that a client could POST an event claiming any
 * `campaign_id`, `creative_version_id`, `experiment_arm_id` and
 * `consent_status: GRANTED` with no token at all, and have every one of them
 * stored verbatim as production traffic — inflating a campaign's sessions,
 * skewing an experiment's denominators, and asserting consent nobody gave.
 *
 * Overlaying the trusted context on top of the client's payload was not enough:
 * a field the token happened not to carry kept whatever the browser sent. These
 * tests pin the rule that internal identifiers are server-owned, full stop.
 */

const forged = {
  event_type: 'funnel_viewed' as const,
  event_schema_version: 1 as const,
  event_id: 'e1111111-1111-4111-8111-111111111111',
  occurred_at: '2026-08-25T10:00:00.000Z',
  visitor_id: '11111111-1111-4111-8111-111111111111',
  session_id: '22222222-2222-4222-8222-222222222222',
  campaign_id: 'c1111111-1111-4111-8111-111111111111',
  campaign_version_id: 'c2222222-2222-4222-8222-222222222222',
  creative_version_id: 'c3333333-3333-4333-8333-333333333333',
  experiment_id: 'e2222222-2222-4222-8222-222222222222',
  experiment_arm_id: 'a1111111-1111-4111-8111-111111111111',
  funnel_version_id: 'f1111111-1111-4111-8111-111111111111',
  consent_status: 'GRANTED' as const,
};

const ctx = (over: Partial<CollectorContext> = {}): CollectorContext =>
  ({
    environment: 'production',
    trafficKind: 'PRODUCTION',
    trusted: null,
    ...over,
  }) as CollectorContext;

describe('client-claimed internal identifiers', () => {
  it('discards every context id when there is no token', () => {
    const result = normalizeEvent(forged, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.campaign_id).toBeNull();
    expect(result.value.campaign_version_id).toBeNull();
    expect(result.value.creative_version_id).toBeNull();
    expect(result.value.experiment_id).toBeNull();
    expect(result.value.experiment_arm_id).toBeNull();
    expect(result.value.funnel_version_id).toBeNull();
  });

  it('discards a claimed consent status', () => {
    const result = normalizeEvent(forged, ctx());
    expect(result.ok && result.value.consent_status).toBe('UNKNOWN');
  });

  it('reports the consent the server knows, not the one the client asserts', () => {
    const result = normalizeEvent({ ...forged, consent_status: 'GRANTED' }, ctx({
      consentStatus: 'DENIED',
    }));
    expect(result.ok && result.value.consent_status).toBe('DENIED');
  });

  it('keeps a client claim out even for a field the token does not carry', () => {
    // The original bug: the token overrode campaign_version_id, and campaign_id
    // — absent from the token — kept the browser's value.
    const result = normalizeEvent(
      forged,
      ctx({ trusted: { campaign_version_id: 'aaaaaaaa-1111-4111-8111-111111111111' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.campaign_version_id).toBe('aaaaaaaa-1111-4111-8111-111111111111');
    expect(result.value.campaign_id).toBeNull();
    expect(result.value.experiment_arm_id).toBeNull();
  });

  it('applies every id the token does carry', () => {
    const trusted = {
      campaign_id: 'bbbbbbbb-1111-4111-8111-111111111111',
      campaign_version_id: 'bbbbbbbb-2222-4222-8222-222222222222',
      creative_version_id: 'bbbbbbbb-3333-4333-8333-333333333333',
      experiment_arm_id: 'bbbbbbbb-4444-4444-8444-444444444444',
    };
    const result = normalizeEvent(forged, ctx({ trusted }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.campaign_id).toBe(trusted.campaign_id);
    expect(result.value.campaign_version_id).toBe(trusted.campaign_version_id);
    expect(result.value.creative_version_id).toBe(trusted.creative_version_id);
    expect(result.value.experiment_arm_id).toBe(trusted.experiment_arm_id);
  });

  it('never lets the client set its own traffic kind or environment', () => {
    const result = normalizeEvent(
      { ...forged, traffic_kind: 'PRODUCTION', environment: 'production' },
      ctx({ trafficKind: 'BOT', environment: 'preview' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.traffic_kind).toBe('BOT');
    expect(result.value.environment).toBe('preview');
  });

  it('still stores the untrusted marketing parameters, which are for reporting', () => {
    const result = normalizeEvent(
      { ...forged, utm_source: 'facebook', utm_campaign: 'potenzialanalyse-q1', fbclid: 'IwAR0x' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.utm_source).toBe('facebook');
    expect(result.value.utm_campaign).toBe('potenzialanalyse-q1');
    expect(result.value.fbclid).toBe('IwAR0x');
  });

  it('holds through the batch path as well as the single-event path', () => {
    const { accepted, rejected } = ingestBatch([forged], ctx());
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.campaign_id).toBeNull();
    expect(accepted[0]?.consent_status).toBe('UNKNOWN');
  });
});
