/**
 * AI campaign proposals. One accepted proposal per campaign, enforced by a
 * partial unique index; every regeneration keeps its predecessor for the audit
 * trail rather than overwriting it.
 */
import { DomainError } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, SupabaseRepository, uniqueIds } from './base';
import type { CampaignProposalInsert, CampaignProposalRow, Uuid } from '../types';

export interface ProposalRepository {
  listByCampaign(campaignId: Uuid): Promise<CampaignProposalRow[]>;
  getById(id: Uuid): Promise<CampaignProposalRow | null>;
  getAccepted(campaignId: Uuid): Promise<CampaignProposalRow | null>;
  nextGenerationIndex(campaignId: Uuid): Promise<number>;
  create(input: CampaignProposalInsert): Promise<CampaignProposalRow>;
  accept(id: Uuid, acceptedBy: Uuid | null): Promise<CampaignProposalRow>;
  reject(id: Uuid, reasonDe: string): Promise<CampaignProposalRow>;
  supersede(id: Uuid, supersededBy: Uuid): Promise<CampaignProposalRow>;
  /** Batched loader for the campaign list view. */
  loadForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, CampaignProposalRow[]>>;
}

export class SupabaseProposalRepository extends SupabaseRepository implements ProposalRepository {
  listByCampaign(campaignId: Uuid): Promise<CampaignProposalRow[]> {
    return this.selectList<CampaignProposalRow>(
      this.client
        .from('campaign_proposals')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('generation_index', { ascending: false }),
      'proposals.listByCampaign',
    );
  }

  getById(id: Uuid): Promise<CampaignProposalRow | null> {
    return this.selectMaybe<CampaignProposalRow>(
      this.client.from('campaign_proposals').select('*').eq('id', id).maybeSingle(),
      'proposals.getById',
    );
  }

  getAccepted(campaignId: Uuid): Promise<CampaignProposalRow | null> {
    return this.selectMaybe<CampaignProposalRow>(
      this.client
        .from('campaign_proposals')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('accepted', true)
        .maybeSingle(),
      'proposals.getAccepted',
    );
  }

  async nextGenerationIndex(campaignId: Uuid): Promise<number> {
    const rows = await this.selectList<{ generation_index: number }>(
      this.client
        .from('campaign_proposals')
        .select('generation_index')
        .eq('campaign_id', campaignId)
        .order('generation_index', { ascending: false })
        .limit(1),
      'proposals.nextGenerationIndex',
    );
    return (rows[0]?.generation_index ?? 0) + 1;
  }

  async create(input: CampaignProposalInsert): Promise<CampaignProposalRow> {
    const row = await this.selectMaybe<CampaignProposalRow>(
      this.client.from('campaign_proposals').insert(input).select('*').single(),
      'proposals.create',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'proposals.create' } });
    return row;
  }

  async accept(id: Uuid, acceptedBy: Uuid | null): Promise<CampaignProposalRow> {
    const row = await this.selectMaybe<CampaignProposalRow>(
      this.client
        .from('campaign_proposals')
        .update({ accepted: true, accepted_at: new Date().toISOString(), accepted_by: acceptedBy })
        .eq('id', id)
        .select('*')
        .single(),
      'proposals.accept',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'proposals.accept', id } });
    return row;
  }

  async reject(id: Uuid, reasonDe: string): Promise<CampaignProposalRow> {
    const row = await this.selectMaybe<CampaignProposalRow>(
      this.client
        .from('campaign_proposals')
        .update({ accepted: false, rejected_reason_de: reasonDe })
        .eq('id', id)
        .select('*')
        .single(),
      'proposals.reject',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'proposals.reject', id } });
    return row;
  }

  async supersede(id: Uuid, supersededBy: Uuid): Promise<CampaignProposalRow> {
    const row = await this.selectMaybe<CampaignProposalRow>(
      this.client
        .from('campaign_proposals')
        .update({ superseded_by: supersededBy })
        .eq('id', id)
        .select('*')
        .single(),
      'proposals.supersede',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'proposals.supersede', id } });
    return row;
  }

  async loadForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, CampaignProposalRow[]>> {
    const ids = uniqueIds(campaignIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<CampaignProposalRow>(
      this.client
        .from('campaign_proposals')
        .select('*')
        .in('campaign_id', ids)
        .order('generation_index', { ascending: false }),
      'proposals.loadForCampaigns',
    );
    return groupBy(rows, (row) => row.campaign_id);
  }
}

export function createProposalRepository(client: DbClient): ProposalRepository {
  return new SupabaseProposalRepository(client);
}
