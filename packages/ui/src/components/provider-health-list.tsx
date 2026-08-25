'use client';

import * as React from 'react';
import {
  rollUpHealth,
  type ConnectionState,
  type HealthCheck,
  type HealthStatus,
  type Provider,
} from '@am/domain';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { cn } from '../lib/cn';
import { formatDateTimeDe } from '../lib/format';
import { Button } from './button';
import { EmptyState } from './states';
import { StatusBadge } from './status-badge';

export interface ProviderHealthListProps extends React.HTMLAttributes<HTMLDivElement> {
  checks: readonly HealthCheck[];
  /** Shown in the header; omit for a bare list. */
  provider?: Provider;
  /** Defaults to `rollUpHealth(checks)` from `@am/domain`. */
  overall?: HealthStatus;
  connectionState?: ConnectionState;
  onRecheck?: () => void;
  rechecking?: boolean;
  recheckLabel?: string;
}

/**
 * Renders provider probes.
 *
 * `AWAITING_EXTERNAL_INPUT` is presented as a first-class state with the
 * remediation text, never as a failure and never as a fake success — the
 * product is correct, a credential or mapping is simply missing (spec §29).
 */
export const ProviderHealthList = React.forwardRef<HTMLDivElement, ProviderHealthListProps>(
  function ProviderHealthList(
    {
      className,
      checks,
      provider,
      overall,
      connectionState,
      onRecheck,
      rechecking = false,
      recheckLabel = 'Erneut prüfen',
      ...props
    },
    ref,
  ) {
    const rolled = overall ?? rollUpHealth(checks);

    return (
      <div
        ref={ref}
        className={cn('flex flex-col gap-3', className)}
        aria-label={provider ? `Systemstatus ${provider}` : 'Systemstatus'}
        role="region"
        {...props}
      >
        <div className="flex flex-wrap items-center gap-2">
          {provider ? (
            <h3 className="text-sm font-semibold text-foreground">{provider}</h3>
          ) : null}
          <StatusBadge kind="health" state={rolled} />
          {connectionState ? <StatusBadge kind="connection" state={connectionState} /> : null}
          {onRecheck ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={onRecheck}
              loading={rechecking}
            >
              <RotateCcw aria-hidden="true" />
              {recheckLabel}
            </Button>
          ) : null}
        </div>

        {checks.length === 0 ? (
          <EmptyState
            size="sm"
            title="Noch keine Prüfungen ausgeführt"
            description="Für diesen Provider liegt kein Prüfergebnis vor. Starten Sie eine Prüfung, um den Status zu ermitteln."
            action={
              onRecheck ? (
                <Button variant="secondary" size="sm" onClick={onRecheck} loading={rechecking}>
                  <RotateCcw aria-hidden="true" />
                  {recheckLabel}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {checks.map((check) => (
              <li key={check.key} className="flex flex-col gap-2 px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm font-medium text-foreground">{check.labelDe}</p>
                    {check.detailDe ? (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {check.detailDe}
                      </p>
                    ) : null}
                  </div>
                  <StatusBadge kind="health" state={check.status} />
                </div>

                {check.remediationDe ? (
                  <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-2.5 py-2 text-xs leading-relaxed text-foreground">
                    <ArrowRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="font-semibold">Nächster Schritt: </span>
                      {check.remediationDe}
                    </span>
                  </p>
                ) : null}

                <p className="text-[0.6875rem] text-muted-foreground">
                  Geprüft am {formatDateTimeDe(check.checkedAt)}
                  {check.blocksLiveOnly ? ' · blockiert nur den Live-Schritt' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
