import { z } from 'zod';
import { specKeySchema } from '@am/domain';

/**
 * Shared building blocks for every spec document in this package.
 *
 * Two hard rules govern everything here and are enforced at parse time:
 *
 * 1. **No executable or styling payload.** A spec never carries HTML, JavaScript,
 *    CSS, template expressions or an external script URL. `plainText()` refuses
 *    anything that looks like markup, so an AI-authored spec cannot smuggle
 *    markup through a headline (AGENTS.md rule 5).
 * 2. **No fabricated externals.** Anything that points outside the application is
 *    a `LinkTarget` that is either relative or explicitly flagged for allowlist
 *    checking by the caller. A missing external target is modelled as `null`
 *    (AWAITING_EXTERNAL_INPUT), never as an invented URL (AGENTS.md rule 1).
 *
 * All visible copy in a spec is German; identifiers, codes and keys are English.
 * Spec schemas deliberately use **no zod defaults**: a published spec is a frozen,
 * fully materialised document, so input and output types are identical and a
 * half-filled object never silently becomes valid.
 */

export const SPEC_SCHEMA_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/* Markup guard                                                                */
/* -------------------------------------------------------------------------- */

export const MARKUP_MESSAGE_DE =
  'Dieser Text darf kein Markup, kein Skript und kein CSS enthalten.';

const MARKUP_PATTERNS: readonly { pattern: RegExp; reasonDe: string }[] = [
  { pattern: /<\s*\/?\s*[a-zA-Z][^>]*>/, reasonDe: 'HTML-Tag' },
  { pattern: /<\s*script/i, reasonDe: 'Skript-Tag' },
  { pattern: /javascript\s*:/i, reasonDe: 'javascript:-URL' },
  { pattern: /data\s*:\s*text\/html/i, reasonDe: 'data:-URL mit HTML' },
  {
    /* Deliberately the concrete handler names: a generic `on\w+=` would reject
       harmless German copy such as "Anfragen online = planbar". */
    pattern:
      /\son(click|load|error|mouseover|mouseenter|focus|submit|change|input|keydown|keyup|blur|toggle)\s*=/i,
    reasonDe: 'Event-Handler-Attribut',
  },
  { pattern: /\{\{[\s\S]*\}\}/, reasonDe: 'Template-Ausdruck' },
  { pattern: /expression\s*\(/i, reasonDe: 'CSS-Expression' },
  { pattern: /\burl\s*\(\s*['"]?(?:https?:|data:|\/\/)/i, reasonDe: 'CSS-url()' },
  { pattern: /@import/i, reasonDe: 'CSS-@import' },
];

/** True when a string carries markup, script, CSS or a template expression. */
export function containsMarkup(value: string): boolean {
  return MARKUP_PATTERNS.some((entry) => entry.pattern.test(value));
}

/**
 * Structural markup scan over an arbitrary spec fragment. Mirrors
 * `findPiiViolations` from `@am/domain`: it returns readable paths rather than
 * throwing, so the builder can list every offending text at once.
 */
export function findMarkupViolations(value: unknown, path = '$'): string[] {
  const violations: string[] = [];

  const walk = (node: unknown, currentPath: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      for (const entry of MARKUP_PATTERNS) {
        if (entry.pattern.test(node)) {
          violations.push(`${currentPath} (${entry.reasonDe})`);
          return;
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, `${currentPath}.${key}`);
      }
    }
  };

  walk(value, path);
  return violations;
}

/** German visible copy of a bounded length that may never contain markup. */
export function plainText(max: number, min = 1): z.ZodString {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !containsMarkup(value), { message: MARKUP_MESSAGE_DE });
}

/** Optional German copy: either absent (`null`) or non-empty and markup-free. */
export function optionalPlainText(max: number): z.ZodNullable<z.ZodString> {
  return plainText(max).nullable();
}

/* -------------------------------------------------------------------------- */
/* Links and redirects                                                         */
/* -------------------------------------------------------------------------- */

/** Application-internal path: starts with a single `/`, no protocol, no `//`. */
export const RELATIVE_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;

export const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(RELATIVE_PATH_PATTERN, 'Erwartet einen anwendungsinternen Pfad, z. B. /danke.');

export function isRelativeHref(href: string): boolean {
  return RELATIVE_PATH_PATTERN.test(href);
}

/** In-page jump target, e.g. `#formular`. */
export const ANCHOR_PATTERN = /^#[A-Za-z][A-Za-z0-9_-]*$/;

export function isAnchorHref(href: string): boolean {
  return ANCHOR_PATTERN.test(href);
}

/** Anything the runtime may follow without leaving the application. */
export function isInternalHref(href: string): boolean {
  return isRelativeHref(href) || isAnchorHref(href);
}

/**
 * A link the runtime may follow.
 *
 * `external: false` means an in-app path. `external: true` requires
 * `requiresAllowlist: true` — the publishing caller checks the host against the
 * configured redirect allowlist. This package never decides that question; it
 * only guarantees that an unchecked external target cannot exist in a spec.
 */
export const linkTargetSchema = z
  .object({
    href: z.string().min(1).max(500),
    external: z.boolean(),
    requiresAllowlist: z.boolean(),
    newTab: z.boolean(),
  })
  .refine((target) => (target.external ? target.requiresAllowlist : true), {
    message: 'Externe Ziele müssen für die Allowlist-Prüfung markiert sein.',
    path: ['requiresAllowlist'],
  })
  .refine(
    (target) =>
      target.external ? target.href.startsWith('https://') : isInternalHref(target.href),
    {
      message:
        'Interne Ziele müssen relative Pfade oder Sprungpunkte sein, externe Ziele HTTPS-URLs.',
      path: ['href'],
    },
  );
export type LinkTarget = z.infer<typeof linkTargetSchema>;

export function internalLink(href: string, newTab = false): LinkTarget {
  return { href, external: false, requiresAllowlist: false, newTab };
}

export function externalLink(href: string, newTab = true): LinkTarget {
  return { href, external: true, requiresAllowlist: true, newTab };
}

/** In-page jump to a block anchor, e.g. `anchorLink('formular')`. */
export function anchorLink(anchor: string): LinkTarget {
  return { href: `#${anchor}`, external: false, requiresAllowlist: false, newTab: false };
}

/* -------------------------------------------------------------------------- */
/* Calls to action                                                             */
/* -------------------------------------------------------------------------- */

export const CTA_ACTIONS = ['NEXT_STEP', 'SUBMIT', 'LINK', 'OPEN_FORM', 'BOOKING'] as const;
export const ctaActionSchema = z.enum(CTA_ACTIONS);
export type CtaAction = z.infer<typeof ctaActionSchema>;

export const CTA_STYLES = ['PRIMARY', 'SECONDARY', 'GHOST'] as const;
export const ctaStyleSchema = z.enum(CTA_STYLES);
export type CtaStyle = z.infer<typeof ctaStyleSchema>;

export const ctaSpecSchema = z
  .object({
    label: plainText(80),
    action: ctaActionSchema,
    /** Only meaningful for `action: 'LINK'`; `null` for in-app actions. */
    target: linkTargetSchema.nullable(),
    style: ctaStyleSchema,
    note: optionalPlainText(160),
  })
  .refine((cta) => (cta.action === 'LINK' ? cta.target !== null : true), {
    message: 'Ein Link-CTA benötigt ein Ziel.',
    path: ['target'],
  });
export type CtaSpec = z.infer<typeof ctaSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

export const MEDIA_ASPECTS = ['1:1', '4:5', '16:9', '9:16', '3:2'] as const;
export const mediaAspectSchema = z.enum(MEDIA_ASPECTS);
export type MediaAspect = z.infer<typeof mediaAspectSchema>;

/**
 * A rendered asset. `assetPath` is a storage path inside the application, never
 * a remote URL — remote assets would be an uncontrolled external dependency at
 * render time.
 */
export const mediaRefSchema = z.object({
  kind: z.enum(['IMAGE', 'VIDEO']),
  assetPath: relativePathSchema,
  alt: plainText(300),
  aspect: mediaAspectSchema,
});
export type MediaRef = z.infer<typeof mediaRefSchema>;

/* -------------------------------------------------------------------------- */
/* Booking                                                                     */
/* -------------------------------------------------------------------------- */

export const BOOKING_MODES = ['LINK', 'EMBED'] as const;
export const bookingModeSchema = z.enum(BOOKING_MODES);
export type BookingMode = z.infer<typeof bookingModeSchema>;

/**
 * A booking offer. `target: null` is the honest state while no meeting link has
 * been supplied — the runtime renders "Terminbuchung noch nicht verbunden"
 * instead of a fabricated URL.
 */
export const bookingSpecSchema = z.object({
  mode: bookingModeSchema,
  target: linkTargetSchema.nullable(),
  label: plainText(80),
  helpText: optionalPlainText(300),
});
export type BookingSpec = z.infer<typeof bookingSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Theme                                                                       */
/* -------------------------------------------------------------------------- */

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Erwartet eine Hex-Farbe, z. B. #D7182A.');

export const THEME_PRESETS = ['AM_DEFAULT', 'LIGHT', 'DARK'] as const;
export const themePresetSchema = z.enum(THEME_PRESETS);
export type ThemePreset = z.infer<typeof themePresetSchema>;

/**
 * Brand token overrides only. There is deliberately no field that can carry raw
 * CSS — rendering happens through the controlled component library, which maps
 * these tokens onto Tailwind theme variables.
 */
export const themeSpecSchema = z.object({
  preset: themePresetSchema,
  colors: z.object({
    primary: hexColorSchema,
    onPrimary: hexColorSchema,
    foreground: hexColorSchema,
    background: hexColorSchema,
    muted: hexColorSchema,
    accent: hexColorSchema,
  }),
  radius: z.enum(['NONE', 'SM', 'MD', 'LG', 'FULL']),
  density: z.enum(['COMPACT', 'COMFORTABLE']),
  fontScale: z.enum(['SM', 'MD', 'LG']),
  progressStyle: z.enum(['BAR', 'DOTS', 'NONE']),
  /** Storage path of the logo; `null` while no logo has been configured. */
  logoAssetPath: relativePathSchema.nullable(),
});
export type ThemeSpec = z.infer<typeof themeSpecSchema>;

/** A&M house style: red on white, comfortable, rounded. */
export const DEFAULT_THEME: ThemeSpec = {
  preset: 'AM_DEFAULT',
  colors: {
    primary: '#D7182A',
    onPrimary: '#FFFFFF',
    foreground: '#111111',
    background: '#FFFFFF',
    muted: '#F4F4F5',
    accent: '#000000',
  },
  radius: 'MD',
  density: 'COMFORTABLE',
  fontScale: 'MD',
  progressStyle: 'BAR',
  logoAssetPath: null,
};

/* -------------------------------------------------------------------------- */
/* Codes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable reason for a qualification outcome or a disqualification.
 * Rendered in German by the console; never shown raw to a visitor.
 */
export const reasonCodeSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Reason-Codes sind GROSS_GESCHRIEBEN_MIT_UNTERSTRICH.');
export type ReasonCode = z.infer<typeof reasonCodeSchema>;

/** Stable key inside a spec document (step, field, option, block, variant). */
export const keySchema = specKeySchema;

/* -------------------------------------------------------------------------- */
/* SEO                                                                         */
/* -------------------------------------------------------------------------- */

export const seoSpecSchema = z.object({
  metaTitle: plainText(70),
  metaDescription: plainText(180),
  /** Paid funnel pages are excluded from the index by default. */
  noindex: z.boolean(),
  canonicalPath: relativePathSchema.nullable(),
});
export type SeoSpec = z.infer<typeof seoSpecSchema>;
