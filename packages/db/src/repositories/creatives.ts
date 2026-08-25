/**
 * Creative aggregate: concepts → versions → renditions, plus source assets.
 *
 * The asset-review board lists every concept for a campaign with its renditions;
 * `loadRenditionsForVersions` exists so that view is two queries, not 6 × 3.
 */
import { DomainError, REQUIRED_ASPECT_RATIOS, type AspectRatio, type AssetReviewState } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, SupabaseRepository, uniqueIds } from './base';
import type {
  CreativeAssetInsert,
  CreativeAssetRow,
  CreativeConceptInsert,
  CreativeConceptRow,
  CreativeRenditionInsert,
  CreativeRenditionRow,
  CreativeVersionInsert,
  CreativeVersionRow,
  Updatable,
  Uuid,
} from '../types';

export interface CreativeRepository {
  listConcepts(campaignId: Uuid): Promise<CreativeConceptRow[]>;
  getConcept(id: Uuid): Promise<CreativeConceptRow | null>;
  createConcepts(inputs: readonly CreativeConceptInsert[]): Promise<CreativeConceptRow[]>;
  updateConcept(id: Uuid, patch: Updatable<CreativeConceptRow>): Promise<CreativeConceptRow>;
  setConceptReview(
    id: Uuid,
    state: AssetReviewState,
    reviewerId: Uuid | null,
    reasonDe?: string | null,
  ): Promise<CreativeConceptRow>;
  countApprovedConcepts(campaignId: Uuid): Promise<number>;
  loadConceptsForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, CreativeConceptRow[]>>;

  createAsset(input: CreativeAssetInsert): Promise<CreativeAssetRow>;
  listAssets(conceptId: Uuid): Promise<CreativeAssetRow[]>;

  listVersions(conceptId: Uuid): Promise<CreativeVersionRow[]>;
  getVersion(id: Uuid): Promise<CreativeVersionRow | null>;
  createVersion(input: CreativeVersionInsert): Promise<CreativeVersionRow>;
  publishVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<CreativeVersionRow>;
  approveVersion(versionId: Uuid, approvedBy: Uuid | null): Promise<CreativeVersionRow>;
  loadVersionsForConcepts(conceptIds: readonly Uuid[]): Promise<Map<Uuid, CreativeVersionRow[]>>;

  upsertRendition(input: CreativeRenditionInsert): Promise<CreativeRenditionRow>;
  listRenditions(creativeVersionId: Uuid): Promise<CreativeRenditionRow[]>;
  loadRenditionsForVersions(versionIds: readonly Uuid[]): Promise<Map<Uuid, CreativeRenditionRow[]>>;
  /** Which of `REQUIRED_ASPECT_RATIOS` a version is still missing. */
  missingRequiredRatios(creativeVersionId: Uuid): Promise<AspectRatio[]>;
}

export class SupabaseCreativeRepository extends SupabaseRepository implements CreativeRepository {
  listConcepts(campaignId: Uuid): Promise<CreativeConceptRow[]> {
    return this.selectList<CreativeConceptRow>(
      this.client
        .from('creative_concepts')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('sort_order', { ascending: true })
        .order('concept_key', { ascending: true }),
      'creatives.listConcepts',
    );
  }

  getConcept(id: Uuid): Promise<CreativeConceptRow | null> {
    return this.selectMaybe<CreativeConceptRow>(
      this.client.from('creative_concepts').select('*').eq('id', id).maybeSingle(),
      'creatives.getConcept',
    );
  }

  async createConcepts(inputs: readonly CreativeConceptInsert[]): Promise<CreativeConceptRow[]> {
    if (inputs.length === 0) return [];
    return this.selectList<CreativeConceptRow>(
      this.client.from('creative_concepts').insert(inputs as CreativeConceptInsert[]).select('*'),
      'creatives.createConcepts',
    );
  }

  async updateConcept(id: Uuid, patch: Updatable<CreativeConceptRow>): Promise<CreativeConceptRow> {
    const row = await this.selectMaybe<CreativeConceptRow>(
      this.client.from('creative_concepts').update(patch).eq('id', id).select('*').single(),
      'creatives.updateConcept',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'creatives.updateConcept', id } });
    return row;
  }

  setConceptReview(
    id: Uuid,
    state: AssetReviewState,
    reviewerId: Uuid | null,
    reasonDe: string | null = null,
  ): Promise<CreativeConceptRow> {
    return this.updateConcept(id, {
      review_state: state,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
      rejection_reason_de: state === 'REJECTED' ? reasonDe : null,
      updated_by: reviewerId,
    });
  }

  async countApprovedConcepts(campaignId: Uuid): Promise<number> {
    const result = (await this.client
      .from('creative_concepts')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('review_state', 'APPROVED')) as { count: number | null; error: { code?: string } | null };
    if (result.error) throw new DomainError('INTERNAL', { details: { context: 'creatives.countApprovedConcepts' } });
    return result.count ?? 0;
  }

  async loadConceptsForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, CreativeConceptRow[]>> {
    const ids = uniqueIds(campaignIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<CreativeConceptRow>(
      this.client
        .from('creative_concepts')
        .select('*')
        .in('campaign_id', ids)
        .order('sort_order', { ascending: true }),
      'creatives.loadConceptsForCampaigns',
    );
    return groupBy(rows, (row) => row.campaign_id);
  }

  async createAsset(input: CreativeAssetInsert): Promise<CreativeAssetRow> {
    const row = await this.selectMaybe<CreativeAssetRow>(
      this.client
        .from('creative_assets')
        .upsert(input, { onConflict: 'provider,external_id' })
        .select('*')
        .single(),
      'creatives.createAsset',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'creatives.createAsset' } });
    return row;
  }

  listAssets(conceptId: Uuid): Promise<CreativeAssetRow[]> {
    return this.selectList<CreativeAssetRow>(
      this.client.from('creative_assets').select('*').eq('concept_id', conceptId).order('created_at'),
      'creatives.listAssets',
    );
  }

  listVersions(conceptId: Uuid): Promise<CreativeVersionRow[]> {
    return this.selectList<CreativeVersionRow>(
      this.client
        .from('creative_versions')
        .select('*')
        .eq('concept_id', conceptId)
        .order('version', { ascending: false }),
      'creatives.listVersions',
    );
  }

  getVersion(id: Uuid): Promise<CreativeVersionRow | null> {
    return this.selectMaybe<CreativeVersionRow>(
      this.client.from('creative_versions').select('*').eq('id', id).maybeSingle(),
      'creatives.getVersion',
    );
  }

  async createVersion(input: CreativeVersionInsert): Promise<CreativeVersionRow> {
    const row = await this.selectMaybe<CreativeVersionRow>(
      this.client.from('creative_versions').insert(input).select('*').single(),
      'creatives.createVersion',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'creatives.createVersion' } });
    return row;
  }

  async publishVersion(versionId: Uuid, publishedBy: Uuid | null): Promise<CreativeVersionRow> {
    const row = await this.selectMaybe<CreativeVersionRow>(
      this.client
        .from('creative_versions')
        .update({ state: 'PUBLISHED', published_at: new Date().toISOString(), published_by: publishedBy })
        .eq('id', versionId)
        .eq('state', 'DRAFT')
        .select('*')
        .maybeSingle(),
      'creatives.publishVersion',
    );
    if (!row) {
      throw new DomainError('IMMUTABLE_VERSION', {
        messageDe: 'Diese Creative-Version ist bereits veröffentlicht und kann nicht erneut veröffentlicht werden.',
        details: { versionId },
      });
    }
    await this.client
      .from('creative_concepts')
      .update({ current_version_id: row.id })
      .eq('id', row.concept_id);
    return row;
  }

  async approveVersion(versionId: Uuid, approvedBy: Uuid | null): Promise<CreativeVersionRow> {
    const row = await this.selectMaybe<CreativeVersionRow>(
      this.client
        .from('creative_versions')
        .update({ review_state: 'APPROVED', approved_by: approvedBy, approved_at: new Date().toISOString() })
        .eq('id', versionId)
        .select('*')
        .single(),
      'creatives.approveVersion',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'creatives.approveVersion', versionId } });
    return row;
  }

  async loadVersionsForConcepts(conceptIds: readonly Uuid[]): Promise<Map<Uuid, CreativeVersionRow[]>> {
    const ids = uniqueIds(conceptIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<CreativeVersionRow>(
      this.client
        .from('creative_versions')
        .select('*')
        .in('concept_id', ids)
        .order('version', { ascending: false }),
      'creatives.loadVersionsForConcepts',
    );
    return groupBy(rows, (row) => row.concept_id);
  }

  async upsertRendition(input: CreativeRenditionInsert): Promise<CreativeRenditionRow> {
    const row = await this.selectMaybe<CreativeRenditionRow>(
      this.client
        .from('creative_renditions')
        .upsert(input, { onConflict: 'creative_version_id,aspect_ratio' })
        .select('*')
        .single(),
      'creatives.upsertRendition',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'creatives.upsertRendition' } });
    return row;
  }

  listRenditions(creativeVersionId: Uuid): Promise<CreativeRenditionRow[]> {
    return this.selectList<CreativeRenditionRow>(
      this.client
        .from('creative_renditions')
        .select('*')
        .eq('creative_version_id', creativeVersionId)
        .order('aspect_ratio'),
      'creatives.listRenditions',
    );
  }

  async loadRenditionsForVersions(versionIds: readonly Uuid[]): Promise<Map<Uuid, CreativeRenditionRow[]>> {
    const ids = uniqueIds(versionIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<CreativeRenditionRow>(
      this.client.from('creative_renditions').select('*').in('creative_version_id', ids).order('aspect_ratio'),
      'creatives.loadRenditionsForVersions',
    );
    return groupBy(rows, (row) => row.creative_version_id);
  }

  async missingRequiredRatios(creativeVersionId: Uuid): Promise<AspectRatio[]> {
    const present = new Set((await this.listRenditions(creativeVersionId)).map((r) => r.aspect_ratio));
    return REQUIRED_ASPECT_RATIOS.filter((ratio) => !present.has(ratio));
  }
}

export function createCreativeRepository(client: DbClient): CreativeRepository {
  return new SupabaseCreativeRepository(client);
}
