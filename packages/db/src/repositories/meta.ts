/**
 * Meta ad objects, daily insights and the external-command log.
 *
 * Every upsert keys on `(provider, external_id)`, so re-running the historical
 * import over an overlapping window updates in place and never duplicates.
 */
import { DomainError, type MetaCommandKind } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, SupabaseRepository, uniqueIds } from './base';
import { toDomainError } from '../errors';
import type {
  CapiDispatchInsert,
  CapiDispatchRow,
  DateOnly,
  ExternalCommandInsert,
  ExternalCommandRow,
  MetaAccountInsert,
  MetaAccountRow,
  MetaAdInsert,
  MetaAdRow,
  MetaAdSetInsert,
  MetaAdSetRow,
  MetaCampaignInsert,
  MetaCampaignRow,
  MetaCreativeInsert,
  MetaCreativeRow,
  MetaInsightsDailyInsert,
  MetaInsightsDailyRow,
  Updatable,
  Uuid,
} from '../types';

export interface InsightsQuery {
  workspaceId: Uuid;
  level?: MetaInsightsDailyRow['level'];
  campaignId?: Uuid;
  metaCampaignId?: Uuid;
  from?: DateOnly;
  to?: DateOnly;
}

export interface SpendTotals {
  spend_minor: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  currency: string;
  days: number;
}

export interface MetaRepository {
  upsertAccount(input: MetaAccountInsert): Promise<MetaAccountRow>;
  listAccounts(workspaceId: Uuid): Promise<MetaAccountRow[]>;
  getPrimaryAccount(workspaceId: Uuid): Promise<MetaAccountRow | null>;

  upsertCampaigns(inputs: readonly MetaCampaignInsert[]): Promise<MetaCampaignRow[]>;
  upsertAdSets(inputs: readonly MetaAdSetInsert[]): Promise<MetaAdSetRow[]>;
  upsertCreatives(inputs: readonly MetaCreativeInsert[]): Promise<MetaCreativeRow[]>;
  upsertAds(inputs: readonly MetaAdInsert[]): Promise<MetaAdRow[]>;

  listCampaigns(workspaceId: Uuid): Promise<MetaCampaignRow[]>;
  loadAdSetsForCampaigns(metaCampaignIds: readonly Uuid[]): Promise<Map<Uuid, MetaAdSetRow[]>>;
  loadAdsForAdSets(metaAdSetIds: readonly Uuid[]): Promise<Map<Uuid, MetaAdRow[]>>;
  linkCampaign(metaCampaignId: Uuid, campaignId: Uuid): Promise<MetaCampaignRow>;

  /** Idempotent import. Returns the number of rows written. */
  upsertInsightsDaily(rows: readonly MetaInsightsDailyInsert[]): Promise<number>;
  listInsights(query: InsightsQuery): Promise<MetaInsightsDailyRow[]>;
  spendTotals(query: InsightsQuery): Promise<SpendTotals>;

  recordCapiDispatch(input: CapiDispatchInsert): Promise<CapiDispatchRow>;
  updateCapiDispatch(id: Uuid, patch: Updatable<CapiDispatchRow>): Promise<CapiDispatchRow>;
  listCapiDispatches(workspaceId: Uuid, limit?: number): Promise<CapiDispatchRow[]>;

  createCommand(input: ExternalCommandInsert): Promise<ExternalCommandRow>;
  getCommandByIdempotencyKey(key: string): Promise<ExternalCommandRow | null>;
  /** Only PROVIDER_CONFIRMED / RECONCILED may be rendered as success. */
  confirmCommand(id: Uuid, providerResponseRedacted: unknown): Promise<ExternalCommandRow>;
  failCommand(id: Uuid, error: string): Promise<ExternalCommandRow>;
  listCommands(workspaceId: Uuid, kinds?: MetaCommandKind[]): Promise<ExternalCommandRow[]>;
}

export class SupabaseMetaRepository extends SupabaseRepository implements MetaRepository {
  private async upsertExternal<TInsert extends object, TRow>(
    table: string,
    inputs: readonly TInsert[],
    context: string,
  ): Promise<TRow[]> {
    if (inputs.length === 0) return [];
    return this.selectList<TRow>(
      this.client
        .from(table)
        .upsert(inputs as TInsert[], { onConflict: 'provider,external_id' })
        .select('*'),
      context,
    );
  }

  async upsertAccount(input: MetaAccountInsert): Promise<MetaAccountRow> {
    const rows = await this.upsertExternal<MetaAccountInsert, MetaAccountRow>(
      'meta_accounts',
      [input],
      'meta.upsertAccount',
    );
    if (!rows[0]) throw new DomainError('INTERNAL', { details: { context: 'meta.upsertAccount' } });
    return rows[0];
  }

  listAccounts(workspaceId: Uuid): Promise<MetaAccountRow[]> {
    return this.selectList<MetaAccountRow>(
      this.client.from('meta_accounts').select('*').eq('workspace_id', workspaceId).order('name'),
      'meta.listAccounts',
    );
  }

  getPrimaryAccount(workspaceId: Uuid): Promise<MetaAccountRow | null> {
    return this.selectMaybe<MetaAccountRow>(
      this.client
        .from('meta_accounts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('is_primary', true)
        .maybeSingle(),
      'meta.getPrimaryAccount',
    );
  }

  upsertCampaigns(inputs: readonly MetaCampaignInsert[]): Promise<MetaCampaignRow[]> {
    return this.upsertExternal<MetaCampaignInsert, MetaCampaignRow>(
      'meta_campaigns',
      inputs,
      'meta.upsertCampaigns',
    );
  }

  upsertAdSets(inputs: readonly MetaAdSetInsert[]): Promise<MetaAdSetRow[]> {
    return this.upsertExternal<MetaAdSetInsert, MetaAdSetRow>('meta_adsets', inputs, 'meta.upsertAdSets');
  }

  upsertCreatives(inputs: readonly MetaCreativeInsert[]): Promise<MetaCreativeRow[]> {
    return this.upsertExternal<MetaCreativeInsert, MetaCreativeRow>(
      'meta_creatives',
      inputs,
      'meta.upsertCreatives',
    );
  }

  upsertAds(inputs: readonly MetaAdInsert[]): Promise<MetaAdRow[]> {
    return this.upsertExternal<MetaAdInsert, MetaAdRow>('meta_ads', inputs, 'meta.upsertAds');
  }

  listCampaigns(workspaceId: Uuid): Promise<MetaCampaignRow[]> {
    return this.selectList<MetaCampaignRow>(
      this.client
        .from('meta_campaigns')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('start_time', { ascending: false, nullsFirst: false }),
      'meta.listCampaigns',
    );
  }

  async loadAdSetsForCampaigns(metaCampaignIds: readonly Uuid[]): Promise<Map<Uuid, MetaAdSetRow[]>> {
    const ids = uniqueIds(metaCampaignIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<MetaAdSetRow>(
      this.client.from('meta_adsets').select('*').in('meta_campaign_id', ids).order('name'),
      'meta.loadAdSetsForCampaigns',
    );
    return groupBy(rows, (row) => row.meta_campaign_id);
  }

  async loadAdsForAdSets(metaAdSetIds: readonly Uuid[]): Promise<Map<Uuid, MetaAdRow[]>> {
    const ids = uniqueIds(metaAdSetIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<MetaAdRow>(
      this.client.from('meta_ads').select('*').in('meta_adset_id', ids).order('name'),
      'meta.loadAdsForAdSets',
    );
    return groupBy(rows, (row) => row.meta_adset_id);
  }

  async linkCampaign(metaCampaignId: Uuid, campaignId: Uuid): Promise<MetaCampaignRow> {
    const row = await this.selectMaybe<MetaCampaignRow>(
      this.client
        .from('meta_campaigns')
        .update({ campaign_id: campaignId })
        .eq('id', metaCampaignId)
        .select('*')
        .single(),
      'meta.linkCampaign',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'meta.linkCampaign', metaCampaignId } });
    return row;
  }

  async upsertInsightsDaily(rows: readonly MetaInsightsDailyInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.client.rpc('upsert_meta_insights_daily', { p_rows: rows });
    if (result.error) throw toDomainError(result.error, 'meta.upsertInsightsDaily');
    return typeof result.data === 'number' ? result.data : rows.length;
  }

  listInsights(query: InsightsQuery): Promise<MetaInsightsDailyRow[]> {
    let builder = this.client
      .from('meta_insights_daily')
      .select('*')
      .eq('workspace_id', query.workspaceId);
    if (query.level) builder = builder.eq('level', query.level);
    if (query.campaignId) builder = builder.eq('campaign_id', query.campaignId);
    if (query.metaCampaignId) builder = builder.eq('meta_campaign_id', query.metaCampaignId);
    if (query.from) builder = builder.gte('date_start', query.from);
    if (query.to) builder = builder.lte('date_start', query.to);
    return this.selectList<MetaInsightsDailyRow>(
      builder.order('date_start', { ascending: true }),
      'meta.listInsights',
    );
  }

  async spendTotals(query: InsightsQuery): Promise<SpendTotals> {
    const rows = await this.listInsights(query);
    return foldSpendTotals(rows);
  }

  async recordCapiDispatch(input: CapiDispatchInsert): Promise<CapiDispatchRow> {
    const row = await this.selectMaybe<CapiDispatchRow>(
      this.client
        .from('capi_dispatches')
        .upsert(input, { onConflict: 'dataset_id,event_id' })
        .select('*')
        .single(),
      'meta.recordCapiDispatch',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'meta.recordCapiDispatch' } });
    return row;
  }

  async updateCapiDispatch(id: Uuid, patch: Updatable<CapiDispatchRow>): Promise<CapiDispatchRow> {
    const row = await this.selectMaybe<CapiDispatchRow>(
      this.client.from('capi_dispatches').update(patch).eq('id', id).select('*').single(),
      'meta.updateCapiDispatch',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'meta.updateCapiDispatch', id } });
    return row;
  }

  listCapiDispatches(workspaceId: Uuid, limit = 100): Promise<CapiDispatchRow[]> {
    return this.selectList<CapiDispatchRow>(
      this.client
        .from('capi_dispatches')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(limit),
      'meta.listCapiDispatches',
    );
  }

  async createCommand(input: ExternalCommandInsert): Promise<ExternalCommandRow> {
    const row = await this.selectMaybe<ExternalCommandRow>(
      this.client
        .from('external_commands')
        .upsert(input, { onConflict: 'idempotency_key' })
        .select('*')
        .single(),
      'meta.createCommand',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'meta.createCommand' } });
    return row;
  }

  getCommandByIdempotencyKey(key: string): Promise<ExternalCommandRow | null> {
    return this.selectMaybe<ExternalCommandRow>(
      this.client.from('external_commands').select('*').eq('idempotency_key', key).maybeSingle(),
      'meta.getCommandByIdempotencyKey',
    );
  }

  async confirmCommand(id: Uuid, providerResponseRedacted: unknown): Promise<ExternalCommandRow> {
    const row = await this.selectMaybe<ExternalCommandRow>(
      this.client
        .from('external_commands')
        .update({
          state: 'PROVIDER_CONFIRMED',
          confirmed_at: new Date().toISOString(),
          provider_response_redacted: providerResponseRedacted,
          error: null,
        })
        .eq('id', id)
        .select('*')
        .single(),
      'meta.confirmCommand',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'meta.confirmCommand', id } });
    return row;
  }

  async failCommand(id: Uuid, error: string): Promise<ExternalCommandRow> {
    const row = await this.selectMaybe<ExternalCommandRow>(
      this.client
        .from('external_commands')
        .update({ state: 'FAILED', error: error.slice(0, 2000) })
        .eq('id', id)
        .select('*')
        .single(),
      'meta.failCommand',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'meta.failCommand', id } });
    return row;
  }

  listCommands(workspaceId: Uuid, kinds?: MetaCommandKind[]): Promise<ExternalCommandRow[]> {
    let query = this.client.from('external_commands').select('*').eq('workspace_id', workspaceId);
    if (kinds?.length) query = query.in('kind', kinds);
    return this.selectList<ExternalCommandRow>(
      query.order('requested_at', { ascending: false }),
      'meta.listCommands',
    );
  }
}

/** Shared fold: money stays in integer minor units throughout. */
export function foldSpendTotals(
  rows: readonly Pick<
    MetaInsightsDailyRow,
    'spend_minor' | 'impressions' | 'clicks' | 'link_clicks' | 'currency' | 'date_start'
  >[],
): SpendTotals {
  const days = new Set(rows.map((row) => row.date_start));
  return {
    spend_minor: rows.reduce((sum, row) => sum + row.spend_minor, 0),
    impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
    clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
    link_clicks: rows.reduce((sum, row) => sum + row.link_clicks, 0),
    currency: rows[0]?.currency ?? 'EUR',
    days: days.size,
  };
}

export function createMetaRepository(client: DbClient): MetaRepository {
  return new SupabaseMetaRepository(client);
}
