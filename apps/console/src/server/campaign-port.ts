import type {
  Approval,
  ApprovalKind,
  AspectRatio,
  AssetReviewState,
  AttributionLevel,
  AudienceSpec,
  AuditLog,
  BudgetProposal,
  CampaignErrorState,
  CampaignState,
  ClaimSpec,
  CommandState,
  ConnectionState,
  CreativeConcept,
  DataMaturity,
  DryRunResult,
  EvidenceReference,
  ExperimentPlan,
  ExternalCommand,
  FunnelKind,
  FunnelVersionState,
  HealthStatus,
  LaunchCheckKey,
  LaunchQaReport,
  LearningCard,
  MetricKey,
  MetricValue,
  OfferSpec,
  Permission,
  Rate,
  Recommendation,
  Role,
  SimilarCampaignReference,
  SyncStatus,
  VqStatus,
} from '@am/domain';
import type { ActionResult } from '@/lib/action-result';

/**
 * The single data port of the campaign list and the Campaign Room.
 *
 * Every screen reads through this interface and never through a repository or a
 * provider, so which store is behind it is a decision `getCampaignPort()` makes
 * once, from configuration. Two implementations exist and no screen can tell
 * them apart: `campaign-fixtures.ts` against the fixture data the packages ship,
 * and `campaign-db-port.ts` against the repositories in `@am/db`.
 *
 * Three properties every implementation must uphold, because the UI states them
 * as facts:
 *
 * 1. **An approval covers a content hash, not an object.** Every view that can
 *    be approved carries `contentHash`; the port must invalidate an approval
 *    whose hash no longer matches (`INVALIDATION_MAP`, `isApprovalValid`).
 * 2. **A local click is never a provider confirmation.** Write methods that
 *    touch Meta return either an `ExternalCommand` — rendered as done only in
 *    `PROVIDER_CONFIRMED` / `RECONCILED` — or a `DryRunResult`, which is
 *    rendered as a dry run and never as success.
 * 3. **A refused budget change is refused, never clamped.** The refusal names
 *    the role that may approve it.
 */

/* -------------------------------------------------------------------------- */
/* Shared value objects                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Which reality the operator is looking at. Preview, an internal draft, the
 * paused Meta draft and an actually delivering campaign must never be
 * confusable, so the distinction is carried as data rather than inferred in a
 * component.
 */
export type CampaignReality =
  | 'PREVIEW'
  | 'DRAFT'
  | 'META_DRAFT_PAUSED'
  | 'LIVE'
  | 'PAUSED'
  | 'ENDED';

export interface MoneyAmount {
  amountMinor: number;
  currency: string;
}

/** One provider's sync state for this campaign, as shown in the header. */
export interface ProviderSyncStatus {
  provider: 'META' | 'HUBSPOT';
  connection: ConnectionState;
  health: HealthStatus;
  /** German one-liner: what is synced, what is not, and since when. */
  detailDe: string;
  lastSyncedAt: string | null;
  /** Number of records currently in a failed/retrying sync state. */
  failedCount: number;
}

/** The one thing the campaign is waiting for, computed, never guessed. */
export interface NextRequiredAction {
  key: string;
  labelDe: string;
  detailDe: string;
  /** Deep link into the tab where the operator does it. */
  href: string;
  permission: Permission;
  /** True when the action cannot be taken yet; `blockedReasonDe` says why. */
  blocked: boolean;
  blockedReasonDe: string | null;
}

/** An approval plus everything the UI needs to judge whether it still holds. */
export interface ApprovalStatus {
  kind: ApprovalKind;
  approval: Approval;
  /** Hash of what is on screen now. Differs from the approved hash ⇒ stale. */
  currentContentHash: string;
  /** `isApprovalValid(approval, currentContentHash)`. */
  valid: boolean;
  approverName: string | null;
  /** German reason when a content change invalidated this approval. */
  invalidatedByDe: string | null;
}

/* -------------------------------------------------------------------------- */
/* List                                                                        */
/* -------------------------------------------------------------------------- */

export interface CampaignListQuery {
  states: CampaignState[];
  /** Angle names, matched exactly against `CampaignListRow.angleName`. */
  angles: string[];
  /** Offer names, matched exactly against `CampaignListRow.offerName`. */
  offers: string[];
  /** Inclusive ISO-8601 date bounds on `updatedAt`. */
  from: string | null;
  to: string | null;
  search: string | null;
  page: number;
  pageSize: number;
}

export interface CampaignListRow {
  id: string;
  name: string;
  state: CampaignState;
  errorState: CampaignErrorState | null;
  reality: CampaignReality;
  angleName: string;
  offerName: string;
  primaryMetric: MetricValue;
  budget: MoneyAmount;
  nextAction: NextRequiredAction;
  providerSync: ProviderSyncStatus[];
  updatedAt: string;
}

export interface CampaignListPage {
  rows: CampaignListRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Every value that occurs in the unfiltered set, for the filter controls. */
  facets: { angles: string[]; offers: string[]; states: CampaignState[] };
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

export interface CampaignHeaderView {
  id: string;
  name: string;
  state: CampaignState;
  errorState: CampaignErrorState | null;
  reality: CampaignReality;
  angleName: string;
  offerName: string;
  audienceName: string;
  primaryMetric: MetricValue;
  primaryMetricTarget: number | null;
  budget: MoneyAmount;
  approvals: ApprovalStatus[];
  nextAction: NextRequiredAction;
  providerSync: ProviderSyncStatus[];
  /** States `canTransition` allows from here, already filtered by approvals. */
  allowedTransitions: CampaignState[];
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Tab 1 — Strategie                                                           */
/* -------------------------------------------------------------------------- */

export interface StrategyView {
  campaignId: string;
  contentHash: string;
  angleName: string;
  anglePerspective: string;
  angleRationale: string;
  offer: OfferSpec;
  audience: AudienceSpec;
  coreMessage: string;
  hypothesis: string;
  claims: ClaimSpec[];
  historicalEvidence: EvidenceReference[];
  risks: string[];
  similarPastCampaigns: SimilarCampaignReference[];
  differentiationFromPast: string;
  approval: ApprovalStatus;
}

/* -------------------------------------------------------------------------- */
/* Tab 2 — Creatives                                                           */
/* -------------------------------------------------------------------------- */

export interface CreativeRendition {
  id: string;
  aspectRatio: AspectRatio;
  /** Public URL of the composed rendition, or null while it is being rendered. */
  previewUrl: string | null;
  widthPx: number;
  heightPx: number;
  altTextDe: string;
  /** Renderer + template + seed, so a rendition is always traceable. */
  provenanceDe: string;
}

export interface CreativeCard {
  id: string;
  key: string;
  concept: CreativeConcept;
  renditions: CreativeRendition[];
  reviewState: AssetReviewState;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectedReasonDe: string | null;
}

/** One conceptually colliding pair, named so the operator can act on it. */
export interface DiversityCollision {
  aKey: string;
  aName: string;
  bKey: string;
  bName: string;
  /** Weighted similarity 0..1 from `checkCreativeDiversity`. */
  overall: number;
  samePrinciple: boolean;
  reasonDe: string;
}

export interface DiversityCheckView {
  distinctCount: number;
  requiredDistinct: number;
  /** True when fewer than `requiredDistinct` clusters exist. */
  blocked: boolean;
  reasonsDe: string[];
  collisions: DiversityCollision[];
  evaluatedAt: string | null;
}

export interface CreativeBoardView {
  campaignId: string;
  contentHash: string;
  creatives: CreativeCard[];
  diversity: DiversityCheckView;
  approvedCount: number;
  minApproved: number;
  approval: ApprovalStatus;
}

/* -------------------------------------------------------------------------- */
/* Tab 3 — Funnel                                                              */
/* -------------------------------------------------------------------------- */

export interface FunnelVariantView {
  funnelId: string;
  versionId: string;
  /** Set for MULTI_STEP_FORM / HYBRID; drives the form-builder deep link. */
  formVersionId: string | null;
  name: string;
  kind: FunnelKind;
  version: number;
  state: FunnelVersionState;
  promise: string;
  hypothesis: string;
  rationale: string;
  qualificationQuestionCount: number;
  publishedAt: string | null;
  /** Public runtime URL once published. */
  publicUrl: string | null;
  /** `/builder/form/[id]` or `/builder/page/[id]` — owned by the builder routes. */
  builderHref: string;
}

export interface FunnelOverviewView {
  campaignId: string;
  variants: FunnelVariantView[];
  minMultiStepFormVariants: number;
  /** German problems from `validateFunnelMix`, empty when the mix is valid. */
  mixProblemsDe: string[];
}

/* -------------------------------------------------------------------------- */
/* Tab 4 — Testplan                                                            */
/* -------------------------------------------------------------------------- */

export interface TestPlanView {
  campaignId: string;
  contentHash: string;
  plan: ExperimentPlan;
  budget: BudgetProposal;
  primaryMetric: MetricKey;
  /** Arm labels resolved from creative / funnel keys, for the control column. */
  armLabelsDe: Record<string, string>;
  approval: ApprovalStatus;
}

/* -------------------------------------------------------------------------- */
/* Tab 5 — Launch-QA                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The exact request one publishing step would send to Meta.
 *
 * The confirmation dialog and the port read the same object, so what the
 * operator approves and what the adapter would send cannot drift apart.
 */
export interface MetaWritePreview {
  /** The campaign state this step would enter. */
  to: CampaignState;
  /** Adapter operation, e.g. `meta.create_paused_draft_campaign`. */
  operation: string;
  payload: Record<string, unknown>;
}

export interface LaunchQaView {
  campaignId: string;
  report: LaunchQaReport;
  /** Keys whose status is AWAITING_EXTERNAL_INPUT and gate only the live step. */
  awaitingLiveOnlyKeys: LaunchCheckKey[];
  /** One entry per step on this screen that reaches Meta. */
  metaWrites: MetaWritePreview[];
}

/* -------------------------------------------------------------------------- */
/* Tab 6 — Live-Performance                                                    */
/* -------------------------------------------------------------------------- */

export interface PerformancePoint {
  /** ISO-8601 date, `YYYY-MM-DD`. */
  date: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  sessions: number;
  formStarts: number;
  submissions: number;
  ctr: Rate;
  cpcMinor: number | null;
  cplMinor: number | null;
}

export interface PerformanceBreakdownRow {
  id: string;
  labelDe: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  sessions: number;
  submissions: number;
  ctr: Rate;
  submissionRate: Rate;
  cplMinor: number | null;
  maturity: DataMaturity;
}

export interface LivePerformanceView {
  campaignId: string;
  currency: string;
  reality: CampaignReality;
  /** Empty while nothing has been delivered — the UI then explains why. */
  series: PerformancePoint[];
  totals: MetricValue[];
  byCreative: PerformanceBreakdownRow[];
  byFunnelArm: PerformanceBreakdownRow[];
  maturity: DataMaturity;
  attributionCoverage: number | null;
  lastUpdatedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Tab 7 — Leads und Sales                                                     */
/* -------------------------------------------------------------------------- */

export interface CrmFunnelStage {
  key:
    | 'leads'
    | 'vq_scheduled'
    | 'vq_attended'
    | 'vq_no_show'
    | 'qualified_vq'
    | 'opportunities'
    | 'closed_won'
    | 'closed_lost';
  labelDe: string;
  count: number;
  /** Conversion from the previous meaningful stage, with its basis. */
  conversion: Rate;
  maturity: DataMaturity;
  attributionCoverage: number | null;
}

export interface LeadRow {
  id: string;
  /** Pseudonymous label — never a name, never an e-mail (AGENTS.md rule 7). */
  labelDe: string;
  createdAt: string;
  vqStatus: VqStatus;
  syncStatus: SyncStatus;
  syncAttempts: number;
  lastSyncError: string | null;
  attributionLevel: AttributionLevel;
  creativeLabelDe: string | null;
  funnelArmLabelDe: string | null;
}

export interface LeadsSalesView {
  campaignId: string;
  stages: CrmFunnelStage[];
  revenue: MoneyAmount;
  revenueMaturity: DataMaturity;
  attributionCoverage: number | null;
  crmMaturityDays: number;
  /** Days the youngest cohort still needs before CRM outcomes are mature. */
  maturityRemainingDays: number;
  leads: LeadRow[];
  failedSyncCount: number;
}

/* -------------------------------------------------------------------------- */
/* Tab 8 — Empfehlungen                                                        */
/* -------------------------------------------------------------------------- */

export interface RecommendationView {
  recommendation: Recommendation;
  /** The command this recommendation produced, if it was ever dispatched. */
  command: ExternalCommand | null;
  /** Present when the last execution attempt was blocked by a safety flag. */
  lastDryRun: DryRunResult | null;
  /** Exactly what would be sent, rendered in the confirmation dialog. */
  requestPreview: Record<string, unknown>;
  /** German sentence naming the action in operator language. */
  actionSummaryDe: string;
}

/* -------------------------------------------------------------------------- */
/* Tab 10 — Versionen                                                          */
/* -------------------------------------------------------------------------- */

export interface CampaignVersionEntry {
  versionId: string;
  version: number;
  publishedAt: string | null;
  labelDe: string;
  summaryDe: string;
  /** True for the version currently delivered / last published. */
  current: boolean;
  before: unknown;
  after: unknown;
}

export interface HistoryView {
  campaignId: string;
  versions: CampaignVersionEntry[];
  auditLog: AuditLog[];
}

/* -------------------------------------------------------------------------- */
/* Write inputs                                                                */
/* -------------------------------------------------------------------------- */

export interface ApprovalDecisionInput {
  campaignId: string;
  kind: ApprovalKind;
  decision: 'APPROVE' | 'REJECT';
  /** The hash the operator saw. A mismatch must be refused, not overwritten. */
  contentHash: string;
  reasonDe?: string;
  actor: { id: string; displayName: string };
}

export interface CreativeReviewInput {
  campaignId: string;
  creativeId: string;
  decision: 'APPROVE' | 'REJECT';
  reasonDe?: string;
  actor: { id: string; displayName: string };
}

export interface TransitionInput {
  campaignId: string;
  to: CampaignState;
  actor: { id: string; displayName: string };
}

export interface BudgetChangeInput {
  campaignId: string;
  newDailyBudgetMinor: number;
  reasonDe: string;
  /** Roles of the requesting user; the port checks them against role limits. */
  actorRoles: Role[];
  actor: { id: string; displayName: string };
}

export interface RecommendationExecutionInput {
  campaignId: string;
  recommendationId: string;
  actor: { id: string; displayName: string };
}

/**
 * Deciding a recommendation without touching a provider.
 *
 * `ACCEPTED` and `DISMISSED` are states of *our* record — the operator's
 * verdict on the proposal. They are how a recommendation that needs no external
 * action leaves the board, and they never imply that anything was sent.
 */
export interface RecommendationDecisionInput {
  campaignId: string;
  recommendationId: string;
  decision: 'ACCEPT' | 'DISMISS';
  reasonDe?: string;
  actor: { id: string; displayName: string };
}

export interface LeadSyncRetryInput {
  campaignId: string;
  leadId: string;
  actor: { id: string; displayName: string };
}

/** What a Meta-touching write returns: a command record, never a bare "ok". */
export interface CommandOutcome {
  command: ExternalCommand;
  /** Only `PROVIDER_CONFIRMED` / `RECONCILED` may render as a completed action. */
  state: CommandState;
}

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

export interface CampaignPort {
  /* ---- reads ---- */
  listCampaigns(query: CampaignListQuery): Promise<CampaignListPage>;
  getHeader(campaignId: string, preview: boolean): Promise<CampaignHeaderView | null>;
  getStrategy(campaignId: string): Promise<StrategyView | null>;
  getCreativeBoard(campaignId: string): Promise<CreativeBoardView | null>;
  getFunnelOverview(campaignId: string): Promise<FunnelOverviewView | null>;
  getTestPlan(campaignId: string): Promise<TestPlanView | null>;
  getLaunchQa(campaignId: string): Promise<LaunchQaView | null>;
  getLivePerformance(campaignId: string): Promise<LivePerformanceView | null>;
  getLeadsAndSales(campaignId: string): Promise<LeadsSalesView | null>;
  getRecommendations(campaignId: string): Promise<RecommendationView[]>;
  getLearnings(campaignId: string): Promise<LearningCard[]>;
  getHistory(campaignId: string): Promise<HistoryView | null>;

  /* ---- writes ---- */
  decideApproval(input: ApprovalDecisionInput): Promise<ActionResult<ApprovalStatus>>;
  reviewCreative(input: CreativeReviewInput): Promise<ActionResult<CreativeBoardView>>;
  /**
   * Advances the business state. A step into a state that asserts a Meta object
   * runs through the Meta write path and returns `dry_run` while writes are off
   * — the state is not recorded on the strength of a local click.
   */
  transition(input: TransitionInput): Promise<ActionResult<CampaignHeaderView>>;
  /**
   * Refuses out-of-limit changes naming the approving role; never clamps. Once
   * the budget lives on a Meta object, changing it is an external write and
   * returns `dry_run` while writes are off.
   */
  changeBudget(input: BudgetChangeInput): Promise<ActionResult<CampaignHeaderView>>;
  /** Returns `dry_run` while external writes are off — never `ok`. */
  executeRecommendation(
    input: RecommendationExecutionInput,
  ): Promise<ActionResult<CommandOutcome>>;
  /** Records the operator's verdict. Sends nothing, so it may return `ok`. */
  decideRecommendation(
    input: RecommendationDecisionInput,
  ): Promise<ActionResult<RecommendationView>>;
  retryLeadSync(input: LeadSyncRetryInput): Promise<ActionResult<LeadRow>>;
}

/** Route segments of the Campaign Room, in the order the tabs are shown. */
export const CAMPAIGN_TABS = [
  'strategie',
  'creatives',
  'funnel',
  'testplan',
  'launch-qa',
  'live-performance',
  'leads-sales',
  'empfehlungen',
  'learnings',
  'versionen',
] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number];

export const CAMPAIGN_TAB_LABELS_DE: Readonly<Record<CampaignTab, string>> = {
  strategie: 'Strategie',
  creatives: 'Creatives',
  funnel: 'Funnel',
  testplan: 'Testplan',
  'launch-qa': 'Launch-QA',
  'live-performance': 'Live-Performance',
  'leads-sales': 'Leads & Sales',
  empfehlungen: 'Empfehlungen',
  learnings: 'Learnings',
  versionen: 'Versionen',
};

export function campaignTabHref(campaignId: string, tab: CampaignTab): string {
  return `/kampagnen/${campaignId}/${tab}`;
}
