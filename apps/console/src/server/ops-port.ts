import type {
  AspectRatio,
  AssetReviewState,
  AttributionLevel,
  CampaignErrorState,
  CampaignState,
  ConfidenceLabel,
  ConnectionState,
  ConsentVersion,
  CreativePrinciple,
  DataMaturity,
  DryRunResult,
  ExperimentThresholds,
  FeatureFlags,
  HealthCheck,
  HealthStatus,
  IntegrationConnection,
  OfferType,
  OutboxEvent,
  Provider,
  ProviderHealth,
  RecommendationConfig,
  RetentionPolicy,
  Role,
  RoleBudgetLimit,
} from '@am/domain';
import type {
  HubspotMappingDocument,
  MappingIssue,
  MappingValidationResult,
  MappingWizardStepKey,
  TestLeadResult,
} from '@am/hubspot';
import type { StatusSelector } from '@am/ui';

/**
 * The data port for Heute, Library, Integrationen and Einstellungen.
 *
 * These four areas own no storage. Everything they need from the data layer is
 * declared here so the real repositories can be substituted without touching a
 * component, and `ops-fixtures.ts` implements the whole interface today against
 * the packages' own fixture providers.
 *
 * Three invariants every implementation must uphold, because the UI states them
 * as facts to the operator (AGENTS.md rules 1–3):
 *
 * 1. **Nothing external is invented.** A missing credential, id or mapping is
 *    reported as `AWAITING_EXTERNAL_INPUT`, never as a `FAIL` and never as a
 *    fabricated `CONNECTED`.
 * 2. **A dry run is not a success.** Every write-shaped call returns its
 *    `DryRunResult` in a dedicated field so the console can render
 *    `DryRunNotice` rather than a success toast.
 * 3. **A local click is not a provider confirmation.** `providerConfirmed` is
 *    only ever true when the provider itself acknowledged the command.
 */

/* -------------------------------------------------------------------------- */
/* Heute                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of work the daily start page surfaces (spec §8).
 *
 * The array order *is* the display order and encodes why the day is arranged
 * this way: errors invalidate the data everything else is judged on, approvals
 * block other people, and only then come the decisions this operator can take
 * alone.
 */
export const TODAY_ITEM_KINDS = [
  'ERROR',
  'APPROVAL',
  'RECOMMENDATION',
  'BUDGET_WARNING',
  'PERFORMANCE_WARNING',
  'MATURED_RESULT',
  'PROPOSAL',
  'IMMATURE_COHORT',
] as const;
export type TodayItemKind = (typeof TODAY_ITEM_KINDS)[number];

export type TodaySeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TodayItem {
  id: string;
  kind: TodayItemKind;
  /** German headline naming the concrete thing that needs attention. */
  titleDe: string;
  /** German sentence explaining the consequence and what happens next. */
  detailDe: string;
  /** Deep link to the screen where this item is actually resolved. */
  href: string;
  hrefLabelDe: string;
  /** Business time the item arose. Oldest first inside a kind. */
  occurredAt: string;
  campaignNameDe: string | null;
  /** Optional lifecycle badge, rendered through `StatusBadge`. */
  badge: StatusSelector | null;
  severity: TodaySeverity;
}

export interface ActiveCampaignSummary {
  id: string;
  nameDe: string;
  state: CampaignState;
  errorState: CampaignErrorState | null;
  spendTodayMinor: number | null;
  currency: string;
  leadsToday: number | null;
  targetCostPerLeadMinor: number | null;
  costPerLeadMinor: number | null;
  maturity: DataMaturity;
  attributionCoverage: number | null;
  href: string;
}

export interface TodaySnapshot {
  generatedAt: string;
  activeCampaigns: ActiveCampaignSummary[];
  items: TodayItem[];
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

export interface LibraryClaim {
  id: string;
  textDe: string;
  confidence: ConfidenceLabel;
  /** Present exactly when the claim is backed; otherwise it is a hypothesis. */
  evidence: {
    kindDe: string;
    summaryDe: string;
    sourceRefDe: string | null;
    approved: boolean;
  } | null;
  requiresHypothesisLabel: boolean;
}

export interface CreativeRendition {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  status: 'READY' | 'PENDING' | 'FAILED';
  /** Alt text is mandatory for a READY rendition. */
  altTextDe: string | null;
}

export interface CreativePerformance {
  spendMinor: number;
  currency: string;
  impressions: number;
  leads: number;
  /** Null when there is no lead yet — never rendered as a zero cost. */
  costPerLeadMinor: number | null;
  maturity: DataMaturity;
  attributionLevel: AttributionLevel;
}

export interface LibraryCreative {
  id: string;
  nameDe: string;
  principle: CreativePrinciple;
  angleNameDe: string | null;
  offerNameDe: string | null;
  reviewState: AssetReviewState;
  hookDe: string;
  bodyDe: string;
  renditions: CreativeRendition[];
  performance: CreativePerformance;
  claims: LibraryClaim[];
  /** Detail route, once one exists. Null renders as plain text, never a dead link. */
  href: string | null;
}

export interface LibraryAngleVersion {
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  summaryDe: string;
  publishedAt: string | null;
}

export interface LibraryAngle {
  id: string;
  nameDe: string;
  coreMessageDe: string;
  audienceDe: string;
  versions: LibraryAngleVersion[];
  usedInCampaigns: number;
  href: string | null;
}

export interface LibraryOffer {
  id: string;
  nameDe: string;
  type: OfferType;
  promiseDe: string;
  effortPromiseDe: string | null;
  usedInCampaigns: number;
  href: string | null;
}

export interface LibraryCaseStudy {
  id: string;
  clientDe: string;
  industryDe: string | null;
  challengeDe: string;
  outcomeDe: string;
  metrics: Array<{ labelDe: string; valueDe: string }>;
  approved: boolean;
  usableInAds: boolean;
}

export interface LibraryTestimonial {
  id: string;
  quoteDe: string;
  authorDe: string;
  companyDe: string | null;
  approved: boolean;
  usableInAds: boolean;
}

export interface LibraryFaq {
  id: string;
  questionDe: string;
  answerDe: string;
  approved: boolean;
}

export interface LibraryGuardrail {
  id: string;
  kindDe: string;
  pattern: string;
  reasonDe: string;
  severity: 'BLOCK' | 'WARN';
}

export interface LibraryHistoricalCampaign {
  id: string;
  nameDe: string;
  periodDe: string;
  spendMinor: number;
  currency: string;
  attributionLevel: AttributionLevel;
  attributionCoverage: number | null;
  maturity: DataMaturity;
  confidence: ConfidenceLabel;
  outcomeDe: string;
  angleNameDe: string | null;
  offerNameDe: string | null;
  href: string | null;
}

export interface LibrarySnapshot {
  generatedAt: string;
  creatives: LibraryCreative[];
  angles: LibraryAngle[];
  offers: LibraryOffer[];
  claims: LibraryClaim[];
  caseStudies: LibraryCaseStudy[];
  testimonials: LibraryTestimonial[];
  faqs: LibraryFaq[];
  guardrails: LibraryGuardrail[];
  historicalCampaigns: LibraryHistoricalCampaign[];
}

/* -------------------------------------------------------------------------- */
/* Integrationen — overview                                                    */
/* -------------------------------------------------------------------------- */

export interface ProviderCardData {
  provider: Provider;
  connection: IntegrationConnection;
  health: ProviderHealth;
  lastSyncAt: string | null;
  /** Events currently retrying. */
  errorCount: number;
  deadLetterCount: number;
  /** German sentence naming the mode this provider actually runs in. */
  modeDe: string;
  setupHref: string | null;
  setupLabelDe: string | null;
}

export interface IntegrationsSnapshot {
  generatedAt: string;
  providers: ProviderCardData[];
  flags: FeatureFlags;
}

/* -------------------------------------------------------------------------- */
/* Integrationen — Meta setup wizard                                           */
/* -------------------------------------------------------------------------- */

/**
 * The ten steps of the Meta setup (spec §21). The first nine map one-to-one
 * onto `META_HEALTH_KEYS`; the tenth is the aggregated final verdict.
 */
export const META_WIZARD_STEP_KEYS = [
  'meta.app_connection',
  'meta.business',
  'meta.ad_account',
  'meta.page_ig',
  'meta.pixel_dataset',
  'meta.permissions',
  'meta.insights_read',
  'meta.draft_test',
  'meta.capi_test',
  'meta.final_health',
] as const;
export type MetaWizardStepKey = (typeof META_WIZARD_STEP_KEYS)[number];

export interface MetaWizardStep {
  key: MetaWizardStepKey;
  order: number;
  labelDe: string;
  descriptionDe: string;
  status: HealthStatus;
  /** The underlying probe. Null for the aggregated final step. */
  check: HealthCheck | null;
  /** Names the environment variables this step needs, never their values. */
  requiredEnvVars: string[];
}

export interface CredentialSlot {
  labelDe: string;
  envVar: string;
  present: boolean;
  /**
   * Shown only when the value is genuinely known and non-secret — a fixture
   * id is always labelled as such. Never an invented identifier.
   */
  displayValue: string | null;
  originDe: string;
}

export interface MetaSetupSnapshot {
  generatedAt: string;
  mode: 'FIXTURE' | 'LIVE';
  /** Set in fixture mode; the wizard says plainly that nothing is connected. */
  fixtureNoticeDe: string | null;
  health: ProviderHealth;
  steps: MetaWizardStep[];
  credentials: CredentialSlot[];
  flags: FeatureFlags;
}

/* -------------------------------------------------------------------------- */
/* Integrationen — HubSpot mapping wizard                                      */
/* -------------------------------------------------------------------------- */

export interface HubspotStepView {
  key: MappingWizardStepKey;
  order: number;
  labelDe: string;
  descriptionDe: string;
  requiredForLaunch: boolean;
  /** German issues from `validateMapping`, with their blocking level. */
  issues: MappingIssue[];
  /** No ERROR issue on this step. */
  complete: boolean;
  /** Read-only summary of what is configured, one line per fact. */
  summaryDe: string[];
}

export interface MappingVersionSummary {
  id: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: string | null;
  sourceDe: string;
  notesDe: string | null;
}

export interface ProbeResultView {
  key: string;
  labelDe: string;
  status: HealthStatus;
  detailDe: string;
  checkedAt: string;
  /** Set when the probe could only be prepared, not executed. */
  dryRun: DryRunResult | null;
}

export interface HubspotMappingSnapshot {
  generatedAt: string;
  connection: ProviderHealth;
  draft: HubspotMappingDocument;
  versions: MappingVersionSummary[];
  steps: HubspotStepView[];
  validation: MappingValidationResult;
  /** `canPublishMapping(draft)` — no PUBLISH-blocking error left. */
  canPublish: boolean;
  /** `requiredMappingsComplete(draft)` && a passed test lead. */
  launchReady: boolean;
  /** Exactly what is still missing for the live launch, in German. */
  missingForLaunchDe: string[];
  testLead: TestLeadResult | null;
  webhookTest: ProbeResultView | null;
  reconciliationTest: ProbeResultView | null;
  flags: FeatureFlags;
}

export interface PublishMappingOutcome {
  published: boolean;
  version: number | null;
  issues: MappingIssue[];
  messageDe: string;
}

/* -------------------------------------------------------------------------- */
/* Integrationen — outbox / dead letter                                        */
/* -------------------------------------------------------------------------- */

export interface OutboxRow {
  event: OutboxEvent;
  destinationLabelDe: string;
  /** False for terminal states that a retry cannot change. */
  retryable: boolean;
  /** Deep link to the campaign the event belongs to, when there is one. */
  href: string | null;
}

export interface OutboxSnapshot {
  generatedAt: string;
  rows: OutboxRow[];
  pendingCount: number;
  retryingCount: number;
  deadLetterCount: number;
}

export interface OutboxRetryOutcome {
  eventId: string;
  /** The state the event is in *after* the attempt. */
  state: OutboxEvent['status'];
  messageDe: string;
  /** Only true when the provider itself acknowledged the dispatch. */
  providerConfirmed: boolean;
  dryRun: DryRunResult | null;
}

/* -------------------------------------------------------------------------- */
/* Einstellungen                                                               */
/* -------------------------------------------------------------------------- */

export interface WorkspaceMemberView {
  id: string;
  displayName: string;
  email: string;
  roles: Role[];
  lastActiveAt: string | null;
}

/**
 * When an approval becomes mandatory. Kept beside the per-role budget limits
 * because the two together decide whether a scale request is executed, refused
 * or routed onwards.
 */
export interface ApprovalThresholds {
  /** Relative increase above which a BUDGET_SCALE approval is required. */
  budgetScaleApprovalPct: number;
  /** Relative increase above which the change counts as MAJOR_CHANGE. */
  majorChangeApprovalPct: number;
  /** Daily budget above which every change needs an approval, in minor units. */
  dailyBudgetApprovalMinor: number;
  currency: string;
}

export interface BrandTokens {
  primary: string;
  foreground: string;
  background: string;
  accent: string;
  logoAssetPath: string | null;
}

export type FeatureFlagKey = keyof FeatureFlags;

export interface FeatureFlagView {
  key: FeatureFlagKey;
  labelDe: string;
  value: boolean;
  /** The environment variable that controls it. */
  envVar: string;
  explanationDe: string;
}

export interface SettingsSnapshot {
  generatedAt: string;
  members: WorkspaceMemberView[];
  roleBudgetLimits: Record<Role, RoleBudgetLimit>;
  approvalThresholds: ApprovalThresholds;
  experimentThresholds: ExperimentThresholds;
  recommendationConfig: RecommendationConfig;
  attributionWindowDays: number;
  consentVersions: ConsentVersion[];
  retention: RetentionPolicy;
  brand: BrandTokens;
  featureFlags: FeatureFlagView[];
}

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

export interface SaveConsentVersionInput {
  textDe: string;
  purposes: ConsentVersion['purposes'];
  privacyPolicyUrl: string;
}

export interface OpsPort {
  /* ---- reads ---- */
  loadToday(): Promise<TodaySnapshot>;
  loadLibrary(): Promise<LibrarySnapshot>;
  loadIntegrations(): Promise<IntegrationsSnapshot>;
  loadMetaSetup(): Promise<MetaSetupSnapshot>;
  loadHubspotMapping(): Promise<HubspotMappingSnapshot>;
  loadOutbox(): Promise<OutboxSnapshot>;
  loadSettings(): Promise<SettingsSnapshot>;

  /* ---- integrations ---- */
  recheckProvider(input: { provider: Provider }): Promise<ProviderHealth>;
  retryOutboxEvent(input: { eventId: string }): Promise<OutboxRetryOutcome>;

  /* ---- HubSpot mapping wizard ---- */
  saveMappingStep(input: {
    step: MappingWizardStepKey;
    /** A partial document patch; the implementation re-validates the whole. */
    patch: Partial<HubspotMappingDocument>;
  }): Promise<HubspotMappingSnapshot>;
  /**
   * Loads the complete fixture mapping into the draft, clearly marked as
   * fixture data. It exists so the wizard, the publish path and the launch gate
   * are walkable before a customer portal has been described — never so that a
   * fixture can be mistaken for the real mapping.
   */
  applyFixtureMapping(): Promise<HubspotMappingSnapshot>;
  publishMapping(input: { publishedBy: string; now: string }): Promise<PublishMappingOutcome>;
  runMappingTestLead(input: { initiatedBy: string }): Promise<TestLeadResult>;
  runWebhookTest(): Promise<ProbeResultView>;
  runReconciliationTest(): Promise<ProbeResultView>;

  /* ---- settings ---- */
  saveMemberRoles(input: { memberId: string; roles: Role[] }): Promise<SettingsSnapshot>;
  saveRoleBudgetLimit(input: { limit: RoleBudgetLimit }): Promise<SettingsSnapshot>;
  saveApprovalThresholds(input: { thresholds: ApprovalThresholds }): Promise<SettingsSnapshot>;
  saveExperimentThresholds(input: { thresholds: ExperimentThresholds }): Promise<SettingsSnapshot>;
  saveRecommendationConfig(input: { config: RecommendationConfig }): Promise<SettingsSnapshot>;
  saveAttributionWindow(input: { windowDays: number }): Promise<SettingsSnapshot>;
  /** Always appends a new version — a published consent text is immutable. */
  addConsentVersion(input: SaveConsentVersionInput & { now: string }): Promise<SettingsSnapshot>;
  saveRetentionPolicy(input: {
    policy: Omit<RetentionPolicy, 'configuredBy' | 'configuredAt'>;
    configuredBy: string;
    now: string;
  }): Promise<SettingsSnapshot>;
  saveBrandTokens(input: { brand: BrandTokens }): Promise<SettingsSnapshot>;
}

/* -------------------------------------------------------------------------- */
/* Shared German labels                                                        */
/* -------------------------------------------------------------------------- */

export const TODAY_ITEM_KIND_LABELS_DE: Readonly<Record<TodayItemKind, string>> = {
  ERROR: 'Kritische Fehler',
  APPROVAL: 'Offene Freigaben',
  RECOMMENDATION: 'Offene Empfehlungen',
  BUDGET_WARNING: 'Budgetwarnungen',
  PERFORMANCE_WARNING: 'Performance-Warnungen',
  MATURED_RESULT: 'Ergebnisse sind reif',
  PROPOSAL: 'Neue Kampagnenvorschläge',
  IMMATURE_COHORT: 'CRM-Kohorten noch unreif',
};

export const TODAY_ITEM_KIND_HINTS_DE: Readonly<Record<TodayItemKind, string>> = {
  ERROR:
    'Zuerst bearbeiten: Solange Tracking oder Sync fehlerhaft sind, sind alle darunter stehenden Zahlen unvollständig.',
  APPROVAL: 'Diese Freigaben blockieren die Arbeit anderer Personen.',
  RECOMMENDATION:
    'Deterministisch berechnete Handlungsvorschläge. Jede Ausführung wird vorher im Detail angezeigt.',
  BUDGET_WARNING: 'Ausgaben laufen aus dem geplanten Rahmen.',
  PERFORMANCE_WARNING: 'Kennzahlen weichen deutlich vom Zielwert ab.',
  MATURED_RESULT: 'Die CRM-Ergebnisse sind alt genug für eine belastbare Auswertung.',
  PROPOSAL: 'Vorschläge, die noch niemand gesichtet hat.',
  IMMATURE_COHORT:
    'Diese Kampagnen liefern noch keine belastbaren Abschlussdaten. Es wird nicht skaliert und kein Gewinner ausgerufen.',
};

export const CONNECTION_STATE_HINTS_DE: Readonly<Record<ConnectionState, string>> = {
  NOT_CONFIGURED: 'Es sind keine Zugangsdaten hinterlegt.',
  FIXTURE: 'Es besteht keine Verbindung zum Anbieter. Alle Daten stammen aus dem Testdatensatz.',
  CONNECTED: 'Die Verbindung wurde vom Anbieter bestätigt.',
  DEGRADED: 'Die Verbindung besteht, einzelne Prüfungen sind offen.',
  ERROR: 'Der Anbieter meldet einen Fehler.',
};
