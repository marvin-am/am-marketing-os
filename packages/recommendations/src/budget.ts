import {
  DEFAULT_ROLE_BUDGET_LIMITS,
  DEFAULT_SCALE_COOLDOWN_HOURS,
  DEFAULT_SCALE_STEP_PCT,
  formatMoneyDe,
  type IsoTimestamp,
  money,
  type Role,
  type RoleBudgetLimit,
  ROLES,
} from '@am/domain';
import { roleLabelsDe, ROLE_LABELS_DE } from './config';

/**
 * Budget authority.
 *
 * The rule this module exists to enforce: an over-limit change is **refused and
 * routed**, never silently clamped. Clamping is the failure mode that makes a
 * budget system untrustworthy — the operator asks for +80 %, sees a success
 * toast, and finds +20 % in Meta the next morning with nothing in the audit log
 * explaining the difference. Here the answer is "no, and the Geschäftsführung
 * can approve this", with the numbers that produced it.
 *
 * Pure: `now` is an input, no clock is read, and nothing is executed. The result
 * is an opinion the caller acts on.
 */

export type BudgetDecisionKind = 'ALLOW' | 'REQUIRES_APPROVAL' | 'REFUSE';

export const BUDGET_REASON_CODES = [
  'NO_CHANGE',
  'DECREASE_WITHIN_AUTHORITY',
  'DECREASE_NOT_PERMITTED',
  'ROLE_MAY_NOT_SCALE',
  'SINGLE_INCREASE_LIMIT_EXCEEDED',
  'DAILY_BUDGET_CEILING_EXCEEDED',
  'ACCOUNT_LIMIT_EXCEEDED',
  'SCALE_COOLDOWN_ACTIVE',
  'NO_CURRENT_BUDGET',
  'WITHIN_AUTHORITY',
  'APPROVAL_REQUIRED_LARGE_STEP',
  'APPROVAL_REQUIRED_HIGH_BUDGET',
] as const;
export type BudgetReasonCode = (typeof BUDGET_REASON_CODES)[number];

export interface BudgetPolicy {
  /** Relative increase above which a recorded BUDGET_SCALE approval is needed. */
  requiresApprovalAbovePct: number;
  /**
   * Resulting daily budget above which an approval is needed. `null` means
   * "half the acting role's own ceiling", which scales with the role.
   */
  requiresApprovalAboveDailyMinor: number | null;
  /** Rolling window for the scale-frequency limit. */
  cooldownHours: number;
  /** Hard account-wide ceiling. Nobody may exceed it; Settings must be changed. */
  accountMaxDailyBudgetMinor: number | null;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  requiresApprovalAbovePct: DEFAULT_SCALE_STEP_PCT,
  requiresApprovalAboveDailyMinor: null,
  cooldownHours: DEFAULT_SCALE_COOLDOWN_HOURS,
  accountMaxDailyBudgetMinor: null,
};

export interface ScaleAction {
  at: IsoTimestamp;
}

export interface BudgetChangeInput {
  role: Role;
  currentDailyMinor: number;
  proposedDailyMinor: number;
  /** Previous scale actions on the same object, for the rolling-window limit. */
  recentScales?: readonly ScaleAction[];
  now?: IsoTimestamp;
  limits?: Readonly<Record<Role, RoleBudgetLimit>>;
  policy?: BudgetPolicy;
  currency?: string;
}

export interface BudgetDecision {
  decision: BudgetDecisionKind;
  /** Relative change; negative for a decrease, Infinity from a zero budget. */
  increasePct: number;
  deltaMinor: number;
  reasonCodes: BudgetReasonCode[];
  messageDe: string;
  /** Roles that could perform or approve this exact change. May be empty. */
  approverRoles: Role[];
  limit: RoleBudgetLimit;
  /** Largest daily budget the acting role could set in this single action. */
  maxAllowedDailyMinor: number;
  /** Scale actions already used inside the rolling window. */
  scalesInWindow: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function relativeIncrease(currentMinor: number, proposedMinor: number): number {
  if (currentMinor > 0) return (proposedMinor - currentMinor) / currentMinor;
  if (proposedMinor === currentMinor) return 0;
  return Number.POSITIVE_INFINITY;
}

function scalesInsideWindow(
  recentScales: readonly ScaleAction[],
  now: IsoTimestamp,
  cooldownHours: number,
): number {
  const nowMs = Date.parse(now);
  const windowMs = cooldownHours * 3_600_000;
  return recentScales.filter((scale) => {
    const at = Date.parse(scale.at);
    return !Number.isNaN(at) && nowMs - at < windowMs && nowMs - at >= 0;
  }).length;
}

/** Largest daily budget a role may set in one action from `currentMinor`. */
export function maxAllowedDailyBudget(
  limit: RoleBudgetLimit,
  currentMinor: number,
  policy: BudgetPolicy,
): number {
  const byStep = Math.floor(currentMinor * (1 + limit.maxSingleIncreasePct));
  const ceilings = [byStep, limit.maxDailyBudgetMinor];
  if (policy.accountMaxDailyBudgetMinor !== null) {
    ceilings.push(policy.accountMaxDailyBudgetMinor);
  }
  return Math.min(...ceilings);
}

/** Can `role` perform this exact change within its own numeric limits? */
function roleCanPerform(
  role: Role,
  input: Required<Pick<BudgetChangeInput, 'currentDailyMinor' | 'proposedDailyMinor'>>,
  limits: Readonly<Record<Role, RoleBudgetLimit>>,
  policy: BudgetPolicy,
  scalesUsed: number,
): boolean {
  const limit = limits[role];
  const delta = input.proposedDailyMinor - input.currentDailyMinor;

  if (delta === 0) return true;
  if (delta < 0) return limit.mayPause;

  if (policy.accountMaxDailyBudgetMinor !== null && input.proposedDailyMinor > policy.accountMaxDailyBudgetMinor) {
    return false;
  }
  if (limit.maxSingleIncreasePct <= 0) return false;
  if (input.proposedDailyMinor > limit.maxDailyBudgetMinor) return false;
  if (scalesUsed >= limit.maxScalesPer24h) return false;

  const pct = relativeIncrease(input.currentDailyMinor, input.proposedDailyMinor);
  return pct <= limit.maxSingleIncreasePct;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether `role` may move a daily budget from `currentDailyMinor` to
 * `proposedDailyMinor`.
 *
 * - `ALLOW` — inside the role's authority and small enough not to need a
 *   recorded approval. The operator still confirms in the console; nothing is
 *   executed from here.
 * - `REQUIRES_APPROVAL` — inside the role's numeric limits, but large enough
 *   that a `BUDGET_SCALE` approval must be recorded first.
 * - `REFUSE` — outside the role's authority. `approverRoles` names who could do
 *   it, and `messageDe` says so in German.
 */
export function evaluateBudgetChange(input: BudgetChangeInput): BudgetDecision {
  const limits = input.limits ?? DEFAULT_ROLE_BUDGET_LIMITS;
  const policy = input.policy ?? DEFAULT_BUDGET_POLICY;
  const currency = input.currency ?? 'EUR';
  const now = input.now ?? new Date(0).toISOString();
  const limit = limits[input.role];

  const currentDailyMinor = input.currentDailyMinor;
  const proposedDailyMinor = input.proposedDailyMinor;
  const deltaMinor = proposedDailyMinor - currentDailyMinor;
  const increasePct = relativeIncrease(currentDailyMinor, proposedDailyMinor);
  const scalesInWindow = scalesInsideWindow(input.recentScales ?? [], now, policy.cooldownHours);
  const maxAllowedDailyMinor = maxAllowedDailyBudget(limit, currentDailyMinor, policy);

  const changeShape = { currentDailyMinor, proposedDailyMinor };
  const approverRoles = ROLES.filter(
    (role) =>
      role !== input.role &&
      roleCanPerform(
        role,
        changeShape,
        limits,
        policy,
        // Frequency limits are per role; another role has not used this window.
        deltaMinor > 0 ? 0 : scalesInWindow,
      ),
  );

  const base = { increasePct, deltaMinor, limit, maxAllowedDailyMinor, scalesInWindow };

  /* ---- No change --------------------------------------------------------- */

  if (deltaMinor === 0) {
    return {
      ...base,
      decision: 'ALLOW',
      reasonCodes: ['NO_CHANGE'],
      approverRoles: [],
      messageDe: 'Das Tagesbudget bleibt unverändert.',
    };
  }

  /* ---- Decrease ---------------------------------------------------------- */

  if (deltaMinor < 0) {
    if (limit.mayPause) {
      return {
        ...base,
        decision: 'ALLOW',
        reasonCodes: ['DECREASE_WITHIN_AUTHORITY'],
        approverRoles: [],
        messageDe: `Budgetsenkung auf ${formatMoneyDe(money(proposedDailyMinor, currency))} pro Tag liegt in der Befugnis der Rolle ${ROLE_LABELS_DE[input.role]}.`,
      };
    }
    return {
      ...base,
      decision: 'REFUSE',
      reasonCodes: ['DECREASE_NOT_PERMITTED'],
      approverRoles,
      messageDe: `Die Rolle ${ROLE_LABELS_DE[input.role]} darf Budgets nicht senken oder pausieren. Freigeben können: ${roleLabelsDe(approverRoles)}.`,
    };
  }

  /* ---- Increase ---------------------------------------------------------- */

  const reasonCodes: BudgetReasonCode[] = [];

  if (policy.accountMaxDailyBudgetMinor !== null && proposedDailyMinor > policy.accountMaxDailyBudgetMinor) {
    return {
      ...base,
      decision: 'REFUSE',
      reasonCodes: ['ACCOUNT_LIMIT_EXCEEDED'],
      approverRoles: [],
      messageDe: `Das vorgeschlagene Tagesbudget von ${formatMoneyDe(money(proposedDailyMinor, currency))} überschreitet das Kontolimit von ${formatMoneyDe(money(policy.accountMaxDailyBudgetMinor, currency))}. Keine Rolle kann das freigeben — das Limit muss zuerst in den Einstellungen durch einen ${ROLE_LABELS_DE.ADMIN} angehoben werden.`,
    };
  }

  if (currentDailyMinor <= 0) {
    return {
      ...base,
      decision: 'REFUSE',
      reasonCodes: ['NO_CURRENT_BUDGET'],
      approverRoles,
      messageDe:
        'Es ist kein aktuelles Tagesbudget hinterlegt. Ein Startbudget wird beim Launch gesetzt, nicht über eine Skalierung.',
    };
  }

  if (limit.maxSingleIncreasePct <= 0) {
    return {
      ...base,
      decision: 'REFUSE',
      reasonCodes: ['ROLE_MAY_NOT_SCALE'],
      approverRoles,
      messageDe:
        approverRoles.length > 0
          ? `Die Rolle ${ROLE_LABELS_DE[input.role]} darf Budgets nicht erhöhen. Freigeben können: ${roleLabelsDe(approverRoles)}.`
          : `Die Rolle ${ROLE_LABELS_DE[input.role]} darf Budgets nicht erhöhen.`,
    };
  }

  if (increasePct > limit.maxSingleIncreasePct) {
    reasonCodes.push('SINGLE_INCREASE_LIMIT_EXCEEDED');
  }
  if (proposedDailyMinor > limit.maxDailyBudgetMinor) {
    reasonCodes.push('DAILY_BUDGET_CEILING_EXCEEDED');
  }
  if (scalesInWindow >= limit.maxScalesPer24h) {
    reasonCodes.push('SCALE_COOLDOWN_ACTIVE');
  }

  if (reasonCodes.length > 0) {
    const details: string[] = [];
    if (reasonCodes.includes('SINGLE_INCREASE_LIMIT_EXCEEDED')) {
      details.push(
        `Die Erhöhung um ${Math.round(increasePct * 100)} % überschreitet das Einzelschritt-Limit von ${Math.round(limit.maxSingleIncreasePct * 100)} %`,
      );
    }
    if (reasonCodes.includes('DAILY_BUDGET_CEILING_EXCEEDED')) {
      details.push(
        `das Ergebnis von ${formatMoneyDe(money(proposedDailyMinor, currency))} überschreitet die Tagesobergrenze von ${formatMoneyDe(money(limit.maxDailyBudgetMinor, currency))}`,
      );
    }
    if (reasonCodes.includes('SCALE_COOLDOWN_ACTIVE')) {
      details.push(
        `es wurden bereits ${scalesInWindow} von ${limit.maxScalesPer24h} zulässigen Skalierungen in den letzten ${policy.cooldownHours} Stunden vorgenommen`,
      );
    }

    return {
      ...base,
      decision: 'REFUSE',
      reasonCodes,
      approverRoles,
      messageDe:
        approverRoles.length > 0
          ? `Budgeterhöhung abgelehnt: ${details.join('; ')}. Maximal zulässig wären derzeit ${formatMoneyDe(money(maxAllowedDailyMinor, currency))} pro Tag. Freigeben können: ${roleLabelsDe(approverRoles)}.`
          : `Budgeterhöhung abgelehnt: ${details.join('; ')}. Maximal zulässig wären derzeit ${formatMoneyDe(money(maxAllowedDailyMinor, currency))} pro Tag.`,
    };
  }

  /* ---- Within limits: allow or require an approval ------------------------ */

  const approvalThreshold =
    policy.requiresApprovalAboveDailyMinor ?? Math.floor(limit.maxDailyBudgetMinor / 2);

  const approvalReasons: BudgetReasonCode[] = [];
  if (increasePct > policy.requiresApprovalAbovePct) approvalReasons.push('APPROVAL_REQUIRED_LARGE_STEP');
  if (proposedDailyMinor > approvalThreshold) approvalReasons.push('APPROVAL_REQUIRED_HIGH_BUDGET');

  if (approvalReasons.length > 0) {
    return {
      ...base,
      decision: 'REQUIRES_APPROVAL',
      reasonCodes: approvalReasons,
      approverRoles,
      messageDe: `Die Erhöhung auf ${formatMoneyDe(money(proposedDailyMinor, currency))} pro Tag (+${Math.round(increasePct * 100)} %) liegt innerhalb des Rollenlimits, benötigt aber eine dokumentierte Budget-Freigabe vor der Ausführung.`,
    };
  }

  return {
    ...base,
    decision: 'ALLOW',
    reasonCodes: ['WITHIN_AUTHORITY'],
    approverRoles: [],
    messageDe: `Die Erhöhung auf ${formatMoneyDe(money(proposedDailyMinor, currency))} pro Tag (+${Math.round(increasePct * 100)} %) liegt in der Befugnis der Rolle ${ROLE_LABELS_DE[input.role]}.`,
  };
}
