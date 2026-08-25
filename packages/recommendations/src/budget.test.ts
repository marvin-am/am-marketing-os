import { DEFAULT_ROLE_BUDGET_LIMITS, type Role } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_POLICY,
  evaluateBudgetChange,
  maxAllowedDailyBudget,
  type BudgetChangeInput,
} from './budget';

const NOW = '2026-04-01T12:00:00.000Z';

function hoursBefore(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
}

function decide(overrides: Partial<BudgetChangeInput> = {}) {
  return evaluateBudgetChange({
    role: 'MARKETING_LEAD',
    currentDailyMinor: 10_000,
    proposedDailyMinor: 12_000,
    now: NOW,
    ...overrides,
  });
}

describe('evaluateBudgetChange — allow', () => {
  it('allows the standard +20 % step for a MARKETING_LEAD', () => {
    const decision = decide();
    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasonCodes).toEqual(['WITHIN_AUTHORITY']);
    expect(decision.increasePct).toBeCloseTo(0.2, 10);
    expect(decision.deltaMinor).toBe(2_000);
    expect(decision.messageDe).toContain('Marketing-Lead');
  });

  it('allows an unchanged budget', () => {
    const decision = decide({ proposedDailyMinor: 10_000 });
    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasonCodes).toEqual(['NO_CHANGE']);
    expect(decision.increasePct).toBe(0);
  });

  it('allows a decrease for a role that may pause', () => {
    const decision = decide({ proposedDailyMinor: 6_000 });
    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasonCodes).toEqual(['DECREASE_WITHIN_AUTHORITY']);
    expect(decision.deltaMinor).toBe(-4_000);
  });
});

describe('evaluateBudgetChange — refuse and route', () => {
  it('refuses an over-limit increase for MARKETING_LEAD and routes it to EXECUTIVE', () => {
    const decision = decide({ proposedDailyMinor: 18_000 }); // +80 %
    expect(decision.decision).toBe('REFUSE');
    expect(decision.reasonCodes).toContain('SINGLE_INCREASE_LIMIT_EXCEEDED');
    expect(decision.approverRoles).toContain('EXECUTIVE');
    expect(decision.messageDe).toContain('Geschäftsführung');
    // Refused, not clamped: the proposal is rejected outright.
    expect(decision.maxAllowedDailyMinor).toBe(12_000);
  });

  it('states the maximum it would have allowed without applying it', () => {
    const decision = decide({ proposedDailyMinor: 40_000 });
    expect(decision.decision).toBe('REFUSE');
    // 12 000 minor units = 120,00 €, the ceiling it would have permitted.
    expect(decision.messageDe).toContain('120,00');
    // The decision object never carries a silently reduced proposal.
    expect(decision).not.toHaveProperty('clampedProposal');
  });

  it('refuses when the resulting budget exceeds the role ceiling', () => {
    // EXECUTIVE may go to 200 000,00 € per day; 210 000,00 € is past that.
    const decision = decide({
      role: 'EXECUTIVE',
      currentDailyMinor: 19_000_000,
      proposedDailyMinor: 21_000_000,
    });
    expect(decision.decision).toBe('REFUSE');
    expect(decision.reasonCodes).toContain('DAILY_BUDGET_CEILING_EXCEEDED');
  });

  it('refuses any increase for a role without scale authority', () => {
    for (const role of ['VIEWER', 'MARKETING_OPERATOR', 'CREATIVE_REVIEWER', 'REVOPS'] as Role[]) {
      const decision = decide({ role, proposedDailyMinor: 10_500 });
      expect(decision.decision).toBe('REFUSE');
      expect(decision.reasonCodes).toEqual(['ROLE_MAY_NOT_SCALE']);
      expect(decision.approverRoles).toEqual(expect.arrayContaining(['MARKETING_LEAD', 'EXECUTIVE', 'ADMIN']));
    }
  });

  it('refuses a decrease for a role that may not pause, naming who may', () => {
    const decision = decide({ role: 'MARKETING_OPERATOR', proposedDailyMinor: 5_000 });
    expect(decision.decision).toBe('REFUSE');
    expect(decision.reasonCodes).toEqual(['DECREASE_NOT_PERMITTED']);
    expect(decision.approverRoles).toEqual(expect.arrayContaining(['MARKETING_LEAD', 'EXECUTIVE', 'ADMIN']));
  });

  it('refuses once the rolling scale limit is used up', () => {
    const decision = decide({ recentScales: [{ at: hoursBefore(3) }] });
    expect(decision.decision).toBe('REFUSE');
    expect(decision.reasonCodes).toContain('SCALE_COOLDOWN_ACTIVE');
    expect(decision.scalesInWindow).toBe(1);
    expect(decision.messageDe).toContain('24 Stunden');
  });

  it('ignores scale actions outside the rolling window', () => {
    const decision = decide({ recentScales: [{ at: hoursBefore(30) }] });
    expect(decision.decision).toBe('ALLOW');
    expect(decision.scalesInWindow).toBe(0);
  });

  it('lets EXECUTIVE scale more often than MARKETING_LEAD', () => {
    const scales = [{ at: hoursBefore(2) }, { at: hoursBefore(5) }];
    expect(decide({ recentScales: scales }).decision).toBe('REFUSE');
    expect(decide({ role: 'EXECUTIVE', recentScales: scales }).decision).toBe('ALLOW');
  });

  it('refuses an increase past the account limit with nobody able to approve', () => {
    const decision = decide({
      role: 'ADMIN',
      proposedDailyMinor: 11_000,
      policy: { ...DEFAULT_BUDGET_POLICY, accountMaxDailyBudgetMinor: 10_500 },
    });
    expect(decision.decision).toBe('REFUSE');
    expect(decision.reasonCodes).toEqual(['ACCOUNT_LIMIT_EXCEEDED']);
    expect(decision.approverRoles).toEqual([]);
    expect(decision.messageDe).toContain('Administrator');
  });

  it('refuses a scale from a zero budget instead of dividing by zero', () => {
    const decision = decide({ currentDailyMinor: 0, proposedDailyMinor: 5_000 });
    expect(decision.decision).toBe('REFUSE');
    expect(decision.reasonCodes).toEqual(['NO_CURRENT_BUDGET']);
    expect(decision.increasePct).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('evaluateBudgetChange — requires approval', () => {
  it('requires an approval for a large step inside the role limit', () => {
    const decision = decide({ role: 'EXECUTIVE', proposedDailyMinor: 15_000 }); // +50 %
    expect(decision.decision).toBe('REQUIRES_APPROVAL');
    expect(decision.reasonCodes).toContain('APPROVAL_REQUIRED_LARGE_STEP');
    expect(decision.messageDe).toContain('Budget-Freigabe');
  });

  it('requires an approval for a high resulting budget even at a small step', () => {
    const decision = decide({
      role: 'MARKETING_LEAD',
      currentDailyMinor: 1_500_000,
      proposedDailyMinor: 1_650_000, // +10 %, but above half the role ceiling
    });
    expect(decision.decision).toBe('REQUIRES_APPROVAL');
    expect(decision.reasonCodes).toContain('APPROVAL_REQUIRED_HIGH_BUDGET');
  });

  it('honours an explicit approval threshold', () => {
    const decision = decide({
      policy: { ...DEFAULT_BUDGET_POLICY, requiresApprovalAboveDailyMinor: 11_000 },
    });
    expect(decision.decision).toBe('REQUIRES_APPROVAL');
    expect(decision.reasonCodes).toEqual(['APPROVAL_REQUIRED_HIGH_BUDGET']);
  });
});

describe('maxAllowedDailyBudget', () => {
  it('is the smaller of the step limit and the role ceiling', () => {
    expect(maxAllowedDailyBudget(DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD, 10_000, DEFAULT_BUDGET_POLICY)).toBe(12_000);
    expect(
      maxAllowedDailyBudget(DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD, 1_900_000, DEFAULT_BUDGET_POLICY),
    ).toBe(2_000_000);
  });

  it('respects an account-wide ceiling', () => {
    expect(
      maxAllowedDailyBudget(DEFAULT_ROLE_BUDGET_LIMITS.EXECUTIVE, 10_000, {
        ...DEFAULT_BUDGET_POLICY,
        accountMaxDailyBudgetMinor: 15_000,
      }),
    ).toBe(15_000);
  });
});

describe('evaluateBudgetChange — determinism', () => {
  it('produces identical decisions for identical input', () => {
    const input: BudgetChangeInput = {
      role: 'MARKETING_LEAD',
      currentDailyMinor: 10_000,
      proposedDailyMinor: 18_000,
      now: NOW,
      recentScales: [{ at: hoursBefore(40) }],
    };
    expect(evaluateBudgetChange(input)).toEqual(evaluateBudgetChange(input));
  });

  it('lists approver roles in a stable order', () => {
    const first = decide({ proposedDailyMinor: 18_000 }).approverRoles;
    const second = decide({ proposedDailyMinor: 18_000 }).approverRoles;
    expect(second).toEqual(first);
    expect(first).toEqual(['EXECUTIVE', 'ADMIN']);
  });
});
