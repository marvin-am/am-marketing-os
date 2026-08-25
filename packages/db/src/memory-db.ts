/**
 * In-memory implementation of every repository.
 *
 * Two jobs:
 *   1. DEMO_MODE — the whole product runs with no database at all.
 *   2. Unit tests — deterministic, fast, and no Postgres in CI.
 *
 * It is deliberately *honest*: the constraints that carry the product's
 * guarantees are enforced here too, so a test that passes against this store is
 * evidence about the real one.
 *
 *   * `form_submissions.submission_attempt_id` is unique — ten concurrent
 *     identical submits produce exactly one submission and one outbox row.
 *   * `outbox_events (destination, dataset_id, event_id)` is unique.
 *   * `experiment_assignments (experiment_id, visitor_id)` is unique, so an arm
 *     is stable across reloads.
 *   * `experiment_exposures (experiment_id, visitor_id, session_id)` is unique.
 *   * `meta_insights_daily (provider, level, entity_external_id, date_start)` is
 *     unique, so a repeated import updates rather than duplicates.
 *   * Published versions are immutable and raise `IMMUTABLE_VERSION`.
 */
import {
  canTransition,
  CAMPAIGN_STATE_LABELS_DE,
  deriveConfidence,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DEFAULT_RECOMMENDATION_CONFIG,
  DEFAULT_ROLE_BUDGET_LIMITS,
  DomainError,
  isTrustworthy,
  rate,
  rollUpHealth,
  UNCONFIGURED_RETENTION_POLICY,
  type ApprovalKind,
  type ApprovalState,
  type AspectRatio,
  type AssetReviewState,
  type AttributionConfidence,
  type CampaignErrorState,
  type CampaignState,
  type ConnectionState,
  type ExperimentState,
  type ExperimentVerdict,
  type HealthStatus,
  type MetaCommandKind,
  type OutboxDestination,
  type OutboxState,
  type Provider,
  type Rate,
  type RecommendationState,
  type Role,
  type SubmissionState,
  type SyncStatus,
  type VqStatus,
  REQUIRED_ASPECT_RATIOS,
} from '@am/domain';
import { decrypt, encrypt, type EncryptedEnvelope } from './crypto';
import { outboxPayloadHash, planRetry, resolveClaimDestinations, type EnqueueOutboxInput, type EnqueueOutboxResult, type RetryDecision, type SubmitLeadInput, type SubmitLeadResult } from './outbox';
import { foldOutboxStats, type OutboxListParams, type OutboxRepository, type OutboxStats } from './repositories/outbox';
import { foldFunnelCounts, type FunnelCounts, type LeadListParams, type SubmissionListParams, type SubmissionRepository } from './repositories/submissions';
import { groupBy, indexBy, normalizePage, toPage, uniqueIds } from './repositories/base';
import type { AmDatabase } from './repositories';
import { isCrmMature, type ArmObservationRow, type ExperimentRepository } from './repositories/experiments';
import type { AttributionRepository } from './repositories/attribution';
import type { AuditListParams, AuditRepository } from './repositories/audit';
import type { CampaignListParams, CampaignRepository } from './repositories/campaigns';
import type { CreativeRepository } from './repositories/creatives';
import type { FunnelRepository, PublishFunnelInput } from './repositories/funnels';
import type { HubspotRepository } from './repositories/hubspot';
import type { IntegrationRepository } from './repositories/integrations';
import type { LearningCardListParams, LearningCardRepository } from './repositories/learning-cards';
import type { InsightsQuery, MetaRepository, SpendTotals } from './repositories/meta';
import type { JobsRepository } from './repositories/jobs';
import type { ProposalRepository } from './repositories/proposals';
import { isRollupEligible, ROLLUP_DIMENSION_COLUMNS, type RollupQuery, type RollupRepository } from './repositories/rollups';
import type { RecommendationRepository } from './repositories/recommendations';
import type { BrandKnowledgeBundle, SettingsRepository } from './repositories/settings';
import type {
  EnsureVisitorSessionInput,
  EnsureVisitorSessionResult,
  EventListParams,
  TrackingRepository,
} from './repositories/tracking';
import type * as T from './types';

/* -------------------------------------------------------------------------- */
/* Deterministic ids                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic UUID generator. A memory database whose ids change between runs
 * cannot be asserted on, so the counter is part of the store rather than global.
 */
export function createIdFactory(seed = 1): () => string {
  let counter = seed;
  return () => {
    const n = counter++;
    const hex = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  };
}

function clone<V>(value: V): V {
  return value === undefined || value === null ? value : (structuredClone(value) as V);
}

function conflict(constraint: string, messageDe: string): DomainError {
  return new DomainError('CONFLICT', { messageDe, details: { constraint } });
}

function notFound(context: string, id?: string): DomainError {
  return new DomainError('NOT_FOUND', { details: { context, id } });
}

function immutable(context: string, id: string): DomainError {
  return new DomainError('IMMUTABLE_VERSION', { details: { context, id } });
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface MemoryStore {
  workspaces: T.WorkspaceRow[];
  profiles: T.ProfileRow[];
  workspace_members: T.WorkspaceMemberRow[];
  role_limits: T.RoleLimitRow[];
  workspace_settings: T.WorkspaceSettingsRow[];

  brand_profiles: T.BrandProfileRow[];
  audience_segments: T.AudienceSegmentRow[];
  services: T.ServiceRow[];
  offers: T.OfferRow[];
  offer_versions: T.OfferVersionRow[];
  evidence_items: T.EvidenceItemRow[];
  claims: T.ClaimRow[];
  case_studies: T.CaseStudyRow[];
  testimonials: T.TestimonialRow[];
  faqs: T.FaqRow[];
  guardrails: T.GuardrailRow[];

  campaigns: T.CampaignRow[];
  campaign_versions: T.CampaignVersionRow[];
  campaign_proposals: T.CampaignProposalRow[];
  angles: T.AngleRow[];
  angle_versions: T.AngleVersionRow[];
  approvals: T.ApprovalRow[];

  creative_concepts: T.CreativeConceptRow[];
  creative_assets: T.CreativeAssetRow[];
  creative_versions: T.CreativeVersionRow[];
  creative_renditions: T.CreativeRenditionRow[];

  consent_versions: T.ConsentVersionRow[];
  funnels: T.FunnelRow[];
  funnel_versions: T.FunnelVersionRow[];
  form_definitions: T.FormDefinitionRow[];
  form_versions: T.FormVersionRow[];
  published_funnels: T.PublishedFunnelRow[];

  experiments: T.ExperimentRow[];
  experiment_arms: T.ExperimentArmRow[];
  experiment_assignments: T.ExperimentAssignmentRow[];
  experiment_exposures: T.ExperimentExposureRow[];
  experiment_results: T.ExperimentResultRow[];

  visitors: T.VisitorRow[];
  sessions: T.SessionRow[];
  touchpoints: T.TouchpointRow[];
  events: T.EventRow[];
  form_instances: T.FormInstanceRow[];
  form_submissions: T.FormSubmissionRow[];
  submission_answers_non_pii: T.SubmissionAnswerRow[];
  submission_pii_encrypted: T.SubmissionPiiRow[];
  submission_status_history: T.SubmissionStatusHistoryRow[];
  attribution_snapshots: T.AttributionSnapshotRow[];
  leads: T.LeadRow[];
  lead_stage_events: T.LeadStageEventRow[];
  opportunities: T.OpportunityRow[];
  revenue_events: T.RevenueEventRow[];

  meta_accounts: T.MetaAccountRow[];
  meta_campaigns: T.MetaCampaignRow[];
  meta_adsets: T.MetaAdSetRow[];
  meta_creatives: T.MetaCreativeRow[];
  meta_ads: T.MetaAdRow[];
  meta_insights_daily: T.MetaInsightsDailyRow[];
  capi_dispatches: T.CapiDispatchRow[];
  external_commands: T.ExternalCommandRow[];

  hubspot_mappings: T.HubspotMappingRow[];
  hubspot_objects: T.HubspotObjectRow[];
  hubspot_sync_attempts: T.HubspotSyncAttemptRow[];
  hubspot_stage_history: T.HubspotStageHistoryRow[];

  integration_connections: T.IntegrationConnectionRow[];
  integration_health_checks: T.IntegrationHealthCheckRow[];
  sync_cursors: T.SyncCursorRow[];
  sync_jobs: T.SyncJobRow[];
  recommendations: T.RecommendationRow[];
  recommendation_actions: T.RecommendationActionRow[];
  learning_cards: T.LearningCardRow[];
  outbox_events: T.OutboxEventRow[];
  audit_logs: T.AuditLogRow[];
  performance_rollups: T.PerformanceRollupRow[];
  job_locks: T.JobLockRow[];
}

export function createEmptyStore(): MemoryStore {
  return {
    workspaces: [],
    profiles: [],
    workspace_members: [],
    role_limits: [],
    workspace_settings: [],
    brand_profiles: [],
    audience_segments: [],
    services: [],
    offers: [],
    offer_versions: [],
    evidence_items: [],
    claims: [],
    case_studies: [],
    testimonials: [],
    faqs: [],
    guardrails: [],
    campaigns: [],
    campaign_versions: [],
    campaign_proposals: [],
    angles: [],
    angle_versions: [],
    approvals: [],
    creative_concepts: [],
    creative_assets: [],
    creative_versions: [],
    creative_renditions: [],
    consent_versions: [],
    funnels: [],
    funnel_versions: [],
    form_definitions: [],
    form_versions: [],
    published_funnels: [],
    experiments: [],
    experiment_arms: [],
    experiment_assignments: [],
    experiment_exposures: [],
    experiment_results: [],
    visitors: [],
    sessions: [],
    touchpoints: [],
    events: [],
    form_instances: [],
    form_submissions: [],
    submission_answers_non_pii: [],
    submission_pii_encrypted: [],
    submission_status_history: [],
    attribution_snapshots: [],
    leads: [],
    lead_stage_events: [],
    opportunities: [],
    revenue_events: [],
    meta_accounts: [],
    meta_campaigns: [],
    meta_adsets: [],
    meta_creatives: [],
    meta_ads: [],
    meta_insights_daily: [],
    capi_dispatches: [],
    external_commands: [],
    hubspot_mappings: [],
    hubspot_objects: [],
    hubspot_sync_attempts: [],
    hubspot_stage_history: [],
    integration_connections: [],
    integration_health_checks: [],
    sync_cursors: [],
    sync_jobs: [],
    recommendations: [],
    recommendation_actions: [],
    learning_cards: [],
    outbox_events: [],
    audit_logs: [],
    performance_rollups: [],
    job_locks: [],
  };
}

export interface MemoryDatabase extends AmDatabase {
  /** Direct access for fixtures, seeding and assertions. */
  readonly store: MemoryStore;
  reset(): void;
}

export interface MemoryDatabaseOptions {
  store?: MemoryStore;
  /** Seed for the deterministic id factory. */
  idSeed?: number;
  now?: () => string;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createMemoryDatabase(options: MemoryDatabaseOptions = {}): MemoryDatabase {
  let store = options.store ?? createEmptyStore();
  let nextId = createIdFactory(options.idSeed ?? 1);
  const now = options.now ?? (() => new Date().toISOString());

  /* --- generic helpers ---------------------------------------------------- */

  function audit<R extends object>(input: object): R {
    const stamp = now();
    return {
      id: nextId(),
      created_at: stamp,
      updated_at: stamp,
      created_by: null,
      updated_by: null,
      ...input,
    } as unknown as R;
  }

  function insert<R extends { id: string }>(table: R[], row: R): R {
    table.push(row);
    return clone(row);
  }

  function patch<R extends { id: string }>(table: R[], id: string, changes: object, context: string): R {
    const index = table.findIndex((row) => row.id === id);
    if (index < 0) throw notFound(context, id);
    const merged = { ...table[index], ...changes } as R & { updated_at?: string };
    if ('updated_at' in table[index]) merged.updated_at = now();
    table[index] = merged;
    return clone(table[index]);
  }

  function versionPatch<R extends { id: string; state: T.VersionState }>(
    table: R[],
    id: string,
    changes: object,
    context: string,
  ): R {
    const current = table.find((row) => row.id === id);
    if (!current) throw notFound(context, id);
    const next = { ...current, ...changes } as R;
    if (current.state === 'PUBLISHED' && next.state !== 'ARCHIVED') {
      const contentChanged = Object.entries(changes).some(
        ([key, value]) =>
          !['updated_at', 'updated_by', 'archived_at', 'state'].includes(key) &&
          JSON.stringify((current as Record<string, unknown>)[key]) !== JSON.stringify(value),
      );
      if (contentChanged) throw immutable(context, id);
    }
    return patch(table, id, changes, context);
  }

  function publishVersion<R extends { id: string; state: T.VersionState }>(
    table: R[],
    id: string,
    publishedBy: string | null,
    context: string,
  ): R {
    const current = table.find((row) => row.id === id);
    if (!current) throw notFound(context, id);
    if (current.state !== 'DRAFT') {
      throw new DomainError('IMMUTABLE_VERSION', {
        messageDe: 'Diese Version ist bereits veröffentlicht oder archiviert und kann nicht erneut veröffentlicht werden.',
        details: { context, id },
      });
    }
    return patch(table, id, { state: 'PUBLISHED', published_at: now(), published_by: publishedBy }, context);
  }

  function paged<R>(rows: R[], params: T.PageParams | undefined): T.Page<R> {
    const { limit, offset } = normalizePage(params);
    return toPage(rows.slice(offset, offset + limit).map(clone), rows.length, limit, offset);
  }

  function upsertExternal<R extends { id: string; provider: string; external_id: string }>(
    table: R[],
    input: object,
    defaults: object,
  ): R {
    const candidate = { ...defaults, ...input } as R;
    const existing = table.find(
      (row) => row.provider === candidate.provider && row.external_id === candidate.external_id,
    );
    if (existing) return patch(table, existing.id, { ...input, updated_at: now() }, 'upsertExternal');
    return insert(table, audit<R>(candidate));
  }

  const between = (value: string | null | undefined, from?: string, to?: string): boolean => {
    if (!value) return !from && !to;
    if (from && value < from) return false;
    if (to && value > to) return false;
    return true;
  };

  /* --- campaigns ---------------------------------------------------------- */

  const campaigns: CampaignRepository = {
    async list(params: CampaignListParams) {
      let rows = store.campaigns.filter((row) => row.workspace_id === params.workspaceId);
      if (params.states?.length) rows = rows.filter((row) => params.states?.includes(row.state));
      else if (!params.includeArchived) rows = rows.filter((row) => row.state !== 'ARCHIVED');
      if (params.search) {
        const needle = params.search.toLowerCase();
        rows = rows.filter((row) => row.name.toLowerCase().includes(needle));
      }
      if (params.tags?.length) rows = rows.filter((row) => row.tags.some((tag) => params.tags?.includes(tag)));

      const key = params.orderBy ?? 'updated_at';
      const dir = params.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
      return paged(rows, params);
    },
    async getById(id) {
      return clone(store.campaigns.find((row) => row.id === id) ?? null);
    },
    async getBySlug(workspaceId, slug) {
      return clone(
        store.campaigns.find((row) => row.workspace_id === workspaceId && row.slug === slug) ?? null,
      );
    },
    async countsByState(workspaceId) {
      const counts: Record<string, number> = {};
      for (const row of store.campaigns.filter((c) => c.workspace_id === workspaceId)) {
        counts[row.state] = (counts[row.state] ?? 0) + 1;
      }
      return counts;
    },
    async create(input) {
      if (store.campaigns.some((row) => row.workspace_id === input.workspace_id && row.slug === input.slug)) {
        throw conflict('campaigns_slug_unique', 'Es existiert bereits eine Kampagne mit diesem Kurznamen.');
      }
      return insert(
        store.campaigns,
        audit<T.CampaignRow>({
          state: 'IDEA',
          error_state: null,
          error_detail_de: null,
          brand_profile_id: null,
          audience_segment_id: null,
          service_id: null,
          offer_id: null,
          offer_version_id: null,
          angle_id: null,
          angle_version_id: null,
          current_version_id: null,
          core_message: null,
          hypothesis: null,
          currency: 'EUR',
          daily_budget_minor: 0,
          test_budget_minor: 0,
          target_cpl_minor: null,
          target_cost_per_qualified_vq_minor: null,
          primary_metric: null,
          secondary_metrics: [],
          guardrail_metrics: [],
          attribution_level: 'CREATIVE_ONLY',
          tags: [],
          planned_start_at: null,
          planned_end_at: null,
          launched_at: null,
          paused_at: null,
          completed_at: null,
          archived_at: null,
          imported_from_provider: null,
          imported_external_id: null,
          ...input,
        }),
      );
    },
    async update(id, changes) {
      return patch(store.campaigns, id, changes, 'campaigns.update');
    },
    async transitionState(id, to: CampaignState, actorId) {
      const current = store.campaigns.find((row) => row.id === id);
      if (!current) throw notFound('campaigns.transitionState', id);
      if (current.state === to) return clone(current);
      if (!canTransition(current.state, to)) {
        throw new DomainError('CONFLICT', {
          messageDe: `Übergang von „${CAMPAIGN_STATE_LABELS_DE[current.state]}“ nach „${CAMPAIGN_STATE_LABELS_DE[to]}“ ist nicht zulässig.`,
          details: { from: current.state, to },
        });
      }
      const stamp = now();
      return patch(
        store.campaigns,
        id,
        {
          state: to,
          updated_by: actorId,
          launched_at: to === 'LIVE' ? (current.launched_at ?? stamp) : current.launched_at,
          paused_at: to === 'PAUSED' ? stamp : current.paused_at,
          completed_at: to === 'COMPLETED' ? stamp : current.completed_at,
          archived_at: to === 'ARCHIVED' ? stamp : current.archived_at,
        },
        'campaigns.transitionState',
      );
    },
    async setErrorState(id, errorState: CampaignErrorState | null, detailDe) {
      return patch(store.campaigns, id, { error_state: errorState, error_detail_de: detailDe }, 'campaigns.setErrorState');
    },
    async listVersions(campaignId) {
      return store.campaign_versions
        .filter((row) => row.campaign_id === campaignId)
        .sort((a, b) => b.version - a.version)
        .map(clone);
    },
    async getVersion(id) {
      return clone(store.campaign_versions.find((row) => row.id === id) ?? null);
    },
    async createVersion(input) {
      if (store.campaign_versions.some((r) => r.campaign_id === input.campaign_id && r.version === input.version)) {
        throw conflict('campaign_versions_unique', 'Diese Versionsnummer existiert bereits.');
      }
      return insert(
        store.campaign_versions,
        audit<T.CampaignVersionRow>({
          state: 'DRAFT',
          notes: null,
          published_at: null,
          published_by: null,
          archived_at: null,
          ...input,
        }),
      );
    },
    async publishVersion(versionId, publishedBy) {
      const row = publishVersion(store.campaign_versions, versionId, publishedBy, 'campaigns.publishVersion');
      patch(store.campaigns, row.campaign_id, { current_version_id: row.id }, 'campaigns.publishVersion');
      return row;
    },
    async loadVersionsForCampaigns(campaignIds) {
      const ids = new Set(uniqueIds(campaignIds));
      const rows = store.campaign_versions
        .filter((row) => ids.has(row.campaign_id))
        .sort((a, b) => b.version - a.version)
        .map(clone);
      return groupBy(rows, (row) => row.campaign_id);
    },
    async listApprovals(campaignId) {
      return store.approvals.filter((row) => row.campaign_id === campaignId).map(clone);
    },
    async loadApprovalsForCampaigns(campaignIds) {
      const ids = new Set(uniqueIds(campaignIds));
      return groupBy(
        store.approvals.filter((row) => ids.has(row.campaign_id)).map(clone),
        (row) => row.campaign_id,
      );
    },
    async upsertApproval(input) {
      const existing = store.approvals.find(
        (row) =>
          row.campaign_id === input.campaign_id &&
          row.kind === input.kind &&
          (row.state === 'PENDING' || row.state === 'APPROVED'),
      );
      if (existing) return patch(store.approvals, existing.id, input, 'campaigns.upsertApproval');
      return insert(
        store.approvals,
        audit<T.ApprovalRow>({
          state: 'PENDING' satisfies ApprovalState,
          approved_content_hash: null,
          approved_by: null,
          approved_at: null,
          rejected_reason_de: null,
          invalidated_at: null,
          invalidated_reason_de: null,
          requested_by: null,
          ...input,
        }),
      );
    },
    async decideApproval(id, decision) {
      if (decision.state === 'APPROVED' && !decision.contentHash) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Eine Freigabe benötigt den Content-Hash des freigegebenen Inhalts.',
          details: { approvalId: id },
        });
      }
      return patch(
        store.approvals,
        id,
        {
          state: decision.state,
          approved_by: decision.state === 'APPROVED' ? decision.actorId : null,
          approved_at: decision.state === 'APPROVED' ? now() : null,
          approved_content_hash: decision.state === 'APPROVED' ? decision.contentHash : null,
          rejected_reason_de: decision.state === 'REJECTED' ? (decision.reasonDe ?? null) : null,
        },
        'campaigns.decideApproval',
      );
    },
    async invalidateApprovals(campaignId, kinds: readonly ApprovalKind[], reasonDe) {
      const affected = store.approvals.filter(
        (row) => row.campaign_id === campaignId && row.state === 'APPROVED' && kinds.includes(row.kind),
      );
      return affected.map((row) =>
        patch(
          store.approvals,
          row.id,
          { state: 'INVALIDATED', invalidated_at: now(), invalidated_reason_de: reasonDe },
          'campaigns.invalidateApprovals',
        ),
      );
    },
  };

  /* --- proposals ---------------------------------------------------------- */

  const proposals: ProposalRepository = {
    async listByCampaign(campaignId) {
      return store.campaign_proposals
        .filter((row) => row.campaign_id === campaignId)
        .sort((a, b) => b.generation_index - a.generation_index)
        .map(clone);
    },
    async getById(id) {
      return clone(store.campaign_proposals.find((row) => row.id === id) ?? null);
    },
    async getAccepted(campaignId) {
      return clone(
        store.campaign_proposals.find((row) => row.campaign_id === campaignId && row.accepted) ?? null,
      );
    },
    async nextGenerationIndex(campaignId) {
      const max = store.campaign_proposals
        .filter((row) => row.campaign_id === campaignId)
        .reduce((acc, row) => Math.max(acc, row.generation_index), 0);
      return max + 1;
    },
    async create(input) {
      return insert(
        store.campaign_proposals,
        audit<T.CampaignProposalRow>({
          ai_job_id: null,
          prompt_version_id: null,
          model: '',
          generation_index: 1,
          diversity_score: null,
          angle_verdict: null,
          max_similarity: null,
          similar_campaigns: [],
          accepted: false,
          accepted_at: null,
          accepted_by: null,
          rejected_reason_de: null,
          superseded_by: null,
          ...input,
        }),
      );
    },
    async accept(id, acceptedBy) {
      const row = store.campaign_proposals.find((r) => r.id === id);
      if (!row) throw notFound('proposals.accept', id);
      for (const other of store.campaign_proposals) {
        if (other.campaign_id === row.campaign_id && other.id !== id && other.accepted) {
          patch(store.campaign_proposals, other.id, { accepted: false }, 'proposals.accept');
        }
      }
      return patch(
        store.campaign_proposals,
        id,
        { accepted: true, accepted_at: now(), accepted_by: acceptedBy },
        'proposals.accept',
      );
    },
    async reject(id, reasonDe) {
      return patch(store.campaign_proposals, id, { accepted: false, rejected_reason_de: reasonDe }, 'proposals.reject');
    },
    async supersede(id, supersededBy) {
      return patch(store.campaign_proposals, id, { superseded_by: supersededBy }, 'proposals.supersede');
    },
    async loadForCampaigns(campaignIds) {
      const ids = new Set(uniqueIds(campaignIds));
      return groupBy(
        store.campaign_proposals
          .filter((row) => ids.has(row.campaign_id))
          .sort((a, b) => b.generation_index - a.generation_index)
          .map(clone),
        (row) => row.campaign_id,
      );
    },
  };

  /* --- creatives ---------------------------------------------------------- */

  const creatives: CreativeRepository = {
    async listConcepts(campaignId) {
      return store.creative_concepts
        .filter((row) => row.campaign_id === campaignId)
        .sort((a, b) => a.sort_order - b.sort_order || a.concept_key.localeCompare(b.concept_key))
        .map(clone);
    },
    async getConcept(id) {
      return clone(store.creative_concepts.find((row) => row.id === id) ?? null);
    },
    async createConcepts(inputs) {
      return inputs.map((input) => {
        if (
          store.creative_concepts.some(
            (row) => row.campaign_id === input.campaign_id && row.concept_key === input.concept_key,
          )
        ) {
          throw conflict('creative_concepts_key_unique', 'Dieser Konzept-Schlüssel ist bereits vergeben.');
        }
        return insert(
          store.creative_concepts,
          audit<T.CreativeConceptRow>({
            campaign_version_id: null,
            proof_used: null,
            aspect_ratios: ['1:1', '4:5'] as AspectRatio[],
            claims: [],
            review_state: 'DRAFT' satisfies AssetReviewState,
            reviewed_by: null,
            reviewed_at: null,
            rejection_reason_de: null,
            current_version_id: null,
            diversity_hash: null,
            sort_order: 0,
            ...input,
          }),
        );
      });
    },
    async updateConcept(id, changes) {
      return patch(store.creative_concepts, id, changes, 'creatives.updateConcept');
    },
    async setConceptReview(id, state, reviewerId, reasonDe = null) {
      return patch(
        store.creative_concepts,
        id,
        {
          review_state: state,
          reviewed_by: reviewerId,
          reviewed_at: now(),
          rejection_reason_de: state === 'REJECTED' ? reasonDe : null,
        },
        'creatives.setConceptReview',
      );
    },
    async countApprovedConcepts(campaignId) {
      return store.creative_concepts.filter(
        (row) => row.campaign_id === campaignId && row.review_state === 'APPROVED',
      ).length;
    },
    async loadConceptsForCampaigns(campaignIds) {
      const ids = new Set(uniqueIds(campaignIds));
      return groupBy(
        store.creative_concepts.filter((row) => ids.has(row.campaign_id)).map(clone),
        (row) => row.campaign_id,
      );
    },
    async createAsset(input) {
      return upsertExternal(store.creative_assets, input, {
        concept_id: null,
        campaign_id: null,
        media_kind: 'IMAGE',
        source: 'AI_GENERATED',
        mime_type: 'image/png',
        width: null,
        height: null,
        byte_size: null,
        checksum: null,
        duration_ms: null,
        generation_job_id: null,
        generation_prompt: null,
        provider: 'INTERNAL',
        external_id: nextId(),
      });
    },
    async listAssets(conceptId) {
      return store.creative_assets.filter((row) => row.concept_id === conceptId).map(clone);
    },
    async listVersions(conceptId) {
      return store.creative_versions
        .filter((row) => row.concept_id === conceptId)
        .sort((a, b) => b.version - a.version)
        .map(clone);
    },
    async getVersion(id) {
      return clone(store.creative_versions.find((row) => row.id === id) ?? null);
    },
    async createVersion(input) {
      return insert(
        store.creative_versions,
        audit<T.CreativeVersionRow>({
          state: 'DRAFT',
          base_asset_id: null,
          review_state: 'DRAFT',
          approved_by: null,
          approved_at: null,
          published_at: null,
          published_by: null,
          archived_at: null,
          ...input,
        }),
      );
    },
    async publishVersion(versionId, publishedBy) {
      const row = publishVersion(store.creative_versions, versionId, publishedBy, 'creatives.publishVersion');
      patch(store.creative_concepts, row.concept_id, { current_version_id: row.id }, 'creatives.publishVersion');
      return row;
    },
    async approveVersion(versionId, approvedBy) {
      return versionPatch(
        store.creative_versions,
        versionId,
        { review_state: 'APPROVED', approved_by: approvedBy, approved_at: now() },
        'creatives.approveVersion',
      );
    },
    async loadVersionsForConcepts(conceptIds) {
      const ids = new Set(uniqueIds(conceptIds));
      return groupBy(
        store.creative_versions
          .filter((row) => ids.has(row.concept_id))
          .sort((a, b) => b.version - a.version)
          .map(clone),
        (row) => row.concept_id,
      );
    },
    async upsertRendition(input) {
      const existing = store.creative_renditions.find(
        (row) =>
          row.creative_version_id === input.creative_version_id && row.aspect_ratio === input.aspect_ratio,
      );
      if (existing) return patch(store.creative_renditions, existing.id, input, 'creatives.upsertRendition');
      return insert(
        store.creative_renditions,
        audit<T.CreativeRenditionRow>({
          storage_bucket: 'creative-renditions',
          mime_type: 'image/png',
          byte_size: null,
          checksum: null,
          render_duration_ms: null,
          renderer_version: '1',
          meta_image_hash: null,
          meta_video_id: null,
          ...input,
        }),
      );
    },
    async listRenditions(creativeVersionId) {
      return store.creative_renditions
        .filter((row) => row.creative_version_id === creativeVersionId)
        .map(clone);
    },
    async loadRenditionsForVersions(versionIds) {
      const ids = new Set(uniqueIds(versionIds));
      return groupBy(
        store.creative_renditions.filter((row) => ids.has(row.creative_version_id)).map(clone),
        (row) => row.creative_version_id,
      );
    },
    async missingRequiredRatios(creativeVersionId) {
      const present = new Set(
        store.creative_renditions
          .filter((row) => row.creative_version_id === creativeVersionId)
          .map((row) => row.aspect_ratio),
      );
      return REQUIRED_ASPECT_RATIOS.filter((ratio) => !present.has(ratio));
    },
  };

  /* --- funnels ------------------------------------------------------------ */

  const funnels: FunnelRepository = {
    async listByCampaign(campaignId) {
      return store.funnels.filter((row) => row.campaign_id === campaignId).map(clone);
    },
    async getFunnel(id) {
      return clone(store.funnels.find((row) => row.id === id) ?? null);
    },
    async createFunnel(input) {
      return insert(
        store.funnels,
        audit<T.FunnelRow>({
          promise: null,
          hypothesis: null,
          rationale: null,
          current_version_id: null,
          is_active: true,
          ...input,
        }),
      );
    },
    async updateFunnel(id, changes) {
      return patch(store.funnels, id, changes, 'funnels.updateFunnel');
    },
    async listFunnelVersions(funnelId) {
      return store.funnel_versions
        .filter((row) => row.funnel_id === funnelId)
        .sort((a, b) => b.version - a.version)
        .map(clone);
    },
    async getFunnelVersion(id) {
      return clone(store.funnel_versions.find((row) => row.id === id) ?? null);
    },
    async createFunnelVersion(input) {
      return insert(
        store.funnel_versions,
        audit<T.FunnelVersionRow>({
          state: 'DRAFT',
          form_version_id: null,
          published_at: null,
          published_by: null,
          archived_at: null,
          ...input,
        }),
      );
    },
    async publishFunnelVersion(versionId, publishedBy) {
      const row = publishVersion(store.funnel_versions, versionId, publishedBy, 'funnels.publishFunnelVersion');
      patch(store.funnels, row.funnel_id, { current_version_id: row.id }, 'funnels.publishFunnelVersion');
      return row;
    },
    async loadVersionsForFunnels(funnelIds) {
      const ids = new Set(uniqueIds(funnelIds));
      return groupBy(
        store.funnel_versions
          .filter((row) => ids.has(row.funnel_id))
          .sort((a, b) => b.version - a.version)
          .map(clone),
        (row) => row.funnel_id,
      );
    },
    async createFormDefinition(input) {
      return insert(store.form_definitions, audit<T.FormDefinitionRow>({ current_version_id: null, ...input }));
    },
    async listFormDefinitions(funnelId) {
      return store.form_definitions.filter((row) => row.funnel_id === funnelId).map(clone);
    },
    async createFormVersion(input) {
      return insert(
        store.form_versions,
        audit<T.FormVersionRow>({
          state: 'DRAFT',
          field_index: {},
          question_count: 0,
          consent_version_id: null,
          published_at: null,
          published_by: null,
          archived_at: null,
          ...input,
        }),
      );
    },
    async getFormVersion(id) {
      return clone(store.form_versions.find((row) => row.id === id) ?? null);
    },
    async publishFormVersion(versionId, publishedBy) {
      const current = store.form_versions.find((row) => row.id === versionId);
      if (current && !current.consent_version_id) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Eine Formularversion kann ohne gesetzte Consent-Version nicht veröffentlicht werden.',
          details: { versionId },
        });
      }
      const row = publishVersion(store.form_versions, versionId, publishedBy, 'funnels.publishFormVersion');
      patch(store.form_definitions, row.form_definition_id, { current_version_id: row.id }, 'funnels.publishFormVersion');
      return row;
    },
    async publish(input: PublishFunnelInput) {
      const existing = store.published_funnels.find((row) => row.public_slug === input.public_slug);
      const payload = {
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
        published_at: now(),
        unpublished_at: null,
      };
      if (existing) return patch(store.published_funnels, existing.id, payload, 'funnels.publish');
      return insert(store.published_funnels, audit<T.PublishedFunnelRow>(payload));
    },
    async unpublish(id) {
      return patch(store.published_funnels, id, { is_live: false, unpublished_at: now() }, 'funnels.unpublish');
    },
    async listPublished(campaignId) {
      return store.published_funnels.filter((row) => row.campaign_id === campaignId).map(clone);
    },
    async getPublishedBySlug(slug) {
      const pf = store.published_funnels.find(
        (row) => row.public_slug === slug && row.is_live && row.unpublished_at === null,
      );
      if (!pf) return null;
      const funnel = store.funnels.find((row) => row.id === pf.funnel_id);
      const funnelVersion = store.funnel_versions.find((row) => row.id === pf.funnel_version_id);
      const formVersion = store.form_versions.find((row) => row.id === pf.form_version_id);
      const consent = store.consent_versions.find(
        (row) => row.id === (pf.consent_version_id ?? formVersion?.consent_version_id),
      );
      const experiment = store.experiments.find((row) => row.id === pf.experiment_id);

      return clone<T.PublishedFunnelBundle>({
        published_funnel_id: pf.id,
        workspace_id: pf.workspace_id,
        campaign_id: pf.campaign_id,
        funnel_id: pf.funnel_id,
        funnel_version_id: pf.funnel_version_id,
        funnel_kind: funnel?.kind ?? 'MULTI_STEP_FORM',
        funnel_spec: funnelVersion?.spec ?? {},
        form_version_id: pf.form_version_id,
        form_spec: formVersion?.spec ?? null,
        field_index: formVersion?.field_index ?? {},
        public_slug: pf.public_slug,
        path: pf.path,
        environment: pf.environment,
        meta_pixel_id: pf.meta_pixel_id,
        meta_dataset_id: pf.meta_dataset_id,
        redirect_url: pf.redirect_url,
        experiment_id: pf.experiment_id,
        consent: consent
          ? {
              consent_version_id: consent.id,
              version: consent.version,
              text_de: consent.text_de,
              purposes: consent.purposes,
              privacy_policy_url: consent.privacy_policy_url,
            }
          : null,
        experiment: experiment
          ? {
              experiment_id: experiment.id,
              state: experiment.state,
              assignment_salt: experiment.assignment_salt,
              arms: store.experiment_arms
                .filter((arm) => arm.experiment_id === experiment.id)
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((arm) => ({
                  arm_id: arm.id,
                  key: arm.key,
                  label: arm.label,
                  is_control: arm.is_control,
                  allocation: arm.allocation,
                  funnel_version_id: arm.funnel_version_id,
                  form_version_id: arm.form_version_id,
                  creative_version_id: arm.creative_version_id,
                })),
            }
          : null,
      });
    },
    async listConsentVersions(workspaceId) {
      return store.consent_versions
        .filter((row) => row.workspace_id === workspaceId)
        .sort((a, b) => b.version - a.version)
        .map(clone);
    },
    async createConsentVersion(input) {
      return insert(
        store.consent_versions,
        audit<T.ConsentVersionRow>({ effective_from: now(), effective_until: null, ...input }),
      );
    },
    async activeConsentVersion(workspaceId) {
      const rows = store.consent_versions
        .filter((row) => row.workspace_id === workspaceId && row.effective_until === null)
        .sort((a, b) => b.version - a.version);
      return clone(rows[0] ?? null);
    },
  };

  /* --- experiments -------------------------------------------------------- */

  const LOCKED: readonly ExperimentState[] = ['RUNNING', 'PAUSED', 'CONCLUDED'];

  const experiments: ExperimentRepository = {
    async listByCampaign(campaignId) {
      return store.experiments.filter((row) => row.campaign_id === campaignId).map(clone);
    },
    async listByWorkspace(workspaceId, states) {
      return store.experiments
        .filter((row) => row.workspace_id === workspaceId && (!states?.length || states.includes(row.state)))
        .map(clone);
    },
    async getById(id) {
      return clone(store.experiments.find((row) => row.id === id) ?? null);
    },
    async create(input) {
      return insert(
        store.experiments,
        audit<T.ExperimentRow>({
          state: 'DRAFT',
          secondary_metrics: [],
          guardrail_metrics: [],
          bundled: false,
          eligibility_changing: false,
          verdict: null,
          winning_arm_id: null,
          started_at: null,
          paused_at: null,
          concluded_at: null,
          ...input,
        }),
      );
    },
    async update(id, changes) {
      return patch(store.experiments, id, changes, 'experiments.update');
    },
    async start(id, actorId) {
      const current = store.experiments.find((row) => row.id === id);
      if (!current) throw notFound('experiments.start', id);
      if (current.state === 'RUNNING') return clone(current);
      const arms = store.experiment_arms.filter((arm) => arm.experiment_id === id);
      if (arms.length < 2) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Ein Experiment benötigt mindestens zwei Arme (Kontrolle und Variante).',
          details: { armCount: arms.length },
        });
      }
      if (!arms.some((arm) => arm.is_control)) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Ein Experiment benötigt genau einen Kontrollarm.',
          details: { experimentId: id },
        });
      }
      return patch(
        store.experiments,
        id,
        { state: 'RUNNING', started_at: current.started_at ?? now(), updated_by: actorId },
        'experiments.start',
      );
    },
    async pause(id, actorId) {
      return patch(store.experiments, id, { state: 'PAUSED', paused_at: now(), updated_by: actorId }, 'experiments.pause');
    },
    async conclude(id, verdict: ExperimentVerdict, winningArmId, actorId) {
      if ((verdict === 'WINNER' || verdict === 'PROVISIONAL') && !winningArmId) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Für die Verdikte „Gewinner“ und „Vorläufig führend“ muss ein Gewinnerarm benannt werden.',
          details: { verdict },
        });
      }
      return patch(
        store.experiments,
        id,
        { state: 'CONCLUDED', verdict, winning_arm_id: winningArmId, concluded_at: now(), updated_by: actorId },
        'experiments.conclude',
      );
    },
    async listArms(experimentId) {
      return store.experiment_arms
        .filter((row) => row.experiment_id === experimentId)
        .sort((a, b) => Number(b.is_control) - Number(a.is_control) || a.sort_order - b.sort_order)
        .map(clone);
    },
    async createArms(inputs) {
      if (inputs.length === 0) return [];
      const experiment = store.experiments.find((row) => row.id === inputs[0].experiment_id);
      if (experiment && LOCKED.includes(experiment.state)) {
        throw new DomainError('IMMUTABLE_VERSION', {
          messageDe: 'Arme eines laufenden oder beendeten Experiments können nicht mehr geändert werden.',
          details: { experimentId: experiment.id, state: experiment.state },
        });
      }
      return inputs.map((input) => {
        if (
          store.experiment_arms.some(
            (row) => row.experiment_id === input.experiment_id && row.key === input.key,
          )
        ) {
          throw conflict('experiment_arms_key_unique', 'Dieser Arm-Schlüssel ist bereits vergeben.');
        }
        return insert(
          store.experiment_arms,
          audit<T.ExperimentArmRow>({
            is_control: false,
            creative_version_id: null,
            funnel_version_id: null,
            form_version_id: null,
            published_funnel_id: null,
            sort_order: 0,
            ...input,
          }),
        );
      });
    },
    async loadArmsForExperiments(experimentIds) {
      const ids = new Set(uniqueIds(experimentIds));
      return groupBy(
        store.experiment_arms.filter((row) => ids.has(row.experiment_id)).map(clone),
        (row) => row.experiment_id,
      );
    },
    async assign(experimentId, visitorId, armId, bucket) {
      const experiment = store.experiments.find((row) => row.id === experimentId);
      if (!experiment) throw notFound('experiments.assign', experimentId);
      const existing = store.experiment_assignments.find(
        (row) => row.experiment_id === experimentId && row.visitor_id === visitorId,
      );
      // Stability is the guarantee: an existing assignment wins, always.
      if (existing) return existing.arm_id;
      insert(
        store.experiment_assignments,
        audit<T.ExperimentAssignmentRow>({
          workspace_id: experiment.workspace_id,
          experiment_id: experimentId,
          visitor_id: visitorId,
          arm_id: armId,
          bucket,
          assigned_at: now(),
        }),
      );
      return armId;
    },
    async getAssignment(experimentId, visitorId) {
      return clone(
        store.experiment_assignments.find(
          (row) => row.experiment_id === experimentId && row.visitor_id === visitorId,
        ) ?? null,
      );
    },
    async recordExposure(experimentId, visitorId, sessionId, armId) {
      const experiment = store.experiments.find((row) => row.id === experimentId);
      if (!experiment) throw notFound('experiments.recordExposure', experimentId);
      const duplicate = store.experiment_exposures.some(
        (row) =>
          row.experiment_id === experimentId &&
          row.visitor_id === visitorId &&
          row.session_id === sessionId,
      );
      if (duplicate) return false;
      insert(
        store.experiment_exposures,
        audit<T.ExperimentExposureRow>({
          workspace_id: experiment.workspace_id,
          experiment_id: experimentId,
          visitor_id: visitorId,
          session_id: sessionId,
          arm_id: armId,
          exposed_at: now(),
        }),
      );
      return true;
    },
    async listExposures(experimentId) {
      return store.experiment_exposures.filter((row) => row.experiment_id === experimentId).map(clone);
    },
    async listConcludedWithoutCards(workspaceId, now) {
      const covered = new Set(
        store.learning_cards
          .filter((card) => card.workspace_id === workspaceId && card.experiment_id !== null)
          .map((card) => card.experiment_id),
      );
      return store.experiments
        .filter(
          (experiment) =>
            experiment.workspace_id === workspaceId &&
            experiment.state === 'CONCLUDED' &&
            experiment.concluded_at !== null &&
            !covered.has(experiment.id) &&
            isCrmMature(experiment, now),
        )
        .sort((a, b) => ((a.concluded_at ?? '') < (b.concluded_at ?? '') ? -1 : 1))
        .map(clone);
    },
    async observations(experimentId) {
      const arms = store.experiment_arms.filter((row) => row.experiment_id === experimentId);
      return arms.map((arm) => {
        const exposures = store.experiment_exposures.filter((row) => row.arm_id === arm.id);
        const submissions = store.form_submissions.filter(
          (row) => row.experiment_arm_id === arm.id && row.traffic_kind === 'PRODUCTION',
        );
        const leads = submissions
          .map((sub) => store.leads.find((lead) => lead.submission_id === sub.id))
          .filter((lead): lead is T.LeadRow => Boolean(lead));
        const opportunities = leads.flatMap((lead) =>
          store.opportunities.filter((opp) => opp.lead_id === lead.id),
        );
        const snapshots = submissions
          .map((sub) => store.attribution_snapshots.find((snap) => snap.submission_id === sub.id))
          .filter((snap): snap is T.AttributionSnapshotRow => Boolean(snap));
        const adsetIds = store.meta_adsets
          .filter((adset) => adset.experiment_arm_id === arm.id)
          .map((adset) => adset.id);

        return {
          arm_id: arm.id,
          arm_key: arm.key,
          label: arm.label,
          is_control: arm.is_control,
          sessions: new Set(exposures.map((row) => row.session_id)).size,
          exposures: exposures.length,
          conversions: submissions.filter(
            (row) => row.state === 'ACCEPTED' || row.state.startsWith('HUBSPOT'),
          ).length,
          vq_scheduled: leads.filter((lead) => lead.vq_status !== 'NOT_SCHEDULED').length,
          vq_attended: leads.filter((lead) =>
            ['ATTENDED', 'PASSED', 'REJECTED'].includes(lead.vq_status),
          ).length,
          qualified_vq: leads.filter((lead) => lead.vq_status === 'PASSED').length,
          opportunities: opportunities.length,
          closed_won: opportunities.filter((opp) => opp.closed_won_at !== null).length,
          revenue_minor: opportunities
            .filter((opp) => opp.closed_won_at !== null)
            .reduce((sum, opp) => sum + (opp.amount_minor ?? 0), 0),
          spend_minor: store.meta_insights_daily
            .filter((row) => row.meta_adset_id !== null && adsetIds.includes(row.meta_adset_id))
            .reduce((sum, row) => sum + row.spend_minor, 0),
          attribution_coverage:
            snapshots.length === 0
              ? null
              : snapshots.filter((snap) => isTrustworthy(snap.confidence)).length / snapshots.length,
        } satisfies ArmObservationRow;
      });
    },
    async saveResult(input) {
      const computedAt = input.computed_at ?? now();
      const existing = store.experiment_results.find(
        (row) => row.experiment_id === input.experiment_id && row.computed_at === computedAt,
      );
      if (existing) return patch(store.experiment_results, existing.id, input, 'experiments.saveResult');
      return insert(
        store.experiment_results,
        audit<T.ExperimentResultRow>({
          computed_at: computedAt,
          winning_arm_id: null,
          arms: [],
          reasons: [],
          interpretation_warnings: [],
          runtime_days: 0,
          total_sessions: 0,
          total_conversions: 0,
          ...input,
        }),
      );
    },
    async latestResult(experimentId) {
      const rows = store.experiment_results
        .filter((row) => row.experiment_id === experimentId)
        .sort((a, b) => (a.computed_at < b.computed_at ? 1 : -1));
      return clone(rows[0] ?? null);
    },
    async loadLatestResultsFor(experimentIds) {
      const ids = new Set(uniqueIds(experimentIds));
      const rows = store.experiment_results
        .filter((row) => ids.has(row.experiment_id))
        .sort((a, b) => (a.computed_at < b.computed_at ? 1 : -1))
        .map(clone);
      return indexBy(rows, (row) => row.experiment_id);
    },
  };

  /* --- tracking ----------------------------------------------------------- */

  const tracking: TrackingRepository = {
    async ensureVisitorSession(input: EnsureVisitorSessionInput): Promise<EnsureVisitorSessionResult> {
      const pf = store.published_funnels.find(
        (row) => row.public_slug === input.public_slug && row.is_live && row.unpublished_at === null,
      );
      if (!pf) {
        throw new DomainError('NOT_FOUND', {
          messageDe: `Unbekannter oder nicht veröffentlichter Funnel: ${input.public_slug}`,
          details: { slug: input.public_slug },
        });
      }

      const visitorId = input.visitor_id ?? nextId();
      const existingVisitor = store.visitors.find((row) => row.id === visitorId);
      if (existingVisitor) {
        patch(store.visitors, visitorId, { last_seen_at: now(), session_count: existingVisitor.session_count + 1 }, 'tracking.visitor');
      } else {
        store.visitors.push({
          id: visitorId,
          workspace_id: pf.workspace_id,
          first_seen_at: now(),
          last_seen_at: now(),
          traffic_kind: input.traffic_kind ?? 'PRODUCTION',
          consent_status: input.consent_status ?? 'UNKNOWN',
          session_count: 1,
          created_at: now(),
        });
      }

      const sessionId = input.session_id ?? nextId();
      if (!store.sessions.some((row) => row.id === sessionId)) {
        store.sessions.push({
          id: sessionId,
          workspace_id: pf.workspace_id,
          visitor_id: visitorId,
          started_at: now(),
          last_activity_at: now(),
          ended_at: null,
          environment: input.environment ?? 'production',
          traffic_kind: input.traffic_kind ?? 'PRODUCTION',
          consent_status: input.consent_status ?? 'UNKNOWN',
          channel: input.channel ?? 'UNKNOWN',
          landing_url: input.landing_url ?? null,
          referrer: input.referrer ?? null,
          utm_source: input.utm_source ?? null,
          utm_medium: input.utm_medium ?? null,
          utm_campaign: input.utm_campaign ?? null,
          utm_content: input.utm_content ?? null,
          utm_term: input.utm_term ?? null,
          fbclid: input.fbclid ?? null,
          fbc: input.fbc ?? null,
          fbp: input.fbp ?? null,
          meta_campaign_id: input.meta_campaign_id ?? null,
          meta_adset_id: input.meta_adset_id ?? null,
          meta_ad_id: input.meta_ad_id ?? null,
          published_funnel_id: pf.id,
          funnel_version_id: pf.funnel_version_id,
          campaign_id: pf.campaign_id,
          experiment_id: pf.experiment_id,
          experiment_arm_id: null,
          device_bucket: input.device_bucket ?? null,
          event_count: 0,
          created_at: now(),
        });
      }

      return {
        visitor_id: visitorId,
        session_id: sessionId,
        workspace_id: pf.workspace_id,
        published_funnel_id: pf.id,
        campaign_id: pf.campaign_id,
      };
    },
    async recordEvents(events) {
      let inserted = 0;
      for (const raw of events) {
        const eventId = (raw.event_id as string | undefined) ?? nextId();
        if (store.events.some((row) => row.id === eventId)) continue;
        const sessionId = raw.session_id as string | undefined;
        const session = store.sessions.find((row) => row.id === sessionId);
        if (!session) continue;

        store.events.push({
          id: eventId,
          workspace_id: session.workspace_id,
          event_type: raw.event_type as T.EventRow['event_type'],
          event_schema_version: (raw.event_schema_version as number | undefined) ?? 1,
          occurred_at: (raw.occurred_at as string | undefined) ?? now(),
          received_at: now(),
          environment: (raw.environment as T.EventRow['environment'] | undefined) ?? session.environment,
          traffic_kind: (raw.traffic_kind as T.EventRow['traffic_kind'] | undefined) ?? session.traffic_kind,
          visitor_id: (raw.visitor_id as string | undefined) ?? session.visitor_id,
          session_id: session.id,
          campaign_id: (raw.campaign_id as string | undefined) ?? session.campaign_id,
          campaign_version_id: (raw.campaign_version_id as string | undefined) ?? null,
          angle_id: (raw.angle_id as string | undefined) ?? null,
          angle_version_id: (raw.angle_version_id as string | undefined) ?? null,
          offer_id: (raw.offer_id as string | undefined) ?? null,
          offer_version_id: (raw.offer_version_id as string | undefined) ?? null,
          creative_id: (raw.creative_id as string | undefined) ?? null,
          creative_version_id: (raw.creative_version_id as string | undefined) ?? null,
          funnel_id: (raw.funnel_id as string | undefined) ?? null,
          funnel_version_id: (raw.funnel_version_id as string | undefined) ?? session.funnel_version_id,
          form_id: (raw.form_id as string | undefined) ?? null,
          form_version_id: (raw.form_version_id as string | undefined) ?? null,
          experiment_id: (raw.experiment_id as string | undefined) ?? session.experiment_id,
          experiment_arm_id: (raw.experiment_arm_id as string | undefined) ?? null,
          form_instance_id: (raw.form_instance_id as string | undefined) ?? null,
          submission_id: (raw.submission_id as string | undefined) ?? null,
          step_id: (raw.step_id as string | undefined) ?? null,
          field_id: (raw.field_id as string | undefined) ?? null,
          error_code: (raw.error_code as T.EventRow['error_code'] | undefined) ?? null,
          consent_status: (raw.consent_status as T.EventRow['consent_status'] | undefined) ?? 'UNKNOWN',
          utm_source: session.utm_source,
          utm_medium: session.utm_medium,
          utm_campaign: session.utm_campaign,
          utm_content: session.utm_content,
          utm_term: session.utm_term,
          fbclid: session.fbclid,
          fbc: session.fbc,
          fbp: session.fbp,
          meta_campaign_id: session.meta_campaign_id,
          meta_adset_id: session.meta_adset_id,
          meta_ad_id: session.meta_ad_id,
          referrer: session.referrer,
          landing_url: session.landing_url,
          metadata: (raw.metadata as T.EventRow['metadata'] | undefined) ?? {},
        });
        inserted += 1;
        patch(store.sessions, session.id, { last_activity_at: now(), event_count: session.event_count + 1 }, 'tracking.recordEvents');
      }
      return inserted;
    },
    async listEvents(params: EventListParams) {
      let rows = store.events.filter((row) => row.workspace_id === params.workspaceId);
      if (params.campaignId) rows = rows.filter((row) => row.campaign_id === params.campaignId);
      if (params.sessionId) rows = rows.filter((row) => row.session_id === params.sessionId);
      if (params.eventTypes?.length) rows = rows.filter((row) => params.eventTypes?.includes(row.event_type));
      rows = rows.filter((row) => between(row.occurred_at, params.from, params.to));
      rows = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
      return paged(rows, params);
    },
    async countEventsByType(workspaceId, campaignId) {
      const counts: Record<string, number> = {};
      for (const row of store.events) {
        if (row.workspace_id !== workspaceId || row.traffic_kind !== 'PRODUCTION') continue;
        if (campaignId && row.campaign_id !== campaignId) continue;
        counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
      }
      return counts;
    },
    async getVisitor(id) {
      return clone(store.visitors.find((row) => row.id === id) ?? null);
    },
    async getSession(id) {
      return clone(store.sessions.find((row) => row.id === id) ?? null);
    },
    async createFormInstance(input) {
      return insert(store.form_instances, audit<T.FormInstanceRow>(input));
    },
    async updateFormInstance(id, changes) {
      return patch(store.form_instances, id, changes, 'tracking.updateFormInstance');
    },
    async listAbandonCandidates(workspaceId, idleSince) {
      return store.form_instances
        .filter(
          (row) =>
            row.workspace_id === workspaceId &&
            row.completed_at === null &&
            row.abandoned_at === null &&
            row.last_activity_at < idleSince,
        )
        .map(clone);
    },
  };

  /* --- outbox ------------------------------------------------------------- */

  function findOutbox(destination: string, datasetId: string, eventId: string): T.OutboxEventRow | undefined {
    return store.outbox_events.find(
      (row) => row.destination === destination && row.dataset_id === datasetId && row.event_id === eventId,
    );
  }

  function enqueue(input: EnqueueOutboxInput): EnqueueOutboxResult {
    const datasetId = input.dataset_id ?? '';
    const existing = findOutbox(input.destination, datasetId, input.event_id);
    if (existing) return { event: clone(existing), created: false };

    const payload = input.payload ?? {};
    const event = insert(
      store.outbox_events,
      audit<T.OutboxEventRow>({
        workspace_id: input.workspace_id,
        destination: input.destination,
        event_id: input.event_id,
        dataset_id: datasetId,
        event_name: input.event_name,
        event_time: input.event_time,
        payload,
        payload_hash: input.payload_hash ?? outboxPayloadHash(payload),
        status: 'PENDING' satisfies OutboxState,
        attempt_count: 0,
        next_attempt_at: now(),
        last_error: null,
        provider_response_redacted: null,
        sent_at: null,
        locked_at: null,
        locked_by: null,
        campaign_id: input.campaign_id ?? null,
        submission_id: input.submission_id ?? null,
        lead_id: input.lead_id ?? null,
        opportunity_id: input.opportunity_id ?? null,
      }),
    );
    return { event, created: true };
  }

  const outbox: OutboxRepository = {
    async enqueue(input) {
      return enqueue(input);
    },
    async claim(options = {}) {
      const limit = options.limit ?? 25;
      // No destination filter means one mixed batch, as the dispatcher wants.
      const wanted = resolveClaimDestinations(options);
      const due = store.outbox_events
        .filter(
          (row) =>
            (wanted === null || wanted.includes(row.destination)) &&
            (row.status === 'PENDING' || row.status === 'FAILED_RETRYING') &&
            (row.next_attempt_at === null || row.next_attempt_at <= now()),
        )
        .sort((a, b) => ((a.next_attempt_at ?? a.created_at) < (b.next_attempt_at ?? b.created_at) ? -1 : 1))
        .slice(0, Math.max(limit, 1));

      return due.map((row) =>
        patch(
          store.outbox_events,
          row.id,
          {
            status: 'PROCESSING',
            locked_at: now(),
            locked_by: options.worker ?? 'worker',
            attempt_count: row.attempt_count + 1,
          },
          'outbox.claim',
        ),
      );
    },
    async reclaimStale() {
      const stale = store.outbox_events.filter((row) => row.status === 'PROCESSING');
      for (const row of stale) {
        patch(
          store.outbox_events,
          row.id,
          { status: 'FAILED_RETRYING', locked_at: null, locked_by: null },
          'outbox.reclaimStale',
        );
      }
      return stale.length;
    },
    async markSent(id, providerResponseRedacted) {
      return patch(
        store.outbox_events,
        id,
        {
          status: 'SENT',
          sent_at: now(),
          locked_at: null,
          locked_by: null,
          last_error: null,
          provider_response_redacted: providerResponseRedacted ?? null,
        },
        'outbox.markSent',
      );
    },
    async markAccepted(id, providerResponseRedacted) {
      return patch(
        store.outbox_events,
        id,
        {
          status: 'ACCEPTED',
          sent_at: now(),
          locked_at: null,
          locked_by: null,
          last_error: null,
          provider_response_redacted: providerResponseRedacted ?? null,
        },
        'outbox.markAccepted',
      );
    },
    async markFailed(event, error, options = {}) {
      const decision: RetryDecision = planRetry(event, options.now ?? new Date());
      const updated = patch(
        store.outbox_events,
        event.id,
        {
          status: decision.status,
          next_attempt_at: decision.nextAttemptAt,
          last_error: error.slice(0, 2000),
          locked_at: null,
          locked_by: null,
          provider_response_redacted: options.providerResponseRedacted ?? null,
        },
        'outbox.markFailed',
      );
      return { event: updated, decision };
    },
    async markDeadLetter(id, reason, providerResponseRedacted) {
      return patch(
        store.outbox_events,
        id,
        {
          status: 'DEAD_LETTER',
          next_attempt_at: null,
          last_error: reason.slice(0, 2000),
          locked_at: null,
          locked_by: null,
          provider_response_redacted: providerResponseRedacted ?? null,
        },
        'outbox.markDeadLetter',
      );
    },
    async list(params: OutboxListParams) {
      let rows = store.outbox_events.filter((row) => row.workspace_id === params.workspaceId);
      if (params.destination) rows = rows.filter((row) => row.destination === params.destination);
      if (params.statuses?.length) rows = rows.filter((row) => params.statuses?.includes(row.status));
      rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return paged(rows, params);
    },
    async listDeadLetters(workspaceId) {
      return store.outbox_events
        .filter((row) => row.workspace_id === workspaceId && row.status === 'DEAD_LETTER')
        .map(clone);
    },
    async getByDedupKey(destination: OutboxDestination, datasetId, eventId) {
      return clone(findOutbox(destination, datasetId, eventId) ?? null);
    },
    async getByEventId(destination: OutboxDestination, eventId) {
      const matches = store.outbox_events
        .filter((row) => row.destination === destination && row.event_id === eventId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return clone(matches[0] ?? null);
    },
    async stats(workspaceId): Promise<OutboxStats> {
      return foldOutboxStats(store.outbox_events.filter((row) => row.workspace_id === workspaceId));
    },
  };

  /* --- submissions -------------------------------------------------------- */

  const submissions: SubmissionRepository = {
    async submitLead(input: SubmitLeadInput): Promise<SubmitLeadResult> {
      const pf = store.published_funnels.find((row) => row.id === input.published_funnel_id);
      if (!pf) throw notFound('submissions.submitLead', input.published_funnel_id);

      // The idempotency guarantee: one submission per attempt id, full stop.
      const existing = store.form_submissions.find(
        (row) => row.submission_attempt_id === input.submission_attempt_id,
      );
      if (existing) {
        const outboxRow = input.outbox
          ? findOutbox(input.outbox.destination, input.outbox.dataset_id ?? '', input.outbox.event_id)
          : undefined;
        return {
          submission_id: existing.id,
          created: false,
          state: existing.state,
          attribution_snapshot_id: existing.attribution_snapshot_id,
          outbox_event_id: outboxRow?.id ?? null,
        };
      }

      const state = (input.state ?? 'ACCEPTED') as SubmissionState;
      const submittedAt = input.submitted_at ?? now();

      const submission = insert(
        store.form_submissions,
        audit<T.FormSubmissionRow>({
          workspace_id: pf.workspace_id,
          submission_attempt_id: input.submission_attempt_id,
          form_instance_id: input.form_instance_id ?? null,
          form_version_id: input.form_version_id ?? pf.form_version_id,
          funnel_version_id: pf.funnel_version_id,
          published_funnel_id: pf.id,
          campaign_id: pf.campaign_id,
          experiment_id: input.experiment_id ?? pf.experiment_id,
          experiment_arm_id: input.experiment_arm_id ?? null,
          visitor_id: input.visitor_id ?? null,
          session_id: input.session_id ?? null,
          state,
          submitted_at: submittedAt,
          accepted_at: state === 'ACCEPTED' ? submittedAt : null,
          environment: (input.environment as T.FormSubmissionRow['environment']) ?? pf.environment,
          traffic_kind: (input.traffic_kind as T.FormSubmissionRow['traffic_kind']) ?? 'PRODUCTION',
          consent_version_id: input.consent_version_id ?? pf.consent_version_id,
          consent_status: (input.consent_status as T.FormSubmissionRow['consent_status']) ?? 'UNKNOWN',
          consent_purposes: (input.consent_purposes ?? []) as T.FormSubmissionRow['consent_purposes'],
          consent_text_hash: input.consent_text_hash ?? null,
          spam_score: input.spam_score ?? null,
          spam_reason: input.spam_reason ?? null,
          validation_error_codes: (input.validation_error_codes ??
            []) as T.FormSubmissionRow['validation_error_codes'],
          answers_hash: input.answers_hash ?? null,
          attribution_snapshot_id: null,
          lead_id: null,
        }),
      );

      for (const answer of input.answers ?? []) {
        store.submission_answers_non_pii.push({
          id: nextId(),
          workspace_id: pf.workspace_id,
          submission_id: submission.id,
          field_key: answer.field_key,
          step_key: answer.step_key ?? null,
          field_type: answer.field_type as T.NonPiiFieldType,
          pii_class: answer.pii_class ?? 'QUALIFICATION',
          qualification_class: (answer.qualification_class ??
            'NONE') as T.SubmissionAnswerRow['qualification_class'],
          value_text: answer.value_text ?? null,
          value_number: answer.value_number ?? null,
          value_bool: answer.value_bool ?? null,
          value_options: answer.value_options ?? null,
          score_contribution: answer.score_contribution ?? null,
          created_at: now(),
        });
      }

      if (input.pii) {
        store.submission_pii_encrypted.push({
          id: nextId(),
          workspace_id: pf.workspace_id,
          submission_id: submission.id,
          algorithm: 'AES-256-GCM',
          key_version: input.pii.key_version,
          iv: input.pii.iv,
          auth_tag: input.pii.auth_tag,
          ciphertext: input.pii.ciphertext,
          email_hash: input.pii.email_hash ?? null,
          phone_hash: input.pii.phone_hash ?? null,
          email_domain: input.pii.email_domain ?? null,
          purged_at: null,
          created_at: now(),
        });
      }

      store.submission_status_history.push({
        id: nextId(),
        workspace_id: pf.workspace_id,
        submission_id: submission.id,
        from_state: null,
        to_state: state,
        occurred_at: now(),
        reason_de: input.status_reason_de ?? null,
        actor_label: input.actor_label ?? 'funnel-runtime',
        correlation_id: input.correlation_id ?? null,
        created_at: now(),
      });

      const attr = (input.attribution ?? {}) as Record<string, string | number | null | undefined>;
      const snapshot = insert(
        store.attribution_snapshots,
        audit<T.AttributionSnapshotRow>({
          workspace_id: pf.workspace_id,
          submission_id: submission.id,
          frozen: true,
          campaign_id: pf.campaign_id,
          campaign_version_id: (attr.campaign_version_id as string | null) ?? null,
          angle_id: (attr.angle_id as string | null) ?? null,
          angle_version_id: (attr.angle_version_id as string | null) ?? null,
          offer_id: (attr.offer_id as string | null) ?? null,
          offer_version_id: (attr.offer_version_id as string | null) ?? null,
          creative_id: (attr.creative_id as string | null) ?? null,
          creative_version_id: (attr.creative_version_id as string | null) ?? null,
          funnel_id: pf.funnel_id,
          funnel_version_id: pf.funnel_version_id,
          form_id: (attr.form_id as string | null) ?? null,
          form_version_id: (attr.form_version_id as string | null) ?? pf.form_version_id,
          experiment_id: input.experiment_id ?? pf.experiment_id,
          experiment_arm_id: input.experiment_arm_id ?? null,
          first_touch: null,
          last_touch: null,
          acquisition_touch: null,
          influenced_touch_ids: [],
          utm_source: (attr.utm_source as string | null) ?? null,
          utm_medium: (attr.utm_medium as string | null) ?? null,
          utm_campaign: (attr.utm_campaign as string | null) ?? null,
          utm_content: (attr.utm_content as string | null) ?? null,
          utm_term: (attr.utm_term as string | null) ?? null,
          fbclid: (attr.fbclid as string | null) ?? null,
          fbc: (attr.fbc as string | null) ?? null,
          fbp: (attr.fbp as string | null) ?? null,
          meta_campaign_id: (attr.meta_campaign_id as string | null) ?? null,
          meta_adset_id: (attr.meta_adset_id as string | null) ?? null,
          meta_ad_id: (attr.meta_ad_id as string | null) ?? null,
          referrer: (attr.referrer as string | null) ?? null,
          landing_url: (attr.landing_url as string | null) ?? null,
          channel: (attr.channel as T.AttributionSnapshotRow['channel']) ?? 'UNKNOWN',
          level: (attr.level as T.AttributionSnapshotRow['level']) ?? 'LEAD_LINKED',
          confidence: (attr.confidence as AttributionConfidence) ?? 'UNKNOWN',
          consent_status: (input.consent_status as T.AttributionSnapshotRow['consent_status']) ?? 'UNKNOWN',
          days_to_conversion: (attr.days_to_conversion as number | null) ?? null,
          window_days: (attr.window_days as number | null) ?? 30,
        }),
      );

      patch(store.form_submissions, submission.id, { attribution_snapshot_id: snapshot.id }, 'submissions.submitLead');

      if (input.form_instance_id) {
        const instance = store.form_instances.find((row) => row.id === input.form_instance_id);
        if (instance) {
          patch(
            store.form_instances,
            instance.id,
            { completed_at: instance.completed_at ?? now(), last_activity_at: now() },
            'submissions.submitLead',
          );
        }
      }

      let outboxId: string | null = null;
      if (input.outbox) {
        const result = enqueue({
          workspace_id: pf.workspace_id,
          destination: input.outbox.destination,
          event_id: input.outbox.event_id,
          dataset_id: input.outbox.dataset_id ?? '',
          event_name: input.outbox.event_name ?? 'lead',
          event_time: input.outbox.event_time ?? submittedAt,
          payload: input.outbox.payload ?? {},
          payload_hash: input.outbox.payload_hash,
          campaign_id: pf.campaign_id,
          submission_id: submission.id,
        });
        outboxId = result.event.id;
      }

      return {
        submission_id: submission.id,
        created: true,
        state,
        attribution_snapshot_id: snapshot.id,
        outbox_event_id: outboxId,
      };
    },
    async listSubmissions(params: SubmissionListParams) {
      let rows = store.form_submissions.filter((row) => row.workspace_id === params.workspaceId);
      if (params.campaignId) rows = rows.filter((row) => row.campaign_id === params.campaignId);
      if (params.experimentId) rows = rows.filter((row) => row.experiment_id === params.experimentId);
      if (params.states?.length) rows = rows.filter((row) => params.states?.includes(row.state));
      if (params.productionOnly !== false) rows = rows.filter((row) => row.traffic_kind === 'PRODUCTION');
      rows = rows.filter((row) => between(row.submitted_at, params.from, params.to));
      rows = [...rows].sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
      return paged(rows, params);
    },
    async getSubmission(id) {
      return clone(store.form_submissions.find((row) => row.id === id) ?? null);
    },
    async getByAttemptId(attemptId) {
      return clone(store.form_submissions.find((row) => row.submission_attempt_id === attemptId) ?? null);
    },
    async transitionSubmission(id, to: SubmissionState, options = {}) {
      const current = store.form_submissions.find((row) => row.id === id);
      if (!current) throw notFound('submissions.transitionSubmission', id);
      if (current.state === to) return clone(current);

      const updated = patch(
        store.form_submissions,
        id,
        { state: to, accepted_at: to === 'ACCEPTED' ? (current.accepted_at ?? now()) : current.accepted_at },
        'submissions.transitionSubmission',
      );
      store.submission_status_history.push({
        id: nextId(),
        workspace_id: current.workspace_id,
        submission_id: id,
        from_state: current.state,
        to_state: to,
        occurred_at: now(),
        reason_de: options.reasonDe ?? null,
        actor_label: options.actorLabel ?? 'system',
        correlation_id: options.correlationId ?? null,
        created_at: now(),
      });
      return updated;
    },
    async listStatusHistory(submissionId) {
      return store.submission_status_history.filter((row) => row.submission_id === submissionId).map(clone);
    },
    async loadAnswersForSubmissions(submissionIds) {
      const ids = new Set(uniqueIds(submissionIds));
      return groupBy(
        store.submission_answers_non_pii.filter((row) => ids.has(row.submission_id)).map(clone),
        (row) => row.submission_id,
      );
    },
    async getPii(submissionId) {
      return clone(store.submission_pii_encrypted.find((row) => row.submission_id === submissionId) ?? null);
    },
    async createLead(input) {
      if (store.leads.some((row) => row.submission_id === input.submission_id)) {
        throw conflict('leads_submission_unique', 'Zu dieser Übermittlung existiert bereits ein Lead.');
      }
      const lead = insert(
        store.leads,
        audit<T.LeadRow>({
          campaign_id: null,
          hubspot_contact_id: null,
          hubspot_company_id: null,
          sync_status: 'PENDING' satisfies SyncStatus,
          vq_status: 'NOT_SCHEDULED' satisfies VqStatus,
          vq_score: null,
          vq_reason_codes: [],
          vq_model_version: null,
          vq_evaluated_at: null,
          vq_scheduled_at: null,
          vq_occurred_at: null,
          ...input,
        }),
      );
      const submission = store.form_submissions.find((row) => row.id === lead.submission_id);
      if (submission) patch(store.form_submissions, submission.id, { lead_id: lead.id }, 'submissions.createLead');
      return lead;
    },
    async getLead(id) {
      return clone(store.leads.find((row) => row.id === id) ?? null);
    },
    async getLeadBySubmission(submissionId) {
      return clone(store.leads.find((row) => row.submission_id === submissionId) ?? null);
    },
    async listLeads(params: LeadListParams) {
      let rows = store.leads.filter((row) => row.workspace_id === params.workspaceId);
      if (params.campaignId) rows = rows.filter((row) => row.campaign_id === params.campaignId);
      if (params.vqStatuses?.length) rows = rows.filter((row) => params.vqStatuses?.includes(row.vq_status));
      if (params.syncStatuses?.length) rows = rows.filter((row) => params.syncStatuses?.includes(row.sync_status));
      rows = rows.filter((row) => between(row.created_at, params.from, params.to));
      rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return paged(rows, params);
    },
    async updateLead(id, changes) {
      return patch(store.leads, id, changes, 'submissions.updateLead');
    },
    async setVqEvaluation(id, evaluation) {
      const at = evaluation.occurredAt ?? now();
      const current = store.leads.find((row) => row.id === id);
      if (!current) throw notFound('submissions.setVqEvaluation', id);
      return patch(
        store.leads,
        id,
        {
          vq_status: evaluation.vq_status,
          vq_score: evaluation.vq_score ?? null,
          vq_reason_codes: evaluation.vq_reason_codes ?? [],
          vq_model_version: evaluation.vq_model_version,
          vq_evaluated_at: at,
          vq_scheduled_at: evaluation.vq_status === 'SCHEDULED' ? at : current.vq_scheduled_at,
          vq_occurred_at: ['ATTENDED', 'NO_SHOW', 'PASSED', 'REJECTED'].includes(evaluation.vq_status)
            ? at
            : current.vq_occurred_at,
        },
        'submissions.setVqEvaluation',
      );
    },
    async loadLeadsForSubmissions(submissionIds) {
      const ids = new Set(uniqueIds(submissionIds));
      return indexBy(
        store.leads.filter((row) => ids.has(row.submission_id)).map(clone),
        (row) => row.submission_id,
      );
    },
    async recordStageEvent(input) {
      const sourceId = input.source_event_id ?? null;
      const duplicate = store.lead_stage_events.some((row) =>
        sourceId
          ? row.source_event_id === sourceId && row.type === input.type
          : row.lead_id === (input.lead_id ?? null) &&
            row.type === input.type &&
            row.new_state === (input.new_state ?? input.type) &&
            row.occurred_at === input.occurred_at,
      );
      if (duplicate) return { event: null, created: false };

      const event = insert(
        store.lead_stage_events,
        audit<T.LeadStageEventRow>({
          lead_id: null,
          opportunity_id: null,
          submission_id: null,
          campaign_id: null,
          recorded_at: now(),
          source_object: 'INTERNAL',
          hubspot_object_id: null,
          previous_state: null,
          mapping_version: null,
          source_event_id: null,
          attribution_snapshot_id: null,
          amount_minor: null,
          currency: null,
          ...input,
          new_state: input.new_state ?? input.type,
        }),
      );
      return { event, created: true };
    },
    async listStageEvents(leadId) {
      return store.lead_stage_events.filter((row) => row.lead_id === leadId).map(clone);
    },
    async loadStageEventsForLeads(leadIds) {
      const ids = new Set(uniqueIds(leadIds));
      return groupBy(
        store.lead_stage_events.filter((row) => row.lead_id !== null && ids.has(row.lead_id)).map(clone),
        (row) => row.lead_id,
      );
    },
    async createOpportunity(input) {
      return insert(
        store.opportunities,
        audit<T.OpportunityRow>({
          lead_id: null,
          campaign_id: null,
          hubspot_deal_id: null,
          pipeline: null,
          stage: null,
          amount_minor: null,
          currency: null,
          closed_won_at: null,
          closed_lost_at: null,
          closed_lost_reason: null,
          sync_status: 'PENDING',
          ...input,
        }),
      );
    },
    async updateOpportunity(id, changes) {
      const guarded = { ...changes };
      delete guarded.acquisition_submission_id;
      delete guarded.acquisition_snapshot_id;
      return patch(store.opportunities, id, guarded, 'submissions.updateOpportunity');
    },
    async listOpportunities(workspaceId, campaignId) {
      return store.opportunities
        .filter((row) => row.workspace_id === workspaceId && (!campaignId || row.campaign_id === campaignId))
        .map(clone);
    },
    async loadOpportunitiesForLeads(leadIds) {
      const ids = new Set(uniqueIds(leadIds));
      return groupBy(
        store.opportunities.filter((row) => row.lead_id !== null && ids.has(row.lead_id)).map(clone),
        (row) => row.lead_id,
      );
    },
    async recordRevenue(input) {
      const sourceEventId = input.source_event_id ?? nextId();
      const existing = store.revenue_events.find(
        (row) =>
          row.opportunity_id === input.opportunity_id &&
          row.kind === input.kind &&
          row.source_event_id === sourceEventId,
      );
      if (existing) return patch(store.revenue_events, existing.id, input, 'submissions.recordRevenue');
      return insert(
        store.revenue_events,
        audit<T.RevenueEventRow>({
          campaign_id: null,
          reconciliation_delta_minor: null,
          ...input,
          source_event_id: sourceEventId,
        }),
      );
    },
    async funnelCounts(params): Promise<FunnelCounts> {
      const subs = store.form_submissions.filter(
        (row) =>
          row.workspace_id === params.workspaceId &&
          row.traffic_kind === 'PRODUCTION' &&
          (!params.campaignId || row.campaign_id === params.campaignId) &&
          between(row.submitted_at, params.from, params.to),
      );
      const subIds = new Set(subs.map((row) => row.id));
      const leads = store.leads.filter((row) => subIds.has(row.submission_id));
      const leadIds = new Set(leads.map((row) => row.id));
      const opportunities = store.opportunities.filter(
        (row) => row.lead_id !== null && leadIds.has(row.lead_id),
      );
      const snapshots = store.attribution_snapshots.filter((row) => subIds.has(row.submission_id));
      return foldFunnelCounts(subs, leads, opportunities, snapshots);
    },
    async attributionCoverage(campaignId): Promise<Rate> {
      const rows = store.attribution_snapshots.filter((row) => row.campaign_id === campaignId);
      return rate(rows.filter((row) => isTrustworthy(row.confidence)).length, rows.length);
    },
  };

  /* --- attribution -------------------------------------------------------- */

  const attribution: AttributionRepository = {
    async getSnapshot(submissionId) {
      return clone(store.attribution_snapshots.find((row) => row.submission_id === submissionId) ?? null);
    },
    async getSnapshotById(id) {
      return clone(store.attribution_snapshots.find((row) => row.id === id) ?? null);
    },
    async loadSnapshotsForSubmissions(submissionIds) {
      const ids = new Set(uniqueIds(submissionIds));
      return indexBy(
        store.attribution_snapshots.filter((row) => ids.has(row.submission_id)).map(clone),
        (row) => row.submission_id,
      );
    },
    async listSnapshotsForCampaign(campaignId) {
      return store.attribution_snapshots.filter((row) => row.campaign_id === campaignId).map(clone);
    },
    async coverageForCampaign(campaignId) {
      const rows = store.attribution_snapshots.filter((row) => row.campaign_id === campaignId);
      return rate(rows.filter((row) => isTrustworthy(row.confidence)).length, rows.length);
    },
    async confidenceBreakdown(campaignId) {
      const breakdown: Record<AttributionConfidence, number> = {
        EXACT: 0,
        HIGH_CONFIDENCE: 0,
        MEDIUM_CONFIDENCE: 0,
        LOW_CONFIDENCE: 0,
        UNKNOWN: 0,
      };
      for (const row of store.attribution_snapshots.filter((r) => r.campaign_id === campaignId)) {
        breakdown[row.confidence] += 1;
      }
      return breakdown;
    },
    async appendTouchpoint(input) {
      return insert(
        store.touchpoints,
        audit<T.TouchpointRow>({ from_signed_token: false, occurred_at: now(), ...input }),
      );
    },
    async listTouchpoints(visitorId) {
      return store.touchpoints.filter((row) => row.visitor_id === visitorId).map(clone);
    },
    async loadTouchpointsForVisitors(visitorIds) {
      const ids = new Set(uniqueIds(visitorIds));
      return groupBy(
        store.touchpoints.filter((row) => ids.has(row.visitor_id)).map(clone),
        (row) => row.visitor_id,
      );
    },
  };

  /* --- meta --------------------------------------------------------------- */

  const meta: MetaRepository = {
    async upsertAccount(input) {
      return upsertExternal(store.meta_accounts, input, {
        provider: 'META',
        currency: 'EUR',
        timezone: 'Europe/Berlin',
        business_id: null,
        page_id: null,
        instagram_actor_id: null,
        pixel_id: null,
        dataset_id: null,
        account_status: null,
        is_primary: false,
        connection_id: null,
        last_imported_at: null,
        raw: {},
      });
    },
    async listAccounts(workspaceId) {
      return store.meta_accounts.filter((row) => row.workspace_id === workspaceId).map(clone);
    },
    async getPrimaryAccount(workspaceId) {
      return clone(
        store.meta_accounts.find((row) => row.workspace_id === workspaceId && row.is_primary) ?? null,
      );
    },
    async upsertCampaigns(inputs) {
      return inputs.map((input) =>
        upsertExternal(store.meta_campaigns, input, {
          provider: 'META',
          campaign_id: null,
          objective: null,
          status: 'PAUSED',
          effective_status: null,
          buying_type: null,
          daily_budget_minor: null,
          lifetime_budget_minor: null,
          currency: 'EUR',
          start_time: null,
          stop_time: null,
          provider_created_time: null,
          provider_updated_time: null,
          raw: {},
          imported_at: now(),
        }),
      );
    },
    async upsertAdSets(inputs) {
      return inputs.map((input) =>
        upsertExternal(store.meta_adsets, input, {
          provider: 'META',
          status: 'PAUSED',
          effective_status: null,
          optimization_goal: null,
          billing_event: null,
          bid_strategy: null,
          daily_budget_minor: null,
          lifetime_budget_minor: null,
          targeting: {},
          start_time: null,
          end_time: null,
          experiment_arm_id: null,
          raw: {},
          imported_at: now(),
        }),
      );
    },
    async upsertCreatives(inputs) {
      return inputs.map((input) =>
        upsertExternal(store.meta_creatives, input, {
          provider: 'META',
          name: null,
          creative_version_id: null,
          creative_rendition_id: null,
          object_story_spec: {},
          image_hash: null,
          video_id: null,
          thumbnail_url: null,
          title: null,
          body: null,
          call_to_action_type: null,
          link_url: null,
          raw: {},
          imported_at: now(),
        }),
      );
    },
    async upsertAds(inputs) {
      return inputs.map((input) =>
        upsertExternal(store.meta_ads, input, {
          provider: 'META',
          meta_creative_id: null,
          status: 'PAUSED',
          effective_status: null,
          creative_version_id: null,
          tracking_specs: [],
          raw: {},
          imported_at: now(),
        }),
      );
    },
    async listCampaigns(workspaceId) {
      return store.meta_campaigns.filter((row) => row.workspace_id === workspaceId).map(clone);
    },
    async loadAdSetsForCampaigns(metaCampaignIds) {
      const ids = new Set(uniqueIds(metaCampaignIds));
      return groupBy(
        store.meta_adsets.filter((row) => ids.has(row.meta_campaign_id)).map(clone),
        (row) => row.meta_campaign_id,
      );
    },
    async loadAdsForAdSets(metaAdSetIds) {
      const ids = new Set(uniqueIds(metaAdSetIds));
      return groupBy(
        store.meta_ads.filter((row) => ids.has(row.meta_adset_id)).map(clone),
        (row) => row.meta_adset_id,
      );
    },
    async linkCampaign(metaCampaignId, campaignId) {
      return patch(store.meta_campaigns, metaCampaignId, { campaign_id: campaignId }, 'meta.linkCampaign');
    },
    async upsertInsightsDaily(rows) {
      for (const input of rows) {
        const existing = store.meta_insights_daily.find(
          (row) =>
            row.provider === 'META' &&
            row.level === input.level &&
            row.entity_external_id === input.entity_external_id &&
            row.date_start === input.date_start,
        );
        if (existing) {
          patch(store.meta_insights_daily, existing.id, { ...input, imported_at: now() }, 'meta.upsertInsightsDaily');
        } else {
          insert(
            store.meta_insights_daily,
            audit<T.MetaInsightsDailyRow>({
              provider: 'META',
              meta_account_id: null,
              meta_campaign_id: null,
              meta_adset_id: null,
              meta_ad_id: null,
              campaign_id: null,
              impressions: 0,
              reach: 0,
              clicks: 0,
              link_clicks: 0,
              spend_minor: 0,
              currency: 'EUR',
              frequency: null,
              cpm_minor: null,
              cpc_minor: null,
              ctr: null,
              video_views: 0,
              actions: [],
              action_values: [],
              raw: {},
              imported_at: now(),
              ...input,
            }),
          );
        }
      }
      return rows.length;
    },
    async listInsights(query: InsightsQuery) {
      return store.meta_insights_daily
        .filter(
          (row) =>
            row.workspace_id === query.workspaceId &&
            (!query.level || row.level === query.level) &&
            (!query.campaignId || row.campaign_id === query.campaignId) &&
            (!query.metaCampaignId || row.meta_campaign_id === query.metaCampaignId) &&
            between(row.date_start, query.from, query.to),
        )
        .sort((a, b) => (a.date_start < b.date_start ? -1 : 1))
        .map(clone);
    },
    async spendTotals(query): Promise<SpendTotals> {
      const rows = await meta.listInsights(query);
      const days = new Set(rows.map((row) => row.date_start));
      return {
        spend_minor: rows.reduce((sum, row) => sum + row.spend_minor, 0),
        impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
        clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
        link_clicks: rows.reduce((sum, row) => sum + row.link_clicks, 0),
        currency: rows[0]?.currency ?? 'EUR',
        days: days.size,
      };
    },
    async recordCapiDispatch(input) {
      const existing = store.capi_dispatches.find(
        (row) => row.dataset_id === input.dataset_id && row.event_id === input.event_id,
      );
      if (existing) return patch(store.capi_dispatches, existing.id, input, 'meta.recordCapiDispatch');
      return insert(
        store.capi_dispatches,
        audit<T.CapiDispatchRow>({
          outbox_event_id: null,
          action_source: 'website',
          submission_id: null,
          lead_id: null,
          opportunity_id: null,
          campaign_id: null,
          test_event_code: null,
          state: 'PENDING',
          events_received: null,
          fbtrace_id: null,
          response_redacted: null,
          error: null,
          dispatched_at: null,
          ...input,
        }),
      );
    },
    async updateCapiDispatch(id, changes) {
      return patch(store.capi_dispatches, id, changes, 'meta.updateCapiDispatch');
    },
    async listCapiDispatches(workspaceId, limit = 100) {
      return store.capi_dispatches
        .filter((row) => row.workspace_id === workspaceId)
        .slice(0, limit)
        .map(clone);
    },
    async createCommand(input) {
      const existing = store.external_commands.find((row) => row.idempotency_key === input.idempotency_key);
      if (existing) return clone(existing);
      return insert(
        store.external_commands,
        audit<T.ExternalCommandRow>({
          state: 'PENDING_CONFIRMATION',
          campaign_id: null,
          recommendation_id: null,
          target_level: null,
          target_external_id: null,
          request_preview: {},
          provider_response_redacted: null,
          error: null,
          attempt_count: 0,
          requested_by: null,
          requested_at: now(),
          confirmed_at: null,
          reconciled_at: null,
          ...input,
        }),
      );
    },
    async getCommandByIdempotencyKey(key) {
      return clone(store.external_commands.find((row) => row.idempotency_key === key) ?? null);
    },
    async confirmCommand(id, providerResponseRedacted) {
      return patch(
        store.external_commands,
        id,
        {
          state: 'PROVIDER_CONFIRMED',
          confirmed_at: now(),
          provider_response_redacted: providerResponseRedacted,
          error: null,
        },
        'meta.confirmCommand',
      );
    },
    async failCommand(id, error) {
      return patch(store.external_commands, id, { state: 'FAILED', error: error.slice(0, 2000) }, 'meta.failCommand');
    },
    async listCommands(workspaceId, kinds?: MetaCommandKind[]) {
      return store.external_commands
        .filter((row) => row.workspace_id === workspaceId && (!kinds?.length || kinds.includes(row.kind)))
        .map(clone);
    },
  };

  /* --- hubspot ------------------------------------------------------------ */

  const hubspot: HubspotRepository = {
    async listMappings(workspaceId, objectType) {
      return store.hubspot_mappings
        .filter((row) => row.workspace_id === workspaceId && (!objectType || row.object_type === objectType))
        .sort((a, b) => b.version - a.version)
        .map(clone);
    },
    async getActiveMapping(workspaceId, objectType) {
      return clone(
        store.hubspot_mappings.find(
          (row) =>
            row.workspace_id === workspaceId && row.object_type === objectType && row.state === 'PUBLISHED',
        ) ?? null,
      );
    },
    async createMapping(input) {
      return insert(
        store.hubspot_mappings,
        audit<T.HubspotMappingRow>({
          state: 'DRAFT',
          field_map: {},
          stage_map: {},
          pipeline_id: null,
          pipeline_label: null,
          required_fields: [],
          missing_fields: [],
          published_at: null,
          published_by: null,
          archived_at: null,
          ...input,
        }),
      );
    },
    async updateMapping(id, changes) {
      return versionPatch(store.hubspot_mappings, id, changes, 'hubspot.updateMapping');
    },
    async publishMapping(id, publishedBy) {
      const current = store.hubspot_mappings.find((row) => row.id === id);
      if (!current) throw notFound('hubspot.publishMapping', id);
      if (current.missing_fields.length > 0) {
        throw new DomainError('MAPPING_INCOMPLETE', {
          messageDe: `Das HubSpot-Mapping ist unvollständig. Es fehlen: ${current.missing_fields.join(', ')}.`,
          details: { missing: current.missing_fields, objectType: current.object_type },
        });
      }
      return publishVersion(store.hubspot_mappings, id, publishedBy, 'hubspot.publishMapping');
    },
    async missingMappings(workspaceId) {
      const result: Record<T.HubspotObjectType, string[]> = { CONTACT: [], COMPANY: [], DEAL: [] };
      for (const type of Object.keys(result) as T.HubspotObjectType[]) {
        const latest = store.hubspot_mappings
          .filter((row) => row.workspace_id === workspaceId && row.object_type === type)
          .sort((a, b) => b.version - a.version)[0];
        result[type] = latest ? [...latest.missing_fields] : ['Kein Mapping angelegt'];
      }
      return result;
    },
    async upsertObject(input) {
      return upsertExternal(store.hubspot_objects, input, {
        provider: 'HUBSPOT',
        am_person_id: null,
        lead_id: null,
        opportunity_id: null,
        properties_redacted: {},
        pipeline: null,
        stage: null,
        amount_minor: null,
        currency: null,
        archived: false,
        last_synced_at: null,
        provider_updated_at: null,
      });
    },
    async getObjectByExternalId(externalId) {
      return clone(store.hubspot_objects.find((row) => row.external_id === externalId) ?? null);
    },
    async listObjects(workspaceId, objectType) {
      return store.hubspot_objects
        .filter((row) => row.workspace_id === workspaceId && (!objectType || row.object_type === objectType))
        .map(clone);
    },
    async recordSyncAttempt(input) {
      return insert(
        store.hubspot_sync_attempts,
        audit<T.HubspotSyncAttemptRow>({
          outbox_event_id: null,
          submission_id: null,
          lead_id: null,
          opportunity_id: null,
          attempt_number: 1,
          mapping_version: null,
          request_hash: null,
          http_status: null,
          error_code: null,
          error_message: null,
          response_redacted: null,
          started_at: now(),
          finished_at: null,
          duration_ms: null,
          next_attempt_at: null,
          ...input,
        }),
      );
    },
    async listSyncAttempts(submissionId) {
      return store.hubspot_sync_attempts
        .filter((row) => row.submission_id === submissionId)
        .sort((a, b) => a.attempt_number - b.attempt_number)
        .map(clone);
    },
    async listFailedAttempts(workspaceId, statuses = ['FAILED_RETRYING', 'DEAD_LETTER']) {
      return store.hubspot_sync_attempts
        .filter((row) => row.workspace_id === workspaceId && statuses.includes(row.status))
        .map(clone);
    },
    async loadAttemptsForSubmissions(submissionIds) {
      const ids = new Set(uniqueIds(submissionIds));
      return groupBy(
        store.hubspot_sync_attempts
          .filter((row) => row.submission_id !== null && ids.has(row.submission_id))
          .map(clone),
        (row) => row.submission_id,
      );
    },
    async nextAttemptNumber(submissionId) {
      return (
        store.hubspot_sync_attempts
          .filter((row) => row.submission_id === submissionId)
          .reduce((acc, row) => Math.max(acc, row.attempt_number), 0) + 1
      );
    },
    async recordStageHistory(input) {
      const duplicate = store.hubspot_stage_history.some(
        (row) =>
          row.external_id === input.external_id &&
          row.to_stage === input.to_stage &&
          row.occurred_at === input.occurred_at,
      );
      if (duplicate) return { row: null, created: false };
      const row = insert(
        store.hubspot_stage_history,
        audit<T.HubspotStageHistoryRow>({
          hubspot_object_id: null,
          pipeline: null,
          from_stage: null,
          observed_at: now(),
          source: 'POLL',
          source_event_id: null,
          mapping_version: null,
          lead_stage_event_id: null,
          ...input,
        }),
      );
      return { row, created: true };
    },
    async listStageHistory(externalId) {
      return store.hubspot_stage_history.filter((row) => row.external_id === externalId).map(clone);
    },
  };

  /* --- recommendations ---------------------------------------------------- */

  const recommendations: RecommendationRepository = {
    async listOpen(workspaceId) {
      return store.recommendations
        .filter((row) => row.workspace_id === workspaceId && row.state === 'OPEN')
        .map(clone);
    },
    async listByCampaign(campaignId, states?: RecommendationState[]) {
      return store.recommendations
        .filter((row) => row.campaign_id === campaignId && (!states?.length || states.includes(row.state)))
        .map(clone);
    },
    async getById(id) {
      return clone(store.recommendations.find((row) => row.id === id) ?? null);
    },
    async upsert(input) {
      const existing = store.recommendations.find(
        (row) =>
          row.campaign_id === input.campaign_id &&
          row.rule_id === input.rule_id &&
          row.dedup_key === input.dedup_key &&
          row.state === 'OPEN',
      );
      if (existing) return patch(store.recommendations, existing.id, input, 'recommendations.upsert');
      return insert(
        store.recommendations,
        audit<T.RecommendationRow>({
          experiment_id: null,
          state: 'OPEN',
          explanation_de: null,
          next_hypothesis_de: null,
          facts: [],
          attribution_coverage: null,
          risk_note_de: null,
          affected_meta_objects: [],
          proposed_budget_change_pct: null,
          superseded_by: null,
          ...input,
        }),
      );
    },
    async update(id, changes) {
      return patch(store.recommendations, id, changes, 'recommendations.update');
    },
    async accept(id, actorId) {
      const row = patch(store.recommendations, id, { state: 'ACCEPTED', updated_by: actorId }, 'recommendations.accept');
      await recommendations.recordAction({
        workspace_id: row.workspace_id,
        recommendation_id: id,
        action: 'ACCEPTED',
        actor_id: actorId,
        actor_label: actorId ?? 'system',
      });
      return row;
    },
    async dismiss(id, actorId, noteDe) {
      const row = patch(store.recommendations, id, { state: 'DISMISSED', updated_by: actorId }, 'recommendations.dismiss');
      await recommendations.recordAction({
        workspace_id: row.workspace_id,
        recommendation_id: id,
        action: 'DISMISSED',
        actor_id: actorId,
        actor_label: actorId ?? 'system',
        note_de: noteDe ?? null,
      });
      return row;
    },
    async markExecuting(id, commandId, actorId) {
      const row = patch(store.recommendations, id, { state: 'EXECUTING', updated_by: actorId }, 'recommendations.markExecuting');
      await recommendations.recordAction({
        workspace_id: row.workspace_id,
        recommendation_id: id,
        action: 'EXECUTION_STARTED',
        external_command_id: commandId,
        command_state: 'QUEUED',
        actor_id: actorId,
        actor_label: actorId ?? 'system',
      });
      return row;
    },
    async completeFromCommand(id, command) {
      const confirmed = command.state === 'PROVIDER_CONFIRMED' || command.state === 'RECONCILED';
      const row = patch(
        store.recommendations,
        id,
        { state: confirmed ? 'EXECUTED' : 'EXECUTION_FAILED' },
        'recommendations.completeFromCommand',
      );
      await recommendations.recordAction({
        workspace_id: row.workspace_id,
        recommendation_id: id,
        action: confirmed ? 'EXECUTED' : 'EXECUTION_FAILED',
        external_command_id: command.id,
        command_state: command.state,
        actor_label: 'system',
        executed_at: now(),
        provider_confirmed_at: confirmed ? now() : null,
        error: confirmed ? null : (command.error ?? 'Der Provider hat die Aktion nicht bestätigt.'),
      });
      return row;
    },
    async supersede(id, supersededBy) {
      return patch(
        store.recommendations,
        id,
        { state: 'SUPERSEDED', superseded_by: supersededBy },
        'recommendations.supersede',
      );
    },
    async recordAction(input) {
      return insert(
        store.recommendation_actions,
        audit<T.RecommendationActionRow>({
          external_command_id: null,
          command_state: null,
          actor_id: null,
          actor_label: 'system',
          note_de: null,
          executed_at: null,
          provider_confirmed_at: null,
          error: null,
          ...input,
        }),
      );
    },
    async listActions(recommendationId) {
      return store.recommendation_actions.filter((row) => row.recommendation_id === recommendationId).map(clone);
    },
    async loadActionsFor(recommendationIds) {
      const ids = new Set(uniqueIds(recommendationIds));
      return groupBy(
        store.recommendation_actions.filter((row) => ids.has(row.recommendation_id)).map(clone),
        (row) => row.recommendation_id,
      );
    },
  };

  /* --- learning cards ----------------------------------------------------- */

  const learningCards: LearningCardRepository = {
    async list(params: LearningCardListParams) {
      let rows = store.learning_cards.filter((row) => row.workspace_id === params.workspaceId);
      if (params.campaignId) rows = rows.filter((row) => row.campaign_id === params.campaignId);
      if (params.experimentId) rows = rows.filter((row) => row.experiment_id === params.experimentId);
      if (params.confidences?.length) rows = rows.filter((row) => params.confidences?.includes(row.confidence));
      if (!params.includeSuperseded) rows = rows.filter((row) => row.superseded_by === null);
      rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return paged(rows, params);
    },
    async getById(id) {
      return clone(store.learning_cards.find((row) => row.id === id) ?? null);
    },
    async create(input) {
      const { sampleSize, ...card } = input;
      const confidence = deriveConfidence({
        maturity: card.data_maturity,
        attributionCoverage: card.attribution_coverage ?? null,
        sampleSize: sampleSize ?? 0,
      });
      const version =
        card.version ?? (await learningCards.nextVersion(card.campaign_id ?? null, card.experiment_id ?? null));
      return insert(
        store.learning_cards,
        audit<T.LearningCardRow>({
          campaign_id: null,
          experiment_id: null,
          angle_id: null,
          angle_name: null,
          offer_id: null,
          offer_name: null,
          creative_concept_de: null,
          funnel_kind: null,
          audience_de: null,
          period_start: null,
          period_end: null,
          spend_minor: 0,
          currency: 'EUR',
          outcome_facts: [],
          attribution_coverage: null,
          possible_explanation_de: null,
          suggested_next_test_de: null,
          superseded_by: null,
          ...card,
          version,
          confidence,
        }),
      );
    },
    async revise(previousId, input) {
      const previous = store.learning_cards.find((row) => row.id === previousId);
      if (!previous) throw notFound('learningCards.revise', previousId);
      const next = await learningCards.create({ ...input, version: previous.version + 1 });
      patch(store.learning_cards, previousId, { superseded_by: next.id }, 'learningCards.revise');
      return next;
    },
    async loadForCampaigns(campaignIds) {
      const ids = new Set(uniqueIds(campaignIds));
      return groupBy(
        store.learning_cards
          .filter((row) => row.campaign_id !== null && ids.has(row.campaign_id) && row.superseded_by === null)
          .map(clone),
        (row) => row.campaign_id,
      );
    },
    async nextVersion(campaignId, experimentId) {
      return (
        store.learning_cards
          .filter((row) => row.campaign_id === campaignId && row.experiment_id === experimentId)
          .reduce((acc, row) => Math.max(acc, row.version), 0) + 1
      );
    },
  };

  /* --- audit -------------------------------------------------------------- */

  const audit_: AuditRepository = {
    async append(entry) {
      return insert(
        store.audit_logs,
        audit<T.AuditLogRow>({
          occurred_at: now(),
          actor_id: null,
          campaign_id: null,
          before: null,
          after: null,
          correlation_id: null,
          ...entry,
        }),
      );
    },
    async appendMany(entries) {
      const rows: T.AuditLogRow[] = [];
      for (const entry of entries) rows.push(await audit_.append(entry));
      return rows;
    },
    async list(params: AuditListParams) {
      let rows = store.audit_logs.filter((row) => row.workspace_id === params.workspaceId);
      if (params.actions?.length) rows = rows.filter((row) => params.actions?.includes(row.action));
      if (params.campaignId) rows = rows.filter((row) => row.campaign_id === params.campaignId);
      if (params.actorId) rows = rows.filter((row) => row.actor_id === params.actorId);
      if (params.entityType) rows = rows.filter((row) => row.entity_type === params.entityType);
      if (params.entityId) rows = rows.filter((row) => row.entity_id === params.entityId);
      rows = rows.filter((row) => between(row.occurred_at, params.from, params.to));
      rows = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
      return paged(rows, params);
    },
    async listForEntity(workspaceId, entityType, entityId) {
      return store.audit_logs
        .filter(
          (row) =>
            row.workspace_id === workspaceId &&
            row.entity_type === entityType &&
            row.entity_id === entityId,
        )
        .map(clone);
    },
  };

  /* --- integrations ------------------------------------------------------- */

  const integrations: IntegrationRepository = {
    async list(workspaceId) {
      return store.integration_connections.filter((row) => row.workspace_id === workspaceId).map(clone);
    },
    async get(workspaceId, provider: Provider) {
      return clone(
        store.integration_connections.find(
          (row) => row.workspace_id === workspaceId && row.provider === provider,
        ) ?? null,
      );
    },
    async upsert(input) {
      const existing = store.integration_connections.find(
        (row) => row.workspace_id === input.workspace_id && row.provider === input.provider,
      );
      if (existing) return patch(store.integration_connections, existing.id, input, 'integrations.upsert');
      return insert(
        store.integration_connections,
        audit<T.IntegrationConnectionRow>({
          state: 'NOT_CONFIGURED' satisfies ConnectionState,
          account_label: null,
          external_account_id: null,
          granted_scopes: [],
          credentials_ciphertext: null,
          credentials_iv: null,
          credentials_auth_tag: null,
          key_version: null,
          connected_at: null,
          expires_at: null,
          last_checked_at: null,
          last_error: null,
          ...input,
        }),
      );
    },
    async setState(workspaceId, provider, state, error = null) {
      return integrations.upsert({
        workspace_id: workspaceId,
        provider,
        state,
        last_error: error,
        last_checked_at: now(),
        connected_at: state === 'CONNECTED' ? now() : null,
      });
    },
    async storeCredentials(workspaceId, provider, credentials) {
      const envelope = encrypt(JSON.stringify(credentials), { aad: `${workspaceId}:${provider}` });
      return integrations.upsert({
        workspace_id: workspaceId,
        provider,
        state: 'CONNECTED',
        credentials_ciphertext: envelope.ciphertext,
        credentials_iv: envelope.iv,
        credentials_auth_tag: envelope.auth_tag,
        key_version: envelope.key_version,
        connected_at: now(),
      });
    },
    async readCredentials(workspaceId, provider) {
      const row = await integrations.get(workspaceId, provider);
      if (!row?.credentials_ciphertext || !row.credentials_iv || !row.credentials_auth_tag || !row.key_version) {
        return null;
      }
      const envelope: EncryptedEnvelope = {
        algorithm: 'AES-256-GCM',
        key_version: row.key_version,
        iv: row.credentials_iv,
        auth_tag: row.credentials_auth_tag,
        ciphertext: row.credentials_ciphertext,
      };
      return JSON.parse(decrypt(envelope, { aad: `${workspaceId}:${provider}` })) as Record<string, unknown>;
    },
    async recordHealthChecks(checks) {
      return checks.map((check) =>
        insert(
          store.integration_health_checks,
          audit<T.IntegrationHealthCheckRow>({
            detail_de: null,
            remediation_de: null,
            blocks_live_only: false,
            checked_at: now(),
            ...check,
          }),
        ),
      );
    },
    async latestHealth(workspaceId, provider) {
      const rows = store.integration_health_checks
        .filter((row) => row.workspace_id === workspaceId && (!provider || row.provider === provider))
        .sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1))
        .map(clone);
      return [...indexBy(rows, (row) => `${row.provider}:${row.key}`).values()];
    },
    async overallHealth(workspaceId, provider): Promise<HealthStatus> {
      const checks = await integrations.latestHealth(workspaceId, provider);
      return rollUpHealth(
        checks.map((check) => ({
          key: check.key,
          labelDe: check.label_de,
          status: check.status,
          detailDe: check.detail_de,
          checkedAt: check.checked_at,
          remediationDe: check.remediation_de,
          blocksLiveOnly: check.blocks_live_only,
        })),
      );
    },
    async getCursor(workspaceId, provider, resource) {
      return clone(
        store.sync_cursors.find(
          (row) =>
            row.workspace_id === workspaceId && row.provider === provider && row.resource === resource,
        ) ?? null,
      );
    },
    async setCursor(workspaceId, provider, resource, changes) {
      const existing = store.sync_cursors.find(
        (row) => row.workspace_id === workspaceId && row.provider === provider && row.resource === resource,
      );
      const payload = {
        workspace_id: workspaceId,
        provider,
        resource,
        cursor_value: changes.cursor_value ?? existing?.cursor_value ?? null,
        cursor_time: changes.cursor_time ?? existing?.cursor_time ?? null,
        last_run_at: now(),
        last_success_at: changes.success ? now() : (existing?.last_success_at ?? null),
        last_error: changes.success ? null : (changes.error ?? 'Unbekannter Fehler'),
        consecutive_failures: changes.success ? 0 : (existing?.consecutive_failures ?? 0) + 1,
      };
      if (existing) return patch(store.sync_cursors, existing.id, payload, 'integrations.setCursor');
      return insert(store.sync_cursors, audit<T.SyncCursorRow>(payload));
    },
    async enqueueJob(input) {
      const existing = store.sync_jobs.find((row) => row.idempotency_key === input.idempotency_key);
      if (existing) return clone(existing);
      return insert(
        store.sync_jobs,
        audit<T.SyncJobRow>({
          state: 'QUEUED',
          scheduled_for: now(),
          started_at: null,
          finished_at: null,
          attempt_count: 0,
          records_processed: 0,
          records_failed: 0,
          params: {},
          result: null,
          error: null,
          ...input,
        }),
      );
    },
    async listDueJobs(workspaceId, limit = 20) {
      return store.sync_jobs
        .filter(
          (row) => row.workspace_id === workspaceId && row.state === 'QUEUED' && row.scheduled_for <= now(),
        )
        .slice(0, limit)
        .map(clone);
    },
    async startJob(id) {
      const current = store.sync_jobs.find((row) => row.id === id);
      if (!current) throw notFound('integrations.startJob', id);
      if (current.state !== 'QUEUED') {
        throw new DomainError('CONFLICT', {
          messageDe: 'Dieser Sync-Auftrag wurde bereits von einem anderen Worker übernommen.',
          details: { id },
        });
      }
      return patch(
        store.sync_jobs,
        id,
        { state: 'RUNNING', started_at: now(), attempt_count: current.attempt_count + 1 },
        'integrations.startJob',
      );
    },
    async finishJob(id, result) {
      return patch(
        store.sync_jobs,
        id,
        {
          state: result.error ? 'FAILED' : 'SUCCEEDED',
          finished_at: now(),
          records_processed: result.processed,
          records_failed: result.failed,
          error: result.error ?? null,
          result: (result.payload ?? null) as T.SyncJobRow['result'],
        },
        'integrations.finishJob',
      );
    },
  };

  /* --- rollups ------------------------------------------------------------ */

  /** Mirrors the generated column in the database, including the NULL handling. */
  const dimensionKey = (row: {
    campaign_id?: string | null;
    campaign_version_id?: string | null;
    creative_version_id?: string | null;
    funnel_version_id?: string | null;
    experiment_id?: string | null;
    experiment_arm_id?: string | null;
  }): string =>
    [
      row.campaign_id,
      row.campaign_version_id,
      row.creative_version_id,
      row.funnel_version_id,
      row.experiment_id,
      row.experiment_arm_id,
    ]
      .map((value) => value ?? '-')
      .join('|');

  const rollups: RollupRepository = {
    async upsertDaily(rows) {
      if (rows.length === 0) return 0;
      for (const input of rows) {
        // The database CHECK fixes traffic_scope to PRODUCTION; refuse anything
        // that claims otherwise rather than silently relabelling it.
        const scope = (input as { traffic_scope?: string }).traffic_scope;
        if (scope !== undefined && scope !== 'PRODUCTION') {
          throw new DomainError('VALIDATION_FAILED', {
            messageDe:
              'In ein Rollup dürfen ausschließlich PRODUCTION-Daten einfließen. Preview-, Test- und Bot-Traffic ist ausgeschlossen.',
            details: { day: input.day },
          });
        }

        const key = dimensionKey(input);
        const existing = store.performance_rollups.find(
          (row) =>
            row.workspace_id === input.workspace_id && row.day === input.day && row.dimension_key === key,
        );
        const computedAt = input.computed_at ?? now();
        if (existing) {
          patch(
            store.performance_rollups,
            existing.id,
            { ...input, dimension_key: key, traffic_scope: 'PRODUCTION', computed_at: computedAt },
            'rollups.upsertDaily',
          );
        } else {
          insert(
            store.performance_rollups,
            audit<T.PerformanceRollupRow>({
              campaign_id: null,
              campaign_version_id: null,
              creative_version_id: null,
              funnel_version_id: null,
              experiment_id: null,
              experiment_arm_id: null,
              impressions: 0,
              reach: 0,
              link_clicks: 0,
              spend_minor: 0,
              currency: 'EUR',
              funnel_sessions: 0,
              form_views: 0,
              form_starts: 0,
              step_completions: 0,
              validation_failures: 0,
              submissions: 0,
              leads: 0,
              vq_scheduled: 0,
              vq_attended: 0,
              vq_no_show: 0,
              qualified_vq: 0,
              opportunities: 0,
              closed_won: 0,
              closed_lost: 0,
              revenue_minor: 0,
              attribution_coverage: null,
              data_maturity: 'IMMATURE',
              source_max_at: null,
              ...input,
              dimension_key: key,
              traffic_scope: 'PRODUCTION',
              computed_at: computedAt,
            }),
          );
        }
      }
      return rows.length;
    },
    async listDays(workspaceId, since, until) {
      return [
        ...new Set(
          store.performance_rollups
            .filter((row) => row.workspace_id === workspaceId && row.day >= since && row.day <= until)
            .map((row) => row.day),
        ),
      ].sort();
    },
    async query(params: RollupQuery) {
      let rows = store.performance_rollups.filter((row) => row.workspace_id === params.workspaceId);
      if (params.since) rows = rows.filter((row) => row.day >= params.since!);
      if (params.until) rows = rows.filter((row) => row.day <= params.until!);
      if (params.maturities?.length) rows = rows.filter((row) => params.maturities?.includes(row.data_maturity));
      if (params.dimension) {
        const column = ROLLUP_DIMENSION_COLUMNS[params.dimension];
        const ids = uniqueIds(params.ids ?? []);
        rows = rows.filter((row) => {
          const value = row[column] as string | null;
          return ids.length > 0 ? value !== null && ids.includes(value) : value !== null;
        });
      }
      return [...rows].sort((a, b) => (a.day < b.day ? -1 : 1)).map(clone);
    },
    async daysNeedingRecompute(workspaceId, since, until) {
      const inRange = (value: string) => {
        const day = value.slice(0, 10);
        return day >= since && day <= until;
      };
      // Newest source timestamp per day, across every production input.
      const latestSource = new Map<string, string>();
      const note = (day: string, at: string) => {
        const current = latestSource.get(day);
        if (!current || current < at) latestSource.set(day, at);
      };

      for (const row of store.events) {
        if (row.workspace_id !== workspaceId || !isRollupEligible(row.traffic_kind)) continue;
        if (!inRange(row.occurred_at)) continue;
        note(row.occurred_at.slice(0, 10), row.received_at);
      }
      for (const row of store.meta_insights_daily) {
        if (row.workspace_id !== workspaceId || !inRange(row.date_start)) continue;
        note(row.date_start, row.imported_at);
      }
      for (const row of store.form_submissions) {
        if (row.workspace_id !== workspaceId || !isRollupEligible(row.traffic_kind)) continue;
        if (!inRange(row.submitted_at)) continue;
        note(row.submitted_at.slice(0, 10), row.updated_at);
      }
      for (const row of store.lead_stage_events) {
        if (row.workspace_id !== workspaceId || !inRange(row.occurred_at)) continue;
        note(row.occurred_at.slice(0, 10), row.recorded_at);
      }

      const oldestRollup = new Map<string, string>();
      for (const row of store.performance_rollups) {
        if (row.workspace_id !== workspaceId || row.day < since || row.day > until) continue;
        const current = oldestRollup.get(row.day);
        if (!current || row.computed_at < current) oldestRollup.set(row.day, row.computed_at);
      }

      return [...latestSource.entries()]
        .filter(([day, latest]) => {
          const computedAt = oldestRollup.get(day);
          return computedAt === undefined || computedAt < latest;
        })
        .map(([day]) => day)
        .sort();
    },
  };

  /* --- job locks ---------------------------------------------------------- */

  const jobs: JobsRepository = {
    async tryAcquireJobLock(key, holder, ttlSeconds = 300) {
      const at = now();
      const expiresAt = new Date(Date.parse(at) + Math.max(ttlSeconds, 1) * 1000).toISOString();
      const existing = store.job_locks.find((row) => row.key === key);

      if (!existing) {
        store.job_locks.push({
          key,
          holder,
          acquired_at: at,
          expires_at: expiresAt,
          acquire_count: 1,
          created_at: at,
          updated_at: at,
        });
        return true;
      }

      // Free when expired, or already ours — a job renewing its own lock is not
      // locked out by itself.
      if (existing.expires_at > at && existing.holder !== holder) return false;

      existing.holder = holder;
      existing.acquired_at = at;
      existing.expires_at = expiresAt;
      existing.acquire_count += 1;
      existing.updated_at = at;
      return true;
    },
    async releaseJobLock(key, holder) {
      const index = store.job_locks.findIndex((row) => row.key === key && row.holder === holder);
      // Releasing a lock somebody else holds is a no-op, never a steal.
      if (index >= 0) store.job_locks.splice(index, 1);
    },
    async listLocks() {
      return [...store.job_locks].sort((a, b) => a.key.localeCompare(b.key)).map(clone);
    },
  };

  /* --- settings ----------------------------------------------------------- */

  const settings: SettingsRepository = {
    async getWorkspace(id) {
      return clone(store.workspaces.find((row) => row.id === id) ?? null);
    },
    async getWorkspaceBySlug(slug) {
      return clone(store.workspaces.find((row) => row.slug === slug) ?? null);
    },
    async listMembers(workspaceId) {
      return store.workspace_members.filter((row) => row.workspace_id === workspaceId).map(clone);
    },
    async setMemberRoles(workspaceId, profileId, roles: Role[]) {
      if (roles.length === 0) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Ein Mitglied benötigt mindestens eine Rolle.',
          details: { workspaceId, profileId },
        });
      }
      const member = store.workspace_members.find(
        (row) => row.workspace_id === workspaceId && row.profile_id === profileId,
      );
      if (!member) throw notFound('settings.setMemberRoles');
      return patch(store.workspace_members, member.id, { roles }, 'settings.setMemberRoles');
    },
    async getSettings(workspaceId) {
      const existing = store.workspace_settings.find((row) => row.workspace_id === workspaceId);
      if (existing) return clone(existing);
      return {
        workspace_id: workspaceId,
        experiment_thresholds: {},
        recommendation_config: {},
        retention_policy: {},
        attribution_window_days: 30,
        form_abandon_minutes: 30,
        historical_import_months: 24,
        active_consent_version_id: null,
        vq_model_version: 'vq-1',
        created_at: now(),
        updated_at: now(),
        updated_by: null,
      };
    },
    async updateSettings(workspaceId, changes) {
      const index = store.workspace_settings.findIndex((row) => row.workspace_id === workspaceId);
      if (index < 0) {
        const created = { ...(await settings.getSettings(workspaceId)), ...changes, updated_at: now() };
        store.workspace_settings.push(created);
        return clone(created);
      }
      store.workspace_settings[index] = { ...store.workspace_settings[index], ...changes, updated_at: now() };
      return clone(store.workspace_settings[index]);
    },
    async experimentThresholds(workspaceId) {
      const row = await settings.getSettings(workspaceId);
      return { ...DEFAULT_EXPERIMENT_THRESHOLDS, ...row.experiment_thresholds };
    },
    async recommendationConfig(workspaceId) {
      const row = await settings.getSettings(workspaceId);
      return { ...DEFAULT_RECOMMENDATION_CONFIG, ...row.recommendation_config };
    },
    async retentionPolicy(workspaceId) {
      const row = await settings.getSettings(workspaceId);
      return { ...UNCONFIGURED_RETENTION_POLICY, ...row.retention_policy };
    },
    async listRoleLimits(workspaceId) {
      return store.role_limits.filter((row) => row.workspace_id === workspaceId).map(clone);
    },
    async upsertRoleLimit(input) {
      const existing = store.role_limits.find(
        (row) => row.workspace_id === input.workspace_id && row.role === input.role,
      );
      if (existing) return patch(store.role_limits, existing.id, input, 'settings.upsertRoleLimit');
      return insert(store.role_limits, audit<T.RoleLimitRow>(input));
    },
    async budgetLimitFor(workspaceId, role: Role) {
      const configured = store.role_limits.find(
        (row) => row.workspace_id === workspaceId && row.role === role,
      );
      if (configured) return clone(configured);
      const fallback = DEFAULT_ROLE_BUDGET_LIMITS[role];
      return {
        id: `${workspaceId}:${role}`,
        workspace_id: workspaceId,
        role,
        max_single_increase_pct: fallback.maxSingleIncreasePct,
        max_daily_budget_minor: fallback.maxDailyBudgetMinor,
        max_scales_per_24h: fallback.maxScalesPer24h,
        may_pause: fallback.mayPause,
        created_at: now(),
        updated_at: now(),
        created_by: null,
        updated_by: null,
      };
    },
    async brandKnowledge(workspaceId, options = {}): Promise<BrandKnowledgeBundle> {
      const approvedOnly = options.approvedOnly ?? true;
      const keep = <R extends { approved: boolean }>(rows: R[]): R[] =>
        approvedOnly ? rows.filter((row) => row.approved) : rows;
      const scoped = <R extends { workspace_id: string }>(rows: R[]): R[] =>
        rows.filter((row) => row.workspace_id === workspaceId);

      return {
        brand: clone(
          store.brand_profiles.find((row) => row.workspace_id === workspaceId && row.is_default) ??
            store.brand_profiles.find((row) => row.workspace_id === workspaceId) ??
            null,
        ),
        audiences: scoped(store.audience_segments)
          .filter((row) => row.is_active)
          .map(clone),
        services: scoped(store.services)
          .filter((row) => row.is_active)
          .map(clone),
        offers: scoped(store.offers)
          .filter((row) => row.is_active)
          .map(clone),
        evidence: keep(scoped(store.evidence_items)).map(clone),
        caseStudies: keep(scoped(store.case_studies)).map(clone),
        testimonials: keep(scoped(store.testimonials)).map(clone),
        faqs: keep(scoped(store.faqs)).map(clone),
        guardrails: scoped(store.guardrails)
          .filter((row) => row.is_active)
          .map(clone),
      };
    },
  };

  const database: MemoryDatabase = {
    get store() {
      return store;
    },
    reset() {
      store = createEmptyStore();
      nextId = createIdFactory(options.idSeed ?? 1);
    },
    campaigns,
    proposals,
    creatives,
    funnels,
    experiments,
    tracking,
    submissions,
    attribution,
    outbox,
    meta,
    hubspot,
    recommendations,
    rollups,
    learningCards,
    audit: audit_,
    integrations,
    settings,
    jobs,
  };

  return database;
}
