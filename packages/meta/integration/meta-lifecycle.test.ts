/**
 * End-to-end contract test for the draft → command → reconcile lifecycle,
 * against the fixture provider. No network.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_BUDGET_LIMITS,
  type DomainError,
  SAFE_DEFAULT_FLAGS,
  externalCommandSchema,
  isProviderConfirmed,
} from '@am/domain';
import type { DraftCreationResult } from '../src/index';
import {
  FIXTURE_PAGE_ID,
  FIXTURE_PIXEL_ID,
  FixtureMetaProvider,
  allDraftObjects,
  buildDraftPlan,
  confirmCommand,
  createInMemoryCommandLedger,
  createInMemoryDraftStore,
  executeCommand,
  newCommand,
  proposeScaledBudget,
  reconcile,
  summarizeDraftResult,
} from '../src/index';

const NOW = '2026-06-30T10:00:00.000Z';
const COMMAND_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ACTOR_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const CAMPAIGN_ID = 'cccccccc-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = 'campaign-v3-draft-2026-06-30';

const WRITES_ON = {
  ...SAFE_DEFAULT_FLAGS,
  demoMode: false,
  externalWritesEnabled: true,
  metaMutationsEnabled: true,
};

const LEAD_LIMITS = DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD;

function plan(idempotencyKey = IDEMPOTENCY_KEY) {
  return buildDraftPlan({
    idempotencyKey,
    apiVersion: 'v23.0',
    adAccountId: '1094732810554371',
    currency: 'EUR',
    now: NOW,
    campaign: {
      name: 'Potenzialanalyse Handwerk',
      objective: 'OUTCOME_LEADS',
      dailyBudgetMinor: null,
    },
    adSets: [
      {
        key: 'as_kalt',
        name: 'Kaltpublikum',
        dailyBudgetMinor: 15_000,
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        targeting: { countries: ['DE'], ageMin: 30, ageMax: 60 },
        startTime: '2026-07-01T06:00:00.000Z',
      },
      {
        key: 'as_lookalike',
        name: 'Lookalike 1 %',
        dailyBudgetMinor: 10_000,
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        targeting: { countries: ['DE'] },
        startTime: '2026-07-01T06:00:00.000Z',
      },
    ],
    creatives: [
      {
        key: 'cr_problem',
        name: 'Problem/Schmerz',
        primaryText: 'Ihre Auslastung schwankt, Ihre Fixkosten nicht. Das lässt sich rechnen.',
        headline: 'Kostenlose Potenzialanalyse',
        callToAction: 'LEARN_MORE',
        imageHash: 'hash-problem',
      },
      {
        key: 'cr_beweis',
        name: 'Beweis/Fallstudie',
        primaryText: 'Wie ein Handwerksbetrieb mit 24 Mitarbeitenden seine Auslastung planbar machte.',
        headline: 'Fallstudie ansehen',
        callToAction: 'LEARN_MORE',
        imageHash: 'hash-beweis',
      },
    ],
    ads: [
      { key: 'ad_1', name: 'Problem · Kalt', adSetKey: 'as_kalt', creativeKey: 'cr_problem' },
      { key: 'ad_2', name: 'Beweis · Kalt', adSetKey: 'as_kalt', creativeKey: 'cr_beweis' },
      { key: 'ad_3', name: 'Problem · LAL', adSetKey: 'as_lookalike', creativeKey: 'cr_problem' },
    ],
    tracking: {
      pixelId: FIXTURE_PIXEL_ID,
      pageId: FIXTURE_PAGE_ID,
      destinationBaseUrl: 'https://funnel.am-beratung.de/potenzialanalyse',
      launchToken: 'signed.launch.token',
      utm: { campaign: 'potenzialanalyse-handwerk' },
      campaignId: CAMPAIGN_ID,
    },
  });
}

function draftCommand(idempotencyKey = IDEMPOTENCY_KEY) {
  return newCommand({
    id: COMMAND_ID,
    kind: 'CREATE_DRAFT_CAMPAIGN',
    idempotencyKey,
    requestedBy: ACTOR_ID,
    requestedAt: NOW,
    campaignId: CAMPAIGN_ID,
    input: { draftPlan: plan(idempotencyKey) },
  });
}

/* -------------------------------------------------------------------------- */

describe('draft creation through the command lifecycle', () => {
  it('blocks by flag and describes the exact payload it would have sent', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const command = confirmCommand(draftCommand());

    const result = await executeCommand(command, provider, SAFE_DEFAULT_FLAGS, { now: NOW });

    expect(result.command.state).toBe('BLOCKED_BY_FLAG');
    expect(isProviderConfirmed(result.command)).toBe(false);
    expect(result.dryRun?.dryRun).toBe(true);
    expect(result.dryRun?.provider).toBe('META');
    expect(result.outcome).toBeNull();
    expect(await provider.findDraftByIdempotencyKey(IDEMPOTENCY_KEY)).toBeNull();
  });

  it('creates every object PAUSED and reaches PROVIDER_CONFIRMED', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const command = confirmCommand(draftCommand());

    const result = await executeCommand(command, provider, WRITES_ON, {
      now: NOW,
      draftStore: createInMemoryDraftStore(),
    });

    expect(result.command.state).toBe('PROVIDER_CONFIRMED');
    expect(isProviderConfirmed(result.command)).toBe(true);
    expect(() => externalCommandSchema.parse(result.command)).not.toThrow();

    const draft = result.outcome as DraftCreationResult;
    const objects = allDraftObjects(draft);

    // 1 campaign + 2 ad sets + 2 creatives + 3 ads.
    expect(objects).toHaveLength(8);
    expect(objects.every((object) => object.status === 'PAUSED')).toBe(true);

    const summary = summarizeDraftResult(draft);
    expect(summary.all_paused).toBe(true);
    expect(summary.ad_ids).toHaveLength(3);
  });

  it('reconciles a draft without a single target object', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const executed = await executeCommand(confirmCommand(draftCommand()), provider, WRITES_ON, {
      now: NOW,
    });

    const reconciled = await reconcile(executed.command, provider, { now: NOW });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.command.state).toBe('RECONCILED');
    expect(reconciled.command.reconciledAt).toBe(NOW);
  });

  it('never creates a second campaign when the command is retried', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const ledger = createInMemoryCommandLedger();
    const draftStore = createInMemoryDraftStore();
    const command = confirmCommand(draftCommand());

    const first = await executeCommand(command, provider, WRITES_ON, {
      now: NOW,
      ledger,
      draftStore,
    });
    const retry = await executeCommand(command, provider, WRITES_ON, {
      now: NOW,
      ledger,
      draftStore,
    });

    expect(first.idempotentReplay).toBe(false);
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.outcome).toEqual(first.outcome);

    // And a fresh command record with the same key still resolves to one draft.
    const third = await executeCommand(
      confirmCommand(draftCommand()),
      provider,
      WRITES_ON,
      { now: NOW, ledger, draftStore },
    );
    expect(third.outcome).toEqual(first.outcome);
  });
});

/* -------------------------------------------------------------------------- */

describe('steering a live campaign', () => {
  async function liveAdSet(provider: FixtureMetaProvider) {
    const adSets = await provider.importAdSets({ limit: 100 });
    const active = adSets.items.find((adSet) => adSet.status === 'ACTIVE');
    if (!active) throw new Error('fixture has no live ad set');
    return active;
  }

  it('scales by the default +20 % and reconciles against the new budget', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const adSet = await liveAdSet(provider);
    const current = adSet.dailyBudget?.amountMinor ?? 0;
    const requested = proposeScaledBudget(current);

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'INCREASE_BUDGET',
      idempotencyKey: `scale-${adSet.externalId}-2026-06-30`,
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: {
        target: { level: 'ADSET', externalId: adSet.externalId },
        currentDailyBudgetMinor: current,
        dailyBudgetMinor: requested,
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
    expect(reconciled.snapshot?.dailyBudget?.amountMinor).toBe(requested);
  });

  it('refuses a second scale inside 24 hours rather than clamping it', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const adSet = await liveAdSet(provider);
    const current = adSet.dailyBudget?.amountMinor ?? 0;

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'INCREASE_BUDGET',
      idempotencyKey: `scale-again-${adSet.externalId}`,
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: {
        target: { level: 'ADSET', externalId: adSet.externalId },
        currentDailyBudgetMinor: current,
        dailyBudgetMinor: proposeScaledBudget(current),
        currency: 'EUR',
      },
    });

    const result = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
      budget: { limits: LEAD_LIMITS, scalesInLast24h: 1 },
    });

    expect(result.command.state).toBe('FAILED');
    expect(result.errorCode).toBe('BUDGET_LIMIT_EXCEEDED');
    const snapshot = await provider.getEntity({ level: 'ADSET', externalId: adSet.externalId });
    expect(snapshot?.dailyBudget?.amountMinor).toBe(current);
  });

  it('pauses a creative by pausing the ad that carries it', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    const ads = await provider.importAds({ limit: 100 });
    const active = ads.items.find((ad) => ad.status === 'ACTIVE');
    if (!active) throw new Error('fixture has no live ad');

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'PAUSE_CREATIVE',
      idempotencyKey: `pause-creative-${active.externalId}`,
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: {
        adExternalId: active.externalId,
        creativeExternalId: active.creativeExternalId,
      },
    });

    const executed = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
    });
    expect(executed.command.state).toBe('PROVIDER_CONFIRMED');

    const reconciled = await reconcile(executed.command, provider, { now: NOW });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.snapshot?.status).toBe('PAUSED');
  });

  it('surfaces a rate limit as PROVIDER_RATE_LIMITED after backing off', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON, simulateRateLimit: true });
    const slept: number[] = [];

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'PAUSE_ENTITY',
      idempotencyKey: 'pause-throttled',
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: { target: { level: 'ADSET', externalId: '23852000000100000' } },
    });

    const result = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 2_000,
        maxDelayMs: 10_000,
        jitterRatio: 0,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    });

    expect(result.command.state).toBe('FAILED');
    expect(result.errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(result.errorDe).toContain('Anfragelimit');
    // Meta's hint (1 s in the fixture) is honoured, twice, before giving up.
    expect(slept).toEqual([1_000, 1_000]);
    expect(result.backoffDelaysMs).toEqual([1_000, 1_000]);
  });

  it('reports a permission error in German and leaves the command FAILED', async () => {
    const provider = new FixtureMetaProvider({
      flags: WRITES_ON,
      simulatePermissionError: true,
    });

    const command = newCommand({
      id: COMMAND_ID,
      kind: 'PAUSE_ENTITY',
      idempotencyKey: 'pause-forbidden',
      requestedBy: ACTOR_ID,
      requestedAt: NOW,
      input: { target: { level: 'ADSET', externalId: '23852000000100000' } },
    });

    const result = await executeCommand(confirmCommand(command), provider, WRITES_ON, {
      now: NOW,
    });

    expect(result.command.state).toBe('FAILED');
    expect(result.errorCode).toBe('FORBIDDEN');
    expect(result.command.error).toBe(
      'Meta hat den Zugriff verweigert: Dem verbundenen Konto fehlen die erforderlichen Berechtigungen für dieses Werbekonto.',
    );
    expect(result.backoffDelaysMs).toEqual([]);
    expect(isProviderConfirmed(result.command)).toBe(false);
  });

  it('refuses to reconcile a command that was never confirmed', async () => {
    const provider = new FixtureMetaProvider({ flags: WRITES_ON });
    let thrown: unknown;
    try {
      await reconcile(confirmCommand(draftCommand()), provider, { now: NOW });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DomainError).code).toBe('CONFLICT');
  });
});
