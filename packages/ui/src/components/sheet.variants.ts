import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

export const sheetVariants = cva(
  cn(
    // Focus lands on the panel when it opens; see `DialogContent`.
    'fixed z-50 flex flex-col border-border bg-surface shadow-xl focus:outline-hidden',
    'data-[state=open]:animate-am-in data-[state=closed]:animate-am-out',
  ),
  {
    variants: {
      side: {
        right: 'inset-y-0 right-0 h-full w-full max-w-md border-l',
        left: 'inset-y-0 left-0 h-full w-full max-w-md border-r',
        top: 'inset-x-0 top-0 max-h-[80dvh] w-full border-b',
        bottom: 'inset-x-0 bottom-0 max-h-[80dvh] w-full border-t',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export type SheetVariantsProps = VariantProps<typeof sheetVariants>;
