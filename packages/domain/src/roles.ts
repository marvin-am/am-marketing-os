import { z } from 'zod';

export const ROLES = [
  'VIEWER',
  'MARKETING_OPERATOR',
  'CREATIVE_REVIEWER',
  'MARKETING_LEAD',
  'REVOPS',
  'EXECUTIVE',
  'ADMIN',
] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * Every guarded capability in the product. Route handlers and server actions
 * check a permission, never a role — so that the role matrix stays the single
 * place a capability moves.
 */
export const PERMISSIONS = [
  'campaign.read',
  'campaign.create',
  'campaign.edit',
  'campaign.approve_strategy',
  'campaign.approve_assets',
  'campaign.approve_test_plan',
  'campaign.publish',
  'campaign.pause',
  'campaign.scale_budget',
  'campaign.scale_budget_major',
  'campaign.archive',
  'creative.edit',
  'creative.generate',
  'creative.approve',
  'funnel.edit',
  'funnel.publish',
  'experiment.edit',
  'experiment.conclude',
  'recommendation.execute',
  'crm.mapping.manage',
  'crm.revenue.manage',
  'integration.manage',
  'settings.manage',
  'user.manage',
  'audit.read',
] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

const VIEWER: readonly Permission[] = ['campaign.read', 'audit.read'];

const MARKETING_OPERATOR: readonly Permission[] = [
  ...VIEWER,
  'campaign.create',
  'campaign.edit',
  'creative.edit',
  'creative.generate',
  'funnel.edit',
  'experiment.edit',
];

const CREATIVE_REVIEWER: readonly Permission[] = [
  ...VIEWER,
  'creative.approve',
  'campaign.approve_assets',
];

const MARKETING_LEAD: readonly Permission[] = [
  ...MARKETING_OPERATOR,
  'creative.approve',
  'campaign.approve_strategy',
  'campaign.approve_assets',
  'campaign.approve_test_plan',
  'campaign.publish',
  'campaign.pause',
  'campaign.scale_budget',
  'campaign.archive',
  'funnel.publish',
  'experiment.conclude',
  'recommendation.execute',
];

const REVOPS: readonly Permission[] = [
  ...VIEWER,
  'crm.mapping.manage',
  'crm.revenue.manage',
  'integration.manage',
];

const EXECUTIVE: readonly Permission[] = [
  ...VIEWER,
  'campaign.scale_budget',
  'campaign.scale_budget_major',
  'campaign.approve_strategy',
];

const ADMIN: readonly Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  VIEWER,
  MARKETING_OPERATOR,
  CREATIVE_REVIEWER,
  MARKETING_LEAD,
  REVOPS,
  EXECUTIVE,
  ADMIN,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** A member may hold several roles; permissions are the union. */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) set.add(permission);
  }
  return [...set];
}

/* -------------------------------------------------------------------------- */
/* Budget limits                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Per-role budget authority, configurable in Settings. A scale request that
 * exceeds a role's limits is not silently clamped — it is refused and routed to
 * a role that may approve it (spec §7, §21, acceptance criterion 24).
 */
export const roleBudgetLimitSchema = z.object({
  role: roleSchema,
  /** Largest relative increase in a single action, e.g. 0.2 for +20 %. */
  maxSingleIncreasePct: z.number().min(0).max(10),
  /** Hard ceiling on the resulting daily budget, in minor units. */
  maxDailyBudgetMinor: z.number().int().min(0),
  /** Number of scale actions allowed per rolling 24 h window. */
  maxScalesPer24h: z.number().int().min(0),
  /** Whether the role may decrease budget or pause without extra approval. */
  mayPause: z.boolean(),
});
export type RoleBudgetLimit = z.infer<typeof roleBudgetLimitSchema>;

export const DEFAULT_ROLE_BUDGET_LIMITS: Readonly<Record<Role, RoleBudgetLimit>> = {
  VIEWER: {
    role: 'VIEWER',
    maxSingleIncreasePct: 0,
    maxDailyBudgetMinor: 0,
    maxScalesPer24h: 0,
    mayPause: false,
  },
  MARKETING_OPERATOR: {
    role: 'MARKETING_OPERATOR',
    maxSingleIncreasePct: 0,
    maxDailyBudgetMinor: 0,
    maxScalesPer24h: 0,
    mayPause: false,
  },
  CREATIVE_REVIEWER: {
    role: 'CREATIVE_REVIEWER',
    maxSingleIncreasePct: 0,
    maxDailyBudgetMinor: 0,
    maxScalesPer24h: 0,
    mayPause: false,
  },
  MARKETING_LEAD: {
    role: 'MARKETING_LEAD',
    maxSingleIncreasePct: 0.2,
    maxDailyBudgetMinor: 20_000_00,
    maxScalesPer24h: 1,
    mayPause: true,
  },
  REVOPS: {
    role: 'REVOPS',
    maxSingleIncreasePct: 0,
    maxDailyBudgetMinor: 0,
    maxScalesPer24h: 0,
    mayPause: false,
  },
  EXECUTIVE: {
    role: 'EXECUTIVE',
    maxSingleIncreasePct: 1.0,
    maxDailyBudgetMinor: 200_000_00,
    maxScalesPer24h: 4,
    mayPause: true,
  },
  ADMIN: {
    role: 'ADMIN',
    maxSingleIncreasePct: 1.0,
    maxDailyBudgetMinor: 200_000_00,
    maxScalesPer24h: 4,
    mayPause: true,
  },
};

export const DEFAULT_SCALE_STEP_PCT = 0.2;
export const DEFAULT_SCALE_COOLDOWN_HOURS = 24;
