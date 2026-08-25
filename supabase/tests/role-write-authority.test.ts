/**
 * Write authority at the database, not just in Next.js.
 *
 * The console checks a `Permission` before every mutating server action, but the
 * browser also holds a Supabase session token and PostgREST answers it directly.
 * Anything these tests can do as a plain member is something a signed-in
 * colleague can do with `curl` and no console involved — so every assertion here
 * is made as a real Postgres role with a real JWT subject, never through a
 * repository.
 *
 * Skips cleanly when `DATABASE_URL` is unset (AGENTS.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from '../../packages/domain/src/roles';
import { APPROVAL_PERMISSIONS } from '../../packages/domain/src/approvals';
import {
  announceSkip,
  expectSqlState,
  HAS_DATABASE,
  seedAuthUsers,
  setupDatabase,
  type Harness,
} from './harness';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

/** One member per role in workspace A, so a policy can be attributed to a role. */
const MEMBERS: Readonly<Record<Role, string>> = {
  VIEWER: 'aaaa1111-0000-4000-8000-000000000001',
  MARKETING_OPERATOR: 'aaaa1111-0000-4000-8000-000000000002',
  CREATIVE_REVIEWER: 'aaaa1111-0000-4000-8000-000000000003',
  MARKETING_LEAD: 'aaaa1111-0000-4000-8000-000000000004',
  REVOPS: 'aaaa1111-0000-4000-8000-000000000005',
  EXECUTIVE: 'aaaa1111-0000-4000-8000-000000000006',
  ADMIN: 'aaaa1111-0000-4000-8000-000000000007',
};
/** An ADMIN of a workspace the others have nothing to do with. */
const OUTSIDER = 'bbbb2222-0000-4000-8000-000000000001';

const CAMPAIGN = '33333333-3333-4333-8333-000000000001';
const FUNNEL = '33333333-3333-4333-8333-000000000002';
const FUNNEL_VERSION = '33333333-3333-4333-8333-000000000003';
const SUBMISSION = '33333333-3333-4333-8333-000000000004';
const CAMPAIGN_B = '44444444-4444-4444-8444-000000000001';

if (!HAS_DATABASE) announceSkip('supabase/tests/role-write-authority.test.ts');

describe.skipIf(!HAS_DATABASE)('write authority', () => {
  let harness: Harness;

  /** `update … returning` as one role; resolves to the number of rows written. */
  async function updateAs(
    role: Role | 'OUTSIDER',
    sql: string,
    values: unknown[] = [],
  ): Promise<number> {
    const profileId = role === 'OUTSIDER' ? OUTSIDER : MEMBERS[role];
    return harness.asUser(profileId, async (client) => {
      const { rowCount } = await client.query(sql, values);
      return rowCount ?? 0;
    });
  }

  /** `select count(*)` as one role. */
  async function countAs(role: Role | 'OUTSIDER', table: string): Promise<number> {
    const profileId = role === 'OUTSIDER' ? OUTSIDER : MEMBERS[role];
    return harness.asUser(profileId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text from public.${table}`,
      );
      return Number(rows[0].count);
    });
  }

  beforeAll(async () => {
    harness = await setupDatabase('roleauth');
    const { admin } = harness;

    await admin.query(
      `insert into public.workspaces (id, slug, name) values ($1,'a','A&M'), ($2,'b','Fremd')`,
      [WORKSPACE_A, WORKSPACE_B],
    );

    const people = [
      ...ROLES.map((role) => ({
        id: MEMBERS[role],
        email: `${role.toLowerCase()}@am-beratung.de`,
      })),
      { id: OUTSIDER, email: 'admin@fremd.de' },
    ];
    await seedAuthUsers(admin, people);
    for (const person of people) {
      await admin.query(`insert into public.profiles (id, email, display_name) values ($1,$2,$2)`, [
        person.id,
        person.email,
      ]);
    }
    for (const role of ROLES) {
      await admin.query(
        `insert into public.workspace_members (workspace_id, profile_id, roles) values ($1,$2,array[$3])`,
        [WORKSPACE_A, MEMBERS[role], role],
      );
    }
    await admin.query(
      `insert into public.workspace_members (workspace_id, profile_id, roles) values ($1,$2,array['ADMIN'])`,
      [WORKSPACE_B, OUTSIDER],
    );

    // The rows the assertions below try to write. Inserted as the owner, which
    // is a superuser and therefore not subject to the policies under test.
    await admin.query(
      `insert into public.campaigns (id, workspace_id, name, slug, state) values
         ($1,$2,'Meins','meins','LIVE'), ($3,$4,'Fremd','fremd','LIVE')`,
      [CAMPAIGN, WORKSPACE_A, CAMPAIGN_B, WORKSPACE_B],
    );
    await admin.query(
      `insert into public.role_limits (workspace_id, role, max_single_increase_pct, max_daily_budget_minor, max_scales_per_24h, may_pause)
       values ($1,'MARKETING_LEAD',0.2,2000000,1,true), ($1,'EXECUTIVE',1.0,20000000,4,true), ($1,'ADMIN',1.0,20000000,4,true)`,
      [WORKSPACE_A],
    );
    await admin.query(`insert into public.workspace_settings (workspace_id) values ($1)`, [
      WORKSPACE_A,
    ]);
    await admin.query(
      `insert into public.funnels (id, workspace_id, campaign_id, funnel_key, kind, name)
       values ($1,$2,$3,'funnel_1','MULTI_STEP_FORM','V1')`,
      [FUNNEL, WORKSPACE_A, CAMPAIGN],
    );
    await admin.query(
      `insert into public.funnel_versions (id, workspace_id, funnel_id, campaign_id, version, state, spec, content_hash, published_at)
       values ($1,$2,$3,$4,1,'PUBLISHED','{}'::jsonb,repeat('a',64),now())`,
      [FUNNEL_VERSION, WORKSPACE_A, FUNNEL, CAMPAIGN],
    );
    await admin.query(
      `insert into public.published_funnels (workspace_id, campaign_id, funnel_id, funnel_version_id, public_slug, is_live, environment, redirect_url)
       values ($1,$2,$3,$4,'live-slug',true,'production','https://am-beratung.de/danke')`,
      [WORKSPACE_A, CAMPAIGN, FUNNEL, FUNNEL_VERSION],
    );
    for (const kind of Object.keys(APPROVAL_PERMISSIONS)) {
      await admin.query(
        `insert into public.approvals (workspace_id, campaign_id, kind, state, approved_content_hash, approved_at)
         values ($1,$2,$3,'APPROVED',repeat('b',64),now())`,
        [WORKSPACE_A, CAMPAIGN, kind],
      );
    }
    await admin.query(
      `insert into public.experiments (workspace_id, campaign_id, kind, state, name, hypothesis, test_variable,
                                       primary_metric, thresholds, assignment_salt)
       values ($1,$2,'FUNNEL_EXPERIMENT','DRAFT','Test','Hypothese mit genug Text','Fragenzahl','submission_rate','{}'::jsonb,'saltsalt')`,
      [WORKSPACE_A, CAMPAIGN],
    );
    await admin.query(
      `insert into public.recommendations (workspace_id, campaign_id, action, rule_id, dedup_key, title_de, summary_de,
                                           comparison_basis_de, maturity, uncertainty_de, risk, facts)
       values ($1,$2,'COLLECT_MORE_DATA','r1','d1','Titel','Zusammenfassung','Vergleichsbasis','PARTIAL','Unsicherheit','LOW','[{"k":"v"}]'::jsonb)`,
      [WORKSPACE_A, CAMPAIGN],
    );
    await admin.query(
      `insert into public.hubspot_mappings (workspace_id, object_type, version, state, content_hash)
       values ($1,'CONTACT',1,'DRAFT',repeat('c',64))`,
      [WORKSPACE_A],
    );
    await admin.query(
      `insert into public.prompt_versions (workspace_id, key, version, template, model, content_hash)
       values ($1,'campaign.proposal',1,'Vorlage','gpt-5',repeat('d',64))`,
      [WORKSPACE_A],
    );
    await admin.query(
      `insert into public.audit_logs (workspace_id, action, actor_label, entity_type, entity_id, summary_de)
       values ($1,'settings.changed','System','workspace','w','Einstellung geändert')`,
      [WORKSPACE_A],
    );
    await admin.query(
      `insert into public.integration_connections (workspace_id, provider, state) values ($1,'META','FIXTURE')`,
      [WORKSPACE_A],
    );
    await admin.query(
      `insert into public.form_submissions (id, workspace_id, submission_attempt_id, state)
       values ($1,$2,gen_random_uuid(),'ACCEPTED')`,
      [SUBMISSION, WORKSPACE_A],
    );
    await admin.query(
      `insert into public.submission_pii_encrypted (workspace_id, submission_id, iv, auth_tag, ciphertext)
       values ($1,$2,'\\x313233343536373839303132','\\x31323334353637383930313233343536','\\x67656865696d')`,
      [WORKSPACE_A, SUBMISSION],
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  /* ------------------------------------------------------------------------ */
  /* The matrix in the database is the matrix in the product                   */
  /* ------------------------------------------------------------------------ */

  describe('the permission matrix', () => {
    it('matches ROLE_PERMISSIONS in packages/domain/src/roles.ts exactly', async () => {
      const { rows } = await harness.admin.query<{ permission: string; roles: string[] }>(
        `select permission, roles from app.permission_roles order by permission`,
      );

      const fromDatabase = Object.fromEntries(
        rows.map((row) => [row.permission, [...row.roles].sort()]),
      );
      const fromDomain: Record<string, string[]> = {};
      for (const role of ROLES) {
        for (const permission of ROLE_PERMISSIONS[role]) {
          (fromDomain[permission] ??= []).push(role);
        }
      }
      for (const permission of Object.keys(fromDomain)) fromDomain[permission].sort();

      // Compared whole rather than key by key: a permission present on one side
      // and missing on the other is the drift this test exists to catch.
      expect(fromDatabase).toEqual(fromDomain);
    });

    it('matches APPROVAL_PERMISSIONS in packages/domain/src/approvals.ts exactly', async () => {
      const { rows } = await harness.admin.query<{ kind: string; permission: string }>(
        `select kind, permission from app.approval_kind_permissions order by kind`,
      );
      expect(Object.fromEntries(rows.map((row) => [row.kind, row.permission]))).toEqual(
        APPROVAL_PERMISSIONS,
      );
    });

    it('names only capabilities the matrix knows, for every gated table', async () => {
      const { rows } = await harness.admin.query<{ permission: string }>(
        `select distinct p as permission
         from app.write_capabilities w, unnest(w.permissions) as p
         where not exists (select 1 from app.permission_roles r where r.permission = p)`,
      );
      expect(rows).toEqual([]);
    });

    it('leaves no gated table writable on membership alone', async () => {
      const { rows } = await harness.admin.query<{ tablename: string }>(
        `select distinct p.tablename
         from pg_policies p
         where p.schemaname = 'public'
           and p.tablename in (select table_name from app.write_capabilities union select 'approvals')
           and p.permissive = 'PERMISSIVE'
           and p.cmd in ('ALL','INSERT','UPDATE','DELETE')
           and 'authenticated' = any (p.roles)
           and coalesce(p.qual, p.with_check, '') like '%is_member%'
         order by 1`,
      );
      expect(rows.map((row) => row.tablename)).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The two writes that started this                                          */
  /* ------------------------------------------------------------------------ */

  describe('the budget authority matrix', () => {
    const raise = `update public.role_limits set max_daily_budget_minor = 999999999, may_pause = true`;

    it('cannot be rewritten by a VIEWER', async () => {
      expect(await updateAs('VIEWER', raise)).toBe(0);
    });

    it('cannot be rewritten by any role without settings.manage', async () => {
      for (const role of ROLES.filter((r) => !ROLE_PERMISSIONS[r].includes('settings.manage'))) {
        expect([role, await updateAs(role, raise)]).toEqual([role, 0]);
      }
    });

    it('is still writable by ADMIN, which is what settings.manage resolves to', async () => {
      expect(await updateAs('ADMIN', raise)).toBe(3);
      // …and the change did not survive: every asUser call runs in a rolled-back
      // transaction, so one test cannot arm the next.
      const { rows } = await harness.admin.query<{ max: string }>(
        `select max(max_daily_budget_minor)::text as max from public.role_limits`,
      );
      expect(Number(rows[0].max)).toBe(20000000);
    });

    it('stays readable by a VIEWER', async () => {
      expect(await countAs('VIEWER', 'role_limits')).toBe(3);
    });
  });

  describe('the live funnel binding', () => {
    const repoint = `update public.published_funnels set redirect_url = 'https://evil.example/phish' where is_live`;
    const retire = `update public.published_funnels set is_live = false, unpublished_at = now() where is_live`;
    const publishOwn = `insert into public.published_funnels
        (workspace_id, campaign_id, funnel_id, funnel_version_id, public_slug, is_live, environment, redirect_url)
      select workspace_id, campaign_id, funnel_id, funnel_version_id, 'gekapert', true, 'production', 'https://evil.example/phish'
      from public.published_funnels where is_live limit 1`;

    it('cannot be repointed by a VIEWER', async () => {
      expect(await updateAs('VIEWER', repoint)).toBe(0);
    });

    it('cannot be taken offline by a VIEWER', async () => {
      // Retiring is the one edit the immutability trigger permits on a live
      // binding, so without the capability check this is a one-statement outage.
      expect(await updateAs('VIEWER', retire)).toBe(0);
    });

    it('cannot be re-published under a new slug by a VIEWER', async () => {
      // The sharper form: the trigger guards the existing row, nothing guarded
      // a brand-new live binding pointing anywhere the inserter liked.
      await harness.asUser(MEMBERS.VIEWER, (client) =>
        expectSqlState(() => client.query(publishOwn), '42501'),
      );
    });

    it('cannot be touched by an operator who may edit a funnel but not publish it', async () => {
      expect(ROLE_PERMISSIONS.MARKETING_OPERATOR).toContain('funnel.edit');
      expect(ROLE_PERMISSIONS.MARKETING_OPERATOR).not.toContain('funnel.publish');
      expect(await updateAs('MARKETING_OPERATOR', retire)).toBe(0);
      await harness.asUser(MEMBERS.MARKETING_OPERATOR, (client) =>
        expectSqlState(() => client.query(publishOwn), '42501'),
      );
    });

    it('is still retired and published by the roles that hold funnel.publish', async () => {
      for (const role of ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('funnel.publish'))) {
        expect([role, await updateAs(role, retire)]).toEqual([role, 1]);
        expect([role, await updateAs(role, publishOwn)]).toEqual([role, 1]);
      }
    });

    it('stays readable by a VIEWER', async () => {
      expect(await countAs('VIEWER', 'published_funnels')).toBe(1);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The rest of the matrix                                                    */
  /* ------------------------------------------------------------------------ */

  describe('every other gated table', () => {
    /**
     * table → the statement that writes it → the capabilities that may.
     *
     * `campaigns` carries two because `daily_budget_minor` lives on it and
     * `campaign.scale_budget` is held by EXECUTIVE, who holds no `campaign.edit`.
     */
    const CASES: readonly {
      table: string;
      permissions: Permission[];
      sql: string;
      rows: number;
    }[] = [
      {
        table: 'workspace_settings',
        permissions: ['settings.manage'],
        sql: `update public.workspace_settings set attribution_window_days = 90`,
        rows: 1,
      },
      {
        table: 'prompt_versions',
        permissions: ['settings.manage'],
        sql: `update public.prompt_versions set template = 'Gekapert'`,
        rows: 1,
      },
      {
        table: 'hubspot_mappings',
        permissions: ['crm.mapping.manage'],
        sql: `update public.hubspot_mappings set stage_map = '{"x":"y"}'::jsonb`,
        rows: 1,
      },
      {
        table: 'recommendations',
        permissions: ['recommendation.execute'],
        sql: `update public.recommendations set state = 'EXECUTED'`,
        rows: 1,
      },
      {
        table: 'experiments',
        permissions: ['experiment.edit'],
        sql: `update public.experiments set name = 'Umbenannt'`,
        rows: 1,
      },
      {
        table: 'funnels',
        permissions: ['funnel.edit'],
        sql: `update public.funnels set name = 'Umbenannt'`,
        rows: 1,
      },
      {
        table: 'campaigns',
        permissions: ['campaign.edit', 'campaign.scale_budget'],
        sql: `update public.campaigns set core_message = 'Gekapert'`,
        rows: 1,
      },
    ];

    for (const testCase of CASES) {
      const holds = (role: Role): boolean =>
        testCase.permissions.some((permission) => ROLE_PERMISSIONS[role].includes(permission));
      const holders = ROLES.filter(holds);
      const others = ROLES.filter((role) => !holds(role));
      const label = testCase.permissions.join(' / ');

      it(`lets ${label} write ${testCase.table} and nobody else`, async () => {
        for (const role of holders) {
          expect([testCase.table, role, await updateAs(role, testCase.sql)]).toEqual([
            testCase.table,
            role,
            testCase.rows,
          ]);
        }
        for (const role of others) {
          expect([testCase.table, role, await updateAs(role, testCase.sql)]).toEqual([
            testCase.table,
            role,
            0,
          ]);
        }
      });

      it(`still lets a VIEWER read ${testCase.table}`, async () => {
        expect(await countAs('VIEWER', testCase.table)).toBeGreaterThan(0);
      });
    }

    it('resolves the required capability of an approval from its own kind', async () => {
      // A CREATIVE_REVIEWER may sign off the assets and nothing else. Under a
      // union-of-approvers policy that distinction disappears, which is the
      // whole point of the four-eyes split.
      const approveAssets = `update public.approvals set state='APPROVED', approved_content_hash=repeat('e',64) where kind='ASSETS'`;
      expect(await updateAs('CREATIVE_REVIEWER', approveAssets)).toBe(1);

      const approveStrategy = `update public.approvals set state='APPROVED', approved_content_hash=repeat('e',64) where kind='STRATEGY'`;
      expect(await updateAs('MARKETING_LEAD', approveStrategy)).toBe(1);

      // Two different refusals, and the difference is the point. A role with no
      // write authority on the row never sees it for update at all; a role that
      // may edit the campaign sees it, and is stopped at the decision.
      expect(await updateAs('CREATIVE_REVIEWER', approveStrategy)).toBe(0);
      expect(await updateAs('VIEWER', approveStrategy)).toBe(0);
      await harness.asUser(MEMBERS.MARKETING_OPERATOR, (client) =>
        expectSqlState(() => client.query(approveStrategy), '42501'),
      );
    });

    it('still lets whoever may edit the content invalidate the approval covering it', async () => {
      // Criterion 25: a content change voids the approval that covered it. That
      // must not need the approver's authority, or the invalidation silently
      // writes nothing and a stale approval outlives its content.
      const invalidate = `update public.approvals
         set state='INVALIDATED', invalidated_at=now(), invalidated_reason_de='Inhalt geändert'
         where kind='STRATEGY' and state='APPROVED'`;
      expect(ROLE_PERMISSIONS.MARKETING_OPERATOR).not.toContain('campaign.approve_strategy');
      expect(await updateAs('MARKETING_OPERATOR', invalidate)).toBe(1);
      expect(await updateAs('VIEWER', invalidate)).toBe(0);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* What was already blocked stays blocked                                    */
  /* ------------------------------------------------------------------------ */

  describe('the guarantees that already held', () => {
    it('refuses a member their own promotion', async () => {
      expect(
        await updateAs(
          'VIEWER',
          `update public.workspace_members set roles = array['ADMIN'] where profile_id = $1`,
          [MEMBERS.VIEWER],
        ),
      ).toBe(0);
    });

    it('refuses a delete of the audit trail, to everyone including ADMIN', async () => {
      for (const role of ROLES) {
        expect([role, await updateAs(role, `delete from public.audit_logs`)]).toEqual([role, 0]);
      }
    });

    it('keeps encrypted submission PII to the three roles that may hold it', async () => {
      expect(await countAs('VIEWER', 'submission_pii_encrypted')).toBe(0);
      expect(await countAs('MARKETING_OPERATOR', 'submission_pii_encrypted')).toBe(0);
      expect(await countAs('ADMIN', 'submission_pii_encrypted')).toBe(1);
    });

    it('keeps provider credentials to the same three roles', async () => {
      expect(await countAs('VIEWER', 'integration_connections')).toBe(0);
      expect(await countAs('EXECUTIVE', 'integration_connections')).toBe(0);
      expect(await countAs('REVOPS', 'integration_connections')).toBe(1);
    });

    it('shows another workspace’s ADMIN none of this workspace’s rows', async () => {
      for (const table of [
        'role_limits',
        'published_funnels',
        'campaigns',
        'approvals',
        'workspace_settings',
      ]) {
        const visible = await harness.asUser(OUTSIDER, async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `select count(*)::text from public.${table} where workspace_id = $1`,
            [WORKSPACE_A],
          );
          return Number(rows[0].count);
        });
        expect([table, visible]).toEqual([table, 0]);
      }
      // …and does still see their own, so the count above is a policy result
      // rather than an empty table.
      expect(await countAs('OUTSIDER', 'campaigns')).toBe(1);
    });

    it('refuses another workspace’s ADMIN every write, capability or not', async () => {
      expect(
        await updateAs('OUTSIDER', `update public.role_limits set max_daily_budget_minor = 1`),
      ).toBe(0);
      expect(
        await updateAs(
          'OUTSIDER',
          `update public.published_funnels set redirect_url = 'https://evil.example/phish'`,
        ),
      ).toBe(0);
    });

    it('refuses an ADMIN a write into a workspace they do not belong to', async () => {
      await harness.asUser(MEMBERS.ADMIN, (client) =>
        expectSqlState(
          () =>
            client.query(
              `insert into public.role_limits (workspace_id, role) values ($1,'ADMIN')`,
              [WORKSPACE_B],
            ),
          '42501',
        ),
      );
    });

    it('refuses an ADMIN moving one of their rows into another workspace', async () => {
      await harness.asUser(MEMBERS.ADMIN, (client) =>
        expectSqlState(
          () => client.query(`update public.role_limits set workspace_id = $1`, [WORKSPACE_B]),
          '42501',
        ),
      );
    });
  });
});
