/**
 * Campaign aggregate: the campaign, its versions, its approvals.
 *
 * State transitions are validated against `CAMPAIGN_TRANSITIONS` from
 * `@am/domain` before they touch the database, so an illegal move fails with a
 * German `DomainError` rather than a silent write.
 */
import {
  canTransition,
  CAMPAIGN_STATE_LABELS_DE,
  DomainError,
  type ApprovalKind,
  type ApprovalState,
  type CampaignErrorState,
  type CampaignState,
} from '@am/domain';
import type { DbClient } from '../client';
import {
  groupBy,
  normalizePage,
  SupabaseRepository,
  uniqueIds,
} from './base';
import type {
  ApprovalInsert,
  ApprovalRow,
  CampaignInsert,
  CampaignRow,
  CampaignUpdate,
  CampaignVersionInsert,
  CampaignVersionRow,
  Page,
  PageParams,
  Uuid,
} from '../types';

export interface CampaignListParams extends PageParams {
  workspaceId: Uuid;
  states?: CampaignState[];
  search?: string;
  tags?: string[];
  includeArchived?: boolean;
  orderBy?: 'updated_at' | 'created_at' | 'name';
  direction?: 'asc' | 'desc';
}

export interface CampaignRepository {
  list(params: CampaignListParams): Promise<Page<CampaignRow>>;
  getById(id: Uuid): Promise<CampaignRow | null>;
  getBySlug(workspaceId: Uuid, slug: string): Promise<CampaignRow | null>;
  countsByState(workspaceId: Uuid): Promise<Record<string, number>>;
  create(input: CampaignInsert): Promise<CampaignRow>;
  update(id: Uuid, patch: CampaignUpdate): Promise<CampaignRow>;
  transitionState(id: Uuid, to: CampaignState, actorId: Uuid | null): Promise<CampaignRow>;
  setErrorState(id: Uuid, errorState: CampaignErrorState | null, detailDe: string | null): Promise<CampaignRow>;

  listVersions(campaignId: Uuid): Promise<CampaignVersionRow[]>;
  getVersion(id: Uuid): Promise<CampaignVersionRow | null>;
  createVersion(input: CampaignVersionInsert): Promise<CampaignVersionRow>;
  publishVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<CampaignVersionRow>;
  /** Batched: one query for many campaigns instead of one query per campaign. */
  loadVersionsForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, CampaignVersionRow[]>>;

  listApprovals(campaignId: Uuid): Promise<ApprovalRow[]>;
  loadApprovalsForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, ApprovalRow[]>>;
  upsertApproval(input: ApprovalInsert): Promise<ApprovalRow>;
  decideApproval(
    id: Uuid,
    decision: { state: Extract<ApprovalState, 'APPROVED' | 'REJECTED'>; actorId: Uuid | null; contentHash?: string; reasonDe?: string },
  ): Promise<ApprovalRow>;
  /** A content change invalidates every approval taken against the old content. */
  invalidateApprovals(campaignId: Uuid, kinds: readonly ApprovalKind[], reasonDe: string): Promise<ApprovalRow[]>;
}

const CAMPAIGN_COLUMNS = '*';

export class SupabaseCampaignRepository extends SupabaseRepository implements CampaignRepository {
  async list(params: CampaignListParams): Promise<Page<CampaignRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client
      .from('campaigns')
      .select(CAMPAIGN_COLUMNS, { count: 'exact' })
      .eq('workspace_id', params.workspaceId);

    if (params.states?.length) query = query.in('state', params.states);
    else if (!params.includeArchived) query = query.neq('state', 'ARCHIVED');

    if (params.search) query = query.ilike('name', `%${params.search}%`);
    if (params.tags?.length) query = query.overlaps('tags', params.tags);

    query = query
      .order(params.orderBy ?? 'updated_at', { ascending: params.direction === 'asc' })
      .range(offset, offset + limit - 1);

    return this.selectCounted<CampaignRow>(query, 'campaigns.list', limit, offset);
  }

  getById(id: Uuid): Promise<CampaignRow | null> {
    return this.selectMaybe<CampaignRow>(
      this.client.from('campaigns').select(CAMPAIGN_COLUMNS).eq('id', id).maybeSingle(),
      'campaigns.getById',
    );
  }

  getBySlug(workspaceId: Uuid, slug: string): Promise<CampaignRow | null> {
    return this.selectMaybe<CampaignRow>(
      this.client
        .from('campaigns')
        .select(CAMPAIGN_COLUMNS)
        .eq('workspace_id', workspaceId)
        .eq('slug', slug)
        .maybeSingle(),
      'campaigns.getBySlug',
    );
  }

  async countsByState(workspaceId: Uuid): Promise<Record<string, number>> {
    const rows = await this.selectList<{ state: CampaignState }>(
      this.client.from('campaigns').select('state').eq('workspace_id', workspaceId),
      'campaigns.countsByState',
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
    return counts;
  }

  async create(input: CampaignInsert): Promise<CampaignRow> {
    const row = await this.selectMaybe<CampaignRow>(
      this.client.from('campaigns').insert(input).select(CAMPAIGN_COLUMNS).single(),
      'campaigns.create',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'campaigns.create' } });
    return row;
  }

  async update(id: Uuid, patch: CampaignUpdate): Promise<CampaignRow> {
    const row = await this.selectMaybe<CampaignRow>(
      this.client.from('campaigns').update(patch).eq('id', id).select(CAMPAIGN_COLUMNS).single(),
      'campaigns.update',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'campaigns.update', id } });
    return row;
  }

  async transitionState(id: Uuid, to: CampaignState, actorId: Uuid | null): Promise<CampaignRow> {
    const current = await this.getById(id);
    if (!current) throw new DomainError('NOT_FOUND', { details: { context: 'campaigns.transitionState', id } });

    if (current.state === to) return current;

    if (!canTransition(current.state, to)) {
      throw new DomainError('CONFLICT', {
        messageDe: `Übergang von „${CAMPAIGN_STATE_LABELS_DE[current.state]}“ nach „${CAMPAIGN_STATE_LABELS_DE[to]}“ ist nicht zulässig.`,
        details: { from: current.state, to },
      });
    }

    const now = new Date().toISOString();
    const patch: CampaignUpdate = { state: to, updated_by: actorId };
    if (to === 'LIVE') patch.launched_at = current.launched_at ?? now;
    if (to === 'PAUSED') patch.paused_at = now;
    if (to === 'COMPLETED') patch.completed_at = now;
    if (to === 'ARCHIVED') patch.archived_at = now;

    return this.update(id, patch);
  }

  setErrorState(id: Uuid, errorState: CampaignErrorState | null, detailDe: string | null): Promise<CampaignRow> {
    return this.update(id, { error_state: errorState, error_detail_de: detailDe });
  }

  listVersions(campaignId: Uuid): Promise<CampaignVersionRow[]> {
    return this.selectList<CampaignVersionRow>(
      this.client
        .from('campaign_versions')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('version', { ascending: false }),
      'campaigns.listVersions',
    );
  }

  getVersion(id: Uuid): Promise<CampaignVersionRow | null> {
    return this.selectMaybe<CampaignVersionRow>(
      this.client.from('campaign_versions').select('*').eq('id', id).maybeSingle(),
      'campaigns.getVersion',
    );
  }

  async createVersion(input: CampaignVersionInsert): Promise<CampaignVersionRow> {
    const row = await this.selectMaybe<CampaignVersionRow>(
      this.client.from('campaign_versions').insert(input).select('*').single(),
      'campaigns.createVersion',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'campaigns.createVersion' } });
    return row;
  }

  async publishVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<CampaignVersionRow> {
    const row = await this.selectMaybe<CampaignVersionRow>(
      this.client
        .from('campaign_versions')
        .update({ state: 'PUBLISHED', published_at: new Date().toISOString(), published_by: publishedBy })
        .eq('id', versionId)
        .eq('state', 'DRAFT')
        .select('*')
        .maybeSingle(),
      'campaigns.publishVersion',
    );
    if (!row) {
      throw new DomainError('IMMUTABLE_VERSION', {
        messageDe: 'Diese Version ist bereits veröffentlicht oder archiviert und kann nicht erneut veröffentlicht werden.',
        details: { versionId },
      });
    }
    await this.client.from('campaigns').update({ current_version_id: row.id }).eq('id', row.campaign_id);
    return row;
  }

  async loadVersionsForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, CampaignVersionRow[]>> {
    const ids = uniqueIds(campaignIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<CampaignVersionRow>(
      this.client
        .from('campaign_versions')
        .select('*')
        .in('campaign_id', ids)
        .order('version', { ascending: false }),
      'campaigns.loadVersionsForCampaigns',
    );
    return groupBy(rows, (row) => row.campaign_id);
  }

  listApprovals(campaignId: Uuid): Promise<ApprovalRow[]> {
    return this.selectList<ApprovalRow>(
      this.client
        .from('approvals')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false }),
      'campaigns.listApprovals',
    );
  }

  async loadApprovalsForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, ApprovalRow[]>> {
    const ids = uniqueIds(campaignIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<ApprovalRow>(
      this.client
        .from('approvals')
        .select('*')
        .in('campaign_id', ids)
        .order('created_at', { ascending: false }),
      'campaigns.loadApprovalsForCampaigns',
    );
    return groupBy(rows, (row) => row.campaign_id);
  }

  async upsertApproval(input: ApprovalInsert): Promise<ApprovalRow> {
    const row = await this.selectMaybe<ApprovalRow>(
      this.client
        .from('approvals')
        .upsert(input, { onConflict: 'campaign_id,kind', ignoreDuplicates: false })
        .select('*')
        .single(),
      'campaigns.upsertApproval',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'campaigns.upsertApproval' } });
    return row;
  }

  async decideApproval(
    id: Uuid,
    decision: {
      state: Extract<ApprovalState, 'APPROVED' | 'REJECTED'>;
      actorId: Uuid | null;
      contentHash?: string;
      reasonDe?: string;
    },
  ): Promise<ApprovalRow> {
    if (decision.state === 'APPROVED' && !decision.contentHash) {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Eine Freigabe benötigt den Content-Hash des freigegebenen Inhalts.',
        details: { approvalId: id },
      });
    }
    const row = await this.selectMaybe<ApprovalRow>(
      this.client
        .from('approvals')
        .update({
          state: decision.state,
          approved_by: decision.state === 'APPROVED' ? decision.actorId : null,
          approved_at: decision.state === 'APPROVED' ? new Date().toISOString() : null,
          approved_content_hash: decision.state === 'APPROVED' ? decision.contentHash : null,
          rejected_reason_de: decision.state === 'REJECTED' ? (decision.reasonDe ?? null) : null,
          updated_by: decision.actorId,
        })
        .eq('id', id)
        .select('*')
        .single(),
      'campaigns.decideApproval',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'campaigns.decideApproval', id } });
    return row;
  }

  async invalidateApprovals(
    campaignId: Uuid,
    kinds: readonly ApprovalKind[],
    reasonDe: string,
  ): Promise<ApprovalRow[]> {
    if (kinds.length === 0) return [];
    return this.selectList<ApprovalRow>(
      this.client
        .from('approvals')
        .update({
          state: 'INVALIDATED',
          invalidated_at: new Date().toISOString(),
          invalidated_reason_de: reasonDe,
        })
        .eq('campaign_id', campaignId)
        .in('kind', kinds as string[])
        .eq('state', 'APPROVED')
        .select('*'),
      'campaigns.invalidateApprovals',
    );
  }
}

export function createCampaignRepository(client: DbClient): CampaignRepository {
  return new SupabaseCampaignRepository(client);
}
