import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

export const alertVariants = cva(
  cn(
    'relative grid w-full grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1',
    'rounded-lg border px-4 py-3.5 text-sm',
    '[&>svg]:mt-0.5 [&>svg]:size-4.5 [&>svg]:shrink-0',
  ),
  {
    variants: {
      tone: {
        info: 'border-info-border bg-info-surface text-info',
        success: 'border-success-border bg-success-surface text-success',
        warning: 'border-warning-border bg-warning-surface text-warning',
        destructive: 'border-destructive-border bg-destructive-surface text-destructive',
        neutral: 'border-border bg-surface-raised text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type AlertVariantsProps = VariantProps<typeof alertVariants>;
