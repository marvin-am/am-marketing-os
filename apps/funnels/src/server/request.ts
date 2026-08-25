import { headers } from 'next/headers';
import { getAppConfig, getServerEnv } from '@am/config';
import { resolveRuntimeContext, type RuntimeContext } from './runtime-context';
import { requestHost } from './origin';

/**
 * The Next-bound half of request resolution.
 *
 * Everything that needs a request object lives here so that
 * `runtime-context.ts` stays free of `next/headers` and can be unit-tested
 * without a server. A server component cannot see its own URL, so the caller
 * reconstructs it from the params it was handed — which is all
 * `parseLandingUrl` needs, since it only ever reads the query string.
 */

export function absoluteUrl(
  host: string | null,
  proto: string | null,
  pathname: string,
  query: Record<string, string | string[] | undefined> = {},
): string {
  const scheme = proto ?? (host?.startsWith('localhost') ? 'http' : 'https');
  const url = new URL(pathname, `${scheme}://${host ?? 'localhost'}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  return url.toString();
}

export function runtimeContextFrom(
  headerList: Headers,
  url: string,
  isPreviewRoute = false,
): RuntimeContext {
  return resolveRuntimeContext({
    cookieHeader: headerList.get('cookie'),
    userAgent: headerList.get('user-agent'),
    host: requestHost(headerList),
    url,
    referer: headerList.get('referer'),
    acceptLanguage: headerList.get('accept-language'),
    secFetchSite: headerList.get('sec-fetch-site'),
    isPreviewRoute,
  });
}

export interface PageRequest {
  context: RuntimeContext;
  url: string;
  host: string | null;
}

/** Resolves identity and traffic kind for a server-rendered page. */
export async function pageRequest(
  pathname: string,
  query: Record<string, string | string[] | undefined> = {},
  isPreviewRoute = false,
): Promise<PageRequest> {
  const headerList = await headers();
  const host = requestHost(headerList);
  const url = absoluteUrl(host, headerList.get('x-forwarded-proto'), pathname, query);
  return { context: runtimeContextFrom(headerList, url, isPreviewRoute), url, host };
}

export interface FunnelServerConfig {
  /** `META_PIXEL_ID`, or `null` while Meta is not connected. */
  pixelId: string | null;
  redirectAllowlist: readonly string[];
  attributionWindowDays: number;
  /** Hosts allowed to call the write endpoints besides the request host. */
  allowedOriginHosts: string[];
}

export function funnelServerConfig(): FunnelServerConfig {
  const env = getServerEnv();
  const app = getAppConfig();
  const allowedOriginHosts: string[] = [];
  try {
    allowedOriginHosts.push(new URL(app.funnelUrl).host);
  } catch {
    /* An unparseable configured URL simply contributes no extra host; the
       request's own host still matches. */
  }
  return {
    pixelId: env.META_PIXEL_ID,
    redirectAllowlist: env.REDIRECT_ALLOWLIST,
    attributionWindowDays: env.ATTRIBUTION_WINDOW_DAYS,
    allowedOriginHosts,
  };
}
