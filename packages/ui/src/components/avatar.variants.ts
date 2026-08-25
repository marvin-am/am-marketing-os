import { cva, type VariantProps } from 'class-variance-authority';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

export const avatarVariants = cva(
  'relative flex shrink-0 overflow-hidden rounded-full border border-border bg-muted',
  {
    variants: {
      size: {
        sm: 'size-7 text-[0.625rem]',
        md: 'size-9 text-xs',
        lg: 'size-11 text-sm',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export type AvatarVariantsProps = VariantProps<typeof avatarVariants>;
