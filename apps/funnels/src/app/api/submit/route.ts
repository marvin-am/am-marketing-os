import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitKeysFor, takeAll } from '@am/tracking';
import { checkOrigin, requestHost } from '@/server/origin';
import { clientAddress, rateLimitSalt, submitLimiter } from '@/server/rate-limit';
import { funnelServerConfig, runtimeContextFrom } from '@/server/request';
import { getFunnelStore } from '@/server/store';
import { RATE_LIMIT_MESSAGE_DE, submitLead } from '@/server/submit-service';

/**
 * The final submit.
 *
 * A thin shell on purpose: everything that decides whether a lead is accepted
 * lives in `submit-service.ts`, where it is reachable from a unit test without a
 * running server. This function only does what needs a request — origin, rate
 * limit, identity — and hands over.
 *
 * The response never echoes personal data back. It carries the submission id,
 * the selected result variant, an allow-list-checked redirect and the browser
 * pixel payload (whose `customData` is a closed schema), and nothing else.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = funnelServerConfig();
  const context = runtimeContextFrom(request.headers, request.url);

  const origin = checkOrigin({
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    host: requestHost(request.headers),
    allowedHosts: config.allowedOriginHosts,
  });
  if (!origin.ok) {
    /* Hard stop as well as a spam signal. A cross-site POST has no legitimate
       reason to reach the one endpoint that writes personal data. */
    return NextResponse.json(
      { ok: false, code: 'FORBIDDEN', messageDe: origin.reasonDe },
      { status: 403, headers: NO_STORE },
    );
  }

  /* The address is always part of the key, so a caller that sends no cookie is
     charged to the address it is calling from rather than to a bucket the
     server just minted for it. */
  const decision = takeAll(
    submitLimiter,
    rateLimitKeysFor({
      visitorId: context.visitorId,
      visitorPresented: context.visitorPresented,
      ipAddress: clientAddress(request.headers),
      salt: rateLimitSalt(),
    }),
  );
  if (!decision.allowed) {
    return NextResponse.json(
      { ok: false, code: 'RATE_LIMITED', messageDe: RATE_LIMIT_MESSAGE_DE },
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, decision.retryAfterSeconds)) },
      },
    );
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_FAILED', messageDe: 'Die Anfrage ist kein gültiges JSON.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const outcome = await submitLead(
    body,
    {
      visitorId: context.visitorId,
      sessionId: context.sessionId,
      environment: context.environment,
      trafficKind: context.trafficKind,
      originOk: origin.ok,
      userAgent: request.headers.get('user-agent'),
      clientIpAddress: clientAddress(request.headers),
      eventSourceUrl: context.landingUrl,
    },
    {
      store: getFunnelStore(),
      pixelId: config.pixelId,
      attributionWindowDays: config.attributionWindowDays,
      redirectAllowlist: config.redirectAllowlist,
    },
  );

  return NextResponse.json(outcome.body, { status: outcome.status, headers: NO_STORE });
}
