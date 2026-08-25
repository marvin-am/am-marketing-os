import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMA_VERSION } from '@am/domain';
import {
  createExposureRegistry,
  createMemoryDedupeStore,
  createRateLimiter,
  deriveAbandonedForms,
  deterministicUuid,
  findEventPiiViolations,
  hashIdentifier,
  ingestBatch,
  normalizeEvent,
  rateLimitKeyFor,
  shouldRecordExposure,
  type CollectorContext,
  type FormInstanceActivity,
} from './collector';

const NOW = new Date('2026-03-01T10:00:00.000Z');

const ctx: CollectorContext = {
  environment: 'production',
  trafficKind: 'PRODUCTION',
  receivedAt: NOW.toISOString(),
};

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'funnel_viewed',
    event_schema_version: EVENT_SCHEMA_VERSION,
    occurred_at: '2026-03-01T09:59:58.000Z',
    visitor_id: randomUUID(),
    session_id: randomUUID(),
    ...overrides,
  };
}

describe('normalizeEvent', () => {
  it('fills the server-owned fields', () => {
    const result = normalizeEvent(baseEvent(), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.value.received_at).toBe(NOW.toISOString());
    expect(result.value.environment).toBe('production');
    expect(result.value.traffic_kind).toBe('PRODUCTION');
  });

  it('stamps the traffic kind decided at the edge, not the one the client claims', () => {
    const result = normalizeEvent(baseEvent({ traffic_kind: 'PRODUCTION' }), {
      ...ctx,
      trafficKind: 'BOT',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.traffic_kind).toBe('BOT');
  });

  it('lets trusted token ids win over anything the payload claims', () => {
    const trustedCampaign = randomUUID();
    const result = normalizeEvent(baseEvent({ campaign_id: randomUUID() }), {
      ...ctx,
      trusted: { campaign_id: trustedCampaign },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.campaign_id).toBe(trustedCampaign);
  });

  it('keeps the client-provided event id so a retry is idempotent', () => {
    const eventId = randomUUID();
    const result = normalizeEvent(baseEvent({ event_id: eventId }), ctx);
    expect(result.ok && result.value.event_id).toBe(eventId);
  });

  it('rejects an unsupported schema version', () => {
    const result = normalizeEvent(baseEvent({ event_schema_version: 2 }), ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed envelope', () => {
    expect(normalizeEvent(baseEvent({ event_type: 'made_up' }), ctx).ok).toBe(false);
    expect(normalizeEvent(baseEvent({ visitor_id: 'nope' }), ctx).ok).toBe(false);
    expect(normalizeEvent('not-an-object', ctx).ok).toBe(false);
    expect(normalizeEvent(null, ctx).ok).toBe(false);
  });
});

describe('PII guard', () => {
  it('rejects an event carrying an e-mail address', () => {
    const result = normalizeEvent(
      baseEvent({ metadata: { contact: 'max.mustermann@example.de' } }),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(result.error.details.reason).toBe('PII_DETECTED');
    expect(result.error.messageDe).toContain('personenbezogene Daten');
    expect(String(result.error.details.violations)).toContain('E-Mail-Muster');
  });

  it('rejects an event carrying a phone number', () => {
    const result = normalizeEvent(baseEvent({ metadata: { c: '+49 170 1234567' } }), ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details.reason).toBe('PII_DETECTED');
  });

  it.each(['answers', 'email', 'name', 'first_name', 'phone', 'nachricht', 'ip', 'user_agent'])(
    'rejects an event carrying a "%s" key',
    (key) => {
      const result = normalizeEvent(baseEvent({ [key]: { a: 1 } }), ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details.reason).toBe('PII_DETECTED');
    },
  );

  it('rejects PII nested inside an unknown key, before the schema strips it', () => {
    const result = normalizeEvent(
      baseEvent({ debug: { extra: ['harmless', 'kontakt@example.de'] } }),
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts form_validation_failed carrying only a field id and a code', () => {
    const result = normalizeEvent(
      baseEvent({
        event_type: 'form_validation_failed',
        form_instance_id: randomUUID(),
        step_id: 'kontakt',
        field_id: 'email',
        error_code: 'INVALID_EMAIL',
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.field_id).toBe('email');
    expect(result.value.error_code).toBe('INVALID_EMAIL');
    // The value the visitor typed is nowhere in the envelope.
    expect(JSON.stringify(result.value)).not.toContain('@');
  });

  it('does not mistake a UUID for a phone number', () => {
    // `00123456-…` satisfies the domain phone heuristic by coincidence.
    const trickyId = '00123456-7890-4abc-8def-0123456789ab';
    expect(findEventPiiViolations({ visitor_id: trickyId })).toEqual([]);
    expect(findEventPiiViolations({ metadata: { v: '+49 170 1234567' } })).not.toEqual([]);

    const result = normalizeEvent(baseEvent({ visitor_id: trickyId }), ctx);
    expect(result.ok).toBe(true);
  });
});

describe('ingestBatch', () => {
  it('accepts the good events and rejects only the bad ones', () => {
    const result = ingestBatch(
      [baseEvent(), baseEvent({ visitor_id: 'broken' }), baseEvent()],
      ctx,
    );

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reasonDe.length).toBeGreaterThan(0);
  });

  it('is idempotent on event_id within and across batches', () => {
    const dedupe = createMemoryDedupeStore();
    const eventId = randomUUID();
    const event = baseEvent({ event_id: eventId });

    const first = ingestBatch([event, event], { ...ctx, dedupe });
    expect(first.accepted).toHaveLength(1);
    expect(first.duplicates).toEqual([eventId]);

    const retry = ingestBatch([event], { ...ctx, dedupe });
    expect(retry.accepted).toHaveLength(0);
    expect(retry.duplicates).toEqual([eventId]);
    expect(retry.rejected).toHaveLength(0);
  });

  it('rate-limits by hashed key', () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1 });
    const key = rateLimitKeyFor({ ipAddress: '203.0.113.7', salt: 'pepper' });
    expect(key.startsWith('i:')).toBe(true);
    expect(key).not.toContain('203.0.113.7');

    const result = ingestBatch(
      [baseEvent(), baseEvent(), baseEvent(), baseEvent(), baseEvent()],
      { ...ctx, limiter, rateLimitKey: key },
    );

    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.code).toBe('RATE_LIMITED');
  });

  it('caps the batch size', () => {
    const events = Array.from({ length: 4 }, () => baseEvent());
    const result = ingestBatch(events, { ...ctx, maxBatchSize: 2 });
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
  });

  it('prefers the visitor id over the IP for the rate-limit key and hashes both', () => {
    const visitorId = randomUUID();
    expect(rateLimitKeyFor({ visitorId, ipAddress: '203.0.113.7' })).toBe(
      `v:${hashIdentifier(visitorId, undefined)}`,
    );
    expect(rateLimitKeyFor({})).toBe('anon');
  });
});

describe('createRateLimiter', () => {
  it('refills over time', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1 });
    const start = NOW.getTime();

    expect(limiter.take('k', 1, start).allowed).toBe(true);
    expect(limiter.take('k', 1, start).allowed).toBe(true);

    const blocked = limiter.take('k', 1, start);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);

    expect(limiter.take('k', 1, start + 1_000).allowed).toBe(true);
    expect(limiter.take('other', 1, start).allowed).toBe(true);
  });
});

describe('deriveAbandonedForms', () => {
  const instance = (overrides: Partial<FormInstanceActivity> = {}): FormInstanceActivity => ({
    form_instance_id: randomUUID(),
    visitor_id: randomUUID(),
    session_id: randomUUID(),
    started_at: '2026-03-01T09:00:00.000Z',
    last_activity_at: '2026-03-01T09:10:00.000Z',
    submitted: false,
    step_id: 'kontakt',
    ...overrides,
  });

  it('derives an event once the inactivity window has elapsed', () => {
    const events = deriveAbandonedForms([instance()], NOW, 30);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('form_abandoned');
    // The moment the window elapsed, not the moment the job ran.
    expect(events[0]?.occurred_at).toBe('2026-03-01T09:40:00.000Z');
    expect(events[0]?.metadata.seconds_on_form).toBe(600);
    expect(events[0]?.step_id).toBe('kontakt');
  });

  it('does not derive for submitted, already-recorded or still-active instances', () => {
    const events = deriveAbandonedForms(
      [
        instance({ submitted: true }),
        instance({ abandoned_recorded: true }),
        instance({ last_activity_at: '2026-03-01T09:45:00.000Z' }),
      ],
      NOW,
      30,
    );
    expect(events).toEqual([]);
  });

  it('produces a stable event id so a re-run does not double count', () => {
    const one = instance();
    const first = deriveAbandonedForms([one], NOW, 30);
    const second = deriveAbandonedForms([one], new Date(NOW.getTime() + 3_600_000), 30);

    expect(first[0]?.event_id).toBe(second[0]?.event_id);
    expect(first[0]?.occurred_at).toBe(second[0]?.occurred_at);
    expect(deterministicUuid('form_abandoned', one.form_instance_id)).toBe(first[0]?.event_id);
    expect(deterministicUuid('form_abandoned', randomUUID())).not.toBe(first[0]?.event_id);
  });

  it('carries the trusted campaign context through', () => {
    const campaignId = randomUUID();
    const events = deriveAbandonedForms(
      [instance({ context: { campaign_id: campaignId }, traffic_kind: 'PRODUCTION' })],
      NOW,
      30,
    );
    expect(events[0]?.campaign_id).toBe(campaignId);
  });
});

describe('shouldRecordExposure', () => {
  const experimentId = randomUUID();
  const visitorId = randomUUID();
  const sessionId = randomUUID();

  it('records on an actual render, exactly once per experiment/visitor/session', () => {
    const registry = createExposureRegistry();
    const input = { experimentId, visitorId, sessionId, rendered: true, isRecorded: registry.has };

    const first = shouldRecordExposure(input);
    expect(first.record).toBe(true);
    registry.add(first.key);

    expect(shouldRecordExposure(input).record).toBe(false);
    expect(shouldRecordExposure(input).reason).toBe('ALREADY_RECORDED');

    // A new session of the same visitor is a new exposure.
    const nextSession = shouldRecordExposure({ ...input, sessionId: randomUUID() });
    expect(nextSession.record).toBe(true);
  });

  it('never records without a render — assignment alone is not exposure', () => {
    const decision = shouldRecordExposure({
      experimentId,
      visitorId,
      sessionId,
      rendered: false,
    });
    expect(decision.record).toBe(false);
    expect(decision.reason).toBe('NOT_RENDERED');
  });

  it('never records non-production traffic', () => {
    for (const trafficKind of ['BOT', 'PREVIEW', 'INTERNAL', 'TEST'] as const) {
      const decision = shouldRecordExposure({
        experimentId,
        visitorId,
        sessionId,
        rendered: true,
        trafficKind,
      });
      expect(decision.record).toBe(false);
      expect(decision.reason).toBe('NON_PRODUCTION_TRAFFIC');
    }
  });
});
