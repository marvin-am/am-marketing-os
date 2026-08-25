'use server';

import { revalidatePath } from 'next/cache';
import {
  nowIso,
  type ExperimentThresholds,
  type RecommendationConfig,
  type RetentionPolicy,
  type Role,
  type RoleBudgetLimit,
} from '@am/domain';
import { actionError } from '@/lib/action-result';
import { defineAction } from '@/lib/action';
import type {
  ApprovalThresholds,
  BrandTokens,
  SaveConsentVersionInput,
  SettingsSnapshot,
} from '@/server/ops-port';
import { getOpsPort } from '@/server/ops-fixtures';

/**
 * Server actions for the settings area.
 *
 * Every one of them checks a permission through `defineAction` and writes an
 * audit entry — settings changes are exactly the kind of change nobody
 * remembers making three weeks later.
 */

export const saveMemberRolesAction = defineAction<
  { memberId: string; roles: Role[] },
  SettingsSnapshot
>({ permission: 'user.manage', name: 'settings.member_roles' }, async (input, ctx) => {
  if (input.roles.length === 0) {
    return actionError<SettingsSnapshot>(
      'ROLES_REQUIRED',
      'Mindestens eine Rolle ist erforderlich. Ohne Rolle hätte die Person keinen Zugang.',
    );
  }
  const snapshot = await getOpsPort().saveMemberRoles(input);
  await ctx.audit({
    action: 'user.role_changed',
    entityType: 'workspace_member',
    entityId: input.memberId,
    summaryDe: `Rollen geändert: ${input.roles.join(', ')}.`,
    after: { roles: input.roles },
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const saveRoleBudgetLimitAction = defineAction<
  { limit: RoleBudgetLimit },
  SettingsSnapshot
>({ permission: 'settings.manage', name: 'settings.role_budget_limit' }, async (input, ctx) => {
  const snapshot = await getOpsPort().saveRoleBudgetLimit(input);
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'role_budget_limit',
    entityId: input.limit.role,
    summaryDe: `Budgetlimit für ${input.limit.role} geändert.`,
    after: input.limit,
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const saveApprovalThresholdsAction = defineAction<
  { thresholds: ApprovalThresholds },
  SettingsSnapshot
>({ permission: 'settings.manage', name: 'settings.approval_thresholds' }, async (input, ctx) => {
  const snapshot = await getOpsPort().saveApprovalThresholds(input);
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'approval_thresholds',
    entityId: 'workspace',
    summaryDe: 'Freigabeschwellen geändert.',
    after: input.thresholds,
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const saveExperimentThresholdsAction = defineAction<
  { thresholds: ExperimentThresholds },
  SettingsSnapshot
>({ permission: 'settings.manage', name: 'settings.experiment_thresholds' }, async (input, ctx) => {
  if (input.thresholds.maxRuntimeDays < input.thresholds.minRuntimeDays) {
    return actionError<SettingsSnapshot>(
      'INVALID_RANGE',
      'Die Höchstlaufzeit darf nicht kleiner als die Mindestlaufzeit sein.',
      { fieldErrors: { maxRuntimeDays: 'Muss mindestens der Mindestlaufzeit entsprechen.' } },
    );
  }
  const snapshot = await getOpsPort().saveExperimentThresholds(input);
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'experiment_thresholds',
    entityId: 'workspace',
    summaryDe: 'Experiment-Schwellen geändert.',
    after: input.thresholds,
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const saveRecommendationConfigAction = defineAction<
  { config: RecommendationConfig },
  SettingsSnapshot
>({ permission: 'settings.manage', name: 'settings.recommendation_config' }, async (input, ctx) => {
  const snapshot = await getOpsPort().saveRecommendationConfig(input);
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'recommendation_config',
    entityId: 'workspace',
    summaryDe: 'Empfehlungsregeln geändert.',
    after: input.config,
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const saveAttributionWindowAction = defineAction<
  { windowDays: number },
  SettingsSnapshot
>({ permission: 'settings.manage', name: 'settings.attribution_window' }, async (input, ctx) => {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1) {
    return actionError<SettingsSnapshot>(
      'INVALID_WINDOW',
      'Das Attributionsfenster muss mindestens einen Tag betragen.',
    );
  }
  const snapshot = await getOpsPort().saveAttributionWindow(input);
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'attribution_window',
    entityId: 'workspace',
    summaryDe: `Attributionsfenster auf ${input.windowDays} Tage gesetzt.`,
    after: { windowDays: input.windowDays },
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const addConsentVersionAction = defineAction<SaveConsentVersionInput, SettingsSnapshot>(
  { permission: 'settings.manage', name: 'settings.consent_version' },
  async (input, ctx) => {
    if (input.textDe.trim().length < 20) {
      return actionError<SettingsSnapshot>(
        'CONSENT_TEXT_TOO_SHORT',
        'Der Einwilligungstext muss mindestens 20 Zeichen lang sein.',
        { fieldErrors: { textDe: 'Bitte den vollständigen Text einfügen.' } },
      );
    }
    if (input.purposes.length === 0) {
      return actionError<SettingsSnapshot>(
        'CONSENT_PURPOSE_REQUIRED',
        'Bitte mindestens einen Zweck auswählen.',
      );
    }
    const snapshot = await getOpsPort().addConsentVersion({ ...input, now: nowIso() });
    const version = snapshot.consentVersions.at(-1)?.version ?? 0;
    await ctx.audit({
      action: 'settings.changed',
      entityType: 'consent_version',
      entityId: String(version),
      summaryDe: `Einwilligungsversion ${version} angelegt; vorherige Version beendet.`,
      after: { version, purposes: input.purposes },
    });
    revalidatePath('/einstellungen');
    return snapshot;
  },
);

export const saveRetentionPolicyAction = defineAction<
  { policy: Omit<RetentionPolicy, 'configuredBy' | 'configuredAt'> },
  SettingsSnapshot
>({ permission: 'settings.manage', name: 'settings.retention_policy' }, async (input, ctx) => {
  const snapshot = await getOpsPort().saveRetentionPolicy({
    policy: input.policy,
    configuredBy: ctx.user.id,
    now: nowIso(),
  });
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'retention_policy',
    entityId: 'workspace',
    summaryDe: 'Aufbewahrungsfristen geändert.',
    after: input.policy,
  });
  revalidatePath('/einstellungen');
  return snapshot;
});

export const saveBrandTokensAction = defineAction<{ brand: BrandTokens }, SettingsSnapshot>(
  { permission: 'settings.manage', name: 'settings.brand_tokens' },
  async (input, ctx) => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    const invalid = (['primary', 'foreground', 'background', 'accent'] as const).filter(
      (key) => !hex.test(input.brand[key]),
    );
    if (invalid.length > 0) {
      return actionError<SettingsSnapshot>(
        'INVALID_COLOR',
        'Bitte alle Farben im Format #RRGGBB angeben.',
        {
          fieldErrors: Object.fromEntries(
            invalid.map((key) => [key, 'Erwartet einen Hex-Wert wie #D7182A.']),
          ),
        },
      );
    }
    const snapshot = await getOpsPort().saveBrandTokens(input);
    await ctx.audit({
      action: 'settings.changed',
      entityType: 'brand_tokens',
      entityId: 'workspace',
      summaryDe: 'Marken-Tokens geändert.',
      after: input.brand,
    });
    revalidatePath('/einstellungen');
    return snapshot;
  },
);
