/**
 * `LiveMetaProvider` — the real Graph API adapter.
 *
 * Design notes worth knowing before changing anything here:
 *
 * - The API version is **always** injected (`META_API_VERSION`). There is no
 *   default: a silent version bump changes field semantics without a diff.
 * - The access token travels in an `Authorization: Bearer` header, never in the
 *   query string, so it cannot end up in a proxy log or an error message.
 * - Every mutating method checks the feature flags *first* and returns a
 *   `DryRunResult`. The higher layers check too; this is the last line.
 * - Every request goes through `withRateLimitRetry`, which honours Meta's
 *   `Retry-After` / `X-Business-Use-Case-Usage` hints before falling back to
 *   exponential backoff.
 * - Nothing is reported as confirmed on the strength of a `{"success":true}`.
 *   Mutations re-read the object and report the status Meta actually holds.
 */
import type { z } from 'zod';
import {
  type FeatureFlags,
  type HealthCheck,
  type ProviderHealth,
  DomainError,
  canDispatchCapi,
  canWriteMeta,
  dryRun,
  nowIso,
  redact,
  rollUpHealth,
  sha256Hex,
} from '@am/domain';
import { instrumented } from '@am/observability';
import {
  type DraftCreatedObject,
  type DraftCreationResult,
  type DraftPlan,
  draftAdPayload,
  draftAdSetPayload,
  draftCampaignPayload,
  draftCreativePayload,
  draftPlanPreview,
  extractIdempotencyKey,
  idempotencyMarker,
} from './draft';
import { mapMetaError, mapMetaTransportError } from './errors';
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
import { DEFAULT_META_RETRY, type RetryConfig, withRateLimitRetry } from './retry';
import {
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
  META_ASSET_HOST_SUFFIXES,
  adAccountPath,
  buildGraphUrl,
  capiResponseSchema,
  mapAd,
  mapAdAccount,
  mapAdCreative,
  mapAdSet,
  mapCampaign,
  mapDataset,
  mapInsightsRow,
  mapInstagramActor,
  mapPage,
  mapPixel,
  metaAdAccountSchema,
  metaAdCreativeSchema,
  metaAdSchema,
  metaAdSetSchema,
  metaCampaignSchema,
  metaDatasetSchema,
  metaInsightsRowSchema,
  metaInstagramActorSchema,
  metaListResponseSchema,
  metaPageSchema,
  metaPixelSchema,
  parseMinorUnits,
  toEntityStatus,
} from './types';

/* -------------------------------------------------------------------------- */
/* Field selections                                                            */
/* -------------------------------------------------------------------------- */

const CAMPAIGN_FIELDS =
  'id,account_id,name,objective,status,effective_status,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,special_ad_categories,created_time,updated_time,start_time,stop_time';

const ADSET_FIELDS =
  'id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,bid_amount,bid_strategy,billing_event,optimization_goal,destination_type,promoted_object,targeting,attribution_spec,start_time,end_time,created_time,updated_time';

const AD_FIELDS =
  'id,account_id,campaign_id,adset_id,name,status,effective_status,creative{id},tracking_specs,created_time,updated_time';

const CREATIVE_FIELDS =
  'id,account_id,name,status,object_story_spec,effective_object_story_id,thumbnail_url,image_url,image_hash,video_id,url_tags,title,body,call_to_action_type';

const INSIGHTS_FIELDS =
  'date_start,date_stop,account_id,account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,reach,frequency,clicks,inline_link_clicks,unique_inline_link_clicks,spend,ctr,inline_link_click_ctr,cpc,cpm,actions,action_values';

const ENTITY_FIELDS = 'id,name,status,effective_status,daily_budget';

const DEFAULT_PAGE_LIMIT = 100;

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LiveProviderOptions {
  /** Pinned from config (`META_API_VERSION`). Never defaulted here. */
  apiVersion: string;
  accessToken: string;
  /**
   * Token for the Conversions API when it differs from the Marketing API one,
   * which is the usual arrangement — a system user granted only
   * `ads_management` on the dataset, with its own lifetime. Null means "reuse
   * `accessToken`", never "CAPI is off"; that decision belongs to the flags.
   */
  capiAccessToken?: string | null;
  adAccountId: string;
  currency?: string;
  appId?: string | null;
  appSecret?: string | null;
  businessId?: string | null;
  pageId?: string | null;
  instagramActorId?: string | null;
  pixelId?: string | null;
  datasetId?: string | null;
  flags: FeatureFlags;
  fetchImpl?: FetchLike;
  retry?: RetryConfig;
  /** Only ever set from Settings while validating a CAPI integration. */
  capiTestEventCode?: string | null;
}

interface CallOptions<S extends z.ZodType> {
  method: 'GET' | 'POST';
  path: string;
  operation: string;
  params?: Record<string, string | number | undefined | null>;
  form?: Record<string, string>;
  schema: S;
  /** Overrides the Marketing API token. Only the CAPI dispatch sets it. */
  accessToken?: string;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

export class LiveMetaProvider implements MetaProvider {
  readonly mode = 'LIVE' as const;

  private readonly options: LiveProviderOptions;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryConfig;
  private readonly accountPath: string;

  constructor(options: LiveProviderOptions) {
    if (!options.apiVersion) {
      throw new DomainError('PROVIDER_NOT_CONFIGURED', {
        messageDe: 'Die Meta-API-Version ist nicht konfiguriert (META_API_VERSION).',
      });
    }
    if (!options.accessToken || !options.adAccountId) {
      throw new DomainError('PROVIDER_NOT_CONFIGURED', {
        messageDe:
          'Meta ist nicht verbunden: Zugriffstoken oder Werbekonto-ID fehlen. Bitte in den Einstellungen hinterlegen.',
      });
    }
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.retry = options.retry ?? DEFAULT_META_RETRY;
    this.accountPath = adAccountPath(options.adAccountId);
  }

  private get currency(): string {
    return this.options.currency ?? 'EUR';
  }

  /* ---------------------------------------------------------------------- */
  /* Transport                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Meta requires `appsecret_proof` for server-side calls whenever the app is
   * configured to demand it: an HMAC-SHA256 of the access token keyed with the
   * app secret. Computed lazily so an app without a secret still works.
   *
   * The proof is over *the token being sent*, so it takes the token as an
   * argument rather than reading `options.accessToken`: a CAPI dispatch signed
   * with the Marketing API token would be rejected, and the error Meta returns
   * for a mismatched proof does not say which of the two is wrong.
   */
  private async appSecretProof(accessToken: string): Promise<string | null> {
    const secret = this.options.appSecret;
    if (!secret) return null;
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await globalThis.crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(accessToken),
    );
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async call<S extends z.ZodType>(options: CallOptions<S>): Promise<z.infer<S>> {
    const accessToken = options.accessToken ?? this.options.accessToken;
    const proof = await this.appSecretProof(accessToken);
    const params = { ...(options.params ?? {}) };
    if (proof) params.appsecret_proof = proof;

    const url = buildGraphUrl(this.options.apiVersion, options.path, params);

    const outcome = await withRateLimitRetry(
      options.operation,
      async () => {
        let response: Response;
        try {
          const init: RequestInit = {
            method: options.method,
            headers: {
              authorization: `Bearer ${accessToken}`,
              accept: 'application/json',
              ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            },
          };
          if (options.form) init.body = new URLSearchParams(options.form).toString();
          response = await this.fetchImpl(url, init);
        } catch (error) {
          throw mapMetaTransportError(error, options.operation);
        }

        const text = await response.text();
        let body: unknown = null;
        try {
          body = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          body = text;
        }

        if (!response.ok) {
          throw mapMetaError(response.status, body, {
            operation: options.operation,
            headers: response.headers,
          });
        }

        const parsed = options.schema.safeParse(body);
        if (!parsed.success) {
          throw new DomainError('PROVIDER_ERROR', {
            messageDe:
              'Meta hat eine unerwartete Antwortstruktur geliefert. Der Vorgang wurde abgebrochen.',
            retryable: false,
            details: {
              operation: options.operation,
              issues: parsed.error.issues.slice(0, 5).map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            },
          });
        }
        return parsed.data as z.infer<S>;
      },
      this.retry,
    );

    return outcome.value;
  }

  private raw(
    kind: RawProviderPayload['kind'],
    externalId: string,
    payload: unknown,
  ): RawProviderPayload {
    return {
      provider: 'META',
      kind,
      externalId,
      fetchedAt: nowIso(),
      apiVersion: this.options.apiVersion,
      payload,
    };
  }

  /**
   * `paging.cursors.after` is present even on the last page; `paging.next` is
   * the only reliable "there is more" signal.
   */
  private static nextCursor(paging: {
    cursors?: { after?: string | null } | null;
    next?: string | null;
  } | null | undefined): string | null {
    if (!paging?.next) return null;
    return paging.cursors?.after ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Discovery                                                              */
  /* ---------------------------------------------------------------------- */

  async listAdAccounts(): Promise<MetaAdAccountRecord[]> {
    return instrumented('META', 'meta.list_ad_accounts', async () => {
      const response = await this.call({
        method: 'GET',
        path: 'me/adaccounts',
        operation: 'meta.list_ad_accounts',
        params: {
          fields: 'id,account_id,name,currency,timezone_name,account_status,business',
          limit: DEFAULT_PAGE_LIMIT,
        },
        schema: metaListResponseSchema(metaAdAccountSchema),
      });
      return response.data.map(mapAdAccount);
    });
  }

  async listPages(): Promise<MetaPageRecord[]> {
    return instrumented('META', 'meta.list_pages', async () => {
      const path = this.options.businessId
        ? `${this.options.businessId}/owned_pages`
        : 'me/accounts';
      const response = await this.call({
        method: 'GET',
        path,
        operation: 'meta.list_pages',
        params: { fields: 'id,name,category,tasks', limit: DEFAULT_PAGE_LIMIT },
        schema: metaListResponseSchema(metaPageSchema),
      });
      return response.data.map(mapPage);
    });
  }

  async listInstagramActors(): Promise<MetaInstagramActorRecord[]> {
    return instrumented('META', 'meta.list_instagram_actors', async () => {
      const response = await this.call({
        method: 'GET',
        path: `${this.accountPath}/instagram_accounts`,
        operation: 'meta.list_instagram_actors',
        params: { fields: 'id,username,profile_pic', limit: DEFAULT_PAGE_LIMIT },
        schema: metaListResponseSchema(metaInstagramActorSchema),
      });
      return response.data.map(mapInstagramActor);
    });
  }

  async listPixels(): Promise<MetaPixelRecord[]> {
    return instrumented('META', 'meta.list_pixels', async () => {
      const response = await this.call({
        method: 'GET',
        path: `${this.accountPath}/adspixels`,
        operation: 'meta.list_pixels',
        params: {
          fields: 'id,name,last_fired_time,is_created_by_business',
          limit: DEFAULT_PAGE_LIMIT,
        },
        schema: metaListResponseSchema(metaPixelSchema),
      });
      return response.data.map(mapPixel);
    });
  }

  async listDatasets(): Promise<MetaDatasetRecord[]> {
    return instrumented('META', 'meta.list_datasets', async () => {
      if (!this.options.businessId) return [];
      const response = await this.call({
        method: 'GET',
        path: `${this.options.businessId}/owned_offline_conversion_data_sets`,
        operation: 'meta.list_datasets',
        params: { fields: 'id,name,description', limit: DEFAULT_PAGE_LIMIT },
        schema: metaListResponseSchema(metaDatasetSchema),
      });
      return response.data.map(mapDataset);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Import                                                                 */
  /* ---------------------------------------------------------------------- */

  private async importEdge<S extends z.ZodType, R>(
    edge: string,
    fields: string,
    operation: string,
    kind: RawProviderPayload['kind'],
    itemSchema: S,
    map: (item: z.infer<S>) => R,
    request: PageRequest | undefined,
  ): Promise<ProviderPage<R>> {
    return instrumented(
      'META',
      operation,
      async () => {
        const response = await this.call({
          method: 'GET',
          path: `${this.accountPath}/${edge}`,
          operation,
          params: {
            fields,
            limit: request?.limit ?? DEFAULT_PAGE_LIMIT,
            after: request?.cursor ?? undefined,
          },
          schema: metaListResponseSchema(itemSchema),
        });

        const items = response.data.map((item) => map(item as z.infer<S>));
        const raw = response.data.map((item) =>
          this.raw(kind, String((item as { id?: unknown }).id ?? ''), item),
        );
        return {
          items,
          raw,
          nextCursor: LiveMetaProvider.nextCursor(response.paging),
        };
      },
      (page) => ({ count: page.items.length, has_more: page.nextCursor !== null }),
    );
  }

  importCampaigns(request?: PageRequest): Promise<ProviderPage<MetaCampaignRecord>> {
    return this.importEdge(
      'campaigns',
      CAMPAIGN_FIELDS,
      'meta.import_campaigns',
      'CAMPAIGN',
      metaCampaignSchema,
      (wire) => mapCampaign(wire, this.currency),
      request,
    );
  }

  importAdSets(request?: PageRequest): Promise<ProviderPage<MetaAdSetRecord>> {
    return this.importEdge(
      'adsets',
      ADSET_FIELDS,
      'meta.import_adsets',
      'ADSET',
      metaAdSetSchema,
      (wire) => mapAdSet(wire, this.currency),
      request,
    );
  }

  importAds(request?: PageRequest): Promise<ProviderPage<MetaAdRecord>> {
    return this.importEdge(
      'ads',
      AD_FIELDS,
      'meta.import_ads',
      'AD',
      metaAdSchema,
      mapAd,
      request,
    );
  }

  importCreatives(request?: PageRequest): Promise<ProviderPage<MetaAdCreativeRecord>> {
    return this.importEdge(
      'adcreatives',
      CREATIVE_FIELDS,
      'meta.import_creatives',
      'AD_CREATIVE',
      metaAdCreativeSchema,
      mapAdCreative,
      request,
    );
  }

  async fetchInsightsDaily(request: InsightsRequest): Promise<ProviderPage<MetaInsightsDailyRow>> {
    return instrumented(
      'META',
      'meta.fetch_insights_daily',
      async () => {
        const response = await this.call({
          method: 'GET',
          path: `${this.accountPath}/insights`,
          operation: 'meta.fetch_insights_daily',
          params: {
            level: request.level,
            fields: INSIGHTS_FIELDS,
            // `time_increment=1` is what turns the aggregate into daily rows.
            time_increment: 1,
            time_range: JSON.stringify({ since: request.since, until: request.until }),
            limit: request.limit ?? 500,
            after: request.cursor ?? undefined,
          },
          schema: metaListResponseSchema(metaInsightsRowSchema),
        });

        const items = response.data.map((row) => mapInsightsRow(row, request.level, this.currency));
        const raw = response.data.map((row, index) =>
          this.raw('INSIGHTS_DAILY', `${items[index].externalId}:${items[index].date}`, row),
        );
        return { items, raw, nextCursor: LiveMetaProvider.nextCursor(response.paging) };
      },
      (page) => ({ count: page.items.length, has_more: page.nextCursor !== null }),
    );
  }

  async downloadCreativeAsset(url: string): Promise<CreativeAssetDownload> {
    return instrumented(
      'META',
      'meta.download_creative_asset',
      async () => {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
          throw new DomainError('VALIDATION_FAILED', {
            messageDe: 'Creative-Assets dürfen nur über HTTPS geladen werden.',
            details: { host: parsed.hostname },
          });
        }
        const allowed = META_ASSET_HOST_SUFFIXES.some(
          (suffix) => parsed.hostname === suffix.slice(1) || parsed.hostname.endsWith(suffix),
        );
        if (!allowed) {
          throw new DomainError('VALIDATION_FAILED', {
            messageDe:
              'Das Creative-Asset liegt nicht auf einem bekannten Meta-CDN-Host und wurde nicht geladen.',
            details: { host: parsed.hostname },
          });
        }

        let response: Response;
        try {
          response = await this.fetchImpl(url, { method: 'GET' });
        } catch (error) {
          throw mapMetaTransportError(error, 'meta.download_creative_asset');
        }
        if (!response.ok) {
          throw new DomainError('PROVIDER_ERROR', {
            messageDe: 'Das Creative-Asset konnte nicht von Meta geladen werden.',
            retryable: true,
            details: { status: response.status, host: parsed.hostname },
          });
        }

        const buffer = new Uint8Array(await response.arrayBuffer());
        return {
          url,
          contentType: response.headers.get('content-type') ?? 'application/octet-stream',
          byteLength: buffer.byteLength,
          sha256: await sha256Hex(
            Array.from(buffer)
              .map((b) => String.fromCharCode(b))
              .join(''),
          ),
          bytes: buffer,
        };
      },
      (asset) => ({ bytes: asset.byteLength, content_type: asset.contentType }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Reads used by reconciliation                                           */
  /* ---------------------------------------------------------------------- */

  async getEntity(ref: MetaEntityRef): Promise<MetaEntitySnapshot | null> {
    return instrumented('META', 'meta.get_entity', async () => {
      try {
        const wire = await this.call({
          method: 'GET',
          path: ref.externalId,
          operation: 'meta.get_entity',
          params: { fields: ENTITY_FIELDS },
          schema: metaCampaignSchema,
        });
        const daily = parseMinorUnits(wire.daily_budget);
        return {
          ref,
          name: wire.name,
          status: toEntityStatus(wire.status),
          effectiveStatus: wire.effective_status ?? null,
          dailyBudget: daily === null ? null : { amountMinor: daily, currency: this.currency },
          fetchedAt: nowIso(),
        };
      } catch (error) {
        if (error instanceof DomainError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                              */
  /* ---------------------------------------------------------------------- */

  private blockedByFlags(operation: string, wouldSend: Record<string, unknown>) {
    return dryRun(
      'META',
      operation,
      wouldSend,
      'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts gesendet.',
    );
  }

  private async writeAndConfirm(
    operation: string,
    ref: MetaEntityRef,
    form: Record<string, string>,
  ): Promise<MetaMutationResult> {
    assertOutboundAllowed(operation);
    const response = await this.call({
      method: 'POST',
      path: ref.externalId,
      operation,
      form,
      schema: metaCampaignSchema.partial().or(metaListResponseSchema(metaCampaignSchema).partial()),
    });

    // A `{"success":true}` is not a confirmation of state. Read it back.
    const snapshot = await this.getEntity(ref);
    if (!snapshot) {
      throw new DomainError('PROVIDER_ERROR', {
        messageDe:
          'Meta hat die Änderung entgegengenommen, das Objekt konnte danach aber nicht gelesen werden. Der Status bleibt unbestätigt.',
        retryable: true,
        details: { operation, external_id: ref.externalId },
      });
    }

    return {
      ok: true,
      operation,
      ref,
      confirmedAt: nowIso(),
      responseRedacted: redact({ response, snapshot }),
    };
  }

  async pauseEntity(input: PauseEntityInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.pause_entity';
    const wouldSend = { edge: input.ref.externalId, body: { status: 'PAUSED' } };
    if (!canWriteMeta(this.options.flags)) return this.blockedByFlags(operation, wouldSend);
    return instrumented('META', operation, () =>
      this.writeAndConfirm(operation, input.ref, { status: 'PAUSED' }),
    );
  }

  async resumeEntity(input: ResumeEntityInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.resume_entity';
    const wouldSend = { edge: input.ref.externalId, body: { status: 'ACTIVE' } };
    if (!canWriteMeta(this.options.flags)) return this.blockedByFlags(operation, wouldSend);
    return instrumented('META', operation, () =>
      this.writeAndConfirm(operation, input.ref, { status: 'ACTIVE' }),
    );
  }

  async updateBudget(input: UpdateBudgetInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.update_budget';
    const body = { daily_budget: String(input.dailyBudgetMinor) };
    if (!canWriteMeta(this.options.flags)) {
      return this.blockedByFlags(operation, {
        edge: input.ref.externalId,
        body,
        currency: input.currency,
      });
    }
    return instrumented('META', operation, () =>
      this.writeAndConfirm(operation, input.ref, body),
    );
  }

  async pauseCreative(input: PauseCreativeInput): Promise<MutationOutcome<MetaMutationResult>> {
    const operation = 'meta.pause_creative';
    const ref: MetaEntityRef = { level: 'AD', externalId: input.adExternalId };
    const wouldSend = {
      edge: input.adExternalId,
      body: { status: 'PAUSED' },
      creative_id: input.creativeExternalId ?? null,
    };
    if (!canWriteMeta(this.options.flags)) return this.blockedByFlags(operation, wouldSend);
    return instrumented('META', operation, () =>
      this.writeAndConfirm(operation, ref, { status: 'PAUSED' }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Draft creation                                                         */
  /* ---------------------------------------------------------------------- */

  async createPausedDraftCampaign(
    plan: DraftPlan,
  ): Promise<MutationOutcome<DraftCreationResult>> {
    const operation = 'meta.create_paused_draft_campaign';
    if (!canWriteMeta(this.options.flags)) {
      return this.blockedByFlags(operation, draftPlanPreview(plan));
    }
    assertOutboundAllowed(operation);

    return instrumented('META', operation, async () => {
      const result: DraftCreationResult = {
        ok: false,
        state: 'PARTIAL',
        idempotencyKey: plan.idempotencyKey,
        campaign: null,
        adSets: [],
        creatives: [],
        ads: [],
        createdAt: nowIso(),
        errorDe: null,
        responseRedacted: null,
      };

      const created: Record<string, unknown> = {};
      const idSchema = metaCampaignSchema.pick({ id: true });

      try {
        const campaign = await this.call({
          method: 'POST',
          path: `${plan.adAccountId}/campaigns`,
          operation: `${operation}.campaign`,
          form: formEncode(draftCampaignPayload(plan)),
          schema: idSchema,
        });
        result.campaign = {
          key: 'campaign',
          level: 'CAMPAIGN',
          externalId: campaign.id,
          status: 'PAUSED',
          name: plan.campaign.name,
        };
        created.campaign_id = campaign.id;

        const adSetIds = new Map<string, string>();
        for (const adSet of plan.adSets) {
          const response = await this.call({
            method: 'POST',
            path: `${plan.adAccountId}/adsets`,
            operation: `${operation}.adset`,
            form: formEncode(draftAdSetPayload(plan, adSet, campaign.id)),
            schema: idSchema,
          });
          adSetIds.set(adSet.key, response.id);
          result.adSets.push({
            key: adSet.key,
            level: 'ADSET',
            externalId: response.id,
            status: 'PAUSED',
            name: adSet.name,
          });
        }

        const creativeIds = new Map<string, string>();
        for (const creative of plan.creatives) {
          const response = await this.call({
            method: 'POST',
            path: `${plan.adAccountId}/adcreatives`,
            operation: `${operation}.creative`,
            form: formEncode(draftCreativePayload(plan, creative)),
            schema: idSchema,
          });
          creativeIds.set(creative.key, response.id);
          result.creatives.push({
            key: creative.key,
            level: 'AD_CREATIVE',
            externalId: response.id,
            status: 'PAUSED',
            name: creative.name,
          });
        }

        for (const ad of plan.ads) {
          const adSetId = adSetIds.get(ad.adSetKey);
          const creativeId = creativeIds.get(ad.creativeKey);
          if (!adSetId || !creativeId) {
            throw new DomainError('INTERNAL', {
              messageDe: 'Der Entwurfsplan verweist auf ein Objekt, das nicht angelegt wurde.',
              details: { ad: ad.key },
            });
          }
          const response = await this.call({
            method: 'POST',
            path: `${plan.adAccountId}/ads`,
            operation: `${operation}.ad`,
            form: formEncode(draftAdPayload(plan, ad, adSetId, creativeId)),
            schema: idSchema,
          });
          result.ads.push({
            key: ad.key,
            level: 'AD',
            externalId: response.id,
            status: 'PAUSED',
            name: ad.name,
          });
        }

        result.ok = true;
        result.state = 'CREATED';
      } catch (error) {
        result.ok = false;
        result.state = 'PARTIAL';
        result.errorDe =
          error instanceof DomainError
            ? error.messageDe
            : 'Der Meta-Entwurf konnte nicht vollständig angelegt werden.';
      }

      result.responseRedacted = redact(created);
      return result;
    });
  }

  /**
   * Recovers an already-created draft after a crash between "POST accepted" and
   * "result stored", by looking for the idempotency marker in the campaign name.
   */
  async findDraftByIdempotencyKey(idempotencyKey: string): Promise<DraftCreationResult | null> {
    return instrumented('META', 'meta.find_draft_by_idempotency_key', async () => {
      const marker = idempotencyMarker(idempotencyKey);
      const campaigns = await this.call({
        method: 'GET',
        path: `${this.accountPath}/campaigns`,
        operation: 'meta.find_draft_by_idempotency_key',
        params: {
          fields: 'id,name,status,effective_status',
          limit: 50,
          filtering: JSON.stringify([
            { field: 'name', operator: 'CONTAIN', value: marker },
          ]),
        },
        schema: metaListResponseSchema(metaCampaignSchema),
      });

      const match = campaigns.data.find(
        (campaign) => extractIdempotencyKey(campaign.name) === idempotencyKey,
      );
      if (!match) return null;

      const [adSets, ads] = await Promise.all([
        this.call({
          method: 'GET',
          path: `${match.id}/adsets`,
          operation: 'meta.find_draft_adsets',
          params: { fields: 'id,name,status', limit: 100 },
          schema: metaListResponseSchema(metaAdSetSchema),
        }),
        this.call({
          method: 'GET',
          path: `${match.id}/ads`,
          operation: 'meta.find_draft_ads',
          params: { fields: 'id,name,status,creative{id}', limit: 200 },
          schema: metaListResponseSchema(metaAdSchema),
        }),
      ]);

      const toObject = (
        level: DraftCreatedObject['level'],
        id: string,
        name: string,
      ): DraftCreatedObject => ({ key: id, level, externalId: id, status: 'PAUSED', name });

      return {
        ok: true,
        state: 'CREATED',
        idempotencyKey,
        campaign: toObject('CAMPAIGN', match.id, match.name),
        adSets: adSets.data.map((adSet) => toObject('ADSET', adSet.id, adSet.name)),
        creatives: ads.data
          .map((ad) => ad.creative?.id)
          .filter((id): id is string => typeof id === 'string')
          .map((id) => toObject('AD_CREATIVE', id, id)),
        ads: ads.data.map((ad) => toObject('AD', ad.id, ad.name)),
        createdAt: nowIso(),
        errorDe: null,
        responseRedacted: redact({ recovered_from: 'idempotency_marker' }),
      };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Conversions API                                                        */
  /* ---------------------------------------------------------------------- */

  async sendCapiEvents(
    request: CapiDispatchRequest,
  ): Promise<MutationOutcome<CapiDispatchResult>> {
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

    return instrumented(
      'META',
      operation,
      async () => {
        const form: Record<string, string> = { data: JSON.stringify(request.events) };
        const testCode = request.testEventCode ?? this.options.capiTestEventCode;
        if (testCode) form.test_event_code = testCode;

        const response = await this.call({
          method: 'POST',
          path: `${request.destinationId}/events`,
          operation,
          form,
          schema: capiResponseSchema,
          accessToken: this.options.capiAccessToken ?? this.options.accessToken,
        });

        return {
          ok: true as const,
          destinationId: request.destinationId,
          eventsReceived: response.events_received ?? 0,
          fbtraceId: response.fbtrace_id ?? null,
          dispatchedAt: nowIso(),
          responseRedacted: redact(response),
        };
      },
      (result) => ({ events_received: result.eventsReceived }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Health                                                                 */
  /* ---------------------------------------------------------------------- */

  async health(): Promise<ProviderHealth> {
    const checkedAt = nowIso();
    const checks: HealthCheck[] = [];

    const probe = async (
      key: string,
      labelDe: string,
      remediationDe: string,
      run: () => Promise<string>,
    ): Promise<void> => {
      try {
        const detailDe = await run();
        checks.push({
          key,
          labelDe,
          status: 'PASS',
          detailDe,
          checkedAt,
          remediationDe: null,
          blocksLiveOnly: false,
        });
      } catch (error) {
        const isDomain = error instanceof DomainError;
        const awaiting =
          isDomain &&
          (error.code === 'PROVIDER_NOT_CONFIGURED' || error.code === 'MAPPING_INCOMPLETE');
        checks.push({
          key,
          labelDe,
          status: awaiting ? 'AWAITING_EXTERNAL_INPUT' : 'FAIL',
          detailDe: isDomain ? error.messageDe : 'Unbekannter Fehler bei der Meta-Prüfung.',
          checkedAt,
          remediationDe,
          blocksLiveOnly: false,
        });
      }
    };

    await probe(
      'meta.ad_account',
      'Meta-Werbekonto erreichbar',
      'Prüfen Sie META_AD_ACCOUNT_ID und die Berechtigungen des verbundenen Nutzers.',
      async () => {
        const account = await this.call({
          method: 'GET',
          path: this.accountPath,
          operation: 'meta.health.ad_account',
          params: { fields: 'id,name,currency,account_status,timezone_name' },
          schema: metaAdAccountSchema,
        });
        return `Werbekonto „${account.name ?? account.id}" (${account.currency ?? '—'}).`;
      },
    );

    if (this.options.pixelId) {
      await probe(
        'meta.pixel',
        'Meta-Pixel erreichbar',
        'Prüfen Sie META_PIXEL_ID und ob das Pixel dem Werbekonto zugeordnet ist.',
        async () => {
          const pixel = await this.call({
            method: 'GET',
            path: this.options.pixelId as string,
            operation: 'meta.health.pixel',
            params: { fields: 'id,name,last_fired_time' },
            schema: metaPixelSchema,
          });
          return `Pixel „${pixel.name ?? pixel.id}".`;
        },
      );
    }

    const overall = rollUpHealth(checks);
    return {
      provider: 'META',
      state: overall === 'PASS' ? 'CONNECTED' : overall === 'FAIL' ? 'ERROR' : 'DEGRADED',
      overall,
      checks,
      checkedAt,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Graph API takes nested structures as JSON strings inside a form-encoded
 * body. Scalars stay scalars so a reviewer sees `status=PAUSED`, not
 * `status="PAUSED"`.
 */
export function formEncode(payload: Record<string, unknown>): Record<string, string> {
  const form: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    form[key] =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  }
  return form;
}
