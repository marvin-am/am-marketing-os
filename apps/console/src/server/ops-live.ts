import { getFeatureFlags } from '@am/config';
import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DEFAULT_RECOMMENDATION_CONFIG,
  DEFAULT_ROLE_BUDGET_LIMITS,
  DomainError,
  ROLES,
  UNCONFIGURED_RETENTION_POLICY,
  asId,
  dryRun,
  outboxEventSchema,
  type ConsentVersion,
  type DataMaturity,
  type FeatureFlags,
  type OutboxEvent,
  type Provider,
  type ProviderHealth,
  type RetentionPolicy,
  type Role,
  type RoleBudgetLimit,
} from '@am/domain';
import type {
  AmDatabase,
  BrandProfileRow,
  JsonObject,
  ConsentVersionRow,
  IntegrationConnectionRow,
  OutboxEventRow,
  PerformanceRollupRow,
  RoleLimitRow,
  Uuid,
} from '@am/db';
import {
  MAPPING_WIZARD_STEPS,
  canPublishMapping,
  createInMemorySyncStore,
  mappingDocumentSchema,
  missingRequiredMappings,
  reconcile,
  requiredMappingsComplete,
  runTestLead,
  validateMapping,
  type HubspotMappingDocument,
} from '@am/hubspot';
import type {
  ActiveCampaignSummary,
  ApprovalThresholds,
  BrandTokens,
  FeatureFlagView,
  HubspotMappingSnapshot,
  HubspotStepView,
  IntegrationsSnapshot,
  LibrarySnapshot,
  MappingVersionSummary,
  OpsPort,
  OutboxRow,
  OutboxSnapshot,
  ProbeResultView,
  ProviderCardData,
  SettingsSnapshot,
  TodayItem,
  TodaySnapshot,
} from './ops-port';
import {
  buildMetaSetupSnapshot,
  hubspotProviderFor,
  probeHubspot,
  probeMeta,
  probeOpenAi,
  probeSupabase,
} from './provider-probes';
import { FLAG_VIEW_TEXTS_DE, OUTBOX_DESTINATION_LABELS_DE } from './ops-text';
import { workspaceResolver } from './workspace';

/**
 * `OpsPort` over the real schema.
 *
 * The rule this file follows everywhere is the one the fixture cannot break and
 * a live implementation easily can: **it reports only what a repository actually
 * returned.** Where `AmDatabase` has no answer — the HubSpot wizard document,
 * the display names behind `workspace_members`, the approval thresholds — the
 * snapshot carries the empty or unconfigured value and the write path refuses
 * with a German explanation, rather than quietly serving fixture data that the
 * operator would read as their own.
 *
 * Provider health is not a storage question and is answered by the same probes
 * the fixture uses (`provider-probes.ts`), so a live console never infers a
 * connection from an environment variable either.
 */

export interface LiveOpsPortOptions {
  db: AmDatabase;
  /** Fallback workspace id when no workspace carries the console's slug. */
  workspaceId: string;
  /** Evaluation instant. Injected so a test can pin the snapshot. */
  now?: () => string;
}

/** Number of outbox rows the sync screen loads. The table is a queue, not a log. */
const OUTBOX_PAGE_LIMIT = 200;

/**
 * The approval thresholds the console steers by.
 *
 * `workspace_settings` has columns for the experiment thresholds, the
 * recommendation config, the retention policy and the attribution window — and
 * none for these four. They are therefore the product's documented defaults on
 * the live path, and `saveApprovalThresholds` refuses rather than accepting a
 * change it cannot persist.
 */
const DEFAULT_APPROVAL_THRESHOLDS: ApprovalThresholds = {
  budgetScaleApprovalPct: 0.2,
  majorChangeApprovalPct: 0.5,
  dailyBudgetApprovalMinor: 20_000_00,
  currency: 'EUR',
};

/** Brand tokens as they stand before a brand profile has been described. */
const UNCONFIGURED_BRAND: BrandTokens = {
  primary: '#D7182A',
  foreground: '#111111',
  background: '#FFFFFF',
  accent: '#000000',
  logoAssetPath: null,
};

function notStorable(what: string, column: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    messageDe:
      `${what} kann nicht gespeichert werden: im Schema existiert dafür keine Spalte (${column}). ` +
      'Die Änderung wurde nicht übernommen — sie würde sonst beim nächsten Laden verschwinden.',
    details: { column },
    retryable: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Row translation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `OutboxEventRow` → `OutboxEvent`.
 *
 * Parsed through the domain schema rather than cast: the column set is wider
 * than the domain type (payload, lock holder, lead id) and the console must not
 * carry a raw payload into a React tree.
 */
function toOutboxEvent(row: OutboxEventRow): OutboxEvent {
  return outboxEventSchema.parse({
    event_id: row.event_id,
    destination: row.destination,
    event_name: row.event_name,
    event_time: row.event_time,
    payload_hash: row.payload_hash,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    provider_response_redacted: row.provider_response_redacted ?? null,
    sent_at: row.sent_at,
    created_at: row.created_at,
    campaign_id: row.campaign_id,
    submission_id: row.submission_id,
    opportunity_id: row.opportunity_id,
    dataset_id: row.dataset_id,
  });
}

function toConsentVersion(row: ConsentVersionRow): ConsentVersion {
  return {
    id: row.id,
    version: row.version,
    textDe: row.text_de,
    purposes: row.purposes,
    privacyPolicyUrl: row.privacy_policy_url,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  };
}

function toRoleBudgetLimit(row: RoleLimitRow): RoleBudgetLimit {
  return {
    role: row.role,
    maxSingleIncreasePct: row.max_single_increase_pct,
    maxDailyBudgetMinor: row.max_daily_budget_minor,
    maxScalesPer24h: row.max_scales_per_24h,
    mayPause: row.may_pause,
  };
}

function toBrandTokens(row: BrandProfileRow | null): BrandTokens {
  if (!row) return UNCONFIGURED_BRAND;
  return {
    primary: row.colors.primary,
    foreground: row.colors.foreground,
    background: row.colors.background,
    accent: row.colors.accent,
    logoAssetPath: row.logo_asset_path,
  };
}

function flagViews(flags: FeatureFlags): FeatureFlagView[] {
  return (Object.keys(FLAG_VIEW_TEXTS_DE) as Array<keyof FeatureFlags>).map((key) => ({
    key,
    value: flags[key],
    ...FLAG_VIEW_TEXTS_DE[key],
  }));
}

/**
 * Narrows a typed settings object to the column's JSON type.
 *
 * The columns are `jsonb` and the values are plain data; the cast is only here
 * because a declared interface is not structurally an index signature.
 */
function toJson(value: object): JsonObject {
  return value as unknown as JsonObject;
}

/** The day a UTC timestamp falls on — the grain the rollup table is keyed on. */
function utcDayOf(iso: string): string {
  return iso.slice(0, 10);
}

function sumRollup(rows: readonly PerformanceRollupRow[], key: keyof PerformanceRollupRow): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

export function createLiveOpsPort(options: LiveOpsPortOptions): OpsPort {
  const { db } = options;
  const workspace = workspaceResolver(db, options.workspaceId);
  const now = options.now ?? (() => new Date().toISOString());
  const flags = (): FeatureFlags => getFeatureFlags();

  /* ---- HubSpot mapping --------------------------------------------------- */

  /**
   * What `hubspot_mappings` can say about the wizard document.
   *
   * The table stores a field map, a stage map and a pipeline — not the wizard's
   * document, which additionally describes deal creation, stage events, revenue,
   * VQ, acquisition slots and the webhook. Those parts are therefore returned at
   * their schema defaults, which is exactly the state the wizard should show
   * when nothing has been described: incomplete, with every missing item named.
   */
  const loadMappingDraft = async (): Promise<{
    draft: HubspotMappingDocument;
    versions: MappingVersionSummary[];
  }> => {
    const rows = await db.hubspot.listMappings(await workspace(), 'DEAL');
    const newest = rows[0] ?? null;

    const draft = mappingDocumentSchema.parse({
      id: newest?.id ?? '00000000-0000-4000-8000-000000000000',
      version: newest?.version ?? 1,
      status: 'DRAFT',
      createdAt: newest?.created_at ?? now(),
      source: 'WIZARD',
      pipeline: {
        pipelineId: newest?.pipeline_id ?? null,
        pipelineLabel: newest?.pipeline_label ?? null,
      },
    });

    const versions: MappingVersionSummary[] = rows.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.state,
      publishedAt: row.published_at,
      sourceDe: 'Aus der Datenbank gelesen (hubspot_mappings).',
      notesDe:
        row.missing_fields.length > 0
          ? `Fehlende Pflichtfelder: ${row.missing_fields.join(', ')}.`
          : null,
    }));

    return { draft, versions };
  };

  const buildHubspotSnapshot = async (): Promise<HubspotMappingSnapshot> => {
    const current = flags();
    const { draft, versions } = await loadMappingDraft();
    const validation = validateMapping(draft);
    const steps: HubspotStepView[] = MAPPING_WIZARD_STEPS.map((step, index) => {
      const issues = validation.issues.filter((issue) => issue.step === step.key);
      return {
        key: step.key,
        order: index + 1,
        labelDe: step.labelDe,
        descriptionDe: step.descriptionDe,
        requiredForLaunch: step.requiredForLaunch,
        issues,
        complete: !issues.some((issue) => issue.severity === 'ERROR'),
        summaryDe: [
          'Für diesen Schritt liegt in der Datenbank keine gespeicherte Angabe vor.',
        ],
      };
    });

    return {
      generatedAt: now(),
      connection: await probeHubspot({ mapping: draft, flags: current, testLead: null, now: now() }),
      draft,
      versions,
      steps,
      validation,
      canPublish: canPublishMapping(draft),
      // Never launch-ready without a recorded test lead, and the schema records
      // none — `hubspot_sync_attempts` is per submission, not per wizard run.
      launchReady: false,
      missingForLaunchDe: [
        ...missingRequiredMappings(draft).map((issue) => issue.messageDe),
        ...(requiredMappingsComplete(draft)
          ? []
          : [
              'Das Mapping-Dokument des Assistenten hat in der Datenbank keine Ablage. Es kann gelesen, aber nicht gespeichert werden.',
            ]),
        'Es liegt kein nachgewiesener Test-Lead vor. Der Live-Launch bleibt gesperrt.',
      ],
      testLead: null,
      webhookTest: null,
      reconciliationTest: null,
      flags: current,
    };
  };

  /* ---- Settings ---------------------------------------------------------- */

  const buildSettings = async (): Promise<SettingsSnapshot> => {
    const current = flags();
    const id = await workspace();
    const [settings, roleLimits, consent, knowledge] = await Promise.all([
      db.settings.getSettings(id),
      db.settings.listRoleLimits(id),
      db.funnels.listConsentVersions(id),
      db.settings.brandKnowledge(id, { approvedOnly: false }),
    ]);

    const configured = new Map(roleLimits.map((row) => [row.role, toRoleBudgetLimit(row)]));
    const limits = Object.fromEntries(
      ROLES.map((role) => [role, configured.get(role) ?? DEFAULT_ROLE_BUDGET_LIMITS[role]]),
    ) as Record<Role, RoleBudgetLimit>;

    return {
      generatedAt: now(),
      // `workspace_members` carries roles and a profile id; the display name and
      // e-mail live in `profiles`, which no repository reads. Listing members
      // without them would mean inventing labels, so the screen shows none.
      members: [],
      roleBudgetLimits: limits,
      approvalThresholds: DEFAULT_APPROVAL_THRESHOLDS,
      experimentThresholds: {
        ...DEFAULT_EXPERIMENT_THRESHOLDS,
        ...(settings.experiment_thresholds as Partial<typeof DEFAULT_EXPERIMENT_THRESHOLDS>),
      },
      recommendationConfig: {
        ...DEFAULT_RECOMMENDATION_CONFIG,
        ...(settings.recommendation_config as Partial<typeof DEFAULT_RECOMMENDATION_CONFIG>),
      },
      attributionWindowDays: settings.attribution_window_days,
      consentVersions: [...consent].sort((a, b) => a.version - b.version).map(toConsentVersion),
      retention: {
        ...UNCONFIGURED_RETENTION_POLICY,
        ...(settings.retention_policy as Partial<RetentionPolicy>),
      },
      brand: toBrandTokens(knowledge.brand),
      featureFlags: flagViews(current),
    };
  };

  /* ---- Outbox ------------------------------------------------------------ */

  const buildOutbox = async (): Promise<OutboxSnapshot> => {
    const id = await workspace();
    const [page, stats] = await Promise.all([
      db.outbox.list({ workspaceId: id, limit: OUTBOX_PAGE_LIMIT }),
      db.outbox.stats(id),
    ]);

    const rows: OutboxRow[] = page.rows.map((row) => {
      const event = toOutboxEvent(row);
      return {
        event,
        destinationLabelDe: OUTBOX_DESTINATION_LABELS_DE[event.destination],
        retryable: event.status === 'FAILED_RETRYING' || event.status === 'DEAD_LETTER',
        href: event.campaign_id ? `/kampagnen/${event.campaign_id}` : null,
      };
    });

    return {
      generatedAt: now(),
      rows,
      // PROCESSING is counted as pending on purpose: a row a worker has claimed
      // but not yet dispatched is still owed to the provider.
      pendingCount: stats.pending + stats.processing,
      retryingCount: stats.failedRetrying,
      deadLetterCount: stats.deadLetter,
    };
  };

  /* ---- Provider health --------------------------------------------------- */

  const probeAll = async (): Promise<{
    meta: ProviderHealth;
    hubspot: ProviderHealth;
    openai: ProviderHealth;
    supabase: ProviderHealth;
    connections: IntegrationConnectionRow[];
  }> => {
    const current = flags();
    const instant = now();
    const { draft } = await loadMappingDraft();
    const [meta, hubspot, openai, supabase, connections] = await Promise.all([
      probeMeta(current, instant),
      probeHubspot({ mapping: draft, flags: current, testLead: null, now: instant }),
      probeOpenAi(instant),
      probeSupabase(instant),
      db.integrations.list(await workspace()),
    ]);
    return { meta, hubspot, openai, supabase, connections };
  };

  const buildIntegrations = async (): Promise<IntegrationsSnapshot> => {
    const current = flags();
    const [{ meta, hubspot, openai, supabase, connections }, outbox] = await Promise.all([
      probeAll(),
      workspace().then((id) => db.outbox.list({ workspaceId: id, limit: OUTBOX_PAGE_LIMIT })),
    ]);

    const byProvider = new Map(connections.map((row) => [row.provider, row]));

    const countFor = (destinationIsHubspot: boolean, status: OutboxEventRow['status']): number =>
      outbox.rows.filter(
        (row) => (row.destination === 'HUBSPOT') === destinationIsHubspot && row.status === status,
      ).length;

    // The headline sentence follows the probe result. A provider that did not
    // answer is never introduced as a live connection.
    const modeDe = (health: ProviderHealth, live: string): string =>
      health.state === 'FIXTURE'
        ? 'Fixture-Modus: keine Verbindung zum Anbieter, alle Daten stammen aus dem Testdatensatz.'
        : health.state === 'NOT_CONFIGURED'
          ? 'Nicht konfiguriert: es sind keine Zugangsdaten hinterlegt.'
          : health.state === 'ERROR'
            ? 'Keine bestätigte Verbindung: Die letzte Prüfung ist fehlgeschlagen. Die Einzelheiten stehen in den Prüfungen unten.'
            : health.state === 'DEGRADED'
              ? `${live} Einzelne Prüfungen sind noch offen — siehe unten.`
              : live;

    const card = (
      provider: Provider,
      health: ProviderHealth,
      live: string,
      extras: Pick<
        ProviderCardData,
        'lastSyncAt' | 'errorCount' | 'deadLetterCount' | 'setupHref' | 'setupLabelDe'
      >,
    ): ProviderCardData => {
      const row = byProvider.get(provider) ?? null;
      return {
        provider,
        connection: {
          id: row?.id ?? `connection-${provider.toLowerCase()}`,
          provider,
          // The probe is the authority on the state right now; the stored row
          // is what someone recorded last, which may be older than this render.
          state: health.state,
          accountLabel: row?.account_label ?? null,
          externalAccountId: row?.external_account_id ?? null,
          grantedScopes: row?.granted_scopes ?? [],
          connectedAt: row?.connected_at ?? null,
          expiresAt: row?.expires_at ?? null,
          lastCheckedAt: health.checkedAt,
        },
        health,
        modeDe: modeDe(health, live),
        ...extras,
      };
    };

    const cursorFor = async (provider: Provider, resource: string): Promise<string | null> => {
      const cursor = await db.integrations.getCursor(await workspace(), provider, resource);
      return cursor?.last_success_at ?? null;
    };

    const [metaSync, hubspotSync] = await Promise.all([
      cursorFor('META', 'insights'),
      cursorFor('HUBSPOT', 'deals'),
    ]);

    return {
      generatedAt: now(),
      flags: current,
      providers: [
        card('META', meta, 'Live-Verbindung zur Meta Marketing API.', {
          lastSyncAt: metaSync,
          errorCount: countFor(false, 'FAILED_RETRYING'),
          deadLetterCount: countFor(false, 'DEAD_LETTER'),
          setupHref: '/integrationen/meta',
          setupLabelDe: 'Meta-Assistent öffnen',
        }),
        card('HUBSPOT', hubspot, 'Live-Verbindung zum HubSpot-Portal.', {
          lastSyncAt: hubspotSync,
          errorCount: countFor(true, 'FAILED_RETRYING'),
          deadLetterCount: countFor(true, 'DEAD_LETTER'),
          setupHref: '/integrationen/hubspot',
          setupLabelDe: 'Mapping-Assistent öffnen',
        }),
        card('OPENAI', openai, 'Live-Verbindung zur OpenAI Responses API.', {
          lastSyncAt: null,
          errorCount: 0,
          deadLetterCount: 0,
          setupHref: null,
          setupLabelDe: null,
        }),
        card('SUPABASE', supabase, 'Live-Verbindung zum Supabase-Projekt.', {
          lastSyncAt: null,
          errorCount: 0,
          deadLetterCount: 0,
          setupHref: null,
          setupLabelDe: null,
        }),
      ],
    };
  };

  /* ---- Heute ------------------------------------------------------------- */

  const buildToday = async (): Promise<TodaySnapshot> => {
    const instant = now();
    const today = utcDayOf(instant);
    const id = await workspace();

    const [campaignPage, outbox, recommendations, rollups] = await Promise.all([
      db.campaigns.list({ workspaceId: id, states: ['LIVE', 'PAUSED'], limit: OUTBOX_PAGE_LIMIT }),
      db.outbox.list({
        workspaceId: id,
        statuses: ['FAILED_RETRYING', 'DEAD_LETTER'],
        limit: OUTBOX_PAGE_LIMIT,
      }),
      db.recommendations.listOpen(id),
      db.rollups.query({ workspaceId: id, since: today, until: today }),
    ]);

    const campaigns = campaignPage.rows;
    const approvals = await db.campaigns.loadApprovalsForCampaigns(
      campaigns.map((campaign) => campaign.id),
    );

    const rollupsByCampaign = new Map<string, PerformanceRollupRow[]>();
    for (const row of rollups) {
      if (!row.campaign_id) continue;
      const bucket = rollupsByCampaign.get(row.campaign_id);
      if (bucket) bucket.push(row);
      else rollupsByCampaign.set(row.campaign_id, [row]);
    }

    const activeCampaigns: ActiveCampaignSummary[] = campaigns.map((campaign) => {
      const rows = rollupsByCampaign.get(campaign.id) ?? [];
      const spend = rows.length > 0 ? sumRollup(rows, 'spend_minor') : null;
      const leads = rows.length > 0 ? sumRollup(rows, 'leads') : null;
      const coverage = rows.find((row) => row.attribution_coverage !== null);
      const maturity: DataMaturity =
        rows.find((row) => row.data_maturity === 'IMMATURE')?.data_maturity ??
        rows.find((row) => row.data_maturity === 'PARTIAL')?.data_maturity ??
        (rows.length > 0 ? 'MATURE' : 'IMMATURE');

      return {
        id: campaign.id,
        nameDe: campaign.name,
        state: campaign.state,
        errorState: campaign.error_state,
        spendTodayMinor: spend,
        currency: campaign.currency,
        leadsToday: leads,
        targetCostPerLeadMinor: campaign.target_cpl_minor,
        // Never a cost per lead without a lead: a zero denominator is unknown,
        // not free.
        costPerLeadMinor: spend !== null && leads !== null && leads > 0 ? Math.round(spend / leads) : null,
        maturity,
        attributionCoverage: coverage?.attribution_coverage ?? null,
        href: `/kampagnen/${campaign.id}/live-performance`,
      };
    });

    const nameById = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
    const items: TodayItem[] = [];

    for (const campaign of campaigns) {
      if (!campaign.error_state) continue;
      items.push({
        id: `error-campaign-${campaign.id}`,
        kind: 'ERROR',
        titleDe: `${campaign.name}: ${campaign.error_state}`,
        detailDe:
          campaign.error_detail_de ??
          'Die Kampagne meldet einen Fehlerzustand. Solange er besteht, sind ihre Zahlen unvollständig.',
        href: `/kampagnen/${campaign.id}/live-performance`,
        hrefLabelDe: 'Zur Kampagne',
        occurredAt: campaign.updated_at,
        campaignNameDe: campaign.name,
        badge: { kind: 'campaignError', state: campaign.error_state },
        severity: 'HIGH',
      });
    }

    const deadLetters = outbox.rows.filter((row) => row.status === 'DEAD_LETTER');
    if (deadLetters.length > 0) {
      items.push({
        id: 'error-outbox-dead-letter',
        kind: 'ERROR',
        titleDe: `${deadLetters.length} Ereignis(se) im Dead Letter`,
        detailDe:
          'Diese Ereignisse haben den Anbieter endgültig nicht erreicht. Bis sie zugestellt sind, fehlen die zugehörigen Zahlen.',
        href: '/integrationen/outbox',
        hrefLabelDe: 'Zur Fehlerliste',
        occurredAt: deadLetters[0].updated_at,
        campaignNameDe: nameById.get(deadLetters[0].campaign_id ?? '') ?? null,
        badge: { kind: 'outbox', state: 'DEAD_LETTER' },
        severity: 'HIGH',
      });
    }

    for (const [campaignId, list] of approvals) {
      for (const approval of list) {
        if (approval.state !== 'PENDING') continue;
        items.push({
          id: `approval-${approval.id}`,
          kind: 'APPROVAL',
          titleDe: `Freigabe offen: ${approval.kind}`,
          detailDe: 'Diese Freigabe blockiert die Arbeit anderer Personen.',
          href: `/kampagnen/${campaignId}/freigaben`,
          hrefLabelDe: 'Zur Freigabe',
          occurredAt: approval.created_at,
          campaignNameDe: nameById.get(campaignId) ?? null,
          badge: { kind: 'approval', state: approval.state },
          severity: 'HIGH',
        });
      }
    }

    for (const recommendation of recommendations) {
      items.push({
        id: `recommendation-${recommendation.id}`,
        kind: 'RECOMMENDATION',
        titleDe: recommendation.title_de,
        detailDe: recommendation.summary_de,
        href: `/kampagnen/${recommendation.campaign_id}/empfehlungen`,
        hrefLabelDe: 'Zur Empfehlung',
        occurredAt: recommendation.created_at,
        campaignNameDe: nameById.get(recommendation.campaign_id) ?? null,
        badge: { kind: 'recommendation', state: recommendation.state },
        severity: recommendation.risk === 'HIGH' ? 'HIGH' : 'MEDIUM',
      });
    }

    // The declared kind order is the display order; inside a kind, oldest first.
    const order = new Map(
      (['ERROR', 'APPROVAL', 'RECOMMENDATION'] as const).map((kind, index) => [kind, index]),
    );
    items.sort(
      (a, b) =>
        (order.get(a.kind as 'ERROR') ?? 99) - (order.get(b.kind as 'ERROR') ?? 99) ||
        a.occurredAt.localeCompare(b.occurredAt),
    );

    return { generatedAt: instant, activeCampaigns, items };
  };

  /* ---- Library ----------------------------------------------------------- */

  const buildLibrary = async (): Promise<LibrarySnapshot> => {
    const knowledge = await db.settings.brandKnowledge(await workspace(), { approvedOnly: false });

    return {
      generatedAt: now(),
      // Creatives, angles and their versions are per campaign in the schema and
      // have no workspace-wide listing; the Campaign Room is where they are read
      // today. Nothing is invented here to fill the gap.
      creatives: [],
      angles: [],
      offers: knowledge.offers.map((offer) => ({
        id: offer.id,
        nameDe: offer.name,
        type: offer.offer_type,
        // The promise and the effort promise live in the offer's published
        // version spec, which no repository reads; the card says so rather than
        // showing a sentence nobody wrote.
        promiseDe: 'Das Nutzenversprechen steht in der Offer-Version und wird hier nicht geladen.',
        effortPromiseDe: null,
        usedInCampaigns: 0,
        href: null,
      })),
      // An approved evidence item is an INDICATION, never a FACT: FACT also
      // requires a mature cohort and trustworthy attribution, and an approval
      // flag says nothing about either.
      claims: knowledge.evidence.map((item) => ({
        id: item.id,
        textDe: item.statement,
        confidence: item.approved ? ('INDICATION' as const) : ('HYPOTHESIS' as const),
        evidence: item.approved
          ? {
              kindDe: item.kind,
              summaryDe: item.statement,
              sourceRefDe: item.source,
              approved: item.approved,
            }
          : null,
        requiresHypothesisLabel: !item.approved,
      })),
      caseStudies: knowledge.caseStudies.map((study) => ({
        id: study.id,
        clientDe: study.client,
        industryDe: study.industry,
        challengeDe: study.challenge,
        outcomeDe: study.outcome,
        metrics: [],
        approved: study.approved,
        usableInAds: study.approved && study.usable_in_ads,
      })),
      testimonials: knowledge.testimonials.map((testimonial) => ({
        id: testimonial.id,
        quoteDe: testimonial.quote,
        authorDe: testimonial.author_name,
        companyDe: testimonial.company,
        approved: testimonial.approved,
        usableInAds: testimonial.approved && testimonial.usable_in_ads,
      })),
      faqs: knowledge.faqs.map((faq) => ({
        id: faq.id,
        questionDe: faq.question,
        answerDe: faq.answer,
        approved: faq.approved,
      })),
      guardrails: knowledge.guardrails.map((guardrail) => ({
        id: guardrail.id,
        kindDe: guardrail.kind,
        pattern: guardrail.pattern,
        reasonDe: guardrail.reason_de,
        severity: guardrail.severity,
      })),
      historicalCampaigns: [],
    };
  };

  /* ---- The port ---------------------------------------------------------- */

  return {
    loadToday: buildToday,
    loadLibrary: buildLibrary,
    loadIntegrations: buildIntegrations,
    loadMetaSetup: () => buildMetaSetupSnapshot(flags(), now()),
    loadHubspotMapping: buildHubspotSnapshot,
    loadOutbox: buildOutbox,
    loadSettings: buildSettings,

    async recheckProvider({ provider }) {
      const current = flags();
      const instant = now();
      switch (provider) {
        case 'META':
          return probeMeta(current, instant);
        case 'HUBSPOT': {
          const { draft } = await loadMappingDraft();
          return probeHubspot({ mapping: draft, flags: current, testLead: null, now: instant });
        }
        case 'OPENAI':
          return probeOpenAi(instant);
        case 'SUPABASE':
          return probeSupabase(instant);
      }
    },

    async retryOutboxEvent({ eventId }) {
      const current = flags();
      const rows = await db.outbox.list({ workspaceId: await workspace(), limit: OUTBOX_PAGE_LIMIT });
      const row = rows.rows.find((candidate) => candidate.event_id === eventId) ?? null;
      if (!row) {
        return {
          eventId,
          state: 'DEAD_LETTER',
          messageDe: 'Dieses Ereignis existiert nicht mehr.',
          providerConfirmed: false,
          dryRun: null,
        };
      }

      const provider = row.destination === 'HUBSPOT' ? 'HUBSPOT' : 'META';
      const writesEnabled =
        current.externalWritesEnabled &&
        (provider === 'HUBSPOT' ? current.hubspotWritesEnabled : current.metaCapiEnabled);

      if (!writesEnabled) {
        return {
          eventId,
          state: row.status,
          messageDe:
            'Dry-Run – nicht ausgeführt. Der Wiederholungsversuch wurde vorbereitet, aber nichts gesendet.',
          providerConfirmed: false,
          dryRun: dryRun(
            provider,
            `outbox.retry:${row.event_name}`,
            {
              event_id: row.event_id,
              event_name: row.event_name,
              event_time: row.event_time,
              destination: row.destination,
              attempt: row.attempt_count + 1,
            },
            provider === 'HUBSPOT'
              ? 'HubSpot-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / HUBSPOT_WRITES_ENABLED).'
              : 'Der Conversions-API-Versand ist deaktiviert (EXTERNAL_WRITES_ENABLED / META_CAPI_ENABLED).',
          ),
        };
      }

      // Re-arming the row is all the console may do: the dispatch itself belongs
      // to the outbox worker, and only the provider's own acknowledgement — which
      // this path never sees — may be reported as a confirmation.
      const { event } = await db.outbox.markFailed(
        { id: row.id, event_id: row.event_id, attempt_count: 0 },
        'Manuell erneut eingeplant.',
      );
      return {
        eventId,
        state: event.status,
        messageDe:
          'Das Ereignis wurde erneut eingeplant. Zugestellt gilt es erst, wenn der Anbieter es quittiert hat.',
        providerConfirmed: false,
        dryRun: null,
      };
    },

    async saveMappingStep() {
      throw notStorable('Das HubSpot-Mapping des Assistenten', 'hubspot_mappings.field_map');
    },

    async applyFixtureMapping() {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe:
          'Das Fixture-Mapping darf nicht in einen produktiven Arbeitsbereich geladen werden. Es existiert nur, damit der Assistent ohne beschriebenes Portal begehbar ist.',
        retryable: false,
      });
    },

    async publishMapping() {
      throw notStorable('Eine Mapping-Version', 'hubspot_mappings.field_map');
    },

    async runMappingTestLead({ initiatedBy }) {
      const current = flags();
      const { draft } = await loadMappingDraft();
      return runTestLead(
        { mapping: draft, initiatedBy },
        { provider: hubspotProviderFor(current), store: createInMemorySyncStore(), flags: current },
      );
    },

    async runWebhookTest() {
      const { draft } = await loadMappingDraft();
      const configured = draft.webhook.subscribedObjectTypes.length > 0;
      const result: ProbeResultView = {
        key: 'webhook_test',
        labelDe: 'Webhook-Test',
        status: configured ? 'AWAITING_EXTERNAL_INPUT' : 'FAIL',
        detailDe: configured
          ? 'Abonnements sind hinterlegt. Signaturen können erst geprüft werden, wenn HUBSPOT_WEBHOOK_SECRET gesetzt ist — bis dahin werden eingehende Webhooks abgelehnt.'
          : 'Es sind keine Webhook-Abonnements hinterlegt. Änderungen in HubSpot würden nur über den stündlichen Abgleich erkannt.',
        checkedAt: now(),
        dryRun: null,
      };
      return result;
    },

    async runReconciliationTest() {
      const current = flags();
      const { draft } = await loadMappingDraft();
      const instant = now();
      const report = await reconcile(
        { scope: 'HOURLY', mapping: draft },
        {
          provider: hubspotProviderFor(current),
          store: createInMemorySyncStore(),
          now: () => instant,
        },
      );
      return {
        key: 'reconciliation_test',
        labelDe: 'Abgleich-Test',
        status: report.discrepancies.length > 0 ? 'WARN' : 'PASS',
        detailDe: [
          `${report.objectsRead} Objekt(e) gelesen, ${report.eventsEmitted.length} Ereignis(se) erzeugt, ${report.discrepancies.length} Abweichung(en).`,
          ...report.correctionsDe,
          ...report.messagesDe,
        ].join(' '),
        checkedAt: instant,
        dryRun: null,
      };
    },

    async saveMemberRoles({ memberId, roles }) {
      await db.settings.setMemberRoles(await workspace(), asId<Uuid>(memberId), roles);
      return buildSettings();
    },

    async saveRoleBudgetLimit({ limit }) {
      await db.settings.upsertRoleLimit({
        workspace_id: await workspace(),
        role: limit.role,
        max_single_increase_pct: limit.maxSingleIncreasePct,
        max_daily_budget_minor: limit.maxDailyBudgetMinor,
        max_scales_per_24h: limit.maxScalesPer24h,
        may_pause: limit.mayPause,
        created_by: null,
        updated_by: null,
      });
      return buildSettings();
    },

    async saveApprovalThresholds() {
      throw notStorable('Die Freigabeschwellen', 'workspace_settings');
    },

    async saveExperimentThresholds({ thresholds }) {
      await db.settings.updateSettings(await workspace(), {
        experiment_thresholds: toJson(thresholds),
      });
      return buildSettings();
    },

    async saveRecommendationConfig({ config }) {
      await db.settings.updateSettings(await workspace(), {
        recommendation_config: toJson(config),
      });
      return buildSettings();
    },

    async saveAttributionWindow({ windowDays }) {
      await db.settings.updateSettings(await workspace(), {
        attribution_window_days: windowDays,
      });
      return buildSettings();
    },

    async addConsentVersion({ textDe, purposes, privacyPolicyUrl, now: at }) {
      const id = await workspace();
      const existing = await db.funnels.listConsentVersions(id);
      const nextVersion = Math.max(0, ...existing.map((row) => row.version)) + 1;
      // Append only: a published consent text is what a visitor actually saw and
      // is never edited in place.
      await db.funnels.createConsentVersion({
        workspace_id: id,
        version: nextVersion,
        text_de: textDe,
        purposes,
        privacy_policy_url: privacyPolicyUrl,
        effective_from: at,
        effective_until: null,
        created_by: null,
        updated_by: null,
      });
      return buildSettings();
    },

    async saveRetentionPolicy({ policy, configuredBy, now: at }) {
      await db.settings.updateSettings(await workspace(), {
        retention_policy: toJson({ ...policy, configuredBy, configuredAt: at }),
      });
      return buildSettings();
    },

    async saveBrandTokens() {
      throw notStorable('Die Markenfarben', 'brand_profiles');
    },
  };
}
