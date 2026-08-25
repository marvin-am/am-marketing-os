'use client';

import { Toaster as SonnerToaster, toast, type ToasterProps } from 'sonner';
import { AlertTriangle, CheckCircle2, Info, Loader2, OctagonAlert } from 'lucide-react';

export type { ToasterProps };
export { toast };

/**
 * Toast host. Mount once per app shell.
 *
 * Toasts are for *confirmed* outcomes only. A dry run or a locally queued
 * command is never announced as success — those render as a `DryRunNotice` or
 * a command state badge in the page itself (AGENTS.md rules 2–3, 8).
 */
export function Toaster({
  position = 'bottom-right',
  duration = 6000,
  closeButton = true,
  ...props
}: ToasterProps) {
  return (
    <SonnerToaster
      position={position}
      duration={duration}
      closeButton={closeButton}
      icons={{
        success: <CheckCircle2 aria-hidden="true" className="size-4" />,
        info: <Info aria-hidden="true" className="size-4" />,
        warning: <AlertTriangle aria-hidden="true" className="size-4" />,
        error: <OctagonAlert aria-hidden="true" className="size-4" />,
        loading: <Loader2 aria-hidden="true" className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'group flex w-full items-start gap-3 rounded-lg border border-border bg-surface p-4 text-sm text-foreground shadow-lg',
          title: 'font-semibold leading-tight',
          description: 'text-muted-foreground leading-relaxed',
          actionButton:
            'inline-flex h-9 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground',
          cancelButton:
            'inline-flex h-9 items-center rounded-md bg-muted px-3 text-xs font-medium text-foreground',
          closeButton: 'border-border bg-surface text-muted-foreground',
          success: 'border-success-border',
          error: 'border-destructive-border',
          warning: 'border-warning-border',
          info: 'border-info-border',
        },
      }}
      {...props}
    />
  );
}
