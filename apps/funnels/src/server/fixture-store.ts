import { newId, nowIso, type OutboxEvent, type Touchpoint, type TrackingEvent } from '@am/domain';
import {
  buildDefaultMultiStepForm,
  FIXTURE_IDS,
  HYBRID_FUNNEL_SPEC,
  LANDING_PAGE_SPEC,
  POTENZIALANALYSE_FORM_INPUT,
  POTENZIALANALYSE_FORM_SPEC,
  type MultiStepFormSpec,
} from '@am/funnel-schema';
import type {
  AcceptSubmissionInput,
  AcceptSubmissionResult,
  CreateFormInstanceInput,
  FormInstanceRecord,
  FunnelStore,
  FunnelVersionRecord,
  PublishedFormRecord,
  RecordStepProgressInput,
  SubmissionDraft,
} from './ports';

/**
 * In-memory implementation of `FunnelStore`.
 *
 * `@am/db` is not wired into this app yet, so the runtime ships with a store
 * seeded from `@am/funnel-schema`'s fixtures. That is a deliberate choice over
 * stubbing the routes: every code path below — publication state, idempotency,
 * the transactional outbox — is real and is exercised by the tests, so swapping
 * in the Postgres implementation is a one-line change in `store.ts` rather than
 * a rewrite of the routes.
 *
 * Nothing here pretends to be a database: the store is per-process, it is lost
 * on restart, and `mode` reports `'memory'` so no surface can claim otherwise.
 */

/* -------------------------------------------------------------------------- */
/* Seed data                                                                   */
/* -------------------------------------------------------------------------- */

/** Stable fixture identifiers. Fixture-local, never external ids. */
export const FIXTURE_FUNNEL_IDS = {
  formFunnelId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1001',
  formFunnelVersionA: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1002',
  formFunnelVersionB: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1003',
  formVersionB: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1004',
  landingFunnelId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1005',
  landingFunnelVersionId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1006',
  hybridFunnelId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1007',
  hybridFunnelVersionId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1008',
  draftFunnelVersionId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1009',
  experimentId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1010',
  armControlId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1011',
  armVariantId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1012',
} as const;

export const FIXTURE_SLUGS = {
  form: 'potenzialanalyse',
  landing: LANDING_PAGE_SPEC.slug,
  hybrid: HYBRID_FUNNEL_SPEC.slug,
} as const;

const SEED_PUBLISHED_AT = '2026-01-15T09:00:00.000Z';

/**
 * The B arm of the funnel experiment: the same five questions, a different
 * promise in the intro. A copy-level variant is what a funnel experiment
 * actually tests, and keeping both arms real means assignment can be verified
 * end to end instead of against a placeholder.
 */
const POTENZIALANALYSE_FORM_SPEC_B: MultiStepFormSpec = buildDefaultMultiStepForm({
  ...POTENZIALANALYSE_FORM_INPUT,
  formVersionId: FIXTURE_FUNNEL_IDS.formVersionB,
  intro: {
    ...POTENZIALANALYSE_FORM_INPUT.intro,
    headline: 'In zwei Minuten wissen Sie, ob sich Meta-Werbung für Sie rechnet',
    primaryCtaLabel: 'Jetzt prüfen',
  },
});

function funnelExperiment() {
  return {
    experimentId: FIXTURE_FUNNEL_IDS.experimentId,
    state: 'RUNNING' as const,
    assignmentSalt: 'potenzialanalyse-intro-2026-01',
    arms: [
      {
        armId: FIXTURE_FUNNEL_IDS.armControlId,
        allocation: 0.5,
        funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionA,
      },
      {
        armId: FIXTURE_FUNNEL_IDS.armVariantId,
        allocation: 0.5,
        funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionB,
      },
    ],
  };
}

function seedFunnelVersions(): FunnelVersionRecord[] {
  const experiment = funnelExperiment();
  return [
    {
      funnelId: FIXTURE_FUNNEL_IDS.formFunnelId,
      funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionA,
      slug: FIXTURE_SLUGS.form,
      kind: 'MULTI_STEP_FORM',
      state: 'PUBLISHED',
      publishedAt: SEED_PUBLISHED_AT,
      spec: POTENZIALANALYSE_FORM_SPEC,
      formVersionId: POTENZIALANALYSE_FORM_SPEC.formVersionId,
      experiment,
    },
    {
      funnelId: FIXTURE_FUNNEL_IDS.formFunnelId,
      funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionB,
      slug: FIXTURE_SLUGS.form,
      kind: 'MULTI_STEP_FORM',
      state: 'PUBLISHED',
      publishedAt: SEED_PUBLISHED_AT,
      spec: POTENZIALANALYSE_FORM_SPEC_B,
      formVersionId: POTENZIALANALYSE_FORM_SPEC_B.formVersionId,
      experiment,
    },
    {
      funnelId: FIXTURE_FUNNEL_IDS.landingFunnelId,
      funnelVersionId: FIXTURE_FUNNEL_IDS.landingFunnelVersionId,
      slug: FIXTURE_SLUGS.landing,
      kind: 'LANDING_PAGE',
      state: 'PUBLISHED',
      publishedAt: SEED_PUBLISHED_AT,
      spec: LANDING_PAGE_SPEC,
      formVersionId: null,
      experiment: null,
    },
    {
      funnelId: FIXTURE_FUNNEL_IDS.hybridFunnelId,
      funnelVersionId: FIXTURE_FUNNEL_IDS.hybridFunnelVersionId,
      slug: FIXTURE_SLUGS.hybrid,
      kind: 'HYBRID',
      state: 'PUBLISHED',
      publishedAt: SEED_PUBLISHED_AT,
      spec: HYBRID_FUNNEL_SPEC,
      formVersionId: HYBRID_FUNNEL_SPEC.form.formVersionId,
      experiment: null,
    },
    {
      /* An unpublished draft of the landing page. It exists so the test suite
         can prove a draft never reaches `/f/<slug>` — the rule is worth nothing
         if nothing ever tries. */
      funnelId: FIXTURE_FUNNEL_IDS.landingFunnelId,
      funnelVersionId: FIXTURE_FUNNEL_IDS.draftFunnelVersionId,
      slug: FIXTURE_SLUGS.landing,
      kind: 'LANDING_PAGE',
      state: 'DRAFT',
      publishedAt: null,
      spec: {
        ...LANDING_PAGE_SPEC,
        pageVersionId: FIXTURE_FUNNEL_IDS.draftFunnelVersionId,
        title: 'ENTWURF — nicht veröffentlicht',
      },
      formVersionId: null,
      experiment: null,
    },
  ];
}

function seedFormVersions(): PublishedFormRecord[] {
  return [
    {
      formId: FIXTURE_IDS.formId,
      formVersionId: POTENZIALANALYSE_FORM_SPEC.formVersionId,
      state: 'PUBLISHED',
      publishedAt: SEED_PUBLISHED_AT,
      spec: POTENZIALANALYSE_FORM_SPEC,
    },
    {
      formId: FIXTURE_IDS.formId,
      formVersionId: POTENZIALANALYSE_FORM_SPEC_B.formVersionId,
      state: 'PUBLISHED',
      publishedAt: SEED_PUBLISHED_AT,
      spec: POTENZIALANALYSE_FORM_SPEC_B,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface StoredSubmission extends SubmissionDraft {
  acceptedAt: string;
}

export interface FixtureFunnelStore extends FunnelStore {
  readonly mode: 'memory';
  /** Test seam: everything the runtime has written so far. */
  snapshot(): {
    submissions: StoredSubmission[];
    attribution: AcceptSubmissionInput['attribution'][];
    outbox: OutboxEvent[];
    events: TrackingEvent[];
    formInstances: FormInstanceRecord[];
    stepProgress: RecordStepProgressInput[];
  };
  /** Test seam: forget everything written, keep the seed. */
  reset(): void;
}

export function createFixtureStore(): FixtureFunnelStore {
  const funnelVersions = new Map<string, FunnelVersionRecord>();
  const formVersions = new Map<string, PublishedFormRecord>();

  for (const version of seedFunnelVersions()) funnelVersions.set(version.funnelVersionId, version);
  for (const form of seedFormVersions()) formVersions.set(form.formVersionId, form);

  let formInstances = new Map<string, FormInstanceRecord>();
  let stepProgress: RecordStepProgressInput[] = [];
  let touches = new Map<string, Touchpoint[]>();
  let submissionsById = new Map<string, StoredSubmission>();
  let submissionIdByAttempt = new Map<string, string>();
  let attribution = new Map<string, AcceptSubmissionInput['attribution']>();
  let outboxById = new Map<string, OutboxEvent>();
  let outboxBySubmission = new Map<string, string[]>();
  let events = new Map<string, TrackingEvent>();

  /**
   * In-flight commits keyed by attempt id. JavaScript's single-threaded event
   * loop makes the check-and-set below atomic, which is what collapses ten
   * concurrent submits onto one row — the same guarantee a unique index on
   * `submissions.submission_attempt_id` gives the Postgres implementation.
   */
  const inFlight = new Map<string, Promise<AcceptSubmissionResult>>();

  function instanceKey(input: CreateFormInstanceInput): string {
    return `${input.visitorId}:${input.sessionId}:${input.formVersionId}`;
  }

  function commit(input: AcceptSubmissionInput): AcceptSubmissionResult {
    const { submission } = input;

    /* Build the whole write set first, then publish it in one synchronous
       block: a rejected outbox row must not leave a half-written submission. */
    const stored: StoredSubmission = { ...submission, acceptedAt: nowIso() };
    const outboxIds = input.outbox.map((row) => row.event_id);

    submissionsById.set(submission.submissionId, stored);
    submissionIdByAttempt.set(submission.submissionAttemptId, submission.submissionId);
    attribution.set(submission.submissionId, input.attribution);
    for (const row of input.outbox) {
      /* Deterministic dispatch ids: a replay collapses onto the same row rather
         than duplicating the provider event. */
      if (!outboxById.has(row.event_id)) outboxById.set(row.event_id, row);
    }
    outboxBySubmission.set(submission.submissionId, outboxIds);

    const instance = formInstances.get(submission.formInstanceId);
    if (instance) {
      formInstances.set(submission.formInstanceId, {
        ...instance,
        submitted: true,
        lastActivityAt: stored.acceptedAt,
      });
    }

    return { submissionId: submission.submissionId, created: true, outboxEventIds: outboxIds };
  }

  return {
    mode: 'memory',

    async loadPublishedFunnelBySlug(slug) {
      for (const version of funnelVersions.values()) {
        if (version.slug === slug && version.state === 'PUBLISHED') return version;
      }
      return null;
    },

    async loadFunnelVersion(funnelVersionId) {
      return funnelVersions.get(funnelVersionId) ?? null;
    },

    async loadPublishedFormSpec(formVersionId) {
      const record = formVersions.get(formVersionId);
      if (!record || record.state !== 'PUBLISHED') return null;
      return record;
    },

    async createFormInstance(input) {
      const key = instanceKey(input);
      const existing = formInstances.get(key);
      if (input.touch) await this.recordTouch(input.touch);
      if (existing) {
        const refreshed: FormInstanceRecord = { ...existing, lastActivityAt: input.startedAt };
        formInstances.set(key, refreshed);
        formInstances.set(existing.formInstanceId, refreshed);
        return refreshed;
      }

      const record: FormInstanceRecord = {
        formInstanceId: newId(),
        visitorId: input.visitorId,
        sessionId: input.sessionId,
        funnelVersionId: input.funnelVersionId,
        formVersionId: input.formVersionId,
        experimentId: input.experimentId,
        experimentArmId: input.experimentArmId,
        environment: input.environment,
        trafficKind: input.trafficKind,
        startedAt: input.startedAt,
        lastActivityAt: input.startedAt,
        lastStepId: null,
        submitted: false,
      };
      formInstances.set(key, record);
      formInstances.set(record.formInstanceId, record);
      return record;
    },

    async recordStepProgress(input) {
      stepProgress.push(input);
      const instance = formInstances.get(input.formInstanceId);
      if (!instance) return;
      const updated: FormInstanceRecord = {
        ...instance,
        lastStepId: input.stepId,
        lastActivityAt: input.occurredAt,
      };
      formInstances.set(input.formInstanceId, updated);
      formInstances.set(
        `${instance.visitorId}:${instance.sessionId}:${instance.formVersionId}`,
        updated,
      );
    },

    async recordTouch(touch) {
      const list = touches.get(touch.visitor_id) ?? [];
      if (list.some((entry) => entry.id === touch.id)) return;
      list.push(touch);
      touches.set(touch.visitor_id, list);
    },

    async listTouches(visitorId) {
      return [...(touches.get(visitorId) ?? [])].sort(
        (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
      );
    },

    async acceptSubmission(input) {
      const attemptId = input.submission.submissionAttemptId;

      const settled = submissionIdByAttempt.get(attemptId);
      if (settled) {
        return {
          submissionId: settled,
          created: false,
          outboxEventIds: outboxBySubmission.get(settled) ?? [],
        };
      }

      const pending = inFlight.get(attemptId);
      if (pending) {
        const result = await pending;
        return { ...result, created: false };
      }

      const promise = (async () => commit(input))();
      inFlight.set(attemptId, promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(attemptId);
      }
    },

    async recordEvents(batch) {
      let written = 0;
      for (const event of batch) {
        if (events.has(event.event_id)) continue;
        events.set(event.event_id, event);
        written += 1;
      }
      return written;
    },

    async listOutboxForSubmission(submissionId) {
      return (outboxBySubmission.get(submissionId) ?? [])
        .map((id) => outboxById.get(id))
        .filter((row): row is OutboxEvent => row !== undefined);
    },

    snapshot() {
      return {
        submissions: [...submissionsById.values()],
        attribution: [...attribution.values()],
        outbox: [...outboxById.values()],
        events: [...events.values()],
        formInstances: [...new Set(formInstances.values())],
        stepProgress: [...stepProgress],
      };
    },

    reset() {
      formInstances = new Map();
      stepProgress = [];
      touches = new Map();
      submissionsById = new Map();
      submissionIdByAttempt = new Map();
      attribution = new Map();
      outboxById = new Map();
      outboxBySubmission = new Map();
      events = new Map();
      inFlight.clear();
    },
  };
}
