import { SAFE_DEFAULT_FLAGS, type FeatureFlags } from '@am/domain';
import { createLogger } from '@am/observability';
import type {
  AbandonableFormInstance,
  JobContext,
  JobPorts,
  JobProviders,
  JobResult,
  OutboxClaim,
} from './types';

/**
 * In-memory ports for tests and for the demo mode.
 *
 * They enforce the same invariants the real implementations do — in particular
 * the lock is a real lock and the outbox refuses to hand the same event to two
 * holders — so a test that passes here is testing the actual behaviour, not a
 * permissive stub.
 */

export interface MemoryPortsState {
  outbox: OutboxRecord[];
  formInstances: AbandonableFormInstance[];
  runs: JobResult[];
  locks: Map<string, { holder: string; expiresAt: number }>;
  cursors: Map<string, { cursor: string | null; watermark: string | null }>;
  healthByProvider: Map<string, unknown>;
  rollupDays: string[];
  rollupsWritten: Array<{ day: string; rows: number }>;
  learningCandidates: Array<{ experimentId: string; campaignId: string }>;
  learningCards: unknown[];
  activeCampaigns: Array<{ campaignId: string }>;
  recommendationContexts: Map<string, unknown>;
  recommendationsWritten: Map<string, unknown[]>;
}

export interface OutboxRecord extends OutboxClaim {
  status: 'PENDING' | 'PROCESSING' | 'ACCEPTED' | 'FAILED_RETRYING' | 'DEAD_LETTER';
  nextAttemptAt: string | null;
  lastError: string | null;
  responseRedacted: unknown;
}

export function createMemoryState(overrides: Partial<MemoryPortsState> = {}): MemoryPortsState {
  return {
    outbox: [],
    formInstances: [],
    runs: [],
    locks: new Map(),
    cursors: new Map(),
    healthByProvider: new Map(),
    rollupDays: [],
    rollupsWritten: [],
    learningCandidates: [],
    learningCards: [],
    activeCampaigns: [],
    recommendationContexts: new Map(),
    recommendationsWritten: new Map(),
    ...overrides,
  };
}

export function createMemoryPorts(state: MemoryPortsState, now: () => Date = () => new Date()): JobPorts {
  return {
    lock: {
      async acquire(key, ttlMs, holder) {
        const existing = state.locks.get(key);
        const nowMs = now().getTime();
        if (existing && existing.expiresAt > nowMs && existing.holder !== holder) return false;
        state.locks.set(key, { holder, expiresAt: nowMs + ttlMs });
        return true;
      },
      async release(key, holder) {
        const existing = state.locks.get(key);
        // Releasing someone else's lock would defeat the point of taking one.
        if (existing?.holder === holder) state.locks.delete(key);
      },
    },

    outbox: {
      async claimDue(limit, at) {
        const due = state.outbox
          .filter(
            (row) =>
              (row.status === 'PENDING' || row.status === 'FAILED_RETRYING') &&
              (row.nextAttemptAt === null || new Date(row.nextAttemptAt) <= at),
          )
          .slice(0, limit);
        for (const row of due) row.status = 'PROCESSING';
        return due.map((row) => ({ ...row }));
      },
      async markAccepted(eventId, destination, responseRedacted) {
        const row = find(state, eventId, destination);
        if (!row) return;
        row.status = 'ACCEPTED';
        row.responseRedacted = responseRedacted;
        row.lastError = null;
      },
      async markFailed(eventId, destination, error, nextAttemptAt, deadLetter) {
        const row = find(state, eventId, destination);
        if (!row) return;
        row.status = deadLetter ? 'DEAD_LETTER' : 'FAILED_RETRYING';
        row.attemptCount += 1;
        row.lastError = error;
        row.nextAttemptAt = nextAttemptAt ? nextAttemptAt.toISOString() : null;
      },
      async countByStatus() {
        const counts: Record<string, number> = {};
        for (const row of state.outbox) {
          counts[row.status] = (counts[row.status] ?? 0) + 1;
        }
        return counts;
      },
    },

    sync: {
      async get(provider, resource) {
        return state.cursors.get(`${provider}:${resource}`) ?? { cursor: null, watermark: null };
      },
      async set(provider, resource, value) {
        const key = `${provider}:${resource}`;
        const current = state.cursors.get(key) ?? { cursor: null, watermark: null };
        state.cursors.set(key, {
          cursor: value.cursor === undefined ? current.cursor : value.cursor,
          watermark: value.watermark === undefined ? current.watermark : value.watermark,
        });
      },
    },

    forms: {
      async listStaleOpen(inactiveSince, limit) {
        return state.formInstances
          .filter(
            (instance) =>
              !instance.submitted &&
              !instance.abandonedRecorded &&
              new Date(instance.lastActivityAt) <= inactiveSince,
          )
          .slice(0, limit);
      },
      async markAbandoned(formInstanceId) {
        const instance = state.formInstances.find((i) => i.formInstanceId === formInstanceId);
        if (instance) instance.abandonedRecorded = true;
      },
    },

    rollups: {
      async listDaysNeedingRollup() {
        return [...state.rollupDays];
      },
      async loadDailyCounters() {
        return [];
      },
      async writeRollups(day, rows) {
        state.rollupsWritten.push({ day, rows: rows.length });
        return rows.length;
      },
    },

    learnings: {
      async listExperimentsNeedingCards() {
        return [...state.learningCandidates];
      },
      async writeLearningCard(card) {
        state.learningCards.push(card);
      },
    },

    recommendations: {
      async listActiveCampaigns() {
        return [...state.activeCampaigns];
      },
      async loadContext(campaignId) {
        return state.recommendationContexts.get(campaignId) ?? null;
      },
      async replaceOpenRecommendations(campaignId, recommendations) {
        state.recommendationsWritten.set(campaignId, recommendations);
        return recommendations.length;
      },
    },

    health: {
      async record(provider, health) {
        state.healthByProvider.set(provider, health);
      },
    },

    audit: {
      async recordRun(result) {
        state.runs.push(result);
      },
    },
  };
}

function find(state: MemoryPortsState, eventId: string, destination: string) {
  return state.outbox.find((row) => row.eventId === eventId && row.destination === destination);
}

export function createTestContext(
  state: MemoryPortsState,
  options: {
    now?: Date;
    flags?: Partial<FeatureFlags>;
    providers?: Partial<JobProviders>;
    signal?: AbortSignal;
  } = {},
): Omit<JobContext, 'job' | 'runId' | 'logger'> {
  const now = options.now ?? new Date('2026-06-30T08:00:00.000Z');
  return {
    now,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    environment: 'test',
    flags: { ...SAFE_DEFAULT_FLAGS, ...options.flags },
    signal: options.signal ?? new AbortController().signal,
    ports: createMemoryPorts(state, () => now),
    providers: { meta: null, hubspot: null, ...options.providers },
  };
}

export function createTestLogger() {
  return createLogger({ test: true });
}

export function outboxRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    eventId: 'evt-1',
    destination: 'HUBSPOT',
    eventName: 'FORM_COMPLETED',
    eventTime: '2026-06-30T07:00:00.000Z',
    datasetId: null,
    payload: { kind: 'lead' },
    attemptCount: 0,
    campaignId: null,
    submissionId: null,
    opportunityId: null,
    status: 'PENDING',
    nextAttemptAt: null,
    lastError: null,
    responseRedacted: null,
    ...overrides,
  };
}
