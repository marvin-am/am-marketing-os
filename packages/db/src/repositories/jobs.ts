/**
 * Cooperative locks for scheduled jobs.
 *
 * Two overlapping cron invocations must not both drain the outbox — that is how
 * a lead gets dispatched to HubSpot twice.
 *
 * A `pg_advisory_lock` releases itself when the session drops, which is what a
 * crashed serverless invocation wants. It is still the wrong tool here: Supabase
 * pools connections, so the session holding the lock is not the invocation that
 * took it, and an advisory lock is invisible to the operator. A `job_locks` row
 * with an explicit TTL gives the same crash recovery — the lock simply expires —
 * survives pooling, and shows up in the console.
 *
 * `tryAcquireJobLock` never blocks: it returns `false` and the invocation exits.
 */
import type { DbClient } from '../client';
import { toDomainError } from '../errors';
import { SupabaseRepository } from './base';
import type { JobLockRow } from '../types';

/** How long a lock survives without a heartbeat. Longer than any job's runtime. */
export const DEFAULT_JOB_LOCK_TTL_SECONDS = 300;

export interface JobsRepository {
  /**
   * Takes the lock, or reports that someone else holds it.
   *
   * Succeeds when the lock is free, has expired, or is already held by this
   * exact holder — so a job that renews its own lock mid-run is not locked out
   * by itself.
   */
  tryAcquireJobLock(key: string, holder: string, ttlSeconds?: number): Promise<boolean>;
  /** No-op when the caller is not the holder. Returns whether it released one. */
  releaseJobLock(key: string, holder: string): Promise<void>;
  /** Operational view for the console's job page. */
  listLocks(): Promise<JobLockRow[]>;
}

export class SupabaseJobsRepository extends SupabaseRepository implements JobsRepository {
  async tryAcquireJobLock(
    key: string,
    holder: string,
    ttlSeconds: number = DEFAULT_JOB_LOCK_TTL_SECONDS,
  ): Promise<boolean> {
    const result = await this.client.rpc('try_acquire_job_lock', {
      p_key: key,
      p_holder: holder,
      p_ttl_seconds: ttlSeconds,
    });
    if (result.error) throw toDomainError(result.error, 'jobs.tryAcquireJobLock');
    return result.data === true;
  }

  async releaseJobLock(key: string, holder: string): Promise<void> {
    const result = await this.client.rpc('release_job_lock', { p_key: key, p_holder: holder });
    if (result.error) throw toDomainError(result.error, 'jobs.releaseJobLock');
  }

  listLocks(): Promise<JobLockRow[]> {
    return this.selectList<JobLockRow>(
      this.client.from('job_locks').select('*').order('key'),
      'jobs.listLocks',
    );
  }
}

export function createJobsRepository(client: DbClient): JobsRepository {
  return new SupabaseJobsRepository(client);
}
