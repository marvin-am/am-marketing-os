import { beforeEach, describe, expect, it } from 'vitest';

process.env.LOG_LEVEL = 'error';

import { createExposureRegistry, createMemoryDedupeStore, createRateLimiter } from '@am/tracking';
import { collectEvents, type CollectContext } from './collect-service';
import { checkOrigin } from './origin';
import { getFixtureStore, resetFunnelStore } from './store';

/**
 * The collector is the only path from a funnel page to stored data, and the only
 * one an attacker can reach without a form. These tests pin the two properties
 * that make it safe: no personal data survives it, and the client cannot claim
 * an identity or an exposure it did not earn.
 */

const VISITOR_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
const OTHER_VISITOR_ID = 'a1b2c3d4-0000-4000-8000-0000000000ff';
const EXPERIMENT_ID = 'a1b2c3d4-0000-4000-8000-000000000003';
const ARM_ID = 'a1b2c3d4-0000-4000-8000-000000000004';
const FORM_INSTANCE_ID = 'a1b2c3d4-0000-4000-8000-000000000005';

function context(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    environment: 'test',
    trafficKind: 'PRODUCTION',
    visitorId: VISITOR_ID,
    sessionId: SESSION_ID,
    trusted: null,
    rateLimitKey: 'v:test',
    ...overrides,
  };
}

function deps(extra: Record<string, unknown> = {}) {
  return {
    store: getFixtureStore(),
    dedupe: createMemoryDedupeStore(),
    exposures: createExposureRegistry(),
    ...extra,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'form_step_viewed',
    event_schema_version: 1,
    occurred_at: '2026-08-25T10:00:00.000Z',
    visitor_id: VISITOR_ID,
    session_id: SESSION_ID,
    step_id: 'frage_1',
    form_instance_id: FORM_INSTANCE_ID,
    metadata: { step_index: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  resetFunnelStore();
});

describe('PII guard', () => {
  it('rejects the whole batch when any event carries a forbidden key', async () => {
    const outcome = await collectEvents(
      { events: [event(), event({ metadata: { email: 'katrin@example.de' } })] },
      context(),
      deps(),
    );

    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    /* Not sanitised and stored — a "cleaned" event teaches the emitting code
       that sending PII is survivable. Nothing at all is written. */
    expect(getFixtureStore().snapshot().events).toHaveLength(0);
  });

  it('rejects a value that merely looks like contact data', async () => {
    const outcome = await collectEvents(
      { events: [event({ metadata: { hinweis: 'schreiben Sie an k.bergmann@example.de' } })] },
      context(),
      deps(),
    );

    expect(outcome.status).toBe(422);
    expect((outcome.body as { violations?: string[] }).violations?.length).toBeGreaterThan(0);
  });

  it('rejects a phone number hidden in a metadata value', async () => {
    const outcome = await collectEvents(
      { events: [event({ metadata: { note: '+49 2571 987654' } })] },
      context(),
      deps(),
    );

    expect(outcome.status).toBe(422);
  });

  it('accepts a clean batch', async () => {
    const outcome = await collectEvents(
      { events: [event(), event({ event_type: 'form_step_completed' })] },
      context(),
      deps(),
    );

    expect(outcome.status).toBe(200);
    expect(outcome.ok && outcome.body.accepted).toBe(2);
  });
});

describe('server-owned identity', () => {
  it('overwrites a visitor id the client tried to claim', async () => {
    await collectEvents(
      { events: [event({ visitor_id: OTHER_VISITOR_ID, session_id: OTHER_VISITOR_ID })] },
      context(),
      deps(),
    );

    const [stored] = getFixtureStore().snapshot().events;
    expect(stored?.visitor_id).toBe(VISITOR_ID);
    expect(stored?.session_id).toBe(SESSION_ID);
  });

  it('lets ids from a verified launch token win over the payload', async () => {
    const trustedCampaign = 'a1b2c3d4-0000-4000-8000-00000000c001';
    await collectEvents(
      { events: [event({ campaign_id: 'a1b2c3d4-0000-4000-8000-00000000dead' })] },
      context({ trusted: { campaign_id: trustedCampaign } }),
      deps(),
    );

    const [stored] = getFixtureStore().snapshot().events;
    expect(stored?.campaign_id).toBe(trustedCampaign);
  });

  it('reports a malformed batch rather than throwing', async () => {
    const outcome = await collectEvents({ nichts: true }, context(), deps());
    expect(outcome.status).toBe(400);
  });
});

describe('experiment exposure', () => {
  const exposure = () =>
    event({
      event_type: 'experiment_exposed',
      experiment_id: EXPERIMENT_ID,
      experiment_arm_id: ARM_ID,
      step_id: null,
    });

  it('records one exposure per experiment, visitor and session', async () => {
    const shared = deps();
    await collectEvents({ events: [exposure()] }, context(), shared);
    await collectEvents({ events: [exposure()] }, context(), shared);

    const exposures = getFixtureStore()
      .snapshot()
      .events.filter((stored) => stored.event_type === 'experiment_exposed');
    expect(exposures).toHaveLength(1);
  });

  it('keeps non-production exposures out of the store entirely', async () => {
    const outcome = await collectEvents(
      { events: [exposure()] },
      context({ trafficKind: 'PREVIEW' }),
      deps(),
    );

    expect(outcome.ok && outcome.body.suppressedExposures).toBe(1);
    expect(getFixtureStore().snapshot().events).toHaveLength(0);
  });
});

describe('rate limiting and progress', () => {
  it('reports a rate-limited batch instead of silently dropping it', async () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0 });
    const outcome = await collectEvents(
      { events: [event(), event({ step_id: 'frage_2' })] },
      context(),
      deps({ limiter }),
    );

    expect(outcome.ok && outcome.body.accepted).toBe(1);
    expect(outcome.ok && outcome.body.rejected.map((entry) => entry.code)).toEqual([
      'RATE_LIMITED',
    ]);
  });

  it('derives step progress from the events rather than a second endpoint', async () => {
    await collectEvents(
      {
        events: [
          event({ step_id: 'frage_1' }),
          event({ event_type: 'form_step_completed', step_id: 'frage_1' }),
        ],
      },
      context(),
      deps(),
    );

    const progress = getFixtureStore().snapshot().stepProgress;
    expect(progress).toHaveLength(2);
    expect(progress.at(-1)).toMatchObject({ stepId: 'frage_1', completed: true });
  });
});

describe('origin check', () => {
  it('accepts a same-origin request', () => {
    expect(
      checkOrigin({ origin: 'https://funnel.example.com', host: 'funnel.example.com' }).ok,
    ).toBe(true);
  });

  it('accepts a request whose proxy rewrote the port', () => {
    expect(
      checkOrigin({ origin: 'http://localhost:3001', host: 'localhost:3000' }).ok,
    ).toBe(true);
  });

  it('refuses a foreign origin', () => {
    const result = checkOrigin({ origin: 'https://evil.example', host: 'funnel.example.com' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('FOREIGN_ORIGIN');
  });

  it('refuses a request with no origin at all unless explicitly allowed', () => {
    expect(checkOrigin({ host: 'funnel.example.com' }).reason).toBe('MISSING_ORIGIN');
    expect(checkOrigin({ host: 'funnel.example.com', allowMissing: true }).ok).toBe(true);
  });

  it('falls back to the referer when a privacy tool stripped the origin', () => {
    expect(
      checkOrigin({
        referer: 'https://funnel.example.com/f/potenzialanalyse',
        host: 'funnel.example.com',
      }).ok,
    ).toBe(true);
  });
});
