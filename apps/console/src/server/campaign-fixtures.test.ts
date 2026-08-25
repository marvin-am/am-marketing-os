import { beforeEach, describe, expect, it } from 'vitest';
import { getFeatureFlags } from '@am/config';
import { canWriteMeta } from '@am/domain';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from './campaign-fixtures';
import type { CampaignPort } from './campaign-port';

/**
 * Contract tests for the write side of the fixture `CampaignPort`.
 *
 * The component tests render props; these exercise the implementation every
 * Campaign Room route actually loads, because the property under test is not
 * "does the button work" but "does anything claim a Meta-side fact that never
 * happened" (AGENTS.md rules 1–3).
 *
 * They assume the repository's default flags, which is the deployment this
 * product ships in: `EXTERNAL_WRITES_ENABLED=false`, no credentials.
 */

const ACTOR = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Marvin Flenche' };

let port: CampaignPort;

beforeEach(() => {
  port = getCampaignPort();
});

describe('feature flags in this environment', () => {
  it('has Meta writes disabled, which is what the rest of this file assumes', () => {
    expect(canWriteMeta(getFeatureFlags())).toBe(false);
  });
});

describe('the step that creates the paused Meta draft', () => {
  /**
   * Creating the draft is a write to an ad account. With writes disabled the
   * step must come back as a dry run — never as a plain success, which is what
   * turns the header into a claim that a draft exists over there.
   */
  it('returns a dry run naming the operation and the full payload', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.metaDraft;
    const before = await port.getHeader(id, false);
    expect(before?.state).toBe('META_DRAFT_CREATED');

    // Walk a campaign that is ready for the draft rather than one already in it.
    const ready = await port.transition({
      campaignId: id,
      to: 'READY_FOR_META_DRAFT',
      actor: ACTOR,
    });
    expect(ready.status).toBe('ok');

    const result = await port.transition({
      campaignId: id,
      to: 'META_DRAFT_CREATED',
      actor: ACTOR,
    });

    expect(result.status).toBe('dry_run');
    if (result.status !== 'dry_run') throw new Error('unreachable');
    expect(result.dryRun.provider).toBe('META');
    expect(result.dryRun.operation).toBe('meta.create_paused_draft_campaign');
    expect(result.dryRun.blockedByDe).toMatch(/nichts angelegt/);

    const campaign = result.dryRun.wouldSend.campaign as Record<string, unknown>;
    expect(campaign.status).toBe('PAUSED');
    // Ids that only a connected ad account can supply are absent, not invented.
    expect(result.dryRun.wouldSend.ad_account_id).toBeNull();
    expect(result.dryRun.wouldSend.pixel_id).toBeNull();
  });

  /** A dry run changed nothing at Meta, so it may not change our record either. */
  it('leaves the campaign in the state it was in', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.metaDraft;
    await port.transition({ campaignId: id, to: 'READY_FOR_META_DRAFT', actor: ACTOR });

    await port.transition({ campaignId: id, to: 'META_DRAFT_CREATED', actor: ACTOR });

    const after = await port.getHeader(id, false);
    expect(after?.state).toBe('READY_FOR_META_DRAFT');
    expect(after?.reality).toBe('DRAFT');
  });

  /** The dialog and the adapter must quote the same request. */
  it('previews exactly the payload the dry run would send', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.metaDraft;
    await port.transition({ campaignId: id, to: 'READY_FOR_META_DRAFT', actor: ACTOR });

    const qa = await port.getLaunchQa(id);
    const preview = qa?.metaWrites.find((write) => write.to === 'META_DRAFT_CREATED');
    expect(preview).toBeDefined();

    const result = await port.transition({
      campaignId: id,
      to: 'META_DRAFT_CREATED',
      actor: ACTOR,
    });
    if (result.status !== 'dry_run') throw new Error('expected a dry run');

    expect(preview?.operation).toBe(result.dryRun.operation);
    expect(preview?.payload).toEqual(result.dryRun.wouldSend);
  });
});

describe('changing the daily budget of a campaign whose budget lives at Meta', () => {
  /**
   * The same operation reached through a recommendation is a Meta command.
   * Reached through the test plan it used to mutate the record and report
   * success, telling the operator a live campaign spends an amount Meta was
   * never asked to deliver at.
   */
  it('produces the dry-run shape of the recommendation path', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.live;
    const header = await port.getHeader(id, false);
    const current = header?.budget.amountMinor ?? 0;

    const result = await port.changeBudget({
      campaignId: id,
      newDailyBudgetMinor: Math.round(current * 1.1),
      reasonDe: 'Kosten je qualifiziertem VQ liegen unter dem Zielwert.',
      actorRoles: ['MARKETING_LEAD'],
      actor: ACTOR,
    });

    expect(result.status).toBe('dry_run');
    if (result.status !== 'dry_run') throw new Error('unreachable');
    expect(result.dryRun.provider).toBe('META');
    expect(result.dryRun.operation).toBe('campaign.update.daily_budget');
    expect(result.dryRun.wouldSend).toEqual({
      campaign_id: expect.any(String),
      daily_budget: Math.round(current * 1.1),
      currency: 'EUR',
    });

    const after = await port.getHeader(id, false);
    expect(after?.budget.amountMinor).toBe(current);
  });

  /** It names the same Meta object the recommendation for this campaign names. */
  it('addresses the campaign the scale recommendation addresses', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.live;
    const views = await port.getRecommendations(id);
    const scale = views.find((view) => view.recommendation.action === 'INCREASE_BUDGET');
    expect(scale).toBeDefined();

    const result = await port.changeBudget({
      campaignId: id,
      newDailyBudgetMinor: 13_200,
      reasonDe: 'Skalierung nach reifer Kohorte.',
      actorRoles: ['MARKETING_LEAD'],
      actor: ACTOR,
    });
    if (result.status !== 'dry_run') throw new Error('expected a dry run');

    expect(result.dryRun.wouldSend.campaign_id).toBe(scale?.requestPreview.campaign_id);
  });

  /** A draft has no Meta object, so its planned budget is ours to change. */
  it('still edits our own record while no Meta object exists', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.strategyReview;
    const result = await port.changeBudget({
      campaignId: id,
      newDailyBudgetMinor: 5_500,
      reasonDe: 'Planungsstand angepasst.',
      actorRoles: ['MARKETING_LEAD'],
      actor: ACTOR,
    });

    expect(result.status).toBe('ok');
    const after = await port.getHeader(id, false);
    expect(after?.budget.amountMinor).toBe(5_500);
  });
});

describe('deciding a recommendation that needs no external action', () => {
  async function collectMoreData(campaignId: string) {
    const views = await port.getRecommendations(campaignId);
    const view = views.find((v) => v.recommendation.action === 'COLLECT_MORE_DATA');
    if (!view) throw new Error('fixture is missing a COLLECT_MORE_DATA recommendation');
    return view;
  }

  /**
   * Executing it is refused, so without a decision path `ACCEPTED` and
   * `DISMISSED` are unreachable and the item never leaves the board.
   */
  it('cannot be executed', async () => {
    const view = await collectMoreData(FIXTURE_CAMPAIGN_IDS.live);
    const result = await port.executeRecommendation({
      campaignId: FIXTURE_CAMPAIGN_IDS.live,
      recommendationId: view.recommendation.id,
      actor: ACTOR,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.code).toBe('NO_EXTERNAL_ACTION');
  });

  it('reaches ACCEPTED', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.live;
    const view = await collectMoreData(id);
    expect(view.recommendation.state).toBe('OPEN');

    const result = await port.decideRecommendation({
      campaignId: id,
      recommendationId: view.recommendation.id,
      decision: 'ACCEPT',
      actor: ACTOR,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.data.recommendation.state).toBe('ACCEPTED');
    expect((await collectMoreData(id)).recommendation.state).toBe('ACCEPTED');
  });

  it('reaches DISMISSED', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.paused;
    const view = await collectMoreData(id);

    const result = await port.decideRecommendation({
      campaignId: id,
      recommendationId: view.recommendation.id,
      decision: 'DISMISS',
      reasonDe: 'Der Arm wird ohnehin abgelöst.',
      actor: ACTOR,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.data.recommendation.state).toBe('DISMISSED');
    expect((await collectMoreData(id)).recommendation.state).toBe('DISMISSED');
  });

  /** Accepting a Meta-touching proposal would imply a change is on its way. */
  it('refuses to accept a recommendation that does touch Meta', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.completed;
    const views = await port.getRecommendations(id);
    const scale = views.find((view) => view.recommendation.action === 'INCREASE_BUDGET');
    expect(scale).toBeDefined();

    const result = await port.decideRecommendation({
      campaignId: id,
      recommendationId: scale!.recommendation.id,
      decision: 'ACCEPT',
      actor: ACTOR,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.code).toBe('EXTERNAL_ACTION_REQUIRED');
  });
});
