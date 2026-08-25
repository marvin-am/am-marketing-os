import { newId, type TrafficKind } from '@am/domain';

/**
 * First-party visitor and session identity.
 *
 * Everything here is framework-agnostic on purpose: the funnel runtime (a Next
 * route handler or middleware), the console and the job runner all resolve
 * identity the same way, and none of them may import `next/headers` through this
 * package. The caller passes a raw `Cookie` header in and gets `Set-Cookie`
 * strings back.
 *
 * There is no third-party cookie, no fingerprint and no cross-site identifier.
 * A visitor id is a random UUID scoped to our own domain and it never leaves it.
 */

/* -------------------------------------------------------------------------- */
/* Cookie names and attributes                                                 */
/* -------------------------------------------------------------------------- */

/** Long-lived visitor identifier. */
export const VISITOR_COOKIE = 'am_vid';
/** Session identifier plus its start and last-seen timestamps. */
export const SESSION_COOKIE = 'am_sid';
/** Set by the preview deployment; keeps preview traffic out of metrics. */
export const PREVIEW_COOKIE = 'am_preview';
/** Set manually by the team; keeps our own visits out of metrics. */
export const INTERNAL_COOKIE = 'am_internal';
/** Set by E2E runs and load tests. */
export const TEST_COOKIE = 'am_test';

/**
 * Request header the edge sets when it minted the visitor id it is forwarding.
 *
 * Identity is issued at the edge and handed to the route inside the `Cookie`
 * header, which leaves nothing downstream able to tell an id the browser
 * presented from one the edge invented a moment ago. Anything that treats a
 * visitor id as evidence — the rate limiter above all — needs that difference,
 * so the edge states it rather than letting the route guess.
 */
export const MINTED_VISITOR_HEADER = 'x-am-visitor-minted';

/**
 * 400 days. Chrome caps cookie lifetime there, so anything longer is silently
 * truncated — writing the real cap keeps the code honest about what happens.
 */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** A session ends after 30 minutes without activity (spec §18). */
export const SESSION_IDLE_MINUTES = 30;
export const SESSION_IDLE_SECONDS = SESSION_IDLE_MINUTES * 60;

export interface CookieAttributes {
  /** Omit for a host-only cookie, which is the safer default. */
  domain?: string | null;
  /** Off only for plain-HTTP local development. */
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  maxAgeSeconds?: number;
  /**
   * Both identity cookies are HttpOnly. The browser tracker never needs to read
   * them: the server resolves identity per request and hands the ids to the page,
   * which removes a whole class of XSS-driven identity theft.
   */
  httpOnly?: boolean;
}

export function serializeCookie(name: string, value: string, attrs: CookieAttributes = {}): string {
  const {
    domain = null,
    secure = true,
    sameSite = 'Lax',
    path = '/',
    maxAgeSeconds,
    httpOnly = true,
  } = attrs;

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (typeof maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  if (domain) parts.push(`Domain=${domain}`);
  if (httpOnly) parts.push('HttpOnly');
  // SameSite=None is meaningless — and rejected by browsers — without Secure.
  if (secure || sameSite === 'None') parts.push('Secure');
  return parts.join('; ');
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    if (name.length === 0) continue;
    const raw = pair.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Session state                                                               */
/* -------------------------------------------------------------------------- */

export interface SessionState {
  sessionId: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds of the last request seen in this session. */
  lastSeenAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeSessionValue(session: SessionState): string {
  return `${session.sessionId}.${session.startedAt}.${session.lastSeenAt}`;
}

function parseSessionValue(value: string | undefined): SessionState | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, started, lastSeen] = parts as [string, string, string];
  if (!UUID_PATTERN.test(sessionId)) return null;
  const startedAt = Number.parseInt(started, 10);
  const lastSeenAt = Number.parseInt(lastSeen, 10);
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastSeenAt)) return null;
  return { sessionId, startedAt, lastSeenAt };
}

export function buildVisitorCookie(visitorId: string, attrs: CookieAttributes = {}): string {
  return serializeCookie(VISITOR_COOKIE, visitorId, {
    maxAgeSeconds: VISITOR_COOKIE_MAX_AGE_SECONDS,
    ...attrs,
  });
}

export function buildSessionCookie(session: SessionState, attrs: CookieAttributes = {}): string {
  return serializeCookie(SESSION_COOKIE, serializeSessionValue(session), {
    maxAgeSeconds: SESSION_IDLE_SECONDS,
    ...attrs,
  });
}

export interface ParsedVisitorCookies {
  visitorId: string | null;
  session: SessionState | null;
}

/** Reads both identity cookies out of a raw `Cookie` header. */
export function parseVisitorCookie(cookieHeader: string | null | undefined): ParsedVisitorCookies {
  const cookies = parseCookieHeader(cookieHeader);
  const visitorId = cookies[VISITOR_COOKIE];
  return {
    visitorId: visitorId && UUID_PATTERN.test(visitorId) ? visitorId : null,
    session: parseSessionValue(cookies[SESSION_COOKIE]),
  };
}

/** Clears both identity cookies, e.g. on an opt-out request. */
export function buildIdentityClearCookies(attrs: CookieAttributes = {}): string[] {
  return [
    serializeCookie(VISITOR_COOKIE, '', { ...attrs, maxAgeSeconds: 0 }),
    serializeCookie(SESSION_COOKIE, '', { ...attrs, maxAgeSeconds: 0 }),
  ];
}

export interface ResolveVisitorInput {
  cookieHeader?: string | null;
  now: Date;
  /** Cookie attributes to apply to the returned `Set-Cookie` strings. */
  cookieAttributes?: CookieAttributes;
  /** Test seam. */
  generateId?: () => string;
  idleMinutes?: number;
}

export interface ResolvedVisitor {
  visitorId: string;
  sessionId: string;
  /** True when this request created the visitor id. */
  isNew: boolean;
  /** True when this request started a new session (first visit or 30 min idle). */
  isNewSession: boolean;
  session: SessionState;
  /** Emit these on the response; both are refreshed on every request. */
  setCookies: string[];
}

/**
 * Resolves — and rolls forward — visitor and session identity.
 *
 * The session window slides: every request extends it by another 30 minutes of
 * inactivity. A returning visitor after a longer gap keeps their `visitorId`
 * (so return visits stay attributable and experiment arms stay stable) but
 * starts a fresh `sessionId`.
 */
export function resolveVisitor(input: ResolveVisitorInput): ResolvedVisitor {
  const nowMs = input.now.getTime();
  const generateId = input.generateId ?? (() => newId());
  const idleMs = (input.idleMinutes ?? SESSION_IDLE_MINUTES) * 60_000;
  const { visitorId: existingVisitorId, session: existingSession } = parseVisitorCookie(
    input.cookieHeader,
  );

  const visitorId = existingVisitorId ?? generateId();
  const isNew = existingVisitorId === null;

  const sessionExpired =
    existingSession === null || nowMs - existingSession.lastSeenAt >= idleMs;

  const session: SessionState = sessionExpired
    ? { sessionId: generateId(), startedAt: nowMs, lastSeenAt: nowMs }
    : { ...(existingSession as SessionState), lastSeenAt: nowMs };

  return {
    visitorId,
    sessionId: session.sessionId,
    isNew,
    isNewSession: sessionExpired,
    session,
    setCookies: [
      buildVisitorCookie(visitorId, input.cookieAttributes),
      buildSessionCookie(session, input.cookieAttributes),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Traffic classification                                                      */
/* -------------------------------------------------------------------------- */

/**
 * User-agent substrings that identify automated traffic. Matched
 * case-insensitively against the raw UA.
 *
 * This list is the difference between a conversion rate and a fiction: an
 * unfiltered funnel gets 10-30 % of its "sessions" from crawlers, link
 * previewers and uptime monitors, all of which view pages and none of which
 * ever convert.
 */
export const BOT_USER_AGENT_TOKENS: readonly string[] = [
  // Generic self-declarations
  'bot',
  'crawler',
  'crawling',
  'spider',
  'scraper',
  'slurp',
  'archiver',
  'feedfetcher',
  // Search engines
  'googlebot',
  'google-inspectiontool',
  'google-extended',
  'apis-google',
  'mediapartners-google',
  'adsbot',
  'bingbot',
  'bingpreview',
  'msnbot',
  'duckduckbot',
  'yandex',
  'baiduspider',
  'sogou',
  'exabot',
  'seznambot',
  'petalbot',
  'applebot',
  // Social / messenger link previewers
  'facebookexternalhit',
  'facebookcatalog',
  'facebot',
  'meta-externalagent',
  'meta-externalfetcher',
  'twitterbot',
  'linkedinbot',
  'pinterest',
  'redditbot',
  'slackbot',
  'discordbot',
  'telegrambot',
  'whatsapp',
  'skypeuripreview',
  'embedly',
  'quora link preview',
  // SEO / marketing crawlers
  'ahrefsbot',
  'semrushbot',
  'mj12bot',
  'dotbot',
  'dataforseo',
  'screaming frog',
  'sitebulb',
  'serpstatbot',
  // AI crawlers
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'claudebot',
  'claude-web',
  'anthropic-ai',
  'perplexitybot',
  'ccbot',
  'bytespider',
  'amazonbot',
  'applebot-extended',
  'diffbot',
  // Monitoring / performance
  'uptimerobot',
  'pingdom',
  'statuscake',
  'site24x7',
  'newrelicpinger',
  'lighthouse',
  'pagespeed',
  'gtmetrix',
  'webpagetest',
  // Automation frameworks and HTTP clients
  'headlesschrome',
  'headless',
  'phantomjs',
  'puppeteer',
  'playwright',
  'selenium',
  'webdriver',
  'cypress',
  'curl/',
  'wget',
  'python-requests',
  'python-urllib',
  'aiohttp',
  'scrapy',
  'httpclient',
  'okhttp',
  'go-http-client',
  'java/',
  'libwww-perl',
  'axios/',
  'node-fetch',
  'got (',
  'postman',
  'insomnia',
  'httpie',
];

/** Shortest plausible real browser UA. Anything shorter is tooling. */
const MIN_HUMAN_UA_LENGTH = 20;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // A real browser always sends one.
  const ua = userAgent.toLowerCase().trim();
  if (ua.length < MIN_HUMAN_UA_LENGTH) return true;
  return BOT_USER_AGENT_TOKENS.some((token) => ua.includes(token));
}

/** Headless signals that survive a spoofed user-agent string. */
export interface HeadlessSignals {
  /** `navigator.webdriver`, reported by the client. */
  webdriver?: boolean;
  /** `Sec-CH-UA` / `Sec-Fetch-*` headers absent on most automation stacks. */
  hasSecFetchHeaders?: boolean;
  /** `Accept-Language` is absent on nearly every headless default profile. */
  hasAcceptLanguage?: boolean;
}

export interface ClassifyTrafficInput {
  userAgent?: string | null;
  /** The deployment knows it is a preview build. */
  isPreview?: boolean;
  /** The request carries an internal marker (VPN, staff cookie, admin session). */
  isInternal?: boolean;
  cookieHeader?: string | null;
  /** Preview deployments live on generated hostnames. */
  host?: string | null;
  headless?: HeadlessSignals;
}

function cookieFlag(cookies: Record<string, string>, name: string): boolean {
  const value = cookies[name];
  return value === '1' || value === 'true';
}

/**
 * Decides which bucket a request belongs to. Only `PRODUCTION` ever reaches a
 * rollup, a metric or an experiment.
 *
 * Order matters and is deliberate: a crawler hitting a preview deployment is
 * still a bot, and an internal user is still internal even on production.
 */
export function classifyTraffic(input: ClassifyTrafficInput): TrafficKind {
  const cookies = parseCookieHeader(input.cookieHeader);

  if (isBotUserAgent(input.userAgent)) return 'BOT';
  if (input.headless?.webdriver === true) return 'BOT';
  if (input.headless?.hasSecFetchHeaders === false && input.headless?.hasAcceptLanguage === false) {
    return 'BOT';
  }

  if (cookieFlag(cookies, TEST_COOKIE)) return 'TEST';

  if (input.isPreview === true || cookieFlag(cookies, PREVIEW_COOKIE) || isPreviewHost(input.host)) {
    return 'PREVIEW';
  }

  if (input.isInternal === true || cookieFlag(cookies, INTERNAL_COOKIE)) return 'INTERNAL';

  return 'PRODUCTION';
}

/** Hostnames that are structurally never production. */
export function isPreviewHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase().split(':')[0] ?? '';
  return (
    normalized.endsWith('.vercel.app') ||
    normalized.startsWith('preview.') ||
    normalized.startsWith('staging.') ||
    normalized === 'localhost' ||
    normalized === '127.0.0.1'
  );
}

export function isProductionTraffic(kind: TrafficKind): boolean {
  return kind === 'PRODUCTION';
}

export const TRAFFIC_KIND_LABELS_DE: Readonly<Record<TrafficKind, string>> = {
  PRODUCTION: 'Produktiv',
  PREVIEW: 'Vorschau',
  INTERNAL: 'Intern',
  BOT: 'Bot',
  TEST: 'Test',
};
