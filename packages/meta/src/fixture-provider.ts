/**
 * `FixtureMetaProvider` — deterministic, realistic, and honest about being a
 * fixture.
 *
 * It generates roughly eighteen months of history: six campaigns, two ad sets
 * each, three ads per ad set, one creative per ad, and a daily insights row per
 * ad per delivery day. Numbers are produced from a seeded PRNG, so two runs —
 * and two processes — see byte-identical data. That is what makes "import the
 * same data twice, get zero duplicates" a meaningful assertion.
 *
 * The one thing it will never do is claim a connection: `health()` reports
 * `state: 'FIXTURE'` and every credential-dependent probe reports
 * `AWAITING_EXTERNAL_INPUT` (AGENTS.md rule 1).
 */
import {
  type FeatureFlags,
  type HealthCheck,
  type MetaEntityStatus,
  type Money,
  type ProviderHealth,
  DomainError,
  canDispatchCapi,
  canWriteMeta,
  dryRun,
  fnv1a32,
  money,
  nowIso,
  rate,
  redact,
  rollUpHealth,
  sha256Hex,
} from '@am/domain';
import {
  type DraftCreatedObject,
  type DraftCreationResult,
  type DraftPlan,
  draftPlanPreview,
  extractIdempotencyKey,
} from './draft';
import { assertOutboundAllowed } from './import-mode';
import type {
  CapiDispatchRequest,
  CapiDispatchResult,
  CreativeAssetDownload,
  InsightsRequest,
  MetaEntityRef,
  MetaEntitySnapshot,
  MetaMutationResult,
  MetaProvider,
  MutationOutcome,
  PageRequest,
  PauseCreativeInput,
  PauseEntityInput,
  ProviderPage,
  ResumeEntityInput,
  UpdateBudgetInput,
} from './provider';
import {
  type InsightsLevel,
  type MetaAdAccountRecord,
  type MetaAdCreativeRecord,
  type MetaAdRecord,
  type MetaAdSetRecord,
  type MetaCampaignRecord,
  type MetaDatasetRecord,
  type MetaInstagramActorRecord,
  type MetaInsightsDailyRow,
  type MetaPageRecord,
  type MetaPixelRecord,
  type RawProviderPayload,
} from './types';

/* -------------------------------------------------------------------------- */
/* Fixture constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Fixed anchor so the dataset never shifts with the wall clock. Overridable for
 * scenarios that need history relative to a different "today".
 */
export const FIXTURE_ANCHOR = '2026-06-30T00:00:00.000Z';
export const FIXTURE_SEED = 20260630;

export const FIXTURE_AD_ACCOUNT_ID = 'act_1094732810554371';
export const FIXTURE_BUSINESS_ID = '210946325118804';
export const FIXTURE_PAGE_ID = '104882736611905';
export const FIXTURE_INSTAGRAM_ACTOR_ID = '17841409876543210';
export const FIXTURE_PIXEL_ID = '1180347629945512';
export const FIXTURE_DATASET_ID = '1420938475610293';
export const FIXTURE_CURRENCY = 'EUR';

export const FIXTURE_CAMPAIGN_COUNT = 6;
const AD_SETS_PER_CAMPAIGN = 2;
const ADS_PER_AD_SET = 3;

const ID_PREFIX: Record<'CAMPAIGN' | 'ADSET' | 'AD' | 'AD_CREATIVE', string> = {
  CAMPAIGN: '23851',
  ADSET: '23852',
  AD: '23853',
  AD_CREATIVE: '23854',
};

function fixtureId(kind: keyof typeof ID_PREFIX, index: number): string {
  return `${ID_PREFIX[kind]}${String(100_000_000 + index * 137).padStart(11, '0')}`;
}

/**
 * Six angles matching the mandated communication principles, so the fixture
 * data is usable for the diversity and learning surfaces too.
 */
const FIXTURE_CAMPAIGN_BLUEPRINTS: readonly {
  name: string;
  objective: string;
  principle: string;
  monthsAgo: number;
  runDays: number;
  dailyBudgetMinor: number;
  quality: number;
}[] = [
  {
    name: 'Potenzialanalyse Handwerk – Problem & Schmerz',
    objective: 'OUTCOME_LEADS',
    principle: 'PROBLEM_PAIN',
    monthsAgo: 17,
    runDays: 42,
    dailyBudgetMinor: 15_000,
    quality: 0.82,
  },
  {
    name: 'Benchmark Maschinenbau – Konkretes Ergebnis',
    objective: 'OUTCOME_LEADS',
    principle: 'CONCRETE_RESULT',
    monthsAgo: 14,
    runDays: 56,
    dailyBudgetMinor: 25_000,
    quality: 1.14,
  },
  {
    name: 'Audit Logistik – Vergleich zur Alternative',
    objective: 'OUTCOME_LEADS',
    principle: 'COMPARISON_ALTERNATIVE',
    monthsAgo: 11,
    runDays: 35,
    dailyBudgetMinor: 12_000,
    quality: 0.71,
  },
  {
    name: 'Strategiegespräch Bau – Beweis & Fallstudie',
    objective: 'OUTCOME_LEADS',
    principle: 'PROOF_CASE_DATAPOINT',
    monthsAgo: 8,
    runDays: 63,
    dailyBudgetMinor: 35_000,
    quality: 1.28,
  },
  {
    name: 'Rechner Energie – Einwandbehandlung',
    objective: 'OUTCOME_LEADS',
    principle: 'OBJECTION_HANDLING',
    monthsAgo: 5,
    runDays: 49,
    dailyBudgetMinor: 20_000,
    quality: 0.96,
  },
  {
    name: 'Checkliste Pflege – Konträre Einsicht',
    objective: 'OUTCOME_LEADS',
    principle: 'CONTRARIAN_INSIGHT',
    // Still running at the anchor date, so the fixture always has one live
    // campaign to steer, pause and scale against.
    monthsAgo: 2,
    runDays: 75,
    dailyBudgetMinor: 28_000,
    quality: 1.05,
  },
];

const AD_SET_AUDIENCES = ['Entscheider 30–55', 'Lookalike 1 % Kunden'];
const CREATIVE_FORMATS = ['1:1 Statisch', '4:5 Statisch', '9:16 Story'];

/** Monday…Sunday. B2B delivery is weaker at the weekend; this encodes that. */
const WEEKDAY_FACTORS = [1.06, 1.11, 1.09, 1.04, 0.93, 0.72, 0.78];

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                          */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBetween(seedKey: string, min: number, max: number): number {
  return min + mulberry32(fnv1a32(seedKey))() * (max - min);
}

function addMonths(iso: string, months: number): Date {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Generated dataset                                                           */
/* -------------------------------------------------------------------------- */

interface FixtureDataset {
  account: MetaAdAccountRecord;
  campaigns: MetaCampaignRecord[];
  adSets: MetaAdSetRecord[];
  ads: MetaAdRecord[];
  creatives: MetaAdCreativeRecord[];
  insights: MetaInsightsDailyRow[];
}

function buildDataset(anchor: string, currency: string): FixtureDataset {
  const campaigns: MetaCampaignRecord[] = [];
  const adSets: MetaAdSetRecord[] = [];
  const ads: MetaAdRecord[] = [];
  const creatives: MetaAdCreativeRecord[] = [];
  const insights: MetaInsightsDailyRow[] = [];

  const anchorDate = new Date(anchor);
  let adSetIndex = 0;
  let adIndex = 0;

  FIXTURE_CAMPAIGN_BLUEPRINTS.forEach((blueprint, campaignIndex) => {
    const campaignId = fixtureId('CAMPAIGN', campaignIndex);
    const start = addMonths(anchor, -blueprint.monthsAgo);
    const stop = addDays(start, blueprint.runDays);
    const stillRunning = stop.getTime() > anchorDate.getTime();
    const dailyBudgetMinor = blueprint.dailyBudgetMinor;

    campaigns.push({
      externalId: campaignId,
      accountExternalId: FIXTURE_AD_ACCOUNT_ID,
      name: blueprint.name,
      objective: blueprint.objective,
      status: stillRunning ? 'ACTIVE' : 'PAUSED',
      statusRaw: stillRunning ? 'ACTIVE' : 'PAUSED',
      effectiveStatus: stillRunning ? 'ACTIVE' : 'CAMPAIGN_PAUSED',
      buyingType: 'AUCTION',
      bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
      dailyBudget: null,
      lifetimeBudget: null,
      specialAdCategories: [],
      createdAt: addDays(start, -3).toISOString(),
      updatedAt: stop.toISOString(),
      startedAt: start.toISOString(),
      stoppedAt: stillRunning ? null : stop.toISOString(),
    });

    for (let s = 0; s < AD_SETS_PER_CAMPAIGN; s++) {
      const adSetId = fixtureId('ADSET', adSetIndex);
      const adSetBudget = Math.round(dailyBudgetMinor / AD_SETS_PER_CAMPAIGN);
      adSets.push({
        externalId: adSetId,
        campaignExternalId: campaignId,
        name: `${blueprint.name} · ${AD_SET_AUDIENCES[s]}`,
        status: stillRunning ? 'ACTIVE' : 'PAUSED',
        statusRaw: stillRunning ? 'ACTIVE' : 'PAUSED',
        effectiveStatus: stillRunning ? 'ACTIVE' : 'ADSET_PAUSED',
        dailyBudget: money(adSetBudget, currency),
        lifetimeBudget: null,
        bidAmount: null,
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        billingEvent: 'IMPRESSIONS',
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        destinationType: 'WEBSITE',
        promotedPixelId: FIXTURE_PIXEL_ID,
        promotedCustomEventType: 'LEAD',
        startedAt: start.toISOString(),
        endsAt: stillRunning ? null : stop.toISOString(),
        createdAt: addDays(start, -2).toISOString(),
        updatedAt: stop.toISOString(),
      });

      for (let a = 0; a < ADS_PER_AD_SET; a++) {
        const adId = fixtureId('AD', adIndex);
        const creativeId = fixtureId('AD_CREATIVE', adIndex);
        const format = CREATIVE_FORMATS[a % CREATIVE_FORMATS.length];
        const adName = `${blueprint.principle} · ${format}`;

        ads.push({
          externalId: adId,
          campaignExternalId: campaignId,
          adSetExternalId: adSetId,
          creativeExternalId: creativeId,
          name: adName,
          status: stillRunning ? 'ACTIVE' : 'PAUSED',
          statusRaw: stillRunning ? 'ACTIVE' : 'PAUSED',
          effectiveStatus: stillRunning ? 'ACTIVE' : 'AD_PAUSED',
          createdAt: addDays(start, -1).toISOString(),
          updatedAt: stop.toISOString(),
        });

        creatives.push({
          externalId: creativeId,
          name: `${adName} – Creative`,
          pageId: FIXTURE_PAGE_ID,
          instagramActorId: FIXTURE_INSTAGRAM_ACTOR_ID,
          linkUrl: `https://funnel.example.de/${blueprint.principle.toLowerCase()}?utm_source=meta&utm_medium=paid_social&utm_campaign=${campaignIndex + 1}`,
          primaryText: `${blueprint.name}: in zwei Minuten zur Einschätzung – ohne Vertriebsgespräch vorab.`,
          headline: blueprint.name.split('–')[0].trim(),
          description: 'Kostenlose Analyse für mittelständische Unternehmen.',
          callToActionType: 'LEARN_MORE',
          imageHash: `hash_${creativeId.slice(-10)}`,
          imageUrl: `https://scontent.xx.fbcdn.net/v/fixture_${creativeId}.jpg`,
          thumbnailUrl: `https://scontent.xx.fbcdn.net/v/fixture_${creativeId}_t.jpg`,
          videoId: null,
          urlTags: 'meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}',
        });

        // Per-ad creative variation: some creatives simply work better.
        const creativeQuality = seededBetween(`quality:${adId}`, 0.68, 1.42) * blueprint.quality;
        const baseCpmMinor = seededBetween(`cpm:${adId}`, 1_180, 3_260);
        const baseLinkCtr = seededBetween(`ctr:${adId}`, 0.005, 0.019) * creativeQuality;
        const baseCvr = seededBetween(`cvr:${adId}`, 0.018, 0.075) * creativeQuality;
        const adBudgetMinor = Math.round(adSetBudget / ADS_PER_AD_SET);

        const deliveryDays = Math.min(
          blueprint.runDays,
          Math.max(
            0,
            Math.round((anchorDate.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)),
          ),
        );

        for (let day = 0; day < deliveryDays; day++) {
          const date = addDays(start, day);
          const weekday = (date.getUTCDay() + 6) % 7; // 0 = Monday
          const weekdayFactor = WEEKDAY_FACTORS[weekday];
          // Learning phase: delivery ramps over the first three days.
          const rampFactor = day < 3 ? 0.55 + day * 0.15 : 1;
          const noise = seededBetween(`day:${adId}:${day}`, 0.86, 1.14);

          const spendMinor = Math.round(adBudgetMinor * weekdayFactor * rampFactor * noise);
          if (spendMinor <= 0) continue;

          const cpmMinor = baseCpmMinor * (2 - weekdayFactor) * noise;
          const impressions = Math.max(1, Math.round((spendMinor / cpmMinor) * 1000));
          const frequency = seededBetween(`freq:${adId}:${day}`, 1.08, 2.35);
          const reach = Math.max(1, Math.round(impressions / frequency));
          const linkClicks = Math.round(impressions * baseLinkCtr * noise);
          const clicks = Math.round(linkClicks * seededBetween(`clk:${adId}:${day}`, 1.18, 1.62));
          const leads = Math.round(linkClicks * baseCvr * noise);

          insights.push({
            date: isoDay(date),
            level: 'ad',
            externalId: adId,
            accountExternalId: FIXTURE_AD_ACCOUNT_ID,
            campaignExternalId: campaignId,
            adSetExternalId: adSetId,
            adExternalId: adId,
            name: adName,
            currency,
            impressions,
            reach,
            frequency,
            clicks,
            linkClicks,
            leads,
            spend: money(spendMinor, currency),
            ctr: rate(clicks, impressions),
            linkCtr: rate(linkClicks, impressions),
            cpc: linkClicks > 0 ? money(Math.round(spendMinor / linkClicks), currency) : null,
            cpm: money(Math.round((spendMinor / impressions) * 1000), currency),
            cpl: leads > 0 ? money(Math.round(spendMinor / leads), currency) : null,
          });
        }

        adIndex++;
      }
      adSetIndex++;
    }
  });

  insights.sort((a, b) => (a.date === b.date ? a.externalId.localeCompare(b.externalId) : a.date.localeCompare(b.date)));

  return {
    account: {
      externalId: FIXTURE_AD_ACCOUNT_ID,
      accountId: FIXTURE_AD_ACCOUNT_ID.replace('act_', ''),
      name: 'A&M Beratung – Werbekonto (Fixture)',
      currency,
      timezone: 'Europe/Berlin',
      accountStatus: 1,
      businessId: FIXTURE_BUSINESS_ID,
      businessName: 'A&M Beratung (Fixture)',
    },
    campaigns,
    adSets,
    ads,
    creatives,
    insights,
  };
}

/* -------------------------------------------------------------------------- */
/* Insights aggregation                                                        */
/* -------------------------------------------------------------------------- */

function groupKeyFor(row: MetaInsightsDailyRow, level: InsightsLevel): string | null {
  switch (level) {
    case 'ad':
      return row.adExternalId;
    case 'adset':
      return row.adSetExternalId;
    case 'campaign':
      return row.campaignExternalId;
    case 'account':
      return row.accountExternalId;
    default:
      return null;
  }
}

function aggregate(
  rows: readonly MetaInsightsDailyRow[],
  level: InsightsLevel,
): MetaInsightsDailyRow[] {
  if (level === 'ad') return [...rows];

  const buckets = new Map<string, MetaInsightsDailyRow>();
  for (const row of rows) {
    const groupId = groupKeyFor(row, level);
    if (!groupId) continue;
    const key = `${row.date}:${groupId}`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        ...row,
        level,
        externalId: groupId,
        adExternalId: null,
        adSetExternalId: level === 'adset' ? row.adSetExternalId : null,
        name: null,
      });
      continue;
    }
    existing.impressions += row.impressions;
    existing.reach += row.reach;
    existing.clicks += row.clicks;
    existing.linkClicks += row.linkClicks;
    existing.leads += row.leads;
    existing.spend = money(existing.spend.amountMinor + row.spend.amountMinor, existing.currency);
  }

  return [...buckets.values()]
    .map((row) => ({
      ...row,
      frequency: row.reach > 0 ? row.impressions / row.reach : 0,
      ctr: rate(row.clicks, row.impressions),
      linkCtr: rate(row.linkClicks, row.impressions),
      cpc:
        row.linkClicks > 0
          ? money(Math.round(row.spend.amountMinor / row.linkClicks), row.currency)
          : null,
      cpm:
        row.impressions > 0
          ? money(Math.round((row.spend.amountMinor / row.impressions) * 1000), row.currency)
          : null,
      cpl:
        row.leads > 0 ? money(Math.round(row.spend.amountMinor / row.leads), row.currency) : null,
    }))
    .sort((a, b) =>
      a.date === b.date ? a.externalId.localeCompare(b.externalId) : a.date.localeCompare(b.date),
    );
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface FixtureProviderOptions {
  flags: FeatureFlags;
  anchor?: string;
  currency?: string;
  /** `true` fails every call; a number fails the first N calls. */
  simulateRateLimit?: boolean | number;
  /** Every call fails with a permission error until switched off. */
  simulatePermissionError?: boolean;
  /** Fails the first N calls with a retryable provider error. */
  simulateTransientFailure?: number;
  pageSize?: number;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

export class FixtureMetaProvider implements MetaProvider {
  readonly mode = 'FIXTURE' as const;

  private readonly options: FixtureProviderOptions;
  private readonly data: FixtureDataset;
  private readonly currency: string;
  private readonly pageSize: number;

  /** Mutable overlay so a mutation is visible to a later `getEntity` read. */
  private readonly statusOverrides = new Map<string, MetaEntityStatus>();
  private readonly budgetOverrides = new Map<string, Money>();
  private readonly drafts = new Map<string, DraftCreationResult>();
  private readonly capiBatches: CapiDispatchRequest[] = [];

  private rateLimitRemaining: number;
  private transientRemaining: number;
  private draftCounter = 0;

  constructor(options: FixtureProviderOptions) {
    this.options = options;
    this.currency = options.currency ?? FIXTURE_CURRENCY;
    this.pageSize = options.pageSize ?? 25;
    this.data = buildDataset(options.anchor ?? FIXTURE_ANCHOR, this.currency);
    this.rateLimitRemaining =
      options.simulateRateLimit === true
        ? Number.POSITIVE_INFINITY
        : typeof options.simulateRateLimit === 'number'
          ? options.simulateRateLimit
          : 0;
    this.transientRemaining = options.simulateTransientFailure ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Failure injection                                                      */
  /* ---------------------------------------------------------------------- */

  private failIfSimulated(operation: string): void {
    if (this.options.simulatePermissionError) {
      throw new DomainError('FORBIDDEN', {
        messageDe:
          'Meta hat den Zugriff verweigert: Dem verbundenen Konto fehlen die erforderlichen Berechtigungen für dieses Werbekonto.',
        retryable: false,
        details: { provider: 'META', operation, meta_code: 200, simulated: true },
      });
    }
    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining -= 1;
      throw new DomainError('PROVIDER_RATE_LIMITED', {
        messageDe:
          'Meta hat das Anfragelimit erreicht. Die Anfrage wird automatisch mit Verzögerung erneut versucht.',
        retryable: true,
        details: {
          provider: 'META',
          operation,
          meta_code: 17,
          retry_after_ms: 1_000,
          simulated: true,
        },
      });
    }
    if (this.transientRemaining > 0) {
      this.transientRemaining -= 1;
      throw new DomainError('PROVIDER_ERROR', {
        messageDe:
          'Meta ist derzeit nicht erreichbar oder hat einen temporären Fehler gemeldet. Der Vorgang wird erneut versucht.',
        retryable: true,
        details: { provider: 'META', operation, meta_code: 2, simulated: true },
      });
    }
  }

  /** Test seam: stop injecting failures. */
  clearSimulatedFailures(): void {
    this.rateLimitRemaining = 0;
    this.transientRemaining = 0;
    this.options.simulatePermissionError = false;
  }

  /** Everything the fixture accepted through the CAPI edge, for assertions. */
  dispatchedCapiBatches(): readonly CapiDispatchRequest[] {
    return this.capiBatches;
  }

  /* ---------------------------------------------------------------------- */
  /* Pagination                                                             */
  /* ---------------------------------------------------------------------- */

  private paginate<T>(
    items: readonly T[],
    request: PageRequest | undefined,
    kind: RawProviderPayload['kind'],
    idOf: (item: T) => string,
  ): ProviderPage<T> {
    const limit = request?.limit ?? this.pageSize;
    const offset = request?.cursor ? Number.parseInt(request.cursor, 10) : 0;
    const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const slice = items.slice(safeOffset, safeOffset + limit);
    const nextOffset = safeOffset + slice.length;

    return {
      items: [...slice],
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
      raw: slice.map((item) => ({
        provider: 'META' as const,
        kind,
        externalId: idOf(item),
        fetchedAt: nowIso(),
        apiVersion: 'fixture',
        payload: item,
      })),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Discovery                                                              */
  /* ---------------------------------------------------------------------- */

  async listAdAccounts(): Promise<MetaAdAccountRecord[]> {
    this.failIfSimulated('meta.list_ad_accounts');
    return [this.data.account];
  }

  async listPages(): Promise<MetaPageRecord[]> {
    this.failIfSimulated('meta.list_pages');
    return [
      {
        externalId: FIXTURE_PAGE_ID,
        name: 'A&M Beratung (Fixture)',
        category: 'Unternehmensberatung',
        tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MANAGE'],
      },
    ];
  }

  async listInstagramActors(): Promise<MetaInstagramActorRecord[]> {
    this.failIfSimulated('meta.list_instagram_actors');
    return [
      {
        externalId: FIXTURE_INSTAGRAM_ACTOR_ID,
        username: 'am.beratung.fixture',
        name: 'A&M Beratung (Fixture)',
        profilePictureUrl: null,
      },
    ];
  }

  async listPixels(): Promise<MetaPixelRecord[]> {
    this.failIfSimulated('meta.list_pixels');
    return [
      {
        externalId: FIXTURE_PIXEL_ID,
        name: 'A&M Website-Pixel (Fixture)',
        lastFiredAt: this.options.anchor ?? FIXTURE_ANCHOR,
      },
    ];
  }

  async listDatasets(): Promise<MetaDatasetRecord[]> {
    this.failIfSimulated('meta.list_datasets');
    return [
      {
        externalId: FIXTURE_DATASET_ID,
        name: 'A&M CRM-Dataset (Fixture)',
        description: 'Down-Funnel-Ereignisse aus dem CRM.',
      },
    ];
  }

  /* ---------------------------------------------------------------------- */
  /* Import                                                                 */
  /* ---------------------------------------------------------------------- */

  async importCampaigns(request?: PageRequest): Promise<ProviderPage<MetaCampaignRecord>> {
    this.failIfSimulated('meta.import_campaigns');
    return this.paginate(this.data.campaigns, request, 'CAMPAIGN', (c) => c.externalId);
  }

  async importAdSets(request?: PageRequest): Promise<ProviderPage<MetaAdSetRecord>> {
    this.failIfSimulated('meta.import_adsets');
    return this.paginate(this.data.adSets, request, 'ADSET', (a) => a.externalId);
  }

  async importAds(request?: PageRequest): Promise<ProviderPage<MetaAdRecord>> {
    this.failIfSimulated('meta.import_ads');
    return this.paginate(this.data.ads, request, 'AD', (a) => a.externalId);
  }

  async importCreatives(request?: PageRequest): Promise<ProviderPage<MetaAdCreativeRecord>> {
    this.failIfSimulated('meta.import_creatives');
    return this.paginate(this.data.creatives, request, 'AD_CREATIVE', (c) => c.externalId);
  }

  async fetchInsightsDaily(request: InsightsRequest): Promise<ProviderPage<MetaInsightsDailyRow>> {
    this.failIfSimulated('meta.fetch_insights_daily');
    const inRange = this.data.insights.filter(
      (row) => row.date >= request.since && row.date <= request.until,
    );
    const rows = aggregate(inRange, request.level);
    return this.paginate(
      rows,
      request,
      'INSIGHTS_DAILY',
      (row) => `${row.externalId}:${row.date}`,
    );
  }

  async downloadCreativeAsset(url: string): Promise<CreativeAssetDownload> {
    this.failIfSimulated('meta.download_creative_asset');
    // A deterministic 1×1 PNG. Enough to exercise the storage path offline.
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89,
    ]);
    return {
      url,
      contentType: 'image/png',
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(`fixture-asset:${url}`),
      bytes,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  async getEntity(ref: MetaEntityRef): Promise<MetaEntitySnapshot | null> {
    this.failIfSimulated('meta.get_entity');

    const campaign = this.data.campaigns.find((c) => c.externalId === ref.externalId);
    const adSet = this.data.adSets.find((a) => a.externalId === ref.externalId);
    const ad = this.data.ads.find((a) => a.externalId === ref.externalId);
    const draftObject = [...this.drafts.values()]
      .flatMap((draft) => [
        ...(draft.campaign ? [draft.campaign] : []),
        ...draft.adSets,
        ...draft.ads,
      ])
      .find((object) => object.externalId === ref.externalId);

    const base =
      campaign ?? adSet ?? ad ?? (draftObject ? { name: draftObject.name } : null);
    if (!base) return null;

    const overriddenStatus = this.statusOverrides.get(ref.externalId);
    const declaredStatus: MetaEntityStatus = campaign
      ? campaign.status
      : adSet
        ? adSet.status
        : ad
          ? ad.status
          : 'PAUSED';

    const overriddenBudget = this.budgetOverrides.get(ref.externalId);
    const declaredBudget = adSet?.dailyBudget ?? campaign?.dailyBudget ?? null;
    const status = overriddenStatus ?? declaredStatus;

    return {
      ref,
      name: base.name,
      status,
      effectiveStatus: status === 'ACTIVE' ? 'ACTIVE' : `${ref.level}_PAUSED`,
      dailyBudget: overriddenBudget ?? declaredBudget,
      fetchedAt: nowIso(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                              */
  /* ---------------------------------------------------------------------- */

  private blocked(operation: string, wouldSend: Record<string, unknown>) {
    return dryRun(
      'META',
      operation,
      wouldSend,
      'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts gesendet.',
    );
  }

  private confirm(operation: string, ref: MetaEntityRef): MetaMutationResult {
    return {
      ok: true,
      operation,
      ref,
      confirmedAt: nowIso(),
      responseRedacted: redact({ success: true, fixture: true, external_id: ref.externalId }),
    };
  }

  async pauseEntity(input: PauseEntityInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.pause_entity';
    if (!canWriteMeta(this.options.flags)) {
      return this.blocked(operation, { edge: input.ref.externalId, body: { status: 'PAUSED' } });
    }
    assertOutboundAllowed(operation);
    this.failIfSimulated(operation);
    this.statusOverrides.set(input.ref.externalId, 'PAUSED');
    return this.confirm(operation, input.ref);
  }

  async resumeEntity(input: ResumeEntityInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.resume_entity';
    if (!canWriteMeta(this.options.flags)) {
      return this.blocked(operation, { edge: input.ref.externalId, body: { status: 'ACTIVE' } });
    }
    assertOutboundAllowed(operation);
    this.failIfSimulated(operation);
    this.statusOverrides.set(input.ref.externalId, 'ACTIVE');
    return this.confirm(operation, input.ref);
  }

  async updateBudget(input: UpdateBudgetInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.update_budget';
    if (!canWriteMeta(this.options.flags)) {
      return this.blocked(operation, {
        edge: input.ref.externalId,
        body: { daily_budget: String(input.dailyBudgetMinor) },
      });
    }
    assertOutboundAllowed(operation);
    this.failIfSimulated(operation);
    this.budgetOverrides.set(input.ref.externalId, money(input.dailyBudgetMinor, input.currency));
    return this.confirm(operation, input.ref);
  }

  async pauseCreative(input: PauseCreativeInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.pause_creative';
    const ref: MetaEntityRef = { level: 'AD', externalId: input.adExternalId };
    if (!canWriteMeta(this.options.flags)) {
      return this.blocked(operation, {
        edge: input.adExternalId,
        body: { status: 'PAUSED' },
        creative_id: input.creativeExternalId ?? null,
      });
    }
    assertOutboundAllowed(operation);
    this.failIfSimulated(operation);
    this.statusOverrides.set(input.adExternalId, 'PAUSED');
    return this.confirm(operation, ref);
  }

  /* ---------------------------------------------------------------------- */
  /* Draft creation                                                         */
  /* ---------------------------------------------------------------------- */

  async createPausedDraftCampaign(plan: DraftPlan): Promise<MutationOutcome<DraftCreationResult>> {
    const operation = 'meta.create_paused_draft_campaign';
    if (!canWriteMeta(this.options.flags)) {
      return this.blocked(operation, draftPlanPreview(plan));
    }
    assertOutboundAllowed(operation);
    this.failIfSimulated(operation);

    const existing = this.drafts.get(plan.idempotencyKey);
    if (existing) return existing;

    const batch = this.draftCounter++;
    const nextId = (level: DraftCreatedObject['level'], index: number): string =>
      fixtureId(level, 900_000 + batch * 1_000 + index);

    let counter = 0;
    const adSets: DraftCreatedObject[] = plan.adSets.map((adSet) => ({
      key: adSet.key,
      level: 'ADSET',
      externalId: nextId('ADSET', counter++),
      status: 'PAUSED',
      name: adSet.name,
    }));
    const creatives: DraftCreatedObject[] = plan.creatives.map((creative) => ({
      key: creative.key,
      level: 'AD_CREATIVE',
      externalId: nextId('AD_CREATIVE', counter++),
      status: 'PAUSED',
      name: creative.name,
    }));
    const ads: DraftCreatedObject[] = plan.ads.map((ad) => ({
      key: ad.key,
      level: 'AD',
      externalId: nextId('AD', counter++),
      status: 'PAUSED',
      name: ad.name,
    }));

    const result: DraftCreationResult = {
      ok: true,
      state: 'CREATED',
      idempotencyKey: plan.idempotencyKey,
      campaign: {
        key: 'campaign',
        level: 'CAMPAIGN',
        externalId: nextId('CAMPAIGN', counter++),
        status: 'PAUSED',
        name: plan.campaign.name,
      },
      adSets,
      creatives,
      ads,
      createdAt: nowIso(),
      errorDe: null,
      responseRedacted: redact({ fixture: true, objects: counter }),
    };

    this.drafts.set(plan.idempotencyKey, result);
    for (const object of [result.campaign, ...adSets, ...ads]) {
      if (object) this.statusOverrides.set(object.externalId, 'PAUSED');
    }
    return result;
  }

  async findDraftByIdempotencyKey(idempotencyKey: string): Promise<DraftCreationResult | null> {
    this.failIfSimulated('meta.find_draft_by_idempotency_key');
    const direct = this.drafts.get(idempotencyKey);
    if (direct) return direct;
    for (const draft of this.drafts.values()) {
      if (draft.campaign && extractIdempotencyKey(draft.campaign.name) === idempotencyKey) {
        return draft;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Conversions API                                                        */
  /* ---------------------------------------------------------------------- */

  async sendCapiEvents(request: CapiDispatchRequest): Promise<MutationOutcome<CapiDispatchResult>> {
    const operation = 'meta.send_capi_events';
    if (!canDispatchCapi(this.options.flags)) {
      return dryRun(
        'META',
        operation,
        {
          edge: `${request.destinationId}/events`,
          event_count: request.events.length,
          events: request.events.map((event) => ({
            event_name: event.event_name,
            event_time: event.event_time,
            event_id: event.event_id,
            action_source: event.action_source,
          })),
        },
        'Der Conversions-API-Versand ist deaktiviert (EXTERNAL_WRITES_ENABLED / META_CAPI_ENABLED = false). Es wurde nichts gesendet.',
      );
    }
    assertOutboundAllowed(operation);
    this.failIfSimulated(operation);

    this.capiBatches.push(request);
    return {
      ok: true,
      destinationId: request.destinationId,
      eventsReceived: request.events.length,
      fbtraceId: null,
      dispatchedAt: nowIso(),
      responseRedacted: redact({ fixture: true, events_received: request.events.length }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Health                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * A fixture never reports a connection. Every credential-dependent probe is
   * `AWAITING_EXTERNAL_INPUT`, the connection state is `FIXTURE`, and the
   * German detail says so in as many words.
   */
  async health(): Promise<ProviderHealth> {
    const checkedAt = nowIso();
    const fixtureNote =
      'Fixture-Modus: Die Daten stammen aus dem deterministischen Testdatensatz, es besteht keine Verbindung zu Meta.';

    const checks: HealthCheck[] = [
      {
        key: 'meta.app_connection',
        labelDe: 'Meta-App-Verbindung',
        status: 'AWAITING_EXTERNAL_INPUT',
        detailDe: fixtureNote,
        checkedAt,
        remediationDe:
          'Meta-App verbinden und META_ACCESS_TOKEN hinterlegen, um den Fixture-Modus zu verlassen.',
        blocksLiveOnly: true,
      },
      {
        key: 'meta.ad_account',
        labelDe: 'Meta-Werbekonto',
        status: 'AWAITING_EXTERNAL_INPUT',
        detailDe: `${fixtureNote} Verwendetes Fixture-Konto: ${FIXTURE_AD_ACCOUNT_ID}.`,
        checkedAt,
        remediationDe: 'META_AD_ACCOUNT_ID in den Einstellungen hinterlegen.',
        blocksLiveOnly: true,
      },
      {
        key: 'meta.pixel_dataset',
        labelDe: 'Pixel / Dataset',
        status: 'AWAITING_EXTERNAL_INPUT',
        detailDe: fixtureNote,
        checkedAt,
        remediationDe: 'META_PIXEL_ID bzw. META_DATASET_ID hinterlegen.',
        blocksLiveOnly: true,
      },
    ];

    return {
      provider: 'META',
      state: 'FIXTURE',
      overall: rollUpHealth(checks),
      checks,
      checkedAt,
    };
  }
}
