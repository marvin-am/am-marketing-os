/**
 * First-party tracking writes for the public funnel runtime.
 *
 * Both writes go through SECURITY DEFINER RPCs: the anon key has no table
 * privileges on `visitors`, `sessions` or `events`, and the workspace is derived
 * from the published funnel rather than trusted from the caller.
 *
 * Nothing here may carry PII (AGENTS rule 7) — `@am/tracking` runs `assertNoPii`
 * on every payload before it reaches this layer.
 */
import type { AppEnvironment, Channel, ConsentStatus, TrafficKind } from '@am/domain';
import { DomainError } from '@am/domain';
import type { DbClient } from '../client';
import { toDomainError } from '../errors';
import { normalizePage, SupabaseRepository } from './base';
import type {
  EventRow,
  FormInstanceRow,
  Page,
  PageParams,
  SessionRow,
  Updatable,
  Uuid,
  VisitorRow,
} from '../types';

export interface EnsureVisitorSessionInput {
  public_slug: string;
  visitor_id?: Uuid | null;
  session_id?: Uuid | null;
  environment?: AppEnvironment;
  traffic_kind?: TrafficKind;
  consent_status?: ConsentStatus;
  channel?: Channel;
  landing_url?: string | null;
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  meta_campaign_id?: string | null;
  meta_adset_id?: string | null;
  meta_ad_id?: string | null;
  device_bucket?: 'MOBILE' | 'TABLET' | 'DESKTOP' | 'UNKNOWN' | null;
}

export interface EnsureVisitorSessionResult {
  visitor_id: Uuid;
  session_id: Uuid;
  workspace_id: Uuid;
  published_funnel_id: Uuid;
  campaign_id: Uuid | null;
}

export interface EventListParams extends PageParams {
  workspaceId: Uuid;
  campaignId?: Uuid;
  sessionId?: Uuid;
  eventTypes?: string[];
  from?: string;
  to?: string;
}

export interface TrackingRepository {
  ensureVisitorSession(input: EnsureVisitorSessionInput): Promise<EnsureVisitorSessionResult>;
  /** Returns how many events were genuinely new — a replayed beacon counts zero. */
  recordEvents(events: readonly Record<string, unknown>[]): Promise<number>;
  listEvents(params: EventListParams): Promise<Page<EventRow>>;
  countEventsByType(workspaceId: Uuid, campaignId?: Uuid): Promise<Record<string, number>>;
  getVisitor(id: Uuid): Promise<VisitorRow | null>;
  getSession(id: Uuid): Promise<SessionRow | null>;

  createFormInstance(input: Omit<FormInstanceRow, 'id' | 'created_at' | 'updated_at'>): Promise<FormInstanceRow>;
  updateFormInstance(id: Uuid, patch: Updatable<FormInstanceRow>): Promise<FormInstanceRow>;
  /** Open instances idle for longer than the window — the abandon job's input. */
  listAbandonCandidates(workspaceId: Uuid, idleSince: string): Promise<FormInstanceRow[]>;
}

export class SupabaseTrackingRepository extends SupabaseRepository implements TrackingRepository {
  async ensureVisitorSession(input: EnsureVisitorSessionInput): Promise<EnsureVisitorSessionResult> {
    const result = await this.client.rpc('ensure_visitor_session', { p_payload: input });
    if (result.error) throw toDomainError(result.error, 'tracking.ensureVisitorSession');
    return result.data as EnsureVisitorSessionResult;
  }

  async recordEvents(events: readonly Record<string, unknown>[]): Promise<number> {
    if (events.length === 0) return 0;
    const result = await this.client.rpc('record_tracking_events', { p_events: events });
    if (result.error) throw toDomainError(result.error, 'tracking.recordEvents');
    return typeof result.data === 'number' ? result.data : 0;
  }

  async listEvents(params: EventListParams): Promise<Page<EventRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client.from('events').select('*', { count: 'exact' }).eq('workspace_id', params.workspaceId);
    if (params.campaignId) query = query.eq('campaign_id', params.campaignId);
    if (params.sessionId) query = query.eq('session_id', params.sessionId);
    if (params.eventTypes?.length) query = query.in('event_type', params.eventTypes);
    if (params.from) query = query.gte('occurred_at', params.from);
    if (params.to) query = query.lte('occurred_at', params.to);

    return this.selectCounted<EventRow>(
      query.order('occurred_at', { ascending: false }).range(offset, offset + limit - 1),
      'tracking.listEvents',
      limit,
      offset,
    );
  }

  async countEventsByType(workspaceId: Uuid, campaignId?: Uuid): Promise<Record<string, number>> {
    let query = this.client
      .from('events')
      .select('event_type')
      .eq('workspace_id', workspaceId)
      .eq('traffic_kind', 'PRODUCTION');
    if (campaignId) query = query.eq('campaign_id', campaignId);
    const rows = await this.selectList<{ event_type: string }>(query, 'tracking.countEventsByType');
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
    return counts;
  }

  getVisitor(id: Uuid): Promise<VisitorRow | null> {
    return this.selectMaybe<VisitorRow>(
      this.client.from('visitors').select('*').eq('id', id).maybeSingle(),
      'tracking.getVisitor',
    );
  }

  getSession(id: Uuid): Promise<SessionRow | null> {
    return this.selectMaybe<SessionRow>(
      this.client.from('sessions').select('*').eq('id', id).maybeSingle(),
      'tracking.getSession',
    );
  }

  async createFormInstance(
    input: Omit<FormInstanceRow, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FormInstanceRow> {
    const row = await this.selectMaybe<FormInstanceRow>(
      this.client.from('form_instances').insert(input).select('*').single(),
      'tracking.createFormInstance',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'tracking.createFormInstance' } });
    return row;
  }

  async updateFormInstance(id: Uuid, patch: Updatable<FormInstanceRow>): Promise<FormInstanceRow> {
    const row = await this.selectMaybe<FormInstanceRow>(
      this.client.from('form_instances').update(patch).eq('id', id).select('*').single(),
      'tracking.updateFormInstance',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'tracking.updateFormInstance', id } });
    return row;
  }

  listAbandonCandidates(workspaceId: Uuid, idleSince: string): Promise<FormInstanceRow[]> {
    return this.selectList<FormInstanceRow>(
      this.client
        .from('form_instances')
        .select('*')
        .eq('workspace_id', workspaceId)
        .is('completed_at', null)
        .is('abandoned_at', null)
        .lt('last_activity_at', idleSince)
        .order('last_activity_at'),
      'tracking.listAbandonCandidates',
    );
  }
}

export function createTrackingRepository(client: DbClient): TrackingRepository {
  return new SupabaseTrackingRepository(client);
}
