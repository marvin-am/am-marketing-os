/**
 * Learning cards: the versioned memory distilled from concluded campaigns and
 * experiments (spec §11).
 *
 * `confidence` is derived by `deriveConfidence()` from data maturity and
 * attribution coverage — a caller that tries to write a FACT without the
 * evidence to back it is corrected here rather than trusted.
 */
import { deriveConfidence, DomainError, type ConfidenceLabel } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, normalizePage, SupabaseRepository, uniqueIds } from './base';
import type { LearningCardInsert, LearningCardRow, Page, PageParams, Uuid } from '../types';

export interface LearningCardListParams extends PageParams {
  workspaceId: Uuid;
  campaignId?: Uuid;
  experimentId?: Uuid;
  confidences?: ConfidenceLabel[];
  includeSuperseded?: boolean;
}

export interface LearningCardRepository {
  list(params: LearningCardListParams): Promise<Page<LearningCardRow>>;
  getById(id: Uuid): Promise<LearningCardRow | null>;
  create(input: LearningCardInsert & { sampleSize?: number }): Promise<LearningCardRow>;
  /** Creates version n+1 and marks the predecessor superseded. */
  revise(previousId: Uuid, input: LearningCardInsert & { sampleSize?: number }): Promise<LearningCardRow>;
  loadForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, LearningCardRow[]>>;
  nextVersion(campaignId: Uuid | null, experimentId: Uuid | null): Promise<number>;
}

export class SupabaseLearningCardRepository extends SupabaseRepository implements LearningCardRepository {
  async list(params: LearningCardListParams): Promise<Page<LearningCardRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client
      .from('learning_cards')
      .select('*', { count: 'exact' })
      .eq('workspace_id', params.workspaceId);
    if (params.campaignId) query = query.eq('campaign_id', params.campaignId);
    if (params.experimentId) query = query.eq('experiment_id', params.experimentId);
    if (params.confidences?.length) query = query.in('confidence', params.confidences);
    if (!params.includeSuperseded) query = query.is('superseded_by', null);

    return this.selectCounted<LearningCardRow>(
      query.order('created_at', { ascending: false }).range(offset, offset + limit - 1),
      'learningCards.list',
      limit,
      offset,
    );
  }

  getById(id: Uuid): Promise<LearningCardRow | null> {
    return this.selectMaybe<LearningCardRow>(
      this.client.from('learning_cards').select('*').eq('id', id).maybeSingle(),
      'learningCards.getById',
    );
  }

  async create(input: LearningCardInsert & { sampleSize?: number }): Promise<LearningCardRow> {
    const { sampleSize, ...card } = input;
    const derived = deriveConfidence({
      maturity: card.data_maturity,
      attributionCoverage: card.attribution_coverage ?? null,
      sampleSize: sampleSize ?? 0,
    });

    const version = card.version ?? (await this.nextVersion(card.campaign_id ?? null, card.experiment_id ?? null));

    const row = await this.selectMaybe<LearningCardRow>(
      this.client
        .from('learning_cards')
        .insert({ ...card, version, confidence: derived })
        .select('*')
        .single(),
      'learningCards.create',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'learningCards.create' } });
    return row;
  }

  async revise(
    previousId: Uuid,
    input: LearningCardInsert & { sampleSize?: number },
  ): Promise<LearningCardRow> {
    const previous = await this.getById(previousId);
    if (!previous) {
      throw new DomainError('NOT_FOUND', { details: { context: 'learningCards.revise', previousId } });
    }
    const next = await this.create({ ...input, version: previous.version + 1 });
    await this.client.from('learning_cards').update({ superseded_by: next.id }).eq('id', previousId);
    return next;
  }

  async loadForCampaigns(campaignIds: readonly Uuid[]): Promise<Map<Uuid, LearningCardRow[]>> {
    const ids = uniqueIds(campaignIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<LearningCardRow>(
      this.client
        .from('learning_cards')
        .select('*')
        .in('campaign_id', ids)
        .is('superseded_by', null)
        .order('created_at', { ascending: false }),
      'learningCards.loadForCampaigns',
    );
    return groupBy(rows, (row) => row.campaign_id);
  }

  async nextVersion(campaignId: Uuid | null, experimentId: Uuid | null): Promise<number> {
    let query = this.client.from('learning_cards').select('version');
    query = campaignId ? query.eq('campaign_id', campaignId) : query.is('campaign_id', null);
    query = experimentId ? query.eq('experiment_id', experimentId) : query.is('experiment_id', null);
    const rows = await this.selectList<{ version: number }>(
      query.order('version', { ascending: false }).limit(1),
      'learningCards.nextVersion',
    );
    return (rows[0]?.version ?? 0) + 1;
  }
}

export function createLearningCardRepository(client: DbClient): LearningCardRepository {
  return new SupabaseLearningCardRepository(client);
}
