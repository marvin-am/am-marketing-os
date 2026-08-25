'use client';

import * as React from 'react';
import { type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { badgeVariants } from './badge.variants';

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, size, ...props },
  ref,
) {
  return <span ref={ref} className={cn(badgeVariants({ tone, size }), className)} {...props} />;
});
