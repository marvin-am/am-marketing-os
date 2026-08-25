import type { CSSProperties } from 'react';
import type { ThemeSpec } from '@am/funnel-schema';

/**
 * Applies a published spec's brand tokens.
 *
 * `@am/ui`'s theme maps every Tailwind utility onto a `--am-*` custom property
 * with `@theme inline`, which is precisely what lets a funnel re-brand itself at
 * runtime by overriding a handful of variables on a wrapper element. No
 * stylesheet is generated per funnel and no class name is computed from spec
 * data — the spec carries tokens, never CSS, and this is the only place those
 * tokens touch the page.
 */

const RADIUS: Readonly<Record<ThemeSpec['radius'], string>> = {
  NONE: '0px',
  SM: '0.25rem',
  MD: '0.5rem',
  LG: '0.75rem',
  FULL: '9999px',
};

const FONT_SCALE: Readonly<Record<ThemeSpec['fontScale'], string>> = {
  SM: '15px',
  MD: '16px',
  LG: '17px',
};

export function themeStyle(theme: ThemeSpec): CSSProperties {
  return {
    '--am-brand': theme.colors.primary,
    '--am-brand-foreground': theme.colors.onPrimary,
    '--am-primary': theme.colors.primary,
    '--am-primary-foreground': theme.colors.onPrimary,
    '--am-foreground': theme.colors.foreground,
    '--am-background': theme.colors.background,
    '--am-surface': theme.colors.background,
    '--am-muted': theme.colors.muted,
    '--am-surface-sunken': theme.colors.muted,
    '--am-accent': theme.colors.accent,
    '--am-ring': theme.colors.primary,
    '--am-radius': RADIUS[theme.radius],
    /* 16 px is the floor on small screens: iOS zooms any focused control below
       it, and a zoomed viewport is how a mobile form starts scrolling sideways. */
    fontSize: FONT_SCALE[theme.fontScale],
  } as CSSProperties;
}

export interface ThemeScopeProps {
  theme: ThemeSpec;
  children: React.ReactNode;
}

export function ThemeScope({ theme, children }: ThemeScopeProps) {
  return (
    <div
      style={themeStyle(theme)}
      data-density={theme.density === 'COMPACT' ? 'compact' : 'comfortable'}
      className="min-h-dvh w-full min-w-0 overflow-x-hidden bg-background text-foreground"
    >
      {children}
    </div>
  );
}
