import { NextResponse, type NextRequest } from 'next/server';
import { LAUNCH_TOKEN_PARAM } from '@am/domain/events';
import {
  PREVIEW_COOKIE,
  SESSION_COOKIE,
  VISITOR_COOKIE,
  resolveVisitor,
  serializeCookie,
  type CookieAttributes,
} from '@am/tracking/identity';

/**
 * First-party identity, issued at the edge.
 *
 * Identity has to be resolved *before* the page renders, because arm assignment
 * is a pure function of the visitor id and must not flash the wrong variant. A
 * React Server Component cannot set a cookie, so the visitor and session
 * cookies are issued here and the refreshed `Cookie` header is forwarded to the
 * request — which is what makes a first visit see the same visitor id that the
 * browser is about to store.
 *
 * Both cookies are HttpOnly, host-only, SameSite=Lax and first-party. There is
 * no third-party cookie, no fingerprint and no cross-site identifier anywhere in
 * this application; the browser tracker never reads them, it receives the ids
 * the server already resolved.
 *
 * Imports are limited to `@am/tracking/identity` on purpose: the package barrel
 * pulls in `node:crypto` through the token and assignment modules, which must
 * never reach the edge bundle.
 */

/** Marks a preview render so it is classified out of production metrics. */
const PREVIEW_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * How long a launch token is carried forward. It only has to outlive the visit:
 * the token's own expiry still governs whether it verifies at all, and the
 * server re-verifies the signature on every request that reads it.
 */
const TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Longest token accepted from a URL. `verifyLaunchToken` uses the same cap. */
const MAX_TOKEN_LENGTH = 4096;

function attributesFor(request: NextRequest): CookieAttributes {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return { secure: !isLocal, sameSite: 'Lax', path: '/', httpOnly: true };
}

export function proxy(request: NextRequest): NextResponse {
  const attributes = attributesFor(request);
  const resolved = resolveVisitor({
    cookieHeader: request.headers.get('cookie'),
    now: new Date(),
    cookieAttributes: attributes,
  });

  /* Forward the identity to the render pass. Without this, the first request of
     a new visitor renders with no visitor id and assigns an arm on the second
     request — which is exactly the flash-of-wrong-variant the server-side
     assignment exists to prevent. */
  const headers = new Headers(request.headers);
  const existing = headers.get('cookie');
  const carried = [
    existing,
    `${VISITOR_COOKIE}=${encodeURIComponent(resolved.visitorId)}`,
    `${SESSION_COOKIE}=${encodeURIComponent(
      `${resolved.session.sessionId}.${resolved.session.startedAt}.${resolved.session.lastSeenAt}`,
    )}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('; ');
  headers.set('cookie', carried);

  /*
   * Carry the signed launch token forward. It arrives once, on the landing URL,
   * and the collector and the submit endpoint never see that URL — without this
   * every event after the first would fall back to untrusted marketing
   * parameters, which looks like weak campaigns rather than a bug. The *token*
   * is stored, not the ids it encodes: the server re-verifies the signature on
   * every read, so a cookie the browser edited proves nothing.
   */
  const urlToken = request.nextUrl.searchParams.get(LAUNCH_TOKEN_PARAM);
  const token = urlToken && urlToken.length <= MAX_TOKEN_LENGTH ? urlToken : null;

  const isPreview = request.nextUrl.pathname.startsWith('/preview');
  const extra = [
    token ? `${LAUNCH_TOKEN_PARAM}=${encodeURIComponent(token)}` : null,
    isPreview ? `${PREVIEW_COOKIE}=1` : null,
  ].filter((part): part is string => part !== null);
  if (extra.length > 0) headers.set('cookie', [carried, ...extra].join('; '));

  const response = NextResponse.next({ request: { headers } });

  for (const cookie of resolved.setCookies) {
    response.headers.append('Set-Cookie', cookie);
  }
  if (token) {
    response.headers.append(
      'Set-Cookie',
      serializeCookie(LAUNCH_TOKEN_PARAM, token, {
        ...attributes,
        maxAgeSeconds: TOKEN_COOKIE_MAX_AGE_SECONDS,
      }),
    );
  }
  if (isPreview) {
    response.headers.append(
      'Set-Cookie',
      serializeCookie(PREVIEW_COOKIE, '1', {
        ...attributes,
        maxAgeSeconds: PREVIEW_COOKIE_MAX_AGE_SECONDS,
      }),
    );
  }

  return response;
}

export const config = {
  /*
   * Everything a human can land on, plus the two write endpoints. Static assets
   * and the health probe are excluded: issuing a session cookie for a favicon
   * request would keep a bot's session alive forever and inflate every
   * session-scoped metric.
   */
  matcher: ['/f/:path*', '/preview/:path*', '/api/collect', '/api/submit'],
};
