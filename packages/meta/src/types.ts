/**
 * Wire shapes of the Meta Graph API and the Conversions API, plus the mapping
 * onto our domain shapes.
 *
 * Everything that travels on the wire keeps Meta's `snake_case` naming so a
 * reviewer can diff a payload against the Graph API reference without a mental
 * translation step. Everything that crosses into the rest of the product is
 * mapped here, once, into `camelCase` records with `Money` in minor units and
 * `Rate` carrying numerator/denominator (AGENTS.md conventions).
 *
 * Two Meta unit conventions that are easy to get wrong and are therefore
 * handled in exactly one place:
 *
 * - Budget fields (`daily_budget`, `lifetime_budget`, `bid_amount`, `spend_cap`)
 *   are **minor units** delivered as decimal strings ("5000" = 50,00 EUR).
 * - Insights money fields (`spend`, `cpc`, `cpm`, `cpp`) are **major units**
 *   delivered as decimal strings ("12.34" = 12,34 EUR).
 */
import { z } from 'zod';
import {
  isoDateSchema,
  type MetaEntityStatus,
  type Money,
  type Rate,
  money,
  rate,
} from '@am/domain';

/* -------------------------------------------------------------------------- */
/* Graph API plumbing                                                          */
/* -------------------------------------------------------------------------- */

export const META_GRAPH_HOST = 'https://graph.facebook.com';

/** Meta CDN hosts we are willing to download a creative asset from. */
export const META_ASSET_HOST_SUFFIXES: readonly string[] = [
  '.fbcdn.net',
  '.facebook.com',
  '.cdninstagram.com',
];

/**
 * Builds a Graph API URL. The version is always pinned from configuration
 * (`META_API_VERSION`) — never defaulted at the call site, because a silent
 * version drift changes field semantics without any code change.
 */
export function buildGraphUrl(
  apiVersion: string,
  path: string,
  params: Record<string, string | number | undefined | null> = {},
): string {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(`${META_GRAPH_HOST}/${apiVersion}/${normalizedPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Meta ad account ids are addressed as `act_<id>` on every edge. */
export function adAccountPath(adAccountId: string): string {
  return adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
}

/** Strips the `act_` prefix for places that want the bare numeric id. */
export function bareAccountId(adAccountId: string): string {
  return adAccountId.startsWith('act_') ? adAccountId.slice(4) : adAccountId;
}

/* -------------------------------------------------------------------------- */
/* Numeric coercion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The Graph API returns numbers as strings almost everywhere. Coercion happens
 * here rather than at every call site so that an unexpected `""` can never
 * become `NaN` inside a metric.
 */
const numericInput = z.union([z.number(), z.string(), z.null()]).optional();

const metaNumberOrZero = numericInput.transform((value): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
});

const metaNumberOrNull = numericInput.transform((value): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
});

/** Meta budget string in minor units → integer minor units. */
export function parseMinorUnits(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/** Meta insights money string in major units → integer minor units. */
export function parseMajorUnitsToMinor(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

export const metaPagingSchema = z.object({
  cursors: z
    .object({
      before: z.string().nullish(),
      after: z.string().nullish(),
    })
    .nullish(),
  next: z.string().nullish(),
  previous: z.string().nullish(),
});
export type MetaPaging = z.infer<typeof metaPagingSchema>;

/** `{ data: [...], paging: { cursors: { after } } }` — the universal list shape. */
export function metaListResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item).default([]),
    paging: metaPagingSchema.nullish(),
  });
}

export const metaErrorBodySchema = z.object({
  error: z.object({
    message: z.string().default(''),
    type: z.string().nullish(),
    code: z.number().nullish(),
    error_subcode: z.number().nullish(),
    error_user_title: z.string().nullish(),
    error_user_msg: z.string().nullish(),
    fbtrace_id: z.string().nullish(),
    is_transient: z.boolean().nullish(),
  }),
});
export type MetaErrorBody = z.infer<typeof metaErrorBodySchema>;

/* -------------------------------------------------------------------------- */
/* Account-level entities                                                      */
/* -------------------------------------------------------------------------- */

export const metaAdAccountSchema = z.object({
  id: z.string(),
  account_id: z.string().nullish(),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  timezone_name: z.string().nullish(),
  /** 1 = ACTIVE, 2 = DISABLED, 3 = UNSETTLED, 7 = PENDING_RISK_REVIEW, 101 = CLOSED. */
  account_status: metaNumberOrNull,
  business: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
  spend_cap: z.string().nullish(),
  amount_spent: z.string().nullish(),
});
export type MetaAdAccountWire = z.infer<typeof metaAdAccountSchema>;

export const metaPageSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  category: z.string().nullish(),
  tasks: z.array(z.string()).nullish(),
});
export type MetaPageWire = z.infer<typeof metaPageSchema>;

export const metaInstagramActorSchema = z.object({
  id: z.string(),
  username: z.string().nullish(),
  name: z.string().nullish(),
  profile_pic: z.string().nullish(),
});
export type MetaInstagramActorWire = z.infer<typeof metaInstagramActorSchema>;

export const metaPixelSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  last_fired_time: z.string().nullish(),
  is_created_by_business: z.boolean().nullish(),
});
export type MetaPixelWire = z.infer<typeof metaPixelSchema>;

/**
 * A dataset (formerly "offline event set") is the CAPI destination for events
 * that do not originate on the website. Same id space as a pixel on the
 * `/{id}/events` edge.
 */
export const metaDatasetSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  is_restricted_use: z.boolean().nullish(),
});
export type MetaDatasetWire = z.infer<typeof metaDatasetSchema>;

/* -------------------------------------------------------------------------- */
/* Ad hierarchy                                                                */
/* -------------------------------------------------------------------------- */

export const metaCampaignSchema = z.object({
  id: z.string(),
  account_id: z.string().nullish(),
  name: z.string().default(''),
  objective: z.string().nullish(),
  status: z.string().nullish(),
  effective_status: z.string().nullish(),
  buying_type: z.string().nullish(),
  bid_strategy: z.string().nullish(),
  daily_budget: z.string().nullish(),
  lifetime_budget: z.string().nullish(),
  budget_remaining: z.string().nullish(),
  special_ad_categories: z.array(z.string()).nullish(),
  created_time: z.string().nullish(),
  updated_time: z.string().nullish(),
  start_time: z.string().nullish(),
  stop_time: z.string().nullish(),
});
export type MetaCampaignWire = z.infer<typeof metaCampaignSchema>;

export const metaPromotedObjectSchema = z.object({
  pixel_id: z.string().nullish(),
  custom_event_type: z.string().nullish(),
  custom_conversion_id: z.string().nullish(),
  page_id: z.string().nullish(),
  object_store_url: z.string().nullish(),
});
export type MetaPromotedObject = z.infer<typeof metaPromotedObjectSchema>;

export const metaAdSetSchema = z.object({
  id: z.string(),
  account_id: z.string().nullish(),
  campaign_id: z.string().nullish(),
  name: z.string().default(''),
  status: z.string().nullish(),
  effective_status: z.string().nullish(),
  daily_budget: z.string().nullish(),
  lifetime_budget: z.string().nullish(),
  bid_amount: z.string().nullish(),
  bid_strategy: z.string().nullish(),
  billing_event: z.string().nullish(),
  optimization_goal: z.string().nullish(),
  destination_type: z.string().nullish(),
  promoted_object: metaPromotedObjectSchema.nullish(),
  targeting: z.record(z.string(), z.unknown()).nullish(),
  attribution_spec: z.array(z.record(z.string(), z.unknown())).nullish(),
  start_time: z.string().nullish(),
  end_time: z.string().nullish(),
  created_time: z.string().nullish(),
  updated_time: z.string().nullish(),
});
export type MetaAdSetWire = z.infer<typeof metaAdSetSchema>;

export const metaAdSchema = z.object({
  id: z.string(),
  account_id: z.string().nullish(),
  campaign_id: z.string().nullish(),
  adset_id: z.string().nullish(),
  name: z.string().default(''),
  status: z.string().nullish(),
  effective_status: z.string().nullish(),
  creative: z.object({ id: z.string().nullish() }).nullish(),
  tracking_specs: z.array(z.record(z.string(), z.unknown())).nullish(),
  created_time: z.string().nullish(),
  updated_time: z.string().nullish(),
});
export type MetaAdWire = z.infer<typeof metaAdSchema>;

export const metaCallToActionSchema = z.object({
  type: z.string(),
  value: z
    .object({
      link: z.string().nullish(),
      link_caption: z.string().nullish(),
    })
    .nullish(),
});

export const metaLinkDataSchema = z.object({
  link: z.string().nullish(),
  message: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  caption: z.string().nullish(),
  image_hash: z.string().nullish(),
  picture: z.string().nullish(),
  call_to_action: metaCallToActionSchema.nullish(),
});
export type MetaLinkData = z.infer<typeof metaLinkDataSchema>;

export const metaVideoDataSchema = z.object({
  video_id: z.string().nullish(),
  message: z.string().nullish(),
  title: z.string().nullish(),
  link_description: z.string().nullish(),
  image_hash: z.string().nullish(),
  image_url: z.string().nullish(),
  call_to_action: metaCallToActionSchema.nullish(),
});
export type MetaVideoData = z.infer<typeof metaVideoDataSchema>;

export const metaObjectStorySpecSchema = z.object({
  page_id: z.string().nullish(),
  /**
   * Historically `instagram_actor_id`; newer API versions accept
   * `instagram_user_id`. Both are read on import, and the writer emits the one
   * configured for the pinned API version.
   */
  instagram_actor_id: z.string().nullish(),
  instagram_user_id: z.string().nullish(),
  link_data: metaLinkDataSchema.nullish(),
  video_data: metaVideoDataSchema.nullish(),
});
export type MetaObjectStorySpec = z.infer<typeof metaObjectStorySpecSchema>;

export const metaAdCreativeSchema = z.object({
  id: z.string(),
  account_id: z.string().nullish(),
  name: z.string().default(''),
  status: z.string().nullish(),
  object_story_spec: metaObjectStorySpecSchema.nullish(),
  effective_object_story_id: z.string().nullish(),
  thumbnail_url: z.string().nullish(),
  image_url: z.string().nullish(),
  image_hash: z.string().nullish(),
  video_id: z.string().nullish(),
  url_tags: z.string().nullish(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  call_to_action_type: z.string().nullish(),
});
export type MetaAdCreativeWire = z.infer<typeof metaAdCreativeSchema>;

/* -------------------------------------------------------------------------- */
/* Insights                                                                    */
/* -------------------------------------------------------------------------- */

export const metaActionSchema = z.object({
  action_type: z.string(),
  value: metaNumberOrZero,
});
export type MetaAction = z.infer<typeof metaActionSchema>;

export const INSIGHTS_LEVELS = ['account', 'campaign', 'adset', 'ad'] as const;
export const insightsLevelSchema = z.enum(INSIGHTS_LEVELS);
export type InsightsLevel = z.infer<typeof insightsLevelSchema>;

/**
 * Action types that count as a lead for us. `lead` is the aggregate Meta
 * reports for lead-optimised delivery; the pixel/offsite variants show up when
 * the conversion is measured through the pixel or the Conversions API.
 */
export const LEAD_ACTION_TYPES: readonly string[] = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_web_lead',
];

export const metaInsightsRowSchema = z.object({
  date_start: z.string(),
  date_stop: z.string(),
  account_id: z.string().nullish(),
  account_currency: z.string().nullish(),
  campaign_id: z.string().nullish(),
  campaign_name: z.string().nullish(),
  adset_id: z.string().nullish(),
  adset_name: z.string().nullish(),
  ad_id: z.string().nullish(),
  ad_name: z.string().nullish(),
  impressions: metaNumberOrZero,
  reach: metaNumberOrZero,
  frequency: metaNumberOrZero,
  clicks: metaNumberOrZero,
  inline_link_clicks: metaNumberOrZero,
  unique_inline_link_clicks: metaNumberOrZero,
  spend: z.union([z.number(), z.string(), z.null()]).optional(),
  ctr: metaNumberOrNull,
  inline_link_click_ctr: metaNumberOrNull,
  cpc: z.union([z.number(), z.string(), z.null()]).optional(),
  cpm: z.union([z.number(), z.string(), z.null()]).optional(),
  actions: z.array(metaActionSchema).nullish(),
  action_values: z.array(metaActionSchema).nullish(),
});
export type MetaInsightsRowWire = z.infer<typeof metaInsightsRowSchema>;

/* -------------------------------------------------------------------------- */
/* Conversions API                                                             */
/* -------------------------------------------------------------------------- */

export const CAPI_ACTION_SOURCES = [
  'website',
  'email',
  'app',
  'phone_call',
  'chat',
  'physical_store',
  'system_generated',
  'business_messaging',
  'other',
] as const;
export const capiActionSourceSchema = z.enum(CAPI_ACTION_SOURCES);
export type CapiActionSource = z.infer<typeof capiActionSourceSchema>;

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Erwartet einen SHA-256-Hash in Kleinbuchstaben (Hex).');

/**
 * `user_data` as Meta expects it on the wire.
 *
 * Hashed fields (`em`, `ph`, `fn`, `ln`, `ct`, `st`, `zp`, `country`,
 * `external_id`) are lowercase hex SHA-256 of the *normalised* value. The
 * remaining fields (`fbc`, `fbp`, `client_ip_address`, `client_user_agent`,
 * `lead_id`, `subscription_id`) are sent raw — hashing them would break
 * matching. That split is enforced by this schema.
 */
export const capiUserDataSchema = z.object({
  em: sha256HexSchema.optional(),
  ph: sha256HexSchema.optional(),
  fn: sha256HexSchema.optional(),
  ln: sha256HexSchema.optional(),
  ct: sha256HexSchema.optional(),
  st: sha256HexSchema.optional(),
  zp: sha256HexSchema.optional(),
  country: sha256HexSchema.optional(),
  external_id: sha256HexSchema.optional(),
  fbc: z.string().max(500).optional(),
  fbp: z.string().max(500).optional(),
  client_ip_address: z.string().max(64).optional(),
  client_user_agent: z.string().max(1000).optional(),
  /** Meta lead-ad id, used by the conversion-leads CRM integration. Not hashed. */
  lead_id: z.union([z.string().max(64), z.number()]).optional(),
  subscription_id: z.string().max(120).optional(),
});
export type CapiUserData = z.infer<typeof capiUserDataSchema>;

export const capiCustomDataSchema = z.object({
  value: z.number().optional(),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/)
    .optional(),
  content_name: z.string().max(200).optional(),
  content_category: z.string().max(200).optional(),
  content_ids: z.array(z.string().max(120)).max(50).optional(),
  content_type: z.string().max(60).optional(),
  order_id: z.string().max(120).optional(),
  predicted_ltv: z.number().optional(),
  num_items: z.number().int().optional(),
  status: z.string().max(60).optional(),
  /** Conversion-leads CRM integration: which CRM the stage change came from. */
  lead_event_source: z.string().max(120).optional(),
  event_source: z.string().max(60).optional(),
});
export type CapiCustomData = z.infer<typeof capiCustomDataSchema>;

export const capiServerEventSchema = z.object({
  event_name: z.string().min(1).max(60),
  /** Unix seconds. Business time of the event — never the retry time. */
  event_time: z.number().int().positive(),
  /** Shared with the browser pixel's `eventID` so Meta can deduplicate. */
  event_id: z.string().min(1).max(200).optional(),
  event_source_url: z.string().max(2000).optional(),
  action_source: capiActionSourceSchema,
  opt_out: z.boolean().optional(),
  user_data: capiUserDataSchema,
  custom_data: capiCustomDataSchema.optional(),
  data_processing_options: z.array(z.string().max(20)).optional(),
  data_processing_options_country: z.number().int().optional(),
  data_processing_options_state: z.number().int().optional(),
  referrer_url: z.string().max(2000).optional(),
});
export type CapiServerEvent = z.infer<typeof capiServerEventSchema>;

export const capiBatchSchema = z.object({
  data: z.array(capiServerEventSchema).min(1).max(1000),
  /** Only ever set from Settings while testing; never in production. */
  test_event_code: z.string().max(60).optional(),
  partner_agent: z.string().max(60).optional(),
});
export type CapiBatch = z.infer<typeof capiBatchSchema>;

export const capiResponseSchema = z.object({
  events_received: z.number().int().nullish(),
  messages: z.array(z.unknown()).nullish(),
  fbtrace_id: z.string().nullish(),
});
export type CapiResponse = z.infer<typeof capiResponseSchema>;

/** What the browser hands to `fbq('track', name, customData, { eventID })`. */
export const pixelPayloadSchema = z.object({
  pixelId: z.string().min(1),
  eventName: z.string().min(1).max(60),
  /** Meta's browser-side spelling of `event_id`. Casing matters for dedup. */
  eventID: z.string().min(1).max(200),
  customData: capiCustomDataSchema.optional(),
});
export type PixelPayload = z.infer<typeof pixelPayloadSchema>;

/* -------------------------------------------------------------------------- */
/* Domain records                                                              */
/* -------------------------------------------------------------------------- */

/** Composite key every upsert is done on. Guarantees import idempotency. */
export interface ExternalRef {
  provider: 'META';
  externalId: string;
}

export function externalKey(externalId: string): string {
  return `META:${externalId}`;
}

export interface MetaAdAccountRecord {
  externalId: string;
  accountId: string;
  name: string;
  currency: string;
  timezone: string | null;
  accountStatus: number | null;
  businessId: string | null;
  businessName: string | null;
}

export interface MetaPageRecord {
  externalId: string;
  name: string;
  category: string | null;
  tasks: string[];
}

export interface MetaInstagramActorRecord {
  externalId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
}

export interface MetaPixelRecord {
  externalId: string;
  name: string;
  lastFiredAt: string | null;
}

export interface MetaDatasetRecord {
  externalId: string;
  name: string;
  description: string | null;
}

export interface MetaCampaignRecord {
  externalId: string;
  accountExternalId: string | null;
  name: string;
  objective: string | null;
  status: MetaEntityStatus;
  statusRaw: string | null;
  effectiveStatus: string | null;
  buyingType: string | null;
  bidStrategy: string | null;
  dailyBudget: Money | null;
  lifetimeBudget: Money | null;
  specialAdCategories: string[];
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

export interface MetaAdSetRecord {
  externalId: string;
  campaignExternalId: string | null;
  name: string;
  status: MetaEntityStatus;
  statusRaw: string | null;
  effectiveStatus: string | null;
  dailyBudget: Money | null;
  lifetimeBudget: Money | null;
  bidAmount: Money | null;
  bidStrategy: string | null;
  billingEvent: string | null;
  optimizationGoal: string | null;
  destinationType: string | null;
  promotedPixelId: string | null;
  promotedCustomEventType: string | null;
  startedAt: string | null;
  endsAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MetaAdRecord {
  externalId: string;
  campaignExternalId: string | null;
  adSetExternalId: string | null;
  creativeExternalId: string | null;
  name: string;
  status: MetaEntityStatus;
  statusRaw: string | null;
  effectiveStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MetaAdCreativeRecord {
  externalId: string;
  name: string;
  pageId: string | null;
  instagramActorId: string | null;
  linkUrl: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  callToActionType: string | null;
  imageHash: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  videoId: string | null;
  urlTags: string | null;
}

/**
 * One day of delivery for one object. Rates are recomputed from the raw counts
 * rather than trusting Meta's rounded string, so the console can always render
 * "12 / 340" beside "3,5 %" (AGENTS.md, acceptance criterion 19).
 */
export interface MetaInsightsDailyRow {
  date: string;
  level: InsightsLevel;
  externalId: string;
  accountExternalId: string | null;
  campaignExternalId: string | null;
  adSetExternalId: string | null;
  adExternalId: string | null;
  name: string | null;
  currency: string;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  spend: Money;
  ctr: Rate;
  linkCtr: Rate;
  cpc: Money | null;
  cpm: Money | null;
  cpl: Money | null;
}

/** Raw provider payload, tagged so the caller can persist it privately. */
export interface RawProviderPayload {
  provider: 'META';
  kind:
    | 'AD_ACCOUNT'
    | 'PAGE'
    | 'INSTAGRAM_ACTOR'
    | 'PIXEL'
    | 'DATASET'
    | 'CAMPAIGN'
    | 'ADSET'
    | 'AD'
    | 'AD_CREATIVE'
    | 'INSIGHTS_DAILY';
  externalId: string;
  fetchedAt: string;
  apiVersion: string;
  payload: unknown;
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                     */
/* -------------------------------------------------------------------------- */

const KNOWN_STATUSES: readonly MetaEntityStatus[] = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'];

/**
 * Maps Meta's `status` onto our enum. An unknown value maps to `PAUSED` rather
 * than `ACTIVE`: guessing "running" for something we do not understand is the
 * expensive direction to be wrong in.
 */
export function toEntityStatus(raw: string | null | undefined): MetaEntityStatus {
  if (!raw) return 'PAUSED';
  const upper = raw.toUpperCase();
  return (KNOWN_STATUSES as readonly string[]).includes(upper)
    ? (upper as MetaEntityStatus)
    : 'PAUSED';
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function mapAdAccount(wire: MetaAdAccountWire): MetaAdAccountRecord {
  return {
    externalId: wire.id,
    accountId: wire.account_id ?? bareAccountId(wire.id),
    name: wire.name ?? wire.id,
    currency: wire.currency ?? 'EUR',
    timezone: wire.timezone_name ?? null,
    accountStatus: wire.account_status,
    businessId: wire.business?.id ?? null,
    businessName: wire.business?.name ?? null,
  };
}

export function mapPage(wire: MetaPageWire): MetaPageRecord {
  return {
    externalId: wire.id,
    name: wire.name ?? wire.id,
    category: wire.category ?? null,
    tasks: wire.tasks ?? [],
  };
}

export function mapInstagramActor(wire: MetaInstagramActorWire): MetaInstagramActorRecord {
  return {
    externalId: wire.id,
    username: wire.username ?? null,
    name: wire.name ?? null,
    profilePictureUrl: wire.profile_pic ?? null,
  };
}

export function mapPixel(wire: MetaPixelWire): MetaPixelRecord {
  return {
    externalId: wire.id,
    name: wire.name ?? wire.id,
    lastFiredAt: toIso(wire.last_fired_time),
  };
}

export function mapDataset(wire: MetaDatasetWire): MetaDatasetRecord {
  return {
    externalId: wire.id,
    name: wire.name ?? wire.id,
    description: wire.description ?? null,
  };
}

export function mapCampaign(wire: MetaCampaignWire, currency: string): MetaCampaignRecord {
  const daily = parseMinorUnits(wire.daily_budget);
  const lifetime = parseMinorUnits(wire.lifetime_budget);
  return {
    externalId: wire.id,
    accountExternalId: wire.account_id ?? null,
    name: wire.name,
    objective: wire.objective ?? null,
    status: toEntityStatus(wire.status),
    statusRaw: wire.status ?? null,
    effectiveStatus: wire.effective_status ?? null,
    buyingType: wire.buying_type ?? null,
    bidStrategy: wire.bid_strategy ?? null,
    dailyBudget: daily === null ? null : money(daily, currency),
    lifetimeBudget: lifetime === null ? null : money(lifetime, currency),
    specialAdCategories: wire.special_ad_categories ?? [],
    createdAt: toIso(wire.created_time),
    updatedAt: toIso(wire.updated_time),
    startedAt: toIso(wire.start_time),
    stoppedAt: toIso(wire.stop_time),
  };
}

export function mapAdSet(wire: MetaAdSetWire, currency: string): MetaAdSetRecord {
  const daily = parseMinorUnits(wire.daily_budget);
  const lifetime = parseMinorUnits(wire.lifetime_budget);
  const bid = parseMinorUnits(wire.bid_amount);
  return {
    externalId: wire.id,
    campaignExternalId: wire.campaign_id ?? null,
    name: wire.name,
    status: toEntityStatus(wire.status),
    statusRaw: wire.status ?? null,
    effectiveStatus: wire.effective_status ?? null,
    dailyBudget: daily === null ? null : money(daily, currency),
    lifetimeBudget: lifetime === null ? null : money(lifetime, currency),
    bidAmount: bid === null ? null : money(bid, currency),
    bidStrategy: wire.bid_strategy ?? null,
    billingEvent: wire.billing_event ?? null,
    optimizationGoal: wire.optimization_goal ?? null,
    destinationType: wire.destination_type ?? null,
    promotedPixelId: wire.promoted_object?.pixel_id ?? null,
    promotedCustomEventType: wire.promoted_object?.custom_event_type ?? null,
    startedAt: toIso(wire.start_time),
    endsAt: toIso(wire.end_time),
    createdAt: toIso(wire.created_time),
    updatedAt: toIso(wire.updated_time),
  };
}

export function mapAd(wire: MetaAdWire): MetaAdRecord {
  return {
    externalId: wire.id,
    campaignExternalId: wire.campaign_id ?? null,
    adSetExternalId: wire.adset_id ?? null,
    creativeExternalId: wire.creative?.id ?? null,
    name: wire.name,
    status: toEntityStatus(wire.status),
    statusRaw: wire.status ?? null,
    effectiveStatus: wire.effective_status ?? null,
    createdAt: toIso(wire.created_time),
    updatedAt: toIso(wire.updated_time),
  };
}

export function mapAdCreative(wire: MetaAdCreativeWire): MetaAdCreativeRecord {
  const spec = wire.object_story_spec ?? null;
  const link = spec?.link_data ?? null;
  const video = spec?.video_data ?? null;
  return {
    externalId: wire.id,
    name: wire.name,
    pageId: spec?.page_id ?? null,
    instagramActorId: spec?.instagram_actor_id ?? spec?.instagram_user_id ?? null,
    linkUrl: link?.link ?? link?.call_to_action?.value?.link ?? null,
    primaryText: link?.message ?? video?.message ?? wire.body ?? null,
    headline: link?.name ?? video?.title ?? wire.title ?? null,
    description: link?.description ?? video?.link_description ?? null,
    callToActionType:
      link?.call_to_action?.type ?? video?.call_to_action?.type ?? wire.call_to_action_type ?? null,
    imageHash: link?.image_hash ?? video?.image_hash ?? wire.image_hash ?? null,
    imageUrl: wire.image_url ?? video?.image_url ?? link?.picture ?? null,
    thumbnailUrl: wire.thumbnail_url ?? null,
    videoId: video?.video_id ?? wire.video_id ?? null,
    urlTags: wire.url_tags ?? null,
  };
}

function sumActions(actions: readonly MetaAction[] | null | undefined): number {
  if (!actions) return 0;
  let total = 0;
  for (const action of actions) {
    if (LEAD_ACTION_TYPES.includes(action.action_type)) total += action.value;
  }
  return total;
}

export function mapInsightsRow(
  wire: MetaInsightsRowWire,
  level: InsightsLevel,
  currency: string,
): MetaInsightsDailyRow {
  const spendMinor = parseMajorUnitsToMinor(wire.spend ?? null) ?? 0;
  const impressions = Math.round(wire.impressions);
  const clicks = Math.round(wire.clicks);
  const linkClicks = Math.round(wire.inline_link_clicks);
  const leads = Math.round(sumActions(wire.actions));

  const externalId =
    level === 'ad'
      ? (wire.ad_id ?? '')
      : level === 'adset'
        ? (wire.adset_id ?? '')
        : level === 'campaign'
          ? (wire.campaign_id ?? '')
          : (wire.account_id ?? '');

  const name =
    level === 'ad'
      ? (wire.ad_name ?? null)
      : level === 'adset'
        ? (wire.adset_name ?? null)
        : level === 'campaign'
          ? (wire.campaign_name ?? null)
          : null;

  const rowCurrency = wire.account_currency ?? currency;

  return {
    date: isoDateSchema.parse(wire.date_start),
    level,
    externalId,
    accountExternalId: wire.account_id ?? null,
    campaignExternalId: wire.campaign_id ?? null,
    adSetExternalId: wire.adset_id ?? null,
    adExternalId: wire.ad_id ?? null,
    name,
    currency: rowCurrency,
    impressions,
    reach: Math.round(wire.reach),
    frequency: wire.frequency,
    clicks,
    linkClicks,
    leads,
    spend: money(spendMinor, rowCurrency),
    ctr: rate(clicks, impressions),
    linkCtr: rate(linkClicks, impressions),
    cpc: linkClicks > 0 ? money(Math.round(spendMinor / linkClicks), rowCurrency) : null,
    cpm: impressions > 0 ? money(Math.round((spendMinor / impressions) * 1000), rowCurrency) : null,
    cpl: leads > 0 ? money(Math.round(spendMinor / leads), rowCurrency) : null,
  };
}
