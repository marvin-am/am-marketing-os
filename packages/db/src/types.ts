/**
 * Hand-written row types.
 *
 * These mirror `supabase/migrations/**` one-to-one and therefore keep the
 * database's `snake_case` (AGENTS.md conventions). Enum-ish columns are typed
 * with the corresponding union from `@am/domain`, so a schema CHECK constraint
 * and a TypeScript type can never drift apart silently — extending an enum in
 * `packages/domain/src/enums.ts` immediately breaks compilation here if the
 * migration was not updated too.
 */
import type {
  AppEnvironment,
  ApprovalKind,
  ApprovalState,
  AspectRatio,
  AssetReviewState,
  AttributionConfidence,
  AttributionLevel,
  AuditAction,
  CampaignErrorState,
  CampaignState,
  CapiStage,
  Channel,
  CommandState,
  ConfidenceLabel,
  ConnectionState,
  ConsentPurpose,
  ConsentStatus,
  CreativePrinciple,
  DataMaturity,
  EventType,
  EvidenceKind,
  ExperimentKind,
  ExperimentState,
  ExperimentVerdict,
  FunnelKind,
  HealthStatus,
  MediaKind,
  MetaCommandKind,
  MetaEntityStatus,
  MetricKey,
  OfferType,
  OutboxDestination,
  OutboxState,
  Provider,
  QualificationClass,
  RecommendationActionKind,
  RecommendationState,
  RiskLevel,
  Role,
  SalesEventType,
  SubmissionState,
  SyncStatus,
  TouchRole,
  TrafficKind,
  ValidationErrorCode,
  VqStatus,
} from '@am/domain';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** ISO-8601 UTC string at the boundary, `timestamptz` in the database. */
export type Timestamptz = string;
/** `YYYY-MM-DD`. */
export type DateOnly = string;
export type Uuid = string;
/** 64 lowercase hex characters. */
export type Sha256Hex = string;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Columns the database fills in for you. */
type ServerManaged = 'id' | 'created_at' | 'updated_at';

type ServerManagedKeys<T> = Extract<keyof T, ServerManaged>;
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];

/**
 * Insert shape: required columns stay required; nullable columns, server-managed
 * columns and the explicitly listed defaulted columns become optional.
 */
export type Insertable<T, Defaulted extends keyof T = never> = Omit<
  T,
  ServerManagedKeys<T> | NullableKeys<T> | Defaulted
> &
  Partial<Pick<T, ServerManagedKeys<T> | NullableKeys<T> | Defaulted>>;

/** Update shape: everything except the identity and creation timestamp. */
export type Updatable<T> = Partial<Omit<T, Extract<keyof T, 'id' | 'created_at'>>>;

/** Audit columns present on every mutable business table. */
export interface AuditColumns {
  created_at: Timestamptz;
  updated_at: Timestamptz;
  created_by: Uuid | null;
  updated_by: Uuid | null;
}

export interface Page<T> {
  rows: T[];
  total: number | null;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface PageParams {
  limit?: number;
  offset?: number;
}

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 200;

/* -------------------------------------------------------------------------- */
/* Core                                                                        */
/* -------------------------------------------------------------------------- */

export interface WorkspaceRow extends AuditColumns {
  id: Uuid;
  slug: string;
  name: string;
  locale: string;
  default_currency: string;
  timezone: string;
  is_active: boolean;
}

export interface ProfileRow {
  id: Uuid;
  email: string;
  display_name: string;
  avatar_url: string | null;
  locale: string;
  is_active: boolean;
  last_seen_at: Timestamptz | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface WorkspaceMemberRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  profile_id: Uuid;
  roles: Role[];
  invited_by: Uuid | null;
  joined_at: Timestamptz;
  is_active: boolean;
}

export interface RoleLimitRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  role: Role;
  max_single_increase_pct: number;
  max_daily_budget_minor: number;
  max_scales_per_24h: number;
  may_pause: boolean;
}

export interface WorkspaceSettingsRow {
  workspace_id: Uuid;
  experiment_thresholds: JsonObject;
  recommendation_config: JsonObject;
  retention_policy: JsonObject;
  attribution_window_days: number;
  form_abandon_minutes: number;
  historical_import_months: number;
  active_consent_version_id: Uuid | null;
  vq_model_version: string;
  created_at: Timestamptz;
  updated_at: Timestamptz;
  updated_by: Uuid | null;
}

/* -------------------------------------------------------------------------- */
/* Brand knowledge                                                             */
/* -------------------------------------------------------------------------- */

export interface BrandColors {
  primary: string;
  foreground: string;
  background: string;
  accent: string;
}

export interface BrandProfileRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  positioning: string;
  tone_of_voice: string;
  avoid_terms: string[];
  preferred_terms: string[];
  colors: BrandColors;
  logo_asset_path: string | null;
  is_default: boolean;
}

export interface AudienceSegmentRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  description: string;
  company_size: string | null;
  industries: string[];
  roles: string[];
  pain_points: string[];
  buying_triggers: string[];
  objections: string[];
  is_active: boolean;
  sort_order: number;
}

export interface ServiceRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  description: string;
  category: string | null;
  is_active: boolean;
}

export interface OfferRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  service_id: Uuid | null;
  name: string;
  offer_type: OfferType;
  current_version_id: Uuid | null;
  is_active: boolean;
}

export type VersionState = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface OfferVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  offer_id: Uuid;
  version: number;
  state: VersionState;
  spec: JsonObject;
  content_hash: Sha256Hex;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export interface EvidenceItemRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  kind: EvidenceKind;
  statement: string;
  source: string;
  approved: boolean;
  approved_at: Timestamptz | null;
  approved_by: Uuid | null;
  valid_until: Timestamptz | null;
  numeric_value: number | null;
  numeric_unit: string | null;
  campaign_id: Uuid | null;
}

export interface ClaimRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid | null;
  text: string;
  evidence_item_id: Uuid | null;
  confidence: ConfidenceLabel;
  requires_hypothesis_label: boolean;
  approved: boolean;
  approved_at: Timestamptz | null;
  approved_by: Uuid | null;
}

export interface CaseStudyRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  client: string;
  industry: string | null;
  challenge: string;
  approach: string;
  outcome: string;
  metrics: Json;
  approved: boolean;
  usable_in_ads: boolean;
}

export interface TestimonialRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  quote: string;
  author_name: string;
  author_role: string | null;
  company: string | null;
  approved: boolean;
  usable_in_ads: boolean;
}

export interface FaqRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  question: string;
  answer: string;
  approved: boolean;
  sort_order: number;
}

export type GuardrailKind = 'FORBIDDEN_CLAIM' | 'FORBIDDEN_TERM' | 'REQUIRED_DISCLAIMER' | 'STYLE_RULE';

export interface GuardrailRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  kind: GuardrailKind;
  pattern: string;
  match_mode: 'SUBSTRING' | 'WORD';
  reason_de: string;
  severity: 'BLOCK' | 'WARN';
  is_active: boolean;
}

export interface KnowledgeDocumentRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  title: string;
  source_kind: 'UPLOAD' | 'URL' | 'CAMPAIGN_EXPORT' | 'MANUAL' | 'HISTORICAL_IMPORT';
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  byte_size: number | null;
  content_text: string | null;
  checksum: Sha256Hex | null;
  language: string;
  provider: string;
  external_id: string;
  ingested_at: Timestamptz | null;
}

export interface KnowledgeEmbeddingRow {
  id: Uuid;
  workspace_id: Uuid;
  source_kind: 'DOCUMENT' | 'ANGLE' | 'CAMPAIGN' | 'LEARNING_CARD' | 'CREATIVE';
  document_id: Uuid | null;
  entity_id: Uuid | null;
  chunk_index: number;
  chunk_text: string;
  model: string;
  /** Always 1536: `text-embedding-3-large` with `dimensions: 1536`, so pgvector can index it. */
  dimensions: number;
  token_count: number | null;
  content_hash: Sha256Hex;
  embedding: number[] | string | null;
  created_at: Timestamptz;
}

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                   */
/* -------------------------------------------------------------------------- */

export interface CampaignRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  slug: string;
  state: CampaignState;
  error_state: CampaignErrorState | null;
  error_detail_de: string | null;
  brand_profile_id: Uuid | null;
  audience_segment_id: Uuid | null;
  service_id: Uuid | null;
  offer_id: Uuid | null;
  offer_version_id: Uuid | null;
  angle_id: Uuid | null;
  angle_version_id: Uuid | null;
  current_version_id: Uuid | null;
  core_message: string | null;
  hypothesis: string | null;
  currency: string;
  daily_budget_minor: number;
  test_budget_minor: number;
  target_cpl_minor: number | null;
  target_cost_per_qualified_vq_minor: number | null;
  primary_metric: MetricKey | null;
  secondary_metrics: MetricKey[];
  guardrail_metrics: MetricKey[];
  attribution_level: AttributionLevel;
  tags: string[];
  planned_start_at: Timestamptz | null;
  planned_end_at: Timestamptz | null;
  launched_at: Timestamptz | null;
  paused_at: Timestamptz | null;
  completed_at: Timestamptz | null;
  archived_at: Timestamptz | null;
  imported_from_provider: string | null;
  imported_external_id: string | null;
}

export interface CampaignVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  version: number;
  state: VersionState;
  spec: JsonObject;
  content_hash: Sha256Hex;
  notes: string | null;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export type AngleVerdictValue = 'DISTINCT' | 'ITERATION' | 'TOO_SIMILAR';

export interface AngleRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  perspective: string;
  rationale: string;
  keywords: string[];
  current_version_id: Uuid | null;
  first_used_campaign_id: Uuid | null;
  last_used_at: Timestamptz | null;
  use_count: number;
}

export interface AngleVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  angle_id: Uuid;
  version: number;
  state: VersionState;
  spec: JsonObject;
  content_hash: Sha256Hex;
  distinctness_verdict: AngleVerdictValue | null;
  max_similarity: number | null;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export interface CampaignAngleRow {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  angle_id: Uuid;
  angle_version_id: Uuid;
  role: 'PRIMARY' | 'SECONDARY';
  created_at: Timestamptz;
  created_by: Uuid | null;
}

export interface CampaignProposalRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  ai_job_id: Uuid | null;
  prompt_version_id: Uuid | null;
  model: string;
  generation_index: number;
  proposal: JsonObject;
  content_hash: Sha256Hex;
  diversity_score: number | null;
  angle_verdict: AngleVerdictValue | null;
  max_similarity: number | null;
  similar_campaigns: Json;
  accepted: boolean;
  accepted_at: Timestamptz | null;
  accepted_by: Uuid | null;
  rejected_reason_de: string | null;
  superseded_by: Uuid | null;
}

export interface ApprovalRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  kind: ApprovalKind;
  state: ApprovalState;
  approved_content_hash: Sha256Hex | null;
  approved_by: Uuid | null;
  approved_at: Timestamptz | null;
  rejected_reason_de: string | null;
  invalidated_at: Timestamptz | null;
  invalidated_reason_de: string | null;
  requested_by: Uuid | null;
}

/* -------------------------------------------------------------------------- */
/* Creatives                                                                   */
/* -------------------------------------------------------------------------- */

export interface MetaCopyJson extends JsonObject {
  primaryText: string;
  headline: string;
  description: string;
  callToAction: string;
}

export interface CreativeConceptRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  campaign_version_id: Uuid | null;
  concept_key: string;
  name: string;
  principle: CreativePrinciple;
  visual_idea: string;
  image_prompt: string;
  copy: MetaCopyJson;
  hypothesis: string;
  rationale: string;
  proof_used: string | null;
  funnel_promise: string;
  alt_text: string;
  aspect_ratios: AspectRatio[];
  claims: Json;
  review_state: AssetReviewState;
  reviewed_by: Uuid | null;
  reviewed_at: Timestamptz | null;
  rejection_reason_de: string | null;
  current_version_id: Uuid | null;
  diversity_hash: Sha256Hex | null;
  sort_order: number;
}

export interface CreativeAssetRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  concept_id: Uuid | null;
  campaign_id: Uuid | null;
  media_kind: MediaKind;
  source: 'AI_GENERATED' | 'UPLOADED' | 'IMPORTED';
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  checksum: Sha256Hex | null;
  duration_ms: number | null;
  generation_job_id: Uuid | null;
  generation_prompt: string | null;
  provider: string;
  external_id: string;
}

export interface CreativeVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  concept_id: Uuid;
  campaign_id: Uuid;
  version: number;
  state: VersionState;
  base_asset_id: Uuid | null;
  render_spec: JsonObject;
  copy: MetaCopyJson;
  content_hash: Sha256Hex;
  review_state: AssetReviewState;
  approved_by: Uuid | null;
  approved_at: Timestamptz | null;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export interface CreativeRenditionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  creative_version_id: Uuid;
  aspect_ratio: AspectRatio;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  width: number;
  height: number;
  byte_size: number | null;
  checksum: Sha256Hex | null;
  render_duration_ms: number | null;
  renderer_version: string;
  meta_image_hash: string | null;
  meta_video_id: string | null;
}

/* -------------------------------------------------------------------------- */
/* Funnels                                                                     */
/* -------------------------------------------------------------------------- */

export interface ConsentVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  version: number;
  text_de: string;
  purposes: ConsentPurpose[];
  privacy_policy_url: string;
  effective_from: Timestamptz;
  effective_until: Timestamptz | null;
}

export interface FunnelRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  funnel_key: string;
  kind: FunnelKind;
  name: string;
  promise: string | null;
  hypothesis: string | null;
  rationale: string | null;
  current_version_id: Uuid | null;
  is_active: boolean;
}

export interface FunnelVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  funnel_id: Uuid;
  campaign_id: Uuid;
  version: number;
  state: VersionState;
  spec: JsonObject;
  content_hash: Sha256Hex;
  form_version_id: Uuid | null;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export interface FormDefinitionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  funnel_id: Uuid;
  form_key: string;
  name: string;
  current_version_id: Uuid | null;
}

/** `field_key -> classification`, denormalised from the spec for the writer. */
export interface FieldIndexEntry extends JsonObject {
  type: string;
  pii_class: 'PII' | 'QUALIFICATION' | 'OPERATIONAL';
  qualification_class: QualificationClass;
  step_key: string;
}

export interface FormVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  form_definition_id: Uuid;
  version: number;
  state: VersionState;
  spec: JsonObject;
  field_index: Record<string, FieldIndexEntry>;
  question_count: number;
  content_hash: Sha256Hex;
  consent_version_id: Uuid | null;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export interface PublishedFunnelRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  funnel_id: Uuid;
  funnel_version_id: Uuid;
  form_version_id: Uuid | null;
  experiment_id: Uuid | null;
  public_slug: string;
  path: string;
  is_live: boolean;
  environment: AppEnvironment;
  meta_pixel_id: string | null;
  meta_dataset_id: string | null;
  consent_version_id: Uuid | null;
  redirect_url: string | null;
  published_at: Timestamptz;
  unpublished_at: Timestamptz | null;
}

/** Shape returned by `public.get_published_funnel(slug)`. */
export interface PublishedFunnelBundle {
  published_funnel_id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid | null;
  funnel_id: Uuid;
  funnel_version_id: Uuid;
  funnel_kind: FunnelKind;
  funnel_spec: JsonObject;
  form_version_id: Uuid | null;
  form_spec: JsonObject | null;
  field_index: Record<string, FieldIndexEntry>;
  public_slug: string;
  path: string;
  environment: AppEnvironment;
  meta_pixel_id: string | null;
  meta_dataset_id: string | null;
  redirect_url: string | null;
  experiment_id: Uuid | null;
  consent: {
    consent_version_id: Uuid;
    version: number;
    text_de: string;
    purposes: ConsentPurpose[];
    privacy_policy_url: string;
  } | null;
  experiment: {
    experiment_id: Uuid;
    state: ExperimentState;
    assignment_salt: string;
    arms: Array<{
      arm_id: Uuid;
      key: string;
      label: string;
      is_control: boolean;
      allocation: number;
      funnel_version_id: Uuid | null;
      form_version_id: Uuid | null;
      creative_version_id: Uuid | null;
    }>;
  } | null;
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExperimentRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  kind: ExperimentKind;
  state: ExperimentState;
  name: string;
  hypothesis: string;
  test_variable: string;
  primary_metric: MetricKey;
  secondary_metrics: MetricKey[];
  guardrail_metrics: MetricKey[];
  thresholds: JsonObject;
  assignment_salt: string;
  bundled: boolean;
  eligibility_changing: boolean;
  verdict: ExperimentVerdict | null;
  winning_arm_id: Uuid | null;
  started_at: Timestamptz | null;
  paused_at: Timestamptz | null;
  concluded_at: Timestamptz | null;
}

export interface ExperimentArmRow {
  id: Uuid;
  workspace_id: Uuid;
  experiment_id: Uuid;
  key: string;
  label: string;
  is_control: boolean;
  allocation: number;
  creative_version_id: Uuid | null;
  funnel_version_id: Uuid | null;
  form_version_id: Uuid | null;
  published_funnel_id: Uuid | null;
  sort_order: number;
  created_at: Timestamptz;
  created_by: Uuid | null;
}

export interface ExperimentAssignmentRow {
  id: Uuid;
  workspace_id: Uuid;
  experiment_id: Uuid;
  visitor_id: Uuid;
  arm_id: Uuid;
  bucket: number;
  assigned_at: Timestamptz;
}

export interface ExperimentExposureRow {
  id: Uuid;
  workspace_id: Uuid;
  experiment_id: Uuid;
  visitor_id: Uuid;
  session_id: Uuid;
  arm_id: Uuid;
  exposed_at: Timestamptz;
}

export interface ExperimentResultRow {
  id: Uuid;
  workspace_id: Uuid;
  experiment_id: Uuid;
  computed_at: Timestamptz;
  primary_metric: MetricKey;
  verdict: ExperimentVerdict;
  winning_arm_id: Uuid | null;
  maturity: DataMaturity;
  arms: Json;
  reasons: string[];
  interpretation_warnings: string[];
  runtime_days: number;
  total_sessions: number;
  total_conversions: number;
  thresholds: JsonObject;
  created_at: Timestamptz;
}

/* -------------------------------------------------------------------------- */
/* Tracking, submissions, leads                                                */
/* -------------------------------------------------------------------------- */

export interface VisitorRow {
  id: Uuid;
  workspace_id: Uuid;
  first_seen_at: Timestamptz;
  last_seen_at: Timestamptz;
  traffic_kind: TrafficKind;
  consent_status: ConsentStatus;
  session_count: number;
  created_at: Timestamptz;
}

/** Marketing parameters observed on the landing URL. Untrusted, reporting only. */
export interface MarketingParamColumns {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  fbc: string | null;
  fbp: string | null;
  meta_campaign_id: string | null;
  meta_adset_id: string | null;
  meta_ad_id: string | null;
}

/** Internal ids resolved from the signed launch token. Trusted. */
export interface TrackingContextColumns {
  campaign_id: Uuid | null;
  campaign_version_id: Uuid | null;
  angle_id: Uuid | null;
  angle_version_id: Uuid | null;
  offer_id: Uuid | null;
  offer_version_id: Uuid | null;
  creative_id: Uuid | null;
  creative_version_id: Uuid | null;
  funnel_id: Uuid | null;
  funnel_version_id: Uuid | null;
  form_id: Uuid | null;
  form_version_id: Uuid | null;
  experiment_id: Uuid | null;
  experiment_arm_id: Uuid | null;
}

export interface SessionRow extends MarketingParamColumns {
  id: Uuid;
  workspace_id: Uuid;
  visitor_id: Uuid;
  started_at: Timestamptz;
  last_activity_at: Timestamptz;
  ended_at: Timestamptz | null;
  environment: AppEnvironment;
  traffic_kind: TrafficKind;
  consent_status: ConsentStatus;
  channel: Channel;
  landing_url: string | null;
  referrer: string | null;
  published_funnel_id: Uuid | null;
  funnel_version_id: Uuid | null;
  campaign_id: Uuid | null;
  experiment_id: Uuid | null;
  experiment_arm_id: Uuid | null;
  device_bucket: 'MOBILE' | 'TABLET' | 'DESKTOP' | 'UNKNOWN' | null;
  event_count: number;
  created_at: Timestamptz;
}

export interface TouchpointRow extends MarketingParamColumns, TrackingContextColumns {
  id: Uuid;
  workspace_id: Uuid;
  visitor_id: Uuid;
  session_id: Uuid;
  occurred_at: Timestamptz;
  channel: Channel;
  role: TouchRole;
  confidence: AttributionConfidence;
  from_signed_token: boolean;
  referrer: string | null;
  landing_url: string | null;
  created_at: Timestamptz;
}

export interface EventRow extends MarketingParamColumns, TrackingContextColumns {
  id: Uuid;
  workspace_id: Uuid;
  event_type: EventType;
  event_schema_version: number;
  occurred_at: Timestamptz;
  received_at: Timestamptz;
  environment: AppEnvironment;
  traffic_kind: TrafficKind;
  visitor_id: Uuid;
  session_id: Uuid;
  form_instance_id: Uuid | null;
  submission_id: Uuid | null;
  step_id: string | null;
  field_id: string | null;
  error_code: ValidationErrorCode | null;
  consent_status: ConsentStatus;
  referrer: string | null;
  landing_url: string | null;
  metadata: Record<string, string | number | boolean>;
}

export interface FormInstanceRow {
  id: Uuid;
  workspace_id: Uuid;
  published_funnel_id: Uuid | null;
  funnel_version_id: Uuid | null;
  form_version_id: Uuid | null;
  visitor_id: Uuid;
  session_id: Uuid;
  campaign_id: Uuid | null;
  experiment_id: Uuid | null;
  experiment_arm_id: Uuid | null;
  started_at: Timestamptz;
  last_activity_at: Timestamptz;
  completed_at: Timestamptz | null;
  abandoned_at: Timestamptz | null;
  current_step_key: string | null;
  steps_completed: number;
  step_count: number;
  environment: AppEnvironment;
  traffic_kind: TrafficKind;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface FormSubmissionRow {
  id: Uuid;
  workspace_id: Uuid;
  submission_attempt_id: Uuid;
  form_instance_id: Uuid | null;
  form_version_id: Uuid | null;
  funnel_version_id: Uuid | null;
  published_funnel_id: Uuid | null;
  campaign_id: Uuid | null;
  experiment_id: Uuid | null;
  experiment_arm_id: Uuid | null;
  visitor_id: Uuid | null;
  session_id: Uuid | null;
  state: SubmissionState;
  submitted_at: Timestamptz;
  accepted_at: Timestamptz | null;
  environment: AppEnvironment;
  traffic_kind: TrafficKind;
  consent_version_id: Uuid | null;
  consent_status: ConsentStatus;
  consent_purposes: ConsentPurpose[];
  consent_text_hash: Sha256Hex | null;
  spam_score: number | null;
  spam_reason: string | null;
  validation_error_codes: ValidationErrorCode[];
  answers_hash: Sha256Hex | null;
  attribution_snapshot_id: Uuid | null;
  lead_id: Uuid | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

/** Field types that may legally appear in `submission_answers_non_pii`. */
export type NonPiiFieldType =
  | 'SINGLE_SELECT'
  | 'MULTI_SELECT'
  | 'BOOLEAN'
  | 'NUMBER'
  | 'RANGE'
  | 'SHORT_TEXT'
  | 'LONG_TEXT'
  | 'POSTCODE'
  | 'CONSENT';

export interface SubmissionAnswerRow {
  id: Uuid;
  workspace_id: Uuid;
  submission_id: Uuid;
  field_key: string;
  step_key: string | null;
  field_type: NonPiiFieldType;
  pii_class: 'QUALIFICATION' | 'OPERATIONAL';
  qualification_class: QualificationClass;
  value_text: string | null;
  value_number: number | null;
  value_bool: boolean | null;
  value_options: string[] | null;
  score_contribution: number | null;
  created_at: Timestamptz;
}

export interface SubmissionPiiRow {
  id: Uuid;
  workspace_id: Uuid;
  submission_id: Uuid;
  algorithm: 'AES-256-GCM';
  key_version: number;
  /** base64 at the boundary; `bytea` in the database. */
  iv: string;
  auth_tag: string;
  ciphertext: string;
  email_hash: Sha256Hex | null;
  phone_hash: Sha256Hex | null;
  email_domain: string | null;
  purged_at: Timestamptz | null;
  created_at: Timestamptz;
}

export interface SubmissionStatusHistoryRow {
  id: Uuid;
  workspace_id: Uuid;
  submission_id: Uuid;
  from_state: SubmissionState | null;
  to_state: SubmissionState;
  occurred_at: Timestamptz;
  reason_de: string | null;
  actor_label: string;
  correlation_id: string | null;
  created_at: Timestamptz;
}

export interface AttributionSnapshotRow extends MarketingParamColumns, TrackingContextColumns {
  id: Uuid;
  workspace_id: Uuid;
  submission_id: Uuid;
  frozen: boolean;
  first_touch: Json;
  last_touch: Json;
  acquisition_touch: Json;
  influenced_touch_ids: Uuid[];
  referrer: string | null;
  landing_url: string | null;
  channel: Channel;
  level: AttributionLevel;
  confidence: AttributionConfidence;
  consent_status: ConsentStatus;
  days_to_conversion: number | null;
  window_days: number;
  created_at: Timestamptz;
}

export interface LeadRow {
  id: Uuid;
  workspace_id: Uuid;
  am_person_id: Uuid;
  submission_id: Uuid;
  campaign_id: Uuid | null;
  hubspot_contact_id: string | null;
  hubspot_company_id: string | null;
  sync_status: SyncStatus;
  vq_status: VqStatus;
  vq_score: number | null;
  vq_reason_codes: string[];
  vq_model_version: string | null;
  vq_evaluated_at: Timestamptz | null;
  vq_scheduled_at: Timestamptz | null;
  vq_occurred_at: Timestamptz | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface OpportunityRow {
  id: Uuid;
  workspace_id: Uuid;
  am_opportunity_id: Uuid;
  am_person_id: Uuid;
  lead_id: Uuid | null;
  acquisition_submission_id: Uuid;
  acquisition_snapshot_id: Uuid;
  campaign_id: Uuid | null;
  hubspot_deal_id: string | null;
  pipeline: string | null;
  stage: string | null;
  amount_minor: number | null;
  currency: string | null;
  closed_won_at: Timestamptz | null;
  closed_lost_at: Timestamptz | null;
  closed_lost_reason: string | null;
  sync_status: SyncStatus;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface LeadStageEventRow {
  id: Uuid;
  workspace_id: Uuid;
  lead_id: Uuid | null;
  opportunity_id: Uuid | null;
  submission_id: Uuid | null;
  campaign_id: Uuid | null;
  type: SalesEventType;
  occurred_at: Timestamptz;
  recorded_at: Timestamptz;
  source_object: 'CONTACT' | 'DEAL' | 'INTERNAL' | 'WEBHOOK';
  hubspot_object_id: string | null;
  previous_state: string | null;
  new_state: string;
  mapping_version: number | null;
  source_event_id: string | null;
  attribution_snapshot_id: Uuid | null;
  amount_minor: number | null;
  currency: string | null;
  created_at: Timestamptz;
}

export interface RevenueEventRow {
  id: Uuid;
  workspace_id: Uuid;
  opportunity_id: Uuid;
  campaign_id: Uuid | null;
  occurred_at: Timestamptz;
  amount_minor: number;
  currency: string;
  kind: 'BOOKED' | 'RECOGNIZED' | 'ADJUSTMENT';
  reconciliation_delta_minor: number | null;
  source_event_id: string;
  created_at: Timestamptz;
}

/* -------------------------------------------------------------------------- */
/* Meta                                                                        */
/* -------------------------------------------------------------------------- */

export interface MetaAccountRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  provider: 'META';
  external_id: string;
  name: string;
  currency: string;
  timezone: string;
  business_id: string | null;
  page_id: string | null;
  instagram_actor_id: string | null;
  pixel_id: string | null;
  dataset_id: string | null;
  account_status: string | null;
  is_primary: boolean;
  connection_id: Uuid | null;
  last_imported_at: Timestamptz | null;
  raw: JsonObject;
}

export interface MetaCampaignRow {
  id: Uuid;
  workspace_id: Uuid;
  meta_account_id: Uuid;
  provider: 'META';
  external_id: string;
  campaign_id: Uuid | null;
  name: string;
  objective: string | null;
  status: MetaEntityStatus;
  effective_status: string | null;
  buying_type: string | null;
  daily_budget_minor: number | null;
  lifetime_budget_minor: number | null;
  currency: string;
  start_time: Timestamptz | null;
  stop_time: Timestamptz | null;
  provider_created_time: Timestamptz | null;
  provider_updated_time: Timestamptz | null;
  raw: JsonObject;
  imported_at: Timestamptz;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface MetaAdSetRow {
  id: Uuid;
  workspace_id: Uuid;
  meta_campaign_id: Uuid;
  provider: 'META';
  external_id: string;
  name: string;
  status: MetaEntityStatus;
  effective_status: string | null;
  optimization_goal: string | null;
  billing_event: string | null;
  bid_strategy: string | null;
  daily_budget_minor: number | null;
  lifetime_budget_minor: number | null;
  targeting: JsonObject;
  start_time: Timestamptz | null;
  end_time: Timestamptz | null;
  experiment_arm_id: Uuid | null;
  raw: JsonObject;
  imported_at: Timestamptz;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface MetaCreativeRow {
  id: Uuid;
  workspace_id: Uuid;
  meta_account_id: Uuid;
  provider: 'META';
  external_id: string;
  name: string | null;
  creative_version_id: Uuid | null;
  creative_rendition_id: Uuid | null;
  object_story_spec: JsonObject;
  image_hash: string | null;
  video_id: string | null;
  thumbnail_url: string | null;
  title: string | null;
  body: string | null;
  call_to_action_type: string | null;
  link_url: string | null;
  raw: JsonObject;
  imported_at: Timestamptz;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface MetaAdRow {
  id: Uuid;
  workspace_id: Uuid;
  meta_adset_id: Uuid;
  meta_creative_id: Uuid | null;
  provider: 'META';
  external_id: string;
  name: string;
  status: MetaEntityStatus;
  effective_status: string | null;
  creative_version_id: Uuid | null;
  tracking_specs: Json;
  raw: JsonObject;
  imported_at: Timestamptz;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface MetaInsightsDailyRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: 'META';
  level: 'ACCOUNT' | 'CAMPAIGN' | 'ADSET' | 'AD';
  entity_external_id: string;
  meta_account_id: Uuid | null;
  meta_campaign_id: Uuid | null;
  meta_adset_id: Uuid | null;
  meta_ad_id: Uuid | null;
  campaign_id: Uuid | null;
  date_start: DateOnly;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  spend_minor: number;
  currency: string;
  frequency: number | null;
  cpm_minor: number | null;
  cpc_minor: number | null;
  ctr: number | null;
  video_views: number;
  actions: Json;
  action_values: Json;
  raw: JsonObject;
  imported_at: Timestamptz;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface CapiDispatchRow {
  id: Uuid;
  workspace_id: Uuid;
  outbox_event_id: Uuid | null;
  dataset_id: string;
  event_name: string;
  event_id: string;
  capi_stage: CapiStage;
  event_time: Timestamptz;
  action_source: string;
  submission_id: Uuid | null;
  lead_id: Uuid | null;
  opportunity_id: Uuid | null;
  campaign_id: Uuid | null;
  test_event_code: string | null;
  request_hash: Sha256Hex;
  state: OutboxState;
  events_received: number | null;
  fbtrace_id: string | null;
  response_redacted: Json;
  error: string | null;
  dispatched_at: Timestamptz | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface ExternalCommandRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  kind: MetaCommandKind;
  idempotency_key: string;
  state: CommandState;
  campaign_id: Uuid | null;
  recommendation_id: Uuid | null;
  target_level: 'CAMPAIGN' | 'ADSET' | 'AD' | null;
  target_external_id: string | null;
  request_preview: JsonObject;
  provider_response_redacted: Json;
  error: string | null;
  attempt_count: number;
  requested_by: Uuid | null;
  requested_at: Timestamptz;
  confirmed_at: Timestamptz | null;
  reconciled_at: Timestamptz | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

/* -------------------------------------------------------------------------- */
/* HubSpot                                                                     */
/* -------------------------------------------------------------------------- */

export type HubspotObjectType = 'CONTACT' | 'COMPANY' | 'DEAL';

export interface HubspotMappingRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  object_type: HubspotObjectType;
  version: number;
  state: VersionState;
  field_map: JsonObject;
  stage_map: JsonObject;
  pipeline_id: string | null;
  pipeline_label: string | null;
  required_fields: string[];
  missing_fields: string[];
  content_hash: Sha256Hex;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export interface HubspotObjectRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: 'HUBSPOT';
  external_id: string;
  object_type: HubspotObjectType;
  am_person_id: Uuid | null;
  lead_id: Uuid | null;
  opportunity_id: Uuid | null;
  properties_redacted: JsonObject;
  pipeline: string | null;
  stage: string | null;
  amount_minor: number | null;
  currency: string | null;
  archived: boolean;
  last_synced_at: Timestamptz | null;
  provider_updated_at: Timestamptz | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface HubspotSyncAttemptRow {
  id: Uuid;
  workspace_id: Uuid;
  outbox_event_id: Uuid | null;
  submission_id: Uuid | null;
  lead_id: Uuid | null;
  opportunity_id: Uuid | null;
  object_type: HubspotObjectType;
  operation: 'CREATE' | 'UPDATE' | 'ASSOCIATE' | 'SEARCH' | 'TEST_LEAD';
  attempt_number: number;
  status: SyncStatus;
  mapping_version: number | null;
  request_hash: Sha256Hex | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  response_redacted: Json;
  started_at: Timestamptz;
  finished_at: Timestamptz | null;
  duration_ms: number | null;
  next_attempt_at: Timestamptz | null;
  created_at: Timestamptz;
}

export interface HubspotStageHistoryRow {
  id: Uuid;
  workspace_id: Uuid;
  hubspot_object_id: Uuid | null;
  external_id: string;
  object_type: HubspotObjectType;
  pipeline: string | null;
  from_stage: string | null;
  to_stage: string;
  occurred_at: Timestamptz;
  observed_at: Timestamptz;
  source: 'POLL' | 'WEBHOOK' | 'MANUAL';
  source_event_id: string | null;
  mapping_version: number | null;
  lead_stage_event_id: Uuid | null;
  created_at: Timestamptz;
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface IntegrationConnectionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  state: ConnectionState;
  account_label: string | null;
  external_account_id: string | null;
  granted_scopes: string[];
  credentials_ciphertext: string | null;
  credentials_iv: string | null;
  credentials_auth_tag: string | null;
  key_version: number | null;
  connected_at: Timestamptz | null;
  expires_at: Timestamptz | null;
  last_checked_at: Timestamptz | null;
  last_error: string | null;
}

export interface IntegrationHealthCheckRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  key: string;
  label_de: string;
  status: HealthStatus;
  detail_de: string | null;
  remediation_de: string | null;
  blocks_live_only: boolean;
  checked_at: Timestamptz;
  created_at: Timestamptz;
}

export interface SyncCursorRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  resource: string;
  cursor_value: string | null;
  cursor_time: Timestamptz | null;
  last_run_at: Timestamptz | null;
  last_success_at: Timestamptz | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export type SyncJobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface SyncJobRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  kind: string;
  state: SyncJobState;
  scheduled_for: Timestamptz;
  started_at: Timestamptz | null;
  finished_at: Timestamptz | null;
  attempt_count: number;
  records_processed: number;
  records_failed: number;
  params: JsonObject;
  result: Json;
  error: string | null;
  idempotency_key: string;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface RawExternalObjectRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  object_type: string;
  external_id: string;
  payload: JsonObject;
  payload_hash: Sha256Hex;
  fetched_at: Timestamptz;
  version_count: number;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface PromptVersionRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  key: string;
  version: number;
  state: VersionState;
  template: string;
  system_prompt: string | null;
  model: string;
  output_schema: JsonObject;
  temperature: number | null;
  max_tokens: number | null;
  notes: string | null;
  content_hash: Sha256Hex;
  published_at: Timestamptz | null;
  published_by: Uuid | null;
  archived_at: Timestamptz | null;
}

export type AiJobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED';

export interface AiJobRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid | null;
  kind: string;
  state: AiJobState;
  prompt_version_id: Uuid | null;
  model: string;
  input_hash: Sha256Hex | null;
  input_redacted: JsonObject;
  output: Json;
  output_valid: boolean | null;
  validation_errors: Json;
  token_input: number | null;
  token_output: number | null;
  cost_minor: number | null;
  latency_ms: number | null;
  attempt_count: number;
  started_at: Timestamptz | null;
  finished_at: Timestamptz | null;
  error: string | null;
  idempotency_key: string;
}

export interface RecommendationRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid;
  experiment_id: Uuid | null;
  action: RecommendationActionKind;
  state: RecommendationState;
  rule_id: string;
  dedup_key: string;
  title_de: string;
  summary_de: string;
  explanation_de: string | null;
  next_hypothesis_de: string | null;
  facts: Json;
  comparison_basis_de: string;
  maturity: DataMaturity;
  attribution_coverage: number | null;
  uncertainty_de: string;
  risk: RiskLevel;
  risk_note_de: string | null;
  affected_meta_objects: Json;
  proposed_budget_change_pct: number | null;
  superseded_by: Uuid | null;
}

export type RecommendationActionKindRow =
  | 'ACCEPTED'
  | 'DISMISSED'
  | 'EXECUTION_STARTED'
  | 'EXECUTED'
  | 'EXECUTION_FAILED'
  | 'SUPERSEDED';

export interface RecommendationActionRow {
  id: Uuid;
  workspace_id: Uuid;
  recommendation_id: Uuid;
  action: RecommendationActionKindRow;
  external_command_id: Uuid | null;
  command_state: CommandState | null;
  actor_id: Uuid | null;
  actor_label: string;
  note_de: string | null;
  executed_at: Timestamptz | null;
  provider_confirmed_at: Timestamptz | null;
  error: string | null;
  created_at: Timestamptz;
}

export interface LearningCardRow extends AuditColumns {
  id: Uuid;
  workspace_id: Uuid;
  version: number;
  campaign_id: Uuid | null;
  experiment_id: Uuid | null;
  title_de: string;
  what_was_tested_de: string;
  angle_id: Uuid | null;
  angle_name: string | null;
  offer_id: Uuid | null;
  offer_name: string | null;
  creative_concept_de: string | null;
  funnel_kind: FunnelKind | null;
  audience_de: string | null;
  period_start: Timestamptz | null;
  period_end: Timestamptz | null;
  spend_minor: number;
  currency: string;
  outcome_de: string;
  outcome_facts: Json;
  data_maturity: DataMaturity;
  attribution_level: AttributionLevel;
  attribution_coverage: number | null;
  possible_explanation_de: string | null;
  suggested_next_test_de: string | null;
  confidence: ConfidenceLabel;
  superseded_by: Uuid | null;
}

export interface OutboxEventRow {
  id: Uuid;
  workspace_id: Uuid;
  destination: OutboxDestination;
  event_id: string;
  /** Never null: a nullable column would make the dedup constraint permissive. */
  dataset_id: string;
  event_name: string;
  event_time: Timestamptz;
  payload: JsonObject;
  payload_hash: Sha256Hex;
  status: OutboxState;
  attempt_count: number;
  next_attempt_at: Timestamptz | null;
  last_error: string | null;
  provider_response_redacted: Json;
  sent_at: Timestamptz | null;
  locked_at: Timestamptz | null;
  locked_by: string | null;
  campaign_id: Uuid | null;
  submission_id: Uuid | null;
  lead_id: Uuid | null;
  opportunity_id: Uuid | null;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface WebhookEventRow {
  id: Uuid;
  workspace_id: Uuid;
  provider: Provider;
  event_kind: string;
  external_event_id: string;
  signature_valid: boolean;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  payload: JsonObject;
  payload_hash: Sha256Hex;
  received_at: Timestamptz;
  processed_at: Timestamptz | null;
  error: string | null;
  retry_count: number;
  created_at: Timestamptz;
}

/**
 * One day × one dimension combination. Dashboards read these instead of
 * aggregating raw events on every request (spec §33).
 */
export interface PerformanceRollupRow {
  id: Uuid;
  workspace_id: Uuid;
  day: DateOnly;

  campaign_id: Uuid | null;
  campaign_version_id: Uuid | null;
  creative_version_id: Uuid | null;
  funnel_version_id: Uuid | null;
  experiment_id: Uuid | null;
  experiment_arm_id: Uuid | null;
  /** Generated in the database from the six dimensions. Never written by hand. */
  dimension_key: string;

  impressions: number;
  reach: number;
  link_clicks: number;
  spend_minor: number;
  currency: string;

  funnel_sessions: number;
  form_views: number;
  form_starts: number;
  step_completions: number;
  validation_failures: number;
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

  attribution_coverage: number | null;
  data_maturity: DataMaturity;
  /** Always `PRODUCTION`: preview, internal, bot and test traffic never roll up. */
  traffic_scope: 'PRODUCTION';

  source_max_at: Timestamptz | null;
  computed_at: Timestamptz;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface JobLockRow {
  key: string;
  holder: string;
  acquired_at: Timestamptz;
  expires_at: Timestamptz;
  acquire_count: number;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

export interface AuditLogRow {
  id: Uuid;
  workspace_id: Uuid;
  action: AuditAction;
  occurred_at: Timestamptz;
  actor_id: Uuid | null;
  actor_label: string;
  entity_type: string;
  entity_id: string;
  campaign_id: Uuid | null;
  summary_de: string;
  before: Json;
  after: Json;
  correlation_id: string | null;
  created_at: Timestamptz;
}

/* -------------------------------------------------------------------------- */
/* Insert / update aliases                                                     */
/* -------------------------------------------------------------------------- */

export type CampaignInsert = Insertable<
  CampaignRow,
  | 'state'
  | 'currency'
  | 'daily_budget_minor'
  | 'test_budget_minor'
  | 'secondary_metrics'
  | 'guardrail_metrics'
  | 'attribution_level'
  | 'tags'
>;
export type CampaignUpdate = Updatable<CampaignRow>;

export type CampaignVersionInsert = Insertable<CampaignVersionRow, 'state'>;
export type CampaignProposalInsert = Insertable<
  CampaignProposalRow,
  'model' | 'generation_index' | 'similar_campaigns' | 'accepted'
>;
export type ApprovalInsert = Insertable<ApprovalRow, 'state'>;

export type AngleInsert = Insertable<AngleRow, 'rationale' | 'keywords' | 'use_count'>;
export type AngleVersionInsert = Insertable<AngleVersionRow, 'state'>;

export type CreativeConceptInsert = Insertable<
  CreativeConceptRow,
  'aspect_ratios' | 'claims' | 'review_state' | 'sort_order'
>;
export type CreativeAssetInsert = Insertable<
  CreativeAssetRow,
  'media_kind' | 'source' | 'mime_type' | 'provider' | 'external_id'
>;
export type CreativeVersionInsert = Insertable<CreativeVersionRow, 'state' | 'review_state'>;
export type CreativeRenditionInsert = Insertable<
  CreativeRenditionRow,
  'storage_bucket' | 'mime_type' | 'renderer_version'
>;

export type FunnelInsert = Insertable<FunnelRow, 'is_active'>;
export type FunnelVersionInsert = Insertable<FunnelVersionRow, 'state'>;
export type FormDefinitionInsert = Insertable<FormDefinitionRow>;
export type FormVersionInsert = Insertable<FormVersionRow, 'state' | 'field_index' | 'question_count'>;
export type PublishedFunnelInsert = Insertable<
  PublishedFunnelRow,
  'path' | 'is_live' | 'environment' | 'published_at'
>;
export type ConsentVersionInsert = Insertable<ConsentVersionRow, 'effective_from'>;

export type ExperimentInsert = Insertable<
  ExperimentRow,
  'state' | 'secondary_metrics' | 'guardrail_metrics' | 'bundled' | 'eligibility_changing'
>;
export type ExperimentArmInsert = Insertable<ExperimentArmRow, 'is_control' | 'sort_order'>;
export type ExperimentResultInsert = Insertable<
  ExperimentResultRow,
  'computed_at' | 'arms' | 'reasons' | 'interpretation_warnings' | 'runtime_days' | 'total_sessions' | 'total_conversions'
>;

export type LeadInsert = Insertable<LeadRow, 'sync_status' | 'vq_status' | 'vq_reason_codes'>;
export type OpportunityInsert = Insertable<OpportunityRow, 'sync_status'>;
export type LeadStageEventInsert = Insertable<LeadStageEventRow, 'recorded_at' | 'source_object'>;
export type RevenueEventInsert = Insertable<RevenueEventRow, 'source_event_id'>;
export type TouchpointInsert = Insertable<TouchpointRow, 'from_signed_token' | 'occurred_at'>;

export type MetaAccountInsert = Insertable<
  MetaAccountRow,
  'provider' | 'currency' | 'timezone' | 'is_primary' | 'raw'
>;
export type MetaCampaignInsert = Insertable<
  MetaCampaignRow,
  'provider' | 'status' | 'currency' | 'raw' | 'imported_at'
>;
export type MetaAdSetInsert = Insertable<
  MetaAdSetRow,
  'provider' | 'status' | 'targeting' | 'raw' | 'imported_at'
>;
export type MetaCreativeInsert = Insertable<
  MetaCreativeRow,
  'provider' | 'object_story_spec' | 'raw' | 'imported_at'
>;
export type MetaAdInsert = Insertable<MetaAdRow, 'provider' | 'status' | 'tracking_specs' | 'raw' | 'imported_at'>;
export type MetaInsightsDailyInsert = Insertable<
  MetaInsightsDailyRow,
  | 'provider'
  | 'impressions'
  | 'reach'
  | 'clicks'
  | 'link_clicks'
  | 'spend_minor'
  | 'currency'
  | 'video_views'
  | 'actions'
  | 'action_values'
  | 'raw'
  | 'imported_at'
>;
export type CapiDispatchInsert = Insertable<CapiDispatchRow, 'state' | 'action_source'>;
export type ExternalCommandInsert = Insertable<
  ExternalCommandRow,
  'state' | 'request_preview' | 'attempt_count' | 'requested_at'
>;

export type HubspotMappingInsert = Insertable<
  HubspotMappingRow,
  'state' | 'field_map' | 'stage_map' | 'required_fields' | 'missing_fields'
>;
export type HubspotObjectInsert = Insertable<
  HubspotObjectRow,
  'provider' | 'properties_redacted' | 'archived'
>;
export type HubspotSyncAttemptInsert = Insertable<
  HubspotSyncAttemptRow,
  'attempt_number' | 'started_at'
>;
export type HubspotStageHistoryInsert = Insertable<HubspotStageHistoryRow, 'observed_at' | 'source'>;

export type IntegrationConnectionInsert = Insertable<
  IntegrationConnectionRow,
  'state' | 'granted_scopes'
>;
export type IntegrationHealthCheckInsert = Insertable<
  IntegrationHealthCheckRow,
  'blocks_live_only' | 'checked_at'
>;
export type SyncJobInsert = Insertable<
  SyncJobRow,
  'state' | 'scheduled_for' | 'attempt_count' | 'records_processed' | 'records_failed' | 'params'
>;
export type RecommendationInsert = Insertable<
  RecommendationRow,
  'state' | 'facts' | 'affected_meta_objects'
>;
export type RecommendationActionInsert = Insertable<RecommendationActionRow, 'actor_label'>;
export type LearningCardInsert = Insertable<
  LearningCardRow,
  'version' | 'spend_minor' | 'currency' | 'outcome_facts'
>;
export type AuditLogInsert = Insertable<AuditLogRow, 'occurred_at'>;
export type OutboxEventInsert = Insertable<
  OutboxEventRow,
  'dataset_id' | 'payload' | 'status' | 'attempt_count'
>;
/**
 * `dimension_key` is generated by the database and `traffic_scope` is fixed, so
 * neither is writable; every counter defaults to zero.
 */
export type PerformanceRollupInsert = Insertable<
  Omit<PerformanceRollupRow, 'dimension_key' | 'traffic_scope'>,
  | 'currency'
  | 'impressions'
  | 'reach'
  | 'link_clicks'
  | 'spend_minor'
  | 'funnel_sessions'
  | 'form_views'
  | 'form_starts'
  | 'step_completions'
  | 'validation_failures'
  | 'submissions'
  | 'leads'
  | 'vq_scheduled'
  | 'vq_attended'
  | 'vq_no_show'
  | 'qualified_vq'
  | 'opportunities'
  | 'closed_won'
  | 'closed_lost'
  | 'revenue_minor'
  | 'data_maturity'
  | 'computed_at'
>;

export type PromptVersionInsert = Insertable<PromptVersionRow, 'state' | 'output_schema'>;
export type AiJobInsert = Insertable<AiJobRow, 'state' | 'model' | 'input_redacted' | 'attempt_count'>;
