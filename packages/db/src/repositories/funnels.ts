/**
 * Funnel and form aggregate, plus the public runtime read.
 *
 * `getPublishedBySlug` goes through the SECURITY DEFINER RPC rather than a join,
 * because the funnel app runs with the anon key and has table privileges on
 * nothing but `published_funnels`.
 */
import { DomainError } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, SupabaseRepository, uniqueIds } from './base';
import { toDomainError } from '../errors';
import type {
  ConsentVersionInsert,
  ConsentVersionRow,
  FormDefinitionInsert,
  FormDefinitionRow,
  FormVersionInsert,
  FormVersionRow,
  FunnelInsert,
  FunnelRow,
  FunnelVersionInsert,
  FunnelVersionRow,
  PublishedFunnelBundle,
  PublishedFunnelInsert,
  PublishedFunnelRow,
  Updatable,
  Uuid,
} from '../types';

export interface PublishFunnelInput {
  workspace_id: Uuid;
  campaign_id: Uuid;
  funnel_id: Uuid;
  funnel_version_id: Uuid;
  form_version_id?: Uuid | null;
  experiment_id?: Uuid | null;
  public_slug: string;
  path?: string;
  environment?: PublishedFunnelRow['environment'];
  meta_pixel_id?: string | null;
  meta_dataset_id?: string | null;
  consent_version_id?: Uuid | null;
  redirect_url?: string | null;
  created_by?: Uuid | null;
}

export interface FunnelRepository {
  listByCampaign(campaignId: Uuid): Promise<FunnelRow[]>;
  getFunnel(id: Uuid): Promise<FunnelRow | null>;
  createFunnel(input: FunnelInsert): Promise<FunnelRow>;
  updateFunnel(id: Uuid, patch: Updatable<FunnelRow>): Promise<FunnelRow>;

  listFunnelVersions(funnelId: Uuid): Promise<FunnelVersionRow[]>;
  getFunnelVersion(id: Uuid): Promise<FunnelVersionRow | null>;
  createFunnelVersion(input: FunnelVersionInsert): Promise<FunnelVersionRow>;
  publishFunnelVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<FunnelVersionRow>;
  loadVersionsForFunnels(funnelIds: readonly Uuid[]): Promise<Map<Uuid, FunnelVersionRow[]>>;

  createFormDefinition(input: FormDefinitionInsert): Promise<FormDefinitionRow>;
  listFormDefinitions(funnelId: Uuid): Promise<FormDefinitionRow[]>;
  createFormVersion(input: FormVersionInsert): Promise<FormVersionRow>;
  getFormVersion(id: Uuid): Promise<FormVersionRow | null>;
  publishFormVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<FormVersionRow>;

  publish(input: PublishFunnelInput): Promise<PublishedFunnelRow>;
  unpublish(id: Uuid): Promise<PublishedFunnelRow>;
  listPublished(campaignId: Uuid): Promise<PublishedFunnelRow[]>;
  /** The public runtime read. Returns the published specs and nothing else. */
  getPublishedBySlug(slug: string): Promise<PublishedFunnelBundle | null>;

  listConsentVersions(workspaceId: Uuid): Promise<ConsentVersionRow[]>;
  createConsentVersion(input: ConsentVersionInsert): Promise<ConsentVersionRow>;
  activeConsentVersion(workspaceId: Uuid): Promise<ConsentVersionRow | null>;
}

export class SupabaseFunnelRepository extends SupabaseRepository implements FunnelRepository {
  listByCampaign(campaignId: Uuid): Promise<FunnelRow[]> {
    return this.selectList<FunnelRow>(
      this.client.from('funnels').select('*').eq('campaign_id', campaignId).order('funnel_key'),
      'funnels.listByCampaign',
    );
  }

  getFunnel(id: Uuid): Promise<FunnelRow | null> {
    return this.selectMaybe<FunnelRow>(
      this.client.from('funnels').select('*').eq('id', id).maybeSingle(),
      'funnels.getFunnel',
    );
  }

  async createFunnel(input: FunnelInsert): Promise<FunnelRow> {
    const row = await this.selectMaybe<FunnelRow>(
      this.client.from('funnels').insert(input).select('*').single(),
      'funnels.createFunnel',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'funnels.createFunnel' } });
    return row;
  }

  async updateFunnel(id: Uuid, patch: Updatable<FunnelRow>): Promise<FunnelRow> {
    const row = await this.selectMaybe<FunnelRow>(
      this.client.from('funnels').update(patch).eq('id', id).select('*').single(),
      'funnels.updateFunnel',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'funnels.updateFunnel', id } });
    return row;
  }

  listFunnelVersions(funnelId: Uuid): Promise<FunnelVersionRow[]> {
    return this.selectList<FunnelVersionRow>(
      this.client
        .from('funnel_versions')
        .select('*')
        .eq('funnel_id', funnelId)
        .order('version', { ascending: false }),
      'funnels.listFunnelVersions',
    );
  }

  getFunnelVersion(id: Uuid): Promise<FunnelVersionRow | null> {
    return this.selectMaybe<FunnelVersionRow>(
      this.client.from('funnel_versions').select('*').eq('id', id).maybeSingle(),
      'funnels.getFunnelVersion',
    );
  }

  async createFunnelVersion(input: FunnelVersionInsert): Promise<FunnelVersionRow> {
    const row = await this.selectMaybe<FunnelVersionRow>(
      this.client.from('funnel_versions').insert(input).select('*').single(),
      'funnels.createFunnelVersion',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'funnels.createFunnelVersion' } });
    return row;
  }

  async publishFunnelVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<FunnelVersionRow> {
    const row = await this.selectMaybe<FunnelVersionRow>(
      this.client
        .from('funnel_versions')
        .update({ state: 'PUBLISHED', published_at: new Date().toISOString(), published_by: publishedBy })
        .eq('id', versionId)
        .eq('state', 'DRAFT')
        .select('*')
        .maybeSingle(),
      'funnels.publishFunnelVersion',
    );
    if (!row) {
      throw new DomainError('IMMUTABLE_VERSION', {
        messageDe: 'Diese Funnel-Version ist bereits veröffentlicht und kann nicht erneut veröffentlicht werden.',
        details: { versionId },
      });
    }
    await this.client.from('funnels').update({ current_version_id: row.id }).eq('id', row.funnel_id);
    return row;
  }

  async loadVersionsForFunnels(funnelIds: readonly Uuid[]): Promise<Map<Uuid, FunnelVersionRow[]>> {
    const ids = uniqueIds(funnelIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<FunnelVersionRow>(
      this.client.from('funnel_versions').select('*').in('funnel_id', ids).order('version', { ascending: false }),
      'funnels.loadVersionsForFunnels',
    );
    return groupBy(rows, (row) => row.funnel_id);
  }

  async createFormDefinition(input: FormDefinitionInsert): Promise<FormDefinitionRow> {
    const row = await this.selectMaybe<FormDefinitionRow>(
      this.client.from('form_definitions').insert(input).select('*').single(),
      'funnels.createFormDefinition',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'funnels.createFormDefinition' } });
    return row;
  }

  listFormDefinitions(funnelId: Uuid): Promise<FormDefinitionRow[]> {
    return this.selectList<FormDefinitionRow>(
      this.client.from('form_definitions').select('*').eq('funnel_id', funnelId).order('form_key'),
      'funnels.listFormDefinitions',
    );
  }

  async createFormVersion(input: FormVersionInsert): Promise<FormVersionRow> {
    const row = await this.selectMaybe<FormVersionRow>(
      this.client.from('form_versions').insert(input).select('*').single(),
      'funnels.createFormVersion',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'funnels.createFormVersion' } });
    return row;
  }

  getFormVersion(id: Uuid): Promise<FormVersionRow | null> {
    return this.selectMaybe<FormVersionRow>(
      this.client.from('form_versions').select('*').eq('id', id).maybeSingle(),
      'funnels.getFormVersion',
    );
  }

  async publishFormVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<FormVersionRow> {
    const row = await this.selectMaybe<FormVersionRow>(
      this.client
        .from('form_versions')
        .update({ state: 'PUBLISHED', published_at: new Date().toISOString(), published_by: publishedBy })
        .eq('id', versionId)
        .eq('state', 'DRAFT')
        .select('*')
        .maybeSingle(),
      'funnels.publishFormVersion',
    );
    if (!row) {
      throw new DomainError('IMMUTABLE_VERSION', {
        messageDe: 'Diese Formularversion ist bereits veröffentlicht und kann nicht erneut veröffentlicht werden.',
        details: { versionId },
      });
    }
    await this.client
      .from('form_definitions')
      .update({ current_version_id: row.id })
      .eq('id', row.form_definition_id);
    return row;
  }

  async publish(input: PublishFunnelInput): Promise<PublishedFunnelRow> {
    const payload: PublishedFunnelInsert = {
      workspace_id: input.workspace_id,
      campaign_id: input.campaign_id,
      funnel_id: input.funnel_id,
      funnel_version_id: input.funnel_version_id,
      form_version_id: input.form_version_id ?? null,
      experiment_id: input.experiment_id ?? null,
      public_slug: input.public_slug,
      path: input.path ?? '/',
      is_live: true,
      environment: input.environment ?? 'production',
      meta_pixel_id: input.meta_pixel_id ?? null,
      meta_dataset_id: input.meta_dataset_id ?? null,
      consent_version_id: input.consent_version_id ?? null,
      redirect_url: input.redirect_url ?? null,
      published_at: new Date().toISOString(),
      unpublished_at: null,
      created_by: input.created_by ?? null,
      updated_by: input.created_by ?? null,
    };

    const row = await this.selectMaybe<PublishedFunnelRow>(
      this.client
        .from('published_funnels')
        .upsert(payload, { onConflict: 'public_slug' })
        .select('*')
        .single(),
      'funnels.publish',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'funnels.publish' } });
    return row;
  }

  async unpublish(id: Uuid): Promise<PublishedFunnelRow> {
    const row = await this.selectMaybe<PublishedFunnelRow>(
      this.client
        .from('published_funnels')
        .update({ is_live: false, unpublished_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single(),
      'funnels.unpublish',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'funnels.unpublish', id } });
    return row;
  }

  listPublished(campaignId: Uuid): Promise<PublishedFunnelRow[]> {
    return this.selectList<PublishedFunnelRow>(
      this.client
        .from('published_funnels')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('published_at', { ascending: false }),
      'funnels.listPublished',
    );
  }

  async getPublishedBySlug(slug: string): Promise<PublishedFunnelBundle | null> {
    const result = await this.client.rpc('get_published_funnel', { p_slug: slug });
    if (result.error) throw toDomainError(result.error, 'funnels.getPublishedBySlug');
    return (result.data as PublishedFunnelBundle | null) ?? null;
  }

  listConsentVersions(workspaceId: Uuid): Promise<ConsentVersionRow[]> {
    return this.selectList<ConsentVersionRow>(
      this.client
        .from('consent_versions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('version', { ascending: false }),
      'funnels.listConsentVersions',
    );
  }

  async createConsentVersion(input: ConsentVersionInsert): Promise<ConsentVersionRow> {
    const row = await this.selectMaybe<ConsentVersionRow>(
      this.client.from('consent_versions').insert(input).select('*').single(),
      'funnels.createConsentVersion',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'funnels.createConsentVersion' } });
    return row;
  }

  async activeConsentVersion(workspaceId: Uuid): Promise<ConsentVersionRow | null> {
    const rows = await this.selectList<ConsentVersionRow>(
      this.client
        .from('consent_versions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .is('effective_until', null)
        .order('version', { ascending: false })
        .limit(1),
      'funnels.activeConsentVersion',
    );
    return rows[0] ?? null;
  }
}

export function createFunnelRepository(client: DbClient): FunnelRepository {
  return new SupabaseFunnelRepository(client);
}
