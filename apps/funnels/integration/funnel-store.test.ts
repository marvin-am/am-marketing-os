import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createSupabaseDatabase,
  generateEncryptionKey,
  type AmDatabase,
} from '@am/db';
import { newId } from '@am/domain';
import { POTENZIALANALYSE_FORM_SPEC } from '@am/funnel-schema';
import {
  announceSkip,
  HAS_DATABASE,
  setupDatabase,
  type Harness,
  type PgClient,
} from '../../../supabase/tests/harness';
import { createDatabaseStore } from '../src/server/db-store';
import { createFixtureStore, FIXTURE_FUNNEL_IDS, FIXTURE_SLUGS } from '../src/server/fixture-store';
import { collectEvents } from '../src/server/collect-service';
import { resetPublishedCache } from '../src/server/published';
import { submitLead } from '../src/server/submit-service';
import type { FunnelStore } from '../src/server/ports';
import { createPgRestClient } from './pg-rest-client';
import {
  newVisitor,
  runFunnelStoreContract,
  sampleAnswers,
  sampleEvent,
  submissionFor,
  touchFor,
  type StoreWorld,
} from './funnel-store-contract';

/**
 * `published.ts` reaches for the module singleton rather than taking a store, so
 * driving the real submit service against Postgres means pointing that singleton
 * at the database store. Nothing about the service is stubbed — only which
 * storage `getFunnelStore()` hands back, which is the one decision this whole
 * exercise is about.
 */
const singleton = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../src/server/store', () => ({
  getFunnelStore: () => {
    if (!singleton.current) throw new Error('Kein Store gesetzt.');
    return singleton.current;
  },
  getFixtureStore: () => {
    throw new Error('Der Fixture-Store steht in diesem Test nicht zur Verfügung.');
  },
  getFunnelStoreMode: () => 'supabase',
  resetFunnelStore: () => {
    singleton.current = null;
  },
}));

/**
 * The funnel store against both of its implementations.
 *
 * `runFunnelStoreContract` is the shared half: identical assertions, expressed
 * only in terms of the port. Everything below it is what only Postgres can
 * demonstrate — a transaction that rolls back, a unique index under genuine
 * contention across separate connections, and the SQL PII guard that a route
 * test cannot reach.
 *
 * Skips cleanly with `DATABASE_URL` unset; the fixture half always runs, so a
 * machine with no database still exercises the contract.
 */

/* PII is only ever stored as ciphertext, so the store cannot accept a lead
   without a key. Generated per run — nothing here reads a real one. */
process.env.APP_ENCRYPTION_KEY ??= generateEncryptionKey();

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = 'cccccccc-1111-4111-8111-000000000001';
const FUNNEL = 'ffffffff-1111-4111-8111-000000000001';
const FUNNEL_VERSION = 'ffffffff-1111-4111-8111-000000000002';
const DRAFT_FUNNEL = 'ffffffff-1111-4111-8111-000000000003';
const DRAFT_FUNNEL_VERSION = 'ffffffff-1111-4111-8111-000000000004';
const PUBLISHED_FUNNEL = 'ffffffff-1111-4111-8111-000000000005';
const DRAFT_PUBLISHED_FUNNEL = 'ffffffff-1111-4111-8111-000000000006';

const SPEC = POTENZIALANALYSE_FORM_SPEC;
const SLUG = 'potenzialanalyse';
const DRAFT_SLUG = 'entwurf-nicht-live';

if (!HAS_DATABASE) announceSkip('apps/funnels/integration/funnel-store.test.ts');

/* -------------------------------------------------------------------------- */
/* Fixture world                                                               */
/* -------------------------------------------------------------------------- */

const fixture = createFixtureStore();

runFunnelStoreContract({
  label: 'fixture store (in memory)',
  open: async () => fixture,
  /* The honest statement of what the fixture store is: one process, and every
     restart is an empty database. It is a demo surface, never a deployment. */
  durable: false,
  slug: FIXTURE_SLUGS.form,
  landingUrl: `https://funnel.test/f/${FIXTURE_SLUGS.form}`,
  funnelId: FIXTURE_FUNNEL_IDS.formFunnelId,
  funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionA,
  formId: SPEC.formId,
  formVersionId: SPEC.formVersionId,
  formSpec: SPEC,
  draftSlug: FIXTURE_SLUGS.landing,
  draftFunnelVersionId: FIXTURE_FUNNEL_IDS.draftFunnelVersionId,
});

/* -------------------------------------------------------------------------- */
/* Postgres world                                                              */
/* -------------------------------------------------------------------------- */

let harness: Harness;
let pool: PgClient[] = [];
let cursor = 0;
let database: AmDatabase;

/** Round-robins over real connections, so ten parallel submits genuinely contend. */
const exec = async <Row = Record<string, unknown>>(text: string, values?: unknown[]) => {
  const client = pool[cursor % pool.length] as PgClient;
  cursor += 1;
  return client.query<Row>(text, values);
};

async function seed(admin: PgClient): Promise<void> {
  await admin.query(`insert into public.workspaces (id, slug, name) values ($1,'am','A&M')`, [
    WORKSPACE,
  ]);
  await admin.query(
    `insert into public.campaigns (id, workspace_id, name, slug, state)
     values ($1, $2, 'Potenzialanalyse', 'potenzialanalyse', 'LIVE')`,
    [CAMPAIGN, WORKSPACE],
  );
  await admin.query(
    `insert into public.consent_versions (id, workspace_id, version, text_de, purposes, privacy_policy_url)
     values ($1, $2, 1, $3, $4, $5)`,
    [
      SPEC.consent.consentVersionId,
      WORKSPACE,
      SPEC.consent.textDe,
      SPEC.consent.purposes,
      SPEC.consent.privacyPolicyUrl,
    ],
  );
  await admin.query(
    `insert into public.funnels (id, workspace_id, campaign_id, funnel_key, kind, name)
     values ($1, $2, $3, 'funnel_1', 'MULTI_STEP_FORM', 'Potenzialanalyse')`,
    [FUNNEL, WORKSPACE, CAMPAIGN],
  );
  await admin.query(
    `insert into public.form_definitions (id, workspace_id, funnel_id, form_key, name)
     values ($1, $2, $3, 'qualifizierung', 'Qualifizierung')`,
    [SPEC.formId, WORKSPACE, FUNNEL],
  );
  await admin.query(
    `insert into public.form_versions (id, workspace_id, form_definition_id, version, state, spec,
                                       content_hash, consent_version_id, published_at)
     values ($1, $2, $3, 1, 'PUBLISHED', $4::jsonb, repeat('b',64), $5, now())`,
    [SPEC.formVersionId, WORKSPACE, SPEC.formId, JSON.stringify(SPEC), SPEC.consent.consentVersionId],
  );
  await admin.query(
    `insert into public.funnel_versions (id, workspace_id, funnel_id, campaign_id, version, state, spec,
                                         content_hash, form_version_id, published_at)
     values ($1, $2, $3, $4, 1, 'PUBLISHED', $5::jsonb, repeat('c',64), $6, now())`,
    [FUNNEL_VERSION, WORKSPACE, FUNNEL, CAMPAIGN, JSON.stringify(SPEC), SPEC.formVersionId],
  );
  await admin.query(
    `insert into public.published_funnels (id, workspace_id, campaign_id, funnel_id, funnel_version_id,
                                           form_version_id, public_slug, is_live, consent_version_id)
     values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
    [
      PUBLISHED_FUNNEL,
      WORKSPACE,
      CAMPAIGN,
      FUNNEL,
      FUNNEL_VERSION,
      SPEC.formVersionId,
      SLUG,
      SPEC.consent.consentVersionId,
    ],
  );

  /* A live binding that points at an unpublished version. The schema permits
     it — `published_funnels` checks `is_live`, not the version's state — so the
     runtime has to be the thing that refuses to serve it. */
  await admin.query(
    `insert into public.funnels (id, workspace_id, campaign_id, funnel_key, kind, name)
     values ($1, $2, $3, 'funnel_2', 'MULTI_STEP_FORM', 'Entwurf')`,
    [DRAFT_FUNNEL, WORKSPACE, CAMPAIGN],
  );
  await admin.query(
    `insert into public.funnel_versions (id, workspace_id, funnel_id, campaign_id, version, state, spec,
                                         content_hash, form_version_id)
     values ($1, $2, $3, $4, 1, 'DRAFT', $5::jsonb, repeat('d',64), $6)`,
    [DRAFT_FUNNEL_VERSION, WORKSPACE, DRAFT_FUNNEL, CAMPAIGN, JSON.stringify(SPEC), SPEC.formVersionId],
  );
  await admin.query(
    `insert into public.published_funnels (id, workspace_id, campaign_id, funnel_id, funnel_version_id,
                                           form_version_id, public_slug, is_live, consent_version_id)
     values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
    [
      DRAFT_PUBLISHED_FUNNEL,
      WORKSPACE,
      CAMPAIGN,
      DRAFT_FUNNEL,
      DRAFT_FUNNEL_VERSION,
      SPEC.formVersionId,
      DRAFT_SLUG,
      SPEC.consent.consentVersionId,
    ],
  );
}

const postgresWorld: StoreWorld = {
  label: 'Postgres',
  /* A fresh store every time: new caches, nothing carried over — the same state
     a serverless cold start begins from. */
  open: async () => createDatabaseStore(database),
  durable: true,
  slug: SLUG,
  landingUrl: `https://funnel.test/f/${SLUG}`,
  funnelId: FUNNEL,
  funnelVersionId: FUNNEL_VERSION,
  formId: SPEC.formId,
  formVersionId: SPEC.formVersionId,
  formSpec: SPEC,
  draftSlug: DRAFT_SLUG,
  draftFunnelVersionId: DRAFT_FUNNEL_VERSION,
};

async function count(table: string, where = '', values: unknown[] = []): Promise<number> {
  const { rows } = await harness.admin.query<{ n: string }>(
    `select count(*)::text as n from public.${table} ${where}`,
    values,
  );
  return Number(rows[0]?.n ?? '0');
}

async function openStore(): Promise<FunnelStore> {
  return postgresWorld.open();
}

describe.skipIf(!HAS_DATABASE)('funnel store against Postgres', () => {
  beforeAll(async () => {
    harness = await setupDatabase('funnel_store');
    await seed(harness.admin);
    /* Twelve connections so ten parallel submits are real contention on the
       unique index rather than ten queued statements on one session. */
    pool = await Promise.all(Array.from({ length: 12 }, () => harness.open()));
    database = createSupabaseDatabase(createPgRestClient(exec));
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pool.map((client) => client.end().catch(() => undefined)));
    await harness?.teardown();
  });

  runFunnelStoreContract(postgresWorld);

  it('reports the storage it actually uses', async () => {
    const store = createDatabaseStore(database);
    expect(store.mode).toBe('supabase');
  });

  it('writes a real form instance rather than an id nobody stored', async () => {
    const store = await openStore();
    const ids = newVisitor();
    await store.recordTouch(touchFor(postgresWorld, ids));
    const instance = await store.createFormInstance({
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      funnelId: FUNNEL,
      funnelVersionId: FUNNEL_VERSION,
      formId: SPEC.formId,
      formVersionId: SPEC.formVersionId,
      environment: 'test',
      trafficKind: 'PRODUCTION',
      experimentId: null,
      experimentArmId: null,
      startedAt: new Date().toISOString(),
      touch: null,
    });

    expect(await count('form_instances', 'where id = $1', [instance.formInstanceId])).toBe(1);
    const rows = await harness.admin.query<{ workspace_id: string; published_funnel_id: string; step_count: number }>(
      `select workspace_id, published_funnel_id, step_count from public.form_instances where id = $1`,
      [instance.formInstanceId],
    );
    /* The workspace is derived from the published funnel, never supplied. */
    expect(rows.rows[0]?.workspace_id).toBe(WORKSPACE);
    expect(rows.rows[0]?.published_funnel_id).toBe(PUBLISHED_FUNNEL);
    expect(rows.rows[0]?.step_count).toBe(SPEC.steps.length);
  });

  it('refuses a draft the live binding points at, which the RPC itself does not', async () => {
    const store = await openStore();

    /* The RPC hands the draft's bundle over — it filters on `is_live` only. */
    const bundle = await database.funnels.getPublishedBySlug(DRAFT_SLUG);
    expect(bundle?.funnel_version_id).toBe(DRAFT_FUNNEL_VERSION);

    expect(await store.loadPublishedFunnelBySlug(DRAFT_SLUG)).toBeNull();
  });

  it('leaves nothing behind when the unit of work fails', async () => {
    const store = await openStore();
    const ids = newVisitor();
    await store.recordTouch(touchFor(postgresWorld, ids));
    const instance = await store.createFormInstance({
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      funnelId: FUNNEL,
      funnelVersionId: FUNNEL_VERSION,
      formId: SPEC.formId,
      formVersionId: SPEC.formVersionId,
      environment: 'test',
      trafficKind: 'PRODUCTION',
      experimentId: null,
      experimentArmId: null,
      startedAt: new Date().toISOString(),
      touch: null,
    });

    const attemptId = newId();
    const before = {
      submissions: await count('form_submissions'),
      snapshots: await count('attribution_snapshots'),
      answers: await count('submission_answers_non_pii'),
      pii: await count('submission_pii_encrypted'),
      history: await count('submission_status_history'),
      outbox: await count('outbox_events'),
    };

    /* 22001 is `string_data_right_truncation` — the over-long payload hash, and
       therefore proof the write reached the outbox insert rather than falling
       over somewhere harmless on the way. */
    await expect(
      store.acceptSubmission(
        submissionFor(postgresWorld, ids, {
          formInstanceId: instance.formInstanceId,
          attemptId,
          brokenOutbox: true,
        }),
      ),
    ).rejects.toMatchObject({ details: { pgCode: '22001' } });

    /* The outbox insert is the last statement in the function. Everything before
       it had already been written when it failed, so equal counts are the
       transaction rolling back, not the statements never running. */
    expect(await count('form_submissions', 'where submission_attempt_id = $1', [attemptId])).toBe(0);
    expect({
      submissions: await count('form_submissions'),
      snapshots: await count('attribution_snapshots'),
      answers: await count('submission_answers_non_pii'),
      pii: await count('submission_pii_encrypted'),
      history: await count('submission_status_history'),
      outbox: await count('outbox_events'),
    }).toEqual(before);
  });

  it('writes one submission, one snapshot and one row per destination for ten concurrent attempts', async () => {
    const store = await openStore();
    const ids = newVisitor();
    await store.recordTouch(touchFor(postgresWorld, ids));
    const instance = await store.createFormInstance({
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      funnelId: FUNNEL,
      funnelVersionId: FUNNEL_VERSION,
      formId: SPEC.formId,
      formVersionId: SPEC.formVersionId,
      environment: 'test',
      trafficKind: 'PRODUCTION',
      experimentId: null,
      experimentArmId: null,
      startedAt: new Date().toISOString(),
      touch: null,
    });

    const attemptId = newId();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.acceptSubmission(
          submissionFor(postgresWorld, ids, { formInstanceId: instance.formInstanceId, attemptId }),
        ),
      ),
    );

    const submissionId = results[0].submissionId;
    expect(results.every((result) => result.submissionId === submissionId)).toBe(true);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    expect(await count('form_submissions', 'where submission_attempt_id = $1', [attemptId])).toBe(1);
    expect(await count('attribution_snapshots', 'where submission_id = $1', [submissionId])).toBe(1);
    expect(await count('submission_pii_encrypted', 'where submission_id = $1', [submissionId])).toBe(1);
    expect(
      await count('outbox_events', `where submission_id = $1 and destination = 'HUBSPOT'`, [submissionId]),
    ).toBe(1);
    expect(
      await count('outbox_events', `where submission_id = $1 and destination = 'META_CAPI'`, [submissionId]),
    ).toBe(1);

    /* The lead's e-mail is in the encrypted record and nowhere a query can
       reach it (AGENTS rule 7). */
    expect(
      await count(
        'submission_answers_non_pii',
        `where submission_id = $1 and value_text like '%@%'`,
        [submissionId],
      ),
    ).toBe(0);
  });

  it('stores the attribution snapshot the submission was frozen with', async () => {
    const store = await openStore();
    const ids = newVisitor();
    await store.recordTouch(touchFor(postgresWorld, ids));
    const instance = await store.createFormInstance({
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      funnelId: FUNNEL,
      funnelVersionId: FUNNEL_VERSION,
      formId: SPEC.formId,
      formVersionId: SPEC.formVersionId,
      environment: 'test',
      trafficKind: 'PRODUCTION',
      experimentId: null,
      experimentArmId: null,
      startedAt: new Date().toISOString(),
      touch: null,
    });

    const accepted = await store.acceptSubmission(
      submissionFor(postgresWorld, ids, { formInstanceId: instance.formInstanceId }),
    );

    const { rows } = await harness.admin.query<{
      channel: string;
      confidence: string;
      fbclid: string | null;
      funnel_version_id: string;
    }>(
      `select channel, confidence, fbclid, funnel_version_id
         from public.attribution_snapshots where submission_id = $1`,
      [accepted.submissionId],
    );
    expect(rows[0]).toMatchObject({
      channel: 'META_PAID',
      confidence: 'HIGH_CONFIDENCE',
      fbclid: 'IwAR0contracttest',
      funnel_version_id: FUNNEL_VERSION,
    });
  });

  it('accepts a lead through the whole submit service, not only the store', async () => {
    const store = await openStore();
    singleton.current = store;
    resetPublishedCache();

    const ids = newVisitor();
    await store.recordTouch(touchFor(postgresWorld, ids));
    const instance = await store.createFormInstance({
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      funnelId: FUNNEL,
      funnelVersionId: FUNNEL_VERSION,
      formId: SPEC.formId,
      formVersionId: SPEC.formVersionId,
      environment: 'test',
      trafficKind: 'PRODUCTION',
      experimentId: null,
      experimentArmId: null,
      startedAt: new Date().toISOString(),
      touch: null,
    });

    const attemptId = newId();
    const request = {
      funnelVersionId: FUNNEL_VERSION,
      formVersionId: SPEC.formVersionId,
      formInstanceId: instance.formInstanceId,
      submissionAttemptId: attemptId,
      answers: sampleAnswers(SPEC),
      elapsedSeconds: 120,
      stepsVisited: SPEC.steps.length,
    };
    const context = {
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      environment: 'test' as const,
      trafficKind: 'PRODUCTION' as const,
      originOk: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      clientIpAddress: null,
      eventSourceUrl: postgresWorld.landingUrl,
    };

    const outcome = await submitLead(request, context, { store, pixelId: null });
    expect(outcome.status).toBe(200);
    const body = outcome.body as { ok: true; submissionId: string; duplicate: boolean };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);

    /* The lead is a row, its dispatches are rows, and its contact details exist
       only as ciphertext. */
    expect(await count('form_submissions', 'where submission_attempt_id = $1', [attemptId])).toBe(1);
    expect(await count('outbox_events', 'where submission_id = $1', [body.submissionId])).toBe(2);
    expect(await count('submission_pii_encrypted', 'where submission_id = $1', [body.submissionId])).toBe(1);
    expect(
      await count('submission_answers_non_pii', `where submission_id = $1 and value_text like '%@%'`, [
        body.submissionId,
      ]),
    ).toBe(0);

    /* The same attempt again is the visitor pressing the button twice. */
    const replay = await submitLead(request, context, { store, pixelId: null });
    const replayBody = replay.body as { ok: true; submissionId: string; duplicate: boolean };
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.submissionId).toBe(body.submissionId);
    expect(await count('form_submissions', 'where submission_attempt_id = $1', [attemptId])).toBe(1);

    singleton.current = null;
  });

  describe('no personal data reaches events', () => {
    it('is refused by the collector before anything is stored', async () => {
      const store = await openStore();
      const ids = newVisitor();
      await store.recordTouch(touchFor(postgresWorld, ids));
      const before = await count('events');

      const outcome = await collectEvents(
        {
          events: [
            {
              ...sampleEvent(postgresWorld, ids),
              metadata: { hinweis: 'max.mustermann@example.de' },
            },
          ],
        },
        {
          environment: 'test',
          trafficKind: 'PRODUCTION',
          visitorId: ids.visitorId,
          sessionId: ids.sessionId,
          trusted: null,
          rateLimitKeys: ['contract-test'],
        },
        { store },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(422);
      expect(await count('events')).toBe(before);
    });

    it('is refused by the database even when the collector is bypassed', async () => {
      const store = await openStore();
      const ids = newVisitor();
      await store.recordTouch(touchFor(postgresWorld, ids));
      const before = await count('events');

      const smuggled = {
        ...sampleEvent(postgresWorld, ids),
        metadata: { hinweis: 'max.mustermann@example.de' },
      };

      /* AM006 is the guard in `public.record_tracking_events`, not a type error
         or a missing session — the batch is refused as a unit for carrying
         personal data. */
      await expect(store.recordEvents([smuggled])).rejects.toMatchObject({
        details: { pgCode: 'AM006' },
      });
      expect(await count('events')).toBe(before);
    });
  });
});
