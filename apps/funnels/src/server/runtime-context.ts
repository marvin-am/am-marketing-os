import { getAppConfig } from '@am/config';
import type {
  AppEnvironment,
  MarketingParams,
  Touchpoint,
  TrackingContext,
  TrafficKind,
} from '@am/domain';
import {
  classifyTraffic,
  deterministicUuid,
  getLaunchTokenSecret,
  LAUNCH_TOKEN_PARAM,
  parseCookieHeader,
  parseLandingUrl,
  resolveTouch,
  resolveVisitor,
  trackingContextFromToken,
  verifyLaunchToken,
  type CookieAttributes,
  type ResolvedVisitor,
} from '@am/tracking';

/**
 * One request, resolved once.
 *
 * Identity, traffic classification and the trusted/untrusted split of the
 * landing URL all have to agree across the page render, the collector and the
 * submit handler. Doing them in three places is how a visitor ends up counted
 * as PRODUCTION on the page and BOT in the event stream, so they are done here
 * and nowhere else.
 *
 * Deliberately free of `next/headers`: the funnel runtime calls it from a
 * server component, from a route handler and from tests, and only the first two
 * have a request context to read.
 */

export interface RuntimeContextInput {
  cookieHeader: string | null;
  userAgent: string | null;
  host: string | null;
  /** Absolute URL of the request, used for the trusted/untrusted split. */
  url: string;
  referer: string | null;
  acceptLanguage: string | null;
  secFetchSite: string | null;
  /** True for `/preview/...`, which is never production traffic. */
  isPreviewRoute?: boolean;
  /**
   * True when the edge minted the visitor id it is forwarding in the cookie
   * header. Only the edge can tell — see `MINTED_VISITOR_HEADER`.
   */
  visitorMintedAtEdge?: boolean;
  now?: Date;
  /** Test seam for cookie issuing. */
  generateId?: () => string;
}

export interface RuntimeContext {
  visitor: ResolvedVisitor;
  visitorId: string;
  /**
   * True when `visitorId` came out of a cookie the browser sent, false when it
   * was minted for this request — here or at the edge, which forwards what it
   * minted in the cookie header. Weak evidence, since the cookie is unsigned,
   * but it is the difference between a browser we have seen before and a caller
   * that sent nothing, and only the former may select a bucket of its own.
   */
  visitorPresented: boolean;
  sessionId: string;
  trafficKind: TrafficKind;
  environment: AppEnvironment;
  /** Internal ids recovered from a verified launch token. Trusted. */
  trusted: TrackingContext;
  /** Query parameters observed on the landing URL. Reporting only. */
  marketingParams: MarketingParams;
  landingUrl: string;
  referrer: string | null;
  /** Raw launch token as it appeared on the URL, or `null`. */
  token: string | null;
  tokenPresent: boolean;
  tokenValid: boolean;
  /** `Set-Cookie` values to emit when the caller can set headers. */
  setCookies: string[];
  now: Date;
}

/** Host-only, HttpOnly, SameSite=Lax. No third-party cookie is ever set. */
export function cookieAttributes(host: string | null): CookieAttributes {
  const isLocal =
    host === null || host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return { secure: !isLocal, sameSite: 'Lax', path: '/', httpOnly: true };
}

export function resolveRuntimeContext(input: RuntimeContextInput): RuntimeContext {
  const now = input.now ?? new Date();

  const visitor = resolveVisitor({
    cookieHeader: input.cookieHeader,
    now,
    cookieAttributes: cookieAttributes(input.host),
    generateId: input.generateId,
  });

  const trafficKind = classifyTraffic({
    userAgent: input.userAgent,
    cookieHeader: input.cookieHeader,
    host: input.host,
    isPreview: input.isPreviewRoute === true,
    headless: {
      hasSecFetchHeaders: input.secFetchSite !== null,
      hasAcceptLanguage: input.acceptLanguage !== null,
    },
  });

  const secret = getLaunchTokenSecret();
  const landing = parseLandingUrl(input.url, { secret, now });

  /*
   * The launch token rides on the landing URL, which the collector and the
   * submit endpoint never see. Middleware therefore copies a token it observes
   * into a first-party HttpOnly cookie, and every later request re-verifies it
   * here. Carrying the token rather than the decoded ids is what keeps the trust
   * rule intact: a cookie the browser could edit would be an untrusted claim,
   * a signed token is not.
   */
  let trusted = landing.trusted;
  let token = landing.token;
  let tokenValid = landing.tokenValid;

  if (!landing.tokenValid) {
    const carried = parseCookieHeader(input.cookieHeader)[LAUNCH_TOKEN_PARAM];
    if (carried) {
      const verified = verifyLaunchToken(carried, secret, { now });
      if (verified.ok) {
        trusted = trackingContextFromToken(verified.value);
        token = carried;
        tokenValid = true;
      }
    }
  }

  return {
    visitor,
    visitorId: visitor.visitorId,
    visitorPresented: !visitor.isNew && input.visitorMintedAtEdge !== true,
    sessionId: visitor.sessionId,
    trafficKind,
    environment: getAppConfig().environment,
    trusted,
    marketingParams: landing.marketingParams,
    landingUrl: landing.landingUrl,
    referrer: input.referer,
    token,
    tokenPresent: landing.tokenPresent || token !== null,
    tokenValid,
    setCookies: visitor.setCookies,
    now,
  };
}

/**
 * The touch this visit represents.
 *
 * The internal ids come exclusively from the verified token; the marketing
 * parameters ride along as reporting data and are never promoted into ids. A
 * visit with nothing identifying it resolves to DIRECT/UNKNOWN rather than to
 * whichever campaign happened to be running.
 */
export function touchFor(context: RuntimeContext): Touchpoint {
  return resolveTouch({
    /* Deterministic id: a server component may render more than once per
       request, and a random id would turn one visit into several touches — which
       would then show up as several "influenced" touches in the snapshot. */
    id: deterministicUuid(
      'touch',
      `${context.visitorId}:${context.sessionId}:${context.landingUrl}`,
    ),
    visitorId: context.visitorId,
    sessionId: context.sessionId,
    occurredAt: context.now.toISOString(),
    token: context.token,
    secret: getLaunchTokenSecret(),
    marketingParams: context.marketingParams,
    referrer: context.referrer,
    landingUrl: context.landingUrl,
    role: context.visitor.isNewSession ? 'FIRST' : 'INFLUENCED',
    now: context.now,
  });
}
