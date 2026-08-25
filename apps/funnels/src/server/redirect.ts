import { isRedirectAllowed } from '@am/config';
import { isInternalHref, type LinkTarget } from '@am/funnel-schema';

/**
 * Redirect and outbound-link resolution.
 *
 * A published spec may only carry an in-app path or an HTTPS URL explicitly
 * flagged for allowlist checking (`@am/funnel-schema` enforces that at parse
 * time). This module answers the question that package deliberately refuses to:
 * *is this particular host allowed*. The answer is computed on the server —
 * `isRedirectAllowed` reads `REDIRECT_ALLOWLIST` from the server environment
 * and returns `false` in a browser context, so a client-side check would fail
 * open on the one deployment where it matters.
 *
 * An empty allowlist denies everything. That is the correct default for an open
 * redirect: an unconfigured allowlist is not a reason to forward a visitor to
 * an arbitrary host.
 */

export interface ResolvedTarget {
  href: string;
  external: boolean;
  newTab: boolean;
  /** False when an external host is not on the allowlist. */
  allowed: boolean;
  /** German copy shown instead of the link when it is not allowed. */
  blockedReasonDe: string | null;
}

const BLOCKED_DE =
  'Dieses Ziel ist nicht freigegeben und wurde deshalb nicht geöffnet. Bitte wenden Sie sich an uns.';

export function resolveLinkTarget(
  target: LinkTarget | null,
  allowlist?: readonly string[],
): ResolvedTarget | null {
  if (!target) return null;

  if (!target.external) {
    /* Belt and braces: the schema already refuses a protocol-relative or
       absolute href on an internal target, but this runs on untrusted stored
       data and the check is free. */
    const allowed = isInternalHref(target.href);
    return {
      href: target.href,
      external: false,
      newTab: target.newTab,
      allowed,
      blockedReasonDe: allowed ? null : BLOCKED_DE,
    };
  }

  const allowed = isRedirectAllowed(target.href, allowlist);
  return {
    href: target.href,
    external: true,
    newTab: target.newTab,
    allowed,
    blockedReasonDe: allowed ? null : BLOCKED_DE,
  };
}

export interface ResolvedRedirect {
  href: string;
  delaySeconds: number;
  external: boolean;
}

/**
 * A redirect the runtime may actually perform. Returns `null` — not a fallback
 * URL — when the target is not allowed, so a blocked redirect leaves the
 * visitor on the honest thank-you state instead of somewhere unexpected.
 */
export function resolveRedirect(
  redirect: { target: LinkTarget; delaySeconds: number } | null,
  allowlist?: readonly string[],
): ResolvedRedirect | null {
  if (!redirect) return null;
  const resolved = resolveLinkTarget(redirect.target, allowlist);
  if (!resolved || !resolved.allowed) return null;
  return {
    href: resolved.href,
    delaySeconds: redirect.delaySeconds,
    external: resolved.external,
  };
}
