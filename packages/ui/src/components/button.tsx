'use client';

import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Invisible hit-area extension. Dense sizes stay visually small while their
 * pointer target remains 44 px tall (WCAG 2.2 §2.5.8, AA).
 */
const HIT_AREA =
  "after:pointer-events-none after:absolute after:left-0 after:top-1/2 after:h-11 after:w-full after:min-w-11 after:-translate-y-1/2 after:content-['']";

export const buttonVariants = cva(
  cn(
    'relative inline-flex shrink-0 select-none items-center justify-center gap-2',
    'whitespace-nowrap rounded-md text-sm font-medium',
    'transition-[background-color,border-color,color,box-shadow] duration-150',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-xs hover:bg-brand-700 active:bg-brand-800',
        secondary:
          'border border-border bg-surface text-foreground shadow-xs hover:bg-surface-sunken active:bg-muted',
        outline:
          'border border-border-strong bg-transparent text-foreground hover:bg-surface-sunken active:bg-muted',
        ghost: 'bg-transparent text-foreground hover:bg-surface-sunken active:bg-muted',
        subtle: 'bg-muted text-foreground hover:bg-surface-sunken active:bg-border',
        destructive:
          'bg-destructive text-destructive-foreground shadow-xs hover:brightness-110 active:brightness-95',
        link: 'bg-transparent text-brand underline-offset-4 hover:underline',
      },
      size: {
        sm: cn('h-9 px-3 text-[0.8125rem]', HIT_AREA),
        md: 'h-11 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'size-11',
        'icon-sm': cn('size-9', HIT_AREA, 'after:w-11 after:-left-1'),
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      block: false,
    },
  },
);

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
