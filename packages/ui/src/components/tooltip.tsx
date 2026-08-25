'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { HelpCircle } from 'lucide-react';
import { cn } from '../lib/cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, children, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-md border border-border bg-foreground px-3 py-2',
          'text-xs leading-relaxed text-background shadow-md',
          'data-[state=delayed-open]:animate-am-in data-[state=closed]:animate-am-out',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-foreground" width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});

export interface TooltipProps {
  /** The tooltip body. German, one or two sentences. */
  content: React.ReactNode;
  children: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['side'];
  align?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['align'];
  delayDuration?: number;
}

/** Convenience wrapper: provider + root + trigger + content in one element. */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delayDuration = 200,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipContent side={side} align={align}>
          {content}
        </TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export interface InfoHintProps {
  /** German explanation. Shown on hover/focus and always exposed to AT. */
  children: React.ReactNode;
  /** German accessible name of the trigger, e.g. "Was bedeutet Datenreife?". */
  label: string;
  className?: string;
  side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['side'];
}

/**
 * The "?" affordance used next to data-quality badges and metric labels.
 *
 * The trigger is a real button, so it is reachable by keyboard and the tooltip
 * opens on focus. The same text is additionally rendered in a visually hidden
 * element referenced by `aria-describedby`, so touch users and screen readers
 * never depend on a hover-only interaction.
 */
export function InfoHint({ children, label, className, side = 'top' }: InfoHintProps) {
  const describedById = React.useId();

  return (
    <span className={cn('inline-flex items-center', className)}>
      <TooltipPrimitive.Provider delayDuration={150}>
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              aria-describedby={describedById}
              className={cn(
                'relative inline-flex size-5 items-center justify-center rounded-full',
                'text-muted-foreground transition-colors hover:text-foreground',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                "after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
              )}
            >
              <HelpCircle aria-hidden="true" className="size-3.5" />
            </button>
          </TooltipPrimitive.Trigger>
          <TooltipContent side={side}>{children}</TooltipContent>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
      <span id={describedById} className="sr-only">
        {children}
      </span>
    </span>
  );
}
