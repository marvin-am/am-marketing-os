/**
 * Schema-level integration tests: migrations, privileges, RLS, immutability.
 *
 * Skips cleanly when `DATABASE_URL` is unset (AGENTS.md). When it is set, a
 * throw-away database is created, every migration is applied into it, and it is
 * dropped afterwards — the database the URL points at is never modified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  announceSkip,
  expectSqlState,
  HAS_DATABASE,
  migrationFiles,
  seedAuthUsers,
  setupDatabase,
  type Harness,
} from './harness';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'aaaaaaaa-0000-4000-8000-000000000002';

if (!HAS_DATABASE) announceSkip('supabase/tests/schema.test.ts');

describe.skipIf(!HAS_DATABASE)('schema', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupDatabase('schema');
    const { admin } = harness;

    await admin.query(
      `insert into public.workspaces (id, slug, name) values ($1,'a','A&M'), ($2,'b','Fremd')`,
      [WORKSPACE_A, WORKSPACE_B],
    );
    // Supabase (and the local shim) own auth.users, and profiles.id references
    // it. Seed the identity first so the FK is exercised rather than bypassed.
    await seedAuthUsers(admin, [
      { id: USER_A, email: 'a@am-beratung.de' },
      { id: USER_B, email: 'b@fremd.de' },
    ]);
    await admin.query(
      `insert into public.profiles (id, email, display_name) values ($1,'a@am-beratung.de','A'), ($2,'b@fremd.de','B')`,
      [USER_A, USER_B],
    );
    await admin.query(
      `insert into public.workspace_members (workspace_id, profile_id, roles)
       values ($1,$2,array['ADMIN']), ($3,$4,array['ADMIN'])`,
      [WORKSPACE_A, USER_A, WORKSPACE_B, USER_B],
    );
    await admin.query(
      `insert into public.campaigns (workspace_id, name, slug, state)
       values ($1,'Meins','meins','LIVE'), ($2,'Fremd','fremd','LIVE')`,
      [WORKSPACE_A, WORKSPACE_B],
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  it('applies every migration in filename order', () => {
    const files = migrationFiles().map((path) => path.split('/').pop());
    expect(files[0]).toBe('0001_extensions.sql');
    expect(files).toEqual([...files].sort());
    // beforeAll already applied them all; reaching here means none threw.
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  it('enables row level security on every base table', async () => {
    const { rows } = await harness.admin.query<{ table_name: string }>(
      `select c.relname as table_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       order by 1`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([]);
  });

  it('gives every workspace-scoped table a policy', async () => {
    const { rows } = await harness.admin.query<{ table_name: string }>(
      `select t.table_name
       from information_schema.columns t
       where t.table_schema = 'public' and t.column_name = 'workspace_id'
         and not exists (
           select 1 from pg_policies p
           where p.schemaname = 'public' and p.tablename = t.table_name
         )
       order by 1`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([]);
  });

  describe('privileges', () => {
    it('gives anon exactly one readable table', async () => {
      const { rows } = await harness.admin.query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
         from information_schema.role_table_grants
         where grantee = 'anon' and table_schema = 'public'
         order by table_name, privilege_type`,
      );
      expect(rows).toEqual([{ table_name: 'published_funnels', privilege_type: 'SELECT' }]);
    });

    it('refuses anon any access to leads, submissions and PII', async () => {
      // A fresh session per table: a failed statement aborts the transaction, and
      // an aborted transaction would mask the next assertion.
      for (const table of ['leads', 'form_submissions', 'submission_pii_encrypted', 'attribution_snapshots']) {
        await harness.asAnon(async (client) => {
          await expectSqlState(() => client.query(`select * from public.${table} limit 1`), '42501');
        });
      }
    });

    it('lets anon read only live production published funnels', async () => {
      await harness.admin.query(
        `insert into public.funnels (id, workspace_id, campaign_id, funnel_key, kind, name)
         select '33333333-3333-4333-8333-333333333333', $1, id, 'funnel_1', 'MULTI_STEP_FORM', 'V1'
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );
      await harness.admin.query(
        `insert into public.funnel_versions (id, workspace_id, funnel_id, campaign_id, version, state, spec, content_hash, published_at)
         select '44444444-4444-4444-8444-444444444444', $1, '33333333-3333-4333-8333-333333333333', id, 1, 'PUBLISHED', '{}'::jsonb, repeat('a',64), now()
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );
      await harness.admin.query(
        `insert into public.published_funnels (workspace_id, campaign_id, funnel_id, funnel_version_id, public_slug, is_live, environment)
         select $1, id, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'live-slug', true, 'production'
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );
      await harness.admin.query(
        `insert into public.published_funnels (workspace_id, campaign_id, funnel_id, funnel_version_id, public_slug, is_live, environment)
         select $1, id, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'draft-slug', false, 'production'
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );

      await harness.asAnon(async (client) => {
        const { rows } = await client.query<{ public_slug: string }>('select public_slug from public.published_funnels');
        expect(rows.map((row) => row.public_slug)).toEqual(['live-slug']);
      });
    });

    it('serves the public funnel read through the SECURITY DEFINER function', async () => {
      await harness.asAnon(async (client) => {
        const { rows } = await client.query<{ bundle: Record<string, unknown> | null }>(
          `select public.get_published_funnel('live-slug') as bundle`,
        );
        expect(rows[0].bundle).not.toBeNull();
        expect(rows[0].bundle).toHaveProperty('funnel_spec');
        // …and returns nothing for a funnel that is not live.
        const missing = await client.query<{ bundle: unknown }>(
          `select public.get_published_funnel('draft-slug') as bundle`,
        );
        expect(missing.rows[0].bundle).toBeNull();
      });
    });
  });

  describe('cross-workspace isolation', () => {
    it('shows a member only their own workspace’s campaigns', async () => {
      const mine = await harness.asUser(USER_A, async (client) => {
        const { rows } = await client.query<{ slug: string }>('select slug from public.campaigns order by slug');
        return rows.map((row) => row.slug);
      });
      expect(mine).toEqual(['meins']);

      const theirs = await harness.asUser(USER_B, async (client) => {
        const { rows } = await client.query<{ slug: string }>('select slug from public.campaigns order by slug');
        return rows.map((row) => row.slug);
      });
      expect(theirs).toEqual(['fremd']);
    });

    it('blocks a write into another workspace', async () => {
      await harness.asUser(USER_A, async (client) => {
        await expectSqlState(
          () =>
            client.query(
              `insert into public.campaigns (workspace_id, name, slug) values ($1,'Hack','hack')`,
              [WORKSPACE_B],
            ),
          '42501',
        );
      });
    });

    it('blocks an update that would move a row into another workspace', async () => {
      await harness.asUser(USER_A, async (client) => {
        await expectSqlState(
          () => client.query(`update public.campaigns set workspace_id = $1 where slug = 'meins'`, [WORKSPACE_B]),
          '42501',
        );
      });
    });

    it('hides another workspace’s leads even from an ADMIN', async () => {
      await harness.admin.query(
        `insert into public.form_submissions (workspace_id, submission_attempt_id, state)
         values ($1, gen_random_uuid(), 'ACCEPTED')`,
        [WORKSPACE_B],
      );
      const visible = await harness.asUser(USER_A, async (client) => {
        const { rows } = await client.query<{ count: string }>('select count(*)::text from public.form_submissions');
        return Number(rows[0].count);
      });
      expect(visible).toBe(0);
    });
  });

  describe('immutability triggers', () => {
    beforeAll(async () => {
      await harness.admin.query(
        `insert into public.campaign_versions (id, workspace_id, campaign_id, version, state, spec, content_hash, published_at)
         select '55555555-5555-4555-8555-555555555555', $1, id, 1, 'PUBLISHED', '{"a":1}'::jsonb, repeat('b',64), now()
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );
      await harness.admin.query(
        `insert into public.campaign_versions (id, workspace_id, campaign_id, version, state, spec, content_hash)
         select '66666666-6666-4666-8666-666666666666', $1, id, 2, 'DRAFT', '{"a":1}'::jsonb, repeat('c',64)
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );
    });

    it('rejects a content change on a published version', async () => {
      const error = await expectSqlState(
        () =>
          harness.admin.query(
            `update public.campaign_versions set spec = '{"a":2}'::jsonb where id = '55555555-5555-4555-8555-555555555555'`,
          ),
        'AM001',
      );
      expect(error.message).toContain('unveränderlich');
      expect(error.message).toContain('spec');
    });

    it('rejects a delete of a published version', async () => {
      const error = await expectSqlState(
        () =>
          harness.admin.query(
            `delete from public.campaign_versions where id = '55555555-5555-4555-8555-555555555555'`,
          ),
        'AM001',
      );
      expect(error.message).toContain('kann nicht gelöscht werden');
    });

    it('still allows a draft version to be edited', async () => {
      await harness.admin.query(
        `update public.campaign_versions set spec = '{"a":9}'::jsonb where id = '66666666-6666-4666-8666-666666666666'`,
      );
      const { rows } = await harness.admin.query<{ spec: { a: number } }>(
        `select spec from public.campaign_versions where id = '66666666-6666-4666-8666-666666666666'`,
      );
      expect(rows[0].spec.a).toBe(9);
    });

    it('still allows retiring a published version to ARCHIVED', async () => {
      await harness.admin.query(
        `update public.campaign_versions set state = 'ARCHIVED', archived_at = now()
         where id = '55555555-5555-4555-8555-555555555555'`,
      );
      const { rows } = await harness.admin.query<{ state: string }>(
        `select state from public.campaign_versions where id = '55555555-5555-4555-8555-555555555555'`,
      );
      expect(rows[0].state).toBe('ARCHIVED');
    });

    it('freezes an attribution snapshot the moment it exists', async () => {
      await harness.admin.query(
        `insert into public.form_submissions (id, workspace_id, submission_attempt_id, state)
         values ('77777777-7777-4777-8777-777777777777', $1, gen_random_uuid(), 'ACCEPTED')`,
        [WORKSPACE_A],
      );
      await harness.admin.query(
        `insert into public.attribution_snapshots (workspace_id, submission_id, channel, level, confidence)
         values ($1, '77777777-7777-4777-8777-777777777777', 'META_PAID', 'LEAD_LINKED', 'EXACT')`,
        [WORKSPACE_A],
      );
      await expectSqlState(
        () => harness.admin.query(`update public.attribution_snapshots set channel = 'DIRECT'`),
        'AM001',
      );
      await expectSqlState(() => harness.admin.query(`delete from public.attribution_snapshots`), 'AM001');
    });

    it('freezes experiment arms once the experiment is running', async () => {
      await harness.admin.query(
        `insert into public.experiments (id, workspace_id, campaign_id, kind, state, name, hypothesis, test_variable,
                                         primary_metric, thresholds, assignment_salt, started_at)
         select '88888888-8888-4888-8888-888888888888', $1, id, 'FUNNEL_EXPERIMENT', 'RUNNING', 'Test',
                'Hypothese mit genug Text', 'Fragenzahl', 'submission_rate', '{}'::jsonb, 'saltsalt', now()
         from public.campaigns where workspace_id = $1`,
        [WORKSPACE_A],
      );
      await harness.admin.query(
        `insert into public.experiment_arms (workspace_id, experiment_id, key, label, is_control, allocation)
         values ($1, '88888888-8888-4888-8888-888888888888', 'control', 'Kontrolle', true, 0.5)`,
        [WORKSPACE_A],
      );
      const error = await expectSqlState(
        () => harness.admin.query(`update public.experiment_arms set allocation = 0.9`),
        'AM001',
      );
      expect(error.message).toContain('RUNNING');
    });
  });

  describe('schema invariants', () => {
    it('gives every mirrored external record a UNIQUE (provider, external_id)', async () => {
      // `hubspot_stage_history` is excluded on purpose: its `external_id` is a
      // reference to the HubSpot object, not this row's identity — one object
      // legitimately has many transitions, keyed by (external_id, to_stage,
      // occurred_at).
      const { rows } = await harness.admin.query<{ table_name: string }>(
        `select c.table_name
         from information_schema.columns c
         where c.table_schema = 'public' and c.column_name = 'external_id'
           and c.table_name <> 'hubspot_stage_history'
           and not exists (
             select 1
             from pg_index i
             join pg_class t on t.oid = i.indrelid
             join pg_namespace n on n.oid = t.relnamespace
             where n.nspname = 'public' and t.relname = c.table_name and i.indisunique
               and (
                 select array_agg(a.attname::text order by a.attname::text)
                 from unnest(i.indkey) as k(attnum)
                 join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
               ) @> array['external_id','provider']
           )
         order by 1`,
      );
      expect(rows.map((row) => row.table_name)).toEqual([]);
    });

    it('makes outbox_events.dataset_id non-nullable so the dedup key always applies', async () => {
      const { rows } = await harness.admin.query<{ is_nullable: string; column_default: string }>(
        `select is_nullable, column_default from information_schema.columns
         where table_schema='public' and table_name='outbox_events' and column_name='dataset_id'`,
      );
      expect(rows[0].is_nullable).toBe('NO');
      expect(rows[0].column_default).toContain("''");
    });

    it('stores every timestamp as timestamptz', async () => {
      const { rows } = await harness.admin.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and data_type = 'timestamp without time zone'
         order by 1, 2`,
      );
      expect(rows).toEqual([]);
    });

    it('keeps PII out of the analytics tables', async () => {
      const { rows } = await harness.admin.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public'
           and table_name in ('events', 'touchpoints', 'submission_answers_non_pii', 'sessions', 'visitors')
           and column_name in ('email','phone','first_name','last_name','name','ip','ip_address','user_agent','answers')
         order by 1, 2`,
      );
      expect(rows).toEqual([]);
    });

    it('structurally excludes PII field types from the answer table', async () => {
      await harness.admin.query(
        `insert into public.form_submissions (id, workspace_id, submission_attempt_id, state)
         values ('99999999-9999-4999-8999-999999999999', $1, gen_random_uuid(), 'ACCEPTED')`,
        [WORKSPACE_A],
      );
      await expectSqlState(
        () =>
          harness.admin.query(
            `insert into public.submission_answers_non_pii (workspace_id, submission_id, field_key, field_type)
             values ($1, '99999999-9999-4999-8999-999999999999', 'email', 'EMAIL')`,
            [WORKSPACE_A],
          ),
        '23514',
      );
    });

    it('creates the five storage buckets when the storage schema exists', async () => {
      const { rows } = await harness.admin.query<{ exists: boolean }>(
        `select to_regclass('storage.buckets') is not null as exists`,
      );
      if (!rows[0].exists) {
        console.warn('[info] storage schema absent (bare Postgres) — bucket assertions skipped.');
        return;
      }
      const buckets = await harness.admin.query<{ id: string; public: boolean }>(
        `select id, public from storage.buckets order by id`,
      );
      expect(buckets.rows).toEqual([
        { id: 'brand-assets', public: true },
        { id: 'creative-renditions', public: true },
        { id: 'creative-source', public: false },
        { id: 'historical-creatives', public: false },
        { id: 'private-imports', public: false },
      ]);
    });
  });
});
