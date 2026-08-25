'use client';

import * as React from 'react';
import { Toggle as TogglePrimitive } from 'radix-ui';
import { type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { toggleVariants } from './toggle.variants';

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
