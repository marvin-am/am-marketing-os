'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FunnelStepAnalysis } from '@am/experiments';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@am/ui';
import { formatNumber, formatRate, formatRateBasis } from '@/lib/format';
import { ChartFrame } from './chart-frame';
import {
  AXIS_PROPS,
  formatAxisValue,
  GRID_PROPS,
  VIZ_MUTED,
  VIZ_SERIES,
  VizLegend,
  VizTooltip,
  type VizTooltipEntry,
} from './chart-theme';

export interface FunnelStepChartProps {
  steps: readonly FunnelStepAnalysis[];
  titleDe?: string;
  descriptionDe?: React.ReactNode;
}

interface StepBar {
  stepKey: string;
  labelDe: string;
  viewed: number;
  completed: number;
  lost: number;
  dropRateDe: string;
  basisDe: string;
}

/**
 * Sessions kept and lost at every form step.
 *
 * Part-to-whole per step, so a stacked bar rather than two charts. The two
 * segments are separated by a 2px surface-coloured gap and named in the legend;
 * the drop-off percentage and its "verloren / gesehen" basis are in the table,
 * so nothing depends on reading a colour.
 */
export function FunnelStepChart({
  steps,
  titleDe = 'Abbruch je Formularschritt',
  descriptionDe,
}: FunnelStepChartProps): React.JSX.Element {
  const bars: StepBar[] = React.useMemo(
    () =>
      steps.map((step) => ({
        stepKey: step.stepKey,
        labelDe: `${step.index + 1}. ${step.label}`,
        viewed: step.viewed,
        completed: step.completed,
        lost: step.lostSessions,
        dropRateDe: formatRate(step.dropOffRate),
        basisDe: formatRateBasis(step.dropOffRate),
      })),
    [steps],
  );

  const byLabel = React.useMemo(() => new Map(bars.map((bar) => [bar.labelDe, bar])), [bars]);
  const hasTraffic = bars.some((bar) => bar.viewed > 0);

  const rowsFor = React.useCallback(
    (label: string, _payload: readonly VizTooltipEntry[]) => {
      const bar = byLabel.get(label);
      if (!bar) return [];
      return [
        { labelDe: 'Abgeschlossen', valueDe: formatNumber(bar.completed), colorVar: VIZ_SERIES[0] },
        { labelDe: 'Abgebrochen', valueDe: formatNumber(bar.lost), colorVar: VIZ_MUTED },
        { labelDe: 'Abbruchrate', valueDe: bar.dropRateDe, basisDe: bar.basisDe },
      ];
    },
    [byLabel],
  );

  const tableView = (
    <Table caption="Sessions je Formularschritt mit Abbruchrate und Bezugsgröße">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Schritt</TableHead>
          <TableHead scope="col" className="text-right">
            Gesehen
          </TableHead>
          <TableHead scope="col" className="text-right">
            Abgeschlossen
          </TableHead>
          <TableHead scope="col" className="text-right">
            Abgebrochen
          </TableHead>
          <TableHead scope="col" className="text-right">
            Abbruchrate
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bars.map((bar) => (
          <TableRow key={bar.stepKey}>
            <TableCell>{bar.labelDe}</TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {formatNumber(bar.viewed)}
            </TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {formatNumber(bar.completed)}
            </TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {formatNumber(bar.lost)}
            </TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {bar.dropRateDe}
              <span className="ml-1 text-xs text-muted-foreground">{bar.basisDe}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <ChartFrame
      titleDe={titleDe}
      descriptionDe={descriptionDe}
      isEmpty={!hasTraffic}
      emptyTitleDe="Keine Schrittdaten vorhanden"
      emptyDescriptionDe="Für diesen Funnel wurden im Auswertungsfenster keine Formularschritte ausgeliefert. Eine leere Achse würde einen gemessenen Nullwert vortäuschen."
      height={Math.max(180, bars.length * 40 + 48)}
      legend={
        <VizLegend
          items={[
            { labelDe: 'Abgeschlossen', colorVar: VIZ_SERIES[0] },
            { labelDe: 'Abgebrochen', colorVar: VIZ_MUTED },
          ]}
        />
      }
      tableView={tableView}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={bars}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
          barCategoryGap="26%"
        >
          <CartesianGrid {...GRID_PROPS} vertical horizontal={false} />
          <XAxis
            type="number"
            {...AXIS_PROPS}
            axisLine={false}
            tickFormatter={(value: number) => formatAxisValue(value, 'COUNT')}
          />
          <YAxis type="category" dataKey="labelDe" {...AXIS_PROPS} width={190} axisLine={false} />
          <Tooltip
            cursor={{ fill: 'var(--viz-grid)', fillOpacity: 0.5 }}
            content={<VizTooltip rowsFor={rowsFor} />}
          />
          <Bar
            dataKey="completed"
            stackId="sessions"
            name="Abgeschlossen"
            fill={VIZ_SERIES[0]}
            stroke="var(--viz-surface)"
            strokeWidth={2}
            maxBarSize={24}
            isAnimationActive={false}
          />
          <Bar
            dataKey="lost"
            stackId="sessions"
            name="Abgebrochen"
            fill={VIZ_MUTED}
            stroke="var(--viz-surface)"
            strokeWidth={2}
            maxBarSize={24}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
