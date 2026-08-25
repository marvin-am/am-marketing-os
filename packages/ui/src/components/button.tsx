'use client';

import * as React from 'react';
import { Slot } from 'radix-ui';
import { type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { buttonVariants } from './button.variants';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Render the child element instead of a `<button>` (e.g. a Next.js `Link`).
   *
   * The child must be a single element with a single child of its own — the
   * spinner and any icons are injected around it, so
   * `<Button asChild><Link href="…">Zur Übersicht</Link></Button>` is the
   * supported shape.
   */
  asChild?: boolean;
  /** Shows a spinner and blocks interaction. Pass `loadingLabel` for screen readers. */
  loading?: boolean;
  /** German status text announced while `loading` is true. */
  loadingLabel?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    asChild = false,
    loading = false,
    loadingLabel = 'Wird ausgeführt …',
    disabled,
    children,
    type,
    ...props
  },
  ref,
) {
  const Comp = (asChild ? Slot.Root : 'button') as React.ElementType;
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={asChild ? undefined : disabled || loading}
      data-loading={loading ? '' : undefined}
      aria-busy={loading || undefined}
      type={asChild ? undefined : (type ?? 'button')}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          <span className="sr-only">{loadingLabel}</span>
        </>
      ) : null}
      {/*
       * Under `asChild` the spinner is a *sibling* of `children`, so Slot would
       * see an array and `React.Children.only` would throw. `Slot.Slottable`
       * marks which child is the element to render; the siblings become its
       * children instead. Keeps the spinner working in `asChild` mode.
       */}
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}
    </Comp>
  );
});
