'use server';

import { revalidatePath } from 'next/cache';
import {
  APPROVAL_KIND_LABELS_DE,
  APPROVAL_PERMISSIONS,
  CAMPAIGN_STATE_LABELS_DE,
  canTransition,
  REQUIRED_APPROVALS_FOR_STATE,
  type ApprovalKind,
  type CampaignState,
} from '@am/domain';
import { actionError, type ActionResult } from '@/lib/action-result';
import { defineAction, type ActionContext } from '@/lib/action';
import { ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';
import { assetGateBlockedReasonDe, budgetRefusalDe } from '@/components/campaign/gates';
import { getCampaignPort } from '@/server/campaign-fixtures';
import type {
  ApprovalStatus,
  CampaignHeaderView,
  CommandOutcome,
  CreativeBoardView,
  LeadRow,
} from '@/server/campaign-port';

/**
 * Every mutating action of the Campaign Room.
 *
 * `defineAction` supplies the permission check, the German error envelope and
 * the audit entry. What is added here is the domain gate that must hold no
 * matter which button was pressed:
 *
 * - `canTransition` before any state change,
 * - `REQUIRED_APPROVALS_FOR_STATE` before advancing, counting only approvals
 *   whose content hash still matches,
 * - at least `GENERATION_DEFAULTS.minApprovedCreatives` conceptually distinct
 *   creatives before launch,
 * - budget authority checked against the role matrix and **refused** with the
 *   approving role named, never clamped.
 */

function revalidateCampaign(campaignId: string): void {
  revalidatePath(`/kampagnen/${campaignId}`, 'layout');
  revalidatePath('/kampagnen');
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

export interface ApprovalDecisionFormInput {
  campaignId: string;
  decision: 'APPROVE' | 'REJECT';
  /** The hash the operator actually reviewed. */
  contentHash: string;
  reasonDe?: string;
}

async function decide(
  kind: ApprovalKind,
  input: ApprovalDecisionFormInput,
  ctx: ActionContext,
): Promise<ActionResult<ApprovalStatus>> {
  if (input.decision === 'REJECT' && (input.reasonDe ?? '').trim().length < 5) {
    return actionError('VALIDATION_FAILED', 'Bitte begründen Sie die Ablehnung.', {
      fieldErrors: { reasonDe: 'Mindestens 5 Zeichen.' },
    });
  }

  const result = await getCampaignPort().decideApproval({
    campaignId: input.campaignId,
    kind,
    decision: input.decision,
    contentHash: input.contentHash,
    reasonDe: input.reasonDe,
    actor: { id: ctx.user.id, displayName: ctx.user.displayName },
  });

  if (result.status === 'ok') {
    await ctx.audit({
      action: input.decision === 'APPROVE' ? 'approval.granted' : 'approval.rejected',
      entityType: 'approval',
      entityId: result.data.approval.id,
      campaignId: input.campaignId,
      summaryDe:
        input.decision === 'APPROVE'
          ? `Freigabe „${APPROVAL_KIND_LABELS_DE[kind]}" erteilt.`
          : `Freigabe „${APPROVAL_KIND_LABELS_DE[kind]}" abgelehnt.`,
      before: { state: 'PENDING' },
      after: { state: result.data.approval.state, hash: result.data.currentContentHash },
    });
    revalidateCampaign(input.campaignId);
  }
  return result;
}

export const decideStrategyApproval = defineAction<ApprovalDecisionFormInput, ApprovalStatus>(
  { permission: APPROVAL_PERMISSIONS.STRATEGY, name: 'campaign.approval.strategy' },
  (input, ctx) => decide('STRATEGY', input, ctx),
);

export const decideAssetsApproval = defineAction<ApprovalDecisionFormInput, ApprovalStatus>(
  { permission: APPROVAL_PERMISSIONS.ASSETS, name: 'campaign.approval.assets' },
  async (input, ctx) => {
    if (input.decision === 'APPROVE') {
      const board = await getCampaignPort().getCreativeBoard(input.campaignId);
      if (!board) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
      const blocked = assetGateBlockedReasonDe(board);
      if (blocked) return actionError('CREATIVE_DIVERSITY_BLOCKED', blocked);
    }
    return decide('ASSETS', input, ctx);
  },
);

export const decideTestPlanApproval = defineAction<ApprovalDecisionFormInput, ApprovalStatus>(
  { permission: APPROVAL_PERMISSIONS.TEST_PLAN, name: 'campaign.approval.test_plan' },
  (input, ctx) => decide('TEST_PLAN', input, ctx),
);

export const decidePublishApproval = defineAction<ApprovalDecisionFormInput, ApprovalStatus>(
  { permission: APPROVAL_PERMISSIONS.PUBLISH, name: 'campaign.approval.publish' },
  (input, ctx) => decide('PUBLISH', input, ctx),
);

/* -------------------------------------------------------------------------- */
/* Creative review                                                             */
/* -------------------------------------------------------------------------- */

export interface CreativeReviewFormInput {
  campaignId: string;
  creativeId: string;
  decision: 'APPROVE' | 'REJECT';
  reasonDe?: string;
}

export const reviewCreative = defineAction<CreativeReviewFormInput, CreativeBoardView>(
  { permission: 'creative.approve', name: 'campaign.creative.review' },
  async (input, ctx) => {
    if (input.decision === 'REJECT' && (input.reasonDe ?? '').trim().length < 5) {
      return actionError('VALIDATION_FAILED', 'Bitte begründen Sie die Ablehnung.', {
        fieldErrors: { reasonDe: 'Mindestens 5 Zeichen.' },
      });
    }
    const result = await getCampaignPort().reviewCreative({
      ...input,
      actor: { id: ctx.user.id, displayName: ctx.user.displayName },
    });
    if (result.status === 'ok') {
      await ctx.audit({
        action: 'creative.approved',
        entityType: 'creative',
        entityId: input.creativeId,
        campaignId: input.campaignId,
        summaryDe:
          input.decision === 'APPROVE'
            ? 'Creative freigegeben.'
            : 'Creative abgelehnt.',
        before: null,
        after: { decision: input.decision, approvedCount: result.data.approvedCount },
      });
      revalidateCampaign(input.campaignId);
    }
    return result;
  },
);

/* -------------------------------------------------------------------------- */
/* State transitions                                                           */
/* -------------------------------------------------------------------------- */

export interface TransitionFormInput {
  campaignId: string;
  to: CampaignState;
}

/** States that actually reach Meta and therefore need `campaign.publish`. */
const PUBLISHING_STATES: readonly CampaignState[] = ['META_DRAFT_CREATED', 'SCHEDULED', 'LIVE'];

async function guardedTransition(
  input: TransitionFormInput,
  ctx: ActionContext,
  allowed: (to: CampaignState) => boolean,
): Promise<ActionResult<CampaignHeaderView>> {
  const port = getCampaignPort();
  const header = await port.getHeader(input.campaignId, false);
  if (!header) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

  if (!allowed(input.to)) {
    const permission = PUBLISHING_STATES.includes(input.to) ? 'campaign.publish' : 'campaign.edit';
    const roles = rolesWithPermission(permission).map((r) => ROLE_LABELS_DE[r]).join(', ');
    return actionError(
      'FORBIDDEN',
      `Dieser Schritt wird über eine andere Aktion ausgeführt und benötigt die Berechtigung „${permission}" (Rollen: ${roles}).`,
    );
  }

  if (!canTransition(header.state, input.to)) {
    return actionError(
      'INVALID_TRANSITION',
      `Ein Wechsel von „${CAMPAIGN_STATE_LABELS_DE[header.state]}" nach „${CAMPAIGN_STATE_LABELS_DE[input.to]}" ist im Kampagnenablauf nicht vorgesehen.`,
    );
  }

  const required = REQUIRED_APPROVALS_FOR_STATE[input.to] ?? [];
  const missing = required.filter(
    (kind) => header.approvals.find((a) => a.kind === kind)?.valid !== true,
  );
  if (missing.length > 0) {
    const stale = missing.filter((kind) => {
      const status = header.approvals.find((a) => a.kind === kind);
      return status?.approval.state === 'APPROVED' || status?.approval.state === 'INVALIDATED';
    });
    const names = missing.map((kind) => APPROVAL_KIND_LABELS_DE[kind]).join(', ');
    return actionError(
      'APPROVAL_REQUIRED',
      stale.length > 0
        ? `Für „${CAMPAIGN_STATE_LABELS_DE[input.to]}" fehlen gültige Freigaben: ${names}. Der Inhalt wurde nach der Freigabe geändert; die Freigabe deckt den aktuellen Stand nicht mehr ab und muss erneut erteilt werden.`
        : `Für „${CAMPAIGN_STATE_LABELS_DE[input.to]}" fehlen folgende Freigaben: ${names}.`,
    );
  }

  if (PUBLISHING_STATES.includes(input.to)) {
    const board = await port.getCreativeBoard(input.campaignId);
    if (board) {
      const blocked = assetGateBlockedReasonDe(board);
      if (blocked) {
        return actionError(
          'CREATIVE_DIVERSITY_BLOCKED',
          `Der Launch ist blockiert. ${blocked}`,
        );
      }
    }
    const qa = await port.getLaunchQa(input.campaignId);
    if (qa) {
      const gate = input.to === 'LIVE' ? qa.report.canGoLive : qa.report.canCreateMetaDraft;
      if (!gate) {
        const blockers =
          input.to === 'LIVE'
            ? [...qa.report.blockingDe, ...qa.report.awaitingExternalDe]
            : qa.report.blockingDe;
        return actionError(
          'LAUNCH_QA_BLOCKED',
          `Die Launch-QA blockiert diesen Schritt: ${blockers.join(', ')}.`,
        );
      }
    }
  }

  const result = await port.transition({
    campaignId: input.campaignId,
    to: input.to,
    actor: { id: ctx.user.id, displayName: ctx.user.displayName },
  });

  if (result.status === 'ok') {
    await ctx.audit({
      action: 'campaign.state_changed',
      entityType: 'campaign',
      entityId: input.campaignId,
      campaignId: input.campaignId,
      summaryDe: `Status von „${CAMPAIGN_STATE_LABELS_DE[header.state]}" auf „${CAMPAIGN_STATE_LABELS_DE[input.to]}" geändert.`,
      before: { state: header.state },
      after: { state: input.to },
    });
    revalidateCampaign(input.campaignId);
  }
  return result;
}

export const advanceCampaign = defineAction<TransitionFormInput, CampaignHeaderView>(
  { permission: 'campaign.edit', name: 'campaign.advance' },
  (input, ctx) => guardedTransition(input, ctx, (to) => !PUBLISHING_STATES.includes(to) && to !== 'PAUSED'),
);

export const publishCampaign = defineAction<TransitionFormInput, CampaignHeaderView>(
  { permission: 'campaign.publish', name: 'campaign.publish' },
  (input, ctx) => guardedTransition(input, ctx, (to) => PUBLISHING_STATES.includes(to)),
);

export const pauseCampaign = defineAction<TransitionFormInput, CampaignHeaderView>(
  { permission: 'campaign.pause', name: 'campaign.pause' },
  (input, ctx) => guardedTransition(input, ctx, (to) => to === 'PAUSED' || to === 'COMPLETED'),
);

/* -------------------------------------------------------------------------- */
/* Budget                                                                      */
/* -------------------------------------------------------------------------- */

export interface BudgetChangeFormInput {
  campaignId: string;
  newDailyBudgetMinor: number;
  reasonDe: string;
}

export const changeDailyBudget = defineAction<BudgetChangeFormInput, CampaignHeaderView>(
  { permission: 'campaign.scale_budget', name: 'campaign.budget.change' },
  async (input, ctx) => {
    if ((input.reasonDe ?? '').trim().length < 5) {
      return actionError('VALIDATION_FAILED', 'Bitte begründen Sie die Budgetänderung.', {
        fieldErrors: { reasonDe: 'Mindestens 5 Zeichen.' },
      });
    }

    const port = getCampaignPort();
    const header = await port.getHeader(input.campaignId, false);
    if (!header) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const refusal = budgetRefusalDe(
      ctx.user.roles,
      header.budget.amountMinor,
      input.newDailyBudgetMinor,
    );
    if (refusal) return actionError('BUDGET_LIMIT_EXCEEDED', refusal);

    const result = await port.changeBudget({
      campaignId: input.campaignId,
      newDailyBudgetMinor: input.newDailyBudgetMinor,
      reasonDe: input.reasonDe,
      actorRoles: ctx.user.roles,
      actor: { id: ctx.user.id, displayName: ctx.user.displayName },
    });

    if (result.status === 'ok') {
      await ctx.audit({
        action: 'settings.changed',
        entityType: 'campaign_budget',
        entityId: input.campaignId,
        campaignId: input.campaignId,
        summaryDe: 'Tagesbudget geändert.',
        before: { dailyBudgetMinor: header.budget.amountMinor },
        after: { dailyBudgetMinor: input.newDailyBudgetMinor, reasonDe: input.reasonDe },
      });
      revalidateCampaign(input.campaignId);
    }
    return result;
  },
);

/* -------------------------------------------------------------------------- */
/* Recommendations                                                             */
/* -------------------------------------------------------------------------- */

export interface RecommendationExecutionFormInput {
  campaignId: string;
  recommendationId: string;
}

export const executeRecommendation = defineAction<
  RecommendationExecutionFormInput,
  CommandOutcome
>(
  { permission: 'recommendation.execute', name: 'campaign.recommendation.execute' },
  async (input, ctx) => {
    const port = getCampaignPort();
    const views = await port.getRecommendations(input.campaignId);
    const view = views.find((v) => v.recommendation.id === input.recommendationId);
    if (!view) {
      return actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
    }

    if (view.recommendation.proposedBudgetChangePct !== null) {
      const object = view.recommendation.affectedMetaObjects[0];
      const refusal = budgetRefusalDe(
        ctx.user.roles,
        object?.currentDailyBudgetMinor ?? 0,
        object?.proposedDailyBudgetMinor ?? 0,
      );
      if (refusal) return actionError('BUDGET_LIMIT_EXCEEDED', refusal);
    }

    const result = await port.executeRecommendation({
      ...input,
      actor: { id: ctx.user.id, displayName: ctx.user.displayName },
    });

    await ctx.audit({
      action: result.status === 'ok' ? 'recommendation.executed' : 'meta.command_requested',
      entityType: 'recommendation',
      entityId: input.recommendationId,
      campaignId: input.campaignId,
      summaryDe:
        result.status === 'ok'
          ? 'Empfehlung ausgeführt und vom Provider bestätigt.'
          : result.status === 'dry_run'
            ? 'Empfehlung als Dry-Run ausgewertet — es wurde nichts gesendet.'
            : 'Ausführung der Empfehlung abgelehnt.',
      before: { state: view.recommendation.state },
      after: { result: result.status },
    });
    revalidateCampaign(input.campaignId);
    return result;
  },
);

/* -------------------------------------------------------------------------- */
/* Lead sync                                                                   */
/* -------------------------------------------------------------------------- */

export interface LeadSyncRetryFormInput {
  campaignId: string;
  leadId: string;
}

export const retryLeadSync = defineAction<LeadSyncRetryFormInput, LeadRow>(
  { permission: 'crm.mapping.manage', name: 'campaign.lead.retry_sync' },
  async (input, ctx) => {
    const result = await getCampaignPort().retryLeadSync({
      ...input,
      actor: { id: ctx.user.id, displayName: ctx.user.displayName },
    });
    await ctx.audit({
      action: 'hubspot.sync_retried',
      entityType: 'lead',
      entityId: input.leadId,
      campaignId: input.campaignId,
      summaryDe:
        result.status === 'dry_run'
          ? 'Erneute HubSpot-Übertragung als Dry-Run ausgewertet — es wurde nichts gesendet.'
          : 'Erneute HubSpot-Übertragung angestoßen.',
      before: null,
      after: { result: result.status },
    });
    revalidateCampaign(input.campaignId);
    return result;
  },
);
