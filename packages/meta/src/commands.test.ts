import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_BUDGET_LIMITS,
  SAFE_DEFAULT_FLAGS,
  externalCommandSchema,
} from '@am/domain';
import {
  COMMAND_TRANSITIONS,
  canTransitionCommand,
  confirmCommand,
  createInMemoryCommandLedger,
  executeCommand,
  guardBudgetChange,
  newCommand,
  parseCommandInput,
  proposeScaledBudget,
  reconcile,
} from './commands';
import { FixtureMetaProvider } from './fixture-provider';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-06-30T10:00:00.000Z';

const WRITES_ON = {
  ...SAFE_DEFAULT_FLAGS,
  demoMode: false,
  externalWritesEnabled: true,
  metaMutationsEnabled: true,
};

const LEAD_LIMITS = DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD;
const OPERATOR_LIMITS = DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_OPERATOR;

/* -------------------------------------------------------------------------- */

describe('budget guards', () => {
  it('allows the default +20 % step', () => {
    const current = 20_000;
    const requested = proposeScaledBudget(current);
    expect(requested).toBe(24_000);

    const verdict = guardBudgetChange({
      currentDailyBudgetMinor: current,
      requestedDailyBudgetMinor: requested,
      limits: LEAD_LIMITS,
      scalesInLast24h: 0,
      now: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('refuses a larger step rather than clamping it', () => {
    const verdict = guardBudgetChange({
      currentDailyBudgetMinor: 20_000,
      requestedDailyBudgetMinor: 40_000,
      limits: LEAD_LIMITS,
      scalesInLast24h: 0,
      now: NOW,
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.error.code).toBe('BUDGET_LIMIT_EXCEEDED');
    expect(verdict.error.messageDe).toContain('nicht gekürzt');
    // Crucially: no clamped value is offered anywhere in the verdict.
    expect(verdict.error.details.requested).toBe(40_000);
  });

  it('refuses a target above the role ceiling', () => {
    const verdict = guardBudgetChange({
      currentDailyBudgetMinor: LEAD_LIMITS.maxDailyBudgetMinor,
      requestedDailyBudgetMinor: LEAD_LIMITS.maxDailyBudgetMinor + 1_000,
      limits: LEAD_LIMITS,
      now: NOW,
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.error.code).toBe('BUDGET_LIMIT_EXCEEDED');
  });

  it('allows at most one scale per 24 hours for a marketing lead', () => {
    const already = guardBudgetChange({
      currentDailyBudgetMinor: 20_000,
      requestedDailyBudgetMinor: 24_000,
      limits: LEAD_LIMITS,
      scalesInLast24h: 1,
      now: NOW,
    });
    expect(already.allowed).toBe(false);

    const cooling = guardBudgetChange({
      currentDailyBudgetMinor: 20_000,
      requestedDailyBudgetMinor: 24_000,
      limits: LEAD_LIMITS,
      scalesInLast24h: 0,
      lastScaleAt: '2026-06-30T02:00:00.000Z',
      now: NOW,
    });
    expect(cooling.allowed).toBe(false);
    if (cooling.allowed) throw new Error('unreachable');
    expect(cooling.error.messageDe).toContain('24 Stunden');
  });

  it('permits a decrease only for roles that may pause', () => {
    expect(
      guardBudgetChange({
        currentDailyBudgetMinor: 20_000,
        requestedDailyBudgetMinor: 10_000,
        limits: LEAD_LIMITS,
        now: NOW,
      }).allowed,
    ).toBe(true);

    const refused = guardBudgetChange({
      currentDailyBudgetMinor: 20_000,
      requestedDailyBudgetMinor: 10_000,
      limits: OPERATOR_LIMITS,
      now: NOW,
    });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error('unreachable');
    expect(refused.error.code).toBe('FORBIDDEN');
  });

  it('refuses a relative increase from a zero budget', () => {
    const verdict = guardBudgetChange({
      currentDailyBudgetMinor: 0,
      requestedDailyBudgetMinor: 5_000,
      limits: LEAD_LIMITS,
      now: NOW,
    });
    expect(verdict.allowed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('command lifecycle', () => {
  function pauseCommand() {
    return newCommand({
      id: COMMAND_ID,
      kind: 'PAUSE_ENTITY',
      idempotencyKey: 'pause-adset-2385200100000000',
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: { target: { level: 'ADSET', externalId: '2385200100000000' } },
    });
  }

  it('produces a command that satisfies the domain schema', () => {
    expect(() => externalCommandSchema.parse(pauseCommand())).not.toThrow();
    expect(pauseCommand().state).toBe('PENDING_CONFIRMATION');
    expect(parseCommandInput(pauseCommand()).target?.externalId).toBe('2385200100000000');
  });

  it('only allows the documented transitions', () => {
    expect(canTransitionCommand('PENDING_CONFIRMATION', 'QUEUED')).toBe(true);
    expect(canTransitionCommand('QUEUED', 'PROVIDER_CONFIRMED')).toBe(false);
    expect(canTransitionCommand('PROVIDER_CONFIRMED', 'RECONCILED')).toBe(true);
    expect(COMMAND_TRANSITIONS.RECONCILED).toEqual([]);
  });

  it('refuses to execute an unconfirmed command', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const result = await executeCommand(pauseCommand(), provider, WRITES_ON, { now: NOW });

    expect(result.errorCode).toBe('APPROVAL_REQUIRED');
    expect(result.command.state).toBe('PENDING_CONFIRMATION');
    expect(result.outcome).toBeNull();
  });

  it('blocks by flag instead of failing, and describes what would have been sent', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const result = await executeCommand(
      confirmCommand(pauseCommand()),
      provider,
      SAFE_DEFAULT_FLAGS,
      { now: NOW },
    );

    expect(result.command.state).toBe('BLOCKED_BY_FLAG');
    expect(result.dryRun?.dryRun).toBe(true);
    expect(result.dryRun?.wouldSend).toMatchObject({
      kind: 'PAUSE_ENTITY',
      target: { level: 'ADSET', externalId: '2385200100000000' },
    });
    expect(result.outcome).toBeNull();
    // Nothing changed at the provider.
    const snapshot = await provider.getEntity({ level: 'ADSET', externalId: '2385200100000000' });
    expect(snapshot?.status).toBe('PAUSED');
  });

  it('reaches PROVIDER_CONFIRMED and then RECONCILED', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    // The last fixture campaign is still running, so its ad set is ACTIVE.
    const adSets = await provider.importAdSets({ limit: 100 });
    const active = adSets.items.find((adSet) => adSet.status === 'ACTIVE');
    expect(active).toBeDefined();

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'PAUSE_ENTITY',
      idempotencyKey: `pause-${active?.externalId}`,
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: { target: { level: 'ADSET', externalId: active?.externalId ?? '' } },
    });

    const executed = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
    });
    expect(executed.command.state).toBe('PROVIDER_CONFIRMED');
    expect(executed.command.confirmedAt).toBe(NOW);
    expect(executed.command.attemptCount).toBe(1);
    expect(executed.errorDe).toBeNull();

    const reconciled = await reconcile(executed.command, provider, { now: NOW });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.command.state).toBe('RECONCILED');
    expect(reconciled.snapshot?.status).toBe('PAUSED');
    expect(reconciled.discrepancy).toBeNull();
  });

  it('reports a discrepancy when the change did not take effect', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const adSets = await provider.importAdSets({ limit: 100 });
    const active = adSets.items.find((adSet) => adSet.status === 'ACTIVE');

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'RESUME_ENTITY',
      idempotencyKey: `resume-${active?.externalId}`,
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: { target: { level: 'ADSET', externalId: active?.externalId ?? '' } },
    });

    const executed = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
    });
    expect(executed.command.state).toBe('PROVIDER_CONFIRMED');

    // Someone (or Meta) pauses it again behind our back.
    await provider.pauseEntity({
      ref: { level: 'ADSET', externalId: active?.externalId ?? '' },
      idempotencyKey: 'external-change',
    });

    const reconciled = await reconcile(executed.command, provider, { now: NOW });
    expect(reconciled.ok).toBe(false);
    expect(reconciled.discrepancy?.kind).toBe('STATUS_MISMATCH');
    expect(reconciled.discrepancy?.expected).toBe('ACTIVE');
    expect(reconciled.discrepancy?.actual).toBe('PAUSED');
    expect(reconciled.command.state).toBe('PROVIDER_CONFIRMED');
  });

  it('refuses a budget command that exceeds the role limit before touching Meta', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const command = newCommand({
      id: COMMAND_ID,
      kind: 'INCREASE_BUDGET',
      idempotencyKey: 'scale-2385200100000000',
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: {
        target: { level: 'ADSET', externalId: '2385200100000000' },
        currentDailyBudgetMinor: 20_000,
        dailyBudgetMinor: 40_000,
        currency: 'EUR',
      },
    });

    const result = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
      budget: { limits: LEAD_LIMITS, scalesInLast24h: 0 },
    });

    expect(result.command.state).toBe('FAILED');
    expect(result.errorCode).toBe('BUDGET_LIMIT_EXCEEDED');
    const snapshot = await provider.getEntity({ level: 'ADSET', externalId: '2385200100000000' });
    expect(snapshot?.dailyBudget?.amountMinor).not.toBe(40_000);
  });

  it('applies an allowed budget change and reconciles against the new value', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const command = newCommand({
      id: COMMAND_ID,
      kind: 'INCREASE_BUDGET',
      idempotencyKey: 'scale-ok-2385200100000000',
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: {
        target: { level: 'ADSET', externalId: '2385200100000000' },
        currentDailyBudgetMinor: 20_000,
        dailyBudgetMinor: 24_000,
        currency: 'EUR',
      },
    });

    const executed = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
      budget: { limits: LEAD_LIMITS, scalesInLast24h: 0 },
    });
    expect(executed.command.state).toBe('PROVIDER_CONFIRMED');

    const reconciled = await reconcile(executed.command, provider, { now: NOW });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.snapshot?.dailyBudget?.amountMinor).toBe(24_000);
  });

  it('is idempotent under retry: the same key never produces a second call', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const ledger = createInMemoryCommandLedger();
    const command = confirmCommand(pauseCommand());

    const first = await executeCommand(command, provider, WRITES_ON, { now: NOW, ledger });
    expect(first.idempotentReplay).toBe(false);
    expect(first.command.state).toBe('PROVIDER_CONFIRMED');

    // A retry of the *original* record, as a job runner would perform it.
    const second = await executeCommand(command, provider, WRITES_ON, { now: NOW, ledger });
    expect(second.idempotentReplay).toBe(true);
    expect(second.command.state).toBe('PROVIDER_CONFIRMED');
    expect(second.outcome).toEqual(first.outcome);
  });
});
