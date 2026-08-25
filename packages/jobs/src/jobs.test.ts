import { describe, expect, it, vi } from 'vitest';
import { JOB_NAMES } from './types';
import { JOB_REGISTRY, getJob, jobForCronPath, listJobs } from './registry';
import { runJob } from './runner';
import {
  createMemoryState,
  createTestContext,
  outboxRecord,
  type MemoryPortsState,
} from './testing';
import { outboxDispatchJob } from './jobs/outbox-dispatch';
import { deriveAbandonedFormsJob } from './jobs/analysis-jobs';
import { hubspotReconcileHourlyJob, metaInsightsJob } from './jobs/sync-jobs';

describe('registry', () => {
  it('registers every declared job name', () => {
    for (const name of JOB_NAMES) {
      expect(JOB_REGISTRY[name], name).toBeDefined();
      expect(getJob(name).name).toBe(name);
    }
    expect(listJobs()).toHaveLength(JOB_NAMES.length);
  });

  it('gives every job a cron schedule and a German description', () => {
    for (const job of listJobs()) {
      expect(job.schedule, job.name).toMatch(/^[\d*/,\-\s]+$/);
      expect(job.descriptionDe.length, job.name).toBeGreaterThan(20);
    }
  });

  it('resolves the cron paths declared in vercel.json', () => {
    expect(jobForCronPath('/api/cron/outbox-dispatch')?.name).toBe('outbox-dispatch');
    expect(jobForCronPath('/api/cron/hubspot-reconcile-deep')?.name).toBe('hubspot-reconcile-deep');
    expect(jobForCronPath('/api/cron/unknown-job')).toBeNull();
    expect(jobForCronPath('/api/health')).toBeNull();
  });
});

describe('runner', () => {
  it('records every run, successful or not', async () => {
    const state = createMemoryState();
    const result = await runJob({
      definition: {
        name: 'integration-health',
        schedule: '0 */6 * * *',
        descriptionDe: 'x'.repeat(30),
        requires: [],
        async run() {
          return { ok: true, counts: { checked: 0 }, summaryDe: 'ok', warningsDe: [], errorDe: null };
        },
      },
      context: createTestContext(state),
    });

    expect(result.ok).toBe(true);
    expect(state.runs).toHaveLength(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('turns a thrown error into a failed, German result rather than propagating', async () => {
    const state = createMemoryState();
    const result = await runJob({
      definition: {
        name: 'integration-health',
        schedule: '0 */6 * * *',
        descriptionDe: 'x'.repeat(30),
        requires: [],
        async run() {
          throw new Error('provider exploded at 10.0.0.4');
        },
      },
      context: createTestContext(state),
    });

    expect(result.ok).toBe(false);
    expect(result.errorDe).toBeTruthy();
    expect(result.errorDe).not.toContain('10.0.0.4');
    expect(state.runs).toHaveLength(1);
  });

  it('skips when another holder has the lock, instead of running concurrently', async () => {
    const state = createMemoryState();
    const context = createTestContext(state);
    let runs = 0;

    const definition = {
      name: 'outbox-dispatch' as const,
      schedule: '*/5 * * * *',
      descriptionDe: 'x'.repeat(30),
      requires: [],
      async run() {
        runs += 1;
        return { ok: true, counts: {}, summaryDe: 'ok', warningsDe: [], errorDe: null };
      },
    };

    // Someone else already holds it.
    await context.ports.lock.acquire(
      `job:outbox-dispatch:${context.workspaceId}`,
      60_000,
      'other-holder',
    );

    const result = await runJob({ definition, context });
    expect(result.skippedLocked).toBe(true);
    expect(runs).toBe(0);
  });

  it('releases the lock so the next run can proceed', async () => {
    const state = createMemoryState();
    const context = createTestContext(state);
    const definition = {
      name: 'outbox-dispatch' as const,
      schedule: '*/5 * * * *',
      descriptionDe: 'x'.repeat(30),
      requires: [],
      async run() {
        return { ok: true, counts: {}, summaryDe: 'ok', warningsDe: [], errorDe: null };
      },
    };

    await runJob({ definition, context });
    const second = await runJob({ definition, context });
    expect(second.skippedLocked).toBe(false);
  });
});

describe('outbox dispatch', () => {
  const withEvents = (rows: MemoryPortsState['outbox']) => createMemoryState({ outbox: rows });

  it('holds events when external writes are disabled and loses nothing', async () => {
    const state = withEvents([outboxRecord(), outboxRecord({ eventId: 'evt-2' })]);
    const result = await runJob({
      definition: outboxDispatchJob,
      context: createTestContext(state, {
        providers: {
          hubspot: {
            syncPending: vi.fn(),
            reconcile: vi.fn(),
            health: vi.fn(),
          },
        },
      }),
    });

    expect(result.counts.held).toBe(2);
    expect(result.counts.dispatched).toBe(0);
    expect(state.outbox.every((row) => row.status === 'PROCESSING')).toBe(true);
    expect(result.warningsDe.join(' ')).toContain('deaktiviert');
  });

  it('dispatches and marks accepted once writes are enabled', async () => {
    const state = withEvents([outboxRecord()]);
    const syncPending = vi.fn().mockResolvedValue({ synced: 1, response: { id: 'c-1' } });

    const result = await runJob({
      definition: outboxDispatchJob,
      context: createTestContext(state, {
        flags: { externalWritesEnabled: true, hubspotWritesEnabled: true },
        providers: { hubspot: { syncPending, reconcile: vi.fn(), health: vi.fn() } },
      }),
    });

    expect(syncPending).toHaveBeenCalledOnce();
    expect(result.counts.dispatched).toBe(1);
    expect(state.outbox[0]?.status).toBe('ACCEPTED');
  });

  it('does not treat a dry run as delivered', async () => {
    const state = withEvents([outboxRecord()]);
    const result = await runJob({
      definition: outboxDispatchJob,
      context: createTestContext(state, {
        flags: { externalWritesEnabled: true, hubspotWritesEnabled: true },
        providers: {
          hubspot: {
            syncPending: vi.fn().mockResolvedValue({ dryRun: true }),
            reconcile: vi.fn(),
            health: vi.fn(),
          },
        },
      }),
    });

    expect(result.counts.dispatched).toBe(0);
    expect(result.counts.held).toBe(1);
    expect(state.outbox[0]?.status).not.toBe('ACCEPTED');
  });

  it('backs off on failure and dead-letters once attempts are exhausted', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('502 upstream'));

    const retrying = createMemoryState({ outbox: [outboxRecord({ attemptCount: 0 })] });
    const first = await runJob({
      definition: outboxDispatchJob,
      context: createTestContext(retrying, {
        flags: { externalWritesEnabled: true, hubspotWritesEnabled: true },
        providers: { hubspot: { syncPending: failing, reconcile: vi.fn(), health: vi.fn() } },
      }),
    });
    expect(first.counts.failed).toBe(1);
    expect(retrying.outbox[0]?.status).toBe('FAILED_RETRYING');
    expect(retrying.outbox[0]?.nextAttemptAt).toBeTruthy();

    const exhausted = createMemoryState({ outbox: [outboxRecord({ attemptCount: 7 })] });
    const second = await runJob({
      definition: outboxDispatchJob,
      context: createTestContext(exhausted, {
        flags: { externalWritesEnabled: true, hubspotWritesEnabled: true },
        providers: { hubspot: { syncPending: failing, reconcile: vi.fn(), health: vi.fn() } },
      }),
    });
    expect(second.counts.deadLettered).toBe(1);
    expect(exhausted.outbox[0]?.status).toBe('DEAD_LETTER');
    expect(second.warningsDe.join(' ')).toContain('Dead-Letter');
  });

  it('reports cleanly when there is nothing due', async () => {
    const result = await runJob({
      definition: outboxDispatchJob,
      context: createTestContext(createMemoryState()),
    });
    expect(result.ok).toBe(true);
    expect(result.counts.claimed).toBe(0);
  });
});

describe('abandoned form derivation', () => {
  it('marks only instances idle past the window, using the activity time', async () => {
    const now = new Date('2026-06-30T12:00:00.000Z');
    const state = createMemoryState({
      formInstances: [
        {
          formInstanceId: 'fi-old',
          visitorId: 'v1',
          sessionId: 's1',
          funnelVersionId: null,
          formVersionId: null,
          lastActivityAt: '2026-06-30T11:00:00.000Z',
          lastStepId: 'step_2',
          submitted: false,
          abandonedRecorded: false,
        },
        {
          formInstanceId: 'fi-recent',
          visitorId: 'v2',
          sessionId: 's2',
          funnelVersionId: null,
          formVersionId: null,
          lastActivityAt: '2026-06-30T11:55:00.000Z',
          lastStepId: 'step_1',
          submitted: false,
          abandonedRecorded: false,
        },
        {
          formInstanceId: 'fi-submitted',
          visitorId: 'v3',
          sessionId: 's3',
          funnelVersionId: null,
          formVersionId: null,
          lastActivityAt: '2026-06-30T09:00:00.000Z',
          lastStepId: 'step_5',
          submitted: true,
          abandonedRecorded: false,
        },
      ],
    });

    const result = await runJob({
      definition: deriveAbandonedFormsJob,
      context: createTestContext(state, { now }),
    });

    expect(result.counts.derived).toBe(1);
    expect(state.formInstances.find((i) => i.formInstanceId === 'fi-old')?.abandonedRecorded).toBe(true);
    expect(state.formInstances.find((i) => i.formInstanceId === 'fi-recent')?.abandonedRecorded).toBe(false);
    expect(state.formInstances.find((i) => i.formInstanceId === 'fi-submitted')?.abandonedRecorded).toBe(false);
  });
});

describe('provider-dependent jobs degrade instead of failing', () => {
  it('skips insights with a German explanation when Meta is not connected', async () => {
    const result = await runJob({
      definition: metaInsightsJob,
      context: createTestContext(createMemoryState()),
    });
    expect(result.ok).toBe(true);
    expect(result.counts.skipped).toBe(1);
    expect(result.summaryDe).toContain('nicht verbunden');
  });

  it('skips reconciliation when HubSpot is not connected', async () => {
    const result = await runJob({
      definition: hubspotReconcileHourlyJob,
      context: createTestContext(createMemoryState()),
    });
    expect(result.ok).toBe(true);
    expect(result.summaryDe).toContain('nicht verbunden');
  });

  it('surfaces a value discrepancy as a warning, not a silent pass', async () => {
    const state = createMemoryState();
    const result = await runJob({
      definition: hubspotReconcileHourlyJob,
      context: createTestContext(state, {
        providers: {
          hubspot: {
            reconcile: vi.fn().mockResolvedValue({ checked: 40, transitions: 3, discrepancies: 1 }),
            syncPending: vi.fn(),
            health: vi.fn(),
          },
        },
      }),
    });

    expect(result.counts.transitions).toBe(3);
    expect(result.warningsDe.join(' ')).toContain('Abweichung');
    expect(result.warningsDe.join(' ')).toContain('kein zweites Conversion-Ereignis');
  });
});
