'use client';

import * as React from 'react';
import { Toggle as TogglePrimitive } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

export const toggleVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium',
    'transition-colors duration-150',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50',
    'hover:bg-surface-sunken',
    // Pressed state carries a border and a weight change alongside the tint.
    'data-[state=on]:border-brand data-[state=on]:bg-brand-subtle data-[state=on]:font-semibold data-[state=on]:text-brand-subtle-foreground',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-transparent',
        outline: 'border border-border bg-transparent',
      },
      size: {
        sm: 'h-9 min-w-9 px-2.5',
        md: 'h-11 min-w-11 px-3',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ToggleProps
  extends React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root>,
    VariantProps<typeof toggleVariants> {}

export const Toggle = React.forwardRef<
  React.ComponentRef<typeof TogglePrimitive.Root>,
  ToggleProps
>(function Toggle({ className, variant, size, ...props }, ref) {
  return (
    <TogglePrimitive.Root
      ref={ref}
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
});
