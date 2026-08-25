/**
 * HubSpot mapping, mirrored objects, sync attempts and observed stage history.
 *
 * A mapping with anything left in `missing_fields` cannot be published — the
 * database CHECK enforces it — so `MAPPING_INCOMPLETE` is a real state rather
 * than a hopeful assumption (AGENTS rule 1).
 */
import { DomainError, type SyncStatus } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, SupabaseRepository, uniqueIds } from './base';
import type {
  HubspotMappingInsert,
  HubspotMappingRow,
  HubspotObjectInsert,
  HubspotObjectRow,
  HubspotObjectType,
  HubspotStageHistoryInsert,
  HubspotStageHistoryRow,
  HubspotSyncAttemptInsert,
  HubspotSyncAttemptRow,
  Updatable,
  Uuid,
} from '../types';

export interface HubspotRepository {
  listMappings(workspaceId: Uuid, objectType?: HubspotObjectType): Promise<HubspotMappingRow[]>;
  getActiveMapping(workspaceId: Uuid, objectType: HubspotObjectType): Promise<HubspotMappingRow | null>;
  createMapping(input: HubspotMappingInsert): Promise<HubspotMappingRow>;
  updateMapping(id: Uuid, patch: Updatable<HubspotMappingRow>): Promise<HubspotMappingRow>;
  publishMapping(id: Uuid, publishedBy: Uuid | null): Promise<HubspotMappingRow>;
  /** Every required mapping still missing across all three object types. */
  missingMappings(workspaceId: Uuid): Promise<Record<HubspotObjectType, string[]>>;

  upsertObject(input: HubspotObjectInsert): Promise<HubspotObjectRow>;
  getObjectByExternalId(externalId: string): Promise<HubspotObjectRow | null>;
  listObjects(workspaceId: Uuid, objectType?: HubspotObjectType): Promise<HubspotObjectRow[]>;

  recordSyncAttempt(input: HubspotSyncAttemptInsert): Promise<HubspotSyncAttemptRow>;
  listSyncAttempts(submissionId: Uuid): Promise<HubspotSyncAttemptRow[]>;
  listFailedAttempts(workspaceId: Uuid, statuses?: SyncStatus[]): Promise<HubspotSyncAttemptRow[]>;
  loadAttemptsForSubmissions(submissionIds: readonly Uuid[]): Promise<Map<Uuid, HubspotSyncAttemptRow[]>>;
  nextAttemptNumber(submissionId: Uuid): Promise<number>;

  recordStageHistory(
    input: HubspotStageHistoryInsert,
  ): Promise<{ row: HubspotStageHistoryRow | null; created: boolean }>;
  listStageHistory(externalId: string): Promise<HubspotStageHistoryRow[]>;
}

export class SupabaseHubspotRepository extends SupabaseRepository implements HubspotRepository {
  listMappings(workspaceId: Uuid, objectType?: HubspotObjectType): Promise<HubspotMappingRow[]> {
    let query = this.client.from('hubspot_mappings').select('*').eq('workspace_id', workspaceId);
    if (objectType) query = query.eq('object_type', objectType);
    return this.selectList<HubspotMappingRow>(
      query.order('version', { ascending: false }),
      'hubspot.listMappings',
    );
  }

  getActiveMapping(workspaceId: Uuid, objectType: HubspotObjectType): Promise<HubspotMappingRow | null> {
    return this.selectMaybe<HubspotMappingRow>(
      this.client
        .from('hubspot_mappings')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('object_type', objectType)
        .eq('state', 'PUBLISHED')
        .maybeSingle(),
      'hubspot.getActiveMapping',
    );
  }

  async createMapping(input: HubspotMappingInsert): Promise<HubspotMappingRow> {
    const row = await this.selectMaybe<HubspotMappingRow>(
      this.client.from('hubspot_mappings').insert(input).select('*').single(),
      'hubspot.createMapping',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'hubspot.createMapping' } });
    return row;
  }

  async updateMapping(id: Uuid, patch: Updatable<HubspotMappingRow>): Promise<HubspotMappingRow> {
    const row = await this.selectMaybe<HubspotMappingRow>(
      this.client.from('hubspot_mappings').update(patch).eq('id', id).select('*').single(),
      'hubspot.updateMapping',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'hubspot.updateMapping', id } });
    return row;
  }

  async publishMapping(id: Uuid, publishedBy: Uuid | null): Promise<HubspotMappingRow> {
    const current = await this.selectMaybe<HubspotMappingRow>(
      this.client.from('hubspot_mappings').select('*').eq('id', id).maybeSingle(),
      'hubspot.publishMapping.read',
    );
    if (!current) throw new DomainError('NOT_FOUND', { details: { context: 'hubspot.publishMapping', id } });
    if (current.missing_fields.length > 0) {
      throw new DomainError('MAPPING_INCOMPLETE', {
        messageDe: `Das HubSpot-Mapping ist unvollständig. Es fehlen: ${current.missing_fields.join(', ')}.`,
        details: { missing: current.missing_fields, objectType: current.object_type },
      });
    }
    return this.updateMapping(id, {
      state: 'PUBLISHED',
      published_at: new Date().toISOString(),
      published_by: publishedBy,
    });
  }

  async missingMappings(workspaceId: Uuid): Promise<Record<HubspotObjectType, string[]>> {
    const rows = await this.listMappings(workspaceId);
    const result: Record<HubspotObjectType, string[]> = { CONTACT: [], COMPANY: [], DEAL: [] };
    for (const type of Object.keys(result) as HubspotObjectType[]) {
      const latest = rows.filter((row) => row.object_type === type).sort((a, b) => b.version - a.version)[0];
      result[type] = latest ? latest.missing_fields : ['Kein Mapping angelegt'];
    }
    return result;
  }

  async upsertObject(input: HubspotObjectInsert): Promise<HubspotObjectRow> {
    const row = await this.selectMaybe<HubspotObjectRow>(
      this.client
        .from('hubspot_objects')
        .upsert(input, { onConflict: 'provider,external_id' })
        .select('*')
        .single(),
      'hubspot.upsertObject',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'hubspot.upsertObject' } });
    return row;
  }

  getObjectByExternalId(externalId: string): Promise<HubspotObjectRow | null> {
    return this.selectMaybe<HubspotObjectRow>(
      this.client.from('hubspot_objects').select('*').eq('external_id', externalId).maybeSingle(),
      'hubspot.getObjectByExternalId',
    );
  }

  listObjects(workspaceId: Uuid, objectType?: HubspotObjectType): Promise<HubspotObjectRow[]> {
    let query = this.client.from('hubspot_objects').select('*').eq('workspace_id', workspaceId);
    if (objectType) query = query.eq('object_type', objectType);
    return this.selectList<HubspotObjectRow>(
      query.order('updated_at', { ascending: false }),
      'hubspot.listObjects',
    );
  }

  async recordSyncAttempt(input: HubspotSyncAttemptInsert): Promise<HubspotSyncAttemptRow> {
    const row = await this.selectMaybe<HubspotSyncAttemptRow>(
      this.client.from('hubspot_sync_attempts').insert(input).select('*').single(),
      'hubspot.recordSyncAttempt',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'hubspot.recordSyncAttempt' } });
    return row;
  }

  listSyncAttempts(submissionId: Uuid): Promise<HubspotSyncAttemptRow[]> {
    return this.selectList<HubspotSyncAttemptRow>(
      this.client
        .from('hubspot_sync_attempts')
        .select('*')
        .eq('submission_id', submissionId)
        .order('attempt_number'),
      'hubspot.listSyncAttempts',
    );
  }

  listFailedAttempts(
    workspaceId: Uuid,
    statuses: SyncStatus[] = ['FAILED_RETRYING', 'DEAD_LETTER'],
  ): Promise<HubspotSyncAttemptRow[]> {
    return this.selectList<HubspotSyncAttemptRow>(
      this.client
        .from('hubspot_sync_attempts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .in('status', statuses)
        .order('started_at', { ascending: false }),
      'hubspot.listFailedAttempts',
    );
  }

  async loadAttemptsForSubmissions(
    submissionIds: readonly Uuid[],
  ): Promise<Map<Uuid, HubspotSyncAttemptRow[]>> {
    const ids = uniqueIds(submissionIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<HubspotSyncAttemptRow>(
      this.client.from('hubspot_sync_attempts').select('*').in('submission_id', ids).order('attempt_number'),
      'hubspot.loadAttemptsForSubmissions',
    );
    return groupBy(rows, (row) => row.submission_id);
  }

  async nextAttemptNumber(submissionId: Uuid): Promise<number> {
    const rows = await this.selectList<{ attempt_number: number }>(
      this.client
        .from('hubspot_sync_attempts')
        .select('attempt_number')
        .eq('submission_id', submissionId)
        .order('attempt_number', { ascending: false })
        .limit(1),
      'hubspot.nextAttemptNumber',
    );
    return (rows[0]?.attempt_number ?? 0) + 1;
  }

  async recordStageHistory(
    input: HubspotStageHistoryInsert,
  ): Promise<{ row: HubspotStageHistoryRow | null; created: boolean }> {
    const result = await this.client
      .from('hubspot_stage_history')
      .insert(input)
      .select('*')
      .maybeSingle();

    // 23505 means the same transition was already observed. That is the point.
    if (result.error && result.error.code === '23505') return { row: null, created: false };
    const row = await this.selectMaybe<HubspotStageHistoryRow>(
      Promise.resolve(result),
      'hubspot.recordStageHistory',
    );
    return { row, created: row !== null };
  }

  listStageHistory(externalId: string): Promise<HubspotStageHistoryRow[]> {
    return this.selectList<HubspotStageHistoryRow>(
      this.client.from('hubspot_stage_history').select('*').eq('external_id', externalId).order('occurred_at'),
      'hubspot.listStageHistory',
    );
  }
}

export function createHubspotRepository(client: DbClient): HubspotRepository {
  return new SupabaseHubspotRepository(client);
}
