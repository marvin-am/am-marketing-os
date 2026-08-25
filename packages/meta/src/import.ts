/**
 * Historical import.
 *
 * Three properties this module exists to guarantee:
 *
 * - **Idempotent.** Every upsert is keyed on `(provider, external_id)` — for
 *   insights on `(provider, external_id, date, level)`. Running the same import
 *   twice creates zero duplicates; that is an explicit acceptance criterion and
 *   is asserted in the integration suite.
 * - **Resumable.** Progress is a watermark per scope: the Graph API cursor for
 *   entity edges, the last completed day for insights. A crashed import
 *   continues where it stopped rather than starting over.
 * - **Silent.** The whole run happens inside `runInImportMode`, which makes any
 *   outbound CAPI or CRM dispatch throw. Reconstructing the past must never
 *   emit events into the present.
 */
import { getAppConfig } from '@am/config';
import { DomainError, nowIso } from '@am/domain';
import { logger } from '@am/observability';
import { runInImportMode } from './import-mode';
import type {
  InsightsRequest,
  MetaProvider,
  PageRequest,
  ProviderPage,
} from './provider';
import type {
  InsightsLevel,
  MetaAdCreativeRecord,
  MetaAdRecord,
  MetaAdSetRecord,
  MetaCampaignRecord,
  MetaInsightsDailyRow,
  RawProviderPayload,
} from './types';

export { assertEventTimeAcceptable, CAPI_MAX_EVENT_AGE_DAYS } from './capi';
export {
  assertOutboundAllowed,
  isImportModeActive,
  resetImportMode,
  runInImportMode,
} from './import-mode';

/* -------------------------------------------------------------------------- */
/* Scopes and keys                                                             */
/* -------------------------------------------------------------------------- */

export const IMPORT_SCOPES = ['CAMPAIGNS', 'ADSETS', 'ADS', 'CREATIVES', 'INSIGHTS'] as const;
export type ImportScope = (typeof IMPORT_SCOPES)[number];

export const IMPORT_SCOPE_LABELS_DE: Readonly<Record<ImportScope, string>> = {
  CAMPAIGNS: 'Kampagnen',
  ADSETS: 'Anzeigengruppen',
  ADS: 'Anzeigen',
  CREATIVES: 'Creatives',
  INSIGHTS: 'Tageswerte',
};

/** The upsert key for every mirrored entity. */
export function entityKey(externalId: string): string {
  return `META:${externalId}`;
}

/**
 * Insights are keyed on object *and* day *and* level: the same ad has one row
 * per day, and the same day exists at ad, ad-set and campaign level.
 */
export function insightsKey(row: {
  externalId: string;
  date: string;
  level: InsightsLevel;
}): string {
  return `META:${row.level}:${row.externalId}:${row.date}`;
}

export const DEFAULT_HISTORICAL_IMPORT_MONTHS = 24;

/**
 * How far back the Graph API will serve insights at all. Used when the operator
 * asks for the maximum available range rather than the configured window.
 */
export const MAX_HISTORICAL_IMPORT_MONTHS = 37;

/* -------------------------------------------------------------------------- */
/* Watermarks and sink                                                         */
/* -------------------------------------------------------------------------- */

export interface ImportWatermark {
  provider: 'META';
  scope: ImportScope;
  /** Graph API cursor for the next page, or null when the scope is complete. */
  cursor: string | null;
  /** Last fully imported insights day (INSIGHTS only). */
  lastDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  itemsSeen: number;
}

export interface UpsertOutcome {
  inserted: number;
  updated: number;
}

/**
 * Persistence is the caller's job — this package has no database access. The
 * sink also receives the raw provider payloads, tagged with their kind, so they
 * can be written to the private schema or bucket under their own retention
 * policy.
 */
export interface ImportSink {
  upsertCampaigns(rows: readonly MetaCampaignRecord[]): Promise<UpsertOutcome>;
  upsertAdSets(rows: readonly MetaAdSetRecord[]): Promise<UpsertOutcome>;
  upsertAds(rows: readonly MetaAdRecord[]): Promise<UpsertOutcome>;
  upsertCreatives(rows: readonly MetaAdCreativeRecord[]): Promise<UpsertOutcome>;
  upsertInsights(rows: readonly MetaInsightsDailyRow[]): Promise<UpsertOutcome>;
  saveRawPayloads(rows: readonly RawProviderPayload[]): Promise<void>;
  loadWatermark(scope: ImportScope): Promise<ImportWatermark | null>;
  saveWatermark(watermark: ImportWatermark): Promise<void>;
}

export interface InMemoryImportSink extends ImportSink {
  campaigns: Map<string, MetaCampaignRecord>;
  adSets: Map<string, MetaAdSetRecord>;
  ads: Map<string, MetaAdRecord>;
  creatives: Map<string, MetaAdCreativeRecord>;
  insights: Map<string, MetaInsightsDailyRow>;
  rawPayloads: RawProviderPayload[];
  watermarks: Map<ImportScope, ImportWatermark>;
}

function upsertInto<T>(
  target: Map<string, T>,
  rows: readonly T[],
  keyOf: (row: T) => string,
): UpsertOutcome {
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const key = keyOf(row);
    if (target.has(key)) updated++;
    else inserted++;
    target.set(key, row);
  }
  return { inserted, updated };
}

/**
 * Reference sink used by the console's demo mode and by the tests. Its
 * key-based `Map` semantics are the same contract a Postgres
 * `ON CONFLICT (provider, external_id) DO UPDATE` gives.
 */
export function createInMemoryImportSink(): InMemoryImportSink {
  const campaigns = new Map<string, MetaCampaignRecord>();
  const adSets = new Map<string, MetaAdSetRecord>();
  const ads = new Map<string, MetaAdRecord>();
  const creatives = new Map<string, MetaAdCreativeRecord>();
  const insights = new Map<string, MetaInsightsDailyRow>();
  const rawPayloads: RawProviderPayload[] = [];
  const watermarks = new Map<ImportScope, ImportWatermark>();

  return {
    campaigns,
    adSets,
    ads,
    creatives,
    insights,
    rawPayloads,
    watermarks,
    upsertCampaigns: async (rows) => upsertInto(campaigns, rows, (r) => entityKey(r.externalId)),
    upsertAdSets: async (rows) => upsertInto(adSets, rows, (r) => entityKey(r.externalId)),
    upsertAds: async (rows) => upsertInto(ads, rows, (r) => entityKey(r.externalId)),
    upsertCreatives: async (rows) => upsertInto(creatives, rows, (r) => entityKey(r.externalId)),
    upsertInsights: async (rows) => upsertInto(insights, rows, insightsKey),
    saveRawPayloads: async (rows) => {
      rawPayloads.push(...rows);
    },
    loadWatermark: async (scope) => watermarks.get(scope) ?? null,
    saveWatermark: async (watermark) => {
      watermarks.set(watermark.scope, watermark);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Progress and summary                                                        */
/* -------------------------------------------------------------------------- */

export interface ImportProgress {
  scope: ImportScope;
  labelDe: string;
  page: number;
  itemsInPage: number;
  itemsSeenInScope: number;
  cursor: string | null;
  at: string;
}

export interface ImportScopeSummary {
  scope: ImportScope;
  labelDe: string;
  pages: number;
  itemsSeen: number;
  inserted: number;
  updated: number;
  rawPayloads: number;
  completedAt: string;
  /** Set when the scope stopped early because `maxPages` was reached. */
  truncated: boolean;
}

export interface ImportSummary {
  provider: 'META';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  window: { since: string; until: string; months: number; fullHistory: boolean };
  scopes: ImportScopeSummary[];
  totals: { itemsSeen: number; inserted: number; updated: number; rawPayloads: number };
  /** German one-liner for the console and the audit log. */
  summaryDe: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface HistoricalImportOptions {
  /** Defaults to `HISTORICAL_IMPORT_MONTHS` (24). */
  months?: number;
  /** Import the maximum range Meta serves instead of the configured window. */
  fullHistory?: boolean;
  now?: string;
  scopes?: readonly ImportScope[];
  insightsLevel?: InsightsLevel;
  pageLimit?: number;
  /** Safety valve so a runaway cursor cannot loop forever. */
  maxPagesPerScope?: number;
  /** Continue from a stored watermark. On by default. */
  resume?: boolean;
  onProgress?: (progress: ImportProgress) => void;
}

function resolveMonths(options: HistoricalImportOptions): number {
  if (options.fullHistory) return MAX_HISTORICAL_IMPORT_MONTHS;
  if (typeof options.months === 'number' && options.months > 0) return options.months;
  try {
    return getAppConfig().historicalImportMonths;
  } catch {
    return DEFAULT_HISTORICAL_IMPORT_MONTHS;
  }
}

export function importWindow(
  months: number,
  now: string,
): { since: string; until: string } {
  const until = new Date(now);
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - months);
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

interface ScopeRunner {
  scope: ImportScope;
  fetchPage: (cursor: string | null) => Promise<ProviderPage<unknown>>;
  persist: (items: readonly unknown[]) => Promise<UpsertOutcome>;
}

const DEFAULT_MAX_PAGES = 500;

/**
 * Runs the import. Everything happens inside `runInImportMode`, so a stray CAPI
 * dispatch raised from an importer hook fails loudly instead of quietly
 * emitting a year-old lead to Meta.
 */
export async function runHistoricalImport(
  provider: MetaProvider,
  sink: ImportSink,
  options: HistoricalImportOptions = {},
): Promise<ImportSummary> {
  return runInImportMode(() => runImportInner(provider, sink, options));
}

async function runImportInner(
  provider: MetaProvider,
  sink: ImportSink,
  options: HistoricalImportOptions,
): Promise<ImportSummary> {
  const startedAtMs = Date.now();
  const startedAt = options.now ?? nowIso();
  const months = resolveMonths(options);
  const window = importWindow(months, startedAt);
  const scopes = options.scopes ?? IMPORT_SCOPES;
  const insightsLevel: InsightsLevel = options.insightsLevel ?? 'ad';
  const pageLimit = options.pageLimit;
  const maxPages = options.maxPagesPerScope ?? DEFAULT_MAX_PAGES;
  const resume = options.resume !== false;

  const pageRequest = (cursor: string | null): PageRequest => ({ cursor, limit: pageLimit });

  const runners: Record<ImportScope, ScopeRunner> = {
    CAMPAIGNS: {
      scope: 'CAMPAIGNS',
      fetchPage: (cursor) => provider.importCampaigns(pageRequest(cursor)),
      persist: (items) => sink.upsertCampaigns(items as MetaCampaignRecord[]),
    },
    ADSETS: {
      scope: 'ADSETS',
      fetchPage: (cursor) => provider.importAdSets(pageRequest(cursor)),
      persist: (items) => sink.upsertAdSets(items as MetaAdSetRecord[]),
    },
    ADS: {
      scope: 'ADS',
      fetchPage: (cursor) => provider.importAds(pageRequest(cursor)),
      persist: (items) => sink.upsertAds(items as MetaAdRecord[]),
    },
    CREATIVES: {
      scope: 'CREATIVES',
      fetchPage: (cursor) => provider.importCreatives(pageRequest(cursor)),
      persist: (items) => sink.upsertCreatives(items as MetaAdCreativeRecord[]),
    },
    INSIGHTS: {
      scope: 'INSIGHTS',
      fetchPage: (cursor) => {
        const request: InsightsRequest = {
          level: insightsLevel,
          since: window.since,
          until: window.until,
          cursor,
          limit: pageLimit,
        };
        return provider.fetchInsightsDaily(request);
      },
      persist: (items) => sink.upsertInsights(items as MetaInsightsDailyRow[]),
    },
  };

  const summaries: ImportScopeSummary[] = [];

  for (const scope of scopes) {
    const runner = runners[scope];
    const stored = resume ? await sink.loadWatermark(scope) : null;
    // A completed watermark from an earlier run is not a reason to skip: a
    // re-run must be safe, and the upserts make it a no-op rather than a
    // duplicate.
    let cursor = stored && !stored.completedAt ? stored.cursor : null;

    let pages = 0;
    let itemsSeen = 0;
    let inserted = 0;
    let updated = 0;
    let rawCount = 0;
    let lastDate: string | null = stored?.lastDate ?? null;
    let truncated = false;

    const scopeStartedAt = nowIso();
    await sink.saveWatermark({
      provider: 'META',
      scope,
      cursor,
      lastDate,
      startedAt: scopeStartedAt,
      completedAt: null,
      itemsSeen: 0,
    });

    for (;;) {
      if (pages >= maxPages) {
        truncated = true;
        break;
      }

      const page = await runner.fetchPage(cursor);
      pages++;
      itemsSeen += page.items.length;

      if (page.items.length > 0) {
        const outcome = await runner.persist(page.items);
        inserted += outcome.inserted;
        updated += outcome.updated;
      }
      if (page.raw.length > 0) {
        await sink.saveRawPayloads(page.raw);
        rawCount += page.raw.length;
      }
      if (scope === 'INSIGHTS') {
        for (const item of page.items as MetaInsightsDailyRow[]) {
          if (!lastDate || item.date > lastDate) lastDate = item.date;
        }
      }

      cursor = page.nextCursor;

      await sink.saveWatermark({
        provider: 'META',
        scope,
        cursor,
        lastDate,
        startedAt: scopeStartedAt,
        completedAt: cursor === null ? nowIso() : null,
        itemsSeen,
      });

      options.onProgress?.({
        scope,
        labelDe: IMPORT_SCOPE_LABELS_DE[scope],
        page: pages,
        itemsInPage: page.items.length,
        itemsSeenInScope: itemsSeen,
        cursor,
        at: nowIso(),
      });

      if (cursor === null) break;
    }

    summaries.push({
      scope,
      labelDe: IMPORT_SCOPE_LABELS_DE[scope],
      pages,
      itemsSeen,
      inserted,
      updated,
      rawPayloads: rawCount,
      completedAt: nowIso(),
      truncated,
    });
  }

  const totals = summaries.reduce(
    (acc, scope) => ({
      itemsSeen: acc.itemsSeen + scope.itemsSeen,
      inserted: acc.inserted + scope.inserted,
      updated: acc.updated + scope.updated,
      rawPayloads: acc.rawPayloads + scope.rawPayloads,
    }),
    { itemsSeen: 0, inserted: 0, updated: 0, rawPayloads: 0 },
  );

  const completedAt = nowIso();
  const summary: ImportSummary = {
    provider: 'META',
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    window: { ...window, months, fullHistory: options.fullHistory === true },
    scopes: summaries,
    totals,
    summaryDe: `Meta-Import abgeschlossen: ${totals.inserted} neu, ${totals.updated} aktualisiert, ${totals.rawPayloads} Rohdatensätze (Zeitraum ${window.since} bis ${window.until}).`,
  };

  logger.info('meta_import_completed', {
    provider: 'META',
    window: summary.window,
    totals,
    scopes: summaries.map((scope) => ({ scope: scope.scope, items: scope.itemsSeen })),
  });

  return summary;
}

/**
 * Convenience guard for callers that receive a summary and want to fail loudly
 * if a re-run inserted anything. The second run of an unchanged dataset must
 * insert zero rows.
 */
export function assertNoDuplicateInserts(summary: ImportSummary): void {
  if (summary.totals.inserted > 0) {
    throw new DomainError('CONFLICT', {
      messageDe: `Ein wiederholter Import hat ${summary.totals.inserted} neue Datensätze angelegt. Der Upsert-Schlüssel (provider, external_id) greift nicht.`,
      details: { inserted: summary.totals.inserted },
    });
  }
}
