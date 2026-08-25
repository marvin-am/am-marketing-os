import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

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

export type ButtonVariantsProps = VariantProps<typeof buttonVariants>;
