import { beforeEach, describe, expect, it } from 'vitest';

process.env.LOG_LEVEL = 'error';

import {
  buildDefaultMultiStepForm,
  POTENZIALANALYSE_FORM_INPUT,
  POTENZIALANALYSE_FORM_SPEC,
  QUALIFIED_ANSWERS,
  type Answers,
} from '@am/funnel-schema';
import { externalLink, internalLink } from '@am/funnel-schema';
import type { OutboxEvent } from '@am/domain';
import { FIXTURE_FUNNEL_IDS } from './fixture-store';
import { resetPublishedCache } from './published';
import { resolveLinkTarget, resolveRedirect } from './redirect';
import { resolveFormTargets } from './spec-targets';
import { getFixtureStore, resetFunnelStore } from './store';
import { submitLead, type SubmitContext, type SubmitSuccessBody } from './submit-service';

/**
 * The submit path, end to end against the in-memory store.
 *
 * These are the tests that have to hold before a single euro of ad spend runs
 * through this funnel: a retried submit must not create a second lead, a
 * hand-crafted POST must not get past validation, and a HubSpot outage must
 * leave the lead accepted with its sync queued.
 */

const HUMAN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const FORM_INSTANCE_ID = '9c2f1e00-1111-4000-8000-000000000001';
const VISITOR_ID = '9c2f1e00-2222-4000-8000-000000000002';
const SESSION_ID = '9c2f1e00-3333-4000-8000-000000000003';
const PIXEL_ID = '111122223333444';

function context(overrides: Partial<SubmitContext> = {}): SubmitContext {
  return {
    visitorId: VISITOR_ID,
    sessionId: SESSION_ID,
    environment: 'test',
    trafficKind: 'PRODUCTION',
    originOk: true,
    userAgent: HUMAN_UA,
    clientIpAddress: '203.0.113.7',
    eventSourceUrl: 'https://funnel.example.com/f/potenzialanalyse',
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionA,
    formVersionId: POTENZIALANALYSE_FORM_SPEC.formVersionId,
    formInstanceId: FORM_INSTANCE_ID,
    submissionAttemptId: '9c2f1e00-4444-4000-8000-000000000004',
    answers: { ...QUALIFIED_ANSWERS } as Answers,
    elapsedSeconds: 42,
    stepsVisited: 7,
    ...overrides,
  };
}

function deps(extra: Record<string, unknown> = {}) {
  return { store: getFixtureStore(), pixelId: PIXEL_ID, ...extra };
}

function expectSuccess(outcome: Awaited<ReturnType<typeof submitLead>>): SubmitSuccessBody {
  expect(outcome.status).toBe(200);
  const body = outcome.body as SubmitSuccessBody;
  expect(body.ok).toBe(true);
  return body;
}

beforeEach(() => {
  resetFunnelStore();
  resetPublishedCache();
});

describe('idempotency', () => {
  it('collapses ten concurrent submits of one attempt id onto a single submission', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => submitLead(request(), context(), deps())),
    );

    const bodies = outcomes.map(expectSuccess);
    const ids = new Set(bodies.map((body) => body.submissionId));
    expect(ids.size).toBe(1);
    expect(bodies.filter((body) => body.duplicate === false)).toHaveLength(1);
    expect(bodies.filter((body) => body.duplicate === true)).toHaveLength(9);

    expect(getFixtureStore().snapshot().submissions).toHaveLength(1);
  });

  it('returns the same submission id for a sequential retry of the same attempt', async () => {
    const first = expectSuccess(await submitLead(request(), context(), deps()));
    const retry = expectSuccess(await submitLead(request(), context(), deps()));

    expect(retry.submissionId).toBe(first.submissionId);
    expect(retry.duplicate).toBe(true);
    expect(getFixtureStore().snapshot().submissions).toHaveLength(1);
  });

  it('sends the pixel and the queued server event under one id', async () => {
    /*
     * This is the pair Meta deduplicates on, and getting it wrong does not
     * fail — it silently counts every lead twice.
     *
     * Both ids used to be seeded from a locally generated submission id while
     * the store returns the id the database minted. On the fixture store those
     * agree; on Postgres they never do, so the pixel was rebuilt with the
     * stored id while the already-queued CAPI row kept the original. Seeding
     * both from the submission attempt removes the divergence rather than
     * patching one side of it.
     */
    const body = expectSuccess(await submitLead(request(), context(), deps()));
    const outbox = await getFixtureStore().listOutboxForSubmission(body.submissionId);
    const capi = outbox.find((row) => row.destination === 'META_CAPI');

    expect(capi).toBeDefined();
    expect(body.pixel?.eventID).toBe(capi?.event_id);
  });

  it('keeps the browser pixel on the same id across a retry', async () => {
    const first = expectSuccess(await submitLead(request(), context(), deps()));
    const retry = expectSuccess(await submitLead(request(), context(), deps()));

    /* Pixel and server event deduplicate on (event_name, event_id). A retry that
       minted a fresh id would double-count the lead at Meta. */
    expect(retry.pixel?.eventID).toBe(first.pixel?.eventID);
    expect(retry.pixel?.eventName).toBe('Lead');
  });

  it('treats a different attempt id as a different lead', async () => {
    await submitLead(request(), context(), deps());
    const second = expectSuccess(
      await submitLead(
        request({ submissionAttemptId: '9c2f1e00-4444-4000-8000-00000000dead' }),
        context(),
        deps(),
      ),
    );

    expect(second.duplicate).toBe(false);
    expect(getFixtureStore().snapshot().submissions).toHaveLength(2);
  });
});

describe('server-side validation', () => {
  it('rejects an answer the spec does not offer', async () => {
    const outcome = await submitLead(
      request({ answers: { ...QUALIFIED_ANSWERS, rolle: 'vorstandsvorsitz_erfunden' } }),
      context(),
      deps(),
    );

    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    const errors = (outcome.body as { fieldErrors?: { fieldId: string; code: string }[] })
      .fieldErrors;
    expect(errors?.some((error) => error.code === 'UNKNOWN_OPTION')).toBe(true);
    expect(getFixtureStore().snapshot().submissions).toHaveLength(0);
  });

  it('rejects a payload that skipped a required step', async () => {
    const answers = { ...QUALIFIED_ANSWERS };
    delete answers.plz;

    const outcome = await submitLead(request({ answers }), context(), deps());
    expect(outcome.status).toBe(422);
    const errors = (outcome.body as { fieldErrors?: { fieldId: string }[] }).fieldErrors;
    expect(errors?.map((error) => error.fieldId)).toContain('plz');
  });

  it('refuses a submission without consent, however the client got there', async () => {
    const outcome = await submitLead(
      request({ answers: { ...QUALIFIED_ANSWERS, einwilligung: false } }),
      context(),
      deps(),
    );

    expect(outcome.status).toBe(422);
    const errors = (outcome.body as { fieldErrors?: { code: string }[] }).fieldErrors;
    expect(errors?.some((error) => error.code === 'CONSENT_REQUIRED')).toBe(true);
  });

  it('refuses a form version the addressed funnel version does not serve', async () => {
    const outcome = await submitLead(
      request({ funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionB }),
      context(),
      deps(),
    );

    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses an unpublished funnel version', async () => {
    const outcome = await submitLead(
      request({ funnelVersionId: FIXTURE_FUNNEL_IDS.draftFunnelVersionId }),
      context(),
      deps(),
    );

    expect(outcome.status).toBe(404);
  });
});

describe('spam and bot defence', () => {
  it('rejects a filled honeypot', async () => {
    const honeypot = POTENZIALANALYSE_FORM_SPEC.submit.honeypotFieldId as string;
    const outcome = await submitLead(
      request({ answers: { ...QUALIFIED_ANSWERS, [honeypot]: 'https://spam.example' } }),
      context(),
      deps(),
    );

    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({ code: 'SPAM_REJECTED' });
    expect(getFixtureStore().snapshot().submissions).toHaveLength(0);
  });

  it('rejects a submission faster than the form author allows', async () => {
    const outcome = await submitLead(request({ elapsedSeconds: 1 }), context(), deps());
    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({ code: 'SPAM_REJECTED' });
  });

  it('rejects a cross-origin submission', async () => {
    const outcome = await submitLead(request(), context({ originOk: false }), deps());
    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({ code: 'SPAM_REJECTED' });
  });

  it('does not reject a real lead on a single soft signal', async () => {
    /* A mislabelled user agent is an indicator, not proof. Rejecting on it alone
       would throw away real leads from corporate proxies. */
    const outcome = await submitLead(
      request(),
      context({ userAgent: 'CorporateProxy/2.0 (compatible; internal gateway build 4471)' }),
      deps(),
    );
    const body = expectSuccess(outcome);
    expect(body.duplicate).toBe(false);
  });

  it('records the risk score with the accepted submission', async () => {
    await submitLead(request(), context(), deps());
    const [submission] = getFixtureStore().snapshot().submissions;
    expect(submission?.riskScore).toBe(0);
  });
});

describe('acceptance, outbox and CAPI', () => {
  it('writes the HubSpot and Meta CAPI rows in the same transaction as the lead', async () => {
    const body = expectSuccess(await submitLead(request(), context(), deps()));
    const outbox = await getFixtureStore().listOutboxForSubmission(body.submissionId);

    expect(outbox.map((row) => row.destination).sort()).toEqual(['HUBSPOT', 'META_CAPI']);
    expect(outbox.every((row) => row.status === 'PENDING')).toBe(true);
    expect(outbox.every((row) => row.submission_id === body.submissionId)).toBe(true);
  });

  it('accepts the lead and leaves the sync queued when HubSpot is down', async () => {
    let attempted = 0;
    const outcome = await submitLead(
      request(),
      context(),
      deps({
        dispatchHubspot: async (_row: OutboxEvent) => {
          attempted += 1;
          throw new Error('HubSpot 503');
        },
      }),
    );

    const body = expectSuccess(outcome);
    expect(attempted).toBe(1);

    const outbox = await getFixtureStore().listOutboxForSubmission(body.submissionId);
    const hubspot = outbox.find((row) => row.destination === 'HUBSPOT');
    expect(hubspot).toBeDefined();
    expect(hubspot?.status).toBe('PENDING');
    expect(getFixtureStore().snapshot().submissions).toHaveLength(1);
  });

  it('shares one event id between the browser pixel and the queued server event', async () => {
    const body = expectSuccess(await submitLead(request(), context(), deps()));
    const outbox = await getFixtureStore().listOutboxForSubmission(body.submissionId);
    const capi = outbox.find((row) => row.destination === 'META_CAPI');

    expect(body.pixel).not.toBeNull();
    expect(capi?.event_id).toBe(body.pixel?.eventID);
    expect(capi?.dataset_id).toBe(PIXEL_ID);
  });

  it('still queues the lead when no Meta pixel is configured', async () => {
    const body = expectSuccess(
      await submitLead(request(), context(), deps({ pixelId: null })),
    );

    expect(body.pixel).toBeNull();
    expect(body.capiQueued).toBe(true);
    expect(body.capiConfigured).toBe(false);

    const outbox = await getFixtureStore().listOutboxForSubmission(body.submissionId);
    const capi = outbox.find((row) => row.destination === 'META_CAPI');
    expect(capi?.dataset_id).toBeNull();
  });

  it('splits contact data away from the qualification answers', async () => {
    const body = expectSuccess(await submitLead(request(), context(), deps()));
    const [submission] = getFixtureStore().snapshot().submissions;

    expect(submission?.submissionId).toBe(body.submissionId);
    expect(Object.keys(submission?.answersPii ?? {}).sort()).toEqual([
      'email',
      'firma',
      'nachname',
      'telefon',
      'vorname',
    ]);
    expect(Object.keys(submission?.answersNonPii ?? {})).toContain('werbebudget');
    expect(submission?.answersNonPii.email).toBeUndefined();
  });

  it('freezes an attribution snapshot against the submission', async () => {
    const body = expectSuccess(await submitLead(request(), context(), deps()));
    const [snapshot] = getFixtureStore().snapshot().attribution;

    expect(snapshot?.submission_id).toBe(body.submissionId);
    /* No touch, no signal: DIRECT/UNKNOWN, never the campaign that happened to
       be running. */
    expect(snapshot?.channel).toBe('DIRECT');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('never echoes contact data back to the browser', async () => {
    const outcome = await submitLead(request(), context(), deps());
    const serialized = JSON.stringify(outcome.body);

    expect(serialized).not.toContain('k.bergmann');
    expect(serialized).not.toContain('Bergmann');
    expect(serialized).not.toContain('987654');
  });
});

describe('redirect allowlist', () => {
  it('allows an external target only when its host is on the allowlist', () => {
    const target = { target: externalLink('https://termin.example.com/am'), delaySeconds: 3 };

    expect(resolveRedirect(target, ['example.com'])).toEqual({
      href: 'https://termin.example.com/am',
      delaySeconds: 3,
      external: true,
    });
    expect(resolveRedirect(target, ['andere.de'])).toBeNull();
  });

  it('denies everything when the allowlist is empty', () => {
    expect(
      resolveRedirect({ target: externalLink('https://termin.example.com'), delaySeconds: 0 }, []),
    ).toBeNull();
  });

  it('keeps in-app paths working without an allowlist entry', () => {
    const resolved = resolveLinkTarget(internalLink('/datenschutz'), []);
    expect(resolved).toMatchObject({ allowed: true, external: false, href: '/datenschutz' });
  });

  it('refuses a protocol-relative href smuggled into an internal target', () => {
    const resolved = resolveLinkTarget(
      { href: '//evil.example.com', external: false, requiresAllowlist: false, newTab: false },
      ['example.com'],
    );
    expect(resolved?.allowed).toBe(false);
    expect(resolved?.blockedReasonDe).toBeTruthy();
  });

  it('blocks a booking link on a published spec whose host is not allow-listed', () => {
    const spec = buildDefaultMultiStepForm({
      ...POTENZIALANALYSE_FORM_INPUT,
      resultKind: 'BOOKING',
      booking: { href: 'https://kalender.fremd.example/am' },
    });

    const blocked = resolveFormTargets(spec, ['example.com']);
    expect(blocked.variants.termin?.booking?.allowed).toBe(false);

    const allowed = resolveFormTargets(spec, ['fremd.example']);
    expect(allowed.variants.termin?.booking?.allowed).toBe(true);
  });
});
