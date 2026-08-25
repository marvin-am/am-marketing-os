import { createHash } from 'node:crypto';
import type { Provider, Uuid } from '@am/domain';
import { asId } from '@am/domain';
import { resolveDatabase, type AmDatabase } from '@am/db';
import type { AbandonableFormInstance, JobPorts, LockPort, OutboxClaim } from '@am/jobs';
import { logger } from '@am/observability';
import { jobEnvironment } from './job-runtime';

/**
 * Supabase-backed implementations of the job ports.
 *
 * `@am/jobs` deliberately knows nothing about the database, so the whole
 * translation between its narrow port shapes and the repository API lives here.
 * Jobs run without a user session and legitimately read across the workspace,
 * so they use the admin client — this module is server-only.
 */
export function createSupabaseJobPorts(): JobPorts {
  const { db } = resolveDatabase({ admin: true });
  const workspaceId = asId<Uuid>(jobEnvironment().workspaceId);

  return {
    lock: createAdvisoryLock(db),

    outbox: {
      async claimDue(limit, _now, holder) {
        const rows = await db.outbox.claim({ limit, worker: holder });
        return rows.map(toOutboxClaim);
      },
      async markAccepted(eventId, destination, responseRedacted) {
        const row = await db.outbox.getByEventId(destination as never, eventId);
        if (!row) {
          logger.warn('outbox_accept_missing_row', { event_id: eventId, destination });
          return;
        }
        await db.outbox.markAccepted(row.id as Uuid, responseRedacted);
      },
      async markFailed(eventId, destination, error, _nextAttemptAt, deadLetter) {
        const row = await db.outbox.getByEventId(destination as never, eventId);
        if (!row) {
          logger.warn('outbox_fail_missing_row', { event_id: eventId, destination });
          return;
        }
        if (deadLetter) {
          await db.outbox.markDeadLetter(row.id as Uuid, error);
          return;
        }
        // The repository owns the backoff schedule, so retry timing has one
        // definition rather than one per caller.
        await db.outbox.markFailed(
          { id: row.id, event_id: row.event_id, attempt_count: row.attempt_count },
          error,
        );
      },
      async countByStatus() {
        return (await db.outbox.stats(workspaceId)) as unknown as Record<string, number>;
      },
    },

    sync: {
      async get(provider, resource) {
        const row = await db.integrations.getCursor(workspaceId, provider as Provider, resource);
        return { cursor: row?.cursor_value ?? null, watermark: row?.cursor_time ?? null };
      },
      async set(provider, resource, value) {
        await db.integrations.setCursor(workspaceId, provider as Provider, resource, {
          cursor_value: value.cursor ?? null,
          cursor_time: value.watermark ?? null,
          success: true,
        });
      },
    },

    forms: {
      async listStaleOpen(inactiveSince, limit) {
        const rows = await db.tracking.listAbandonCandidates(
          workspaceId,
          inactiveSince.toISOString(),
        );
        return rows.slice(0, limit).map(toAbandonable);
      },
      async markAbandoned(formInstanceId, occurredAt) {
        await db.tracking.updateFormInstance(asId<Uuid>(formInstanceId), {
          abandoned_at: occurredAt,
        } as never);
      },
    },

    rollups: {
      async listDaysNeedingRollup(since, until) {
        return db.rollups.daysNeedingRecompute(
          workspaceId,
          isoDay(since),
          isoDay(until),
        );
      },
      async loadDailyCounters(day) {
        // Counters come from the mirrored insights plus the production event
        // stream; the rollup job folds them together. Non-production traffic is
        // excluded upstream by `isRollupEligible`.
        return db.rollups.query({ workspaceId, since: day, until: day } as never);
      },
      async writeRollups(_day, rows) {
        return db.rollups.upsertDaily(rows as never);
      },
    },

    learnings: {
      async listExperimentsNeedingCards(now) {
        const rows = await db.experiments.listConcludedWithoutCards(workspaceId, now.toISOString());
        return rows.map((row) => ({
          experimentId: String(row.id),
          campaignId: String(row.campaign_id),
        }));
      },
      async writeLearningCard(card) {
        await db.learningCards.create(card as never);
      },
    },

    recommendations: {
      async listActiveCampaigns() {
        const page = await db.campaigns.list({ workspaceId, states: ['LIVE', 'PAUSED'] } as never);
        return page.rows.map((row) => ({ campaignId: String(row.id) }));
      },
      async loadContext(campaignId) {
        // The evaluation context is assembled from the campaign's rollups; the
        // engine itself lives in @am/recommendations and stays pure.
        const rows = await db.rollups.query({
          workspaceId,
          campaignId: asId<Uuid>(campaignId),
        } as never);
        return rows.length > 0 ? { campaignId, rollups: rows } : null;
      },
      async replaceOpenRecommendations(campaignId, recommendations) {
        const existing = await db.recommendations.listByCampaign(asId<Uuid>(campaignId), ['OPEN']);
        let written = 0;
        for (const recommendation of recommendations) {
          const row = await db.recommendations.upsert(recommendation as never);
          written += 1;
          // Anything still OPEN that this run did not re-produce is stale.
          for (const previous of existing) {
            if (previous.rule_id === (recommendation as { ruleId?: string }).ruleId) continue;
            await db.recommendations.supersede(previous.id as Uuid, row.id as Uuid);
          }
        }
        return written;
      },
    },

    health: {
      async record(provider, health) {
        const checks = (health as { checks?: unknown[] })?.checks ?? [];
        if (!Array.isArray(checks) || checks.length === 0) return;
        await db.integrations.recordHealthChecks(
          checks.map((check) => ({
            workspace_id: workspaceId,
            provider,
            ...(check as Record<string, unknown>),
          })) as never,
        );
      },
    },

    audit: {
      async recordRun(result) {
        await db.integrations.enqueueJob({
          workspace_id: workspaceId,
          kind: result.job,
          status: result.ok ? 'SUCCEEDED' : 'FAILED',
          payload: result,
        } as never);
      },
    },
  };
}

/**
 * Postgres advisory lock.
 *
 * A row-based lock would need its own expiry sweeping; an advisory lock is
 * released by the database when the session ends, which is the behaviour a
 * crashed serverless invocation needs.
 */
function createAdvisoryLock(db: AmDatabase): LockPort {
  const held = new Map<string, string>();

  return {
    async acquire(key, ttlMs, holder) {
      const acquired = await db.jobs.tryAcquireJobLock(
        lockKey(key),
        holder,
        Math.ceil(ttlMs / 1000),
      );
      if (acquired) held.set(key, holder);
      return acquired;
    },
    async release(key, holder) {
      // Releasing another holder's lock would defeat the point of taking one.
      if (held.get(key) !== holder) return;
      await db.jobs.releaseJobLock(lockKey(key), holder);
      held.delete(key);
    },
  };
}

/** Stable, collision-resistant key derived from the human-readable lock name. */
function lockKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** `YYYY-MM-DD` in UTC, the grain the rollup table is keyed on. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toOutboxClaim(input: unknown): OutboxClaim {
  const row = input as Record<string, unknown>;
  return {
    eventId: String(row.event_id),
    destination: String(row.destination),
    eventName: String(row.event_name),
    eventTime: String(row.event_time),
    datasetId: (row.dataset_id as string | null) ?? null,
    payload: row.payload ?? null,
    attemptCount: Number(row.attempt_count ?? 0),
    campaignId: (row.campaign_id as string | null) ?? null,
    submissionId: (row.submission_id as string | null) ?? null,
    opportunityId: (row.opportunity_id as string | null) ?? null,
  };
}

function toAbandonable(input: unknown): AbandonableFormInstance {
  const row = input as Record<string, unknown>;
  return {
    formInstanceId: String(row.id),
    visitorId: String(row.visitor_id),
    sessionId: String(row.session_id),
    funnelVersionId: (row.funnel_version_id as string | null) ?? null,
    formVersionId: (row.form_version_id as string | null) ?? null,
    lastActivityAt: String(row.last_activity_at ?? row.updated_at),
    lastStepId: (row.current_step_id as string | null) ?? null,
    submitted: Boolean(row.submitted_at),
    abandonedRecorded: Boolean(row.abandoned_at),
  };
}
