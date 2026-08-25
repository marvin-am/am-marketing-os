'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { METRIC_CATALOG, type MetricKey } from '@am/domain';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@am/ui';
import { formatNumber } from '@/lib/format';
import type { DailyPoint } from '@/server/analytics-port';
import { ChartFrame } from './chart-frame';
import {
  AXIS_PROPS,
  formatAxisDay,
  formatAxisValue,
  formatExactValue,
  formatTooltipDay,
  GRID_PROPS,
  VIZ_SERIES,
  VizTooltip,
  type VizTooltipEntry,
  type VizUnit,
} from './chart-theme';

export interface TimeSeriesChartProps {
  titleDe: string;
  descriptionDe?: React.ReactNode;
  points: readonly DailyPoint[];
  /** Which catalogue metric to plot. One metric per chart — never a second axis. */
  metric: MetricKey;
  /** Categorical slot index, so a metric keeps its colour across the page. */
  seriesIndex?: 0 | 1 | 2 | 3;
  /** Area for volumes, line for per-unit costs where gaps carry meaning. */
  shape?: 'area' | 'line';
}

interface SeriesRow {
  date: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  currency: string | null;
}

function unitOf(metric: MetricKey): VizUnit {
  switch (METRIC_CATALOG[metric].unit) {
    case 'MONEY':
      return 'MONEY';
    case 'RATE':
      return 'RATE';
    default:
      return 'COUNT';
  }
}

function basisOf(row: SeriesRow, metric: MetricKey): string | null {
  if (row.denominator === null || row.numerator === null) return null;
  const unit = METRIC_CATALOG[metric].unit;
  if (unit === 'MONEY') {
    return `${formatNumber(row.numerator / 100)} € / ${formatNumber(row.denominator)}`;
  }
  return `${formatNumber(row.numerator)} / ${formatNumber(row.denominator)}`;
}

/**
 * One metric over time.
 *
 * Deliberately single-series: two measures on different scales get two charts,
 * never a second y-axis. A day whose denominator is zero plots as a gap rather
 * than as a zero — "no leads that day" and "cost per lead of 0 €" are not the
 * same statement.
 */
export function TimeSeriesChart({
  titleDe,
  descriptionDe,
  points,
  metric,
  seriesIndex = 0,
  shape = 'area',
}: TimeSeriesChartProps): React.JSX.Element {
  const definition = METRIC_CATALOG[metric];
  const unit = unitOf(metric);
  const color = VIZ_SERIES[seriesIndex];

  const rows: SeriesRow[] = React.useMemo(
    () =>
      points.map((point) => {
        const value = point.metrics[metric];
        return {
          date: point.date,
          value: value.value,
          numerator: value.numerator,
          denominator: value.denominator,
          currency: value.currency,
        };
      }),
    [points, metric],
  );

  const byDate = React.useMemo(() => new Map(rows.map((row) => [row.date, row])), [rows]);
  const hasValue = rows.some((row) => row.value !== null && row.value !== 0);

  const rowsFor = React.useCallback(
    (label: string, _payload: readonly VizTooltipEntry[]) => {
      const row = byDate.get(label);
      if (!row) return [];
      return [
        {
          labelDe: definition.label,
          valueDe: formatExactValue(row.value, unit, row.currency ?? 'EUR'),
          basisDe: basisOf(row, metric),
          colorVar: color,
        },
      ];
    },
    [byDate, color, definition.label, metric, unit],
  );

  const tableView = (
    <div className="max-h-72 overflow-y-auto">
      <Table caption={`${titleDe} – Tageswerte`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Tag</TableHead>
            <TableHead scope="col" className="text-right">
              {definition.label}
            </TableHead>
            <TableHead scope="col" className="text-right">
              Bezugsgröße
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.date}>
              <TableCell>{formatTooltipDay(row.date)}</TableCell>
              <TableCell data-am-numeric="" className="text-right">
                {formatExactValue(row.value, unit, row.currency ?? 'EUR')}
              </TableCell>
              <TableCell data-am-numeric="" className="text-right text-muted-foreground">
                {basisOf(row, metric) ?? definition.formula}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  const axes = (
    <>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis
        dataKey="date"
        {...AXIS_PROPS}
        tickFormatter={formatAxisDay}
        minTickGap={28}
        interval="preserveStartEnd"
      />
      <YAxis
        {...AXIS_PROPS}
        width={64}
        axisLine={false}
        domain={[0, 'auto']}
        tickFormatter={(value: number) => formatAxisValue(value, unit)}
      />
      <Tooltip
        cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
        content={<VizTooltip rowsFor={rowsFor} headingFor={formatTooltipDay} />}
      />
    </>
  );

  return (
    <ChartFrame
      titleDe={titleDe}
      descriptionDe={descriptionDe ?? `Berechnung: ${definition.formula}`}
      isEmpty={!hasValue}
      emptyTitleDe={`Keine ${definition.label} im gewählten Zeitraum`}
      emptyDescriptionDe="Es liegen keine Werte vor, die sich darstellen ließen. Eine leere Achse würde einen gemessenen Nullwert vortäuschen."
      tableView={tableView}
    >
      <ResponsiveContainer width="100%" height="100%">
        {shape === 'area' ? (
          <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            {axes}
            <Area
              type="monotone"
              dataKey="value"
              name={definition.label}
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.1}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            {axes}
            <Line
              type="monotone"
              dataKey="value"
              name={definition.label}
              stroke={color}
              strokeWidth={2}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </ChartFrame>
  );
}
