import {
  attributionSnapshotSchema,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  isTrustworthy,
  newId,
  resolveConfidence,
  touchpointSchema,
  type AttributionSignals,
  type AttributionSnapshot,
  type Channel,
  type ConsentStatus,
  type MarketingParams,
  type Touchpoint,
  type TouchRole,
  type TrackingContext,
} from '@am/domain';
import {
  emptyMarketingParams,
  emptyTrackingContext,
  trackingContextFromToken,
  verifyLaunchToken,
  type LaunchTokenPayload,
} from './tokens';

/**
 * Attribution resolution.
 *
 * Two rules govern everything below.
 *
 * 1. **Never guess.** When nothing identifies the source of a visit, the answer
 *    is `DIRECT`/`UNKNOWN`. A plausible-looking guess is worse than an admitted
 *    gap, because a gap gets investigated and a guess gets budgeted against.
 * 2. **Temporal proximity is not evidence.** "The lead arrived while campaign X
 *    was running" is the single most common source of fabricated attribution in
 *    ad reporting; here it can only ever reach LOW_CONFIDENCE, and only when
 *    there is no other signal at all.
 */

/* -------------------------------------------------------------------------- */
/* Host and parameter vocabularies                                             */
/* -------------------------------------------------------------------------- */

const META_HOSTS: readonly string[] = [
  'facebook.com',
  'instagram.com',
  'messenger.com',
  'threads.net',
  'threads.com',
  'fb.me',
  'fb.watch',
  'fbcdn.net',
];

const OTHER_SOCIAL_HOSTS: readonly string[] = [
  'linkedin.com',
  'lnkd.in',
  'twitter.com',
  'x.com',
  't.co',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'pinterest.com',
  'reddit.com',
  'xing.com',
  'snapchat.com',
];

const SEARCH_HOSTS: readonly string[] = [
  'bing.com',
  'duckduckgo.com',
  'ecosia.org',
  'yahoo.com',
  'startpage.com',
  'qwant.com',
  'search.brave.com',
  'baidu.com',
  'yandex.com',
  'yandex.ru',
];

const MAIL_HOSTS: readonly string[] = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'web.de',
  'gmx.net',
  'gmx.de',
  't-online.de',
];

const GOOGLE_SEARCH_PATTERN = /^(?:www\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/;

const META_SOURCES: readonly string[] = [
  'facebook',
  'facebook_ads',
  'facebookads',
  'fb',
  'fb_ads',
  'ig',
  'instagram',
  'instagram_ads',
  'meta',
  'meta_ads',
  'messenger',
];

const GOOGLE_SOURCES: readonly string[] = ['google', 'google_ads', 'googleads', 'adwords'];

const PAID_MEDIUMS: readonly string[] = [
  'cpc',
  'ppc',
  'cpm',
  'cpv',
  'paid',
  'paidsocial',
  'paid_social',
  'paid-social',
  'paidsearch',
  'paid_search',
  'display',
  'retargeting',
  'remarketing',
];

const EMAIL_MEDIUMS: readonly string[] = ['email', 'e-mail', 'e_mail', 'newsletter', 'mail'];

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesHost(host: string | null, domains: readonly string[]): boolean {
  if (!host) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isSearchHost(host: string | null): boolean {
  if (!host) return false;
  return GOOGLE_SEARCH_PATTERN.test(host) || matchesHost(host, SEARCH_HOSTS);
}

function normalizeParam(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function hasQueryParam(url: string | null | undefined, name: string): boolean {
  if (!url) return false;
  try {
    const value = new URL(url).searchParams.get(name);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}

export function isMetaReferrer(referrer: string | null | undefined): boolean {
  return matchesHost(hostOf(referrer), META_HOSTS);
}

/* -------------------------------------------------------------------------- */
/* Touch resolution                                                            */
/* -------------------------------------------------------------------------- */

export interface ResolveTouchInput {
  visitorId: string;
  sessionId: string;
  /** ISO-8601 timestamp of the visit. */
  occurredAt: string;
  /** A verified payload, or the raw token plus `secret` so it can be verified. */
  token?: string | LaunchTokenPayload | null;
  secret?: string | null;
  /** Untrusted query parameters. Reporting only. */
  marketingParams?: Partial<MarketingParams> | null;
  referrer?: string | null;
  landingUrl?: string | null;
  role?: TouchRole;
  id?: string;
  /**
   * A marketing parameter that is known — through a stored mapping, not a
   * guess — to identify exactly one internal campaign version.
   */
  uniqueCampaignParam?: boolean;
  /**
   * The visit merely overlaps in time with a running campaign. Never sufficient
   * on its own; see `resolveConfidence` in `@am/domain`.
   */
  temporalProximity?: boolean;
  /** Verification clock, for expiry checks. */
  now?: Date;
}

interface ResolvedToken {
  payload: LaunchTokenPayload | null;
  context: TrackingContext;
  valid: boolean;
}

function resolveToken(input: ResolveTouchInput): ResolvedToken {
  const empty: ResolvedToken = { payload: null, context: emptyTrackingContext(), valid: false };
  if (!input.token) return empty;

  if (typeof input.token === 'string') {
    const verified = verifyLaunchToken(input.token, input.secret ?? null, { now: input.now });
    if (!verified.ok) return empty;
    return {
      payload: verified.value,
      context: trackingContextFromToken(verified.value),
      valid: true,
    };
  }

  return {
    payload: input.token,
    context: trackingContextFromToken(input.token),
    valid: true,
  };
}

function hasAnyId(context: TrackingContext): boolean {
  return Object.values(context).some((value) => value !== null);
}

export interface TouchSignalInput {
  hasSignedToken: boolean;
  marketingParams: MarketingParams;
  referrer: string | null;
  landingUrl: string | null;
  uniqueCampaignParam?: boolean;
  temporalProximity?: boolean;
}

/** The evidence behind a touch, kept separate so the console can explain it. */
export function resolveTouchSignals(input: TouchSignalInput): AttributionSignals {
  const params = input.marketingParams;
  const hasClickId =
    Boolean(params.fbclid) || Boolean(params.fbc) || hasQueryParam(input.landingUrl, 'gclid');

  const hasGenericUtm = Boolean(
    params.utm_source || params.utm_medium || params.utm_campaign || params.utm_content,
  );

  const hasUniqueCampaignParam =
    input.uniqueCampaignParam === true ||
    [params.utm_campaign, params.utm_content, params.utm_term].some(
      (value) => typeof value === 'string' && UUID_IN_TEXT.test(value),
    );

  const hasMetaReferrer = isMetaReferrer(input.referrer);

  const hasOtherSignal =
    input.hasSignedToken || hasClickId || hasUniqueCampaignParam || hasGenericUtm || hasMetaReferrer;

  return {
    hasSignedToken: input.hasSignedToken,
    hasClickId,
    hasUniqueCampaignParam,
    hasGenericUtm,
    hasMetaReferrer,
    hasTemporalProximityOnly: input.temporalProximity === true && !hasOtherSignal,
  };
}

/**
 * Maps signals onto a channel. Paid classification requires a click id, a signed
 * token or an explicitly paid medium — a `utm_source=facebook` on its own is
 * organic social, not a paid click.
 */
export function resolveChannel(input: TouchSignalInput): Channel {
  const params = input.marketingParams;
  const source = normalizeParam(params.utm_source);
  const medium = normalizeParam(params.utm_medium);
  const referrerHost = hostOf(input.referrer);
  const landingHost = hostOf(input.landingUrl);

  if (input.hasSignedToken) return 'META_PAID';
  if (params.fbclid || params.fbc) return 'META_PAID';
  if (hasQueryParam(input.landingUrl, 'gclid')) return 'GOOGLE_PAID';

  const paidMedium = PAID_MEDIUMS.includes(medium);
  const emailMedium = EMAIL_MEDIUMS.includes(medium);

  if (META_SOURCES.includes(source)) {
    if (paidMedium) return 'META_PAID';
    if (emailMedium) return 'EMAIL';
    return 'ORGANIC_SOCIAL';
  }
  if (GOOGLE_SOURCES.includes(source)) {
    return paidMedium ? 'GOOGLE_PAID' : 'ORGANIC_SEARCH';
  }
  if (emailMedium) return 'EMAIL';
  if (medium === 'referral') return 'REFERRAL';
  if (medium === 'organic') return 'ORGANIC_SEARCH';
  if (medium === 'social') return 'ORGANIC_SOCIAL';

  if (referrerHost) {
    // An internal referrer is not a new acquisition — the visitor was already here.
    if (landingHost && referrerHost === landingHost) return 'DIRECT';
    if (matchesHost(referrerHost, META_HOSTS)) return 'ORGANIC_SOCIAL';
    if (matchesHost(referrerHost, OTHER_SOCIAL_HOSTS)) return 'ORGANIC_SOCIAL';
    if (isSearchHost(referrerHost)) return 'ORGANIC_SEARCH';
    if (matchesHost(referrerHost, MAIL_HOSTS)) return 'EMAIL';
    return 'REFERRAL';
  }

  // No referrer and nothing usable in the query string.
  if (!source && !medium && !params.utm_campaign && !params.utm_content) return 'DIRECT';
  return 'UNKNOWN';
}

/**
 * Builds a single touchpoint out of one landing.
 *
 * The internal ids on the touch come exclusively from the verified token. The
 * marketing parameters ride along beside them and are never promoted into ids.
 */
export function resolveTouch(input: ResolveTouchInput): Touchpoint {
  const token = resolveToken(input);
  const marketingParams: MarketingParams = {
    ...emptyMarketingParams(),
    ...Object.fromEntries(
      Object.entries(input.marketingParams ?? {}).filter(([, value]) => value != null),
    ),
  };

  const signalInput: TouchSignalInput = {
    hasSignedToken: token.valid && hasAnyId(token.context),
    marketingParams,
    referrer: input.referrer ?? null,
    landingUrl: input.landingUrl ?? null,
    uniqueCampaignParam: input.uniqueCampaignParam,
    temporalProximity: input.temporalProximity,
  };

  const signals = resolveTouchSignals(signalInput);

  return touchpointSchema.parse({
    id: input.id ?? newId(),
    visitor_id: input.visitorId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    channel: resolveChannel(signalInput),
    role: input.role ?? 'INFLUENCED',
    confidence: resolveConfidence(signals),
    from_signed_token: signalInput.hasSignedToken,
    ...token.context,
    ...marketingParams,
    referrer: input.referrer ?? null,
    landing_url: input.landingUrl ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A touch counts as acquisition only when it is paid Meta traffic *and* it is
 * uniquely identified — a signed token, a click id or a 1:1 campaign parameter.
 * A merely plausible Meta touch never acquires; it stays influential.
 */
export function isUniquelyIdentifiedPaidMeta(touch: Touchpoint): boolean {
  return touch.channel === 'META_PAID' && (touch.from_signed_token || touch.confidence === 'EXACT');
}

const DAY_MS = 86_400_000;

export interface TouchWindow {
  now: Date;
  windowDays?: number;
}

/** Touches inside the window and not in the future, oldest first. */
export function touchesInWindow(
  touches: readonly Touchpoint[],
  window: TouchWindow,
): Touchpoint[] {
  const nowMs = window.now.getTime();
  const windowMs = (window.windowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS) * DAY_MS;
  return touches
    .filter((touch) => {
      const at = Date.parse(touch.occurred_at);
      if (!Number.isFinite(at)) return false;
      return at <= nowMs && nowMs - at <= windowMs;
    })
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
}

/**
 * The acquisition touch: the *last* uniquely identified paid-Meta touch inside
 * the window before the accepted submission. Last, not first — the click that
 * actually brought the lead in is the one that closed the loop; an earlier click
 * from a different campaign stays in `influenced_touch_ids`.
 */
export function selectAcquisitionTouch(
  touches: readonly Touchpoint[],
  window: TouchWindow,
): Touchpoint | null {
  const candidates = touchesInWindow(touches, window).filter(isUniquelyIdentifiedPaidMeta);
  return candidates.length > 0 ? (candidates[candidates.length - 1] as Touchpoint) : null;
}

export interface BuildAttributionSnapshotInput {
  submissionId: string;
  touches: readonly Touchpoint[];
  windowDays?: number;
  consent?: ConsentStatus | { status: ConsentStatus } | null;
  /** Time of the accepted submission. */
  now: Date;
  id?: string;
}

function normalizeConsent(consent: BuildAttributionSnapshotInput['consent']): ConsentStatus {
  if (!consent) return 'UNKNOWN';
  return typeof consent === 'string' ? consent : consent.status;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Freezes attribution at submit.
 *
 * Everything downstream — CRM sync, CAPI dispatch, revenue reporting — reads
 * this snapshot rather than re-deriving attribution later, so a campaign's
 * numbers cannot silently change months after the fact when a touch is added,
 * a mapping is corrected or the window is reconfigured.
 */
export function buildAttributionSnapshot(
  input: BuildAttributionSnapshotInput,
): AttributionSnapshot {
  const windowDays = input.windowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS;
  const window: TouchWindow = { now: input.now, windowDays };
  const inWindow = touchesInWindow(input.touches, window);

  const firstTouch = inWindow[0] ?? null;
  const lastTouch = inWindow[inWindow.length - 1] ?? null;
  const acquisition = selectAcquisitionTouch(inWindow, window);

  // Internal ids are only ever carried by the acquisition touch, because only a
  // uniquely identified paid touch has trustworthy ids to carry.
  const context: TrackingContext = acquisition
    ? extractContext(acquisition)
    : emptyTrackingContext();

  const reference = acquisition ?? lastTouch;
  const marketingParams: MarketingParams = reference
    ? extractMarketingParams(reference)
    : emptyMarketingParams();

  const daysToConversion = acquisition
    ? Math.round(((input.now.getTime() - Date.parse(acquisition.occurred_at)) / DAY_MS) * 100) / 100
    : null;

  const snapshot = attributionSnapshotSchema.parse({
    id: input.id ?? newId(),
    submission_id: input.submissionId,
    created_at: input.now.toISOString(),
    ...context,
    first_touch: firstTouch,
    last_touch: lastTouch,
    acquisition_touch: acquisition,
    influenced_touch_ids: inWindow
      .filter((touch) => touch.id !== acquisition?.id)
      .map((touch) => touch.id),
    ...marketingParams,
    referrer: reference?.referrer ?? null,
    landing_url: reference?.landing_url ?? null,
    // No match is reported as DIRECT/UNKNOWN rather than attributed to the
    // campaign that happened to be running.
    channel: acquisition?.channel ?? lastTouch?.channel ?? 'DIRECT',
    level: resolveLevel(acquisition, inWindow.length),
    confidence: acquisition?.confidence ?? lastTouch?.confidence ?? 'UNKNOWN',
    consent_status: normalizeConsent(input.consent),
    days_to_conversion: daysToConversion,
    window_days: windowDays,
  });

  return deepFreeze(snapshot);
}

function resolveLevel(
  acquisition: Touchpoint | null,
  inWindowCount: number,
): AttributionSnapshot['level'] {
  if (acquisition && (acquisition.campaign_version_id || acquisition.creative_version_id)) {
    return 'LEAD_LINKED';
  }
  if (inWindowCount > 0) return 'TRAFFIC_LINKED';
  return 'CREATIVE_ONLY';
}

function extractContext(touch: Touchpoint): TrackingContext {
  const context = emptyTrackingContext();
  for (const key of Object.keys(context) as (keyof TrackingContext)[]) {
    context[key] = touch[key];
  }
  return context;
}

function extractMarketingParams(touch: Touchpoint): MarketingParams {
  const params = emptyMarketingParams();
  for (const key of Object.keys(params) as (keyof MarketingParams)[]) {
    params[key] = touch[key];
  }
  return params;
}

/** May this snapshot back a revenue claim without a caveat in the UI? */
export function isSnapshotTrustworthy(snapshot: AttributionSnapshot): boolean {
  return isTrustworthy(snapshot.confidence);
}

/* -------------------------------------------------------------------------- */
/* Preservation                                                                */
/* -------------------------------------------------------------------------- */

export type PreserveAcquisitionOutcome = 'PRESERVED' | 'BACKFILLED' | 'IGNORED';

export interface PreserveAcquisitionResult {
  snapshot: AttributionSnapshot;
  changed: boolean;
  outcome: PreserveAcquisitionOutcome;
  reasonDe: string;
}

/**
 * Guards an existing snapshot against later visits.
 *
 * A visitor who comes back a week later — directly, via a newsletter, via a
 * second ad — must not rewrite which campaign acquired them. Once an
 * acquisition touch exists it is final: the function returns the *same object*,
 * not a copy, so a caller cannot accidentally persist a mutated version.
 *
 * The one permitted write is a backfill: a snapshot that never had an
 * acquisition touch may receive one from a qualifying touch that occurred
 * *before* the submission and inside the window — late-arriving evidence about
 * the past, not a new visit overwriting history.
 */
export function preserveAcquisition(
  existingSnapshot: AttributionSnapshot,
  newTouch: Touchpoint,
): PreserveAcquisitionResult {
  if (existingSnapshot.acquisition_touch !== null) {
    return {
      snapshot: existingSnapshot,
      changed: false,
      outcome: 'PRESERVED',
      reasonDe: 'Die bestehende Akquise-Zuordnung bleibt unverändert.',
    };
  }

  const createdAtMs = Date.parse(existingSnapshot.created_at);
  const touchMs = Date.parse(newTouch.occurred_at);
  const windowMs = existingSnapshot.window_days * DAY_MS;
  const qualifies =
    isUniquelyIdentifiedPaidMeta(newTouch) &&
    Number.isFinite(touchMs) &&
    touchMs < createdAtMs &&
    createdAtMs - touchMs <= windowMs;

  if (!qualifies) {
    return {
      snapshot: existingSnapshot,
      changed: false,
      outcome: 'IGNORED',
      reasonDe:
        'Der Touchpoint erfüllt die Voraussetzungen für eine Akquise-Zuordnung nicht und wurde nicht übernommen.',
    };
  }

  const snapshot = attributionSnapshotSchema.parse({
    ...existingSnapshot,
    ...extractContext(newTouch),
    acquisition_touch: newTouch,
    influenced_touch_ids: existingSnapshot.influenced_touch_ids.filter((id) => id !== newTouch.id),
    ...extractMarketingParams(newTouch),
    referrer: newTouch.referrer,
    landing_url: newTouch.landing_url,
    channel: newTouch.channel,
    level: resolveLevel(newTouch, 1),
    confidence: newTouch.confidence,
    days_to_conversion: Math.round(((createdAtMs - touchMs) / DAY_MS) * 100) / 100,
  });

  return {
    snapshot: deepFreeze(snapshot),
    changed: true,
    outcome: 'BACKFILLED',
    reasonDe: 'Die fehlende Akquise-Zuordnung wurde aus einem früheren Touchpoint ergänzt.',
  };
}
