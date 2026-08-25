/**
 * The database's own trust boundary.
 *
 * Every case in this file is an attack that worked against the schema as it
 * stood before `0017_harden_privileges.sql`, reproduced against a real Postgres
 * rather than argued about. They exist because the two layers that were supposed
 * to stop them — the GRANTs in 0012 and the request-path controls in
 * `apps/funnels` — both had the same blind spot: PostgREST exposes every function
 * in `public` as `POST /rest/v1/rpc/<name>`, and PostgreSQL grants EXECUTE on a
 * new function to PUBLIC. `revoke … from anon` removes a grant `anon` never held
 * and leaves the one it inherits.
 *
 * Skips cleanly when `DATABASE_URL` is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announceSkip, HAS_DATABASE, setupDatabase, type Harness, type PgClient } from './harness';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = 'aaaa0000-0000-4000-8000-000000000001';
const CONSENT = 'aaaa0000-0000-4000-8000-000000000002';
const FUNNEL = 'aaaa0000-0000-4000-8000-000000000003';
const FORM_DEF = 'aaaa0000-0000-4000-8000-000000000004';
const FORM_VERSION = 'aaaa0000-0000-4000-8000-000000000005';
const FUNNEL_VERSION = 'aaaa0000-0000-4000-8000-000000000006';
const LIVE_FUNNEL = 'aaaa0000-0000-4000-8000-000000000007';
const RETIRED_FUNNEL = 'aaaa0000-0000-4000-8000-000000000008';
const VISITOR = 'aaaa0000-0000-4000-8000-000000000009';
const SESSION = 'aaaa0000-0000-4000-8000-00000000000a';
/* Never inserted: a privilege check fires before the function body runs, so the
   attack is refused whether or not the opportunity it names is real. */
const OPPORTUNITY = 'aaaa0000-0000-4000-8000-00000000000b';
const FOREIGN_VISITOR = 'aaaa0000-0000-4000-8000-00000000000c';
const EXPERIMENT = 'aaaa0000-0000-4000-8000-00000000000d';
const ARM_A = 'aaaa0000-0000-4000-8000-00000000000e';
const OTHER_EXPERIMENT = 'aaaa0000-0000-4000-8000-00000000000f';
const OTHER_ARM = 'aaaa0000-0000-4000-8000-000000000010';

/** Postgres reports a missing privilege as `insufficient_privilege`. */
const INSUFFICIENT_PRIVILEGE = '42501';

if (!HAS_DATABASE) announceSkip('supabase/tests/privileges.test.ts');

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'bbbb0000-0000-4000-8000-000000000001',
    session_id: SESSION,
    event_type: 'funnel_viewed',
    ...overrides,
  };
}

function submitPayload(overrides: Record<string, unknown> = {}) {
  return {
    submission_attempt_id: 'cccc0000-0000-4000-8000-000000000001',
    published_funnel_id: LIVE_FUNNEL,
    session_id: SESSION,
    visitor_id: VISITOR,
    state: 'ACCEPTED',
    consent_status: 'GRANTED',
    consent_purposes: ['CONTACT'],
    answers: [],
    attribution: { channel: 'META_PAID', level: 'REVENUE_LINKED', confidence: 'EXACT', fbclid: 'IwAR0x' },
    ...overrides,
  };
}

describe.skipIf(!HAS_DATABASE)('database privileges', () => {
  let harness: Harness;

  /**
   * The job runner and the funnel routes hold the service role. `asUser` covers
   * `authenticated` and `asAnon` the public key, but the guarded functions have
   * to be exercised as the one role that may still call them, or the tests would
   * only ever prove that the GRANT is missing.
   */
  const asServiceRole = async <T>(fn: (client: PgClient) => Promise<T>): Promise<T> => {
    const client = await harness.open();
    try {
      await client.query('begin');
      await client.query('set local role service_role');
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  };

  const failure = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
    try {
      await fn();
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return { code: err.code, message: err.message ?? '' };
    }
    throw new Error('Expected the statement to fail, but it succeeded.');
  };

  beforeAll(async () => {
    harness = await setupDatabase('priv');
    const { admin } = harness;

    await admin.query(`insert into public.workspaces (id, slug, name) values ($1,'p','A&M')`, [WORKSPACE]);
    await admin.query(
      `insert into public.campaigns (id, workspace_id, name, slug, state) values ($2,$1,'Kampagne','kampagne','LIVE')`,
      [WORKSPACE, CAMPAIGN],
    );
    await admin.query(
      `insert into public.consent_versions (id, workspace_id, version, text_de, purposes, privacy_policy_url)
       values ($2,$1,1,'Ich willige ein.',array['CONTACT'],'https://www.am-beratung.de/datenschutz')`,
      [WORKSPACE, CONSENT],
    );
    await admin.query(
      `insert into public.funnels (id, workspace_id, campaign_id, funnel_key, kind, name)
       values ($2,$1,$3,'funnel_1','MULTI_STEP_FORM','Variante A')`,
      [WORKSPACE, FUNNEL, CAMPAIGN],
    );
    await admin.query(
      `insert into public.form_definitions (id, workspace_id, funnel_id, form_key, name)
       values ($2,$1,$3,'qualifizierung','Qualifizierung')`,
      [WORKSPACE, FORM_DEF, FUNNEL],
    );
    await admin.query(
      `insert into public.form_versions (id, workspace_id, form_definition_id, version, state, spec,
                                         content_hash, consent_version_id, published_at)
       values ($2,$1,$3,1,'PUBLISHED','{"steps":[]}'::jsonb,repeat('b',64),$4,now())`,
      [WORKSPACE, FORM_VERSION, FORM_DEF, CONSENT],
    );
    await admin.query(
      `insert into public.funnel_versions (id, workspace_id, funnel_id, campaign_id, version, state, spec,
                                           content_hash, form_version_id, published_at)
       values ($2,$1,$3,$4,1,'PUBLISHED','{"blocks":[]}'::jsonb,repeat('c',64),$5,now())`,
      [WORKSPACE, FUNNEL_VERSION, FUNNEL, CAMPAIGN, FORM_VERSION],
    );
    await admin.query(
      `insert into public.published_funnels (id, workspace_id, campaign_id, funnel_id, funnel_version_id,
                                             form_version_id, public_slug, is_live, consent_version_id)
       values ($2,$1,$3,$4,$5,$6,'potenzialanalyse',true,$7)`,
      [WORKSPACE, LIVE_FUNNEL, CAMPAIGN, FUNNEL, FUNNEL_VERSION, FORM_VERSION, CONSENT],
    );
    await admin.query(
      `insert into public.published_funnels (id, workspace_id, campaign_id, funnel_id, funnel_version_id,
                                             form_version_id, public_slug, is_live, unpublished_at, consent_version_id)
       values ($2,$1,$3,$4,$5,$6,'potenzialanalyse-alt',false,now(),$7)`,
      [WORKSPACE, RETIRED_FUNNEL, CAMPAIGN, FUNNEL, FUNNEL_VERSION, FORM_VERSION, CONSENT],
    );
    await admin.query(`insert into public.visitors (id, workspace_id) values ($2,$1)`, [WORKSPACE, VISITOR]);
    await admin.query(
      `insert into public.sessions (id, workspace_id, visitor_id, published_funnel_id, funnel_version_id)
       values ($2,$1,$3,$4,$5)`,
      [WORKSPACE, SESSION, VISITOR, LIVE_FUNNEL, FUNNEL_VERSION],
    );

    /* An outbox row with a lead's contact data in it: the payload the reviewer
       read out through `claim_outbox_events` with the public key. */
    await admin.query(
      `insert into public.outbox_events (workspace_id, destination, event_id, event_name, event_time, payload_hash, payload)
       values ($1,'HUBSPOT','lead:1','contact.upsert',now(),repeat('e',64),
               '{"email":"opfer@example.de","phone":"+4915112345678"}'::jsonb)`,
      [WORKSPACE],
    );

    for (const [experimentId, armId, salt] of [
      [EXPERIMENT, ARM_A, 'intro-copy-2026-01'],
      [OTHER_EXPERIMENT, OTHER_ARM, 'headline-2026-01'],
    ] as const) {
      await admin.query(
        `insert into public.experiments (id, workspace_id, campaign_id, kind, name, hypothesis, test_variable,
                                         primary_metric, thresholds, assignment_salt, state, started_at)
         values ($2,$1,$3,'FUNNEL_EXPERIMENT','Test','Hypothese','INTRO','cpl','{}'::jsonb,$4,'RUNNING',now())`,
        [WORKSPACE, experimentId, CAMPAIGN, salt],
      );
      await admin.query(
        `insert into public.experiment_arms (id, workspace_id, experiment_id, key, label, allocation)
         values ($2,$1,$3,'a','A',1.0)`,
        [WORKSPACE, armId, experimentId],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  describe('what the public key may execute', () => {
    it('grants EXECUTE to PUBLIC on nothing at all', async () => {
      /* The defect in one query. `proacl` entries with an empty grantee are
         PUBLIC's, and every role inherits them — so this was the grant that
         made the four attacks below work, not any explicit one. */
      const { rows } = await harness.admin.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proacl is not null
            and exists (select 1 from unnest(p.proacl) as acl where acl::text like '=%X/%')
          order by 1`,
      );
      expect(rows.map((r) => r.proname)).toEqual([]);
    });

    it('leaves anon exactly one callable function', async () => {
      const { rows } = await harness.admin.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
          order by 1`,
      );
      expect(rows.map((r) => r.proname)).toEqual(['get_published_funnel']);
    });

    it('still lets anon read a live funnel, which is the whole point of the key', async () => {
      const result = await harness.asAnon((client) =>
        client.query<{ spec: unknown }>(`select public.get_published_funnel('potenzialanalyse') as spec`),
      );
      expect(result.rows[0]?.spec).not.toBeNull();
    });
  });

  describe('the attacks the public key could previously run', () => {
    it('cannot claim outbox rows, which both stole every pending lead and stopped its delivery', async () => {
      const error = await failure(() =>
        harness.asAnon((client) =>
          client.query(`select * from public.claim_outbox_events(null::text[], 25, 'attacker')`),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { rows } = await harness.admin.query<{ status: string; attempt_count: number }>(
        `select status, attempt_count from public.outbox_events`,
      );
      expect(rows[0]?.status).toBe('PENDING');
      expect(rows[0]?.attempt_count).toBe(0);
    });

    it('cannot book a fabricated closed-won', async () => {
      const error = await failure(() =>
        harness.asAnon((client) =>
          client.query(
            `select public.record_lead_stage_event(jsonb_build_object(
               'workspace_id',$1::text,'type','CLOSED_WON','opportunity_id',$2::text,
               'amount_minor',50000000,'currency','EUR','source_object','INTERNAL'))`,
            [WORKSPACE, OPPORTUNITY],
          ),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { rows } = await harness.admin.query<{ count: string }>(
        `select count(*)::text as count from public.lead_stage_events`,
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('cannot invent Meta spend and delivery', async () => {
      const error = await failure(() =>
        harness.asAnon((client) =>
          client.query(
            `select public.upsert_meta_insights_daily(jsonb_build_array(jsonb_build_object(
               'workspace_id',$1::text,'level','CAMPAIGN','entity_external_id','999',
               'date_start','2026-08-01','spend_minor',1,'impressions',999999999,'clicks',999999999)))`,
            [WORKSPACE],
          ),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('cannot hold the outbox pump lock and stop every delivery for a day', async () => {
      const error = await failure(() =>
        harness.asAnon((client) =>
          client.query(`select public.try_acquire_job_lock('outbox-pump','attacker',86400)`),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('cannot write events or submit a lead', async () => {
      for (const statement of [
        `select public.record_tracking_events('[]'::jsonb)`,
        `select public.submit_lead_transactional('{}'::jsonb)`,
        `select public.ensure_visitor_session('{}'::jsonb)`,
      ]) {
        const error = await failure(() => harness.asAnon((client) => client.query(statement)));
        expect(error.code, statement).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });

    it('does not hand a signed-in operator the job runner\'s functions either', async () => {
      const { rows } = await harness.admin.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('claim_outbox_events','try_acquire_job_lock','upsert_meta_insights_daily',
                              'rollup_days_needing_recompute','record_lead_stage_event')
            and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('the event collector refuses personal data', () => {
    it('rejects the batch when contact data sits under a forbidden key', async () => {
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.record_tracking_events($1::jsonb)`, [
            JSON.stringify([
              event({
                landing_url: 'https://x.de/?email=opfer@example.de',
                metadata: { email: 'opfer@example.de', phone: '+4915112345678' },
              }),
            ]),
          ]),
        ),
      );
      expect(error.message).toContain('personenbezogene Daten');
    });

    it('rejects contact data hiding under a key that looks innocent', async () => {
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.record_tracking_events($1::jsonb)`, [
            JSON.stringify([event({ metadata: { hinweis: 'Rückruf unter 0151 23456789' } })]),
          ]),
        ),
      );
      expect(error.message).toContain('personenbezogene Daten');
    });

    it('names the offending paths and never the values', async () => {
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.record_tracking_events($1::jsonb)`, [
            JSON.stringify([event({ metadata: { email: 'opfer@example.de' } })]),
          ]),
        ),
      );
      expect(error.message).not.toContain('opfer@example.de');
    });

    it('does not fire on the identifiers every event legitimately carries', async () => {
      /* `content_name` contains `name`, a Meta object id is an eighteen-digit
         run, and a uuid contains a thirteen-digit one. A guard that rejects
         valid events is a guard someone switches off. */
      const inserted = await asServiceRole((client) =>
        client.query<{ n: number }>(`select public.record_tracking_events($1::jsonb) as n`, [
          JSON.stringify([
            event({
              metadata: {
                content_name: 'Potenzialanalyse',
                campaign_name: 'Q3',
                meta_campaign_id: '120210000000000000',
                step_index: 3,
                elapsed_ms: 8867200,
              },
            }),
          ]),
        ]),
      );
      expect(inserted.rows[0]?.n).toBe(1);
    });

    it('takes traffic kind, environment and visitor from the session, not from the caller', async () => {
      const rows = await asServiceRole(async (client) => {
        await client.query(
          `update public.sessions set traffic_kind='BOT', environment='preview' where id=$1`,
          [SESSION],
        );
        await client.query(`select public.record_tracking_events($1::jsonb)`, [
          JSON.stringify([
            event({ traffic_kind: 'PRODUCTION', environment: 'production', visitor_id: FOREIGN_VISITOR }),
          ]),
        ]);
        const result = await client.query<{ traffic_kind: string; environment: string; visitor_id: string }>(
          `select traffic_kind, environment, visitor_id from public.events where id=$1`,
          [event().event_id],
        );
        return result.rows;
      });

      expect(rows[0]).toMatchObject({
        traffic_kind: 'BOT',
        environment: 'preview',
        visitor_id: VISITOR,
      });
    });
  });

  describe('the lead submit refuses what it cannot stand behind', () => {
    it('refuses a funnel that is no longer live', async () => {
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.submit_lead_transactional($1::jsonb)`, [
            JSON.stringify(submitPayload({ published_funnel_id: RETIRED_FUNNEL })),
          ]),
        ),
      );
      expect(error.message).toContain('nicht veröffentlichter Funnel');
    });

    it('refuses a submission with no session behind it', async () => {
      /* This is what stops a direct RPC call manufacturing a lead that never
         visited a funnel — and with it the honeypot, the timing check and the
         consent gate, all of which live in the request path it skipped. */
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.submit_lead_transactional($1::jsonb)`, [
            JSON.stringify(submitPayload({ session_id: null })),
          ]),
        ),
      );
      expect(error.message).toContain('keine bekannte Sitzung');
    });

    it('refuses an EXACT attribution with no evidence behind it', async () => {
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.submit_lead_transactional($1::jsonb)`, [
            JSON.stringify(
              submitPayload({
                attribution: { channel: 'META_PAID', confidence: 'EXACT', meta_campaign_id: '23851234567890123' },
              }),
            ),
          ]),
        ),
      );
      expect(error.message).toContain('EXACT');
    });

    it('accepts an EXACT backed by a click id, and takes the traffic kind from the session', async () => {
      const rows = await asServiceRole(async (client) => {
        await client.query(
          `update public.sessions set traffic_kind='INTERNAL' where id=$1`,
          [SESSION],
        );
        await client.query(`select public.submit_lead_transactional($1::jsonb)`, [
          JSON.stringify(submitPayload({ traffic_kind: 'PRODUCTION' })),
        ]);
        const result = await client.query<{ state: string; traffic_kind: string; confidence: string }>(
          `select s.state, s.traffic_kind, a.confidence
             from public.form_submissions s
             join public.attribution_snapshots a on a.submission_id = s.id`,
        );
        return result.rows;
      });

      expect(rows[0]).toMatchObject({
        state: 'ACCEPTED',
        traffic_kind: 'INTERNAL',
        confidence: 'EXACT',
      });
    });
  });

  describe('the live slug binding is a published version', () => {
    it('cannot be re-pointed at another destination', async () => {
      const error = await failure(() =>
        harness.admin.query(`update public.published_funnels set redirect_url=$1 where is_live`, [
          'https://evil.example/phish',
        ]),
      );
      expect(error.message).toContain('unveränderlich');
    });

    it('cannot have its funnel version swapped underneath historical submissions', async () => {
      const error = await failure(() =>
        harness.admin.query(`update public.published_funnels set funnel_version_id=gen_random_uuid() where is_live`),
      );
      expect(error.message).toContain('unveränderlich');
    });

    it('cannot be deleted', async () => {
      const error = await failure(() =>
        harness.admin.query(`delete from public.published_funnels where is_live`),
      );
      expect(error.message).toContain('kann nicht gelöscht werden');
    });

    it('can still be retired, which is what is_live and unpublished_at are for', async () => {
      const client = await harness.open();
      try {
        await client.query('begin');
        const result = await client.query(
          `update public.published_funnels set is_live=false, unpublished_at=now() where id=$1`,
          [LIVE_FUNNEL],
        );
        expect(result.rowCount).toBe(1);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });

  describe('experiment assignment', () => {
    it('refuses an arm that belongs to a different experiment', async () => {
      const error = await failure(() =>
        asServiceRole((client) =>
          client.query(`select public.assign_experiment_arm($1,$2,$3,0.5)`, [
            EXPERIMENT,
            VISITOR,
            OTHER_ARM,
          ]),
        ),
      );
      expect(error.message).toContain('gehört nicht zu Experiment');
    });

    it('refuses an experiment that is no longer routing traffic', async () => {
      const error = await failure(() =>
        asServiceRole(async (client) => {
          await client.query(
            `update public.experiments set state='CONCLUDED', concluded_at=now() where id=$1`,
            [EXPERIMENT],
          );
          return client.query(`select public.assign_experiment_arm($1,$2,$3,0.5)`, [EXPERIMENT, VISITOR, ARM_A]);
        }),
      );
      expect(error.message).toContain('verteilt keinen Traffic');
    });

    it('assigns an arm of its own running experiment', async () => {
      const result = await asServiceRole((client) =>
        client.query<{ arm_id: string }>(`select public.assign_experiment_arm($1,$2,$3,0.5) as arm_id`, [
          EXPERIMENT,
          VISITOR,
          ARM_A,
        ]),
      );
      expect(result.rows[0]?.arm_id).toBe(ARM_A);
    });
  });
});
