'use client';

import * as React from 'react';
import { type DryRunResult } from '@am/domain';
import { ChevronDown, FlaskConical } from 'lucide-react';
import { cn } from '../lib/cn';
import { Badge } from './badge';

/** Narrow an adapter return value to a dry run without importing Zod. */
export function isDryRunResult(value: unknown): value is DryRunResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { dryRun?: unknown }).dryRun === true &&
    typeof (value as { operation?: unknown }).operation === 'string'
  );
}

export interface DryRunNoticeProps extends React.HTMLAttributes<HTMLDivElement> {
  result: DryRunResult;
  /** Start with the payload expanded (used inside confirmation previews). */
  defaultOpen?: boolean;
  /** German heading override. */
  title?: string;
}

/**
 * The banner every dry run is rendered with.
 *
 * A dry run is *not* a success and must never look like one: the headline says
 * "nicht ausgeführt", the payload is shown as "würde gesendet werden", and the
 * blocking reason from the adapter is quoted verbatim (AGENTS.md rule 2,
 * spec §27).
 */
export const DryRunNotice = React.forwardRef<HTMLDivElement, DryRunNoticeProps>(
  function DryRunNotice(
    { className, result, defaultOpen = false, title = 'Dry-Run – nicht ausgeführt', ...props },
    ref,
  ) {
    const [open, setOpen] = React.useState(defaultOpen);
    const payloadId = React.useId();
    const payload = React.useMemo(() => {
      try {
        return JSON.stringify(result.wouldSend, null, 2);
      } catch {
        return 'Nutzlast konnte nicht dargestellt werden.';
      }
    }, [result.wouldSend]);

    return (
      <div
        ref={ref}
        role="status"
        data-dry-run="true"
        className={cn(
          'overflow-hidden rounded-lg border-2 border-warning-border bg-warning-surface',
          className,
        )}
        {...props}
      >
        <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning [&_svg]:size-4"
          >
            <FlaskConical />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-bold uppercase tracking-wide text-warning">{title}</p>
              <Badge tone="warning" size="sm">
                {result.provider}
              </Badge>
              <Badge tone="outline" size="sm" className="font-mono">
                {result.operation}
              </Badge>
            </div>
            <p className="text-sm leading-relaxed text-foreground">{result.blockedByDe}</p>
            <p className="text-xs text-muted-foreground">
              Es wurde nichts an {result.provider} gesendet. Der folgende Aufruf würde bei
              aktivierten Schreibzugriffen ausgeführt.
            </p>
          </div>
        </div>

        <div className="border-t border-warning-border bg-surface">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={payloadId}
            onClick={() => setOpen((value) => !value)}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 px-4 text-left text-xs font-medium text-muted-foreground',
              'transition-colors hover:text-foreground',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            )}
          >
            <span>{open ? 'Nutzlast ausblenden' : 'Nutzlast anzeigen (würde gesendet werden)'}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
            />
          </button>
          <div id={payloadId} hidden={!open}>
            <pre className="max-h-72 overflow-auto border-t border-border bg-surface-sunken px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
              {payload}
            </pre>
          </div>
        </div>
      </div>
    );
  },
);
