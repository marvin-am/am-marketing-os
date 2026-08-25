'use client';

import * as React from 'react';
import { Inbox, OctagonAlert, RotateCcw } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './button';
import { Skeleton } from './skeleton';

/* -------------------------------------------------------------------------- */
/* Empty                                                                       */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** German headline, e.g. "Noch keine Kampagnen". */
  title: string;
  /** German sentence explaining what to do next. */
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Primary call to action. */
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  size?: 'sm' | 'md';
}

/** Never show an empty region without telling the operator what to do next. */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { className, title, description, icon, action, secondaryAction, size = 'md', ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-raised text-center',
        size === 'sm' ? 'gap-2 px-5 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
      >
        {icon ?? <Inbox />}
      </span>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Error                                                                       */
/* -------------------------------------------------------------------------- */

export interface ErrorStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onError'> {
  /** German headline. Defaults to a generic but honest message. */
  title?: string;
  /** German explanation of what failed and what it means. */
  description?: React.ReactNode;
  /** Machine detail (error code, correlation id). Rendered in a mono block. */
  detail?: string | null;
  /** Wired to the retry button. Omit only when a retry is genuinely impossible. */
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  /** Extra escape hatch, e.g. "Support informieren". */
  secondaryAction?: React.ReactNode;
  size?: 'sm' | 'md';
}

/**
 * The only way an error surface is allowed to look. A blank page or a silent
 * failure is never acceptable (AGENTS.md rule 8) — there is always a German
 * message and, wherever possible, a retry.
 */
export const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  {
    className,
    title = 'Die Daten konnten nicht geladen werden.',
    description = 'Bitte versuchen Sie es erneut. Bleibt der Fehler bestehen, prüfen Sie die Integrationen unter Einstellungen.',
    detail = null,
    onRetry,
    retryLabel = 'Erneut versuchen',
    retrying = false,
    secondaryAction,
    size = 'md',
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-destructive-border bg-destructive-surface text-center',
        size === 'sm' ? 'gap-2 px-5 py-8' : 'gap-3 px-6 py-12',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-full bg-destructive-surface text-destructive [&_svg]:size-5"
      >
        <OctagonAlert />
      </span>
      <h3 className="text-sm font-semibold text-destructive">{title}</h3>
      {description ? (
        <p className="max-w-prose text-sm leading-relaxed text-foreground/80">{description}</p>
      ) : null}
      {detail ? (
        <code className="max-w-full overflow-x-auto rounded-md bg-surface px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
          {detail}
        </code>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry} loading={retrying}>
            <RotateCcw aria-hidden="true" />
            {retryLabel}
          </Button>
        ) : null}
        {secondaryAction}
      </div>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export interface LoadingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** German status text announced politely while loading. */
  label?: string;
  /** Number of skeleton rows. */
  rows?: number;
  variant?: 'rows' | 'tiles' | 'inline';
}

/** A loading surface that announces itself instead of just being blank. */
export const LoadingState = React.forwardRef<HTMLDivElement, LoadingStateProps>(
  function LoadingState(
    { className, label = 'Daten werden geladen …', rows = 3, variant = 'rows', ...props },
    ref,
  ) {
    return (
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        aria-busy="true"
        className={cn('w-full', className)}
        {...props}
      >
        <span className="sr-only">{label}</span>
        {variant === 'inline' ? (
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        ) : null}
        {variant === 'rows' ? (
          <div className="flex flex-col gap-2.5">
            {Array.from({ length: rows }, (_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {variant === 'tiles' ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: rows }, (_, index) => (
              <div
                key={index}
                className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4"
              >
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
);
