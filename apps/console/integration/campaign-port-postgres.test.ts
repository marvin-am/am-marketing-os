import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announceSkip, HAS_DATABASE, setupDatabase, type Harness } from '../../../supabase/tests/harness';
import { createDatabaseCampaignPort } from '@/server/campaign-db-port';
import type { CampaignPort } from '@/server/campaign-port';
import {
  actAs,
  assetsHashOfCampaignA,
  AUDIENCE_NAME,
  ANGLE_NAME,
  CAMPAIGN_A,
  CAMPAIGN_A_NAME,
  CAMPAIGN_B,
  DAILY_BUDGET_MINOR,
  OFFER_NAME,
  PROFILE_LEAD,
  PROFILE_OPERATOR,
  PROFILE_OUTSIDER,
  publishHashOfCampaignA,
  seedCampaignScratch,
  strategyHashOfCampaignA,
  testPlanHashOfCampaignA,
  WORKSPACE_A,
  WORKSPACE_B,
  type ScratchClient,
  type ScratchSession,
} from './fixtures/campaign-scratch';

/**
 * What the repository-backed `CampaignPort` does that the fixture cannot.
 *
 * The contract suite proves the two behave alike. This file proves the four
 * things that only exist once there is a database behind the port: a write
 * survives the process, a multi-row write commits whole or not at all, a dry run
 * leaves nothing behind, and RLS still decides who may do what.
 *
 * Skips cleanly without `DATABASE_URL`. The harness provisions its own scratch
 * database and drops it afterwards; the instance the URL points at is never
 * written to.
 */

if (!HAS_DATABASE) announceSkip('apps/console/integration/campaign-port-postgres.test.ts');

const NOW = new Date('2026-08-25T09:00:00.000Z');

describe.skipIf(!HAS_DATABASE)('DatabaseCampaignPort against Postgres', () => {
  let harness: Harness;
  let lead: ScratchSession;
  let port: CampaignPort;
  const sessions: ScratchSession[] = [];

  const open = (): Promise<ScratchClient> => harness.open() as Promise<ScratchClient>;

  async function portFor(profileId: string, workspaceId = WORKSPACE_A): Promise<CampaignPort> {
    const session = await actAs(open, profileId);
    sessions.push(session);
    return createDatabaseCampaignPort({
      database: async () => session.db,
      workspaceId,
      transaction: session.transaction,
      now: () => NOW,
    });
  }

  beforeAll(async () => {
    harness = await setupDatabase('campaign_port');
    await seedCampaignScratch(harness.admin);
    lead = await actAs(open, PROFILE_LEAD);
    sessions.push(lead);
    port = createDatabaseCampaignPort({
      database: async () => lead.db,
      workspaceId: WORKSPACE_A,
      transaction: lead.transaction,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    for (const session of sessions) await session.close();
    await harness?.teardown();
  });

  /* ------------------------------------------------------------------ */

  describe('reads the rows that are actually in the database', () => {
    it('renders the header from the campaign row and its published version', async () => {
      const header = await port.getHeader(CAMPAIGN_A, false);
      expect(header?.name).toBe(CAMPAIGN_A_NAME);
      expect(header?.state).toBe('TEST_PLAN_REVIEW');
      expect(header?.reality).toBe('DRAFT');
      expect(header?.angleName).toBe(ANGLE_NAME);
      expect(header?.offerName).toBe(OFFER_NAME);
      expect(header?.audienceName).toBe(AUDIENCE_NAME);
      expect(header?.budget).toEqual({ amountMinor: DAILY_BUDGET_MINOR, currency: 'EUR' });
      expect(header?.primaryMetric.metric).toBe('cpl');
    });

    it('lists the campaign of this workspace and only that one', async () => {
      const page = await port.listCampaigns({
        states: [],
        angles: [],
        offers: [],
        from: null,
        to: null,
        search: null,
        page: 1,
        pageSize: 25,
      });
      expect(page.rows.map((row) => row.id)).toEqual([CAMPAIGN_A]);
      expect(page.facets.angles).toEqual([ANGLE_NAME]);
    });

    it('reads the creative board from `creative_concepts`, approved set included', async () => {
      const board = await port.getCreativeBoard(CAMPAIGN_A);
      expect(board?.creatives).toHaveLength(6);
      expect(board?.approvedCount).toBe(5);
      expect(board?.contentHash).toBe(assetsHashOfCampaignA());
      expect(board?.diversity.blocked).toBe(false);
      expect(board?.diversity.distinctCount).toBe(5);
      // The reviewer id cannot be resolved to a name without a `profiles`
      // repository, and a uuid in that slot would be worse than nothing.
      const approved = board?.creatives.find((card) => card.reviewState === 'APPROVED');
      expect(approved?.reviewedBy).toBeNull();
      expect(approved?.reviewedAt).not.toBeNull();
    });

    it('reads the funnel mix from `funnels` and its published version', async () => {
      const overview = await port.getFunnelOverview(CAMPAIGN_A);
      expect(overview?.variants).toHaveLength(3);
      expect(overview?.mixProblemsDe).toEqual([]);
      const states = overview?.variants.map((variant) => variant.state);
      expect(states).toEqual(['PUBLISHED', 'PUBLISHED', 'DRAFT']);
      expect(overview?.variants[0]?.publicUrl).toBe('/f/potenzialanalyse-a');
      expect(overview?.variants[2]?.publicUrl).toBeNull();
    });

    it('reads the test plan from the experiment and its thresholds', async () => {
      const plan = await port.getTestPlan(CAMPAIGN_A);
      expect(plan?.plan.kind).toBe('BUNDLED_FUNNEL_TEST');
      expect(plan?.plan.controlKey).toBe('funnel_2');
      expect(plan?.plan.variantKeys.sort()).toEqual(['funnel_1', 'funnel_3']);
      expect(plan?.plan.minSessionsPerArm).toBe(200);
      expect(plan?.plan.stopRules).toHaveLength(1);
      expect(plan?.contentHash).toBe(testPlanHashOfCampaignA());
      expect(plan?.budget.dailyBudgetMinor).toBe(DAILY_BUDGET_MINOR);
    });

    it('folds the performance tab out of `performance_rollups`, not out of a provider', async () => {
      const view = await port.getLivePerformance(CAMPAIGN_A);
      expect(view?.series.map((point) => point.date)).toEqual(['2026-08-23', '2026-08-24']);

      const spend = view?.totals.find((metric) => metric.metric === 'spend');
      expect(spend?.value).toBe(11_000 + 11_400);
      const leads = view?.totals.find((metric) => metric.metric === 'leads');
      expect(leads?.value).toBe(9 + 10);
      expect(view?.attributionCoverage).toBeCloseTo(0.83, 5);
      // Nineteen submissions is not a mature cohort and the port says so.
      expect(view?.maturity).toBe('PARTIAL');
    });

    it('assembles the strategy from the version spec, the proposal and the brand knowledge', async () => {
      const strategy = await port.getStrategy(CAMPAIGN_A);
      expect(strategy?.contentHash).toBe(strategyHashOfCampaignA());
      expect(strategy?.anglePerspective).toContain('Planbarkeitsproblem');
      expect(strategy?.offer.type).toBe('POTENTIAL_ANALYSIS');
      expect(strategy?.offer.effortPromise).toBe('2 Minuten');
      expect(strategy?.audience.name).toBe(AUDIENCE_NAME);
      expect(strategy?.audience.industries).toEqual(['Elektro', 'Sanitär']);
      expect(strategy?.risks).toHaveLength(1);
      expect(strategy?.similarPastCampaigns[0]?.campaignId).toBe(CAMPAIGN_B);
      expect(strategy?.historicalEvidence[0]?.summary).toContain('42 Erstgesprächen');
      // No repository reads `claims`, so the tab shows none rather than a set
      // assembled from somewhere else.
      expect(strategy?.claims).toEqual([]);
    });

    it('reads the version history and its audit trail from the database', async () => {
      const history = await port.getHistory(CAMPAIGN_A);
      expect(history?.versions).toHaveLength(1);
      expect(history?.versions[0]?.current).toBe(true);
      expect(history?.versions[0]?.publishedAt).not.toBeNull();
      expect(history?.versions[0]?.before).toBeNull();
      expect((history?.versions[0]?.after as { angle?: string } | null)?.angle).toBe(ANGLE_NAME);
    });

    it('leaves the CRM tab empty rather than inventing a funnel with no submissions', async () => {
      const crm = await port.getLeadsAndSales(CAMPAIGN_A);
      expect(crm?.stages).toEqual([]);
      expect(crm?.leads).toEqual([]);
      expect(crm?.revenue).toEqual({ amountMinor: 0, currency: 'EUR' });
      expect(crm?.attributionCoverage).toBeNull();
    });
  });

  /* ------------------------------------------------------------------ */

  describe('writes survive the process', () => {
    it('reads an approval back through a fresh connection and a fresh port', async () => {
      const plan = await port.getTestPlan(CAMPAIGN_A);
      const result = await port.decideApproval({
        campaignId: CAMPAIGN_A,
        kind: 'TEST_PLAN',
        decision: 'APPROVE',
        contentHash: plan?.contentHash ?? '',
        actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
      });
      expect(result.status).toBe('ok');

      // A second port over a second connection: nothing about this read can come
      // from the object the write happened on.
      const other = await portFor(PROFILE_LEAD);
      const header = await other.getHeader(CAMPAIGN_A, false);
      const approval = header?.approvals.find((status) => status.kind === 'TEST_PLAN');
      expect(approval?.approval.state).toBe('APPROVED');
      expect(approval?.valid).toBe(true);
      expect(approval?.approval.approved_by).toBe(PROFILE_LEAD);

      const { rows } = await harness.admin.query<{ state: string; approved_content_hash: string }>(
        `select state, approved_content_hash from public.approvals
          where campaign_id = $1 and kind = 'TEST_PLAN'`,
        [CAMPAIGN_A],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('APPROVED');
      expect(rows[0]?.approved_content_hash).toBe(plan?.contentHash);
    });

    it('writes the audit row for the decision in the same breath', async () => {
      const { rows } = await harness.admin.query<{ action: string; summary_de: string }>(
        `select action, summary_de from public.audit_logs
          where campaign_id = $1 and entity_type = 'approval'`,
        [CAMPAIGN_A],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('approval.granted');
      expect(rows[0]?.summary_de).toContain('TEST_PLAN');
    });

    it('refuses to advance while an approval the step requires is missing', async () => {
      const result = await port.transition({
        campaignId: CAMPAIGN_A,
        to: 'READY_FOR_LAUNCH_QA',
        actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
      });
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.code).toBe('APPROVAL_REQUIRED');

      const state = await harness.admin.query<{ state: string }>(
        `select state from public.campaigns where id = $1`,
        [CAMPAIGN_A],
      );
      expect(state.rows[0]?.state).toBe('TEST_PLAN_REVIEW');
    });

    it('moves the campaign state once every required approval covers the content', async () => {
      const actor = { id: PROFILE_LEAD, displayName: 'Marketing Lead' };
      const strategy = await port.getStrategy(CAMPAIGN_A);
      expect(
        (
          await port.decideApproval({
            campaignId: CAMPAIGN_A,
            kind: 'STRATEGY',
            decision: 'APPROVE',
            contentHash: strategy?.contentHash ?? '',
            actor,
          })
        ).status,
      ).toBe('ok');

      const board = await port.getCreativeBoard(CAMPAIGN_A);
      expect(
        (
          await port.decideApproval({
            campaignId: CAMPAIGN_A,
            kind: 'ASSETS',
            decision: 'APPROVE',
            contentHash: board?.contentHash ?? '',
            actor,
          })
        ).status,
      ).toBe('ok');

      const result = await port.transition({
        campaignId: CAMPAIGN_A,
        to: 'READY_FOR_LAUNCH_QA',
        actor,
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.data.state).toBe('READY_FOR_LAUNCH_QA');

      const after = await harness.admin.query<{ state: string }>(
        `select state from public.campaigns where id = $1`,
        [CAMPAIGN_A],
      );
      expect(after.rows[0]?.state).toBe('READY_FOR_LAUNCH_QA');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('a multi-row write lands whole or not at all', () => {
    /** Approval states after the write, so "nothing moved" is one comparison. */
    async function approvalStates(): Promise<Record<string, string>> {
      const { rows } = await harness.admin.query<{ kind: string; state: string }>(
        `select kind, state from public.approvals where campaign_id = $1 order by kind`,
        [CAMPAIGN_A],
      );
      return Object.fromEntries(rows.map((row) => [row.kind, row.state]));
    }

    async function auditCount(): Promise<number> {
      const { rows } = await harness.admin.query<{ count: string }>(
        `select count(*)::text as count from public.audit_logs where campaign_id = $1`,
        [CAMPAIGN_A],
      );
      return Number(rows[0]?.count ?? 0);
    }

    it('rolls the whole rejection back when the audit row it belongs to cannot be written', async () => {
      // The one failure that matters: the business rows are accepted and the row
      // that accounts for them is refused. `authenticated` losing INSERT on
      // `audit_logs` reproduces it through the database rather than through a
      // stub, and neither the decision nor the cascade may survive it.
      const before = await approvalStates();
      const auditBefore = await auditCount();
      expect(before).toEqual({ STRATEGY: 'APPROVED', ASSETS: 'APPROVED', TEST_PLAN: 'APPROVED' });

      await harness.admin.query(`revoke insert on public.audit_logs from authenticated`);
      try {
        const strategy = await port.getStrategy(CAMPAIGN_A);
        const result = await port.decideApproval({
          campaignId: CAMPAIGN_A,
          kind: 'STRATEGY',
          decision: 'REJECT',
          contentHash: strategy?.contentHash ?? '',
          reasonDe: 'Der Angle wiederholt die Q1-Kampagne ohne benannte Abgrenzung.',
          actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
        });
        expect(result.status).toBe('error');
      } finally {
        await harness.admin.query(`grant insert on public.audit_logs to authenticated`);
      }

      expect(await approvalStates()).toEqual(before);
      expect(await auditCount()).toBe(auditBefore);
    });

    it('commits the rejection, its cascade and its audit row together once it can succeed', async () => {
      const auditBefore = await auditCount();
      const strategy = await port.getStrategy(CAMPAIGN_A);
      const result = await port.decideApproval({
        campaignId: CAMPAIGN_A,
        kind: 'STRATEGY',
        decision: 'REJECT',
        contentHash: strategy?.contentHash ?? '',
        reasonDe: 'Der Angle wiederholt die Q1-Kampagne ohne benannte Abgrenzung.',
        actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
      });
      expect(result.status).toBe('ok');

      expect(await approvalStates()).toEqual({
        STRATEGY: 'REJECTED',
        ASSETS: 'INVALIDATED',
        TEST_PLAN: 'INVALIDATED',
      });
      expect(await auditCount()).toBe(auditBefore + 1);

      const { rows } = await harness.admin.query<{ invalidated_reason_de: string | null }>(
        `select invalidated_reason_de from public.approvals
          where campaign_id = $1 and kind = 'ASSETS'`,
        [CAMPAIGN_A],
      );
      expect(rows[0]?.invalidated_reason_de).toContain('STRATEGY');
    });

    it('refuses the write outright when no transactional connection is configured', async () => {
      const withoutTransaction = createDatabaseCampaignPort({
        database: async () => lead.db,
        workspaceId: WORKSPACE_A,
        transaction: null,
        now: () => NOW,
      });
      const strategy = await withoutTransaction.getStrategy(CAMPAIGN_A);
      const result = await withoutTransaction.decideApproval({
        campaignId: CAMPAIGN_A,
        kind: 'STRATEGY',
        decision: 'APPROVE',
        contentHash: strategy?.contentHash ?? '',
        actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
      });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.code).toBe('PROVIDER_NOT_CONFIGURED');
        expect(result.messageDe).toContain('DATABASE_URL');
      }
      expect((await approvalStates()).STRATEGY).toBe('REJECTED');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('RLS decides who sees and who may act', () => {
    it('shows an operator of another workspace nothing of this campaign', async () => {
      const outsider = await portFor(PROFILE_OUTSIDER, WORKSPACE_B);
      expect(await outsider.getHeader(CAMPAIGN_A, false)).toBeNull();
      expect(await outsider.getStrategy(CAMPAIGN_A)).toBeNull();
      expect(await outsider.getRecommendations(CAMPAIGN_A)).toEqual([]);

      const page = await outsider.listCampaigns({
        states: [],
        angles: [],
        offers: [],
        from: null,
        to: null,
        search: null,
        page: 1,
        pageSize: 25,
      });
      expect(page.rows.map((row) => row.id)).toEqual([CAMPAIGN_B]);
    });

    it('lets a member read the campaign but refuses an approval their role does not carry', async () => {
      const operator = await portFor(PROFILE_OPERATOR);
      const header = await operator.getHeader(CAMPAIGN_A, false);
      expect(header?.id).toBe(CAMPAIGN_A);

      const board = await operator.getCreativeBoard(CAMPAIGN_A);
      const result = await operator.decideApproval({
        campaignId: CAMPAIGN_A,
        kind: 'ASSETS',
        decision: 'APPROVE',
        contentHash: board?.contentHash ?? '',
        actor: { id: PROFILE_OPERATOR, displayName: 'Marketing Operator' },
      });

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.code).toBe('FORBIDDEN');
        expect(result.messageDe).toContain('Rolle');
      }

      const { rows } = await harness.admin.query<{ state: string }>(
        `select state from public.approvals where campaign_id = $1 and kind = 'ASSETS'`,
        [CAMPAIGN_A],
      );
      // Still the row the rejection cascade invalidated: the operator's attempt
      // added nothing and changed nothing.
      expect(rows.map((row) => row.state)).toEqual(['INVALIDATED']);
    });

    it('shows an anonymous session nothing at all', async () => {
      const anon = await actAs(open, null, 'anon');
      sessions.push(anon);
      const anonPort = createDatabaseCampaignPort({
        database: async () => anon.db,
        workspaceId: WORKSPACE_A,
        transaction: anon.transaction,
        now: () => NOW,
      });
      expect(await anonPort.getHeader(CAMPAIGN_A, false)).toBeNull();
    });
  });

  /* ------------------------------------------------------------------ */

  describe('a dry run leaves nothing behind', () => {
    beforeAll(async () => {
      // Put the campaign where the two Meta-writing steps are legal and every
      // approval covers the current content, so the refusal under test is the
      // feature flag and not a missing precondition.
      await harness.admin.query(`delete from public.approvals where campaign_id = $1`, [CAMPAIGN_A]);
      for (const [kind, hash] of [
        ['STRATEGY', strategyHashOfCampaignA()],
        ['ASSETS', assetsHashOfCampaignA()],
        ['TEST_PLAN', testPlanHashOfCampaignA()],
        ['PUBLISH', publishHashOfCampaignA()],
      ] as const) {
        await harness.admin.query(
          `insert into public.approvals
             (workspace_id, campaign_id, kind, state, approved_content_hash, approved_by, approved_at)
           values ($1, $2, $3, 'APPROVED', $4, $5, now())`,
          [WORKSPACE_A, CAMPAIGN_A, kind, hash, PROFILE_LEAD],
        );
      }
      await harness.admin.query(
        `update public.campaigns set state = 'META_DRAFT_CREATED' where id = $1`,
        [CAMPAIGN_A],
      );
    });

    it('answers the step into a live campaign with a dry run and writes nothing', async () => {
      const before = await counts(harness);
      const header = await port.getHeader(CAMPAIGN_A, false);
      expect(header?.allowedTransitions).toContain('LIVE');

      const result = await port.transition({
        campaignId: CAMPAIGN_A,
        to: 'LIVE',
        actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
      });

      expect(result.status).toBe('dry_run');
      if (result.status === 'dry_run') {
        expect(result.dryRun.provider).toBe('META');
        expect(result.dryRun.operation).toBe('meta.resume_entity');
        expect(result.dryRun.wouldSend.campaign_id).toBeNull();
      }

      const after = await counts(harness);
      expect(after).toEqual(before);

      const state = await harness.admin.query<{ state: string }>(
        `select state from public.campaigns where id = $1`,
        [CAMPAIGN_A],
      );
      expect(state.rows[0]?.state).toBe('META_DRAFT_CREATED');
    });

    it('answers a budget change on a Meta-owned budget the same way', async () => {
      const before = await counts(harness);
      const result = await port.changeBudget({
        campaignId: CAMPAIGN_A,
        newDailyBudgetMinor: DAILY_BUDGET_MINOR + 1_000,
        reasonDe: 'Mindestvolumen je Arm noch nicht erreicht.',
        actorRoles: ['MARKETING_LEAD'],
        actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
      });

      expect(result.status).toBe('dry_run');
      if (result.status === 'dry_run') {
        expect(result.dryRun.operation).toBe('campaign.update.daily_budget');
      }

      const budget = await harness.admin.query<{ daily_budget_minor: number }>(
        `select daily_budget_minor from public.campaigns where id = $1`,
        [CAMPAIGN_A],
      );
      expect(Number(budget.rows[0]?.daily_budget_minor)).toBe(DAILY_BUDGET_MINOR);
      expect(await counts(harness)).toEqual(before);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('the list page costs the same whatever the workspace holds', () => {
    /**
     * Angle and offer live in the published version's spec rather than in a
     * column, so the list has to read every campaign of the workspace to build
     * its facets. What it must not do is assemble a whole Campaign Room bundle
     * for rows nobody is looking at — that is the N+1 that turns one page render
     * into hundreds of statements. Counting them is the only way to notice.
     */
    it('does not read more from the database as campaigns are added off the page', async () => {
      const statementsFor = async (pageSize: number): Promise<number> => {
        let statements = 0;
        const counting = async (): Promise<ScratchClient> => {
          const client = await open();
          return {
            query: (text, values) => {
              statements += 1;
              return client.query(text, values);
            },
            end: () => client.end(),
          };
        };
        const session = await actAs(counting, PROFILE_LEAD);
        sessions.push(session);
        const counted = createDatabaseCampaignPort({
          database: async () => session.db,
          workspaceId: WORKSPACE_A,
          transaction: session.transaction,
          now: () => NOW,
        });
        const before = statements;
        await counted.listCampaigns({
          states: [],
          angles: [],
          offers: [],
          from: null,
          to: null,
          search: null,
          page: 1,
          pageSize,
        });
        return statements - before;
      };

      const withOne = await statementsFor(1);

      // Older than the campaign under test, so the same row stays on page one
      // and the comparison is about the six that are off it.
      for (let index = 0; index < 6; index += 1) {
        await harness.admin.query(
          `insert into public.campaigns
             (workspace_id, name, slug, state, currency, daily_budget_minor, created_at, updated_at)
           values ($1, $2, $3, 'IDEA', 'EUR', 1000, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
          [WORKSPACE_A, `Weitere Kampagne ${index}`, `weitere-kampagne-${index}`],
        );
      }

      const withSeven = await statementsFor(1);
      expect(withSeven).toBe(withOne);
    });
  });
});

/** Every table a provider dispatch would touch, so "nothing was written" is checked. */
async function counts(harness: Harness): Promise<Record<string, number>> {
  const { rows } = await harness.admin.query<{
    outbox: string;
    commands: string;
    audit: string;
    attempts: string;
  }>(
    `select
       (select count(*) from public.outbox_events)         ::text as outbox,
       (select count(*) from public.external_commands)     ::text as commands,
       (select count(*) from public.audit_logs)            ::text as audit,
       (select count(*) from public.hubspot_sync_attempts) ::text as attempts`,
  );
  const row = rows[0];
  return {
    outbox: Number(row?.outbox ?? 0),
    commands: Number(row?.commands ?? 0),
    audit: Number(row?.audit ?? 0),
    attempts: Number(row?.attempts ?? 0),
  };
}
