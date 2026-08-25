/**
 * Paused draft creation.
 *
 * Two separate steps on purpose:
 *
 * 1. `buildDraftPlan(input)` produces a fully resolved, reviewable plan. It
 *    touches no network and can therefore be rendered, diffed and approved.
 * 2. `createPausedDraft(plan, …)` sends it — and only if `canWriteMeta(flags)`.
 *
 * Every object in the plan is created `PAUSED`. That is enforced by the schema
 * (`z.literal('PAUSED')`), re-asserted before dispatch, and re-checked on the
 * result, because "we accidentally launched a campaign" is the single most
 * expensive bug this package could ship.
 */
import { LAUNCH_TOKEN_PARAM } from '@am/domain';
import { z } from 'zod';
import {
  type DryRunResult,
  type FeatureFlags,
  DomainError,
  canWriteMeta,
  dryRun,
  httpsUrlSchema,
  nowIso,
  redact,
} from '@am/domain';
import type { MetaProvider, MutationOutcome } from './provider';
import { adAccountPath } from './types';

/* -------------------------------------------------------------------------- */
/* Enumerations we are willing to emit                                         */
/* -------------------------------------------------------------------------- */

export const DRAFT_OBJECTIVES = [
  'OUTCOME_LEADS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_AWARENESS',
  'OUTCOME_SALES',
] as const;
export const draftObjectiveSchema = z.enum(DRAFT_OBJECTIVES);
export type DraftObjective = z.infer<typeof draftObjectiveSchema>;

/**
 * `special_ad_categories` is mandatory on campaign creation; an empty array is
 * the "no restricted category" answer. We keep the enum explicit so nobody
 * accidentally omits a legally required declaration.
 */
export const SPECIAL_AD_CATEGORIES = [
  'HOUSING',
  'EMPLOYMENT',
  'CREDIT',
  'ISSUES_ELECTIONS_POLITICS',
  'ONLINE_GAMBLING_AND_GAMING',
  'FINANCIAL_PRODUCTS_SERVICES',
] as const;
export const specialAdCategorySchema = z.enum(SPECIAL_AD_CATEGORIES);

export const OPTIMIZATION_GOALS = [
  'OFFSITE_CONVERSIONS',
  'LEAD_GENERATION',
  'QUALITY_LEAD',
  'LANDING_PAGE_VIEWS',
  'LINK_CLICKS',
  'IMPRESSIONS',
  'REACH',
] as const;
export const optimizationGoalSchema = z.enum(OPTIMIZATION_GOALS);

export const BILLING_EVENTS = ['IMPRESSIONS', 'LINK_CLICKS'] as const;
export const billingEventSchema = z.enum(BILLING_EVENTS);

export const BID_STRATEGIES = [
  'LOWEST_COST_WITHOUT_CAP',
  'LOWEST_COST_WITH_BID_CAP',
  'COST_CAP',
] as const;
export const bidStrategySchema = z.enum(BID_STRATEGIES);

export const CALL_TO_ACTION_TYPES = [
  'LEARN_MORE',
  'SIGN_UP',
  'GET_QUOTE',
  'BOOK_TRAVEL',
  'CONTACT_US',
  'APPLY_NOW',
  'DOWNLOAD',
  'GET_OFFER',
  'SUBSCRIBE',
] as const;
export const callToActionTypeSchema = z.enum(CALL_TO_ACTION_TYPES);

export const PUBLISHER_PLATFORMS = [
  'facebook',
  'instagram',
  'audience_network',
  'messenger',
  'threads',
] as const;

/* -------------------------------------------------------------------------- */
/* Tracking / destination URL                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Query parameter carrying our server-signed launch token. The token itself is
 * produced by `@am/tracking`; this package only ever receives it as a string so
 * the signing secret never enters the Meta adapter.
 */
export { LAUNCH_TOKEN_PARAM };

/**
 * Meta dynamic URL parameters. Meta substitutes these on click, which is how a
 * landing page learns the ad ids without us guessing them at build time. They
 * map 1:1 onto `marketingParamsSchema` in `@am/domain`.
 */
export const META_DYNAMIC_URL_TAGS =
  'meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}';

export const utmParamsSchema = z.object({
  source: z.string().min(1).max(100).default('meta'),
  medium: z.string().min(1).max(100).default('paid_social'),
  /** Our internal campaign slug — not the Meta campaign id. */
  campaign: z.string().min(1).max(200),
  content: z.string().max(200).nullable().default(null),
  term: z.string().max(200).nullable().default(null),
});
export type UtmParams = z.infer<typeof utmParamsSchema>;

export interface DestinationUrlInput {
  baseUrl: string;
  /** Server-signed launch token, supplied by the caller. Never generated here. */
  launchToken: string;
  utm: UtmParams;
  tokenParam?: string;
  extraParams?: Record<string, string>;
}

/**
 * Builds the click destination: funnel URL + signed launch token + UTMs.
 *
 * The signed token is what makes attribution `EXACT` (see `resolveConfidence`
 * in `@am/domain`); the UTMs are the human-readable fallback and are explicitly
 * untrusted downstream.
 */
export function buildDestinationUrl(input: DestinationUrlInput): string {
  const base = httpsUrlSchema.parse(input.baseUrl);
  const url = new URL(base);
  const utm = utmParamsSchema.parse(input.utm);

  url.searchParams.set(input.tokenParam ?? LAUNCH_TOKEN_PARAM, input.launchToken);
  url.searchParams.set('utm_source', utm.source);
  url.searchParams.set('utm_medium', utm.medium);
  url.searchParams.set('utm_campaign', utm.campaign);
  if (utm.content) url.searchParams.set('utm_content', utm.content);
  if (utm.term) url.searchParams.set('utm_term', utm.term);
  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Idempotency marker                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Meta's ad objects have no generic metadata field, so the idempotency key is
 * carried in the campaign name. That is what lets `findDraftByIdempotencyKey`
 * recognise an already-created draft after a crash between "POST sent" and
 * "response stored" — the one case a local ledger alone cannot cover.
 */
export const IDEMPOTENCY_MARKER_PREFIX = 'AM:';

export function draftNameWithMarker(name: string, idempotencyKey: string): string {
  return `${name} [${IDEMPOTENCY_MARKER_PREFIX}${idempotencyKey}]`;
}

export function idempotencyMarker(idempotencyKey: string): string {
  return `[${IDEMPOTENCY_MARKER_PREFIX}${idempotencyKey}]`;
}

export function extractIdempotencyKey(name: string): string | null {
  const match = new RegExp(`\\[${IDEMPOTENCY_MARKER_PREFIX}([^\\]]+)\\]`).exec(name);
  return match ? match[1] : null;
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

const pausedStatus = z.literal('PAUSED');

export const draftPlacementsSchema = z.object({
  publisherPlatforms: z.array(z.enum(PUBLISHER_PLATFORMS)).min(1).default(['facebook', 'instagram']),
  facebookPositions: z.array(z.string().max(60)).default([]),
  instagramPositions: z.array(z.string().max(60)).default([]),
  devicePlatforms: z.array(z.enum(['mobile', 'desktop'])).default(['mobile', 'desktop']),
});
export type DraftPlacements = z.infer<typeof draftPlacementsSchema>;

export const draftTargetingSchema = z.object({
  countries: z.array(z.string().length(2)).min(1).default(['DE']),
  ageMin: z.number().int().min(13).max(65).default(25),
  ageMax: z.number().int().min(13).max(65).default(65),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).default([]),
  placements: draftPlacementsSchema,
  /** Escape hatch for targeting keys this package deliberately does not model. */
  extra: z.record(z.string(), z.unknown()).default({}),
});
export type DraftTargeting = z.infer<typeof draftTargetingSchema>;

export const draftCampaignSchema = z.object({
  name: z.string().min(1).max(400),
  objective: draftObjectiveSchema,
  status: pausedStatus,
  specialAdCategories: z.array(specialAdCategorySchema).default([]),
  buyingType: z.literal('AUCTION').default('AUCTION'),
  bidStrategy: bidStrategySchema.nullable().default(null),
  /** Campaign budget optimisation. Null means budgets live on the ad sets. */
  dailyBudgetMinor: z.number().int().min(0).nullable().default(null),
});
export type DraftCampaign = z.infer<typeof draftCampaignSchema>;

export const draftAdSetSchema = z.object({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(400),
  status: pausedStatus,
  dailyBudgetMinor: z.number().int().min(0).nullable().default(null),
  optimizationGoal: optimizationGoalSchema,
  billingEvent: billingEventSchema.default('IMPRESSIONS'),
  bidStrategy: bidStrategySchema.nullable().default(null),
  bidAmountMinor: z.number().int().min(0).nullable().default(null),
  targeting: draftTargetingSchema,
  /** `promoted_object` — the pixel plus the event we optimise towards. */
  pixelId: z.string().min(1).max(64),
  customEventType: z.string().min(1).max(60).default('LEAD'),
  destinationType: z.string().max(60).nullable().default('WEBSITE'),
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type DraftAdSet = z.infer<typeof draftAdSetSchema>;

export const draftCreativeSchema = z.object({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(400),
  pageId: z.string().min(1).max(64),
  instagramActorId: z.string().max(64).nullable().default(null),
  primaryText: z.string().min(1).max(2000),
  headline: z.string().min(1).max(255),
  description: z.string().max(255).nullable().default(null),
  callToAction: callToActionTypeSchema,
  /** Exactly one of the two — an image hash from the ad account, or a video. */
  imageHash: z.string().max(120).nullable().default(null),
  videoId: z.string().max(64).nullable().default(null),
  /** Fully resolved click destination including the signed launch token. */
  destinationUrl: z.string().min(1).max(2000),
  /** Meta dynamic URL parameters appended on click. */
  urlTags: z.string().max(1000),
  /** Internal reference so the console can trace an ad back to its version. */
  creativeVersionId: z.string().max(64).nullable().default(null),
});
export type DraftCreative = z.infer<typeof draftCreativeSchema>;

export const draftAdSchema = z.object({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(400),
  status: pausedStatus,
  adSetKey: z.string().min(1).max(60),
  creativeKey: z.string().min(1).max(60),
});
export type DraftAd = z.infer<typeof draftAdSchema>;

export const draftTrackingSchema = z.object({
  pixelId: z.string().min(1).max(64),
  launchTokenParam: z.string().min(1).max(40).default(LAUNCH_TOKEN_PARAM),
  utm: utmParamsSchema,
  /** Internal ids the console uses to link the draft back to a campaign version. */
  campaignId: z.string().max(64).nullable().default(null),
  campaignVersionId: z.string().max(64).nullable().default(null),
  funnelVersionId: z.string().max(64).nullable().default(null),
});
export type DraftTracking = z.infer<typeof draftTrackingSchema>;

export const draftPlanSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(128),
    apiVersion: z.string().min(2).max(20),
    adAccountId: z.string().min(1).max(64),
    currency: z.string().length(3),
    campaign: draftCampaignSchema,
    adSets: z.array(draftAdSetSchema).min(1).max(20),
    creatives: z.array(draftCreativeSchema).min(1).max(50),
    ads: z.array(draftAdSchema).min(1).max(100),
    tracking: draftTrackingSchema,
    builtAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((plan, ctx) => {
    const adSetKeys = new Set(plan.adSets.map((a) => a.key));
    const creativeKeys = new Set(plan.creatives.map((c) => c.key));

    if (adSetKeys.size !== plan.adSets.length) {
      ctx.addIssue({ code: 'custom', message: 'Ad-Set-Schlüssel müssen eindeutig sein.' });
    }
    if (creativeKeys.size !== plan.creatives.length) {
      ctx.addIssue({ code: 'custom', message: 'Creative-Schlüssel müssen eindeutig sein.' });
    }
    if (new Set(plan.ads.map((a) => a.key)).size !== plan.ads.length) {
      ctx.addIssue({ code: 'custom', message: 'Ad-Schlüssel müssen eindeutig sein.' });
    }
    for (const ad of plan.ads) {
      if (!adSetKeys.has(ad.adSetKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ads'],
          message: `Ad "${ad.key}" verweist auf ein unbekanntes Ad-Set "${ad.adSetKey}".`,
        });
      }
      if (!creativeKeys.has(ad.creativeKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ads'],
          message: `Ad "${ad.key}" verweist auf ein unbekanntes Creative "${ad.creativeKey}".`,
        });
      }
    }
    for (const creative of plan.creatives) {
      if (!creative.imageHash && !creative.videoId) {
        ctx.addIssue({
          code: 'custom',
          path: ['creatives'],
          message: `Creative "${creative.key}" benötigt entweder ein Bild (image_hash) oder ein Video (video_id).`,
        });
      }
    }
    const campaignBudget = plan.campaign.dailyBudgetMinor !== null;
    for (const adSet of plan.adSets) {
      const adSetBudget = adSet.dailyBudgetMinor !== null;
      if (campaignBudget === adSetBudget) {
        ctx.addIssue({
          code: 'custom',
          path: ['adSets'],
          message:
            'Das Tagesbudget muss entweder auf Kampagnenebene (CBO) oder auf Ad-Set-Ebene gesetzt sein – nicht auf beiden und nicht auf keiner.',
        });
      }
    }
  });
export type DraftPlan = z.infer<typeof draftPlanSchema>;

/* -------------------------------------------------------------------------- */
/* Building the plan                                                           */
/* -------------------------------------------------------------------------- */

export interface DraftPlanInput {
  idempotencyKey: string;
  apiVersion: string;
  adAccountId: string;
  currency: string;
  now?: string;

  campaign: {
    name: string;
    objective: DraftObjective;
    specialAdCategories?: readonly z.infer<typeof specialAdCategorySchema>[];
    dailyBudgetMinor?: number | null;
    bidStrategy?: z.infer<typeof bidStrategySchema> | null;
  };

  adSets: readonly {
    key: string;
    name: string;
    dailyBudgetMinor?: number | null;
    optimizationGoal: z.infer<typeof optimizationGoalSchema>;
    billingEvent?: z.infer<typeof billingEventSchema>;
    bidStrategy?: z.infer<typeof bidStrategySchema> | null;
    bidAmountMinor?: number | null;
    targeting: {
      countries?: readonly string[];
      ageMin?: number;
      ageMax?: number;
      genders?: readonly (1 | 2)[];
      placements?: {
        publisherPlatforms?: readonly (typeof PUBLISHER_PLATFORMS)[number][];
        facebookPositions?: readonly string[];
        instagramPositions?: readonly string[];
        devicePlatforms?: readonly ('mobile' | 'desktop')[];
      };
      extra?: Record<string, unknown>;
    };
    startTime: string;
    endTime?: string | null;
    customEventType?: string;
    destinationType?: string | null;
  }[];

  creatives: readonly {
    key: string;
    name: string;
    primaryText: string;
    headline: string;
    description?: string | null;
    callToAction: z.infer<typeof callToActionTypeSchema>;
    imageHash?: string | null;
    videoId?: string | null;
    /** Per-creative UTM content value, e.g. the creative version slug. */
    utmContent?: string | null;
    creativeVersionId?: string | null;
  }[];

  ads: readonly { key: string; name: string; adSetKey: string; creativeKey: string }[];

  tracking: {
    pixelId: string;
    pageId: string;
    instagramActorId?: string | null;
    /** Funnel base URL — the destination every creative links to. */
    destinationBaseUrl: string;
    /** Server-signed launch token from `@am/tracking`. Passed in, never made here. */
    launchToken: string;
    launchTokenParam?: string;
    utm: { source?: string; medium?: string; campaign: string; term?: string | null };
    urlTags?: string;
    campaignId?: string | null;
    campaignVersionId?: string | null;
    funnelVersionId?: string | null;
  };

  /** Append the idempotency marker to the campaign name. On by default. */
  embedIdempotencyMarker?: boolean;
}

/**
 * Resolves an input into a complete, reviewable plan: names, budgets,
 * placements, destination URLs (token + UTMs), tracking references and a
 * `PAUSED` status on every object.
 */
export function buildDraftPlan(input: DraftPlanInput): DraftPlan {
  const builtAt = input.now ?? nowIso();
  const embedMarker = input.embedIdempotencyMarker !== false;

  const baseUtm = utmParamsSchema.parse({
    source: input.tracking.utm.source ?? 'meta',
    medium: input.tracking.utm.medium ?? 'paid_social',
    campaign: input.tracking.utm.campaign,
    content: null,
    term: input.tracking.utm.term ?? null,
  });

  const creatives = input.creatives.map((creative) =>
    draftCreativeSchema.parse({
      key: creative.key,
      name: creative.name,
      pageId: input.tracking.pageId,
      instagramActorId: input.tracking.instagramActorId ?? null,
      primaryText: creative.primaryText,
      headline: creative.headline,
      description: creative.description ?? null,
      callToAction: creative.callToAction,
      imageHash: creative.imageHash ?? null,
      videoId: creative.videoId ?? null,
      destinationUrl: buildDestinationUrl({
        baseUrl: input.tracking.destinationBaseUrl,
        launchToken: input.tracking.launchToken,
        tokenParam: input.tracking.launchTokenParam ?? LAUNCH_TOKEN_PARAM,
        utm: { ...baseUtm, content: creative.utmContent ?? creative.key },
      }),
      urlTags: input.tracking.urlTags ?? META_DYNAMIC_URL_TAGS,
      creativeVersionId: creative.creativeVersionId ?? null,
    }),
  );

  const adSets = input.adSets.map((adSet) =>
    draftAdSetSchema.parse({
      key: adSet.key,
      name: adSet.name,
      status: 'PAUSED',
      dailyBudgetMinor: adSet.dailyBudgetMinor ?? null,
      optimizationGoal: adSet.optimizationGoal,
      billingEvent: adSet.billingEvent ?? 'IMPRESSIONS',
      bidStrategy: adSet.bidStrategy ?? null,
      bidAmountMinor: adSet.bidAmountMinor ?? null,
      targeting: draftTargetingSchema.parse({
        countries: adSet.targeting.countries ?? ['DE'],
        ageMin: adSet.targeting.ageMin ?? 25,
        ageMax: adSet.targeting.ageMax ?? 65,
        genders: adSet.targeting.genders ?? [],
        placements: draftPlacementsSchema.parse(adSet.targeting.placements ?? {}),
        extra: adSet.targeting.extra ?? {},
      }),
      pixelId: input.tracking.pixelId,
      customEventType: adSet.customEventType ?? 'LEAD',
      destinationType: adSet.destinationType ?? 'WEBSITE',
      startTime: adSet.startTime,
      endTime: adSet.endTime ?? null,
    }),
  );

  return draftPlanSchema.parse({
    idempotencyKey: input.idempotencyKey,
    apiVersion: input.apiVersion,
    adAccountId: adAccountPath(input.adAccountId),
    currency: input.currency,
    campaign: draftCampaignSchema.parse({
      name: embedMarker
        ? draftNameWithMarker(input.campaign.name, input.idempotencyKey)
        : input.campaign.name,
      objective: input.campaign.objective,
      status: 'PAUSED',
      specialAdCategories: input.campaign.specialAdCategories ?? [],
      buyingType: 'AUCTION',
      bidStrategy: input.campaign.bidStrategy ?? null,
      dailyBudgetMinor: input.campaign.dailyBudgetMinor ?? null,
    }),
    adSets,
    creatives,
    ads: input.ads.map((ad) =>
      draftAdSchema.parse({
        key: ad.key,
        name: ad.name,
        status: 'PAUSED',
        adSetKey: ad.adSetKey,
        creativeKey: ad.creativeKey,
      }),
    ),
    tracking: draftTrackingSchema.parse({
      pixelId: input.tracking.pixelId,
      launchTokenParam: input.tracking.launchTokenParam ?? LAUNCH_TOKEN_PARAM,
      utm: baseUtm,
      campaignId: input.tracking.campaignId ?? null,
      campaignVersionId: input.tracking.campaignVersionId ?? null,
      funnelVersionId: input.tracking.funnelVersionId ?? null,
    }),
    builtAt,
  });
}

/* -------------------------------------------------------------------------- */
/* Graph API payloads                                                          */
/* -------------------------------------------------------------------------- */

function targetingPayload(targeting: DraftTargeting): Record<string, unknown> {
  const placements = targeting.placements;
  const payload: Record<string, unknown> = {
    geo_locations: { countries: [...targeting.countries] },
    age_min: targeting.ageMin,
    age_max: targeting.ageMax,
    publisher_platforms: [...placements.publisherPlatforms],
    device_platforms: [...placements.devicePlatforms],
    ...targeting.extra,
  };
  if (targeting.genders.length > 0) payload.genders = [...targeting.genders];
  if (placements.facebookPositions.length > 0) {
    payload.facebook_positions = [...placements.facebookPositions];
  }
  if (placements.instagramPositions.length > 0) {
    payload.instagram_positions = [...placements.instagramPositions];
  }
  return payload;
}

export function draftCampaignPayload(plan: DraftPlan): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: plan.campaign.name,
    objective: plan.campaign.objective,
    status: plan.campaign.status,
    buying_type: plan.campaign.buyingType,
    special_ad_categories: plan.campaign.specialAdCategories,
  };
  if (plan.campaign.dailyBudgetMinor !== null) {
    payload.daily_budget = String(plan.campaign.dailyBudgetMinor);
  }
  if (plan.campaign.bidStrategy) payload.bid_strategy = plan.campaign.bidStrategy;
  return payload;
}

export function draftAdSetPayload(
  plan: DraftPlan,
  adSet: DraftAdSet,
  campaignExternalId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: adSet.name,
    campaign_id: campaignExternalId,
    status: adSet.status,
    billing_event: adSet.billingEvent,
    optimization_goal: adSet.optimizationGoal,
    targeting: targetingPayload(adSet.targeting),
    promoted_object: { pixel_id: adSet.pixelId, custom_event_type: adSet.customEventType },
    start_time: adSet.startTime,
  };
  if (adSet.dailyBudgetMinor !== null) payload.daily_budget = String(adSet.dailyBudgetMinor);
  if (adSet.endTime) payload.end_time = adSet.endTime;
  if (adSet.bidStrategy) payload.bid_strategy = adSet.bidStrategy;
  if (adSet.bidAmountMinor !== null) payload.bid_amount = String(adSet.bidAmountMinor);
  if (adSet.destinationType) payload.destination_type = adSet.destinationType;
  void plan;
  return payload;
}

export function draftCreativePayload(
  plan: DraftPlan,
  creative: DraftCreative,
): Record<string, unknown> {
  const callToAction = {
    type: creative.callToAction,
    value: { link: creative.destinationUrl },
  };

  const objectStorySpec: Record<string, unknown> = { page_id: creative.pageId };
  if (creative.instagramActorId) objectStorySpec.instagram_actor_id = creative.instagramActorId;

  if (creative.videoId) {
    objectStorySpec.video_data = {
      video_id: creative.videoId,
      message: creative.primaryText,
      title: creative.headline,
      link_description: creative.description ?? undefined,
      call_to_action: callToAction,
    };
  } else {
    objectStorySpec.link_data = {
      link: creative.destinationUrl,
      message: creative.primaryText,
      name: creative.headline,
      description: creative.description ?? undefined,
      image_hash: creative.imageHash ?? undefined,
      call_to_action: callToAction,
    };
  }

  void plan;
  return {
    name: creative.name,
    object_story_spec: objectStorySpec,
    url_tags: creative.urlTags,
  };
}

export function draftAdPayload(
  plan: DraftPlan,
  ad: DraftAd,
  adSetExternalId: string,
  creativeExternalId: string,
): Record<string, unknown> {
  return {
    name: ad.name,
    adset_id: adSetExternalId,
    creative: { creative_id: creativeExternalId },
    status: ad.status,
    tracking_specs: [{ 'action.type': ['offsite_conversion'], fb_pixel: [plan.tracking.pixelId] }],
  };
}

/**
 * Exactly what would be sent, in the order it would be sent. Used verbatim as
 * the `wouldSend` body of the dry-run result so the console preview and the
 * live call can never diverge.
 */
export function draftPlanPreview(plan: DraftPlan): Record<string, unknown> {
  return {
    api_version: plan.apiVersion,
    ad_account: plan.adAccountId,
    idempotency_key: plan.idempotencyKey,
    requests: [
      {
        method: 'POST',
        edge: `${plan.adAccountId}/campaigns`,
        body: draftCampaignPayload(plan),
      },
      ...plan.adSets.map((adSet) => ({
        method: 'POST',
        edge: `${plan.adAccountId}/adsets`,
        body: draftAdSetPayload(plan, adSet, '<campaign_id>'),
      })),
      ...plan.creatives.map((creative) => ({
        method: 'POST',
        edge: `${plan.adAccountId}/adcreatives`,
        body: draftCreativePayload(plan, creative),
      })),
      ...plan.ads.map((ad) => ({
        method: 'POST',
        edge: `${plan.adAccountId}/ads`,
        body: draftAdPayload(plan, ad, '<adset_id>', '<creative_id>'),
      })),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Creation result                                                             */
/* -------------------------------------------------------------------------- */

export interface DraftCreatedObject {
  key: string;
  level: 'CAMPAIGN' | 'ADSET' | 'AD' | 'AD_CREATIVE';
  externalId: string;
  /** Always PAUSED. Read back from the provider response, never assumed. */
  status: 'PAUSED';
  name: string;
}

export interface DraftCreationResult {
  ok: boolean;
  state: 'CREATED' | 'PARTIAL';
  idempotencyKey: string;
  campaign: DraftCreatedObject | null;
  adSets: DraftCreatedObject[];
  creatives: DraftCreatedObject[];
  ads: DraftCreatedObject[];
  createdAt: string;
  errorDe: string | null;
  responseRedacted: unknown;
}

export function allDraftObjects(result: DraftCreationResult): DraftCreatedObject[] {
  return [
    ...(result.campaign ? [result.campaign] : []),
    ...result.adSets,
    ...result.creatives,
    ...result.ads,
  ];
}

/** Acceptance criterion: every created draft object is PAUSED. */
export function assertResultAllPaused(result: DraftCreationResult): void {
  const live = allDraftObjects(result).filter((object) => object.status !== 'PAUSED');
  if (live.length > 0) {
    throw new DomainError('INTERNAL', {
      messageDe: `Meta hat ${live.length} Objekt(e) nicht pausiert angelegt. Der Entwurf wurde abgebrochen.`,
      details: { objects: live.map((o) => o.externalId) },
    });
  }
}

function assertPlanAllPaused(plan: DraftPlan): void {
  const offenders: string[] = [];
  if (plan.campaign.status !== 'PAUSED') offenders.push('campaign');
  for (const adSet of plan.adSets) {
    if (adSet.status !== 'PAUSED') offenders.push(`adset:${adSet.key}`);
  }
  for (const ad of plan.ads) {
    if (ad.status !== 'PAUSED') offenders.push(`ad:${ad.key}`);
  }
  if (offenders.length > 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Ein Meta-Entwurf darf ausschließlich pausierte Objekte enthalten.',
      details: { offenders },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Idempotency store                                                           */
/* -------------------------------------------------------------------------- */

export interface DraftIdempotencyStore {
  get(idempotencyKey: string): Promise<DraftCreationResult | null>;
  put(idempotencyKey: string, result: DraftCreationResult): Promise<void>;
}

export function createInMemoryDraftStore(): DraftIdempotencyStore {
  const entries = new Map<string, DraftCreationResult>();
  return {
    get: async (key) => entries.get(key) ?? null,
    put: async (key, result) => {
      entries.set(key, result);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreatePausedDraftOptions {
  store?: DraftIdempotencyStore;
  /** Ask the provider whether a draft with this key already exists remotely. */
  checkProviderForExisting?: boolean;
}

/**
 * Creates the draft — or explains precisely what it would have created.
 *
 * Order of guards matters: flags first (a dry run must never touch the
 * network), then the local ledger, then the remote lookup. Provider ids are
 * only ever returned from a provider response.
 */
export async function createPausedDraft(
  plan: DraftPlan,
  provider: MetaProvider,
  flags: FeatureFlags,
  options: CreatePausedDraftOptions = {},
): Promise<MutationOutcome<DraftCreationResult>> {
  const validated = draftPlanSchema.parse(plan);
  assertPlanAllPaused(validated);

  if (!canWriteMeta(flags)) {
    return dryRun(
      'META',
      'meta.create_paused_draft_campaign',
      draftPlanPreview(validated),
      'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts angelegt.',
    );
  }

  const store = options.store;
  const existing = store ? await store.get(validated.idempotencyKey) : null;
  if (existing) return existing;

  if (options.checkProviderForExisting !== false) {
    const remote = await provider.findDraftByIdempotencyKey(validated.idempotencyKey);
    if (remote) {
      await store?.put(validated.idempotencyKey, remote);
      return remote;
    }
  }

  const result = await provider.createPausedDraftCampaign(validated);
  if ((result as DryRunResult).dryRun === true) return result;

  const created = result as DraftCreationResult;
  assertResultAllPaused(created);
  await store?.put(validated.idempotencyKey, created);
  return created;
}

/** Redacted, operator-facing summary of what was created. */
export function summarizeDraftResult(result: DraftCreationResult): Record<string, unknown> {
  return redact({
    state: result.state,
    campaign_id: result.campaign?.externalId ?? null,
    ad_set_ids: result.adSets.map((a) => a.externalId),
    creative_ids: result.creatives.map((c) => c.externalId),
    ad_ids: result.ads.map((a) => a.externalId),
    all_paused: allDraftObjects(result).every((o) => o.status === 'PAUSED'),
    error: result.errorDe,
  });
}
