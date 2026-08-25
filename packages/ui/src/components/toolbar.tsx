'use client';

import * as React from 'react';
import { Toolbar as ToolbarPrimitive } from 'radix-ui';
import { cn } from '../lib/cn';
import { buttonVariants } from './button';

export interface ToolbarProps
  extends React.ComponentPropsWithoutRef<typeof ToolbarPrimitive.Root> {
  /** German accessible name, e.g. "Filter und Aktionen". Required. */
  label: string;
}

/**
 * A row of filters and actions.
 *
 * Built on the Radix toolbar so arrow keys move between items with a roving
 * tab stop — the whole toolbar is a single stop in the page's tab order
 * (WAI-ARIA toolbar pattern).
 */
export const Toolbar = React.forwardRef<
  React.ComponentRef<typeof ToolbarPrimitive.Root>,
  ToolbarProps
>(function Toolbar({ className, label, orientation = 'horizontal', ...props }, ref) {
  return (
    <ToolbarPrimitive.Root
      ref={ref}
      aria-label={label}
      orientation={orientation}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg border border-border bg-surface p-2',
        orientation === 'vertical' && 'flex-col items-stretch',
        className,
      )}
      {...props}
    />
  );
});

export const ToolbarButton = React.forwardRef<
  React.ComponentRef<typeof ToolbarPrimitive.Button>,
  React.ComponentPropsWithoutRef<typeof ToolbarPrimitive.Button> & {
    variant?: 'ghost' | 'secondary' | 'primary' | 'destructive';
    size?: 'sm' | 'md' | 'icon-sm' | 'icon';
  }
>(function ToolbarButton({ className, variant = 'ghost', size = 'sm', ...props }, ref) {
  return (
    <ToolbarPrimitive.Button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export const ToolbarLink = React.forwardRef<
  React.ComponentRef<typeof ToolbarPrimitive.Link>,
  React.ComponentPropsWithoutRef<typeof ToolbarPrimitive.Link>
>(function ToolbarLink({ className, ...props }, ref) {
  return (
    <ToolbarPrimitive.Link
      ref={ref}
      className={cn(buttonVariants({ variant: 'link', size: 'sm' }), className)}
      {...props}
    />
  );
});

export const ToolbarSeparator = React.forwardRef<
  React.ComponentRef<typeof ToolbarPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ToolbarPrimitive.Separator>
>(function ToolbarSeparator({ className, ...props }, ref) {
  return (
    <ToolbarPrimitive.Separator
      ref={ref}
      className={cn('mx-1 h-6 w-px shrink-0 bg-border', className)}
      {...props}
    />
  );
});

/** Pushes everything after it to the far end of the toolbar. */
export function ToolbarSpacer({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('flex-1', className)} {...props} />;
}
