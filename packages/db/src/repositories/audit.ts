/**
 * Audit log. Append-only by policy (0012 grants SELECT and INSERT, nothing else).
 *
 * `before` / `after` are redacted here rather than at the call site, so an
 * accidental `append({ after: submission })` cannot leak a lead's e-mail into the
 * audit trail (AGENTS rule 7).
 */
import { DomainError, redact, type AuditAction } from '@am/domain';
import type { DbClient } from '../client';
import { normalizePage, SupabaseRepository } from './base';
import type { AuditLogInsert, AuditLogRow, Page, PageParams, Uuid } from '../types';

export interface AuditListParams extends PageParams {
  workspaceId: Uuid;
  actions?: AuditAction[];
  campaignId?: Uuid;
  actorId?: Uuid;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

export interface AuditRepository {
  append(entry: AuditLogInsert): Promise<AuditLogRow>;
  appendMany(entries: readonly AuditLogInsert[]): Promise<AuditLogRow[]>;
  list(params: AuditListParams): Promise<Page<AuditLogRow>>;
  listForEntity(workspaceId: Uuid, entityType: string, entityId: string): Promise<AuditLogRow[]>;
}

function sanitize(entry: AuditLogInsert): AuditLogInsert {
  return {
    ...entry,
    before: entry.before === undefined || entry.before === null ? null : redact(entry.before),
    after: entry.after === undefined || entry.after === null ? null : redact(entry.after),
  };
}

export class SupabaseAuditRepository extends SupabaseRepository implements AuditRepository {
  async append(entry: AuditLogInsert): Promise<AuditLogRow> {
    const row = await this.selectMaybe<AuditLogRow>(
      this.client.from('audit_logs').insert(sanitize(entry)).select('*').single(),
      'audit.append',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'audit.append' } });
    return row;
  }

  async appendMany(entries: readonly AuditLogInsert[]): Promise<AuditLogRow[]> {
    if (entries.length === 0) return [];
    return this.selectList<AuditLogRow>(
      this.client.from('audit_logs').insert(entries.map(sanitize)).select('*'),
      'audit.appendMany',
    );
  }

  async list(params: AuditListParams): Promise<Page<AuditLogRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .eq('workspace_id', params.workspaceId);
    if (params.actions?.length) query = query.in('action', params.actions);
    if (params.campaignId) query = query.eq('campaign_id', params.campaignId);
    if (params.actorId) query = query.eq('actor_id', params.actorId);
    if (params.entityType) query = query.eq('entity_type', params.entityType);
    if (params.entityId) query = query.eq('entity_id', params.entityId);
    if (params.from) query = query.gte('occurred_at', params.from);
    if (params.to) query = query.lte('occurred_at', params.to);

    return this.selectCounted<AuditLogRow>(
      query.order('occurred_at', { ascending: false }).range(offset, offset + limit - 1),
      'audit.list',
      limit,
      offset,
    );
  }

  listForEntity(workspaceId: Uuid, entityType: string, entityId: string): Promise<AuditLogRow[]> {
    return this.selectList<AuditLogRow>(
      this.client
        .from('audit_logs')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('occurred_at', { ascending: false }),
      'audit.listForEntity',
    );
  }
}

export function createAuditRepository(client: DbClient): AuditRepository {
  return new SupabaseAuditRepository(client);
}
