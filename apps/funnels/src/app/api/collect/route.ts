import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitKeysFor } from '@am/tracking';
import { collectEvents } from '@/server/collect-service';
import { checkOrigin, requestHost } from '@/server/origin';
import { clientAddress, collectLimiter, rateLimitSalt } from '@/server/rate-limit';
import { funnelServerConfig, runtimeContextFrom } from '@/server/request';
import { getFunnelStore } from '@/server/store';

/**
 * The first-party event collector.
 *
 * The browser posts here and nowhere else — there is no client Supabase SDK in
 * this app and no vendor analytics bundle, so this route is the only path from
 * a funnel page to stored data.
 *
 * Rejections, in order: a foreign origin (403), a payload carrying personal
 * data (422, the whole batch), and per-event rate limiting inside `ingestBatch`
 * (429 when nothing at all got through). A duplicate event is not an error — the
 * client retried, which is exactly what it should do — so it is counted and the
 * response is still 200.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = funnelServerConfig();

  const origin = checkOrigin({
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    host: requestHost(request.headers),
    allowedHosts: config.allowedOriginHosts,
  });
  if (!origin.ok) {
    return NextResponse.json(
      { ok: false, code: 'FORBIDDEN', messageDe: origin.reasonDe },
      { status: 403, headers: NO_STORE },
    );
  }

  const context = runtimeContextFrom(request.headers, request.url);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_FAILED', messageDe: 'Die Anfrage ist kein gültiges JSON.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const outcome = await collectEvents(
    body,
    {
      environment: context.environment,
      trafficKind: context.trafficKind,
      visitorId: context.visitorId,
      sessionId: context.sessionId,
      trusted: context.tokenValid ? context.trusted : null,
      /* Hashed — an IP address must never sit in a cache key or a log line. The
         address is always part of the key, so a caller that sends no cookie is
         still charged to the address it is calling from. */
      rateLimitKeys: rateLimitKeysFor({
        visitorId: context.visitorId,
        visitorPresented: context.visitorPresented,
        ipAddress: clientAddress(request.headers),
        salt: rateLimitSalt(),
      }),
    },
    { store: getFunnelStore(), limiter: collectLimiter },
  );

  if (outcome.ok) {
    const everythingRateLimited =
      outcome.body.accepted === 0 &&
      outcome.body.rejected.length > 0 &&
      outcome.body.rejected.every((entry) => entry.code === 'RATE_LIMITED');

    if (everythingRateLimited) {
      return NextResponse.json(
        { ok: false, code: 'RATE_LIMITED', messageDe: 'Zu viele Ereignisse. Bitte kurz warten.' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': '5' } },
      );
    }
  }

  return NextResponse.json(outcome.body, { status: outcome.status, headers: NO_STORE });
}
