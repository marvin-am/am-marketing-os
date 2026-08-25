import { cva, type VariantProps } from 'class-variance-authority';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

export const cardVariants = cva(
  'rounded-lg border border-border bg-surface text-foreground',
  {
    variants: {
      elevation: {
        flat: '',
        raised: 'shadow-sm',
        floating: 'shadow-md',
      },
      tone: {
        default: '',
        muted: 'bg-surface-raised',
        destructive: 'border-destructive-border bg-destructive-surface',
        warning: 'border-warning-border bg-warning-surface',
      },
    },
    defaultVariants: {
      elevation: 'flat',
      tone: 'default',
    },
  },
);

export type CardVariantsProps = VariantProps<typeof cardVariants>;
