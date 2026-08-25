import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Campaign lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Business states of a campaign. Error states are tracked separately on
 * `campaigns.error_state` so that a provider failure never destroys the last
 * successful business state (spec §10).
 */
export const CAMPAIGN_STATES = [
  'IDEA',
  'PROPOSED',
  'STRATEGY_REVIEW',
  'STRATEGY_APPROVED',
  'ASSET_GENERATION',
  'ASSET_REVIEW',
  'TEST_PLAN_REVIEW',
  'READY_FOR_LAUNCH_QA',
  'READY_FOR_META_DRAFT',
  'META_DRAFT_CREATED',
  'SCHEDULED',
  'LIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
] as const;
export const campaignStateSchema = z.enum(CAMPAIGN_STATES);
export type CampaignState = z.infer<typeof campaignStateSchema>;

export const CAMPAIGN_ERROR_STATES = [
  'GENERATION_FAILED',
  'PUBLISH_FAILED',
  'META_SYNC_FAILED',
  'TRACKING_FAILED',
  'HUBSPOT_SYNC_FAILED',
] as const;
export const campaignErrorStateSchema = z.enum(CAMPAIGN_ERROR_STATES);
export type CampaignErrorState = z.infer<typeof campaignErrorStateSchema>;

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

export const APPROVAL_KINDS = [
  'STRATEGY',
  'ASSETS',
  'TEST_PLAN',
  'PUBLISH',
  'BUDGET_SCALE',
  'MAJOR_CHANGE',
] as const;
export const approvalKindSchema = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const APPROVAL_STATES = ['PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED'] as const;
export const approvalStateSchema = z.enum(APPROVAL_STATES);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

/* -------------------------------------------------------------------------- */
/* Funnels                                                                     */
/* -------------------------------------------------------------------------- */

export const FUNNEL_KINDS = ['LANDING_PAGE', 'MULTI_STEP_FORM', 'HYBRID'] as const;
export const funnelKindSchema = z.enum(FUNNEL_KINDS);
export type FunnelKind = z.infer<typeof funnelKindSchema>;

export const FUNNEL_VERSION_STATES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const funnelVersionStateSchema = z.enum(FUNNEL_VERSION_STATES);
export type FunnelVersionState = z.infer<typeof funnelVersionStateSchema>;

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

export const FIELD_TYPES = [
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
  'NUMBER',
  'RANGE',
  'SHORT_TEXT',
  'LONG_TEXT',
  'POSTCODE',
  'EMAIL',
  'PHONE',
  'FIRST_NAME',
  'LAST_NAME',
  'CONSENT',
] as const;
export const fieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof fieldTypeSchema>;

/** Data classification. Drives storage location, logging and export rules. */
export const PII_CLASSES = ['PII', 'QUALIFICATION', 'OPERATIONAL'] as const;
export const piiClassSchema = z.enum(PII_CLASSES);
export type PiiClass = z.infer<typeof piiClassSchema>;

/** Field types that always carry personal data, regardless of configuration. */
export const INHERENTLY_PII_FIELD_TYPES: readonly FieldType[] = [
  'EMAIL',
  'PHONE',
  'FIRST_NAME',
  'LAST_NAME',
];

export const QUALIFICATION_CLASSES = [
  'NONE',
  'SCORING',
  'DISQUALIFYING',
  'ROUTING_ONLY',
] as const;
export const qualificationClassSchema = z.enum(QUALIFICATION_CLASSES);
export type QualificationClass = z.infer<typeof qualificationClassSchema>;

export const CONDITION_OPERATORS = [
  'EQUALS',
  'NOT_EQUALS',
  'IN',
  'NOT_IN',
  'GREATER_THAN',
  'LESS_THAN',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
] as const;
export const conditionOperatorSchema = z.enum(CONDITION_OPERATORS);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

/* -------------------------------------------------------------------------- */
/* Submissions                                                                 */
/* -------------------------------------------------------------------------- */

export const SUBMISSION_STATES = [
  'CREATED',
  'VALIDATED',
  'ACCEPTED',
  'HUBSPOT_PENDING',
  'HUBSPOT_SYNCED',
  'REJECTED_VALIDATION',
  'REJECTED_SPAM',
  'SYNC_FAILED_RETRYING',
  'DEAD_LETTER',
] as const;
export const submissionStateSchema = z.enum(SUBMISSION_STATES);
export type SubmissionState = z.infer<typeof submissionStateSchema>;

export const TERMINAL_SUBMISSION_STATES: readonly SubmissionState[] = [
  'HUBSPOT_SYNCED',
  'REJECTED_VALIDATION',
  'REJECTED_SPAM',
  'DEAD_LETTER',
];

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

export const ATTRIBUTION_LEVELS = [
  'CREATIVE_ONLY',
  'TRAFFIC_LINKED',
  'LEAD_LINKED',
  'REVENUE_LINKED',
] as const;
export const attributionLevelSchema = z.enum(ATTRIBUTION_LEVELS);
export type AttributionLevel = z.infer<typeof attributionLevelSchema>;

export const ATTRIBUTION_CONFIDENCES = [
  'EXACT',
  'HIGH_CONFIDENCE',
  'MEDIUM_CONFIDENCE',
  'LOW_CONFIDENCE',
  'UNKNOWN',
] as const;
export const attributionConfidenceSchema = z.enum(ATTRIBUTION_CONFIDENCES);
export type AttributionConfidence = z.infer<typeof attributionConfidenceSchema>;

export const TOUCH_ROLES = ['FIRST', 'LAST', 'ACQUISITION', 'INFLUENCED'] as const;
export const touchRoleSchema = z.enum(TOUCH_ROLES);
export type TouchRole = z.infer<typeof touchRoleSchema>;

export const CHANNELS = [
  'META_PAID',
  'GOOGLE_PAID',
  'ORGANIC_SEARCH',
  'ORGANIC_SOCIAL',
  'REFERRAL',
  'EMAIL',
  'DIRECT',
  'UNKNOWN',
] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;

/* -------------------------------------------------------------------------- */
/* Evidence and confidence                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How strongly a learning or claim is supported. The AI layer may never label
 * something FACT on its own — that requires a computed, sufficiently mature
 * dataset or an approved evidence item.
 */
export const CONFIDENCE_LABELS = ['FACT', 'INDICATION', 'HYPOTHESIS'] as const;
export const confidenceLabelSchema = z.enum(CONFIDENCE_LABELS);
export type ConfidenceLabel = z.infer<typeof confidenceLabelSchema>;

export const EVIDENCE_KINDS = [
  'HISTORICAL_PERFORMANCE',
  'CUSTOMER_PROOF',
  'CASE_STUDY',
  'APPROVED_FACT',
  'APPROVED_STATISTIC',
  'TESTIMONIAL',
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

export const EXPERIMENT_KINDS = [
  'CREATIVE_EXPLORATION',
  'FUNNEL_EXPERIMENT',
  'BUNDLED_FUNNEL_TEST',
] as const;
export const experimentKindSchema = z.enum(EXPERIMENT_KINDS);
export type ExperimentKind = z.infer<typeof experimentKindSchema>;

export const EXPERIMENT_STATES = [
  'DRAFT',
  'READY',
  'RUNNING',
  'PAUSED',
  'CONCLUDED',
  'ABANDONED',
] as const;
export const experimentStateSchema = z.enum(EXPERIMENT_STATES);
export type ExperimentState = z.infer<typeof experimentStateSchema>;

export const EXPERIMENT_VERDICTS = [
  'WINNER',
  'PROVISIONAL',
  'NO_DIFFERENCE',
  'INCONCLUSIVE',
  'INSUFFICIENT_DATA',
] as const;
export const experimentVerdictSchema = z.enum(EXPERIMENT_VERDICTS);
export type ExperimentVerdict = z.infer<typeof experimentVerdictSchema>;

export const DATA_MATURITY = ['IMMATURE', 'PARTIAL', 'MATURE'] as const;
export const dataMaturitySchema = z.enum(DATA_MATURITY);
export type DataMaturity = z.infer<typeof dataMaturitySchema>;

/* -------------------------------------------------------------------------- */
/* Sales / CRM                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Canonical internal sales events (spec §22). These are provider independent —
 * the HubSpot mapping translates customer-specific pipeline stages onto them.
 */
export const SALES_EVENT_TYPES = [
  'FORM_COMPLETED',
  'VQ_SCHEDULED',
  'VQ_ATTENDED',
  'VQ_NO_SHOW',
  'VQ_PASSED',
  'VQ_REJECTED',
  'SALES_ACCEPTED',
  'OPPORTUNITY_CREATED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'REVENUE_RECOGNIZED',
] as const;
export const salesEventTypeSchema = z.enum(SALES_EVENT_TYPES);
export type SalesEventType = z.infer<typeof salesEventTypeSchema>;

export const VQ_STATUSES = [
  'NOT_SCHEDULED',
  'SCHEDULED',
  'ATTENDED',
  'NO_SHOW',
  'PASSED',
  'REJECTED',
] as const;
export const vqStatusSchema = z.enum(VQ_STATUSES);
export type VqStatus = z.infer<typeof vqStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Sync / outbox                                                               */
/* -------------------------------------------------------------------------- */

export const SYNC_STATUSES = [
  'PENDING',
  'SYNCED',
  'FAILED_RETRYING',
  'DEAD_LETTER',
] as const;
export const syncStatusSchema = z.enum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const OUTBOX_STATES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'ACCEPTED',
  'FAILED_RETRYING',
  'DEAD_LETTER',
  'EXPIRED',
] as const;
export const outboxStateSchema = z.enum(OUTBOX_STATES);
export type OutboxState = z.infer<typeof outboxStateSchema>;

export const OUTBOX_DESTINATIONS = ['META_CAPI', 'HUBSPOT', 'META_MARKETING_API'] as const;
export const outboxDestinationSchema = z.enum(OUTBOX_DESTINATIONS);
export type OutboxDestination = z.infer<typeof outboxDestinationSchema>;

/* -------------------------------------------------------------------------- */
/* Integrations                                                                */
/* -------------------------------------------------------------------------- */

export const PROVIDERS = ['META', 'HUBSPOT', 'OPENAI', 'SUPABASE'] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

export const CONNECTION_STATES = [
  'NOT_CONFIGURED',
  'FIXTURE',
  'CONNECTED',
  'DEGRADED',
  'ERROR',
] as const;
export const connectionStateSchema = z.enum(CONNECTION_STATES);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const HEALTH_STATUSES = ['PASS', 'WARN', 'FAIL', 'AWAITING_EXTERNAL_INPUT'] as const;
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Logical environment tag on every event and submission. `PREVIEW` and `TEST`
 * traffic is excluded from all production metrics (spec §35).
 */
export const APP_ENVIRONMENTS = ['production', 'preview', 'development', 'test'] as const;
export const appEnvironmentSchema = z.enum(APP_ENVIRONMENTS);
export type AppEnvironment = z.infer<typeof appEnvironmentSchema>;

export const TRAFFIC_KINDS = ['PRODUCTION', 'PREVIEW', 'INTERNAL', 'BOT', 'TEST'] as const;
export const trafficKindSchema = z.enum(TRAFFIC_KINDS);
export type TrafficKind = z.infer<typeof trafficKindSchema>;

/** Only PRODUCTION traffic ever reaches a rollup, a metric or an experiment. */
export const PRODUCTION_TRAFFIC_KINDS: readonly TrafficKind[] = ['PRODUCTION'];

/* -------------------------------------------------------------------------- */
/* Consent                                                                     */
/* -------------------------------------------------------------------------- */

export const CONSENT_STATUSES = ['GRANTED', 'DENIED', 'UNKNOWN'] as const;
export const consentStatusSchema = z.enum(CONSENT_STATUSES);
export type ConsentStatus = z.infer<typeof consentStatusSchema>;

export const CONSENT_PURPOSES = [
  'CONTACT',
  'MARKETING_EMAIL',
  'ANALYTICS',
  'AD_MEASUREMENT',
] as const;
export const consentPurposeSchema = z.enum(CONSENT_PURPOSES);
export type ConsentPurpose = z.infer<typeof consentPurposeSchema>;

/* -------------------------------------------------------------------------- */
/* Creative                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The six mandated communication principles. Diversity is enforced against this
 * axis plus computed hook/copy/visual similarity (spec §12).
 */
export const CREATIVE_PRINCIPLES = [
  'PROBLEM_PAIN',
  'CONCRETE_RESULT',
  'COMPARISON_ALTERNATIVE',
  'PROOF_CASE_DATAPOINT',
  'OBJECTION_HANDLING',
  'CONTRARIAN_INSIGHT',
] as const;
export const creativePrincipleSchema = z.enum(CREATIVE_PRINCIPLES);
export type CreativePrinciple = z.infer<typeof creativePrincipleSchema>;

export const ASPECT_RATIOS = ['1:1', '4:5', '9:16'] as const;
export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

/** Required for every launch; 9:16 is optional story/reels placement. */
export const REQUIRED_ASPECT_RATIOS: readonly AspectRatio[] = ['1:1', '4:5'];

export const ASSET_REVIEW_STATES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'] as const;
export const assetReviewStateSchema = z.enum(ASSET_REVIEW_STATES);
export type AssetReviewState = z.infer<typeof assetReviewStateSchema>;

export const MEDIA_KINDS = ['IMAGE', 'VIDEO'] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/* -------------------------------------------------------------------------- */
/* Recommendations                                                             */
/* -------------------------------------------------------------------------- */

export const RECOMMENDATION_ACTIONS = [
  'CONTINUE',
  'PAUSE_CREATIVE',
  'PAUSE_FUNNEL_ARM',
  'INCREASE_BUDGET',
  'DECREASE_BUDGET',
  'CONCLUDE_EXPERIMENT',
  'NEW_CREATIVE_ITERATION',
  'TEST_NEW_ANGLE',
  'KEEP_OFFER_CHANGE_MESSAGING',
  'COLLECT_MORE_DATA',
] as const;
export const recommendationActionSchema = z.enum(RECOMMENDATION_ACTIONS);
export type RecommendationActionKind = z.infer<typeof recommendationActionSchema>;

export const RECOMMENDATION_STATES = [
  'OPEN',
  'ACCEPTED',
  'DISMISSED',
  'EXECUTING',
  'EXECUTED',
  'EXECUTION_FAILED',
  'SUPERSEDED',
] as const;
export const recommendationStateSchema = z.enum(RECOMMENDATION_STATES);
export type RecommendationState = z.infer<typeof recommendationStateSchema>;

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/* -------------------------------------------------------------------------- */
/* Meta                                                                        */
/* -------------------------------------------------------------------------- */

export const META_ENTITY_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'] as const;
export const metaEntityStatusSchema = z.enum(META_ENTITY_STATUSES);
export type MetaEntityStatus = z.infer<typeof metaEntityStatusSchema>;

export const META_COMMAND_KINDS = [
  'CREATE_DRAFT_CAMPAIGN',
  'PAUSE_ENTITY',
  'RESUME_ENTITY',
  'INCREASE_BUDGET',
  'DECREASE_BUDGET',
  'PAUSE_CREATIVE',
] as const;
export const metaCommandKindSchema = z.enum(META_COMMAND_KINDS);
export type MetaCommandKind = z.infer<typeof metaCommandKindSchema>;

export const COMMAND_STATES = [
  'PENDING_CONFIRMATION',
  'QUEUED',
  'IN_FLIGHT',
  'PROVIDER_CONFIRMED',
  'FAILED',
  'RECONCILED',
  'BLOCKED_BY_FLAG',
] as const;
export const commandStateSchema = z.enum(COMMAND_STATES);
export type CommandState = z.infer<typeof commandStateSchema>;

/* -------------------------------------------------------------------------- */
/* Down-funnel CAPI stages                                                     */
/* -------------------------------------------------------------------------- */

export const CAPI_STAGES = [
  'INITIAL_LEAD',
  'MARKETING_QUALIFIED_LEAD',
  'SALES_OPPORTUNITY',
  'CONVERTED',
] as const;
export const capiStageSchema = z.enum(CAPI_STAGES);
export type CapiStage = z.infer<typeof capiStageSchema>;
