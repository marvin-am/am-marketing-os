/**
 * Daily performance rollups.
 *
 * Spec §33: no dashboard request ever reaches a provider API. It reads mirrored
 * data and these rollups, which the daily job (spec §24) recomputes.
 *
 * Two properties matter and both are structural rather than conventional:
 *
 *   * **Idempotence.** The unique key is `(workspace_id, day, dimension_key)`,
 *     and `dimension_key` is generated in the database from the six dimension
 *     columns. A recompute overwrites; it never appends a second row for the
 *     same day and dimension, and a NULL dimension does not defeat the
 *     constraint the way a plain multi-column UNIQUE would.
 *   * **Production only.** `traffic_scope` is fixed at `'PRODUCTION'` by a CHECK
 *     constraint, so a row cannot claim to include preview, internal, bot or
 *     test traffic (spec §35). Excluding that traffic is the caller's job; this
 *     layer makes a mislabelled row impossible.
 */
import { DomainError, PRODUCTION_TRAFFIC_KINDS, type DataMaturity, type TrafficKind } from '@am/domain';
import type { DbClient } from '../client';
import { SupabaseRepository, uniqueIds } from './base';
import { toDomainError } from '../errors';
import type { DateOnly, PerformanceRollupInsert, PerformanceRollupRow, Uuid } from '../types';

/** The dimension a caller wants to slice by. */
export type RollupDimension =
  | 'campaign'
  | 'campaign_version'
  | 'creative_version'
  | 'funnel_version'
  | 'experiment'
  | 'experiment_arm';

export const ROLLUP_DIMENSION_COLUMNS: Readonly<Record<RollupDimension, keyof PerformanceRollupRow>> = {
  campaign: 'campaign_id',
  campaign_version: 'campaign_version_id',
  creative_version: 'creative_version_id',
  funnel_version: 'funnel_version_id',
  experiment: 'experiment_id',
  experiment_arm: 'experiment_arm_id',
};

export interface RollupQuery {
  workspaceId: Uuid;
  since?: DateOnly;
  until?: DateOnly;
  /** Restrict to rows that carry this dimension. */
  dimension?: RollupDimension;
  /** Restrict further to these dimension values. Requires `dimension`. */
  ids?: readonly Uuid[];
  maturities?: DataMaturity[];
}

export interface RollupRepository {
  /** Idempotent upsert. Returns how many rows were written. */
  upsertDaily(rows: readonly PerformanceRollupInsert[]): Promise<number>;
  /** Distinct days that already have at least one rollup row. */
  listDays(workspaceId: Uuid, since: DateOnly, until: DateOnly): Promise<DateOnly[]>;
  query(params: RollupQuery): Promise<PerformanceRollupRow[]>;
  /** Days with production source activity whose rollups are missing or stale. */
  daysNeedingRecompute(workspaceId: Uuid, since: DateOnly, until: DateOnly): Promise<DateOnly[]>;
}

/**
 * Guard used by the rollup job before a counter is folded in. Exported so the
 * Supabase and in-memory paths cannot disagree about what "production" means.
 */
export function isRollupEligible(trafficKind: TrafficKind): boolean {
  return PRODUCTION_TRAFFIC_KINDS.includes(trafficKind);
}

function assertProductionOnly(rows: readonly PerformanceRollupInsert[]): void {
  const dirty = rows.find(
    (row) => 'traffic_scope' in row && (row as { traffic_scope?: string }).traffic_scope !== 'PRODUCTION',
  );
  if (dirty) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe:
        'In ein Rollup dürfen ausschließlich PRODUCTION-Daten einfließen. Preview-, Test- und Bot-Traffic ist ausgeschlossen.',
      details: { day: dirty.day },
    });
  }
}

export class SupabaseRollupRepository extends SupabaseRepository implements RollupRepository {
  async upsertDaily(rows: readonly PerformanceRollupInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    assertProductionOnly(rows);

    const stamped = rows.map((row) => ({ ...row, computed_at: row.computed_at ?? new Date().toISOString() }));
    const written = await this.selectList<PerformanceRollupRow>(
      this.client
        .from('performance_rollups')
        .upsert(stamped, { onConflict: 'workspace_id,day,dimension_key' })
        .select('id'),
      'rollups.upsertDaily',
    );
    return written.length;
  }

  async listDays(workspaceId: Uuid, since: DateOnly, until: DateOnly): Promise<DateOnly[]> {
    const rows = await this.selectList<{ day: DateOnly }>(
      this.client
        .from('performance_rollups')
        .select('day')
        .eq('workspace_id', workspaceId)
        .gte('day', since)
        .lte('day', until)
        .order('day', { ascending: true }),
      'rollups.listDays',
    );
    return [...new Set(rows.map((row) => row.day))];
  }

  query(params: RollupQuery): Promise<PerformanceRollupRow[]> {
    let query = this.client
      .from('performance_rollups')
      .select('*')
      .eq('workspace_id', params.workspaceId);

    if (params.since) query = query.gte('day', params.since);
    if (params.until) query = query.lte('day', params.until);
    if (params.maturities?.length) query = query.in('data_maturity', params.maturities);

    if (params.dimension) {
      const column = ROLLUP_DIMENSION_COLUMNS[params.dimension];
      const ids = uniqueIds(params.ids ?? []);
      query = ids.length > 0 ? query.in(column, ids) : query.not(column, 'is', null);
    }

    return this.selectList<PerformanceRollupRow>(
      query.order('day', { ascending: true }),
      'rollups.query',
    );
  }

  async daysNeedingRecompute(workspaceId: Uuid, since: DateOnly, until: DateOnly): Promise<DateOnly[]> {
    const result = await this.client.rpc('rollup_days_needing_recompute', {
      p_workspace_id: workspaceId,
      p_since: since,
      p_until: until,
    });
    if (result.error) throw toDomainError(result.error, 'rollups.daysNeedingRecompute');
    const rows = (result.data ?? []) as Array<DateOnly | { rollup_days_needing_recompute: DateOnly }>;
    return rows.map((row) => (typeof row === 'string' ? row : row.rollup_days_needing_recompute));
  }
}

export function createRollupRepository(client: DbClient): RollupRepository {
  return new SupabaseRollupRepository(client);
}
