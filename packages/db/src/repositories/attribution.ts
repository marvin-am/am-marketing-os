/**
 * Attribution snapshots and touchpoints.
 *
 * Snapshots are written once, by `submit_lead_transactional`, and are then
 * frozen by a database trigger. This repository therefore exposes reads and an
 * append-only touchpoint write — there is deliberately no `updateSnapshot`.
 */
import { attributionCoverage, isTrustworthy, rate, type AttributionConfidence, type Rate } from '@am/domain';
import { DomainError } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, indexBy, SupabaseRepository, uniqueIds } from './base';
import type { AttributionSnapshotRow, TouchpointInsert, TouchpointRow, Uuid } from '../types';

export interface AttributionRepository {
  getSnapshot(submissionId: Uuid): Promise<AttributionSnapshotRow | null>;
  getSnapshotById(id: Uuid): Promise<AttributionSnapshotRow | null>;
  loadSnapshotsForSubmissions(submissionIds: readonly Uuid[]): Promise<Map<Uuid, AttributionSnapshotRow>>;
  listSnapshotsForCampaign(campaignId: Uuid): Promise<AttributionSnapshotRow[]>;
  /** Share of a campaign's snapshots with EXACT/HIGH_CONFIDENCE attribution. */
  coverageForCampaign(campaignId: Uuid): Promise<Rate>;
  confidenceBreakdown(campaignId: Uuid): Promise<Record<AttributionConfidence, number>>;

  appendTouchpoint(input: TouchpointInsert): Promise<TouchpointRow>;
  listTouchpoints(visitorId: Uuid): Promise<TouchpointRow[]>;
  loadTouchpointsForVisitors(visitorIds: readonly Uuid[]): Promise<Map<Uuid, TouchpointRow[]>>;
}

export class SupabaseAttributionRepository extends SupabaseRepository implements AttributionRepository {
  getSnapshot(submissionId: Uuid): Promise<AttributionSnapshotRow | null> {
    return this.selectMaybe<AttributionSnapshotRow>(
      this.client.from('attribution_snapshots').select('*').eq('submission_id', submissionId).maybeSingle(),
      'attribution.getSnapshot',
    );
  }

  getSnapshotById(id: Uuid): Promise<AttributionSnapshotRow | null> {
    return this.selectMaybe<AttributionSnapshotRow>(
      this.client.from('attribution_snapshots').select('*').eq('id', id).maybeSingle(),
      'attribution.getSnapshotById',
    );
  }

  async loadSnapshotsForSubmissions(
    submissionIds: readonly Uuid[],
  ): Promise<Map<Uuid, AttributionSnapshotRow>> {
    const ids = uniqueIds(submissionIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<AttributionSnapshotRow>(
      this.client.from('attribution_snapshots').select('*').in('submission_id', ids),
      'attribution.loadSnapshotsForSubmissions',
    );
    return indexBy(rows, (row) => row.submission_id);
  }

  listSnapshotsForCampaign(campaignId: Uuid): Promise<AttributionSnapshotRow[]> {
    return this.selectList<AttributionSnapshotRow>(
      this.client
        .from('attribution_snapshots')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false }),
      'attribution.listSnapshotsForCampaign',
    );
  }

  async coverageForCampaign(campaignId: Uuid): Promise<Rate> {
    const rows = await this.selectList<{ confidence: AttributionConfidence }>(
      this.client.from('attribution_snapshots').select('confidence').eq('campaign_id', campaignId),
      'attribution.coverageForCampaign',
    );
    const trusted = rows.filter((row) => isTrustworthy(row.confidence)).length;
    // `attributionCoverage` is the domain's definition; keep both in step.
    const share = attributionCoverage(rows.map((row) => row.confidence));
    const computed = rate(trusted, rows.length);
    return share === null ? computed : { ...computed, value: share };
  }

  async confidenceBreakdown(campaignId: Uuid): Promise<Record<AttributionConfidence, number>> {
    const rows = await this.selectList<{ confidence: AttributionConfidence }>(
      this.client.from('attribution_snapshots').select('confidence').eq('campaign_id', campaignId),
      'attribution.confidenceBreakdown',
    );
    const breakdown: Record<AttributionConfidence, number> = {
      EXACT: 0,
      HIGH_CONFIDENCE: 0,
      MEDIUM_CONFIDENCE: 0,
      LOW_CONFIDENCE: 0,
      UNKNOWN: 0,
    };
    for (const row of rows) breakdown[row.confidence] += 1;
    return breakdown;
  }

  async appendTouchpoint(input: TouchpointInsert): Promise<TouchpointRow> {
    const row = await this.selectMaybe<TouchpointRow>(
      this.client.from('touchpoints').insert(input).select('*').single(),
      'attribution.appendTouchpoint',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'attribution.appendTouchpoint' } });
    return row;
  }

  listTouchpoints(visitorId: Uuid): Promise<TouchpointRow[]> {
    return this.selectList<TouchpointRow>(
      this.client.from('touchpoints').select('*').eq('visitor_id', visitorId).order('occurred_at'),
      'attribution.listTouchpoints',
    );
  }

  async loadTouchpointsForVisitors(visitorIds: readonly Uuid[]): Promise<Map<Uuid, TouchpointRow[]>> {
    const ids = uniqueIds(visitorIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<TouchpointRow>(
      this.client.from('touchpoints').select('*').in('visitor_id', ids).order('occurred_at'),
      'attribution.loadTouchpointsForVisitors',
    );
    return groupBy(rows, (row) => row.visitor_id);
  }
}

export function createAttributionRepository(client: DbClient): AttributionRepository {
  return new SupabaseAttributionRepository(client);
}
