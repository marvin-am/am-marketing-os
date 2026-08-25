import { DomainError, domainErrorMessageDe, newId } from '@am/domain';
import { createLogger } from '@am/observability';
import { JOB_LABELS_DE, type JobContext, type JobDefinition, type JobResult } from './types';

export interface RunJobOptions {
  definition: JobDefinition;
  /** Everything the job needs, minus the fields the runner fills in. */
  context: Omit<JobContext, 'job' | 'runId' | 'logger'>;
  /** Lock TTL. Should exceed the platform's function timeout. */
  lockTtlMs?: number;
  /** Skip locking entirely — only for tests and single-shot manual runs. */
  skipLock?: boolean;
}

const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Runs one job with a cooperative lock, structured timing and a result that is
 * always recorded — success or failure.
 *
 * The lock matters because cron on a serverless platform can overlap
 * invocations: two outbox pumps racing the same rows would double-dispatch.
 * The unique constraints would catch it, but only after the provider had
 * already seen both events.
 */
export async function runJob(options: RunJobOptions): Promise<JobResult> {
  const { definition, context } = options;
  const runId = newId();
  const startedAt = context.now.toISOString();
  const started = Date.now();
  const holder = `${definition.name}:${runId}`;
  const lockKey = `job:${definition.name}:${context.workspaceId}`;

  const logger = createLogger({
    job: definition.name,
    run_id: runId,
    workspace_id: context.workspaceId,
  });

  const finish = (
    partial: Partial<JobResult> & Pick<JobResult, 'ok' | 'summaryDe'>,
  ): JobResult => ({
    job: definition.name,
    runId,
    startedAt,
    finishedAt: new Date(context.now.getTime() + (Date.now() - started)).toISOString(),
    durationMs: Date.now() - started,
    counts: {},
    warningsDe: [],
    errorDe: null,
    skippedLocked: false,
    ...partial,
  });

  let holdsLock = false;
  let result: JobResult;

  try {
    if (!options.skipLock) {
      holdsLock = await context.ports.lock.acquire(
        lockKey,
        options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
        holder,
      );
      if (!holdsLock) {
        logger.info('job_skipped_locked');
        result = finish({
          ok: true,
          skippedLocked: true,
          summaryDe: `${JOB_LABELS_DE[definition.name]}: übersprungen, ein anderer Lauf hält die Sperre.`,
        });
        await safeRecord(context, result, logger);
        return result;
      }
    }

    logger.info('job_started');
    const outcome = await definition.run({ ...context, job: definition.name, runId, logger });
    result = finish(outcome);
    logger.info('job_finished', { ok: result.ok, counts: result.counts });
  } catch (error) {
    const messageDe =
      error instanceof DomainError ? error.messageDe : domainErrorMessageDe(error);
    logger.error('job_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    result = finish({
      ok: false,
      summaryDe: `${JOB_LABELS_DE[definition.name]}: fehlgeschlagen.`,
      errorDe: messageDe,
    });
  } finally {
    if (holdsLock) {
      try {
        await context.ports.lock.release(lockKey, holder);
      } catch (error) {
        logger.warn('job_lock_release_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await safeRecord(context, result, logger);
  return result;
}

/** A failure to persist the run record must not mask the run's own outcome. */
async function safeRecord(
  context: Omit<JobContext, 'job' | 'runId' | 'logger'>,
  result: JobResult,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    await context.ports.audit.recordRun(result);
  } catch (error) {
    logger.warn('job_record_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Processes items in bounded batches, stopping cleanly when the invocation's
 * budget runs out. Returning a partial result beats being killed mid-write.
 */
export async function processInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  signal: AbortSignal,
  handler: (batch: T[]) => Promise<R[]>,
): Promise<{ results: R[]; processed: number; aborted: boolean }> {
  const results: R[] = [];
  let processed = 0;

  for (let index = 0; index < items.length; index += batchSize) {
    if (signal.aborted) {
      return { results, processed, aborted: true };
    }
    const batch = items.slice(index, index + batchSize);
    results.push(...(await handler(batch)));
    processed += batch.length;
  }

  return { results, processed, aborted: false };
}
