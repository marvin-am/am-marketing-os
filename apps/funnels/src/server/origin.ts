/**
 * Same-origin enforcement for the two write endpoints.
 *
 * The funnel runtime is the only part of the system on the open internet, and
 * both of its POST routes accept JSON — which means a cross-site form post
 * would otherwise reach them without a preflight. Checking `Origin` against the
 * host the request actually arrived on is what closes that, and it costs
 * nothing on the mobile critical path.
 *
 * A request with no `Origin` at all is *not* automatically trusted: browsers
 * omit it on same-origin GETs, but every `fetch`/`sendBeacon` POST a browser
 * makes carries one. `Referer` is accepted as a fallback for the small number
 * of privacy tools that strip `Origin`, and a missing pair is only tolerated
 * when explicitly allowed (server-to-server smoke tests).
 */

export interface OriginCheckInput {
  /** `Origin` request header. */
  origin?: string | null;
  /** `Referer` request header. */
  referer?: string | null;
  /** `Host` (or `X-Forwarded-Host`) the request arrived on. */
  host?: string | null;
  /** Additional hosts that may call, e.g. the configured public funnel URL. */
  allowedHosts?: readonly string[];
  /** Allow a request that carries neither `Origin` nor `Referer`. */
  allowMissing?: boolean;
}

export type OriginRejection = 'MISSING_ORIGIN' | 'FOREIGN_ORIGIN' | 'UNPARSEABLE_ORIGIN';

export interface OriginCheckResult {
  ok: boolean;
  reason: OriginRejection | null;
  /** German copy for the response body; the browser never sees a stack trace. */
  reasonDe: string | null;
}

const REJECTION_MESSAGES_DE: Readonly<Record<OriginRejection, string>> = {
  MISSING_ORIGIN: 'Die Anfrage enthält keine Herkunftsangabe.',
  FOREIGN_ORIGIN: 'Die Anfrage stammt von einer fremden Herkunft.',
  UNPARSEABLE_ORIGIN: 'Die Herkunftsangabe der Anfrage ist ungültig.',
};

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();

  /* `Host` headers arrive bare (`example.com:3001`), not as URLs — and `new URL`
     would happily read `localhost:3000` as the scheme `localhost:`, yielding an
     empty host that then matches nothing. The shape decides which parser runs. */
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).host.toLowerCase();
    } catch {
      return null;
    }
  }
  return /^[a-z0-9.\-[\]]+(?::\d+)?$/.test(trimmed) ? trimmed : null;
}

/** Compares hosts ignoring the port — a proxy commonly rewrites it. */
function sameHost(a: string, b: string): boolean {
  const strip = (host: string) => host.replace(/:\d+$/, '');
  return a === b || strip(a) === strip(b);
}

export function checkOrigin(input: OriginCheckInput): OriginCheckResult {
  const declared = input.origin ?? input.referer ?? null;

  if (!declared) {
    if (input.allowMissing) return { ok: true, reason: null, reasonDe: null };
    return {
      ok: false,
      reason: 'MISSING_ORIGIN',
      reasonDe: REJECTION_MESSAGES_DE.MISSING_ORIGIN,
    };
  }

  const declaredHost = hostOf(declared);
  if (!declaredHost) {
    return {
      ok: false,
      reason: 'UNPARSEABLE_ORIGIN',
      reasonDe: REJECTION_MESSAGES_DE.UNPARSEABLE_ORIGIN,
    };
  }

  const candidates = [hostOf(input.host), ...(input.allowedHosts ?? []).map(hostOf)].filter(
    (host): host is string => host !== null,
  );

  if (candidates.some((candidate) => sameHost(candidate, declaredHost))) {
    return { ok: true, reason: null, reasonDe: null };
  }

  return { ok: false, reason: 'FOREIGN_ORIGIN', reasonDe: REJECTION_MESSAGES_DE.FOREIGN_ORIGIN };
}

/** Reads the effective host, honouring the proxy header a platform sets. */
export function requestHost(headers: Headers): string | null {
  return headers.get('x-forwarded-host') ?? headers.get('host');
}
