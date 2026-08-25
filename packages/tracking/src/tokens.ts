import { LAUNCH_TOKEN_PARAM } from '@am/domain';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getServerEnv } from '@am/config';
import {
  DomainError,
  err,
  marketingParamsSchema,
  ok,
  trackingContextSchema,
  type MarketingParams,
  type Result,
  type TrackingContext,
} from '@am/domain';

/**
 * Signed launch tokens.
 *
 * The Meta ad URL carries one compact, server-signed token. It encodes the
 * internal identifiers of exactly the versions that were published — campaign,
 * angle, offer, creative, funnel, form and experiment — so that a click can be
 * resolved back to what was actually delivered, without a lookup table and
 * without trusting anything the browser sends.
 *
 * The trust rule that everything else in this package depends on:
 *
 *   - Values recovered from a *valid* token are **trusted**. They were minted by
 *     this server, signed with a secret the browser never sees, and cannot be
 *     forged by editing the URL.
 *   - Values read from query parameters (`utm_*`, `fbclid`, …) are **untrusted**.
 *     They are stored verbatim for reporting and may *never* overwrite a trusted
 *     id. Anyone can put `utm_campaign=…` on a URL; treating that as an internal
 *     id would let a stray link rewrite attribution for a whole campaign.
 *
 * Signing and verification are deliberately server-only (`node:crypto`): the
 * signing secret must never reach a client bundle.
 */

/* -------------------------------------------------------------------------- */
/* Format                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Token version prefix. Bumped whenever the payload encoding changes; an
 * unknown version is rejected rather than parsed optimistically, so an old
 * verifier can never mis-read a new payload.
 */
export const LAUNCH_TOKEN_VERSION = 'v1';

/** Query parameter that carries the token on a landing URL. */
export { LAUNCH_TOKEN_PARAM };

/**
 * Default lifetime: 180 days. The token has to outlive the campaign — an
 * expired token degrades a click to untrusted marketing parameters instead of
 * breaking the landing page, so a generous window costs nothing while a short
 * one silently destroys attribution on long-running evergreen ads.
 */
export const DEFAULT_LAUNCH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180;

/** Minimum acceptable signing secret length (HMAC-SHA256 key material). */
export const MIN_SIGNING_SECRET_LENGTH = 16;

export const launchTokenPayloadSchema = trackingContextSchema.extend({
  /** Unix seconds at which the token was minted. */
  issued_at: z.number().int().nonnegative(),
  /** Unix seconds after which the token is no longer trusted. */
  expires_at: z.number().int().nonnegative(),
});
export type LaunchTokenPayload = z.infer<typeof launchTokenPayloadSchema>;

/** What a caller supplies when minting: any subset of the internal ids. */
export type LaunchTokenInput = Partial<TrackingContext> & {
  issued_at?: number;
  expires_at?: number;
};

export type LaunchTokenRejection =
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'SIGNATURE_MISMATCH'
  | 'PAYLOAD_INVALID'
  | 'EXPIRED'
  | 'MISSING_SECRET';

const REJECTION_MESSAGES_DE: Readonly<Record<LaunchTokenRejection, string>> = {
  MALFORMED: 'Das Tracking-Token hat ein ungültiges Format.',
  UNSUPPORTED_VERSION: 'Das Tracking-Token stammt aus einer nicht unterstützten Version.',
  SIGNATURE_MISMATCH: 'Die Signatur des Tracking-Tokens ist ungültig.',
  PAYLOAD_INVALID: 'Der Inhalt des Tracking-Tokens ist ungültig.',
  EXPIRED: 'Das Tracking-Token ist abgelaufen.',
  MISSING_SECRET: 'Es ist kein Signaturschlüssel für Tracking-Token konfiguriert.',
};

function rejection(reason: LaunchTokenRejection): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    messageDe: REJECTION_MESSAGES_DE[reason],
    details: { reason },
  });
}

/* -------------------------------------------------------------------------- */
/* Wire encoding                                                               */
/* -------------------------------------------------------------------------- */

export const TRACKING_CONTEXT_KEYS = Object.keys(
  trackingContextSchema.shape,
) as (keyof TrackingContext)[];

/**
 * Short wire keys plus base64url-packed UUIDs (22 chars instead of 36) keep the
 * token short enough to sit in a Meta ad URL beside the usual UTM set.
 */
const WIRE_KEYS: Readonly<Record<keyof TrackingContext, string>> = {
  campaign_id: 'c',
  campaign_version_id: 'cv',
  angle_id: 'a',
  angle_version_id: 'av',
  offer_id: 'o',
  offer_version_id: 'ov',
  creative_id: 'r',
  creative_version_id: 'rv',
  funnel_id: 'f',
  funnel_version_id: 'fv',
  form_id: 'm',
  form_version_id: 'mv',
  experiment_id: 'x',
  experiment_arm_id: 'xa',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 16 raw bytes as base64url — a lossless, 22-character UUID. */
export function packUuid(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Ungültige interne Kennung im Tracking-Token.',
      details: { value: 'redacted' },
    });
  }
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

export function unpackUuid(packed: string): string | null {
  if (typeof packed !== 'string' || packed.length !== 22) return null;
  const bytes = Buffer.from(packed, 'base64url');
  if (bytes.length !== 16) return null;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function encodeBody(payload: LaunchTokenPayload): string {
  const wire: Record<string, string | number> = {
    i: payload.issued_at,
    e: payload.expires_at,
  };
  for (const key of TRACKING_CONTEXT_KEYS) {
    const value = payload[key];
    if (value) wire[WIRE_KEYS[key]] = packUuid(value);
  }
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}

function decodeBody(body: string): Result<LaunchTokenPayload> {
  let wire: Record<string, unknown>;
  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return err(rejection('PAYLOAD_INVALID'));
    }
    wire = parsed as Record<string, unknown>;
  } catch {
    return err(rejection('PAYLOAD_INVALID'));
  }

  const candidate: Record<string, unknown> = {
    issued_at: wire.i,
    expires_at: wire.e,
  };
  for (const key of TRACKING_CONTEXT_KEYS) {
    const packed = wire[WIRE_KEYS[key]];
    if (typeof packed !== 'string') continue;
    const expanded = unpackUuid(packed);
    if (expanded === null) return err(rejection('PAYLOAD_INVALID'));
    candidate[key] = expanded;
  }

  const result = launchTokenPayloadSchema.safeParse(candidate);
  if (!result.success) return err(rejection('PAYLOAD_INVALID'));
  return ok(result.data);
}

/* -------------------------------------------------------------------------- */
/* Signing / verification                                                      */
/* -------------------------------------------------------------------------- */

function sign(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest();
}

/**
 * Constant-time signature comparison. A naive `===` on the base64 strings leaks
 * how many leading bytes matched, which is enough to forge a signature byte by
 * byte given enough attempts.
 */
function signaturesMatch(expected: Buffer, provided: Buffer): boolean {
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export interface SignLaunchTokenOptions {
  now?: Date;
  ttlSeconds?: number;
}

/**
 * Mints a URL-safe token: `v1.<base64url payload>.<base64url HMAC-SHA256>`.
 * The signature covers the version prefix as well, so a token cannot be
 * downgraded to another version by rewriting the prefix.
 */
export function signLaunchToken(
  payload: LaunchTokenInput,
  secret: string,
  options: SignLaunchTokenOptions = {},
): string {
  assertSecret(secret);

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_LAUNCH_TOKEN_TTL_SECONDS;
  const parsed = launchTokenPayloadSchema.safeParse({
    ...payload,
    issued_at: payload.issued_at ?? nowSeconds,
    expires_at: payload.expires_at ?? nowSeconds + ttl,
  });
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Das Tracking-Token konnte nicht erzeugt werden: ungültige Kennungen.',
      details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }

  const signingInput = `${LAUNCH_TOKEN_VERSION}.${encodeBody(parsed.data)}`;
  return `${signingInput}.${sign(secret, signingInput).toString('base64url')}`;
}

export interface VerifyLaunchTokenOptions {
  now?: Date;
  /** Allowance for clock skew between the minting and the verifying host. */
  clockToleranceSeconds?: number;
}

/**
 * Verifies signature, version and expiry — in that order. The payload is only
 * decoded *after* the signature holds, so untrusted bytes are never parsed into
 * anything the rest of the system reads.
 */
export function verifyLaunchToken(
  token: string,
  secret: string | null | undefined,
  options: VerifyLaunchTokenOptions = {},
): Result<LaunchTokenPayload> {
  if (!secret || secret.length < MIN_SIGNING_SECRET_LENGTH) {
    return err(rejection('MISSING_SECRET'));
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return err(rejection('MALFORMED'));
  }

  const parts = token.split('.');
  if (parts.length !== 3) return err(rejection('MALFORMED'));
  const [version, body, signature] = parts as [string, string, string];
  if (version !== LAUNCH_TOKEN_VERSION) return err(rejection('UNSUPPORTED_VERSION'));
  if (body.length === 0 || signature.length === 0) return err(rejection('MALFORMED'));

  const expected = sign(secret, `${version}.${body}`);
  const provided = Buffer.from(signature, 'base64url');
  if (!signaturesMatch(expected, provided)) return err(rejection('SIGNATURE_MISMATCH'));

  const decoded = decodeBody(body);
  if (!decoded.ok) return decoded;

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (decoded.value.expires_at + tolerance <= nowSeconds) {
    return err(rejection('EXPIRED'));
  }

  return ok(decoded.value);
}

/**
 * The configured signing secret, or `null` when none is set.
 *
 * Every consumer reads the secret through here rather than touching
 * `process.env`, and it returns `null` in a browser context so the key cannot be
 * pulled into a client bundle by accident. A missing secret is not fatal: tokens
 * simply stop verifying, attribution degrades to untrusted parameters and the
 * funnel keeps serving — which is the honest failure mode, unlike minting
 * unsigned tokens that look trustworthy.
 */
export function getLaunchTokenSecret(): string | null {
  if (typeof window !== 'undefined') return null;
  const secret = getServerEnv().TRACKING_SIGNING_SECRET;
  return secret && secret.length >= MIN_SIGNING_SECRET_LENGTH ? secret : null;
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SIGNING_SECRET_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: REJECTION_MESSAGES_DE.MISSING_SECRET,
      details: { reason: 'MISSING_SECRET', minLength: MIN_SIGNING_SECRET_LENGTH },
    });
  }
}

/** An all-null trusted context — the safe default when no token was present. */
export function emptyTrackingContext(): TrackingContext {
  return trackingContextSchema.parse({});
}

/** Only the internal ids, stripped of the token's own metadata. */
export function trackingContextFromToken(payload: LaunchTokenPayload): TrackingContext {
  const context = emptyTrackingContext();
  for (const key of TRACKING_CONTEXT_KEYS) {
    context[key] = payload[key];
  }
  return context;
}

/* -------------------------------------------------------------------------- */
/* Landing URLs                                                                */
/* -------------------------------------------------------------------------- */

export type MarketingParamKey = keyof MarketingParams;

export const MARKETING_PARAM_KEYS = Object.keys(
  marketingParamsSchema.shape,
) as MarketingParamKey[];

/**
 * Per-parameter length caps mirroring `marketingParamsSchema`. Over-long values
 * are truncated rather than rejected: a bloated `utm_content` is not a reason to
 * throw away an otherwise valid pageview.
 */
const MARKETING_PARAM_MAX_LENGTH: Readonly<Record<MarketingParamKey, number>> = {
  utm_source: 200,
  utm_medium: 200,
  utm_campaign: 300,
  utm_content: 300,
  utm_term: 300,
  fbclid: 500,
  fbc: 500,
  fbp: 500,
  meta_campaign_id: 64,
  meta_adset_id: 64,
  meta_ad_id: 64,
};

/**
 * Query parameters that look like internal ids. They are never read — a trusted
 * id can only ever come out of a verified token. Listed explicitly so that
 * `parseLandingUrl` can report attempts and a test can prove they are ignored.
 */
export const NEVER_TRUSTED_QUERY_PARAMS: readonly string[] = [
  ...TRACKING_CONTEXT_KEYS,
  'visitor_id',
  'session_id',
  'traffic_kind',
  'environment',
  'confidence',
  'from_signed_token',
];

export function emptyMarketingParams(): MarketingParams {
  return marketingParamsSchema.parse({});
}

export type LaunchUrlParams = Partial<Record<MarketingParamKey, string | null | undefined>>;

/**
 * Builds the URL that goes into the Meta ad.
 *
 * Meta's dynamic macros (`{{ad.id}}`) must survive verbatim, so the braces are
 * un-escaped again after `URLSearchParams` has encoded everything else.
 */
export function buildLaunchUrl(
  baseUrl: string,
  token: string,
  params: LaunchUrlParams = {},
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Die Basis-URL für den Launch-Link ist ungültig.',
    });
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Launch-Links müssen HTTPS verwenden (Ausnahme: localhost).',
    });
  }

  url.searchParams.set(LAUNCH_TOKEN_PARAM, token);
  for (const key of MARKETING_PARAM_KEYS) {
    const value = params[key];
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, value.slice(0, MARKETING_PARAM_MAX_LENGTH[key]));
  }

  return url.toString().replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}');
}

export interface LandingUrlParseResult {
  /** Raw token as found on the URL, or null. */
  token: string | null;
  tokenPresent: boolean;
  tokenValid: boolean;
  /** Why an existing token was not honoured. Null when there was none or it was valid. */
  tokenRejection: DomainError | null;
  /** Internal ids — populated only from a verified token. */
  trusted: TrackingContext;
  /** Everything the query string claimed. Reporting only. */
  marketingParams: MarketingParams;
  /** Query parameters that tried to set an internal id and were ignored. */
  ignoredTrustedParams: string[];
  /** Normalised landing URL, capped at the column width of `landing_url`. */
  landingUrl: string;
}

export interface ParseLandingUrlOptions {
  secret?: string | null;
  now?: Date;
}

/**
 * Splits a landing URL into its trusted and untrusted halves.
 *
 * This is the single place where that boundary is drawn. Trusted ids come out
 * of the token and nowhere else; the marketing parameters ride along as
 * reporting data. A URL that carries `?campaign_id=<someone-elses-uuid>` next
 * to a valid token resolves to the token's campaign — the query parameter is
 * recorded in `ignoredTrustedParams` and otherwise discarded.
 */
export function parseLandingUrl(
  url: string,
  options: ParseLandingUrlOptions = {},
): LandingUrlParseResult {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  const marketingParams = emptyMarketingParams();
  const ignoredTrustedParams: string[] = [];
  let token: string | null = null;

  if (parsed) {
    token = parsed.searchParams.get(LAUNCH_TOKEN_PARAM);
    for (const key of MARKETING_PARAM_KEYS) {
      const value = parsed.searchParams.get(key);
      if (value === null || value === '') continue;
      marketingParams[key] = value.slice(0, MARKETING_PARAM_MAX_LENGTH[key]);
    }
    for (const name of NEVER_TRUSTED_QUERY_PARAMS) {
      if (parsed.searchParams.has(name)) ignoredTrustedParams.push(name);
    }
  }

  const landingUrl = (parsed?.toString() ?? String(url)).slice(0, 2000);

  if (!token) {
    return {
      token: null,
      tokenPresent: false,
      tokenValid: false,
      tokenRejection: null,
      trusted: emptyTrackingContext(),
      marketingParams,
      ignoredTrustedParams,
      landingUrl,
    };
  }

  const verified = verifyLaunchToken(token, options.secret ?? null, { now: options.now });
  return {
    token,
    tokenPresent: true,
    tokenValid: verified.ok,
    tokenRejection: verified.ok ? null : verified.error,
    trusted: verified.ok ? trackingContextFromToken(verified.value) : emptyTrackingContext(),
    marketingParams,
    ignoredTrustedParams,
    landingUrl,
  };
}
