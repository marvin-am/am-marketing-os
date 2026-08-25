/**
 * Outbox repository — the thin interface over `../outbox`.
 *
 * Kept separate so `createMemoryDatabase()` can offer the same surface without
 * a database, and so the console's "Sync-Status" page has one place to read from.
 */
import type { OutboxDestination, OutboxState } from '@am/domain';
import type { DbClient } from '../client';
import { normalizePage, SupabaseRepository } from './base';
import {
  claimPendingOutboxEvents,
  enqueueOutboxEvent,
  markAccepted,
  markDeadLetter,
  markFailed,
  markSent,
  reclaimStaleOutboxEvents,
  type ClaimOutboxOptions,
  type EnqueueOutboxInput,
  type EnqueueOutboxResult,
  type RetryDecision,
} from '../outbox';
import type { OutboxEventRow, Page, PageParams, Uuid } from '../types';

export interface OutboxListParams extends PageParams {
  workspaceId: Uuid;
  destination?: OutboxDestination;
  statuses?: OutboxState[];
}

export interface OutboxStats {
  pending: number;
  processing: number;
  sent: number;
  accepted: number;
  failedRetrying: number;
  deadLetter: number;
  expired: number;
}

export interface OutboxRepository {
  enqueue(input: EnqueueOutboxInput): Promise<EnqueueOutboxResult>;
  claim(options: ClaimOutboxOptions): Promise<OutboxEventRow[]>;
  reclaimStale(olderThan?: string): Promise<number>;
  markSent(id: Uuid, providerResponseRedacted?: unknown): Promise<OutboxEventRow>;
  markAccepted(id: Uuid, providerResponseRedacted?: unknown): Promise<OutboxEventRow>;
  markFailed(
    event: Pick<OutboxEventRow, 'id' | 'event_id' | 'attempt_count'>,
    error: string,
    options?: { now?: Date; providerResponseRedacted?: unknown },
  ): Promise<{ event: OutboxEventRow; decision: RetryDecision }>;
  markDeadLetter(id: Uuid, reason: string, providerResponseRedacted?: unknown): Promise<OutboxEventRow>;
  list(params: OutboxListParams): Promise<Page<OutboxEventRow>>;
  listDeadLetters(workspaceId: Uuid): Promise<OutboxEventRow[]>;
  /** Full dedup key. Use when the dataset id is known (Meta CAPI). */
  getByDedupKey(destination: OutboxDestination, datasetId: string, eventId: string): Promise<OutboxEventRow | null>;
  /**
   * Lookup without a dataset id.
   *
   * HubSpot events carry none, and on the way back from a dispatch the worker
   * knows only `(destination, event_id)`. Deterministic event ids make that pair
   * unique in practice; if it ever matched several rows the newest wins, because
   * that is the dispatch the worker just performed.
   */
  getByEventId(destination: OutboxDestination, eventId: string): Promise<OutboxEventRow | null>;
  stats(workspaceId: Uuid): Promise<OutboxStats>;
  /**
   * Every dispatch queued for one submission, oldest first.
   *
   * `list` is workspace-scoped because that is how the console reads the queue.
   * The funnel runtime and the runbook start from a submission and hold no
   * workspace id, and making `workspaceId` optional on `OutboxListParams` would
   * turn a mandatory tenant filter into an optional one for every caller — so
   * this is a separate, narrower read rather than a widening of that one.
   *
   * Optional on the interface: `createMemoryDatabase()` exists for DEMO_MODE,
   * where the funnel runtime serves from its own fixture store and never
   * reaches this read.
   */
  listBySubmission?(submissionId: Uuid): Promise<OutboxEventRow[]>;
}

export class SupabaseOutboxRepository extends SupabaseRepository implements OutboxRepository {
  enqueue(input: EnqueueOutboxInput): Promise<EnqueueOutboxResult> {
    return enqueueOutboxEvent(this.client, input);
  }

  claim(options: ClaimOutboxOptions): Promise<OutboxEventRow[]> {
    return claimPendingOutboxEvents(this.client, options);
  }

  reclaimStale(olderThan?: string): Promise<number> {
    return reclaimStaleOutboxEvents(this.client, olderThan);
  }

  markSent(id: Uuid, providerResponseRedacted?: unknown): Promise<OutboxEventRow> {
    return markSent(this.client, id, providerResponseRedacted);
  }

  markAccepted(id: Uuid, providerResponseRedacted?: unknown): Promise<OutboxEventRow> {
    return markAccepted(this.client, id, providerResponseRedacted);
  }

  markFailed(
    event: Pick<OutboxEventRow, 'id' | 'event_id' | 'attempt_count'>,
    error: string,
    options: { now?: Date; providerResponseRedacted?: unknown } = {},
  ): Promise<{ event: OutboxEventRow; decision: RetryDecision }> {
    return markFailed(this.client, event, error, options);
  }

  markDeadLetter(id: Uuid, reason: string, providerResponseRedacted?: unknown): Promise<OutboxEventRow> {
    return markDeadLetter(this.client, id, reason, providerResponseRedacted);
  }

  async list(params: OutboxListParams): Promise<Page<OutboxEventRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client
      .from('outbox_events')
      .select('*', { count: 'exact' })
      .eq('workspace_id', params.workspaceId);
    if (params.destination) query = query.eq('destination', params.destination);
    if (params.statuses?.length) query = query.in('status', params.statuses);

    return this.selectCounted<OutboxEventRow>(
      query.order('created_at', { ascending: false }).range(offset, offset + limit - 1),
      'outbox.list',
      limit,
      offset,
    );
  }

  listDeadLetters(workspaceId: Uuid): Promise<OutboxEventRow[]> {
    return this.selectList<OutboxEventRow>(
      this.client
        .from('outbox_events')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'DEAD_LETTER')
        .order('updated_at', { ascending: false }),
      'outbox.listDeadLetters',
    );
  }

  getByDedupKey(
    destination: OutboxDestination,
    datasetId: string,
    eventId: string,
  ): Promise<OutboxEventRow | null> {
    return this.selectMaybe<OutboxEventRow>(
      this.client
        .from('outbox_events')
        .select('*')
        .eq('destination', destination)
        .eq('dataset_id', datasetId)
        .eq('event_id', eventId)
        .maybeSingle(),
      'outbox.getByDedupKey',
    );
  }

  async getByEventId(destination: OutboxDestination, eventId: string): Promise<OutboxEventRow | null> {
    const rows = await this.selectList<OutboxEventRow>(
      this.client
        .from('outbox_events')
        .select('*')
        .eq('destination', destination)
        .eq('event_id', eventId)
        .order('created_at', { ascending: false })
        .limit(1),
      'outbox.getByEventId',
    );
    return rows[0] ?? null;
  }

  listBySubmission(submissionId: Uuid): Promise<OutboxEventRow[]> {
    return this.selectList<OutboxEventRow>(
      this.client
        .from('outbox_events')
        .select('*')
        .eq('submission_id', submissionId)
        .order('created_at'),
      'outbox.listBySubmission',
    );
  }

  async stats(workspaceId: Uuid): Promise<OutboxStats> {
    const rows = await this.selectList<{ status: OutboxState }>(
      this.client.from('outbox_events').select('status').eq('workspace_id', workspaceId),
      'outbox.stats',
    );
    return foldOutboxStats(rows);
  }
}

/** Shared fold so both implementations report the same numbers. */
export function foldOutboxStats(rows: readonly { status: OutboxState }[]): OutboxStats {
  const stats: OutboxStats = {
    pending: 0,
    processing: 0,
    sent: 0,
    accepted: 0,
    failedRetrying: 0,
    deadLetter: 0,
    expired: 0,
  };
  for (const row of rows) {
    switch (row.status) {
      case 'PENDING':
        stats.pending += 1;
        break;
      case 'PROCESSING':
        stats.processing += 1;
        break;
      case 'SENT':
        stats.sent += 1;
        break;
      case 'ACCEPTED':
        stats.accepted += 1;
        break;
      case 'FAILED_RETRYING':
        stats.failedRetrying += 1;
        break;
      case 'DEAD_LETTER':
        stats.deadLetter += 1;
        break;
      case 'EXPIRED':
        stats.expired += 1;
        break;
    }
  }
  return stats;
}

export function createOutboxRepository(client: DbClient): OutboxRepository {
  return new SupabaseOutboxRepository(client);
}
