/**
 * Submissions, leads, opportunities and revenue — the whole sales funnel.
 *
 * The write path is `submitLeadTransactional`. Everything else here is read or
 * a CRM-driven state transition, and a transition writes a canonical sales event
 * only when the state actually changed (acceptance criterion 32).
 */
import { DomainError, rate, type Rate, type SubmissionState, type SyncStatus, type VqStatus } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, indexBy, normalizePage, SupabaseRepository, uniqueIds } from './base';
import { toDomainError } from '../errors';
import { submitLeadTransactional, type SubmitLeadInput, type SubmitLeadResult } from '../outbox';
import type {
  FormSubmissionRow,
  LeadInsert,
  LeadRow,
  LeadStageEventInsert,
  LeadStageEventRow,
  OpportunityInsert,
  OpportunityRow,
  Page,
  PageParams,
  RevenueEventInsert,
  RevenueEventRow,
  SubmissionAnswerRow,
  SubmissionPiiRow,
  SubmissionStatusHistoryRow,
  Updatable,
  Uuid,
} from '../types';

export interface SubmissionListParams extends PageParams {
  workspaceId: Uuid;
  campaignId?: Uuid;
  experimentId?: Uuid;
  states?: SubmissionState[];
  from?: string;
  to?: string;
  /** PREVIEW/TEST traffic is excluded from every metric (spec §35). */
  productionOnly?: boolean;
}

export interface LeadListParams extends PageParams {
  workspaceId: Uuid;
  campaignId?: Uuid;
  vqStatuses?: VqStatus[];
  syncStatuses?: SyncStatus[];
  from?: string;
  to?: string;
}

/** Counts, not rates — the UI renders "12 / 340" beside "3,5 %". */
export interface FunnelCounts {
  submissions: number;
  leads: number;
  vq_scheduled: number;
  vq_attended: number;
  vq_no_show: number;
  qualified_vq: number;
  opportunities: number;
  closed_won: number;
  closed_lost: number;
  revenue_minor: number;
  trustworthy_attributions: number;
}

export interface SubmissionRepository {
  submitLead(input: SubmitLeadInput): Promise<SubmitLeadResult>;

  listSubmissions(params: SubmissionListParams): Promise<Page<FormSubmissionRow>>;
  getSubmission(id: Uuid): Promise<FormSubmissionRow | null>;
  getByAttemptId(attemptId: Uuid): Promise<FormSubmissionRow | null>;
  transitionSubmission(
    id: Uuid,
    to: SubmissionState,
    options?: { reasonDe?: string; actorLabel?: string; correlationId?: string },
  ): Promise<FormSubmissionRow>;
  listStatusHistory(submissionId: Uuid): Promise<SubmissionStatusHistoryRow[]>;

  loadAnswersForSubmissions(submissionIds: readonly Uuid[]): Promise<Map<Uuid, SubmissionAnswerRow[]>>;
  /** Ciphertext only. RLS restricts this to ADMIN / REVOPS / MARKETING_LEAD. */
  getPii(submissionId: Uuid): Promise<SubmissionPiiRow | null>;

  createLead(input: LeadInsert): Promise<LeadRow>;
  getLead(id: Uuid): Promise<LeadRow | null>;
  getLeadBySubmission(submissionId: Uuid): Promise<LeadRow | null>;
  listLeads(params: LeadListParams): Promise<Page<LeadRow>>;
  updateLead(id: Uuid, patch: Updatable<LeadRow>): Promise<LeadRow>;
  setVqEvaluation(
    id: Uuid,
    evaluation: {
      vq_status: VqStatus;
      vq_score?: number | null;
      vq_reason_codes?: string[];
      vq_model_version: string;
      occurredAt?: string;
    },
  ): Promise<LeadRow>;
  loadLeadsForSubmissions(submissionIds: readonly Uuid[]): Promise<Map<Uuid, LeadRow>>;

  recordStageEvent(input: LeadStageEventInsert): Promise<{ event: LeadStageEventRow | null; created: boolean }>;
  listStageEvents(leadId: Uuid): Promise<LeadStageEventRow[]>;
  loadStageEventsForLeads(leadIds: readonly Uuid[]): Promise<Map<Uuid, LeadStageEventRow[]>>;

  createOpportunity(input: OpportunityInsert): Promise<OpportunityRow>;
  updateOpportunity(id: Uuid, patch: Updatable<OpportunityRow>): Promise<OpportunityRow>;
  listOpportunities(workspaceId: Uuid, campaignId?: Uuid): Promise<OpportunityRow[]>;
  loadOpportunitiesForLeads(leadIds: readonly Uuid[]): Promise<Map<Uuid, OpportunityRow[]>>;
  recordRevenue(input: RevenueEventInsert): Promise<RevenueEventRow>;

  funnelCounts(params: { workspaceId: Uuid; campaignId?: Uuid; from?: string; to?: string }): Promise<FunnelCounts>;
  /** Share of a campaign's submissions with EXACT/HIGH_CONFIDENCE attribution. */
  attributionCoverage(campaignId: Uuid): Promise<Rate>;
}

export class SupabaseSubmissionRepository extends SupabaseRepository implements SubmissionRepository {
  submitLead(input: SubmitLeadInput): Promise<SubmitLeadResult> {
    return submitLeadTransactional(this.client, input);
  }

  async listSubmissions(params: SubmissionListParams): Promise<Page<FormSubmissionRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client
      .from('form_submissions')
      .select('*', { count: 'exact' })
      .eq('workspace_id', params.workspaceId);

    if (params.campaignId) query = query.eq('campaign_id', params.campaignId);
    if (params.experimentId) query = query.eq('experiment_id', params.experimentId);
    if (params.states?.length) query = query.in('state', params.states);
    if (params.from) query = query.gte('submitted_at', params.from);
    if (params.to) query = query.lte('submitted_at', params.to);
    if (params.productionOnly !== false) query = query.eq('traffic_kind', 'PRODUCTION');

    return this.selectCounted<FormSubmissionRow>(
      query.order('submitted_at', { ascending: false }).range(offset, offset + limit - 1),
      'submissions.listSubmissions',
      limit,
      offset,
    );
  }

  getSubmission(id: Uuid): Promise<FormSubmissionRow | null> {
    return this.selectMaybe<FormSubmissionRow>(
      this.client.from('form_submissions').select('*').eq('id', id).maybeSingle(),
      'submissions.getSubmission',
    );
  }

  getByAttemptId(attemptId: Uuid): Promise<FormSubmissionRow | null> {
    return this.selectMaybe<FormSubmissionRow>(
      this.client.from('form_submissions').select('*').eq('submission_attempt_id', attemptId).maybeSingle(),
      'submissions.getByAttemptId',
    );
  }

  async transitionSubmission(
    id: Uuid,
    to: SubmissionState,
    options: { reasonDe?: string; actorLabel?: string; correlationId?: string } = {},
  ): Promise<FormSubmissionRow> {
    const current = await this.getSubmission(id);
    if (!current) throw new DomainError('NOT_FOUND', { details: { context: 'submissions.transition', id } });
    if (current.state === to) return current;

    const updated = await this.selectMaybe<FormSubmissionRow>(
      this.client
        .from('form_submissions')
        .update({
          state: to,
          accepted_at: to === 'ACCEPTED' ? (current.accepted_at ?? new Date().toISOString()) : current.accepted_at,
        })
        .eq('id', id)
        .select('*')
        .single(),
      'submissions.transition',
    );
    if (!updated) throw new DomainError('NOT_FOUND', { details: { context: 'submissions.transition', id } });

    await this.client.from('submission_status_history').insert({
      workspace_id: current.workspace_id,
      submission_id: id,
      from_state: current.state,
      to_state: to,
      reason_de: options.reasonDe ?? null,
      actor_label: options.actorLabel ?? 'system',
      correlation_id: options.correlationId ?? null,
    });

    return updated;
  }

  listStatusHistory(submissionId: Uuid): Promise<SubmissionStatusHistoryRow[]> {
    return this.selectList<SubmissionStatusHistoryRow>(
      this.client
        .from('submission_status_history')
        .select('*')
        .eq('submission_id', submissionId)
        .order('occurred_at'),
      'submissions.listStatusHistory',
    );
  }

  async loadAnswersForSubmissions(submissionIds: readonly Uuid[]): Promise<Map<Uuid, SubmissionAnswerRow[]>> {
    const ids = uniqueIds(submissionIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<SubmissionAnswerRow>(
      this.client.from('submission_answers_non_pii').select('*').in('submission_id', ids).order('field_key'),
      'submissions.loadAnswersForSubmissions',
    );
    return groupBy(rows, (row) => row.submission_id);
  }

  getPii(submissionId: Uuid): Promise<SubmissionPiiRow | null> {
    return this.selectMaybe<SubmissionPiiRow>(
      this.client.from('submission_pii_encrypted').select('*').eq('submission_id', submissionId).maybeSingle(),
      'submissions.getPii',
    );
  }

  async createLead(input: LeadInsert): Promise<LeadRow> {
    const row = await this.selectMaybe<LeadRow>(
      this.client.from('leads').insert(input).select('*').single(),
      'submissions.createLead',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'submissions.createLead' } });
    await this.client.from('form_submissions').update({ lead_id: row.id }).eq('id', row.submission_id);
    return row;
  }

  getLead(id: Uuid): Promise<LeadRow | null> {
    return this.selectMaybe<LeadRow>(
      this.client.from('leads').select('*').eq('id', id).maybeSingle(),
      'submissions.getLead',
    );
  }

  getLeadBySubmission(submissionId: Uuid): Promise<LeadRow | null> {
    return this.selectMaybe<LeadRow>(
      this.client.from('leads').select('*').eq('submission_id', submissionId).maybeSingle(),
      'submissions.getLeadBySubmission',
    );
  }

  async listLeads(params: LeadListParams): Promise<Page<LeadRow>> {
    const { limit, offset } = normalizePage(params);
    let query = this.client.from('leads').select('*', { count: 'exact' }).eq('workspace_id', params.workspaceId);
    if (params.campaignId) query = query.eq('campaign_id', params.campaignId);
    if (params.vqStatuses?.length) query = query.in('vq_status', params.vqStatuses);
    if (params.syncStatuses?.length) query = query.in('sync_status', params.syncStatuses);
    if (params.from) query = query.gte('created_at', params.from);
    if (params.to) query = query.lte('created_at', params.to);

    return this.selectCounted<LeadRow>(
      query.order('created_at', { ascending: false }).range(offset, offset + limit - 1),
      'submissions.listLeads',
      limit,
      offset,
    );
  }

  async updateLead(id: Uuid, patch: Updatable<LeadRow>): Promise<LeadRow> {
    const row = await this.selectMaybe<LeadRow>(
      this.client.from('leads').update(patch).eq('id', id).select('*').single(),
      'submissions.updateLead',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'submissions.updateLead', id } });
    return row;
  }

  setVqEvaluation(
    id: Uuid,
    evaluation: {
      vq_status: VqStatus;
      vq_score?: number | null;
      vq_reason_codes?: string[];
      vq_model_version: string;
      occurredAt?: string;
    },
  ): Promise<LeadRow> {
    const at = evaluation.occurredAt ?? new Date().toISOString();
    return this.updateLead(id, {
      vq_status: evaluation.vq_status,
      vq_score: evaluation.vq_score ?? null,
      vq_reason_codes: evaluation.vq_reason_codes ?? [],
      vq_model_version: evaluation.vq_model_version,
      vq_evaluated_at: at,
      vq_scheduled_at: evaluation.vq_status === 'SCHEDULED' ? at : undefined,
      vq_occurred_at: ['ATTENDED', 'NO_SHOW', 'PASSED', 'REJECTED'].includes(evaluation.vq_status)
        ? at
        : undefined,
    });
  }

  async loadLeadsForSubmissions(submissionIds: readonly Uuid[]): Promise<Map<Uuid, LeadRow>> {
    const ids = uniqueIds(submissionIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<LeadRow>(
      this.client.from('leads').select('*').in('submission_id', ids),
      'submissions.loadLeadsForSubmissions',
    );
    return indexBy(rows, (row) => row.submission_id);
  }

  async recordStageEvent(
    input: LeadStageEventInsert,
  ): Promise<{ event: LeadStageEventRow | null; created: boolean }> {
    const result = await this.client.rpc('record_lead_stage_event', { p_payload: input });
    if (result.error) throw toDomainError(result.error, 'submissions.recordStageEvent');
    const data = result.data as { lead_stage_event_id: Uuid | null; created: boolean };
    if (!data.created || !data.lead_stage_event_id) return { event: null, created: false };
    const event = await this.selectMaybe<LeadStageEventRow>(
      this.client.from('lead_stage_events').select('*').eq('id', data.lead_stage_event_id).maybeSingle(),
      'submissions.recordStageEvent.read',
    );
    return { event, created: true };
  }

  listStageEvents(leadId: Uuid): Promise<LeadStageEventRow[]> {
    return this.selectList<LeadStageEventRow>(
      this.client.from('lead_stage_events').select('*').eq('lead_id', leadId).order('occurred_at'),
      'submissions.listStageEvents',
    );
  }

  async loadStageEventsForLeads(leadIds: readonly Uuid[]): Promise<Map<Uuid, LeadStageEventRow[]>> {
    const ids = uniqueIds(leadIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<LeadStageEventRow>(
      this.client.from('lead_stage_events').select('*').in('lead_id', ids).order('occurred_at'),
      'submissions.loadStageEventsForLeads',
    );
    return groupBy(rows, (row) => row.lead_id);
  }

  async createOpportunity(input: OpportunityInsert): Promise<OpportunityRow> {
    const row = await this.selectMaybe<OpportunityRow>(
      this.client.from('opportunities').insert(input).select('*').single(),
      'submissions.createOpportunity',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'submissions.createOpportunity' } });
    return row;
  }

  async updateOpportunity(id: Uuid, patch: Updatable<OpportunityRow>): Promise<OpportunityRow> {
    // The acquisition binding is written once and never rewritten (spec §22).
    const guarded = { ...patch };
    delete guarded.acquisition_submission_id;
    delete guarded.acquisition_snapshot_id;
    const row = await this.selectMaybe<OpportunityRow>(
      this.client.from('opportunities').update(guarded).eq('id', id).select('*').single(),
      'submissions.updateOpportunity',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'submissions.updateOpportunity', id } });
    return row;
  }

  listOpportunities(workspaceId: Uuid, campaignId?: Uuid): Promise<OpportunityRow[]> {
    let query = this.client.from('opportunities').select('*').eq('workspace_id', workspaceId);
    if (campaignId) query = query.eq('campaign_id', campaignId);
    return this.selectList<OpportunityRow>(
      query.order('created_at', { ascending: false }),
      'submissions.listOpportunities',
    );
  }

  async loadOpportunitiesForLeads(leadIds: readonly Uuid[]): Promise<Map<Uuid, OpportunityRow[]>> {
    const ids = uniqueIds(leadIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<OpportunityRow>(
      this.client.from('opportunities').select('*').in('lead_id', ids),
      'submissions.loadOpportunitiesForLeads',
    );
    return groupBy(rows, (row) => row.lead_id);
  }

  async recordRevenue(input: RevenueEventInsert): Promise<RevenueEventRow> {
    const row = await this.selectMaybe<RevenueEventRow>(
      this.client
        .from('revenue_events')
        .upsert(input, { onConflict: 'opportunity_id,kind,source_event_id' })
        .select('*')
        .single(),
      'submissions.recordRevenue',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'submissions.recordRevenue' } });
    return row;
  }

  async funnelCounts(params: {
    workspaceId: Uuid;
    campaignId?: Uuid;
    from?: string;
    to?: string;
  }): Promise<FunnelCounts> {
    let submissionQuery = this.client
      .from('form_submissions')
      .select('id,state')
      .eq('workspace_id', params.workspaceId)
      .eq('traffic_kind', 'PRODUCTION');
    if (params.campaignId) submissionQuery = submissionQuery.eq('campaign_id', params.campaignId);
    if (params.from) submissionQuery = submissionQuery.gte('submitted_at', params.from);
    if (params.to) submissionQuery = submissionQuery.lte('submitted_at', params.to);

    const submissions = await this.selectList<{ id: Uuid; state: SubmissionState }>(
      submissionQuery,
      'submissions.funnelCounts.submissions',
    );
    const submissionIds = submissions.map((row) => row.id);

    const [leads, snapshots] = await Promise.all([
      submissionIds.length
        ? this.selectList<LeadRow>(
            this.client.from('leads').select('*').in('submission_id', submissionIds),
            'submissions.funnelCounts.leads',
          )
        : Promise.resolve<LeadRow[]>([]),
      submissionIds.length
        ? this.selectList<{ submission_id: Uuid; confidence: string }>(
            this.client
              .from('attribution_snapshots')
              .select('submission_id,confidence')
              .in('submission_id', submissionIds),
            'submissions.funnelCounts.snapshots',
          )
        : Promise.resolve<{ submission_id: Uuid; confidence: string }[]>([]),
    ]);

    const leadIds = leads.map((lead) => lead.id);
    const opportunities = leadIds.length
      ? await this.selectList<OpportunityRow>(
          this.client.from('opportunities').select('*').in('lead_id', leadIds),
          'submissions.funnelCounts.opportunities',
        )
      : [];

    return foldFunnelCounts(submissions, leads, opportunities, snapshots);
  }

  async attributionCoverage(campaignId: Uuid): Promise<Rate> {
    const rows = await this.selectList<{ confidence: string }>(
      this.client.from('attribution_snapshots').select('confidence').eq('campaign_id', campaignId),
      'submissions.attributionCoverage',
    );
    const trusted = rows.filter((row) => row.confidence === 'EXACT' || row.confidence === 'HIGH_CONFIDENCE');
    return rate(trusted.length, rows.length);
  }
}

/**
 * Shared fold so the Supabase and in-memory implementations cannot disagree
 * about what "qualified VQ" means.
 */
export function foldFunnelCounts(
  submissions: readonly { id: Uuid; state: SubmissionState }[],
  leads: readonly Pick<LeadRow, 'id' | 'submission_id' | 'vq_status'>[],
  opportunities: readonly Pick<OpportunityRow, 'id' | 'lead_id' | 'amount_minor' | 'closed_won_at' | 'closed_lost_at'>[],
  snapshots: readonly { submission_id: Uuid; confidence: string }[],
): FunnelCounts {
  const rejected: SubmissionState[] = ['REJECTED_VALIDATION', 'REJECTED_SPAM'];
  return {
    submissions: submissions.length,
    leads: submissions.filter((row) => !rejected.includes(row.state)).length,
    vq_scheduled: leads.filter((lead) => lead.vq_status !== 'NOT_SCHEDULED').length,
    vq_attended: leads.filter((lead) => ['ATTENDED', 'PASSED', 'REJECTED'].includes(lead.vq_status)).length,
    vq_no_show: leads.filter((lead) => lead.vq_status === 'NO_SHOW').length,
    qualified_vq: leads.filter((lead) => lead.vq_status === 'PASSED').length,
    opportunities: opportunities.length,
    closed_won: opportunities.filter((row) => row.closed_won_at !== null).length,
    closed_lost: opportunities.filter((row) => row.closed_lost_at !== null).length,
    revenue_minor: opportunities
      .filter((row) => row.closed_won_at !== null)
      .reduce((sum, row) => sum + (row.amount_minor ?? 0), 0),
    trustworthy_attributions: snapshots.filter(
      (row) => row.confidence === 'EXACT' || row.confidence === 'HIGH_CONFIDENCE',
    ).length,
  };
}

export function createSubmissionRepository(client: DbClient): SubmissionRepository {
  return new SupabaseSubmissionRepository(client);
}
