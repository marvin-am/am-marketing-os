import { externalLink, internalLink, isInternalHref, type MultiStepFormSpec } from '@am/funnel-schema';
import { resolveLinkTarget, type ResolvedTarget } from './redirect';

/**
 * Every outbound target a form spec can reach, resolved once on the server.
 *
 * The allowlist lives in the server environment: `isRedirectAllowed` returns
 * `false` in a browser context, so a client component that asked the question
 * itself would silently block every legitimate link — or, worse, a future
 * refactor would make it fail open. Resolving here and passing the answers down
 * keeps the decision on the side that can actually make it, and keeps the
 * allowlist out of the client bundle.
 */

export interface VariantTargets {
  cta: ResolvedTarget | null;
  booking: ResolvedTarget | null;
}

export interface FormTargets {
  privacy: ResolvedTarget | null;
  variants: Record<string, VariantTargets>;
  success: {
    primary: ResolvedTarget | null;
    secondary: ResolvedTarget | null;
    booking: ResolvedTarget | null;
  };
}

/** A privacy policy URL is a bare string in the consent spec, not a LinkTarget. */
export function privacyTargetFor(url: string, allowlist?: readonly string[]): ResolvedTarget | null {
  if (!url) return null;
  const target = isInternalHref(url) ? internalLink(url) : externalLink(url);
  return resolveLinkTarget(target, allowlist);
}

export function resolveFormTargets(
  spec: MultiStepFormSpec,
  allowlist?: readonly string[],
): FormTargets {
  const variants: Record<string, VariantTargets> = {};

  for (const variant of spec.resultVariants) {
    const cta = 'cta' in variant && variant.cta ? variant.cta : null;
    const booking = 'booking' in variant && variant.booking ? variant.booking : null;
    variants[variant.variantId] = {
      cta: cta ? resolveLinkTarget(cta.target, allowlist) : null,
      booking: booking ? resolveLinkTarget(booking.target, allowlist) : null,
    };
  }

  return {
    privacy: privacyTargetFor(spec.consent.privacyPolicyUrl, allowlist),
    variants,
    success: {
      primary: resolveLinkTarget(spec.success.primaryCta?.target ?? null, allowlist),
      secondary: resolveLinkTarget(spec.success.secondaryCta?.target ?? null, allowlist),
      booking: resolveLinkTarget(spec.success.booking?.target ?? null, allowlist),
    },
  };
}
