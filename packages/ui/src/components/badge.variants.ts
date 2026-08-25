import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

/**
 * The one badge shape in the product. Tone is never the only carrier of
 * meaning — every product badge built on this also renders an icon and a
 * German word (WCAG 1.4.1, "no colour-only signalling").
 */
export const badgeVariants = cva(
  cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium',
    'align-middle whitespace-nowrap',
    '[&_svg]:size-3.5 [&_svg]:shrink-0',
  ),
  {
    variants: {
      tone: {
        neutral:
          'border-neutral-tone-border bg-neutral-tone-surface text-muted-foreground',
        brand: 'border-brand-200 bg-brand-subtle text-brand-subtle-foreground',
        success: 'border-success-border bg-success-surface text-success',
        warning: 'border-warning-border bg-warning-surface text-warning',
        destructive: 'border-destructive-border bg-destructive-surface text-destructive',
        info: 'border-info-border bg-info-surface text-info',
        outline: 'border-border-strong bg-transparent text-foreground',
        solid: 'border-transparent bg-foreground text-background',
      },
      size: {
        sm: 'px-2 py-0.5 text-[0.6875rem] leading-4',
        md: 'px-2.5 py-1 text-xs leading-4',
      },
    },
    defaultVariants: {
      tone: 'neutral',
      size: 'md',
    },
  },
);

export type BadgeVariantsProps = VariantProps<typeof badgeVariants>;
