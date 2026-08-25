/**
 * Idempotency integration tests: the guarantees that only a real database can
 * demonstrate — a unique constraint under genuine concurrency, `FOR UPDATE SKIP
 * LOCKED` across two connections, and an import that runs twice.
 *
 * Skips cleanly when `DATABASE_URL` is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announceSkip, HAS_DATABASE, setupDatabase, type Harness, type PgClient } from './harness';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PUBLISHED_FUNNEL = 'ffffffff-0000-4000-8000-000000000005';
const META_ACCOUNT = 'bbbbbbbb-0000-4000-8000-000000000001';

if (!HAS_DATABASE) announceSkip('supabase/tests/idempotency.test.ts');

function submitPayload(attemptId: string) {
  return {
    submission_attempt_id: attemptId,
    published_funnel_id: PUBLISHED_FUNNEL,
    consent_status: 'GRANTED',
    consent_purposes: ['CONTACT', 'AD_MEASUREMENT'],
    answers: [
      { field_key: 'mitarbeiterzahl', field_type: 'SINGLE_SELECT', qualification_class: 'SCORING', value_text: '31-60' },
      { field_key: 'zeithorizont', field_type: 'SINGLE_SELECT', qualification_class: 'DISQUALIFYING', value_text: 'sofort' },
    ],
    pii: {
      key_version: 1,
      iv: Buffer.from('123456789012').toString('base64'),
      auth_tag: Buffer.from('1234567890123456').toString('base64'),
      ciphertext: Buffer.from('geheim').toString('base64'),
      email_hash: 'd'.repeat(64),
    },
    attribution: { channel: 'META_PAID', level: 'REVENUE_LINKED', confidence: 'EXACT' },
    outbox: {
      destination: 'HUBSPOT',
      event_id: `lead:${attemptId}`,
      event_name: 'contact.upsert',
      payload_hash: 'e'.repeat(64),
      payload: { objectType: 'CONTACT' },
    },
  };
}

describe.skipIf(!HAS_DATABASE)('idempotency', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupDatabase('idem');
    const { admin } = harness;

    await admin.query(`insert into public.workspaces (id, slug, name) values ($1,'a','A&M')`, [WORKSPACE]);
    await admin.query(
      `insert into public.campaigns (id, workspace_id, name, slug, state)
       values ('cccccccc-0000-4000-8000-000000000001', $1, 'Kampagne', 'kampagne', 'LIVE')`,
      [WORKSPACE],
    );
    await admin.query(
      `insert into public.consent_versions (id, workspace_id, version, text_de, purposes, privacy_policy_url)
       values ('eeeeeeee-0000-4000-8000-000000000001', $1, 1,
               'Ich willige ein, dass A&M mich kontaktiert.', array['CONTACT','AD_MEASUREMENT'],
               'https://www.am-beratung.de/datenschutz')`,
      [WORKSPACE],
    );
    await admin.query(
      `insert into public.funnels (id, workspace_id, campaign_id, funnel_key, kind, name)
       values ('ffffffff-0000-4000-8000-000000000001', $1, 'cccccccc-0000-4000-8000-000000000001',
               'funnel_1', 'MULTI_STEP_FORM', 'Variante A')`,
      [WORKSPACE],
    );
    await admin.query(
      `insert into public.form_definitions (id, workspace_id, funnel_id, form_key, name)
       values ('ffffffff-0000-4000-8000-000000000002', $1, 'ffffffff-0000-4000-8000-000000000001',
               'qualifizierung', 'Qualifizierung')`,
      [WORKSPACE],
    );
    await admin.query(
      `insert into public.form_versions (id, workspace_id, form_definition_id, version, state, spec,
                                         content_hash, consent_version_id, published_at)
       values ('ffffffff-0000-4000-8000-000000000003', $1, 'ffffffff-0000-4000-8000-000000000002', 1,
               'PUBLISHED', '{"steps":[]}'::jsonb, repeat('b',64),
               'eeeeeeee-0000-4000-8000-000000000001', now())`,
      [WORKSPACE],
    );
    await admin.query(
      `insert into public.funnel_versions (id, workspace_id, funnel_id, campaign_id, version, state, spec,
                                           content_hash, form_version_id, published_at)
       values ('ffffffff-0000-4000-8000-000000000004', $1, 'ffffffff-0000-4000-8000-000000000001',
               'cccccccc-0000-4000-8000-000000000001', 1, 'PUBLISHED', '{"blocks":[]}'::jsonb, repeat('c',64),
               'ffffffff-0000-4000-8000-000000000003', now())`,
      [WORKSPACE],
    );
    await admin.query(
      `insert into public.published_funnels (id, workspace_id, campaign_id, funnel_id, funnel_version_id,
                                             form_version_id, public_slug, is_live, consent_version_id)
       values ($2, $1, 'cccccccc-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001',
               'ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000003',
               'potenzialanalyse', true, 'eeeeeeee-0000-4000-8000-000000000001')`,
      [WORKSPACE, PUBLISHED_FUNNEL],
    );
    await admin.query(
      `insert into public.meta_accounts (id, workspace_id, external_id, name) values ($2, $1, 'act_1', 'A&M')`,
      [WORKSPACE, META_ACCOUNT],
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  it('ten concurrent identical submits produce exactly one submission and one outbox row', async () => {
    const attemptId = '99999999-0000-4000-8000-000000000001';
    const payload = JSON.stringify(submitPayload(attemptId));

    // Ten separate connections, so this is real contention on the unique index
    // rather than ten sequential calls on one session.
    const clients: PgClient[] = await Promise.all(Array.from({ length: 10 }, () => harness.open()));
    try {
      const results = await Promise.all(
        clients.map((client) =>
          client.query<{ result: { submission_id: string; created: boolean; outbox_event_id: string | null } }>(
            'select public.submit_lead_transactional($1::jsonb) as result',
            [payload],
          ),
        ),
      );

      const bodies = results.map((r) => r.rows[0].result);
      expect(bodies.filter((b) => b.created)).toHaveLength(1);
      expect(new Set(bodies.map((b) => b.submission_id)).size).toBe(1);
      expect(new Set(bodies.map((b) => b.outbox_event_id)).size).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }

    const counts = await harness.admin.query<{ submissions: string; outbox: string; snapshots: string; pii: string; answers: string }>(
      `select (select count(*) from public.form_submissions)::text        as submissions,
              (select count(*) from public.outbox_events)::text           as outbox,
              (select count(*) from public.attribution_snapshots)::text   as snapshots,
              (select count(*) from public.submission_pii_encrypted)::text as pii,
              (select count(*) from public.submission_answers_non_pii)::text as answers`,
    );
    expect(counts.rows[0]).toEqual({
      submissions: '1',
      outbox: '1',
      snapshots: '1',
      pii: '1',
      answers: '2',
    });
  });

  it('rejects a second row with the same submission_attempt_id at the constraint level', async () => {
    const { rows } = await harness.admin.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'public.form_submissions'::regclass and contype = 'u'
         and pg_get_constraintdef(oid) like '%submission_attempt_id%'`,
    );
    expect(rows.map((row) => row.conname)).toContain('form_submissions_attempt_unique');
  });

  it('deduplicates the outbox on (destination, dataset_id, event_id)', async () => {
    await harness.admin.query(
      `insert into public.outbox_events (workspace_id, destination, event_id, dataset_id, event_name,
                                         event_time, payload_hash)
       values ($1, 'META_CAPI', 'capi:opp-1:CONVERTED', 'DS-1', 'Purchase', now(), repeat('f',64))`,
      [WORKSPACE],
    );
    await expect(
      harness.admin.query(
        `insert into public.outbox_events (workspace_id, destination, event_id, dataset_id, event_name,
                                           event_time, payload_hash)
         values ($1, 'META_CAPI', 'capi:opp-1:CONVERTED', 'DS-1', 'Purchase', now(), repeat('f',64))`,
        [WORKSPACE],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // A HubSpot row has no dataset id; the empty-string default keeps the key
    // effective where a NULL would silently allow a duplicate.
    await harness.admin.query(
      `insert into public.outbox_events (workspace_id, destination, event_id, event_name, event_time, payload_hash)
       values ($1, 'HUBSPOT', 'lead:dedup', 'contact.upsert', now(), repeat('a',64))`,
      [WORKSPACE],
    );
    await expect(
      harness.admin.query(
        `insert into public.outbox_events (workspace_id, destination, event_id, event_name, event_time, payload_hash)
         values ($1, 'HUBSPOT', 'lead:dedup', 'contact.upsert', now(), repeat('a',64))`,
        [WORKSPACE],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('hands each claimed outbox event to exactly one worker', async () => {
    await harness.admin.query(`delete from public.outbox_events`);
    for (let i = 0; i < 6; i++) {
      await harness.admin.query(
        `insert into public.outbox_events (workspace_id, destination, event_id, event_name, event_time, payload_hash)
         values ($1, 'HUBSPOT', $2, 'contact.upsert', now(), repeat('a',64))`,
        [WORKSPACE, `lead:claim-${i}`],
      );
    }

    const [w1, w2] = await Promise.all([harness.open(), harness.open()]);
    try {
      const [a, b] = await Promise.all([
        w1.query<{ id: string }>(`select id from public.claim_outbox_events(null, 6, 'w1')`),
        w2.query<{ id: string }>(`select id from public.claim_outbox_events(null, 6, 'w2')`),
      ]);
      const ids = [...a.rows, ...b.rows].map((row) => row.id);
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(6);
    } finally {
      await Promise.all([w1.end(), w2.end()]);
    }

    const { rows } = await harness.admin.query<{ status: string; count: string }>(
      `select status, count(*)::text as count from public.outbox_events group by 1`,
    );
    expect(rows).toEqual([{ status: 'PROCESSING', count: '6' }]);
  });

  it('claims a mixed batch across destinations, and honours a filter when given', async () => {
    await harness.admin.query(`delete from public.outbox_events`);
    await harness.admin.query(
      `insert into public.outbox_events (workspace_id, destination, event_id, dataset_id, event_name, event_time, payload_hash)
       values ($1, 'HUBSPOT', 'lead:mix', '', 'contact.upsert', now(), repeat('a',64)),
              ($1, 'META_CAPI', 'capi:mix', 'DS-1', 'Lead', now(), repeat('b',64))`,
      [WORKSPACE],
    );

    const filtered = await harness.admin.query<{ destination: string }>(
      `select destination from public.claim_outbox_events(array['HUBSPOT'], 10, 'w1')`,
    );
    expect(filtered.rows.map((row) => row.destination)).toEqual(['HUBSPOT']);

    const rest = await harness.admin.query<{ destination: string }>(
      `select destination from public.claim_outbox_events(null, 10, 'w1')`,
    );
    expect(rest.rows.map((row) => row.destination)).toEqual(['META_CAPI']);
  });

  it('lets exactly one holder take a job lock, and releases only for the holder', async () => {
    const [a, b] = await Promise.all([harness.open(), harness.open()]);
    try {
      const first = await a.query<{ ok: boolean }>(`select public.try_acquire_job_lock('outbox','w1',60) as ok`);
      const second = await b.query<{ ok: boolean }>(`select public.try_acquire_job_lock('outbox','w2',60) as ok`);
      expect(first.rows[0].ok).toBe(true);
      expect(second.rows[0].ok).toBe(false);

      const wrongHolder = await b.query<{ ok: boolean }>(`select public.release_job_lock('outbox','w2') as ok`);
      expect(wrongHolder.rows[0].ok).toBe(false);

      const holder = await a.query<{ ok: boolean }>(`select public.release_job_lock('outbox','w1') as ok`);
      expect(holder.rows[0].ok).toBe(true);

      const afterRelease = await b.query<{ ok: boolean }>(`select public.try_acquire_job_lock('outbox','w2',60) as ok`);
      expect(afterRelease.rows[0].ok).toBe(true);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('re-running the historical import creates no duplicates', async () => {
    const rows = JSON.stringify([
      {
        workspace_id: WORKSPACE, level: 'ACCOUNT', entity_external_id: 'act_1',
        meta_account_id: META_ACCOUNT, date_start: '2026-01-01', spend_minor: 12_345, impressions: 4_000,
      },
      {
        workspace_id: WORKSPACE, level: 'ACCOUNT', entity_external_id: 'act_1',
        meta_account_id: META_ACCOUNT, date_start: '2026-01-02', spend_minor: 9_876, impressions: 3_100,
      },
    ]);

    const first = await harness.admin.query<{ n: number }>(
      'select public.upsert_meta_insights_daily($1::jsonb) as n',
      [rows],
    );
    expect(first.rows[0].n).toBe(2);

    // The same window again, with corrected numbers: an update, not an append.
    const corrected = JSON.stringify(
      (JSON.parse(rows) as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        spend_minor: (row.spend_minor as number) + 100,
      })),
    );
    const second = await harness.admin.query<{ n: number }>(
      'select public.upsert_meta_insights_daily($1::jsonb) as n',
      [corrected],
    );
    expect(second.rows[0].n).toBe(2);

    const counts = await harness.admin.query<{ rows: string; spend: string }>(
      `select count(*)::text as rows, sum(spend_minor)::text as spend from public.meta_insights_daily`,
    );
    expect(counts.rows[0]).toEqual({ rows: '2', spend: String(12_445 + 9_976) });
  });

  it('records an experiment assignment once and an exposure once per session', async () => {
    await harness.admin.query(
      `insert into public.experiments (id, workspace_id, campaign_id, kind, state, name, hypothesis,
                                       test_variable, primary_metric, thresholds, assignment_salt, started_at)
       values ('a1a1a1a1-0000-4000-8000-000000000001', $1, 'cccccccc-0000-4000-8000-000000000001',
               'FUNNEL_EXPERIMENT', 'RUNNING', 'Test', 'Hypothese mit genug Text', 'Fragenzahl',
               'submission_rate', '{}'::jsonb, 'saltsalt', now())`,
      [WORKSPACE],
    );
    await harness.admin.query(
      `insert into public.experiment_arms (id, workspace_id, experiment_id, key, label, is_control, allocation)
       values ('a2a2a2a2-0000-4000-8000-000000000001', $1, 'a1a1a1a1-0000-4000-8000-000000000001', 'control', 'Kontrolle', true, 0.5),
              ('a2a2a2a2-0000-4000-8000-000000000002', $1, 'a1a1a1a1-0000-4000-8000-000000000001', 'variant_b', 'Variante B', false, 0.5)`,
      [WORKSPACE],
    );

    const visitor = 'd0000001-0000-4000-8000-000000000001';
    const first = await harness.admin.query<{ arm: string }>(
      `select public.assign_experiment_arm('a1a1a1a1-0000-4000-8000-000000000001', $1,
              'a2a2a2a2-0000-4000-8000-000000000001', 0.1) as arm`,
      [visitor],
    );
    const second = await harness.admin.query<{ arm: string }>(
      `select public.assign_experiment_arm('a1a1a1a1-0000-4000-8000-000000000001', $1,
              'a2a2a2a2-0000-4000-8000-000000000002', 0.9) as arm`,
      [visitor],
    );
    expect(second.rows[0].arm).toBe(first.rows[0].arm);

    const session = 'e0000001-0000-4000-8000-000000000001';
    const exposed = await harness.admin.query<{ ok: boolean }>(
      `select public.record_experiment_exposure('a1a1a1a1-0000-4000-8000-000000000001', $1, $2,
              'a2a2a2a2-0000-4000-8000-000000000001') as ok`,
      [visitor, session],
    );
    const repeated = await harness.admin.query<{ ok: boolean }>(
      `select public.record_experiment_exposure('a1a1a1a1-0000-4000-8000-000000000001', $1, $2,
              'a2a2a2a2-0000-4000-8000-000000000001') as ok`,
      [visitor, session],
    );
    expect(exposed.rows[0].ok).toBe(true);
    expect(repeated.rows[0].ok).toBe(false);
  });

  it('overwrites a rollup for the same day and dimension instead of appending', async () => {
    const upsert = (impressions: number, spend: number) =>
      harness.admin.query(
        `insert into public.performance_rollups (workspace_id, day, campaign_id, impressions, spend_minor, source_max_at)
         values ($1, date '2026-08-01', 'cccccccc-0000-4000-8000-000000000001', $2, $3, now())
         on conflict (workspace_id, day, dimension_key) do update
           set impressions = excluded.impressions, spend_minor = excluded.spend_minor, computed_at = now()`,
        [WORKSPACE, impressions, spend],
      );

    await upsert(100, 5_000);
    await upsert(250, 9_000);

    const { rows } = await harness.admin.query<{ count: string; impressions: string }>(
      `select count(*)::text as count, sum(impressions)::text as impressions from public.performance_rollups`,
    );
    expect(rows[0]).toEqual({ count: '1', impressions: '250' });

    // A different dimension combination is a different row, and a NULL dimension
    // does not defeat the key.
    await harness.admin.query(
      `insert into public.performance_rollups (workspace_id, day, campaign_id, creative_version_id)
       values ($1, date '2026-08-01', 'cccccccc-0000-4000-8000-000000000001', null)
       on conflict (workspace_id, day, dimension_key) do nothing`,
      [WORKSPACE],
    );
    const after = await harness.admin.query<{ count: string }>(
      `select count(*)::text as count from public.performance_rollups`,
    );
    expect(after.rows[0].count).toBe('1');
  });

  it('builds an HNSW index over the embedding column when pgvector is available', async () => {
    const capability = await harness.admin.query<{ available: boolean }>(
      `select available from app.schema_capabilities where key = 'embedding_ann_index'`,
    );
    if (!capability.rows[0]?.available) {
      console.warn('[info] no ANN index on this instance — similarity search degrades to an exact scan.');
      return;
    }
    const { rows } = await harness.admin.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'knowledge_embeddings' and indexname = 'knowledge_embeddings_hnsw'`,
    );
    expect(rows[0].indexdef).toContain('hnsw');
    expect(rows[0].indexdef).toContain('vector_cosine_ops');
  });
});
