'use client';

import * as React from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from '../lib/cn';
import { formatPercentDe } from '../lib/format';

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** 0–100. `null` renders an indeterminate track, never a full-looking bar. */
  value?: number | null;
  tone?: 'brand' | 'success' | 'warning' | 'destructive' | 'neutral';
  /** German accessible name, e.g. "Fortschritt Launch-QA". */
  label?: string;
}

const TONE_CLASS: Record<NonNullable<ProgressProps['tone']>, string> = {
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  neutral: 'bg-foreground',
};

export const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(function Progress({ className, value = null, tone = 'brand', label, max = 100, ...props }, ref) {
  const clamped = value === null ? null : Math.min(Math.max(value, 0), max);
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={clamped}
      max={max}
      aria-label={label}
      aria-valuetext={
        clamped === null ? 'Wird ermittelt …' : formatPercentDe(clamped / max, 0)
      }
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full w-full flex-1 rounded-full transition-transform duration-300',
          TONE_CLASS[tone],
          clamped === null && 'animate-am-shimmer',
        )}
        style={{
          transform: `translateX(-${100 - ((clamped ?? 30) / max) * 100}%)`,
        }}
      />
    </ProgressPrimitive.Root>
  );
});
