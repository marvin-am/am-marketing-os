import { createHmac } from 'node:crypto';
import { LAUNCH_TOKEN_PARAM } from '@am/domain';
import { FUNNEL_URL, TRACKING_SIGNING_SECRET } from './config';

/**
 * A signed launch token, minted the way the ad URL builder mints it.
 *
 * This is the URL a visitor arrives on after clicking a Meta ad: one compact,
 * server-signed token carrying the internal ids of exactly the versions that
 * were published. The wire format is the contract in
 * `packages/tracking/src/tokens.ts` — version prefix, base64url body with short
 * keys and 22-character packed UUIDs, base64url HMAC-SHA256 over
 * `"<version>.<body>"`.
 *
 * It is re-implemented here rather than imported because `@am/e2e` does not
 * declare `@am/tracking` as a dependency (see the report). Keeping it to the
 * public wire format means a drift in that format shows up as a funnel that
 * stops trusting the token, which is exactly what the journey asserts.
 */

const VERSION = 'v1';

/** Short wire keys, mirroring `WIRE_KEYS` in `@am/tracking`. */
const WIRE_KEYS = {
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
} as const;

export type LaunchTokenIds = Partial<Record<keyof typeof WIRE_KEYS, string>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function packUuid(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Kein gültiger UUID-Wert für das Launch-Token: ${uuid}`);
  }
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

export interface SignLaunchTokenOptions {
  /** Seconds from now until the token stops verifying. Default 180 days. */
  ttlSeconds?: number;
  /** Overrides the signing key — used to prove a forged token is rejected. */
  secret?: string;
}

export function signLaunchToken(
  ids: LaunchTokenIds,
  options: SignLaunchTokenOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const wire: Record<string, string | number> = {
    i: now,
    e: now + (options.ttlSeconds ?? 60 * 60 * 24 * 180),
  };
  for (const [key, wireKey] of Object.entries(WIRE_KEYS)) {
    const value = ids[key as keyof LaunchTokenIds];
    if (value) wire[wireKey] = packUuid(value);
  }

  const body = Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
  const signingInput = `${VERSION}.${body}`;
  const signature = createHmac('sha256', options.secret ?? TRACKING_SIGNING_SECRET)
    .update(signingInput, 'utf8')
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

export interface LaunchUrlOptions extends SignLaunchTokenOptions {
  /** Untrusted reporting parameters that ride alongside the token. */
  marketing?: Record<string, string>;
  /** Defaults to the funnel runtime under test. */
  baseUrl?: string;
}

/** `https://…/f/<slug>?am_t=<token>&utm_…` — the ad's destination URL. */
export function launchUrlFor(
  slug: string,
  ids: LaunchTokenIds,
  options: LaunchUrlOptions = {},
): string {
  const url = new URL(`/f/${slug}`, options.baseUrl ?? FUNNEL_URL);
  url.searchParams.set(LAUNCH_TOKEN_PARAM, signLaunchToken(ids, options));
  for (const [key, value] of Object.entries(options.marketing ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export { LAUNCH_TOKEN_PARAM };
