import { describe, expect, it } from 'vitest';
import {
  attributionSnapshotSchema,
  consentRecordSchema,
  newId,
  outboxEventSchema,
  trackingEventSchema,
  type AttributionSnapshot,
  type OutboxEvent,
  type TrackingEvent,
} from '@am/domain';
import { splitAnswers, type Answers, type MultiStepFormSpec } from '@am/funnel-schema';
import { resolveTouch } from '@am/tracking';
import type { AcceptSubmissionInput, FunnelStore } from '../src/server/ports';

/**
 * One behavioural contract, two implementations.
 *
 * The point of the port is that swapping the fixture store for Postgres changes
 * nothing a route can observe. The only way to hold that claim up is to run the
 * same assertions against both, which is what this file is: everything below is
 * expressed in terms of `FunnelStore` and never reaches for a table, a fixture
 * id or an RPC.
 *
 * The one honest asymmetry is `durable`. The fixture store is per-process and
 * says so; Postgres survives the process. The contract states the difference
 * rather than papering over it, and the Postgres world is the one that has to
 * prove a lead outlives the store that accepted it.
 */

export interface StoreWorld {
  label: string;
  /** A fresh handle onto the same storage — a new process, in effect. */
  open(): Promise<FunnelStore>;
  /** True when a new handle sees what an earlier one wrote. */
  durable: boolean;

  /** The live public slug. */
  slug: string;
  /** Absolute URL a visitor lands on. */
  landingUrl: string;
  funnelId: string;
  funnelVersionId: string;
  formId: string;
  formVersionId: string;
  formSpec: MultiStepFormSpec;

  /** A slug bound to a funnel that also has an unpublished draft version. */
  draftSlug: string;
  draftFunnelVersionId: string;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

export interface VisitorIds {
  visitorId: string;
  sessionId: string;
}

export function newVisitor(): VisitorIds {
  return { visitorId: newId(), sessionId: newId() };
}

/** One valid answer per declared field, derived from the spec rather than typed out. */
export function sampleAnswers(spec: MultiStepFormSpec): Answers {
  const answers: Answers = {};
  for (const [fieldId, field] of Object.entries(spec.fields)) {
    switch (field.type) {
      case 'SINGLE_SELECT':
        answers[fieldId] = field.options[0]?.optionId ?? null;
        break;
      case 'MULTI_SELECT':
        answers[fieldId] = field.options[0] ? [field.options[0].optionId] : [];
        break;
      case 'BOOLEAN':
      case 'CONSENT':
        answers[fieldId] = true;
        break;
      case 'NUMBER':
      case 'RANGE':
        answers[fieldId] = field.min;
        break;
      case 'EMAIL':
        answers[fieldId] = 'max.mustermann@example.de';
        break;
      case 'PHONE':
        answers[fieldId] = '+49 151 23456789';
        break;
      case 'POSTCODE':
        answers[fieldId] = '52062';
        break;
      default:
        answers[fieldId] = 'Testeingabe';
        break;
    }
  }
  return answers;
}

export function touchFor(world: StoreWorld, ids: VisitorIds, occurredAt = new Date()): ReturnType<typeof resolveTouch> {
  return resolveTouch({
    id: newId(),
    visitorId: ids.visitorId,
    sessionId: ids.sessionId,
    occurredAt: occurredAt.toISOString(),
    token: null,
    secret: 'contract-test-secret',
    marketingParams: {
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'potenzialanalyse',
      utm_content: null,
      utm_term: null,
      fbclid: 'IwAR0contracttest',
      fbc: null,
      fbp: null,
      meta_campaign_id: null,
      meta_adset_id: null,
      meta_ad_id: null,
    },
    referrer: null,
    landingUrl: world.landingUrl,
    role: 'FIRST',
    now: occurredAt,
  });
}

export function sampleEvent(
  world: StoreWorld,
  ids: VisitorIds,
  overrides: Partial<TrackingEvent> = {},
): TrackingEvent {
  return trackingEventSchema.parse({
    event_id: newId(),
    event_type: 'form_viewed',
    event_schema_version: 1,
    occurred_at: new Date().toISOString(),
    environment: 'test',
    traffic_kind: 'PRODUCTION',
    visitor_id: ids.visitorId,
    session_id: ids.sessionId,
    funnel_id: world.funnelId,
    funnel_version_id: world.funnelVersionId,
    form_id: world.formId,
    form_version_id: world.formVersionId,
    ...overrides,
  });
}

export interface SubmissionOptions {
  submissionId?: string;
  attemptId?: string;
  formInstanceId: string;
  /** Corrupt the queued dispatch so the write fails inside the unit of work. */
  brokenOutbox?: boolean;
}

export function submissionFor(
  world: StoreWorld,
  ids: VisitorIds,
  options: SubmissionOptions,
): AcceptSubmissionInput {
  const submissionId = options.submissionId ?? newId();
  const occurredAt = new Date().toISOString();
  const spec = world.formSpec;
  const split = splitAnswers(spec, sampleAnswers(spec));

  const consent = consentRecordSchema.parse({
    consent_version_id: spec.consent.consentVersionId,
    consent_version: 1,
    status: 'GRANTED',
    grantedPurposes: spec.consent.purposes,
    occurred_at: occurredAt,
    contextDe: `funnel:${world.funnelVersionId}`,
  });

  const attribution: AttributionSnapshot = attributionSnapshotSchema.parse({
    id: newId(),
    submission_id: submissionId,
    created_at: occurredAt,
    channel: 'META_PAID',
    level: 'LEAD_LINKED',
    /* Not EXACT: the runtime's ladder only grants that with a signed token or a
       click id, and the RPC refuses an unevidenced EXACT outright. */
    confidence: 'HIGH_CONFIDENCE',
    consent_status: 'GRANTED',
    campaign_id: null,
    funnel_id: world.funnelId,
    funnel_version_id: world.funnelVersionId,
    form_id: world.formId,
    form_version_id: world.formVersionId,
    utm_source: 'meta',
    fbclid: 'IwAR0contracttest',
  });

  const hash = 'a'.repeat(64);
  const outbox: OutboxEvent[] = [
    outboxEventSchema.parse({
      event_id: `hubspot:lead:${submissionId}`,
      destination: 'HUBSPOT',
      event_name: 'lead.created',
      event_time: occurredAt,
      payload_hash: hash,
      status: 'PENDING',
      created_at: occurredAt,
      submission_id: submissionId,
    }),
    outboxEventSchema.parse({
      event_id: `capi:lead:${submissionId}`,
      destination: 'META_CAPI',
      event_name: 'Lead',
      event_time: occurredAt,
      payload_hash: 'b'.repeat(64),
      status: 'PENDING',
      created_at: occurredAt,
      submission_id: submissionId,
      dataset_id: 'DS-CONTRACT',
    }),
  ];

  if (options.brokenOutbox) {
    /* Longer than `outbox_events.payload_hash char(64)`. The outbox insert is
       the last statement of the transaction, so everything else — submission,
       answers, PII, status history, attribution snapshot — is already written
       when it fails. Nothing may survive it. */
    outbox[0] = { ...outbox[0], payload_hash: 'c'.repeat(200) } as OutboxEvent;
  }

  return {
    submission: {
      submissionId,
      submissionAttemptId: options.attemptId ?? newId(),
      formInstanceId: options.formInstanceId,
      funnelId: world.funnelId,
      funnelVersionId: world.funnelVersionId,
      formId: world.formId,
      formVersionId: world.formVersionId,
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      environment: 'test',
      trafficKind: 'PRODUCTION',
      state: 'HUBSPOT_PENDING',
      qualification: { outcome: 'QUALIFIED', score: 42, matchedRuleIds: [], reasonCodes: [] },
      resultVariantId: null,
      answersNonPii: split.nonPii,
      answersPii: split.pii,
      answersOperational: { ...split.operational, elapsed_seconds: 45, risk_score: 0 },
      consent,
      riskScore: 0,
      submittedAt: occurredAt,
    },
    attribution,
    outbox,
  };
}

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

async function openInstance(store: FunnelStore, world: StoreWorld, ids: VisitorIds) {
  return store.createFormInstance({
    visitorId: ids.visitorId,
    sessionId: ids.sessionId,
    funnelId: world.funnelId,
    funnelVersionId: world.funnelVersionId,
    formId: world.formId,
    formVersionId: world.formVersionId,
    environment: 'test',
    trafficKind: 'PRODUCTION',
    experimentId: null,
    experimentArmId: null,
    startedAt: new Date().toISOString(),
    touch: null,
  });
}

export function runFunnelStoreContract(world: StoreWorld): void {
  describe(`FunnelStore contract — ${world.label}`, () => {
    it('serves the published version behind a live slug', async () => {
      const store = await world.open();
      const version = await store.loadPublishedFunnelBySlug(world.slug);

      expect(version).not.toBeNull();
      expect(version?.state).toBe('PUBLISHED');
      expect(version?.funnelVersionId).toBe(world.funnelVersionId);
      expect(version?.spec.kind).toBe('MULTI_STEP_FORM');
    });

    it('answers an unknown slug with null rather than an error', async () => {
      const store = await world.open();
      expect(await store.loadPublishedFunnelBySlug('gibt-es-nicht')).toBeNull();
    });

    it('never serves a draft on a public slug', async () => {
      const store = await world.open();

      const draft = await store.loadFunnelVersion(world.draftFunnelVersionId);
      expect(draft?.state).toBe('DRAFT');

      const served = await store.loadPublishedFunnelBySlug(world.draftSlug);
      if (served !== null) {
        expect(served.state).toBe('PUBLISHED');
        expect(served.funnelVersionId).not.toBe(world.draftFunnelVersionId);
      }
    });

    it('loads the published form document a version points at', async () => {
      const store = await world.open();
      const form = await store.loadPublishedFormSpec(world.formVersionId);

      expect(form?.state).toBe('PUBLISHED');
      expect(form?.formVersionId).toBe(world.formVersionId);
      expect(form?.spec.steps.length).toBeGreaterThan(0);
    });

    it('re-opens one form instance per visitor, session and form version', async () => {
      const store = await world.open();
      const ids = newVisitor();

      const first = await openInstance(store, world, ids);
      const second = await openInstance(store, world, ids);
      const other = await openInstance(store, world, newVisitor());

      expect(second.formInstanceId).toBe(first.formInstanceId);
      expect(other.formInstanceId).not.toBe(first.formInstanceId);
    });

    it('carries step progress on the instance', async () => {
      const store = await world.open();
      const ids = newVisitor();
      const instance = await openInstance(store, world, ids);
      const stepId = world.formSpec.steps[0]?.stepId as string;

      await store.recordStepProgress({
        formInstanceId: instance.formInstanceId,
        stepId,
        occurredAt: new Date().toISOString(),
        completed: true,
      });

      const reopened = await openInstance(store, world, ids);
      expect(reopened.formInstanceId).toBe(instance.formInstanceId);
      expect(reopened.lastStepId).toBe(stepId);
    });

    it('appends touches once and returns them oldest first', async () => {
      const store = await world.open();
      const ids = newVisitor();

      const first = touchFor(world, ids, new Date(Date.now() - 60_000));
      const second = { ...touchFor(world, ids), role: 'INFLUENCED' as const };

      await store.recordTouch(first);
      await store.recordTouch(first);
      await store.recordTouch(second);

      const touches = await store.listTouches(ids.visitorId);
      expect(touches.map((touch) => touch.id)).toEqual([first.id, second.id]);
      expect(touches[0]?.utm_source).toBe('meta');
    });

    it('counts only events it had not already stored', async () => {
      const store = await world.open();
      const ids = newVisitor();
      await store.recordTouch(touchFor(world, ids));

      const event = sampleEvent(world, ids);
      expect(await store.recordEvents([event])).toBe(1);
      expect(await store.recordEvents([event])).toBe(0);
    });

    it('accepts a submission and queues its dispatches', async () => {
      const store = await world.open();
      const ids = newVisitor();
      await store.recordTouch(touchFor(world, ids));
      const instance = await openInstance(store, world, ids);

      const input = submissionFor(world, ids, { formInstanceId: instance.formInstanceId });
      const accepted = await store.acceptSubmission(input);

      expect(accepted.created).toBe(true);
      expect(accepted.outboxEventIds.length).toBeGreaterThan(0);

      const queued = await store.listOutboxForSubmission(accepted.submissionId);
      expect(queued.map((row) => row.destination).sort()).toEqual(['HUBSPOT', 'META_CAPI']);
      expect(queued.every((row) => row.status === 'PENDING')).toBe(true);
    });

    it('collapses a repeated attempt onto one submission', async () => {
      const store = await world.open();
      const ids = newVisitor();
      await store.recordTouch(touchFor(world, ids));
      const instance = await openInstance(store, world, ids);
      const attemptId = newId();

      const first = await store.acceptSubmission(
        submissionFor(world, ids, { formInstanceId: instance.formInstanceId, attemptId }),
      );
      const second = await store.acceptSubmission(
        submissionFor(world, ids, { formInstanceId: instance.formInstanceId, attemptId }),
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.submissionId).toBe(first.submissionId);
      expect(second.outboxEventIds).toEqual(first.outboxEventIds);
    });

    it('collapses ten concurrent identical attempts onto one submission', async () => {
      const store = await world.open();
      const ids = newVisitor();
      await store.recordTouch(touchFor(world, ids));
      const instance = await openInstance(store, world, ids);
      const attemptId = newId();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.acceptSubmission(
            submissionFor(world, ids, { formInstanceId: instance.formInstanceId, attemptId }),
          ),
        ),
      );

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.submissionId)).size).toBe(1);

      const queued = await store.listOutboxForSubmission(results[0].submissionId);
      expect(queued).toHaveLength(2);
    });

    it.runIf(world.durable)('keeps an accepted submission after the store is discarded', async () => {
      const accepting = await world.open();
      const ids = newVisitor();
      await accepting.recordTouch(touchFor(world, ids));
      const instance = await openInstance(accepting, world, ids);

      const accepted = await accepting.acceptSubmission(
        submissionFor(world, ids, { formInstanceId: instance.formInstanceId }),
      );

      /* The defect this whole exercise is about: a cold start used to delete
         every lead the funnel had accepted. A second handle is that cold start. */
      const reading = await world.open();
      const queued = await reading.listOutboxForSubmission(accepted.submissionId);
      expect(queued.map((row) => row.destination).sort()).toEqual(['HUBSPOT', 'META_CAPI']);
      expect(await reading.listTouches(ids.visitorId)).toHaveLength(1);
    });
  });
}
