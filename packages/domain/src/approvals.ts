import { z } from 'zod';
import { approvalKindSchema, approvalStateSchema } from './enums';
import { uuidSchema } from './ids';
import { isoTimestampSchema } from './primitives';
import type { Permission } from './roles';

/**
 * An approval always refers to a *content hash*, not just an object id. That is
 * what makes "a content change after an approval automatically invalidates that
 * approval" (spec §4.1, acceptance criterion 25) a mechanical property rather
 * than a process someone has to remember.
 */
export const approvalSchema = z.object({
  id: uuidSchema,
  campaign_id: uuidSchema,
  kind: approvalKindSchema,
  state: approvalStateSchema,
  /** Hash of the exact content that was approved. */
  approved_content_hash: z.string().length(64).nullable().default(null),
  approved_by: uuidSchema.nullable().default(null),
  approved_at: isoTimestampSchema.nullable().default(null),
  rejected_reason_de: z.string().max(1000).nullable().default(null),
  invalidated_at: isoTimestampSchema.nullable().default(null),
  invalidated_reason_de: z.string().max(600).nullable().default(null),
  created_at: isoTimestampSchema,
});
export type Approval = z.infer<typeof approvalSchema>;

type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const APPROVAL_KIND_LABELS_DE: Readonly<Record<ApprovalKind, string>> = {
  STRATEGY: 'Strategie (Angle, Offer, Claims)',
  ASSETS: 'Creatives und Funnel',
  TEST_PLAN: 'Testplan und initiales Budget',
  PUBLISH: 'Veröffentlichung',
  BUDGET_SCALE: 'Budgetskalierung',
  MAJOR_CHANGE: 'Größere Änderung an laufender Kampagne',
};

/** Which permission grants each approval. */
export const APPROVAL_PERMISSIONS: Readonly<Record<ApprovalKind, Permission>> = {
  STRATEGY: 'campaign.approve_strategy',
  ASSETS: 'campaign.approve_assets',
  TEST_PLAN: 'campaign.approve_test_plan',
  PUBLISH: 'campaign.publish',
  BUDGET_SCALE: 'campaign.scale_budget',
  MAJOR_CHANGE: 'campaign.scale_budget_major',
};

/**
 * Which approvals a given content area invalidates when it changes.
 *
 * Changing a claim invalidates the strategy approval *and* everything that was
 * approved downstream of it, because the assets were reviewed against the old
 * claim set.
 */
export const INVALIDATION_MAP: Readonly<Record<string, readonly ApprovalKind[]>> = {
  angle: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
  offer: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
  claims: ['STRATEGY', 'ASSETS', 'PUBLISH'],
  core_message: ['STRATEGY', 'ASSETS', 'PUBLISH'],
  audience: ['STRATEGY', 'TEST_PLAN', 'PUBLISH'],
  creative: ['ASSETS', 'PUBLISH'],
  funnel: ['ASSETS', 'PUBLISH'],
  form: ['ASSETS', 'PUBLISH'],
  experiment_plan: ['TEST_PLAN', 'PUBLISH'],
  budget: ['TEST_PLAN', 'PUBLISH'],
};

export type ContentArea = keyof typeof INVALIDATION_MAP;

export function approvalsInvalidatedBy(area: string): readonly ApprovalKind[] {
  return INVALIDATION_MAP[area] ?? [];
}

/** An approval is only valid while it still matches the current content hash. */
export function isApprovalValid(approval: Approval, currentContentHash: string): boolean {
  return (
    approval.state === 'APPROVED' &&
    approval.invalidated_at === null &&
    approval.approved_content_hash === currentContentHash
  );
}

/**
 * Stable, order-independent content hash input. Keys are sorted recursively so
 * that a re-serialisation with a different property order does not read as a
 * content change and spuriously invalidate an approval.
 */
export function canonicalize(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (Array.isArray(input)) return input.map(walk);
    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/** Approvals required before a campaign may reach each state. */
export const REQUIRED_APPROVALS_FOR_STATE: Readonly<Record<string, readonly ApprovalKind[]>> = {
  STRATEGY_APPROVED: ['STRATEGY'],
  ASSET_REVIEW: ['STRATEGY'],
  TEST_PLAN_REVIEW: ['STRATEGY', 'ASSETS'],
  READY_FOR_LAUNCH_QA: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
  READY_FOR_META_DRAFT: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
  META_DRAFT_CREATED: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
  SCHEDULED: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
  LIVE: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
};
