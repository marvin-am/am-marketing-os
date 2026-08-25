import {
  canTransition,
  canWriteMeta,
  dryRun,
  GENERATION_DEFAULTS,
  isApprovalValid,
  LAUNCH_CHECK_KEYS,
  LAUNCH_CHECK_LABELS_DE,
  LIVE_ONLY_CHECKS,
  rate,
  REQUIRED_APPROVALS_FOR_STATE,
  summarizeLaunchQa,
  validateFunnelMix,
  type Approval,
  type ApprovalKind,
  type AspectRatio,
  type AttributionLevel,
  type AuditLog,
  type CampaignState,
  type CreativeConcept,
  type DataMaturity,
  type ExternalCommand,
  type FunnelProposal,
  type HealthStatus,
  type LaunchCheckResult,
  type LearningCard,
  type MetricKey,
  type MetricValue,
  type Rate,
  type Recommendation,
  type SyncStatus,
  type VqStatus,
} from '@am/domain';
import { getFeatureFlags } from '@am/config';
import { logger } from '@am/observability';
import type {
  AmDatabase,
  ApprovalRow,
  AuditLogRow,
  CampaignProposalRow,
  CampaignRow,
  CampaignVersionRow,
  CreativeConceptRow,
  CreativeRenditionRow,
  CreativeVersionRow,
  ExperimentRow,
  ExternalCommandRow,
  FunnelRow,
  FunnelVersionRow,
  Json,
  JsonObject,
  LearningCardRow,
  PerformanceRollupRow,
  PublishedFunnelRow,
  RecommendationRow,
  Uuid,
} from '@am/db';
import { actionDryRun, actionError, actionOk, type ActionResult } from '@/lib/action-result';
import { rolesWithPermission, ROLE_LABELS_DE } from '@/lib/permissions';
import {
  assetsContentHash,
  CAMPAIGN_APPROVAL_KINDS,
  publishContentHash,
  strategyContentHash,
  testPlanContentHash,
} from './campaign-content-hash';
import { campaignTabHref } from './campaign-port';
import { workspaceResolver } from './workspace';
import type {
  ApprovalDecisionInput,
  ApprovalStatus,
  BudgetChangeInput,
  CampaignHeaderView,
  CampaignListPage,
  CampaignListQuery,
  CampaignListRow,
  CampaignPort,
  CampaignReality,
  CampaignVersionEntry,
  CommandOutcome,
  CreativeBoardView,
  CreativeCard,
  CreativeReviewInput,
  CrmFunnelStage,
  DiversityCheckView,
  FunnelOverviewView,
  FunnelVariantView,
  HistoryView,
  LaunchQaView,
  LeadRow,
  LeadsSalesView,
  LeadSyncRetryInput,
  LivePerformanceView,
  MetaWritePreview,
  NextRequiredAction,
  PerformanceBreakdownRow,
  PerformancePoint,
  ProviderSyncStatus,
  RecommendationDecisionInput,
  RecommendationExecutionInput,
  RecommendationView,
  StrategyView,
  TestPlanView,
  TransitionInput,
} from './campaign-port';
import type { TransactionRunner } from './campaign-transaction';

/**
 * `CampaignPort` over the repositories in `@am/db`.
 *
 * The counterpart of `FixtureCampaignPort`: same contract, same invariants,
 * different storage. Which one the console runs is decided once, in
 * `getCampaignPort()`, from `resolveDatabase()`.
 *
 * Three things this implementation is careful about, because they are the ones
 * a repository-backed port gets wrong quietly:
 *
 * 1. **It never fills a gap with a plausible number.** Several fields the
 *    Campaign Room shows have no column and no repository behind them yet —
 *    claims, creative preview URLs, the display name behind an approver id. Each
 *    of those comes back empty or `null`, and the comment at the site says which
 *    table would have to be reachable for it to carry a value. A screen that
 *    says "nichts hinterlegt" is recoverable; a screen showing an invented
 *    figure is not.
 * 2. **A local click is never a provider confirmation.** Every write that would
 *    reach Meta or HubSpot goes through the same gate as in the fixture: a
 *    `DryRunResult` while `EXTERNAL_WRITES_ENABLED` is off, and a refusal —
 *    never a fabricated success — when writes are on but no account is
 *    connected. Nothing is persisted in either case.
 * 3. **Multi-row writes commit together or not at all.** The approval cascade
 *    writes the decision, the approvals it invalidates and the audit row that
 *    accounts for the cascade. PostgREST cannot span statements, so those go
 *    through `TransactionRunner`; without one the port refuses the write rather
 *    than performing half of it.
 */

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface CampaignDatabaseOptions {
  /**
   * Resolved per call rather than once, because a Supabase client carries the
   * caller's session: one shared instance would hand every request whichever
   * operator's RLS context happened to build it.
   */
  database: () => Promise<AmDatabase>;
  /** Fallback workspace while no workspace row carries the console's slug. */
  workspaceId: string;
  /** Atomic writes. `null` when no `DATABASE_URL` is configured. */
  transaction: TransactionRunner | null;
  now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Values the schema cannot answer yet                                         */
/* -------------------------------------------------------------------------- */

const NOT_RECORDED_DE = 'Dazu ist in der Datenbank nichts hinterlegt.';

const NO_TRANSACTION_DE =
  'Für diese Änderung ist keine transaktionale Datenbankverbindung konfiguriert (DATABASE_URL). ' +
  'Sie wurde nicht ausgeführt, weil sie sonst nur teilweise hätte greifen können.';

const DEFAULT_CURRENCY = 'EUR';

/** How many days of rollups the Live-Performance tab charts. */
const PERFORMANCE_WINDOW_DAYS = 30;

/**
 * How many campaigns the list scans before filtering.
 *
 * Angle and offer are not columns — they live in the published version's spec —
 * so neither the filter nor the facets can be pushed into the query, and the
 * list has to read the workspace's campaigns to compute them. This product is
 * single-workspace and its campaign count is in the dozens; the cap is here so
 * the behaviour is bounded rather than merely unlikely to hurt.
 */
const LIST_SCAN_LIMIT = 200;

const EMPTY_FACETS = { angles: [], offers: [], states: [] } satisfies CampaignListPage['facets'];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function asUuid(value: string): Uuid {
  return value as Uuid;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readString(source: Json | null | undefined, ...path: string[]): string | null {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' && cursor.trim().length > 0 ? cursor : null;
}

function readStringArray(source: Json | null | undefined, ...path: string[]): string[] {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return [];
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? cursor.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readRecords(source: Json | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(source)) return [];
  const records: Record<string, unknown>[] = [];
  for (const entry of source) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      records.push(entry as Record<string, unknown>);
    }
  }
  return records;
}

function toIsoOrNull(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Maturity from the volume actually observed, never from how long ago the
 * campaign started. A campaign that ran a week and produced four submissions has
 * immature data whatever the calendar says.
 */
function maturityFromCount(count: number): DataMaturity {
  if (count >= 20) return 'MATURE';
  if (count >= 8) return 'PARTIAL';
  return 'IMMATURE';
}

function coverageOf(value: Rate): number | null {
  return value.value;
}

/* -------------------------------------------------------------------------- */
/* Reality                                                                     */
/* -------------------------------------------------------------------------- */

export function realityOfState(state: CampaignState, preview: boolean): CampaignReality {
  if (preview) return 'PREVIEW';
  switch (state) {
    case 'META_DRAFT_CREATED':
    case 'SCHEDULED':
      return 'META_DRAFT_PAUSED';
    case 'LIVE':
      return 'LIVE';
    case 'PAUSED':
      return 'PAUSED';
    case 'COMPLETED':
    case 'ARCHIVED':
      return 'ENDED';
    default:
      return 'DRAFT';
  }
}

/**
 * The two state changes only Meta can make true. Identical to the fixture's
 * list, and for the same reason: entering either state is a statement about the
 * provider's records, not about ours.
 */
const META_WRITING_TRANSITIONS = {
  META_DRAFT_CREATED: 'meta.create_paused_draft_campaign',
  LIVE: 'meta.resume_entity',
} as const satisfies Partial<Record<CampaignState, string>>;

function isMetaWritingTransition(to: CampaignState): to is keyof typeof META_WRITING_TRANSITIONS {
  return to in META_WRITING_TRANSITIONS;
}

function budgetLivesAtMeta(state: CampaignState): boolean {
  const reality = realityOfState(state, false);
  return reality === 'META_DRAFT_PAUSED' || reality === 'LIVE' || reality === 'PAUSED';
}

/* -------------------------------------------------------------------------- */
/* The loaded campaign                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything the header, the next action and the launch report are derived
 * from, read once. Each of those three needs most of the same rows, and reading
 * them separately turns one page render into a dozen round trips.
 */
interface CampaignBundle {
  db: AmDatabase;
  campaign: CampaignRow;
  approvals: Map<ApprovalKind, ApprovalRow>;
  concepts: CreativeConceptRow[];
  funnels: FunnelRow[];
  funnelVersions: Map<Uuid, FunnelVersionRow[]>;
  published: PublishedFunnelRow[];
  experiment: ExperimentRow | null;
  version: CampaignVersionRow | null;
  proposal: CampaignProposalRow | null;
  rollups: PerformanceRollupRow[];
  workspace: WorkspaceContext;
}

/**
 * Provider and workspace state, which every campaign of a workspace shares.
 *
 * Read once per request rather than once per campaign: the list page renders up
 * to a page of campaigns, and reading integration health and the HubSpot mapping
 * again for each of them is four extra round trips per row for four identical
 * answers.
 */
interface WorkspaceContext {
  metaHealth: HealthStatus;
  metaDetailDe: string;
  metaLastSyncedAt: string | null;
  hubspotHealth: HealthStatus;
  hubspotDetailDe: string;
  hubspotLastSyncedAt: string | null;
  hubspotFailedCount: number;
  consentVersionId: string | null;
  hubspotMappingMissing: string[];
}

/** Rows a batched loader already has, so a bundle does not re-fetch them. */
interface PreloadedCampaignRows {
  approvals: ApprovalRow[];
  concepts: CreativeConceptRow[];
  version: CampaignVersionRow | null;
  proposal: CampaignProposalRow | null;
  rollups: PerformanceRollupRow[];
}

export class DatabaseCampaignPort implements CampaignPort {
  private readonly options: CampaignDatabaseOptions;

  constructor(options: CampaignDatabaseOptions) {
    this.options = options;
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /**
   * The workspace the list reads.
   *
   * Resolved from the slug through `workspaceResolver` rather than taken from
   * the option, because a pinned uuid that does not match the row in the
   * database fails in the worst possible way: every query succeeds, every screen
   * renders, and every list is empty with nothing on the page to say why. Cached
   * on the instance — the id belongs to the deployment, not to the request.
   */
  private workspaceIdPromise: Promise<Uuid> | null = null;

  private workspaceId(db: AmDatabase): Promise<Uuid> {
    this.workspaceIdPromise ??= workspaceResolver(db, this.options.workspaceId)();
    return this.workspaceIdPromise;
  }

  private db(): Promise<AmDatabase> {
    return this.options.database();
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The campaign, or `null` when this caller may not see it.
   *
   * RLS answers "not a member of that workspace" with an empty result, and
   * "no privilege on the table at all" with `42501`. Both mean the same thing to
   * a screen — there is nothing here for you — and only one of them is a
   * configuration problem, so the second is logged and then rendered as the
   * first. Letting the privilege error escape would replace `notFound()` with a
   * stack trace on a page the operator simply may not open.
   */
  private async visibleCampaign(db: AmDatabase, campaignId: string): Promise<CampaignRow | null> {
    try {
      return await db.campaigns.getById(asUuid(campaignId));
    } catch (error) {
      if (!isRefusal(error)) throw error;
      logger.warn('campaign_read_refused', { campaign_id: campaignId });
      return null;
    }
  }

  private async loadWorkspaceContext(db: AmDatabase, workspaceId: Uuid): Promise<WorkspaceContext> {
    const [health, settings, missingMappings, failedAttempts] = await Promise.all([
      db.integrations.latestHealth(workspaceId),
      db.settings.getSettings(workspaceId),
      db.hubspot.missingMappings(workspaceId),
      db.hubspot.listFailedAttempts(workspaceId),
    ]);

    const metaChecks = health.filter((check) => check.provider === 'META');
    const hubspotChecks = health.filter((check) => check.provider === 'HUBSPOT');

    return {
      metaHealth: worstStatus(metaChecks.map((check) => check.status)),
      metaDetailDe:
        metaChecks[0]?.detail_de ??
        'Für Meta liegt keine Prüfung vor; es ist kein Werbekonto verbunden.',
      metaLastSyncedAt: metaChecks[0]?.checked_at ?? null,
      hubspotHealth: worstStatus(hubspotChecks.map((check) => check.status)),
      hubspotDetailDe:
        hubspotChecks[0]?.detail_de ??
        'Für HubSpot liegt keine Prüfung vor; das Pflichtmapping ist nicht bestätigt.',
      hubspotLastSyncedAt: hubspotChecks[0]?.checked_at ?? null,
      hubspotFailedCount: failedAttempts.length,
      consentVersionId: settings.active_consent_version_id,
      hubspotMappingMissing: Object.values(missingMappings).flat(),
    };
  }

  private rollupWindow(): { since: string; until: string } {
    return {
      since: isoDay(new Date(this.now().getTime() - PERFORMANCE_WINDOW_DAYS * 86_400_000)),
      until: isoDay(this.now()),
    };
  }

  private async loadBundle(
    db: AmDatabase,
    campaign: CampaignRow,
    workspace: WorkspaceContext,
    preloaded?: PreloadedCampaignRows,
  ): Promise<CampaignBundle> {
    const id = campaign.id;
    const window = this.rollupWindow();

    /*
     * `funnels`, `published_funnels` and `experiments` have no batched loader by
     * campaign in `@am/db`, so these three stay per campaign even in the list
     * path. Everything else the list needs comes from a batched loader.
     */
    const [funnels, published, experiments, rows] = await Promise.all([
      db.funnels.listByCampaign(id),
      db.funnels.listPublished(id),
      db.experiments.listByCampaign(id),
      preloaded
        ? Promise.resolve(preloaded)
        : (async (): Promise<PreloadedCampaignRows> => {
            const [approvals, concepts, version, proposal, rollups] = await Promise.all([
              db.campaigns.listApprovals(id),
              db.creatives.listConcepts(id),
              campaign.current_version_id
                ? db.campaigns.getVersion(campaign.current_version_id)
                : null,
              db.proposals.getAccepted(id),
              db.rollups.query({
                workspaceId: campaign.workspace_id,
                dimension: 'campaign',
                ids: [id],
                since: window.since,
                until: window.until,
              }),
            ]);
            return { approvals, concepts, version, proposal, rollups };
          })(),
    ]);

    const funnelVersions = await db.funnels.loadVersionsForFunnels(funnels.map((row) => row.id));

    const approvals = new Map<ApprovalKind, ApprovalRow>();
    // Newest first, so the first row per kind is the one that is live.
    for (const row of rows.approvals) if (!approvals.has(row.kind)) approvals.set(row.kind, row);

    return {
      db,
      campaign,
      approvals,
      concepts: rows.concepts,
      funnels,
      funnelVersions,
      published,
      experiment: experiments[0] ?? null,
      version: rows.version,
      proposal: rows.proposal,
      rollups: rows.rollups,
      workspace,
    };
  }

  private async load(campaignId: string): Promise<CampaignBundle | null> {
    const db = await this.db();
    const campaign = await this.visibleCampaign(db, campaignId);
    if (!campaign) return null;
    const workspace = await this.loadWorkspaceContext(db, campaign.workspace_id);
    return this.loadBundle(db, campaign, workspace);
  }

  /* ------------------------------------------------------------------ */
  /* Derived values                                                      */
  /* ------------------------------------------------------------------ */

  private approvalOf(bundle: CampaignBundle, kind: ApprovalKind): Approval {
    const row = bundle.approvals.get(kind);
    if (row) return toApproval(row);
    // No row is a legitimate state: the approval has not been requested yet.
    return {
      id: `${bundle.campaign.id}:${kind}`,
      campaign_id: bundle.campaign.id,
      kind,
      state: 'PENDING',
      approved_content_hash: null,
      approved_by: null,
      approved_at: null,
      rejected_reason_de: null,
      invalidated_at: null,
      invalidated_reason_de: null,
      created_at: bundle.campaign.created_at,
    };
  }

  private currentHash(bundle: CampaignBundle, kind: ApprovalKind): string {
    switch (kind) {
      case 'STRATEGY':
        return strategyContentHash({
          angle: bundle.campaign.angle_version_id ?? angleNameOf(bundle),
          offer: bundle.campaign.offer_version_id ?? offerNameOf(bundle),
          // The `claims` table has no repository in `@am/db`, so a claim change
          // reaches this hash only through the campaign version it produces.
          claims: [],
          coreMessage: bundle.campaign.core_message ?? '',
          versionHash: bundle.version?.content_hash ?? null,
        });
      case 'ASSETS':
        return assetsContentHash({
          creatives: approvedConceptKeys(bundle.concepts),
          funnels: bundle.funnels.map((row) => row.funnel_key),
        });
      case 'TEST_PLAN':
        return testPlanContentHash({
          plan: bundle.experiment?.id ?? bundle.campaign.id,
          dailyBudgetMinor: bundle.campaign.daily_budget_minor,
        });
      default:
        return publishContentHash({ publish: bundle.campaign.slug });
    }
  }

  private approvalStatus(bundle: CampaignBundle, kind: ApprovalKind): ApprovalStatus {
    const approval = this.approvalOf(bundle, kind);
    const hash = this.currentHash(bundle, kind);
    const valid = isApprovalValid(approval, hash);
    return {
      kind,
      approval,
      currentContentHash: hash,
      valid,
      // `profiles` has no repository, so the id cannot be resolved to a name
      // here. A uuid in place of a person is worse than no name at all.
      approverName: null,
      invalidatedByDe:
        approval.state === 'APPROVED' && !valid
          ? 'Der Inhalt wurde nach der Freigabe geändert. Die Freigabe deckt den aktuellen Stand nicht mehr ab.'
          : (approval.invalidated_reason_de ?? null),
    };
  }

  private allApprovals(bundle: CampaignBundle): ApprovalStatus[] {
    return CAMPAIGN_APPROVAL_KINDS.map((kind) => this.approvalStatus(bundle, kind));
  }

  private diversityOf(bundle: CampaignBundle): DiversityCheckView {
    const approved = bundle.concepts.filter((row) => row.review_state === 'APPROVED');
    const hashed = approved.filter((row) => row.diversity_hash !== null);
    const required = GENERATION_DEFAULTS.minApprovedCreatives;

    if (hashed.length === 0) {
      // The diversity check runs in the generation pipeline and writes
      // `diversity_hash`. Without it there is no verdict — and claiming "no
      // collisions" from an absence of data is exactly the fabrication this
      // check exists to prevent.
      return {
        distinctCount: approved.length,
        requiredDistinct: required,
        blocked: false,
        reasonsDe: [
          'Für diese Kampagne wurde noch keine Ähnlichkeitsprüfung der Creatives ausgeführt; die Konzepte tragen keinen Diversity-Hash.',
        ],
        collisions: [],
        evaluatedAt: null,
      };
    }

    const byHash = new Map<string, CreativeConceptRow[]>();
    for (const row of hashed) {
      const bucket = byHash.get(row.diversity_hash as string);
      if (bucket) bucket.push(row);
      else byHash.set(row.diversity_hash as string, [row]);
    }

    const collisions = [...byHash.values()]
      .filter((bucket) => bucket.length > 1)
      .flatMap((bucket) =>
        bucket.slice(1).map((other) => {
          const first = bucket[0] as CreativeConceptRow;
          return {
            aKey: first.concept_key,
            aName: first.name,
            bKey: other.concept_key,
            bName: other.name,
            overall: 1,
            samePrinciple: first.principle === other.principle,
            reasonDe: `„${first.name}" und „${other.name}" tragen denselben Diversity-Hash und zählen deshalb als ein Konzept. Ersetzen Sie eines der beiden, bevor Sie die Assets freigeben.`,
          };
        }),
      );

    const distinctCount = byHash.size + (approved.length - hashed.length);
    const blocked = distinctCount < required;
    return {
      distinctCount,
      requiredDistinct: required,
      blocked,
      reasonsDe: blocked
        ? [
            `Nur ${distinctCount} von ${approved.length} freigegebenen Konzepten sind konzeptionell unterschiedlich, erforderlich sind ${required}.`,
          ]
        : [],
      collisions,
      evaluatedAt: latestTimestamp(hashed.map((row) => row.updated_at)),
    };
  }

  private providerSyncOf(bundle: CampaignBundle): ProviderSyncStatus[] {
    return [
      {
        provider: 'META',
        connection: bundle.workspace.metaHealth === 'PASS' ? 'CONNECTED' : 'NOT_CONFIGURED',
        health: bundle.workspace.metaHealth,
        detailDe: bundle.workspace.metaDetailDe,
        lastSyncedAt: bundle.workspace.metaLastSyncedAt,
        failedCount: bundle.campaign.error_state === 'META_SYNC_FAILED' ? 1 : 0,
      },
      {
        provider: 'HUBSPOT',
        connection: bundle.workspace.hubspotHealth === 'PASS' ? 'CONNECTED' : 'NOT_CONFIGURED',
        health: bundle.workspace.hubspotFailedCount > 0 ? 'WARN' : bundle.workspace.hubspotHealth,
        detailDe:
          bundle.workspace.hubspotFailedCount > 0
            ? `${bundle.workspace.hubspotFailedCount} Lead-Übertragungen sind fehlgeschlagen und werden wiederholt.`
            : bundle.workspace.hubspotDetailDe,
        lastSyncedAt: bundle.workspace.hubspotLastSyncedAt,
        failedCount: bundle.workspace.hubspotFailedCount,
      },
    ];
  }

  private primaryMetricOf(bundle: CampaignBundle): MetricValue {
    const metric: MetricKey = bundle.campaign.primary_metric ?? 'cpl';
    const totals = foldRollups(bundle.rollups);
    if (bundle.rollups.length === 0) {
      return {
        metric,
        numerator: null,
        denominator: null,
        value: null,
        currency: bundle.campaign.currency,
        maturity: 'IMMATURE',
        attributionCoverage: null,
      };
    }
    return {
      metric,
      numerator: totals.spendMinor,
      denominator: totals.submissions,
      value: totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
      currency: bundle.campaign.currency,
      maturity: maturityFromCount(totals.submissions),
      attributionCoverage: averageCoverage(bundle.rollups),
    };
  }

  private launchChecks(bundle: CampaignBundle): LaunchCheckResult[] {
    const approvals = new Map(this.allApprovals(bundle).map((status) => [status.kind, status]));
    const strategyOk = approvals.get('STRATEGY')?.valid === true;
    const planOk = approvals.get('TEST_PLAN')?.valid === true;
    const approved = approvedConceptKeys(bundle.concepts);
    const diversity = this.diversityOf(bundle);
    const id = bundle.campaign.id;
    const href = (tab: Parameters<typeof campaignTabHref>[1]): string => campaignTabHref(id, tab);

    const evaluate = (
      key: (typeof LAUNCH_CHECK_KEYS)[number],
    ): { status: HealthStatus; detailDe: string; remediationDe: string | null; href: string } => {
      switch (key) {
        case 'angle_approved':
        case 'offer_approved':
        case 'claims_approved':
          return strategyOk
            ? {
                status: 'PASS',
                detailDe: 'Freigabe „Strategie" liegt vor und deckt den aktuellen Stand.',
                remediationDe: null,
                href: href('strategie'),
              }
            : {
                status: 'FAIL',
                detailDe: 'Die Strategiefreigabe fehlt oder ist durch eine Änderung ungültig geworden.',
                remediationDe: 'Strategie prüfen und erneut freigeben.',
                href: href('strategie'),
              };
        case 'creatives_approved':
          return approved.length >= GENERATION_DEFAULTS.minApprovedCreatives
            ? {
                status: 'PASS',
                detailDe: `${approved.length} von ${bundle.concepts.length} Creatives freigegeben.`,
                remediationDe: null,
                href: href('creatives'),
              }
            : {
                status: 'FAIL',
                detailDe: `Nur ${approved.length} von mindestens ${GENERATION_DEFAULTS.minApprovedCreatives} erforderlichen Creatives sind freigegeben.`,
                remediationDe: 'Fehlende Creatives prüfen und freigeben.',
                href: href('creatives'),
              };
        case 'creatives_distinct':
          if (diversity.evaluatedAt === null) {
            return {
              status: 'WARN',
              detailDe:
                diversity.reasonsDe[0] ??
                'Die Ähnlichkeitsprüfung der Creatives wurde für diese Kampagne noch nicht ausgeführt.',
              remediationDe: 'Creative-Generierung erneut ausführen, damit die Konzepte geprüft werden.',
              href: href('creatives'),
            };
          }
          return diversity.blocked
            ? {
                status: 'FAIL',
                detailDe: diversity.reasonsDe[0] ?? 'Zu wenige konzeptionell unterschiedliche Creatives.',
                remediationDe: 'Eines der kollidierenden Konzepte ersetzen.',
                href: href('creatives'),
              }
            : {
                status: 'PASS',
                detailDe: `${diversity.distinctCount} konzeptionell unterschiedliche Creatives.`,
                remediationDe: null,
                href: href('creatives'),
              };
        case 'funnel_versions_published':
          return bundle.published.some((row) => row.is_live)
            ? {
                status: 'PASS',
                detailDe: `${bundle.published.filter((row) => row.is_live).length} Funnel-Versionen veröffentlicht.`,
                remediationDe: null,
                href: href('funnel'),
              }
            : {
                status: 'FAIL',
                detailDe: 'Für diese Kampagne ist keine Funnel-Version veröffentlicht.',
                remediationDe: 'Funnel-Version im Builder veröffentlichen.',
                href: href('funnel'),
              };
        case 'experiment_plan_complete':
          return bundle.experiment
            ? planOk
              ? {
                  status: 'PASS',
                  detailDe: 'Testplan ist vollständig und freigegeben.',
                  remediationDe: null,
                  href: href('testplan'),
                }
              : {
                  status: 'FAIL',
                  detailDe: 'Der Testplan ist nicht freigegeben.',
                  remediationDe: 'Testplan prüfen und freigeben.',
                  href: href('testplan'),
                }
            : {
                status: 'FAIL',
                detailDe: 'Für diese Kampagne ist kein Experiment angelegt.',
                remediationDe: 'Testplan anlegen und freigeben.',
                href: href('testplan'),
              };
        case 'primary_metric_defined':
          return bundle.campaign.primary_metric
            ? {
                status: 'PASS',
                detailDe: `Primärmetrik: ${bundle.campaign.primary_metric}.`,
                remediationDe: null,
                href: href('testplan'),
              }
            : {
                status: 'FAIL',
                detailDe: 'Es ist keine Primärmetrik hinterlegt.',
                remediationDe: 'Primärmetrik im Testplan festlegen.',
                href: href('testplan'),
              };
        case 'min_volume_defined':
          return hasThreshold(bundle.experiment?.thresholds, 'minSessionsPerArm')
            ? {
                status: 'PASS',
                detailDe: 'Mindestvolumen je Arm ist im Experiment hinterlegt.',
                remediationDe: null,
                href: href('testplan'),
              }
            : {
                status: 'FAIL',
                detailDe: 'Für das Experiment ist kein Mindestvolumen je Arm hinterlegt.',
                remediationDe: 'Mindestvolumen im Testplan festlegen.',
                href: href('testplan'),
              };
        case 'budget_and_limits_defined':
          return bundle.campaign.daily_budget_minor > 0
            ? {
                status: 'PASS',
                detailDe: 'Tagesbudget und Testbudget sind hinterlegt.',
                remediationDe: null,
                href: href('testplan'),
              }
            : {
                status: 'FAIL',
                detailDe: 'Es ist kein Tagesbudget hinterlegt.',
                remediationDe: 'Budget im Testplan festlegen.',
                href: href('testplan'),
              };
        case 'target_urls_reachable':
        case 'variant_assignment_working':
        case 'event_tracking_working':
          // These three are runtime probes against the published funnel. Nothing
          // in the schema records their outcome, so the port does not pretend to
          // know it.
          return {
            status: 'AWAITING_EXTERNAL_INPUT',
            detailDe: 'Diese Prüfung wird gegen die veröffentlichte Funnel-Laufzeit ausgeführt; ein Ergebnis ist nicht gespeichert.',
            remediationDe: 'Prüfung im Funnel-Builder ausführen.',
            href: href('funnel'),
          };
        case 'consent_version_set':
          return bundle.workspace.consentVersionId
            ? {
                status: 'PASS',
                detailDe: 'Eine aktive Consent-Version ist in den Workspace-Einstellungen hinterlegt.',
                remediationDe: null,
                href: '/einstellungen',
              }
            : {
                status: 'FAIL',
                detailDe: 'Es ist keine aktive Consent-Version hinterlegt.',
                remediationDe: 'Consent-Version in den Einstellungen aktivieren.',
                href: '/einstellungen',
              };
        case 'no_critical_sync_errors':
          return bundle.campaign.error_state
            ? {
                status: 'FAIL',
                detailDe:
                  bundle.campaign.error_detail_de ??
                  'Für diese Kampagne ist ein Synchronisationsfehler vermerkt.',
                remediationDe: 'Fehlerhafte Synchronisation unter Integrationen prüfen und erneut ausführen.',
                href: '/integrationen',
              }
            : {
                status: 'PASS',
                detailDe: 'Keine kritischen Syncfehler.',
                remediationDe: null,
                href: '/integrationen',
              };
        case 'hubspot_mapping_complete':
          return bundle.workspace.hubspotMappingMissing.length === 0
            ? {
                status: 'PASS',
                detailDe: 'Das HubSpot-Pflichtmapping ist vollständig.',
                remediationDe: null,
                href: '/integrationen',
              }
            : {
                status: 'AWAITING_EXTERNAL_INPUT',
                detailDe: `Es fehlen ${bundle.workspace.hubspotMappingMissing.length} Pflichtfelder im HubSpot-Mapping.`,
                remediationDe: 'Mapping-Assistenten mit RevOps durchgehen, sobald die Property-Namen vorliegen.',
                href: '/integrationen',
              };
        case 'hubspot_test_lead_successful':
          return {
            status: 'AWAITING_EXTERNAL_INPUT',
            detailDe: 'Es ist kein erfolgreicher HubSpot-Test-Lead vermerkt.',
            remediationDe: 'Zuerst das HubSpot-Mapping abschließen und einen Test-Lead senden.',
            href: '/integrationen',
          };
        case 'contact_deal_association_verified':
          return {
            status: 'AWAITING_EXTERNAL_INPUT',
            detailDe: 'Die Contact-/Deal-Association ist erst nach einem echten Test-Lead prüfbar.',
            remediationDe: 'Nach dem Test-Lead erneut prüfen.',
            href: '/integrationen',
          };
        case 'meta_permissions_valid':
          return bundle.workspace.metaHealth === 'PASS'
            ? {
                status: 'PASS',
                detailDe: bundle.workspace.metaDetailDe,
                remediationDe: null,
                href: '/integrationen',
              }
            : {
                status: 'AWAITING_EXTERNAL_INPUT',
                detailDe: bundle.workspace.metaDetailDe,
                remediationDe: 'Meta-Werbekonto unter Integrationen verbinden.',
                href: '/integrationen',
              };
        case 'pixel_capi_dedup_tested':
          return {
            status: 'AWAITING_EXTERNAL_INPUT',
            detailDe: 'Die Deduplizierung ist ohne verbundenes Pixel nicht messbar.',
            remediationDe: 'Pixel und Conversions API unter Integrationen verbinden.',
            href: '/integrationen',
          };
        default:
          return {
            status: 'AWAITING_EXTERNAL_INPUT',
            detailDe: NOT_RECORDED_DE,
            remediationDe: null,
            href: href('launch-qa'),
          };
      }
    };

    return LAUNCH_CHECK_KEYS.map((key) => {
      const result = evaluate(key);
      return {
        key,
        labelDe: LAUNCH_CHECK_LABELS_DE[key],
        status: result.status,
        detailDe: result.detailDe,
        remediationDe: result.remediationDe,
        blocksLiveOnly: LIVE_ONLY_CHECKS.includes(key),
        href: result.href,
      };
    });
  }

  private nextActionOf(bundle: CampaignBundle): NextRequiredAction {
    const id = bundle.campaign.id;
    const approvals = new Map(this.allApprovals(bundle).map((status) => [status.kind, status]));
    const strategy = approvals.get('STRATEGY');
    const assets = approvals.get('ASSETS');
    const plan = approvals.get('TEST_PLAN');
    const publish = approvals.get('PUBLISH');
    const approvedCount = approvedConceptKeys(bundle.concepts).length;
    const diversity = this.diversityOf(bundle);

    if (strategy?.valid !== true) {
      const stale = strategy?.approval.state === 'APPROVED' || strategy?.approval.state === 'INVALIDATED';
      return {
        key: 'approve_strategy',
        labelDe: stale ? 'Strategie erneut freigeben' : 'Strategie freigeben',
        detailDe: stale
          ? 'Der Inhalt wurde nach der Freigabe geändert. Die Freigabe deckt den aktuellen Stand nicht mehr ab.'
          : 'Angle, Offer und Claims müssen freigegeben werden, bevor Assets erzeugt werden.',
        href: campaignTabHref(id, 'strategie'),
        permission: 'campaign.approve_strategy',
        blocked: false,
        blockedReasonDe: null,
      };
    }

    if (assets?.valid !== true) {
      const blocked = diversity.blocked || approvedCount < GENERATION_DEFAULTS.minApprovedCreatives;
      return {
        key: 'approve_assets',
        labelDe: 'Creatives und Funnel freigeben',
        detailDe: `${approvedCount} von mindestens ${GENERATION_DEFAULTS.minApprovedCreatives} Creatives sind freigegeben.`,
        href: campaignTabHref(id, 'creatives'),
        permission: 'campaign.approve_assets',
        blocked,
        blockedReasonDe: blocked
          ? diversity.blocked
            ? `Nur ${diversity.distinctCount} von ${diversity.requiredDistinct} erforderlichen Creatives sind konzeptionell unterschiedlich.`
            : `Es sind erst ${approvedCount} von ${GENERATION_DEFAULTS.minApprovedCreatives} erforderlichen Creatives freigegeben.`
          : null,
      };
    }

    if (plan?.valid !== true) {
      return {
        key: 'approve_test_plan',
        labelDe: 'Testplan freigeben',
        detailDe: 'Hypothese, Metriken, Mindestvolumen, Stop- und Skalierungsregeln prüfen.',
        href: campaignTabHref(id, 'testplan'),
        permission: 'campaign.approve_test_plan',
        blocked: false,
        blockedReasonDe: null,
      };
    }

    const report = summarizeLaunchQa(id, this.launchChecks(bundle), this.now().toISOString());
    const state = bundle.campaign.state;

    if (state === 'READY_FOR_LAUNCH_QA' || state === 'TEST_PLAN_REVIEW') {
      return {
        key: 'run_launch_qa',
        labelDe: 'Launch-QA abschließen',
        detailDe: `${report.blockingDe.length} blockierende Prüfungen, ${report.awaitingExternalDe.length} warten auf externen Input.`,
        href: campaignTabHref(id, 'launch-qa'),
        permission: 'campaign.publish',
        blocked: !report.canCreateMetaDraft,
        blockedReasonDe: report.canCreateMetaDraft ? null : `Blockiert durch: ${report.blockingDe.join(', ')}.`,
      };
    }

    if (state === 'READY_FOR_META_DRAFT') {
      return {
        key: 'create_meta_draft',
        labelDe: 'Pausierten Meta-Entwurf erstellen',
        detailDe: 'Der Entwurf wird pausiert angelegt und schaltet nichts live.',
        href: campaignTabHref(id, 'launch-qa'),
        permission: 'campaign.publish',
        blocked: !report.canCreateMetaDraft,
        blockedReasonDe: report.canCreateMetaDraft ? null : `Blockiert durch: ${report.blockingDe.join(', ')}.`,
      };
    }

    if (state === 'META_DRAFT_CREATED' || state === 'SCHEDULED') {
      const blockedReasonDe = report.canGoLive
        ? null
        : `Live-Schaltung blockiert: ${[...report.blockingDe, ...report.awaitingExternalDe].join(', ')}.`;
      if (publish?.valid !== true) {
        return {
          key: 'approve_publish',
          labelDe: 'Veröffentlichung freigeben',
          detailDe: 'Ohne Veröffentlichungsfreigabe bleibt der Meta-Entwurf pausiert.',
          href: campaignTabHref(id, 'launch-qa'),
          permission: 'campaign.publish',
          blocked: !report.canGoLive,
          blockedReasonDe,
        };
      }
      return {
        key: 'go_live',
        labelDe: 'Kampagne live schalten',
        detailDe: 'Der pausierte Entwurf wird aktiviert.',
        href: campaignTabHref(id, 'launch-qa'),
        permission: 'campaign.publish',
        blocked: !report.canGoLive,
        blockedReasonDe,
      };
    }

    if (state === 'LIVE') {
      return {
        key: 'review_recommendations',
        labelDe: 'Offene Empfehlungen entscheiden',
        detailDe: 'Offene Empfehlungen dieser Kampagne prüfen und entscheiden.',
        href: campaignTabHref(id, 'empfehlungen'),
        permission: 'recommendation.execute',
        blocked: false,
        blockedReasonDe: null,
      };
    }

    if (state === 'PAUSED') {
      return {
        key: 'resume_or_conclude',
        labelDe: 'Fortsetzen oder abschließen',
        detailDe: 'Die Kampagne ist pausiert und liefert keine Impressionen aus.',
        href: campaignTabHref(id, 'live-performance'),
        permission: 'campaign.pause',
        blocked: false,
        blockedReasonDe: null,
      };
    }

    if (state === 'COMPLETED') {
      return {
        key: 'review_learnings',
        labelDe: 'Learnings prüfen und archivieren',
        detailDe: 'Die Kampagne ist abgeschlossen; die Learnings sind erzeugt.',
        href: campaignTabHref(id, 'learnings'),
        permission: 'campaign.archive',
        blocked: false,
        blockedReasonDe: null,
      };
    }

    return {
      key: 'advance_state',
      labelDe: 'Nächsten Schritt auslösen',
      detailDe: `Aktueller Status: ${state}.`,
      href: campaignTabHref(id, 'strategie'),
      permission: 'campaign.edit',
      blocked: false,
      blockedReasonDe: null,
    };
  }

  private headerOf(bundle: CampaignBundle, preview: boolean): CampaignHeaderView {
    const approvals = this.allApprovals(bundle);
    const valid = new Map(approvals.map((status) => [status.kind, status.valid]));
    const allowed = ALL_CAMPAIGN_STATES.filter(
      (to) =>
        canTransition(bundle.campaign.state, to) &&
        (REQUIRED_APPROVALS_FOR_STATE[to] ?? []).every((kind) => valid.get(kind) === true),
    );

    return {
      id: bundle.campaign.id,
      name: bundle.campaign.name,
      state: bundle.campaign.state,
      errorState: bundle.campaign.error_state,
      reality: realityOfState(bundle.campaign.state, preview),
      angleName: angleNameOf(bundle),
      offerName: offerNameOf(bundle),
      audienceName: readString(bundle.version?.spec ?? null, 'audience') ?? NOT_RECORDED_DE,
      primaryMetric: this.primaryMetricOf(bundle),
      primaryMetricTarget:
        bundle.campaign.primary_metric === 'cost_per_qualified_vq'
          ? bundle.campaign.target_cost_per_qualified_vq_minor
          : bundle.campaign.target_cpl_minor,
      budget: {
        amountMinor: bundle.campaign.daily_budget_minor,
        currency: bundle.campaign.currency,
      },
      approvals,
      nextAction: this.nextActionOf(bundle),
      providerSync: this.providerSyncOf(bundle),
      allowedTransitions: allowed,
      updatedAt: bundle.campaign.updated_at,
    };
  }

  private rowOf(bundle: CampaignBundle): CampaignListRow {
    return {
      id: bundle.campaign.id,
      name: bundle.campaign.name,
      state: bundle.campaign.state,
      errorState: bundle.campaign.error_state,
      reality: realityOfState(bundle.campaign.state, false),
      angleName: angleNameOf(bundle),
      offerName: offerNameOf(bundle),
      primaryMetric: this.primaryMetricOf(bundle),
      budget: {
        amountMinor: bundle.campaign.daily_budget_minor,
        currency: bundle.campaign.currency,
      },
      nextAction: this.nextActionOf(bundle),
      providerSync: this.providerSyncOf(bundle),
      updatedAt: bundle.campaign.updated_at,
    };
  }

  private metaWritePreviews(bundle: CampaignBundle): MetaWritePreview[] {
    const key = `campaign-draft-${bundle.campaign.slug}`;
    const name = `AM | ${bundle.campaign.name}`;
    return [
      {
        to: 'META_DRAFT_CREATED',
        operation: META_WRITING_TRANSITIONS.META_DRAFT_CREATED,
        payload: {
          // Ids that can only come from a connected ad account stay null; an
          // invented account or pixel id in a preview is a fabricated external
          // fact even when nothing is sent.
          ad_account_id: null,
          page_id: null,
          pixel_id: null,
          idempotency_key: key,
          campaign: {
            name,
            objective: 'OUTCOME_LEADS',
            status: 'PAUSED',
            special_ad_categories: [],
            daily_budget: bundle.campaign.daily_budget_minor,
            currency: bundle.campaign.currency,
          },
          ad_sets: bundle.funnels.map((row) => ({ name: `${name} | ${row.name}`, status: 'PAUSED' })),
          ads: bundle.concepts
            .filter((row) => row.review_state === 'APPROVED')
            .map((row) => ({ name: `${name} | ${row.name}`, status: 'PAUSED' })),
        },
      },
      {
        to: 'LIVE',
        operation: META_WRITING_TRANSITIONS.LIVE,
        payload: {
          campaign_id: null,
          status: 'ACTIVE',
          daily_budget: bundle.campaign.daily_budget_minor,
          currency: bundle.campaign.currency,
        },
      },
    ];
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  async listCampaigns(query: CampaignListQuery): Promise<CampaignListPage> {
    const db = await this.db();
    const workspaceId = await this.workspaceId(db);
    const page = await db.campaigns.list({
      workspaceId,
      states: query.states.length > 0 ? query.states : undefined,
      search: query.search ?? undefined,
      limit: LIST_SCAN_LIMIT,
      offset: 0,
      orderBy: 'updated_at',
      direction: 'desc',
    });
    if (page.rows.length === 0) {
      return { rows: [], total: 0, page: query.page, pageSize: query.pageSize, facets: EMPTY_FACETS };
    }

    const ids = page.rows.map((row) => row.id);
    const window = this.rollupWindow();

    /*
     * Facets and filters are computed over the whole set, so the cheap batched
     * loaders run for all of it; the expensive per-campaign reads run only for
     * the rows that end up on screen. Loading everything for every campaign is
     * what turns one list render into hundreds of round trips.
     */
    const [workspace, approvals, concepts, versions, proposals, rollups] = await Promise.all([
      this.loadWorkspaceContext(db, workspaceId),
      db.campaigns.loadApprovalsForCampaigns(ids),
      db.creatives.loadConceptsForCampaigns(ids),
      db.campaigns.loadVersionsForCampaigns(ids),
      db.proposals.loadForCampaigns(ids),
      db.rollups.query({ workspaceId, dimension: 'campaign', ids, since: window.since, until: window.until }),
    ]);

    const rollupsByCampaign = new Map<Uuid, PerformanceRollupRow[]>();
    for (const row of rollups) {
      if (!row.campaign_id) continue;
      const bucket = rollupsByCampaign.get(row.campaign_id);
      if (bucket) bucket.push(row);
      else rollupsByCampaign.set(row.campaign_id, [row]);
    }

    const preloaded = new Map<Uuid, PreloadedCampaignRows>(
      page.rows.map((campaign) => [
        campaign.id,
        {
          approvals: approvals.get(campaign.id) ?? [],
          concepts: concepts.get(campaign.id) ?? [],
          version:
            (versions.get(campaign.id) ?? []).find((row) => row.id === campaign.current_version_id) ??
            null,
          proposal: (proposals.get(campaign.id) ?? []).find((row) => row.accepted) ?? null,
          rollups: rollupsByCampaign.get(campaign.id) ?? [],
        },
      ]),
    );

    // Only the fields the filters and facets read, from the batched rows alone.
    const identities = page.rows.map((campaign) => {
      const rows = preloaded.get(campaign.id) as PreloadedCampaignRows;
      return {
        campaign,
        angleName: angleNameFrom(rows.version, rows.proposal),
        offerName: offerNameFrom(rows.version, rows.proposal),
      };
    });

    const facets = {
      angles: [...new Set(identities.map((entry) => entry.angleName))].sort(),
      offers: [...new Set(identities.map((entry) => entry.offerName))].sort(),
      states: [...new Set(identities.map((entry) => entry.campaign.state))],
    };

    const matching = identities.filter((entry) =>
      matchesListQuery(entry.campaign, entry.angleName, entry.offerName, query),
    );
    const start = (query.page - 1) * query.pageSize;
    const visible = matching.slice(start, start + query.pageSize);

    // `Promise.all` keeps the order of `visible`, so the page stays sorted.
    const rows: CampaignListRow[] = await Promise.all(
      visible.map(async (entry) => {
        const bundle = await this.loadBundle(
          db,
          entry.campaign,
          workspace,
          preloaded.get(entry.campaign.id),
        );
        return this.rowOf(bundle);
      }),
    );

    return {
      rows,
      total: matching.length,
      page: query.page,
      pageSize: query.pageSize,
      facets,
    };
  }

  async getHeader(campaignId: string, preview: boolean): Promise<CampaignHeaderView | null> {
    const bundle = await this.load(campaignId);
    return bundle ? this.headerOf(bundle, preview) : null;
  }

  async getStrategy(campaignId: string): Promise<StrategyView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;

    const knowledge = await bundle.db.settings.brandKnowledge(bundle.campaign.workspace_id, {
      approvedOnly: true,
    });
    const audience = knowledge.audiences.find((row) => row.id === bundle.campaign.audience_segment_id);
    const offer = knowledge.offers.find((row) => row.id === bundle.campaign.offer_id);
    const proposal = bundle.proposal?.proposal ?? null;

    return {
      campaignId: bundle.campaign.id,
      contentHash: this.currentHash(bundle, 'STRATEGY'),
      angleName: angleNameOf(bundle),
      anglePerspective: readString(proposal, 'angle', 'perspective') ?? NOT_RECORDED_DE,
      angleRationale: readString(proposal, 'angle', 'rationale') ?? NOT_RECORDED_DE,
      offer: {
        name: offer?.name ?? offerNameOf(bundle),
        type: offer?.offer_type ?? 'LEAD_MAGNET',
        // `offer_versions.spec` carries the value exchange and the deliverable,
        // and no repository in `@am/db` reads that table.
        valueExchange: readString(proposal, 'offer', 'valueExchange') ?? NOT_RECORDED_DE,
        deliverable: readString(proposal, 'offer', 'deliverable') ?? NOT_RECORDED_DE,
        effortPromise: readString(proposal, 'offer', 'effortPromise'),
        qualificationIntent: readString(proposal, 'offer', 'qualificationIntent') ?? NOT_RECORDED_DE,
      },
      audience: {
        name: audience?.name ?? NOT_RECORDED_DE,
        description: audience?.description ?? NOT_RECORDED_DE,
        audienceSegmentId: bundle.campaign.audience_segment_id,
        companySizeRange: audience?.company_size ?? null,
        industries: audience?.industries ?? [],
        roles: audience?.roles ?? [],
        geo: 'Deutschland',
        painPoints: audience?.pain_points ?? [],
        exclusions: [],
      },
      coreMessage: bundle.campaign.core_message ?? NOT_RECORDED_DE,
      hypothesis: bundle.campaign.hypothesis ?? NOT_RECORDED_DE,
      // The `claims` table exists but has no repository; showing an empty list
      // is the only reading of "no claims are readable" that cannot be mistaken
      // for "this campaign makes no claims that need evidence".
      claims: [],
      historicalEvidence: knowledge.evidence
        .filter((row) => row.campaign_id === null || row.campaign_id === bundle.campaign.id)
        .slice(0, 5)
        .map((row) => ({
          evidenceItemId: row.id,
          kind: row.kind,
          summary: row.statement,
          sourceRef: row.source,
        })),
      risks: readStringArray(proposal, 'risks'),
      similarPastCampaigns: readRecords(bundle.proposal?.similar_campaigns ?? null).flatMap((entry) => {
        const campaignId2 = typeof entry.campaignId === 'string' ? entry.campaignId : null;
        if (!campaignId2) return [];
        return [
          {
            campaignId: campaignId2,
            campaignName: typeof entry.campaignName === 'string' ? entry.campaignName : campaignId2,
            similarity: typeof entry.similarity === 'number' ? entry.similarity : 0,
            ranAt: typeof entry.ranAt === 'string' ? entry.ranAt : null,
            outcomeSummary: typeof entry.outcomeSummary === 'string' ? entry.outcomeSummary : null,
            attributionLevel:
              typeof entry.attributionLevel === 'string' ? entry.attributionLevel : null,
          },
        ];
      }),
      differentiationFromPast: readString(proposal, 'differentiationFromPast') ?? NOT_RECORDED_DE,
      approval: this.approvalStatus(bundle, 'STRATEGY'),
    };
  }

  async getCreativeBoard(campaignId: string): Promise<CreativeBoardView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;

    const versions = await bundle.db.creatives.loadVersionsForConcepts(
      bundle.concepts.map((row) => row.id),
    );
    const currentVersions = bundle.concepts.flatMap((concept) => {
      const list = versions.get(concept.id) ?? [];
      const current = list.find((row) => row.id === concept.current_version_id) ?? list[0];
      return current ? [current] : [];
    });
    const renditions = await bundle.db.creatives.loadRenditionsForVersions(
      currentVersions.map((row) => row.id),
    );

    const creatives: CreativeCard[] = bundle.concepts.map((concept) => {
      const list = versions.get(concept.id) ?? [];
      const current = list.find((row) => row.id === concept.current_version_id) ?? list[0] ?? null;
      return {
        id: concept.id,
        key: concept.concept_key,
        concept: toCreativeConcept(concept),
        renditions: (renditions.get(current?.id ?? asUuid('')) ?? []).map((row) =>
          toRendition(row, concept.alt_text, current),
        ),
        reviewState: concept.review_state,
        // `profiles` has no repository, so the reviewer id cannot be turned into
        // a name here.
        reviewedBy: null,
        reviewedAt: toIsoOrNull(concept.reviewed_at),
        rejectedReasonDe: concept.rejection_reason_de,
      };
    });

    return {
      campaignId: bundle.campaign.id,
      contentHash: this.currentHash(bundle, 'ASSETS'),
      creatives,
      diversity: this.diversityOf(bundle),
      approvedCount: approvedConceptKeys(bundle.concepts).length,
      minApproved: GENERATION_DEFAULTS.minApprovedCreatives,
      approval: this.approvalStatus(bundle, 'ASSETS'),
    };
  }

  async getFunnelOverview(campaignId: string): Promise<FunnelOverviewView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;

    const variants: FunnelVariantView[] = bundle.funnels.map((funnel) => {
      const list = bundle.funnelVersions.get(funnel.id) ?? [];
      const current = list.find((row) => row.id === funnel.current_version_id) ?? list[0] ?? null;
      const published = bundle.published.find(
        (row) => row.funnel_id === funnel.id && row.unpublished_at === null,
      );
      const isForm = funnel.kind !== 'LANDING_PAGE';
      const versionId = current?.id ?? funnel.current_version_id ?? funnel.id;
      const formVersionId = current?.form_version_id ?? null;
      return {
        funnelId: funnel.id,
        versionId,
        formVersionId,
        name: funnel.name,
        kind: funnel.kind,
        version: current?.version ?? 1,
        state: current?.state ?? 'DRAFT',
        promise: funnel.promise ?? NOT_RECORDED_DE,
        hypothesis: funnel.hypothesis ?? NOT_RECORDED_DE,
        rationale: funnel.rationale ?? NOT_RECORDED_DE,
        qualificationQuestionCount: readQuestionCount(current),
        publishedAt: toIsoOrNull(current?.published_at),
        publicUrl: published ? publicFunnelUrl(published) : null,
        builderHref:
          isForm && formVersionId ? `/builder/form/${formVersionId}` : `/builder/page/${versionId}`,
      };
    });

    return {
      campaignId: bundle.campaign.id,
      variants,
      minMultiStepFormVariants: GENERATION_DEFAULTS.minMultiStepFormVariants,
      mixProblemsDe: validateFunnelMix(
        variants.map(
          (variant, index): FunnelProposal => ({
            key: `funnel_${index + 1}`,
            kind: variant.kind,
            name: variant.name,
            rationale: variant.rationale,
            hypothesis: variant.hypothesis,
            promise: variant.promise,
            qualificationQuestionCount: Math.min(
              7,
              Math.max(4, variant.qualificationQuestionCount || 4),
            ),
            questionOutline: [],
            resultConcept: variant.promise,
          }),
        ),
      ),
    };
  }

  async getTestPlan(campaignId: string): Promise<TestPlanView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;

    const experiment = bundle.experiment;
    const arms = experiment ? await bundle.db.experiments.listArms(experiment.id) : [];
    const thresholds = await bundle.db.settings.experimentThresholds(bundle.campaign.workspace_id);
    const control = arms.find((row) => row.is_control) ?? arms[0] ?? null;
    const spec = experiment?.thresholds ?? null;

    return {
      campaignId: bundle.campaign.id,
      contentHash: this.currentHash(bundle, 'TEST_PLAN'),
      plan: {
        kind: experimentKindOf(experiment),
        hypothesis: experiment?.hypothesis ?? bundle.campaign.hypothesis ?? NOT_RECORDED_DE,
        testVariable: experiment?.test_variable ?? NOT_RECORDED_DE,
        controlKey: control?.key ?? '',
        variantKeys: arms.filter((row) => row !== control).map((row) => row.key),
        primaryMetric: experiment?.primary_metric ?? bundle.campaign.primary_metric ?? 'cpl',
        secondaryMetrics: experiment?.secondary_metrics ?? bundle.campaign.secondary_metrics,
        guardrailMetrics: experiment?.guardrail_metrics ?? bundle.campaign.guardrail_metrics,
        minRuntimeDays: numberFrom(spec, 'minRuntimeDays') ?? thresholds.minRuntimeDays,
        maxRuntimeDays: numberFrom(spec, 'maxRuntimeDays') ?? thresholds.maxRuntimeDays,
        minSessionsPerArm: numberFrom(spec, 'minSessionsPerArm') ?? thresholds.minSessionsPerArm,
        minConversionsPerArm:
          numberFrom(spec, 'minConversionsPerArm') ?? thresholds.minConversionsPerArm,
        crmMaturityDays: numberFrom(spec, 'crmMaturityDays') ?? thresholds.crmMaturityDays,
        // Stop and scale rules are part of the approved plan and have no column
        // of their own; they reach the schema only inside `thresholds`.
        stopRules: readStringArray(spec, 'stopRules'),
        scaleRules: readStringArray(spec, 'scaleRules'),
        eligibilityChanging: experiment?.eligibility_changing ?? false,
      },
      budget: {
        dailyBudgetMinor: bundle.campaign.daily_budget_minor,
        currency: bundle.campaign.currency,
        testBudgetMinor: bundle.campaign.test_budget_minor,
        rationale:
          readString(bundle.version?.spec ?? null, 'budgetRationale') ??
          'Für dieses Budget ist keine Begründung hinterlegt.',
        targetCplMinor: bundle.campaign.target_cpl_minor,
        targetCostPerQualifiedVqMinor: bundle.campaign.target_cost_per_qualified_vq_minor,
      },
      primaryMetric: experiment?.primary_metric ?? bundle.campaign.primary_metric ?? 'cpl',
      armLabelsDe: Object.fromEntries(arms.map((row) => [row.key, row.label])),
      approval: this.approvalStatus(bundle, 'TEST_PLAN'),
    };
  }

  async getLaunchQa(campaignId: string): Promise<LaunchQaView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;
    const checks = this.launchChecks(bundle);
    return {
      campaignId: bundle.campaign.id,
      report: summarizeLaunchQa(bundle.campaign.id, checks, this.now().toISOString()),
      awaitingLiveOnlyKeys: checks
        .filter((check) => check.status === 'AWAITING_EXTERNAL_INPUT' && check.blocksLiveOnly)
        .map((check) => check.key),
      metaWrites: this.metaWritePreviews(bundle),
    };
  }

  /**
   * Version id → the operator-facing name of the concept or funnel it belongs
   * to. Rollups and attribution snapshots both reference versions, and a bare
   * uuid in a breakdown row is not a label.
   */
  private async versionLabels(
    bundle: CampaignBundle,
  ): Promise<{ creatives: Map<Uuid, string>; funnels: Map<Uuid, string> }> {
    const versions = await bundle.db.creatives.loadVersionsForConcepts(
      bundle.concepts.map((row) => row.id),
    );
    const creatives = new Map<Uuid, string>();
    for (const concept of bundle.concepts) {
      const list = versions.get(concept.id) ?? [];
      const current = list.find((row) => row.id === concept.current_version_id) ?? list[0];
      if (current) creatives.set(current.id, concept.name);
    }
    const funnels = new Map<Uuid, string>();
    for (const funnel of bundle.funnels) {
      const list = bundle.funnelVersions.get(funnel.id) ?? [];
      const current = list.find((row) => row.id === funnel.current_version_id) ?? list[0];
      if (current) funnels.set(current.id, funnel.name);
    }
    return { creatives, funnels };
  }

  async getLivePerformance(campaignId: string): Promise<LivePerformanceView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;

    const workspaceId = bundle.campaign.workspace_id;
    const since = isoDay(new Date(this.now().getTime() - PERFORMANCE_WINDOW_DAYS * 86_400_000));
    const until = isoDay(this.now());

    const labels = await this.versionLabels(bundle);
    const creativeVersionIds = [...labels.creatives.keys()];
    const funnelVersionIds = [...labels.funnels.keys()];

    const [byCreative, byFunnel] = await Promise.all([
      creativeVersionIds.length > 0
        ? bundle.db.rollups.query({
            workspaceId,
            since,
            until,
            dimension: 'creative_version',
            ids: creativeVersionIds,
          })
        : Promise.resolve([]),
      funnelVersionIds.length > 0
        ? bundle.db.rollups.query({
            workspaceId,
            since,
            until,
            dimension: 'funnel_version',
            ids: funnelVersionIds,
          })
        : Promise.resolve([]),
    ]);

    const totals = foldRollups(bundle.rollups);
    return {
      campaignId: bundle.campaign.id,
      currency: bundle.campaign.currency,
      reality: realityOfState(bundle.campaign.state, false),
      series: toSeries(bundle.rollups),
      totals: bundle.rollups.length === 0 ? [] : toTotalMetrics(bundle),
      byCreative: toBreakdown(byCreative, 'creative_version_id', labels.creatives),
      byFunnelArm: toBreakdown(byFunnel, 'funnel_version_id', labels.funnels),
      maturity: maturityFromCount(totals.submissions),
      attributionCoverage: averageCoverage(bundle.rollups),
      lastUpdatedAt: latestTimestamp(bundle.rollups.map((row) => row.computed_at)),
    };
  }

  async getLeadsAndSales(campaignId: string): Promise<LeadsSalesView | null> {
    const bundle = await this.load(campaignId);
    if (!bundle) return null;

    const workspaceId = bundle.campaign.workspace_id;
    const [counts, leadPage, coverage, thresholds] = await Promise.all([
      bundle.db.submissions.funnelCounts({ workspaceId, campaignId: bundle.campaign.id }),
      bundle.db.submissions.listLeads({ workspaceId, campaignId: bundle.campaign.id, limit: 100 }),
      bundle.db.submissions.attributionCoverage(bundle.campaign.id),
      bundle.db.settings.experimentThresholds(workspaceId),
    ]);

    const submissionIds = leadPage.rows.map((row) => row.submission_id);
    const [attempts, snapshots, labels] = await Promise.all([
      bundle.db.hubspot.loadAttemptsForSubmissions(submissionIds),
      bundle.db.attribution.loadSnapshotsForSubmissions(submissionIds),
      this.versionLabels(bundle),
    ]);

    const coverageValue = coverageOf(coverage);
    const stageMaturity = maturityFromCount(counts.leads);
    const lateMaturity = maturityFromCount(counts.opportunities);

    const stages: CrmFunnelStage[] =
      counts.submissions === 0
        ? []
        : [
            stage('leads', 'Leads', counts.leads, rate(counts.leads, counts.submissions), stageMaturity, coverageValue),
            stage('vq_scheduled', 'VQ terminiert', counts.vq_scheduled, rate(counts.vq_scheduled, counts.leads), stageMaturity, coverageValue),
            stage('vq_attended', 'VQ stattgefunden', counts.vq_attended, rate(counts.vq_attended, counts.vq_scheduled), stageMaturity, coverageValue),
            stage('vq_no_show', 'No-Show', counts.vq_no_show, rate(counts.vq_no_show, counts.vq_scheduled), stageMaturity, coverageValue),
            stage('qualified_vq', 'Qualifizierte VQ', counts.qualified_vq, rate(counts.qualified_vq, counts.vq_attended), stageMaturity, coverageValue),
            stage('opportunities', 'Opportunities', counts.opportunities, rate(counts.opportunities, counts.qualified_vq), lateMaturity, coverageValue),
            stage('closed_won', 'Gewonnen', counts.closed_won, rate(counts.closed_won, counts.opportunities), lateMaturity, coverageValue),
            stage('closed_lost', 'Verloren', counts.closed_lost, rate(counts.closed_lost, counts.opportunities), lateMaturity, coverageValue),
          ];

    const leads: LeadRow[] = leadPage.rows.map((row, index) => {
      const attemptList = attempts.get(row.submission_id) ?? [];
      const latest = attemptList[0] ?? null;
      const snapshot = snapshots.get(row.submission_id) ?? null;
      return {
        id: row.id,
        // Never a name and never an e-mail: those live encrypted in
        // `submission_pii_encrypted` and must not reach an analytics surface.
        labelDe: `Lead ${index + 1} · ${row.id.slice(0, 8)}`,
        createdAt: row.created_at,
        vqStatus: row.vq_status as VqStatus,
        syncStatus: row.sync_status as SyncStatus,
        syncAttempts: latest?.attempt_number ?? 0,
        lastSyncError: latest?.error_message ?? null,
        attributionLevel: (snapshot?.level ?? 'NONE') as AttributionLevel,
        // Which creative and which arm this lead came through is only known when
        // the attribution snapshot resolved the signed launch token; without
        // one, the column stays empty rather than guessing the likeliest arm.
        creativeLabelDe: snapshot?.creative_version_id
          ? (labels.creatives.get(snapshot.creative_version_id) ?? null)
          : null,
        funnelArmLabelDe: snapshot?.funnel_version_id
          ? (labels.funnels.get(snapshot.funnel_version_id) ?? null)
          : null,
      };
    });

    const maturityDays = thresholds.crmMaturityDays;
    const youngest = leadPage.rows.reduce<number | null>((acc, row) => {
      const age = Math.floor((this.now().getTime() - Date.parse(row.created_at)) / 86_400_000);
      return acc === null || age < acc ? age : acc;
    }, null);

    return {
      campaignId: bundle.campaign.id,
      stages,
      revenue: { amountMinor: counts.revenue_minor, currency: bundle.campaign.currency },
      revenueMaturity: lateMaturity,
      attributionCoverage: coverageValue,
      crmMaturityDays: maturityDays,
      maturityRemainingDays: youngest === null ? maturityDays : Math.max(0, maturityDays - youngest),
      leads,
      failedSyncCount: leads.filter((row) => row.syncStatus === 'FAILED_RETRYING').length,
    };
  }

  async getRecommendations(campaignId: string): Promise<RecommendationView[]> {
    const db = await this.db();
    const campaign = await this.visibleCampaign(db, campaignId);
    if (!campaign) return [];

    const rows = await db.recommendations.listByCampaign(campaign.id);
    if (rows.length === 0) return [];

    const actions = await db.recommendations.loadActionsFor(rows.map((row) => row.id));
    const commands = await db.meta.listCommands(campaign.workspace_id);
    const byId = new Map(commands.map((row) => [row.id, row]));

    return rows.map((row) => {
      const list = actions.get(row.id) ?? [];
      const commandId = list.find((entry) => entry.external_command_id)?.external_command_id ?? null;
      const command = commandId ? (byId.get(commandId) ?? null) : null;
      const recommendation = toRecommendation(row, command);
      return {
        recommendation,
        command: command ? toExternalCommand(command) : null,
        // A `DryRunResult` is not persisted anywhere — it is the answer to a
        // request, not a record — so a past dry run cannot be replayed here.
        lastDryRun: null,
        requestPreview: (command?.request_preview as Record<string, unknown> | undefined) ?? {
          action: row.action,
          affected: row.affected_meta_objects,
        },
        actionSummaryDe: row.title_de,
      };
    });
  }

  async getLearnings(campaignId: string): Promise<LearningCard[]> {
    const db = await this.db();
    const campaign = await this.visibleCampaign(db, campaignId);
    if (!campaign) return [];
    const page = await db.learningCards.list({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      limit: 50,
    });
    return page.rows.map(toLearningCard);
  }

  async getHistory(campaignId: string): Promise<HistoryView | null> {
    const db = await this.db();
    const campaign = await this.visibleCampaign(db, campaignId);
    if (!campaign) return null;

    const [versions, auditPage] = await Promise.all([
      db.campaigns.listVersions(campaign.id),
      db.audit.list({ workspaceId: campaign.workspace_id, campaignId: campaign.id, limit: 200 }),
    ]);

    const entries: CampaignVersionEntry[] = versions.map((row, index) => ({
      versionId: row.id,
      version: row.version,
      publishedAt: toIsoOrNull(row.published_at),
      labelDe:
        row.state === 'PUBLISHED'
          ? `Version ${row.version} (veröffentlicht)`
          : `Version ${row.version} (${row.state === 'ARCHIVED' ? 'archiviert' : 'Entwurf'})`,
      summaryDe: row.notes ?? 'Für diese Version ist keine Zusammenfassung hinterlegt.',
      current: row.id === campaign.current_version_id,
      // `campaign_versions` stores the whole spec per version, so the previous
      // version *is* the "before" — no separate diff column is needed.
      before: (versions[index + 1]?.spec as unknown) ?? null,
      after: row.spec as unknown,
    }));

    return {
      campaignId: campaign.id,
      versions: entries,
      auditLog: auditPage.rows.map(toAuditLog),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                              */
  /* ------------------------------------------------------------------ */

  async decideApproval(input: ApprovalDecisionInput): Promise<ActionResult<ApprovalStatus>> {
    const bundle = await this.load(input.campaignId);
    if (!bundle) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const hash = this.currentHash(bundle, input.kind);
    if (hash !== input.contentHash) {
      return actionError(
        'CONTENT_CHANGED',
        'Der Inhalt hat sich geändert, während Sie ihn geprüft haben. Bitte laden Sie die Ansicht neu und geben Sie den aktuellen Stand frei.',
      );
    }

    const transaction = this.options.transaction;
    if (!transaction) return actionError('PROVIDER_NOT_CONFIGURED', NO_TRANSACTION_DE);

    const existing = bundle.approvals.get(input.kind) ?? null;
    const decidedAt = this.now().toISOString();

    try {
      await transaction({ profileId: input.actor.id }, async (tx) => {
        /*
         * Update the live row, insert one only when there is none. An upsert on
         * `approvals_active_key` looks tidier and is wrong: that index is
         * partial (`state in ('PENDING','APPROVED')`), so a REJECTED row is
         * outside it, conflicts with nothing, and the decision would leave the
         * pending row standing beside it.
         */
        const decision = [
          input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          input.decision === 'APPROVE' ? hash : null,
          input.decision === 'APPROVE' ? input.actor.id : null,
          input.decision === 'APPROVE' ? decidedAt : null,
          input.decision === 'REJECT'
            ? (input.reasonDe ?? 'Ohne Angabe eines Grundes abgelehnt.')
            : null,
          input.actor.id,
        ];

        let rows = await tx.query<{ id: string }>(
          `update public.approvals
              set state = $3,
                  approved_content_hash = $4,
                  approved_by = $5,
                  approved_at = $6,
                  rejected_reason_de = $7,
                  invalidated_at = null,
                  invalidated_reason_de = null,
                  updated_by = $8
            where campaign_id = $1
              and kind = $2
              and state in ('PENDING','APPROVED')
            returning id`,
          [bundle.campaign.id, input.kind, ...decision],
        );

        if (rows.length === 0) {
          rows = await tx.query<{ id: string }>(
            `insert into public.approvals (
               workspace_id, campaign_id, kind, state, approved_content_hash, approved_by,
               approved_at, rejected_reason_de, requested_by, created_by, updated_by
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
             returning id`,
            [bundle.campaign.workspace_id, bundle.campaign.id, input.kind, ...decision],
          );
        }

        /*
         * The cascade and its trail belong to the decision, not to the caller.
         * A rejection means the content is not covered any more, so every
         * downstream approval taken against it stops being valid — and that is a
         * change nobody else records, which is why the audit row is written
         * here, in the same transaction, rather than by the action wrapper.
         */
        if (input.decision === 'REJECT') {
          const downstream = downstreamApprovals(input.kind);
          if (downstream.length > 0) {
            await tx.query(
              `update public.approvals
                  set state = 'INVALIDATED',
                      invalidated_at = $3,
                      invalidated_reason_de = $4
                where campaign_id = $1
                  and kind = any($2::text[])
                  and state = 'APPROVED'`,
              [
                bundle.campaign.id,
                downstream,
                decidedAt,
                `Die vorgelagerte Freigabe „${input.kind}" wurde abgelehnt; diese Freigabe deckt den aktuellen Stand nicht mehr ab.`,
              ],
            );
          }
        }

        await tx.query(
          `insert into public.audit_logs (
             workspace_id, action, occurred_at, actor_id, actor_label,
             entity_type, entity_id, campaign_id, summary_de, before, after, correlation_id
           ) values ($1, $2, $3, $4, $5, 'approval', $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
          [
            bundle.campaign.workspace_id,
            input.decision === 'APPROVE' ? 'approval.granted' : 'approval.rejected',
            decidedAt,
            input.actor.id,
            input.actor.displayName,
            rows[0]?.id ?? bundle.campaign.id,
            bundle.campaign.id,
            input.decision === 'APPROVE'
              ? `Freigabe „${input.kind}" erteilt.`
              : `Freigabe „${input.kind}" abgelehnt.`,
            JSON.stringify({ state: existing?.state ?? 'PENDING' }),
            JSON.stringify({
              state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
              hash,
            }),
            `campaign.approval.${input.kind.toLowerCase()}:${bundle.campaign.id}`,
          ],
        );
      });
    } catch (error) {
      return toRefusal(error, 'Die Freigabeentscheidung wurde nicht gespeichert.');
    }

    const after = await this.load(input.campaignId);
    return after
      ? actionOk(this.approvalStatus(after, input.kind))
      : actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
  }

  async reviewCreative(input: CreativeReviewInput): Promise<ActionResult<CreativeBoardView>> {
    const bundle = await this.load(input.campaignId);
    if (!bundle) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const concept = bundle.concepts.find((row) => row.id === input.creativeId);
    if (!concept) {
      return actionError('NOT_FOUND', 'Dieses Creative gehört nicht zu dieser Kampagne.');
    }

    const transaction = this.options.transaction;
    if (!transaction) return actionError('PROVIDER_NOT_CONFIGURED', NO_TRANSACTION_DE);

    const reviewedAt = this.now().toISOString();
    try {
      await transaction({ profileId: input.actor.id }, async (tx) => {
        await tx.query(
          `update public.creative_concepts
              set review_state = $2,
                  reviewed_by = $3,
                  reviewed_at = $4,
                  rejection_reason_de = $5,
                  updated_by = $3
            where id = $1`,
          [
            concept.id,
            input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            input.actor.id,
            reviewedAt,
            input.decision === 'REJECT'
              ? (input.reasonDe ?? 'Ohne Angabe eines Grundes abgelehnt.')
              : null,
          ],
        );

        // The approved set is what the ASSETS approval covers, so a review
        // changes that content hash and the approval taken against the old set
        // has to fall in the same breath.
        await tx.query(
          `update public.approvals
              set state = 'INVALIDATED',
                  invalidated_at = $2,
                  invalidated_reason_de = $3
            where campaign_id = $1 and kind in ('ASSETS','PUBLISH') and state = 'APPROVED'`,
          [
            bundle.campaign.id,
            reviewedAt,
            'Die freigegebenen Creatives haben sich geändert; die Freigabe deckt den aktuellen Stand nicht mehr ab.',
          ],
        );
      });
    } catch (error) {
      return toRefusal(error, 'Die Creative-Entscheidung wurde nicht gespeichert.');
    }

    const board = await this.getCreativeBoard(input.campaignId);
    return board ? actionOk(board) : actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
  }

  /**
   * Why a Meta write cannot go through even though the flags allow it.
   *
   * The two reasons are different and the operator has to be able to tell them
   * apart: no ad account is linked at all, or one is linked and the dispatch
   * path is not wired up yet. Reporting the first when the second is true sends
   * them to re-connect an account that is already connected.
   */
  private async metaRefusal(
    db: AmDatabase,
    workspaceId: Uuid,
    suffixDe: string,
  ): Promise<ActionResult<never>> {
    const account = await db.meta.getPrimaryAccount(workspaceId);
    return actionError(
      'PROVIDER_NOT_CONNECTED',
      account
        ? `Für das verbundene Meta-Werbekonto ist an dieser Stelle noch kein Schreibpfad angebunden. ${suffixDe}`
        : `Externe Schreibzugriffe sind aktiviert, aber es ist kein Meta-Werbekonto verbunden. ${suffixDe}`,
    );
  }

  async transition(input: TransitionInput): Promise<ActionResult<CampaignHeaderView>> {
    const bundle = await this.load(input.campaignId);
    if (!bundle) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const from = bundle.campaign.state;
    if (!canTransition(from, input.to)) {
      return actionError(
        'INVALID_TRANSITION',
        `Ein Wechsel von „${from}" nach „${input.to}" ist nicht vorgesehen.`,
      );
    }

    const valid = new Map(this.allApprovals(bundle).map((status) => [status.kind, status.valid]));
    const missing = (REQUIRED_APPROVALS_FOR_STATE[input.to] ?? []).filter(
      (kind) => valid.get(kind) !== true,
    );
    if (missing.length > 0) {
      return actionError(
        'APPROVAL_REQUIRED',
        `Für diesen Schritt fehlen gültige Freigaben: ${missing.join(', ')}. Eine nach der Freigabe geänderte Inhaltsfassung macht die Freigabe ungültig und erfordert eine erneute Freigabe.`,
      );
    }

    if ((input.to === 'META_DRAFT_CREATED' || input.to === 'LIVE') && this.diversityOf(bundle).blocked) {
      return actionError(
        'CREATIVE_DIVERSITY_BLOCKED',
        `Es sind weniger als ${GENERATION_DEFAULTS.minApprovedCreatives} konzeptionell unterschiedliche Creatives freigegeben.`,
      );
    }

    if (isMetaWritingTransition(input.to)) {
      if (!canWriteMeta(getFeatureFlags())) {
        const preview = this.metaWritePreviews(bundle).find((write) => write.to === input.to);
        return actionDryRun(
          dryRun(
            'META',
            META_WRITING_TRANSITIONS[input.to],
            preview?.payload ?? {},
            'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts angelegt und der Status wurde nicht geändert.',
          ),
        );
      }
      return this.metaRefusal(
        bundle.db,
        bundle.campaign.workspace_id,
        'Es wurde nichts gesendet und der Status wurde nicht geändert.',
      );
    }

    try {
      await bundle.db.campaigns.transitionState(
        bundle.campaign.id,
        input.to,
        asUuid(input.actor.id),
      );
    } catch (error) {
      return toRefusal(error, 'Der Status wurde nicht geändert.');
    }

    const after = await this.load(input.campaignId);
    return after
      ? actionOk(this.headerOf(after, false))
      : actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
  }

  async changeBudget(input: BudgetChangeInput): Promise<ActionResult<CampaignHeaderView>> {
    const bundle = await this.load(input.campaignId);
    if (!bundle) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
    if (input.newDailyBudgetMinor <= 0) {
      return actionError('VALIDATION_FAILED', 'Das Tagesbudget muss größer als null sein.', {
        fieldErrors: { newDailyBudgetMinor: 'Bitte einen Betrag größer als 0,00 € angeben.' },
      });
    }

    const current = bundle.campaign.daily_budget_minor;
    const increasePct = (input.newDailyBudgetMinor - current) / Math.max(1, current);

    // The role limits are persisted per workspace; `budgetLimitFor` falls back
    // to `DEFAULT_ROLE_BUDGET_LIMITS` when nothing is configured, so the gate is
    // the workspace's own rule rather than a constant compiled into the console.
    const limits = await Promise.all(
      input.actorRoles.map((role) =>
        bundle.db.settings.budgetLimitFor(bundle.campaign.workspace_id, role),
      ),
    );
    const best = limits.reduce<(typeof limits)[number] | null>(
      (acc, limit) =>
        acc === null || limit.max_daily_budget_minor > acc.max_daily_budget_minor ? limit : acc,
      null,
    );

    if (
      !best ||
      increasePct > best.max_single_increase_pct ||
      input.newDailyBudgetMinor > best.max_daily_budget_minor
    ) {
      const approver = await this.approvingRoleFor(
        bundle,
        input.newDailyBudgetMinor,
        increasePct,
      );
      return actionError(
        'BUDGET_LIMIT_EXCEEDED',
        `Diese Budgetänderung überschreitet Ihr Rollenlimit und wird nicht gekürzt, sondern abgelehnt. Sie muss durch die Rolle „${approver}" freigegeben werden.`,
      );
    }

    if (budgetLivesAtMeta(bundle.campaign.state)) {
      if (!canWriteMeta(getFeatureFlags())) {
        return actionDryRun(
          dryRun('META', 'campaign.update.daily_budget', {
            campaign_id: null,
            daily_budget: input.newDailyBudgetMinor,
            currency: bundle.campaign.currency,
          }),
        );
      }
      return this.metaRefusal(
        bundle.db,
        bundle.campaign.workspace_id,
        'Das Tagesbudget wurde nicht geändert.',
      );
    }

    try {
      await bundle.db.campaigns.update(bundle.campaign.id, {
        daily_budget_minor: input.newDailyBudgetMinor,
        updated_by: asUuid(input.actor.id),
      });
    } catch (error) {
      return toRefusal(error, 'Das Tagesbudget wurde nicht geändert.');
    }

    const after = await this.load(input.campaignId);
    return after
      ? actionOk(this.headerOf(after, false))
      : actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
  }

  private async approvingRoleFor(
    bundle: CampaignBundle,
    newDailyBudgetMinor: number,
    increasePct: number,
  ): Promise<string> {
    const candidates = rolesWithPermission('campaign.scale_budget_major');
    for (const role of candidates) {
      const limit = await bundle.db.settings.budgetLimitFor(bundle.campaign.workspace_id, role);
      if (
        increasePct <= limit.max_single_increase_pct &&
        newDailyBudgetMinor <= limit.max_daily_budget_minor
      ) {
        return ROLE_LABELS_DE[role];
      }
    }
    return ROLE_LABELS_DE.EXECUTIVE;
  }

  async executeRecommendation(
    input: RecommendationExecutionInput,
  ): Promise<ActionResult<CommandOutcome>> {
    const db = await this.db();
    const row = await db.recommendations.getById(asUuid(input.recommendationId));
    if (!row || row.campaign_id !== input.campaignId) {
      return actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
    }

    const affected = readRecords(row.affected_meta_objects);
    if (affected.length === 0) {
      return actionError(
        'NO_EXTERNAL_ACTION',
        'Diese Empfehlung erfordert keine externe Aktion — sie wird durch Weiterlaufen erfüllt.',
      );
    }

    if (!canWriteMeta(getFeatureFlags())) {
      return actionDryRun(
        dryRun('META', metaOperationFor(row.action), {
          action: row.action,
          affected: row.affected_meta_objects,
        }),
      );
    }

    return this.metaRefusal(db, row.workspace_id, 'Es wurde nichts gesendet.');
  }

  async decideRecommendation(
    input: RecommendationDecisionInput,
  ): Promise<ActionResult<RecommendationView>> {
    const db = await this.db();
    const row = await db.recommendations.getById(asUuid(input.recommendationId));
    if (!row || row.campaign_id !== input.campaignId) {
      return actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
    }
    if (row.state !== 'OPEN') {
      return actionError(
        'ALREADY_DECIDED',
        'Über diese Empfehlung wurde bereits entschieden. Eine erneute Entscheidung ändert nichts.',
      );
    }
    if (input.decision === 'ACCEPT' && readRecords(row.affected_meta_objects).length > 0) {
      return actionError(
        'EXTERNAL_ACTION_REQUIRED',
        'Diese Empfehlung verändert Objekte bei Meta. Sie wird über „Annehmen und ausführen" umgesetzt, nicht durch bloßes Annehmen.',
      );
    }

    try {
      if (input.decision === 'ACCEPT') {
        await db.recommendations.accept(row.id, asUuid(input.actor.id));
      } else {
        await db.recommendations.dismiss(row.id, asUuid(input.actor.id), input.reasonDe);
      }
    } catch (error) {
      return toRefusal(error, 'Die Entscheidung wurde nicht gespeichert.');
    }

    const views = await this.getRecommendations(input.campaignId);
    const decided = views.find((view) => view.recommendation.id === input.recommendationId);
    return decided
      ? actionOk(decided)
      : actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
  }

  async retryLeadSync(input: LeadSyncRetryInput): Promise<ActionResult<LeadRow>> {
    const db = await this.db();
    const lead = await db.submissions.getLead(asUuid(input.leadId));
    if (!lead || lead.campaign_id !== input.campaignId) {
      return actionError('NOT_FOUND', 'Dieser Lead gehört nicht zu dieser Kampagne.');
    }
    if (lead.sync_status !== 'FAILED_RETRYING') {
      return actionError('NOT_RETRYABLE', 'Für diesen Lead steht keine Wiederholung an.');
    }

    const flags = getFeatureFlags();
    if (!flags.externalWritesEnabled || !flags.hubspotWritesEnabled) {
      // Nothing is written: recording an attempt would put a row in
      // `hubspot_sync_attempts` claiming a request that never left the process.
      return actionDryRun(
        dryRun('HUBSPOT', 'contacts.upsert', { lead_id: input.leadId, retry: true }),
      );
    }

    const connection = await db.integrations.get(lead.workspace_id, 'HUBSPOT');
    return actionError(
      'PROVIDER_NOT_CONNECTED',
      connection?.state === 'CONNECTED'
        ? 'Für die verbundene HubSpot-Instanz ist an dieser Stelle noch kein Schreibpfad angebunden. Es wurde nichts gesendet.'
        : 'HubSpot ist nicht verbunden. Es wurde nichts gesendet.',
    );
  }
}

export function createDatabaseCampaignPort(options: CampaignDatabaseOptions): CampaignPort {
  return new DatabaseCampaignPort(options);
}

/* -------------------------------------------------------------------------- */
/* Row → view mapping                                                          */
/* -------------------------------------------------------------------------- */

const ALL_CAMPAIGN_STATES: readonly CampaignState[] = [
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
];

/** Approvals a rejection of `kind` takes down with it. */
function downstreamApprovals(kind: ApprovalKind): ApprovalKind[] {
  switch (kind) {
    case 'STRATEGY':
      return ['ASSETS', 'TEST_PLAN', 'PUBLISH'];
    case 'ASSETS':
      return ['TEST_PLAN', 'PUBLISH'];
    case 'TEST_PLAN':
      return ['PUBLISH'];
    default:
      return [];
  }
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    kind: row.kind,
    state: row.state,
    approved_content_hash: row.approved_content_hash,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    rejected_reason_de: row.rejected_reason_de,
    invalidated_at: row.invalidated_at,
    invalidated_reason_de: row.invalidated_reason_de,
    created_at: row.created_at,
  };
}

function toAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    action: row.action,
    occurred_at: row.occurred_at,
    actor_id: row.actor_id,
    actor_label: row.actor_label,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    campaign_id: row.campaign_id,
    summaryDe: row.summary_de,
    before: row.before,
    after: row.after,
    correlation_id: row.correlation_id,
  };
}

function toCreativeConcept(row: CreativeConceptRow): CreativeConcept {
  return {
    key: row.concept_key,
    name: row.name,
    principle: row.principle,
    visualIdea: row.visual_idea,
    imagePrompt: row.image_prompt,
    copy: {
      primaryText: row.copy.primaryText,
      headline: row.copy.headline,
      description: row.copy.description,
      callToAction: (row.copy as { callToAction?: string }).callToAction ?? 'Mehr erfahren',
    },
    hypothesis: row.hypothesis,
    rationale: row.rationale,
    proofUsed: row.proof_used,
    funnelPromise: row.funnel_promise,
    altText: row.alt_text,
    aspectRatios: row.aspect_ratios,
    claims: [],
  };
}

function toRendition(
  row: CreativeRenditionRow,
  altText: string,
  version: CreativeVersionRow | null,
): {
  id: string;
  aspectRatio: AspectRatio;
  previewUrl: string | null;
  widthPx: number;
  heightPx: number;
  altTextDe: string;
  provenanceDe: string;
} {
  return {
    id: row.id,
    aspectRatio: row.aspect_ratio,
    // The file lives in a private storage bucket. A URL for it has to be signed
    // by the storage API, which no repository exposes, so the card renders its
    // placeholder rather than a link that would 404.
    previewUrl: null,
    widthPx: row.width,
    heightPx: row.height,
    altTextDe: altText,
    provenanceDe: `Renderer ${row.renderer_version} · ${row.storage_bucket}/${row.storage_path}${
      version ? ` · Version ${version.version}` : ''
    }`,
  };
}

function toRecommendation(row: RecommendationRow, command: ExternalCommandRow | null): Recommendation {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    experiment_id: row.experiment_id,
    created_at: row.created_at,
    action: row.action,
    state: row.state,
    ruleId: row.rule_id,
    titleDe: row.title_de,
    summaryDe: row.summary_de,
    explanationDe: row.explanation_de,
    nextHypothesisDe: row.next_hypothesis_de,
    facts: readRecords(row.facts) as unknown as Recommendation['facts'],
    comparisonBasisDe: row.comparison_basis_de,
    maturity: row.maturity,
    attributionCoverage: row.attribution_coverage,
    uncertaintyDe: row.uncertainty_de,
    risk: row.risk,
    riskNoteDe: row.risk_note_de,
    affectedMetaObjects: readRecords(
      row.affected_meta_objects,
    ) as unknown as Recommendation['affectedMetaObjects'],
    proposedBudgetChangePct: row.proposed_budget_change_pct,
    execution: command
      ? {
          command_state: command.state,
          executed_at: command.requested_at,
          executed_by: command.requested_by,
          provider_confirmed_at: command.confirmed_at,
          error: command.error,
        }
      : null,
  };
}

function toExternalCommand(row: ExternalCommandRow): ExternalCommand {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    requestedBy: row.requested_by ?? row.id,
    requestedAt: row.requested_at,
    confirmedAt: row.confirmed_at,
    reconciledAt: row.reconciled_at,
    requestPreview: row.request_preview as Record<string, unknown>,
    providerResponseRedacted: row.provider_response_redacted,
    error: row.error,
    attemptCount: row.attempt_count,
    campaign_id: row.campaign_id,
  };
}

function toLearningCard(row: LearningCardRow): LearningCard {
  return {
    id: row.id,
    version: row.version,
    campaign_id: row.campaign_id,
    experiment_id: row.experiment_id,
    created_at: row.created_at,
    titleDe: row.title_de,
    whatWasTestedDe: row.what_was_tested_de,
    angleName: row.angle_name,
    angle_id: row.angle_id,
    offerName: row.offer_name,
    offer_id: row.offer_id,
    creativeConceptDe: row.creative_concept_de,
    funnelKind: row.funnel_kind,
    audienceDe: row.audience_de,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    spendMinor: row.spend_minor,
    currency: row.currency,
    outcomeDe: row.outcome_de,
    outcomeFacts: readRecords(row.outcome_facts) as unknown as LearningCard['outcomeFacts'],
    dataMaturity: row.data_maturity,
    attributionLevel: row.attribution_level,
    attributionCoverage: row.attribution_coverage,
    possibleExplanationDe: row.possible_explanation_de,
    suggestedNextTestDe: row.suggested_next_test_de,
    confidence: row.confidence,
  };
}

/* -------------------------------------------------------------------------- */
/* Rollup folding                                                              */
/* -------------------------------------------------------------------------- */

interface RollupTotals {
  spendMinor: number;
  impressions: number;
  clicks: number;
  sessions: number;
  formStarts: number;
  submissions: number;
}

function foldRollups(rows: readonly PerformanceRollupRow[]): RollupTotals {
  return rows.reduce<RollupTotals>(
    (acc, row) => ({
      spendMinor: acc.spendMinor + row.spend_minor,
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.link_clicks,
      sessions: acc.sessions + row.funnel_sessions,
      formStarts: acc.formStarts + row.form_starts,
      submissions: acc.submissions + row.submissions,
    }),
    { spendMinor: 0, impressions: 0, clicks: 0, sessions: 0, formStarts: 0, submissions: 0 },
  );
}

function toSeries(rows: readonly PerformanceRollupRow[]): PerformancePoint[] {
  const byDay = new Map<string, RollupTotals>();
  for (const row of rows) {
    const current = byDay.get(row.day) ?? {
      spendMinor: 0,
      impressions: 0,
      clicks: 0,
      sessions: 0,
      formStarts: 0,
      submissions: 0,
    };
    byDay.set(row.day, {
      spendMinor: current.spendMinor + row.spend_minor,
      impressions: current.impressions + row.impressions,
      clicks: current.clicks + row.link_clicks,
      sessions: current.sessions + row.funnel_sessions,
      formStarts: current.formStarts + row.form_starts,
      submissions: current.submissions + row.submissions,
    });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, totals]) => ({
      date: day,
      spendMinor: totals.spendMinor,
      impressions: totals.impressions,
      clicks: totals.clicks,
      sessions: totals.sessions,
      formStarts: totals.formStarts,
      submissions: totals.submissions,
      ctr: rate(totals.clicks, totals.impressions),
      cpcMinor: totals.clicks > 0 ? Math.round(totals.spendMinor / totals.clicks) : null,
      cplMinor: totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
    }));
}

function toBreakdown(
  rows: readonly PerformanceRollupRow[],
  column: 'creative_version_id' | 'funnel_version_id',
  labels: Map<Uuid, string>,
): PerformanceBreakdownRow[] {
  const byId = new Map<Uuid, PerformanceRollupRow[]>();
  for (const row of rows) {
    const id = row[column];
    if (!id) continue;
    const bucket = byId.get(id);
    if (bucket) bucket.push(row);
    else byId.set(id, [row]);
  }
  return [...byId.entries()].map(([id, bucket]) => {
    const totals = foldRollups(bucket);
    return {
      id,
      labelDe: labels.get(id) ?? id,
      spendMinor: totals.spendMinor,
      impressions: totals.impressions,
      clicks: totals.clicks,
      sessions: totals.sessions,
      submissions: totals.submissions,
      ctr: rate(totals.clicks, totals.impressions),
      submissionRate: rate(totals.submissions, totals.sessions),
      cplMinor: totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
      maturity: maturityFromCount(totals.submissions),
    };
  });
}

function toTotalMetrics(bundle: CampaignBundle): MetricValue[] {
  const totals = foldRollups(bundle.rollups);
  const maturity = maturityFromCount(totals.submissions);
  const coverage = averageCoverage(bundle.rollups);
  const currency = bundle.campaign.currency;
  const make = (
    metric: MetricKey,
    numerator: number | null,
    denominator: number | null,
    value: number | null,
    unit: string | null,
  ): MetricValue => ({
    metric,
    numerator,
    denominator,
    value,
    currency: unit,
    maturity,
    attributionCoverage: coverage,
  });

  return [
    make('spend', totals.spendMinor, null, totals.spendMinor, currency),
    make('impressions', totals.impressions, null, totals.impressions, null),
    make('link_clicks', totals.clicks, null, totals.clicks, null),
    make(
      'ctr',
      totals.clicks,
      totals.impressions,
      totals.impressions > 0 ? totals.clicks / totals.impressions : null,
      null,
    ),
    make(
      'cpc',
      totals.spendMinor,
      totals.clicks,
      totals.clicks > 0 ? Math.round(totals.spendMinor / totals.clicks) : null,
      currency,
    ),
    make('funnel_sessions', totals.sessions, null, totals.sessions, null),
    make(
      'form_start_rate',
      totals.formStarts,
      totals.sessions,
      totals.sessions > 0 ? totals.formStarts / totals.sessions : null,
      null,
    ),
    make(
      'submission_rate',
      totals.submissions,
      totals.sessions,
      totals.sessions > 0 ? totals.submissions / totals.sessions : null,
      null,
    ),
    make('leads', totals.submissions, null, totals.submissions, null),
    make(
      'cpl',
      totals.spendMinor,
      totals.submissions,
      totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
      currency,
    ),
  ];
}

function averageCoverage(rows: readonly PerformanceRollupRow[]): number | null {
  const known = rows.filter((row) => row.attribution_coverage !== null);
  if (known.length === 0) return null;
  const sum = known.reduce((acc, row) => acc + (row.attribution_coverage ?? 0), 0);
  return sum / known.length;
}

function latestTimestamp(values: readonly (string | null)[]): string | null {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'AWAITING_EXTERNAL_INPUT';
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('AWAITING_EXTERNAL_INPUT')) return 'AWAITING_EXTERNAL_INPUT';
  if (statuses.includes('WARN')) return 'WARN';
  return 'PASS';
}

function stage(
  key: CrmFunnelStage['key'],
  labelDe: string,
  count: number,
  conversion: Rate,
  maturity: DataMaturity,
  attributionCoverage: number | null,
): CrmFunnelStage {
  return { key, labelDe, count, conversion, maturity, attributionCoverage };
}

/* -------------------------------------------------------------------------- */
/* Small readers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The angle's name.
 *
 * `angles` has no repository in `@am/db`, so the name comes from the published
 * campaign version's spec — the record of what was actually delivered — and
 * falls back to the accepted proposal for a campaign that has not been published
 * yet.
 */
function angleNameFrom(
  version: CampaignVersionRow | null,
  proposal: CampaignProposalRow | null,
): string {
  return (
    readString(version?.spec ?? null, 'angle') ??
    readString(proposal?.proposal ?? null, 'angle', 'name') ??
    NOT_RECORDED_DE
  );
}

function offerNameFrom(
  version: CampaignVersionRow | null,
  proposal: CampaignProposalRow | null,
): string {
  return (
    readString(version?.spec ?? null, 'offer') ??
    readString(proposal?.proposal ?? null, 'offer', 'name') ??
    NOT_RECORDED_DE
  );
}

function angleNameOf(bundle: CampaignBundle): string {
  return angleNameFrom(bundle.version, bundle.proposal);
}

function offerNameOf(bundle: CampaignBundle): string {
  return offerNameFrom(bundle.version, bundle.proposal);
}

function approvedConceptKeys(rows: readonly CreativeConceptRow[]): string[] {
  return rows
    .filter((row) => row.review_state === 'APPROVED')
    .map((row) => row.concept_key)
    .sort();
}

function numberFrom(source: JsonObject | null | undefined, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' ? value : null;
}

function hasThreshold(source: JsonObject | null | undefined, key: string): boolean {
  return numberFrom(source, key) !== null;
}

function readQuestionCount(version: FunnelVersionRow | null): number {
  const value = version?.spec?.qualificationQuestionCount;
  return typeof value === 'number' ? value : 0;
}

function experimentKindOf(experiment: ExperimentRow | null): TestPlanView['plan']['kind'] {
  return experiment?.kind ?? 'BUNDLED_FUNNEL_TEST';
}

function publicFunnelUrl(row: PublishedFunnelRow): string {
  return `${row.path.startsWith('/') ? '' : '/'}${row.path}`;
}

function metaOperationFor(action: string): string {
  switch (action) {
    case 'PAUSE_CREATIVE':
      return 'ad.update.status';
    case 'PAUSE_FUNNEL_ARM':
      return 'adset.update.status';
    case 'INCREASE_BUDGET':
    case 'DECREASE_BUDGET':
      return 'campaign.update.daily_budget';
    default:
      return 'campaign.update';
  }
}

/**
 * Whether the database refused the statement on authority grounds.
 *
 * `42501` is what a missing GRANT raises, and `FORBIDDEN` is what `@am/db` maps
 * it to. A policy that simply matches no rows is not an error at all and is not
 * covered here — an empty result is its own answer.
 */
function isRefusal(error: unknown): boolean {
  const candidate = error as { code?: string; details?: { pgCode?: string } } | null;
  // A raw driver error carries the SQLSTATE; a `DomainError` from a repository
  // carries the mapped code and keeps the SQLSTATE in its details.
  return (
    candidate?.code === '42501' ||
    candidate?.code === 'FORBIDDEN' ||
    candidate?.details?.pgCode === '42501'
  );
}

/**
 * A refused write, in German and without a Postgres string.
 *
 * The authority case is the one worth naming: a policy said no — the operator's
 * role does not carry the capability the write needs — and "unbekannter Fehler"
 * would send them looking in the wrong place.
 */
function toRefusal(error: unknown, suffixDe: string): ActionResult<never> {
  if (isRefusal(error)) {
    return actionError(
      'FORBIDDEN',
      `Ihre Rolle ist für diese Änderung nicht berechtigt. ${suffixDe}`,
    );
  }
  return actionError('INTERNAL', `Die Änderung konnte nicht gespeichert werden. ${suffixDe}`);
}

/**
 * The list filter, applied to the campaign row rather than to the rendered view,
 * so the expensive part of a row is only built for rows that survive it. Same
 * predicate as the fixture's `filterRows`.
 */
export function matchesListQuery(
  campaign: CampaignRow,
  angleName: string,
  offerName: string,
  query: CampaignListQuery,
): boolean {
  const search = query.search?.trim().toLowerCase() ?? '';
  const day = campaign.updated_at.slice(0, 10);
  if (query.states.length > 0 && !query.states.includes(campaign.state)) return false;
  if (query.angles.length > 0 && !query.angles.includes(angleName)) return false;
  if (query.offers.length > 0 && !query.offers.includes(offerName)) return false;
  if (query.from !== null && day < query.from) return false;
  if (query.to !== null && day > query.to) return false;
  if (search !== '' && !campaign.name.toLowerCase().includes(search)) return false;
  return true;
}

export { DEFAULT_CURRENCY };
