/**
 * The Meta adapter contract.
 *
 * One interface, two implementations (`LiveMetaProvider`, `FixtureMetaProvider`),
 * selected once in `factory.ts`. Feature code never constructs a provider
 * directly and never branches on demo mode.
 *
 * Every mutating method returns `MutationOutcome<T> = T | DryRunResult`. The
 * union is deliberate: a caller cannot forget to handle the disabled-writes
 * case, because the type will not let it treat the result as a success.
 */
import type { DryRunResult, MetaEntityStatus, Money, ProviderHealth } from '@am/domain';
import type { DraftCreationResult, DraftPlan } from './draft';
import type {
  CapiServerEvent,
  InsightsLevel,
  MetaAdAccountRecord,
  MetaAdCreativeRecord,
  MetaAdRecord,
  MetaAdSetRecord,
  MetaCampaignRecord,
  MetaDatasetRecord,
  MetaInstagramActorRecord,
  MetaInsightsDailyRow,
  MetaPageRecord,
  MetaPixelRecord,
  RawProviderPayload,
} from './types';

export type MetaProviderMode = 'FIXTURE' | 'LIVE';

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export interface PageRequest {
  /** Opaque Graph API cursor (`paging.cursors.after`). Null starts at the top. */
  cursor?: string | null;
  limit?: number;
}

/**
 * One page of mapped records plus the untouched provider payloads.
 *
 * Raw payloads travel alongside the mapped records rather than being persisted
 * by the adapter: the adapter has no database access, and the raw bodies belong
 * in the private schema/bucket the caller controls.
 */
export interface ProviderPage<T> {
  items: T[];
  nextCursor: string | null;
  raw: RawProviderPayload[];
}

export interface InsightsRequest extends PageRequest {
  level: InsightsLevel;
  /** Inclusive ISO dates in the ad account's timezone. */
  since: string;
  until: string;
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

export type MetaEntityLevel = 'CAMPAIGN' | 'ADSET' | 'AD' | 'AD_CREATIVE';

export interface MetaEntityRef {
  level: MetaEntityLevel;
  externalId: string;
}

export interface MutationBase {
  /** Stable key; a retry with the same key must not create a second object. */
  idempotencyKey: string;
}

export interface PauseEntityInput extends MutationBase {
  ref: MetaEntityRef;
}

export interface ResumeEntityInput extends MutationBase {
  ref: MetaEntityRef;
}

export interface UpdateBudgetInput extends MutationBase {
  ref: MetaEntityRef;
  dailyBudgetMinor: number;
  currency: string;
}

export interface PauseCreativeInput extends MutationBase {
  /** Creatives have no status of their own — the ad carrying them is paused. */
  adExternalId: string;
  creativeExternalId?: string | null;
}

/**
 * A confirmed provider mutation. Only ever constructed after the provider has
 * answered — never optimistically (AGENTS.md rule 3).
 */
export interface MetaMutationResult {
  ok: true;
  operation: string;
  ref: MetaEntityRef;
  confirmedAt: string;
  /** Redacted through `redact()` before it ever leaves the adapter. */
  responseRedacted: unknown;
}

/** Current provider-side truth for one object, used by reconciliation. */
export interface MetaEntitySnapshot {
  ref: MetaEntityRef;
  name: string;
  status: MetaEntityStatus;
  effectiveStatus: string | null;
  dailyBudget: Money | null;
  fetchedAt: string;
}

export type MutationOutcome<T> = T | DryRunResult;

export function isDryRun<T>(outcome: MutationOutcome<T>): outcome is DryRunResult {
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    (outcome as DryRunResult).dryRun === true
  );
}

/* -------------------------------------------------------------------------- */
/* Conversions API                                                             */
/* -------------------------------------------------------------------------- */

export interface CapiDispatchRequest {
  /** Pixel id or dataset id — both live on the `/{id}/events` edge. */
  destinationId: string;
  events: CapiServerEvent[];
  testEventCode?: string | null;
}

export interface CapiDispatchResult {
  ok: true;
  destinationId: string;
  eventsReceived: number;
  fbtraceId: string | null;
  dispatchedAt: string;
  responseRedacted: unknown;
}

/* -------------------------------------------------------------------------- */
/* Assets                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreativeAssetDownload {
  url: string;
  contentType: string;
  byteLength: number;
  /** Lowercase hex SHA-256 of the bytes — the storage key the caller uses. */
  sha256: string;
  bytes: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* The interface                                                               */
/* -------------------------------------------------------------------------- */

export interface MetaProvider {
  readonly mode: MetaProviderMode;

  /** Connection-level probes. Never claims a connection it has not made. */
  health(): Promise<ProviderHealth>;

  /* Discovery — used by the setup wizard. */
  listAdAccounts(): Promise<MetaAdAccountRecord[]>;
  listPages(): Promise<MetaPageRecord[]>;
  listInstagramActors(): Promise<MetaInstagramActorRecord[]>;
  listPixels(): Promise<MetaPixelRecord[]>;
  listDatasets(): Promise<MetaDatasetRecord[]>;

  /* Historical import — cursor paginated, resumable. */
  importCampaigns(request?: PageRequest): Promise<ProviderPage<MetaCampaignRecord>>;
  importAdSets(request?: PageRequest): Promise<ProviderPage<MetaAdSetRecord>>;
  importAds(request?: PageRequest): Promise<ProviderPage<MetaAdRecord>>;
  importCreatives(request?: PageRequest): Promise<ProviderPage<MetaAdCreativeRecord>>;
  fetchInsightsDaily(request: InsightsRequest): Promise<ProviderPage<MetaInsightsDailyRow>>;

  downloadCreativeAsset(url: string): Promise<CreativeAssetDownload>;

  /* Mutations — every one of these checks the feature flags first. */
  createPausedDraftCampaign(plan: DraftPlan): Promise<MutationOutcome<DraftCreationResult>>;
  findDraftByIdempotencyKey(idempotencyKey: string): Promise<DraftCreationResult | null>;
  pauseEntity(input: PauseEntityInput): Promise<MutationOutcome<MetaMutationResult>>;
  resumeEntity(input: ResumeEntityInput): Promise<MutationOutcome<MetaMutationResult>>;
  updateBudget(input: UpdateBudgetInput): Promise<MutationOutcome<MetaMutationResult>>;
  pauseCreative(input: PauseCreativeInput): Promise<MutationOutcome<MetaMutationResult>>;
  sendCapiEvents(request: CapiDispatchRequest): Promise<MutationOutcome<CapiDispatchResult>>;

  /** Re-read for reconciliation: did the change actually take effect? */
  getEntity(ref: MetaEntityRef): Promise<MetaEntitySnapshot | null>;
}

export { DEFAULT_META_RETRY, type RetryConfig, withRateLimitRetry } from './retry';
export { FixtureMetaProvider, type FixtureProviderOptions } from './fixture-provider';
export { LiveMetaProvider, type LiveProviderOptions } from './live-provider';
