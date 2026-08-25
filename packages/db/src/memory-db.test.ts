import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '@am/domain';
import { createIdFactory, createMemoryDatabase, type MemoryDatabase } from './memory-db';
import type { SubmitLeadInput } from './outbox';

const WORKSPACE = '0a11b0a1-0000-4000-8000-000000000001';
const OTHER_WORKSPACE = '0a11b0a2-0000-4000-8000-000000000002';
const ACTOR = '0aaa0001-0000-4000-8000-000000000001';

/**
 * Builds the minimum published funnel the runtime needs, straight into the
 * store: this file tests the store's own guarantees, not its constructors.
 */
function seed(db: MemoryDatabase) {
  const s = db.store;
  const at = '2026-08-01T09:00:00.000Z';

  s.workspaces.push({
    id: WORKSPACE, slug: 'am', name: 'A&M', locale: 'de-DE', default_currency: 'EUR',
    timezone: 'Europe/Berlin', is_active: true, created_at: at, updated_at: at, created_by: null, updated_by: null,
  });
  s.campaigns.push({
    id: 'ca000001-0000-4000-8000-000000000001', workspace_id: WORKSPACE, name: 'Potenzialanalyse', slug: 'potenzialanalyse',
    state: 'LIVE', error_state: null, error_detail_de: null, brand_profile_id: null, audience_segment_id: null,
    service_id: null, offer_id: null, offer_version_id: null, angle_id: null, angle_version_id: null,
    current_version_id: null, core_message: null, hypothesis: null, currency: 'EUR', daily_budget_minor: 22_000,
    test_budget_minor: 1_000_000, target_cpl_minor: 5_400, target_cost_per_qualified_vq_minor: 32_400,
    primary_metric: 'cost_per_qualified_vq', secondary_metrics: [], guardrail_metrics: [],
    attribution_level: 'REVENUE_LINKED', tags: [], planned_start_at: null, planned_end_at: null,
    launched_at: at, paused_at: null, completed_at: null, archived_at: null, imported_from_provider: null,
    imported_external_id: null, created_at: at, updated_at: at, created_by: ACTOR, updated_by: ACTOR,
  });
  s.funnels.push({
    id: 'fu000001-0000-4000-8000-000000000001', workspace_id: WORKSPACE, campaign_id: 'ca000001-0000-4000-8000-000000000001',
    funnel_key: 'funnel_1', kind: 'MULTI_STEP_FORM', name: 'Variante A', promise: null, hypothesis: null,
    rationale: null, current_version_id: null, is_active: true, created_at: at, updated_at: at, created_by: ACTOR, updated_by: null,
  });
  s.funnel_versions.push({
    id: 'fv000001-0000-4000-8000-000000000001', workspace_id: WORKSPACE, funnel_id: 'fu000001-0000-4000-8000-000000000001',
    campaign_id: 'ca000001-0000-4000-8000-000000000001', version: 1, state: 'PUBLISHED', spec: { blocks: [] },
    content_hash: 'a'.repeat(64), form_version_id: null, published_at: at, published_by: ACTOR, archived_at: null,
    created_at: at, updated_at: at, created_by: ACTOR, updated_by: null,
  });
  s.published_funnels.push({
    id: 'pf000001-0000-4000-8000-000000000001', workspace_id: WORKSPACE, campaign_id: 'ca000001-0000-4000-8000-000000000001',
    funnel_id: 'fu000001-0000-4000-8000-000000000001', funnel_version_id: 'fv000001-0000-4000-8000-000000000001',
    form_version_id: null, experiment_id: null, public_slug: 'potenzialanalyse-v1', path: '/', is_live: true,
    environment: 'production', meta_pixel_id: null, meta_dataset_id: null, consent_version_id: null,
    redirect_url: null, published_at: at, unpublished_at: null, created_at: at, updated_at: at,
    created_by: ACTOR, updated_by: null,
  });

  return { campaignId: 'ca000001-0000-4000-8000-000000000001', publishedFunnelId: 'pf000001-0000-4000-8000-000000000001' };
}

function submitInput(attemptId: string, publishedFunnelId: string): SubmitLeadInput {
  return {
    submission_attempt_id: attemptId,
    published_funnel_id: publishedFunnelId,
    consent_status: 'GRANTED',
    consent_purposes: ['CONTACT', 'AD_MEASUREMENT'],
    answers: [
      { field_key: 'mitarbeiterzahl', field_type: 'SINGLE_SELECT', qualification_class: 'SCORING', value_text: '31-60' },
      { field_key: 'zeithorizont', field_type: 'SINGLE_SELECT', qualification_class: 'DISQUALIFYING', value_text: 'sofort' },
    ],
    pii: { key_version: 1, iv: 'aXY=', auth_tag: 'dGFn', ciphertext: 'Y2lwaGVy', email_hash: 'd'.repeat(64) },
    attribution: { channel: 'META_PAID', level: 'LEAD_LINKED', confidence: 'EXACT' },
    outbox: {
      destination: 'HUBSPOT',
      event_id: `lead:${attemptId}`,
      payload_hash: 'e'.repeat(64),
      payload: { objectType: 'CONTACT' },
    },
  };
}

describe('memory database', () => {
  let db: MemoryDatabase;

  beforeEach(() => {
    db = createMemoryDatabase({ idSeed: 1 });
  });

  it('generates deterministic ids', () => {
    const a = createIdFactory(1);
    const b = createIdFactory(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(a()).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
  });

  describe('submission idempotency', () => {
    it('ten concurrent identical submits produce exactly one submission and one outbox row', async () => {
      const { publishedFunnelId } = seed(db);
      const attemptId = 'aa000001-0000-4000-8000-000000000001';

      const results = await Promise.all(
        Array.from({ length: 10 }, () => db.submissions.submitLead(submitInput(attemptId, publishedFunnelId))),
      );

      expect(db.store.form_submissions).toHaveLength(1);
      expect(db.store.outbox_events).toHaveLength(1);
      expect(db.store.attribution_snapshots).toHaveLength(1);
      expect(db.store.submission_pii_encrypted).toHaveLength(1);
      expect(db.store.submission_answers_non_pii).toHaveLength(2);
      expect(db.store.submission_status_history).toHaveLength(1);

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.submission_id)).size).toBe(1);
      expect(new Set(results.map((r) => r.outbox_event_id)).size).toBe(1);
    });

    it('a different attempt id creates a second submission', async () => {
      const { publishedFunnelId } = seed(db);
      await db.submissions.submitLead(submitInput('aa000001-0000-4000-8000-000000000001', publishedFunnelId));
      await db.submissions.submitLead(submitInput('aa000001-0000-4000-8000-000000000002', publishedFunnelId));
      expect(db.store.form_submissions).toHaveLength(2);
      expect(db.store.outbox_events).toHaveLength(2);
    });

    it('links the submission to its frozen attribution snapshot', async () => {
      const { publishedFunnelId, campaignId } = seed(db);
      const result = await db.submissions.submitLead(
        submitInput('aa000001-0000-4000-8000-000000000003', publishedFunnelId),
      );
      const submission = await db.submissions.getSubmission(result.submission_id);
      expect(submission?.attribution_snapshot_id).toBe(result.attribution_snapshot_id);

      const snapshot = await db.attribution.getSnapshot(result.submission_id);
      expect(snapshot?.campaign_id).toBe(campaignId);
      expect(snapshot?.confidence).toBe('EXACT');
      expect(snapshot?.frozen).toBe(true);
    });

    it('rejects an unknown published funnel instead of inventing one', async () => {
      seed(db);
      await expect(
        db.submissions.submitLead(submitInput('aa000001-0000-4000-8000-000000000004', 'ff000000-0000-4000-8000-000000000000')),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('outbox dedup', () => {
    it('enqueuing the same deterministic id twice yields one row', async () => {
      seed(db);
      const input = {
        workspace_id: WORKSPACE,
        destination: 'META_CAPI' as const,
        event_id: 'capi:opp-1:CONVERTED',
        dataset_id: 'DS-1',
        event_name: 'Purchase',
        event_time: '2026-08-20T10:00:00.000Z',
        payload_hash: 'f'.repeat(64),
      };
      const first = await db.outbox.enqueue(input);
      const second = await db.outbox.enqueue(input);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(db.store.outbox_events).toHaveLength(1);
    });

    it('treats a different dataset as a different event', async () => {
      seed(db);
      const base = {
        workspace_id: WORKSPACE,
        destination: 'META_CAPI' as const,
        event_id: 'capi:opp-1:CONVERTED',
        event_name: 'Purchase',
        event_time: '2026-08-20T10:00:00.000Z',
        payload_hash: 'f'.repeat(64),
      };
      await db.outbox.enqueue({ ...base, dataset_id: 'DS-1' });
      await db.outbox.enqueue({ ...base, dataset_id: 'DS-2' });
      expect(db.store.outbox_events).toHaveLength(2);
    });

    it('claims each due event exactly once and marks it PROCESSING', async () => {
      seed(db);
      for (let i = 0; i < 3; i++) {
        await db.outbox.enqueue({
          workspace_id: WORKSPACE,
          destination: 'HUBSPOT',
          event_id: `lead:${i}`,
          event_name: 'contact.upsert',
          event_time: '2026-08-20T10:00:00.000Z',
          payload_hash: 'a'.repeat(64),
        });
      }
      const claimed = await db.outbox.claim({ destination: 'HUBSPOT', limit: 10, worker: 'w1' });
      expect(claimed).toHaveLength(3);
      expect(claimed.every((row) => row.status === 'PROCESSING' && row.locked_by === 'w1')).toBe(true);
      expect(claimed.every((row) => row.attempt_count === 1)).toBe(true);

      // Already PROCESSING, so a second worker gets nothing.
      expect(await db.outbox.claim({ destination: 'HUBSPOT', worker: 'w2' })).toHaveLength(0);
    });

    it('retries, then dead-letters, and reports the decision', async () => {
      seed(db);
      const { event } = await db.outbox.enqueue({
        workspace_id: WORKSPACE,
        destination: 'HUBSPOT',
        event_id: 'lead:flaky',
        event_name: 'contact.upsert',
        event_time: '2026-08-20T10:00:00.000Z',
        payload_hash: 'a'.repeat(64),
      });

      const retried = await db.outbox.markFailed({ ...event, attempt_count: 1 }, 'HubSpot 429');
      expect(retried.decision.status).toBe('FAILED_RETRYING');
      expect(retried.event.next_attempt_at).not.toBeNull();
      expect(retried.event.last_error).toContain('429');

      const exhausted = await db.outbox.markFailed({ ...event, attempt_count: 8 }, 'HubSpot 400');
      expect(exhausted.decision.status).toBe('DEAD_LETTER');
      expect(exhausted.event.next_attempt_at).toBeNull();

      expect(await db.outbox.listDeadLetters(WORKSPACE)).toHaveLength(1);
      expect((await db.outbox.stats(WORKSPACE)).deadLetter).toBe(1);
    });

    it('only marks ACCEPTED when the provider confirmed, not when the request left', async () => {
      seed(db);
      const { event } = await db.outbox.enqueue({
        workspace_id: WORKSPACE,
        destination: 'HUBSPOT',
        event_id: 'lead:sent',
        event_name: 'contact.upsert',
        event_time: '2026-08-20T10:00:00.000Z',
        payload_hash: 'a'.repeat(64),
      });
      expect((await db.outbox.markSent(event.id)).status).toBe('SENT');
      expect((await db.outbox.markAccepted(event.id, { status: 200 })).status).toBe('ACCEPTED');
    });
  });

  describe('experiment assignment stability', () => {
    async function withExperiment() {
      seed(db);
      const experiment = await db.experiments.create({
        workspace_id: WORKSPACE,
        campaign_id: 'ca000001-0000-4000-8000-000000000001',
        kind: 'FUNNEL_EXPERIMENT',
        name: 'Fünf vs. sechs Fragen',
        hypothesis: 'Mehr Qualifizierung senkt die Kosten je qualifiziertem VQ.',
        test_variable: 'Anzahl Fragen',
        primary_metric: 'cost_per_qualified_vq',
        thresholds: {},
        assignment_salt: 'salt-1234',
      });
      const arms = await db.experiments.createArms([
        { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'control', label: 'Kontrolle', is_control: true, allocation: 0.5 },
        { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'variant_b', label: 'Variante B', allocation: 0.5 },
      ]);
      return { experiment, arms };
    }

    it('keeps a visitor on the same arm no matter what a later call proposes', async () => {
      const { experiment, arms } = await withExperiment();
      const visitor = 'v0000001-0000-4000-8000-000000000001';

      const first = await db.experiments.assign(experiment.id, visitor, arms[0].id, 0.12);
      const second = await db.experiments.assign(experiment.id, visitor, arms[1].id, 0.91);

      expect(first).toBe(arms[0].id);
      expect(second).toBe(arms[0].id);
      expect(db.store.experiment_assignments).toHaveLength(1);
    });

    it('records one exposure per session, not per render', async () => {
      const { experiment, arms } = await withExperiment();
      const visitor = 'v0000001-0000-4000-8000-000000000001';
      const session = 's0000001-0000-4000-8000-000000000001';

      expect(await db.experiments.recordExposure(experiment.id, visitor, session, arms[0].id)).toBe(true);
      expect(await db.experiments.recordExposure(experiment.id, visitor, session, arms[0].id)).toBe(false);
      expect(await db.experiments.recordExposure(experiment.id, visitor, 's0000001-0000-4000-8000-000000000002', arms[0].id)).toBe(true);
      expect(db.store.experiment_exposures).toHaveLength(2);
    });

    it('freezes arms once the experiment is running', async () => {
      const { experiment } = await withExperiment();
      await db.experiments.start(experiment.id, ACTOR);
      await expect(
        db.experiments.createArms([
          { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'variant_c', label: 'Variante C', allocation: 0.2 },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_VERSION' });
    });

    it('refuses to start an experiment without a control arm', async () => {
      seed(db);
      const experiment = await db.experiments.create({
        workspace_id: WORKSPACE, campaign_id: 'ca000001-0000-4000-8000-000000000001', kind: 'CREATIVE_EXPLORATION',
        name: 'Ohne Kontrolle', hypothesis: 'Hypothese mit ausreichend Text.', test_variable: 'Creative',
        primary_metric: 'form_start_rate', thresholds: {}, assignment_salt: 'salt-5678',
      });
      await db.experiments.createArms([
        { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'a', label: 'A', allocation: 0.5 },
        { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'b', label: 'B', allocation: 0.5 },
      ]);
      await expect(db.experiments.start(experiment.id, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('meta insights upsert', () => {
    it('re-running the import over the same window creates no duplicates', async () => {
      seed(db);
      const rows = [
        { workspace_id: WORKSPACE, level: 'CAMPAIGN' as const, entity_external_id: 'act-1', date_start: '2026-08-01', spend_minor: 12_345, impressions: 4_000 },
        { workspace_id: WORKSPACE, level: 'CAMPAIGN' as const, entity_external_id: 'act-1', date_start: '2026-08-02', spend_minor: 9_876, impressions: 3_100 },
      ];
      await db.meta.upsertInsightsDaily(rows);
      await db.meta.upsertInsightsDaily(rows.map((row) => ({ ...row, spend_minor: row.spend_minor + 100 })));

      expect(db.store.meta_insights_daily).toHaveLength(2);
      const totals = await db.meta.spendTotals({ workspaceId: WORKSPACE });
      expect(totals.spend_minor).toBe(12_445 + 9_976);
      expect(totals.days).toBe(2);
    });
  });

  describe('campaign state machine', () => {
    it('refuses an illegal transition with a German message', async () => {
      const { campaignId } = seed(db);
      await expect(db.campaigns.transitionState(campaignId, 'IDEA', ACTOR)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      try {
        await db.campaigns.transitionState(campaignId, 'IDEA', ACTOR);
      } catch (error) {
        expect((error as DomainError).messageDe).toContain('nicht zulässig');
      }
    });

    it('allows a legal transition and stamps the timestamp', async () => {
      const { campaignId } = seed(db);
      const paused = await db.campaigns.transitionState(campaignId, 'PAUSED', ACTOR);
      expect(paused.state).toBe('PAUSED');
      expect(paused.paused_at).not.toBeNull();
    });

    it('keeps the business state when an error state is recorded', async () => {
      const { campaignId } = seed(db);
      const withError = await db.campaigns.setErrorState(campaignId, 'META_SYNC_FAILED', 'Token abgelaufen');
      expect(withError.state).toBe('LIVE');
      expect(withError.error_state).toBe('META_SYNC_FAILED');
    });

    it('rejects a duplicate slug in the same workspace', async () => {
      seed(db);
      await expect(
        db.campaigns.create({ workspace_id: WORKSPACE, name: 'Zweite', slug: 'potenzialanalyse' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('published versions are immutable', () => {
    it('refuses to publish an already published funnel version', async () => {
      seed(db);
      await expect(
        db.funnels.publishFunnelVersion('fv000001-0000-4000-8000-000000000001', ACTOR),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_VERSION' });
    });

    it('refuses a content change on a published campaign version', async () => {
      seed(db);
      const version = await db.campaigns.createVersion({
        workspace_id: WORKSPACE,
        campaign_id: 'ca000001-0000-4000-8000-000000000001',
        version: 1,
        spec: { a: 1 },
        content_hash: 'b'.repeat(64),
      });
      await db.campaigns.publishVersion(version.id, ACTOR);
      await expect(db.campaigns.publishVersion(version.id, ACTOR)).rejects.toMatchObject({
        code: 'IMMUTABLE_VERSION',
      });
    });
  });

  describe('workspace isolation', () => {
    it('never returns another workspace’s campaigns', async () => {
      seed(db);
      db.store.workspaces.push({
        id: OTHER_WORKSPACE, slug: 'other', name: 'Other', locale: 'de-DE', default_currency: 'EUR',
        timezone: 'Europe/Berlin', is_active: true, created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z', created_by: null, updated_by: null,
      });
      await db.campaigns.create({ workspace_id: OTHER_WORKSPACE, name: 'Fremd', slug: 'fremd' });

      const mine = await db.campaigns.list({ workspaceId: WORKSPACE });
      expect(mine.rows).toHaveLength(1);
      expect(mine.rows[0].slug).toBe('potenzialanalyse');
    });
  });

  describe('funnel counts', () => {
    it('reports counts, not just rates, through the whole funnel', async () => {
      const { publishedFunnelId, campaignId } = seed(db);
      const result = await db.submissions.submitLead(
        submitInput('aa000001-0000-4000-8000-000000000009', publishedFunnelId),
      );
      const lead = await db.submissions.createLead({
        workspace_id: WORKSPACE,
        am_person_id: 'pe000001-0000-4000-8000-000000000001',
        submission_id: result.submission_id,
        campaign_id: campaignId,
      });
      await db.submissions.setVqEvaluation(lead.id, { vq_status: 'PASSED', vq_model_version: 'vq-1' });

      const counts = await db.submissions.funnelCounts({ workspaceId: WORKSPACE, campaignId });
      expect(counts.submissions).toBe(1);
      expect(counts.leads).toBe(1);
      expect(counts.vq_scheduled).toBe(1);
      expect(counts.qualified_vq).toBe(1);
      expect(counts.opportunities).toBe(0);
      expect(counts.trustworthy_attributions).toBe(1);
    });
  });

  describe('rollups', () => {
    it('a recompute overwrites the day rather than appending a second row', async () => {
      seed(db);
      const row = { workspace_id: WORKSPACE, day: '2026-08-01', campaign_id: 'ca000001-0000-4000-8000-000000000001' };

      expect(await db.rollups.upsertDaily([{ ...row, impressions: 100, spend_minor: 5_000 }])).toBe(1);
      expect(await db.rollups.upsertDaily([{ ...row, impressions: 250, spend_minor: 9_000 }])).toBe(1);

      const stored = await db.rollups.query({ workspaceId: WORKSPACE });
      expect(stored).toHaveLength(1);
      expect(stored[0].impressions).toBe(250);
      expect(stored[0].spend_minor).toBe(9_000);
      expect(stored[0].traffic_scope).toBe('PRODUCTION');
    });

    it('treats a different dimension combination as a different row', async () => {
      seed(db);
      const day = '2026-08-01';
      const campaignId = 'ca000001-0000-4000-8000-000000000001';
      await db.rollups.upsertDaily([
        { workspace_id: WORKSPACE, day, campaign_id: campaignId },
        { workspace_id: WORKSPACE, day, campaign_id: campaignId, creative_version_id: 'cv-1' },
        { workspace_id: WORKSPACE, day, campaign_id: campaignId, creative_version_id: 'cv-2' },
      ]);
      expect(db.store.performance_rollups).toHaveLength(3);

      // NULL dimensions must not defeat the key: the campaign-only row is one row.
      await db.rollups.upsertDaily([{ workspace_id: WORKSPACE, day, campaign_id: campaignId }]);
      expect(db.store.performance_rollups).toHaveLength(3);
    });

    it('filters by dimension and by ids', async () => {
      seed(db);
      const day = '2026-08-01';
      await db.rollups.upsertDaily([
        { workspace_id: WORKSPACE, day, campaign_id: 'c1' },
        { workspace_id: WORKSPACE, day, creative_version_id: 'cv-1', impressions: 10 },
        { workspace_id: WORKSPACE, day, creative_version_id: 'cv-2', impressions: 20 },
      ]);

      const creatives = await db.rollups.query({ workspaceId: WORKSPACE, dimension: 'creative_version' });
      expect(creatives).toHaveLength(2);

      const one = await db.rollups.query({ workspaceId: WORKSPACE, dimension: 'creative_version', ids: ['cv-2'] });
      expect(one).toHaveLength(1);
      expect(one[0].impressions).toBe(20);
    });

    it('refuses anything that claims to include non-production traffic', async () => {
      seed(db);
      await expect(
        db.rollups.upsertDaily([
          { workspace_id: WORKSPACE, day: '2026-08-01', traffic_scope: 'PREVIEW' } as never,
        ]),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('lists the days it already holds', async () => {
      seed(db);
      await db.rollups.upsertDaily([
        { workspace_id: WORKSPACE, day: '2026-08-03', campaign_id: 'c1' },
        { workspace_id: WORKSPACE, day: '2026-08-01', campaign_id: 'c1' },
        { workspace_id: WORKSPACE, day: '2026-08-01', campaign_id: 'c2' },
      ]);
      expect(await db.rollups.listDays(WORKSPACE, '2026-08-01', '2026-08-31')).toEqual(['2026-08-01', '2026-08-03']);
    });

    it('flags a day whose source data landed after the rollup was computed', async () => {
      const { publishedFunnelId } = seed(db);
      const submission = await db.submissions.submitLead({
        ...submitInput('aa000001-0000-4000-8000-00000000000b', publishedFunnelId),
        submitted_at: '2026-08-10T12:00:00.000Z',
      });
      expect(submission.created).toBe(true);

      // Nothing computed yet, so the day is owed.
      expect(await db.rollups.daysNeedingRecompute(WORKSPACE, '2026-08-01', '2026-08-31')).toContain('2026-08-10');

      // Computed after the source landed, so the day is settled.
      await db.rollups.upsertDaily([
        { workspace_id: WORKSPACE, day: '2026-08-10', campaign_id: 'ca000001-0000-4000-8000-000000000001', computed_at: new Date().toISOString() },
      ]);
      expect(await db.rollups.daysNeedingRecompute(WORKSPACE, '2026-08-01', '2026-08-31')).not.toContain('2026-08-10');

      // A stale rollup is owed again.
      db.store.performance_rollups[0].computed_at = '2020-01-01T00:00:00.000Z';
      expect(await db.rollups.daysNeedingRecompute(WORKSPACE, '2026-08-01', '2026-08-31')).toContain('2026-08-10');
    });

    it('ignores non-production traffic when deciding what to recompute', async () => {
      seed(db);
      db.store.form_submissions.push({
        ...db.store.form_submissions[0],
        id: 'sb000001-0000-4000-8000-000000000099',
        submission_attempt_id: 'at000001-0000-4000-8000-000000000099',
        workspace_id: WORKSPACE,
        traffic_kind: 'TEST',
        submitted_at: '2026-08-12T09:00:00.000Z',
        updated_at: '2026-08-12T09:00:00.000Z',
      } as (typeof db.store.form_submissions)[number]);

      expect(await db.rollups.daysNeedingRecompute(WORKSPACE, '2026-08-01', '2026-08-31')).not.toContain('2026-08-12');
    });
  });

  describe('job locks', () => {
    it('lets exactly one holder in', async () => {
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-1', 60)).toBe(true);
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-2', 60)).toBe(false);
    });

    it('lets the same holder renew its own lock', async () => {
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-1', 60)).toBe(true);
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-1', 60)).toBe(true);
      expect(db.store.job_locks[0].acquire_count).toBe(2);
    });

    it('hands the lock over once it has expired — a crashed invocation frees itself', async () => {
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-1', 60)).toBe(true);
      db.store.job_locks[0].expires_at = '2020-01-01T00:00:00.000Z';
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-2', 60)).toBe(true);
      expect(db.store.job_locks[0].holder).toBe('worker-2');
    });

    it('releasing someone else’s lock is a no-op, not a steal', async () => {
      await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-1', 60);
      await db.jobs.releaseJobLock('outbox-pump', 'worker-2');
      expect(db.store.job_locks).toHaveLength(1);

      await db.jobs.releaseJobLock('outbox-pump', 'worker-1');
      expect(db.store.job_locks).toHaveLength(0);
      expect(await db.jobs.tryAcquireJobLock('outbox-pump', 'worker-2', 60)).toBe(true);
    });

    it('releasing a lock that does not exist is harmless', async () => {
      await expect(db.jobs.releaseJobLock('nothing', 'worker-1')).resolves.toBeUndefined();
    });
  });

  describe('dispatcher lookups', () => {
    it('finds an event by destination and id, without a dataset id', async () => {
      seed(db);
      await db.outbox.enqueue({
        workspace_id: WORKSPACE,
        destination: 'HUBSPOT',
        event_id: 'lead:abc',
        event_name: 'contact.upsert',
        event_time: '2026-08-20T10:00:00.000Z',
        payload_hash: 'a'.repeat(64),
      });
      expect((await db.outbox.getByEventId('HUBSPOT', 'lead:abc'))?.event_id).toBe('lead:abc');
      expect(await db.outbox.getByEventId('META_CAPI', 'lead:abc')).toBeNull();
    });

    it('drains every destination in one claim', async () => {
      seed(db);
      await db.outbox.enqueue({
        workspace_id: WORKSPACE, destination: 'HUBSPOT', event_id: 'lead:1',
        event_name: 'contact.upsert', event_time: '2026-08-20T10:00:00.000Z', payload_hash: 'a'.repeat(64),
      });
      await db.outbox.enqueue({
        workspace_id: WORKSPACE, destination: 'META_CAPI', event_id: 'capi:1', dataset_id: 'DS-1',
        event_name: 'Lead', event_time: '2026-08-20T10:00:00.000Z', payload_hash: 'b'.repeat(64),
      });

      const mixed = await db.outbox.claim({ worker: 'pump' });
      expect(mixed).toHaveLength(2);
      expect(new Set(mixed.map((row) => row.destination))).toEqual(new Set(['HUBSPOT', 'META_CAPI']));
    });

    it('still honours a single named destination', async () => {
      seed(db);
      await db.outbox.enqueue({
        workspace_id: WORKSPACE, destination: 'HUBSPOT', event_id: 'lead:1',
        event_name: 'contact.upsert', event_time: '2026-08-20T10:00:00.000Z', payload_hash: 'a'.repeat(64),
      });
      await db.outbox.enqueue({
        workspace_id: WORKSPACE, destination: 'META_CAPI', event_id: 'capi:1', dataset_id: 'DS-1',
        event_name: 'Lead', event_time: '2026-08-20T10:00:00.000Z', payload_hash: 'b'.repeat(64),
      });

      const onlyHubspot = await db.outbox.claim({ destination: 'HUBSPOT', worker: 'pump' });
      expect(onlyHubspot.map((row) => row.destination)).toEqual(['HUBSPOT']);
    });
  });

  describe('learning-card candidates', () => {
    async function concludedExperiment(concludedAt: string) {
      seed(db);
      const experiment = await db.experiments.create({
        workspace_id: WORKSPACE,
        campaign_id: 'ca000001-0000-4000-8000-000000000001',
        kind: 'FUNNEL_EXPERIMENT',
        name: 'Abgeschlossen',
        hypothesis: 'Eine Hypothese mit ausreichend Text für die Validierung.',
        test_variable: 'Fragenzahl',
        primary_metric: 'cost_per_qualified_vq',
        thresholds: { crmMaturityDays: 21 },
        assignment_salt: 'salt-1234',
      });
      await db.experiments.createArms([
        { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'control', label: 'Kontrolle', is_control: true, allocation: 0.5 },
        { workspace_id: WORKSPACE, experiment_id: experiment.id, key: 'variant_b', label: 'Variante B', allocation: 0.5 },
      ]);
      await db.experiments.start(experiment.id, ACTOR);
      await db.experiments.conclude(experiment.id, 'NO_DIFFERENCE', null, ACTOR);
      await db.experiments.update(experiment.id, { concluded_at: concludedAt });
      return experiment;
    }

    it('offers a concluded experiment whose CRM cohort has matured', async () => {
      await concludedExperiment('2026-07-01T00:00:00.000Z');
      const due = await db.experiments.listConcludedWithoutCards(WORKSPACE, '2026-08-25T00:00:00.000Z');
      expect(due).toHaveLength(1);
    });

    it('withholds one whose cohort is still immature', async () => {
      await concludedExperiment('2026-08-20T00:00:00.000Z');
      expect(await db.experiments.listConcludedWithoutCards(WORKSPACE, '2026-08-25T00:00:00.000Z')).toHaveLength(0);
    });

    it('withholds one that already has a learning card', async () => {
      const experiment = await concludedExperiment('2026-07-01T00:00:00.000Z');
      await db.learningCards.create({
        workspace_id: WORKSPACE,
        experiment_id: experiment.id,
        title_de: 'Kein Unterschied zwischen fünf und sechs Fragen',
        what_was_tested_de: 'Getestet wurde die Anzahl der Qualifizierungsfragen.',
        outcome_de: 'Kein praktisch relevanter Unterschied.',
        data_maturity: 'MATURE',
        attribution_level: 'LEAD_LINKED',
        confidence: 'INDICATION',
      });
      expect(await db.experiments.listConcludedWithoutCards(WORKSPACE, '2026-08-25T00:00:00.000Z')).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('clears the store and restarts the id sequence', async () => {
      const { publishedFunnelId } = seed(db);
      await db.submissions.submitLead(submitInput('aa000001-0000-4000-8000-00000000000a', publishedFunnelId));
      expect(db.store.form_submissions).toHaveLength(1);

      db.reset();
      expect(db.store.form_submissions).toHaveLength(0);
      expect(db.store.workspaces).toHaveLength(0);
    });
  });
});
