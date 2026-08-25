'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Rendered inside an aria-live region so a screen reader hears the wait. */
  label?: string;
}

/**
 * A loading placeholder. It is `aria-hidden` by default — announcement is the
 * job of the surrounding `LoadingState`, otherwise every skeleton block would
 * be read out individually.
 */
export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { className, label, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      role={label ? 'status' : undefined}
      className={cn('animate-am-shimmer rounded-md bg-muted', className)}
      {...props}
    />
  );
});
