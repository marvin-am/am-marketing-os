'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@am/ui';
import { formatDate } from '@/lib/format';
import type { CampaignRef, DateRange, FunnelVersionRef } from '@/server/analytics-port';
import { RANGE_PRESETS } from './date-range';
import { ALL_FILTER_VALUE } from './labels';

export interface PerformanceFiltersProps {
  basePath: string;
  presetId: string;
  range: DateRange;
  campaigns: readonly CampaignRef[];
  campaignId: string | null;
  funnelVersions: readonly FunnelVersionRef[];
  funnelVersionId: string | null;
  /** Latest selectable day — the fixture and the rollups both end today. */
  maxDate: string;
  minDate: string;
}

interface FilterState {
  presetId: string;
  from: string;
  to: string;
  campaignId: string;
  funnelVersionId: string;
}

function buildQuery(state: FilterState): string {
  const params = new URLSearchParams();
  params.set('zeitraum', state.presetId);
  if (state.presetId === 'benutzerdefiniert') {
    params.set('von', state.from);
    params.set('bis', state.to);
  }
  if (state.campaignId !== ALL_FILTER_VALUE) params.set('kampagne', state.campaignId);
  if (state.funnelVersionId !== ALL_FILTER_VALUE) params.set('funnel', state.funnelVersionId);
  return params.toString();
}

/**
 * One filter row above everything it scopes.
 *
 * The selection lives in the URL rather than in component state, so every chart
 * and table on the page renders against the same slice and a shared link
 * reproduces it exactly. A custom range is applied explicitly; the presets apply
 * immediately.
 */
export function PerformanceFilters({
  basePath,
  presetId,
  range,
  campaigns,
  campaignId,
  funnelVersions,
  funnelVersionId,
  maxDate,
  minDate,
}: PerformanceFiltersProps): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [state, setState] = React.useState<FilterState>({
    presetId,
    from: range.from,
    to: range.to,
    campaignId: campaignId ?? ALL_FILTER_VALUE,
    funnelVersionId: funnelVersionId ?? ALL_FILTER_VALUE,
  });

  const navigate = React.useCallback(
    (next: FilterState) => {
      startTransition(() => {
        router.replace(`${basePath}?${buildQuery(next)}`, { scroll: false });
      });
    },
    [basePath, router],
  );

  // Navigation happens beside the state update, never inside the updater, so
  // React's double-invocation in development cannot fire two navigations.
  const update = React.useCallback(
    (patch: Partial<FilterState>, navigateNow = true) => {
      const next = { ...state, ...patch };
      setState(next);
      if (navigateNow) navigate(next);
    },
    [navigate, state],
  );

  const customInvalid = state.presetId === 'benutzerdefiniert' && state.from > state.to;
  const presetIds = React.useId();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="grid gap-3 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${presetIds}-zeitraum`}>Zeitraum</Label>
          <Select
            value={state.presetId}
            onValueChange={(value) =>
              update({
                presetId: value,
                ...(value === 'benutzerdefiniert' ? {} : { from: range.from, to: range.to }),
              })
            }
          >
            <SelectTrigger id={`${presetIds}-zeitraum`} aria-label="Zeitraum">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.labelDe}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${presetIds}-kampagne`}>Kampagne</Label>
          <Select value={state.campaignId} onValueChange={(value) => update({ campaignId: value })}>
            <SelectTrigger id={`${presetIds}-kampagne`} aria-label="Kampagne">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER_VALUE}>Alle Kampagnen</SelectItem>
              {campaigns.map((campaign) => (
                <SelectItem key={campaign.id} value={campaign.id}>
                  {campaign.labelDe}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${presetIds}-funnel`}>Funnel für die Schritt-Analyse</Label>
          <Select
            value={state.funnelVersionId}
            onValueChange={(value) => update({ funnelVersionId: value })}
          >
            <SelectTrigger id={`${presetIds}-funnel`} aria-label="Funnel für die Schritt-Analyse">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER_VALUE}>Automatisch (meiste Formularstarts)</SelectItem>
              {funnelVersions.map((funnel) => (
                <SelectItem key={funnel.id} value={funnel.id}>
                  {funnel.labelDe}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {state.presetId === 'benutzerdefiniert' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Eigener Zeitraum</span>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                aria-label="Von"
                value={state.from}
                min={minDate}
                max={maxDate}
                onChange={(event) => update({ from: event.target.value }, false)}
              />
              <span aria-hidden="true" className="text-muted-foreground">
                –
              </span>
              <Input
                type="date"
                aria-label="Bis"
                value={state.to}
                min={minDate}
                max={maxDate}
                onChange={(event) => update({ to: event.target.value }, false)}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {pending
            ? 'Zeitraum wird angewendet …'
            : `Ausgewertet wird ${formatDate(range.from)} bis ${formatDate(range.to)}.`}
        </p>
        {state.presetId === 'benutzerdefiniert' ? (
          <div className="flex items-center gap-2">
            {customInvalid ? (
              <span className="text-xs text-destructive">
                Das Startdatum muss vor dem Enddatum liegen.
              </span>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={customInvalid}
              loading={pending}
              onClick={() => navigate(state)}
            >
              Zeitraum anwenden
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
