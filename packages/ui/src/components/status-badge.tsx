'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import { resolveStatus, type StatusSelector } from '../lib/status';
import { Badge, type BadgeProps } from './badge';

export type StatusBadgeProps = StatusSelector &
  Omit<BadgeProps, 'tone' | 'children'> & {
    /** Extra German text appended after the label, e.g. a retry counter. */
    suffix?: React.ReactNode;
    /** Hide the icon (only for very dense tables — the label still carries it). */
    hideIcon?: boolean;
  };

/**
 * The single way the console renders a lifecycle state.
 *
 * It always shows the German label from `@am/domain` plus a state-specific
 * icon; the tone is redundant decoration, so the badge stays readable in
 * greyscale and for colour-blind users (WCAG 1.4.1).
 */
export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  function StatusBadge({ kind, state, className, size, suffix, hideIcon = false, ...props }, ref) {
    const descriptor = resolveStatus({ kind, state } as StatusSelector);
    const Icon = descriptor.icon;

    return (
      <Badge
        ref={ref}
        tone={descriptor.tone}
        size={size}
        data-status-kind={kind}
        data-status-state={String(state)}
        className={cn('gap-1.5', className)}
        {...props}
      >
        {hideIcon ? null : (
          <Icon
            aria-hidden="true"
            className={cn(state === 'IN_FLIGHT' || state === 'EXECUTING' ? 'animate-spin' : '')}
          />
        )}
        <span className="truncate">{descriptor.label}</span>
        {suffix ? <span className="opacity-80">{suffix}</span> : null}
      </Badge>
    );
  },
);
