'use client';

import * as React from 'react';
import { ChartColumnBig } from 'lucide-react';
import { EmptyState } from '@am/ui';
import { VizStyles } from './chart-theme';

export interface ChartFrameProps {
  /** German chart title. Names the plotted series, so one series needs no legend. */
  titleDe: string;
  descriptionDe?: React.ReactNode;
  /** Badges or notes rendered next to the title. */
  meta?: React.ReactNode;
  /** True when there is nothing to plot — an empty axis is never acceptable. */
  isEmpty: boolean;
  emptyTitleDe?: string;
  emptyDescriptionDe?: React.ReactNode;
  /** Plot height in pixels, including the x-axis band. */
  height?: number;
  legend?: React.ReactNode;
  /**
   * The same numbers as a table. Mandatory: several light-mode series colours
   * sit below 3:1 against the surface, so the figures must also be readable
   * without relying on the marks.
   */
  tableView: React.ReactNode;
  tableLabelDe?: string;
  children: React.ReactNode;
}

/**
 * The frame every chart in the console sits in.
 *
 * It owns the two things a chart must never get wrong: an explicit German
 * empty state instead of a bare axis, and a table view of the same figures.
 */
export function ChartFrame({
  titleDe,
  descriptionDe,
  meta,
  isEmpty,
  emptyTitleDe = 'Keine Daten im gewählten Zeitraum',
  emptyDescriptionDe = 'Für diesen Zeitraum liegen keine Auslieferungs- oder Funnel-Daten vor. Wählen Sie einen anderen Zeitraum oder eine andere Kampagne.',
  height = 260,
  legend,
  tableView,
  tableLabelDe = 'Werte als Tabelle',
  children,
}: ChartFrameProps): React.JSX.Element {
  const headingId = React.useId();

  return (
    <figure
      data-am-viz=""
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <VizStyles />
      <figcaption className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 id={headingId} className="text-sm font-semibold text-foreground">
            {titleDe}
          </h3>
          {meta}
        </div>
        {descriptionDe ? (
          <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            {descriptionDe}
          </p>
        ) : null}
      </figcaption>

      {isEmpty ? (
        <EmptyState
          size="sm"
          icon={<ChartColumnBig />}
          title={emptyTitleDe}
          description={emptyDescriptionDe}
        />
      ) : (
        <>
          <div style={{ height }} className="w-full">
            {children}
          </div>
          {legend}
        </>
      )}

      <details className="group">
        <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {tableLabelDe}
        </summary>
        <div className="pt-3">{tableView}</div>
      </details>
    </figure>
  );
}
