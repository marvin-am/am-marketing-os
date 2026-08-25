import { describe, expect, it } from 'vitest';
import {
  LAUNCH_CHECK_KEYS,
  LIVE_ONLY_CHECKS,
  type ApprovalKind,
  type CampaignState,
  type Role,
} from '@am/domain';
import type { CampaignPort } from '@/server/campaign-port';

/**
 * The `CampaignPort` contract, as executable assertions.
 *
 * Two implementations back the Campaign Room — the fixture and the repositories
 * — and the whole point of the port is that a screen cannot tell them apart.
 * That claim is only worth something if it is checked, so this suite runs
 * unchanged against both: the fixture everywhere, and the Postgres-backed port
 * wherever `DATABASE_URL` points at a database.
 *
 * Every assertion here is a property the UI states as a fact. Nothing asserts a
 * particular campaign's data — the two datasets differ on purpose — only that
 * both stores answer the same questions the same way.
 */

export interface CampaignPortSubject {
  name: string;
  port: CampaignPort;
  /** Read-only assertions run against this campaign. */
  campaignId: string;
  /** Mutating assertions run against this one; it may end the suite changed. */
  mutableCampaignId: string;
  actor: { id: string; displayName: string };
  /** Roles the actor holds. Must include one with budget authority. */
  actorRoles: Role[];
}

const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

export function describeCampaignPortContract(subject: () => CampaignPortSubject): void {
  describe('reads', () => {
    it('answers every campaign-scoped read with the id it was asked about', async () => {
      const { port, campaignId } = subject();
      const [header, strategy, board, funnel, plan, qa, performance, crm, history] =
        await Promise.all([
          port.getHeader(campaignId, false),
          port.getStrategy(campaignId),
          port.getCreativeBoard(campaignId),
          port.getFunnelOverview(campaignId),
          port.getTestPlan(campaignId),
          port.getLaunchQa(campaignId),
          port.getLivePerformance(campaignId),
          port.getLeadsAndSales(campaignId),
          port.getHistory(campaignId),
        ]);

      expect(header?.id).toBe(campaignId);
      expect(strategy?.campaignId).toBe(campaignId);
      expect(board?.campaignId).toBe(campaignId);
      expect(funnel?.campaignId).toBe(campaignId);
      expect(plan?.campaignId).toBe(campaignId);
      expect(qa?.campaignId).toBe(campaignId);
      expect(performance?.campaignId).toBe(campaignId);
      expect(crm?.campaignId).toBe(campaignId);
      expect(history?.campaignId).toBe(campaignId);
    });

    it('returns null for a campaign that does not exist rather than an empty view', async () => {
      const { port } = subject();
      expect(await port.getHeader(UNKNOWN_ID, false)).toBeNull();
      expect(await port.getStrategy(UNKNOWN_ID)).toBeNull();
      expect(await port.getCreativeBoard(UNKNOWN_ID)).toBeNull();
      expect(await port.getFunnelOverview(UNKNOWN_ID)).toBeNull();
      expect(await port.getTestPlan(UNKNOWN_ID)).toBeNull();
      expect(await port.getLaunchQa(UNKNOWN_ID)).toBeNull();
      expect(await port.getLivePerformance(UNKNOWN_ID)).toBeNull();
      expect(await port.getLeadsAndSales(UNKNOWN_ID)).toBeNull();
      expect(await port.getHistory(UNKNOWN_ID)).toBeNull();
      expect(await port.getRecommendations(UNKNOWN_ID)).toEqual([]);
      expect(await port.getLearnings(UNKNOWN_ID)).toEqual([]);
    });

    it('carries exactly one status per approval kind, hashed against the current content', async () => {
      const { port, campaignId } = subject();
      const header = await port.getHeader(campaignId, false);
      const kinds = header?.approvals.map((status) => status.kind) ?? [];
      expect([...kinds].sort()).toEqual(['ASSETS', 'PUBLISH', 'STRATEGY', 'TEST_PLAN']);

      for (const status of header?.approvals ?? []) {
        expect(status.currentContentHash).toMatch(/^[0-9a-f]{64}$/);
        // `valid` is never asserted on its own: it is the hash comparison.
        const matches =
          status.approval.state === 'APPROVED' &&
          status.approval.invalidated_at === null &&
          status.approval.approved_content_hash === status.currentContentHash;
        expect(status.valid).toBe(matches);
      }
    });

    it('shows the same content hash on the tab as on the approval in the header', async () => {
      const { port, campaignId } = subject();
      const [header, strategy, board, plan] = await Promise.all([
        port.getHeader(campaignId, false),
        port.getStrategy(campaignId),
        port.getCreativeBoard(campaignId),
        port.getTestPlan(campaignId),
      ]);
      const hashOf = (kind: string): string | undefined =>
        header?.approvals.find((status) => status.kind === kind)?.currentContentHash;

      expect(strategy?.contentHash).toBe(hashOf('STRATEGY'));
      expect(board?.contentHash).toBe(hashOf('ASSETS'));
      expect(plan?.contentHash).toBe(hashOf('TEST_PLAN'));
    });

    it('marks a preview as a preview rather than as the delivered campaign', async () => {
      const { port, campaignId } = subject();
      const preview = await port.getHeader(campaignId, true);
      const real = await port.getHeader(campaignId, false);
      expect(preview?.reality).toBe('PREVIEW');
      expect(real?.reality).not.toBe('PREVIEW');
    });

    it('offers only transitions whose required approvals are actually valid', async () => {
      const { port, campaignId } = subject();
      const header = await port.getHeader(campaignId, false);
      const valid = new Map(header?.approvals.map((status) => [status.kind, status.valid]) ?? []);
      const required: Readonly<Record<string, readonly string[]>> = {
        STRATEGY_APPROVED: ['STRATEGY'],
        ASSET_REVIEW: ['STRATEGY'],
        TEST_PLAN_REVIEW: ['STRATEGY', 'ASSETS'],
        READY_FOR_LAUNCH_QA: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
        READY_FOR_META_DRAFT: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
        META_DRAFT_CREATED: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
        SCHEDULED: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
        LIVE: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
      };
      for (const to of header?.allowedTransitions ?? []) {
        for (const kind of required[to] ?? []) {
          expect(valid.get(kind as ApprovalKind)).toBe(true);
        }
      }
    });

    it('evaluates every launch check exactly once and gates the live-only ones separately', async () => {
      const { port, campaignId } = subject();
      const qa = await port.getLaunchQa(campaignId);
      const keys = qa?.report.checks.map((check) => check.key) ?? [];
      expect([...keys].sort()).toEqual([...LAUNCH_CHECK_KEYS].sort());
      for (const key of qa?.awaitingLiveOnlyKeys ?? []) {
        expect(LIVE_ONLY_CHECKS).toContain(key);
      }
      // A check that is only waiting on a live-only credential must not block
      // the paused draft; that is the whole reason the distinction exists.
      const blockingDraft = (qa?.report.checks ?? []).filter(
        (check) =>
          check.status === 'FAIL' ||
          (check.status === 'AWAITING_EXTERNAL_INPUT' && !check.blocksLiveOnly),
      );
      expect(qa?.report.canCreateMetaDraft).toBe(blockingDraft.length === 0);
    });

    it('previews both Meta-writing steps without naming an object in an ad account', async () => {
      const { port, campaignId } = subject();
      const qa = await port.getLaunchQa(campaignId);
      const steps = qa?.metaWrites.map((write) => write.to) ?? [];
      expect([...steps].sort()).toEqual(['LIVE', 'META_DRAFT_CREATED']);

      const draft = qa?.metaWrites.find((write) => write.to === 'META_DRAFT_CREATED');
      expect(draft?.operation).toBe('meta.create_paused_draft_campaign');
      expect(draft?.payload.ad_account_id).toBeNull();
      expect(draft?.payload.page_id).toBeNull();
      expect(draft?.payload.pixel_id).toBeNull();
    });

    it('never reports a rate or a metric with a zero denominator as a number', async () => {
      const { port, campaignId } = subject();
      const [header, performance, crm] = await Promise.all([
        port.getHeader(campaignId, false),
        port.getLivePerformance(campaignId),
        port.getLeadsAndSales(campaignId),
      ]);

      const metrics = [...(header ? [header.primaryMetric] : []), ...(performance?.totals ?? [])];
      for (const metric of metrics) {
        if (metric.denominator === 0) expect(metric.value).toBeNull();
      }
      for (const point of performance?.series ?? []) {
        if (point.ctr.denominator === 0) expect(point.ctr.value).toBeNull();
      }
      for (const row of performance?.byCreative ?? []) {
        if (row.submissionRate.denominator === 0) expect(row.submissionRate.value).toBeNull();
      }
      for (const stage of crm?.stages ?? []) {
        if (stage.conversion.denominator === 0) expect(stage.conversion.value).toBeNull();
      }
    });

    it('labels leads pseudonymously — never an address, never a name', async () => {
      const { port, campaignId } = subject();
      const crm = await port.getLeadsAndSales(campaignId);
      for (const lead of crm?.leads ?? []) {
        expect(lead.labelDe).not.toContain('@');
        expect(lead.labelDe.length).toBeGreaterThan(0);
      }
    });
  });

  describe('writes', () => {
    it('refuses an approval whose content hash is no longer current, and changes nothing', async () => {
      const { port, mutableCampaignId, actor } = subject();
      const before = await port.getHeader(mutableCampaignId, false);
      const strategyBefore = before?.approvals.find((status) => status.kind === 'STRATEGY');

      const result = await port.decideApproval({
        campaignId: mutableCampaignId,
        kind: 'STRATEGY',
        decision: 'APPROVE',
        contentHash: 'f'.repeat(64),
        actor,
      });

      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.code).toBe('CONTENT_CHANGED');

      const after = await port.getHeader(mutableCampaignId, false);
      const strategyAfter = after?.approvals.find((status) => status.kind === 'STRATEGY');
      expect(strategyAfter?.approval.state).toBe(strategyBefore?.approval.state);
    });

    it('grants an approval against the current hash and reads it back as valid', async () => {
      const { port, mutableCampaignId, actor } = subject();
      const strategy = await port.getStrategy(mutableCampaignId);
      expect(strategy).not.toBeNull();

      const result = await port.decideApproval({
        campaignId: mutableCampaignId,
        kind: 'STRATEGY',
        decision: 'APPROVE',
        contentHash: strategy?.contentHash ?? '',
        actor,
      });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.data.approval.state).toBe('APPROVED');
        expect(result.data.valid).toBe(true);
        expect(result.data.approval.approved_content_hash).toBe(strategy?.contentHash);
      }

      const header = await port.getHeader(mutableCampaignId, false);
      const readBack = header?.approvals.find((status) => status.kind === 'STRATEGY');
      expect(readBack?.approval.state).toBe('APPROVED');
      expect(readBack?.valid).toBe(true);
    });

    it('refuses a budget change beyond the role limit instead of clamping it', async () => {
      const { port, mutableCampaignId, actor, actorRoles } = subject();
      const before = await port.getHeader(mutableCampaignId, false);
      const current = before?.budget.amountMinor ?? 0;

      const result = await port.changeBudget({
        campaignId: mutableCampaignId,
        newDailyBudgetMinor: current * 4,
        reasonDe: 'Skalierung nach guter Woche.',
        actorRoles,
        actor,
      });

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.code).toBe('BUDGET_LIMIT_EXCEEDED');
        // The refusal has to name who could approve it, or it is a dead end.
        expect(result.messageDe).toMatch(/Rolle/);
      }

      const after = await port.getHeader(mutableCampaignId, false);
      expect(after?.budget.amountMinor).toBe(current);
    });

    it('applies a budget change within the limit and invalidates the plan it was sized for', async () => {
      const { port, mutableCampaignId, actor, actorRoles } = subject();
      const before = await port.getHeader(mutableCampaignId, false);
      const current = before?.budget.amountMinor ?? 0;
      const planHashBefore = before?.approvals.find(
        (status) => status.kind === 'TEST_PLAN',
      )?.currentContentHash;

      const result = await port.changeBudget({
        campaignId: mutableCampaignId,
        newDailyBudgetMinor: Math.round(current * 1.1),
        reasonDe: 'Leicht anheben, um das Mindestvolumen zu erreichen.',
        actorRoles,
        actor,
      });

      expect(result.status).toBe('ok');

      const after = await port.getHeader(mutableCampaignId, false);
      expect(after?.budget.amountMinor).toBe(Math.round(current * 1.1));

      const planHashAfter = after?.approvals.find(
        (status) => status.kind === 'TEST_PLAN',
      )?.currentContentHash;
      expect(planHashAfter).not.toBe(planHashBefore);
    });

    it('refuses a transition the campaign flow does not allow', async () => {
      const { port, mutableCampaignId, actor } = subject();
      const before = await port.getHeader(mutableCampaignId, false);
      const illegal: CampaignState = 'IDEA';

      const result = await port.transition({ campaignId: mutableCampaignId, to: illegal, actor });
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.code).toBe('INVALID_TRANSITION');

      const after = await port.getHeader(mutableCampaignId, false);
      expect(after?.state).toBe(before?.state);
    });

    it('never records a state that asserts a Meta object on the strength of a local click', async () => {
      const { port, mutableCampaignId, actor } = subject();
      const before = await port.getHeader(mutableCampaignId, false);

      for (const to of ['META_DRAFT_CREATED', 'LIVE'] as CampaignState[]) {
        const result = await port.transition({ campaignId: mutableCampaignId, to, actor });
        expect(result.status).not.toBe('ok');
        const after = await port.getHeader(mutableCampaignId, false);
        expect(after?.state).toBe(before?.state);
      }
    });

    it('invalidates the assets approval when the approved creative set changes', async () => {
      const { port, mutableCampaignId, actor } = subject();
      const board = await port.getCreativeBoard(mutableCampaignId);
      const approved = board?.creatives.find((card) => card.reviewState === 'APPROVED');
      if (!approved) {
        expect(board?.approvedCount).toBe(0);
        return;
      }

      const result = await port.reviewCreative({
        campaignId: mutableCampaignId,
        creativeId: approved.id,
        decision: 'REJECT',
        reasonDe: 'Der Aufhänger wiederholt ein anderes Konzept.',
        actor,
      });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.data.approvedCount).toBe((board?.approvedCount ?? 1) - 1);
        expect(result.data.contentHash).not.toBe(board?.contentHash);
        const card = result.data.creatives.find((entry) => entry.id === approved.id);
        expect(card?.reviewState).toBe('REJECTED');
        expect(card?.rejectedReasonDe).toBeTruthy();
      }
    });

    it('refuses a lead retry and a recommendation decision that do not belong to the campaign', async () => {
      const { port, mutableCampaignId, actor } = subject();
      const retry = await port.retryLeadSync({
        campaignId: mutableCampaignId,
        leadId: UNKNOWN_ID,
        actor,
      });
      expect(retry.status).toBe('error');
      if (retry.status === 'error') expect(retry.code).toBe('NOT_FOUND');

      const decision = await port.decideRecommendation({
        campaignId: mutableCampaignId,
        recommendationId: UNKNOWN_ID,
        decision: 'DISMISS',
        actor,
      });
      expect(decision.status).toBe('error');
      if (decision.status === 'error') expect(decision.code).toBe('NOT_FOUND');
    });
  });
}
