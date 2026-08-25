'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@am/ui';
import { formatCurrencyMinor, formatNumber } from '@/lib/format';
import type { BreakdownRow } from '@/server/analytics-port';
import { ChartFrame } from './chart-frame';
import {
  AXIS_PROPS,
  formatAxisValue,
  GRID_PROPS,
  VIZ_SERIES,
  VizTooltip,
  type VizTooltipEntry,
} from './chart-theme';

export interface BreakdownBarChartProps {
  titleDe: string;
  descriptionDe?: React.ReactNode;
  rows: readonly BreakdownRow[];
  /** Rows beyond this are folded into "Übrige" rather than given new colours. */
  maxRows?: number;
}

interface BarRow {
  key: string;
  labelDe: string;
  spendMinor: number;
  leads: number;
  cplMinor: number | null;
}

function shorten(label: string, max = 34): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/**
 * Spend per entity, sorted descending.
 *
 * One measure, one hue: identity comes from the category axis, not from colour,
 * so filtering the list never repaints the survivors. Cost per lead lives in the
 * table beside it rather than on a second axis.
 */
export function BreakdownBarChart({
  titleDe,
  descriptionDe,
  rows,
  maxRows = 8,
}: BreakdownBarChartProps): React.JSX.Element {
  const bars: BarRow[] = React.useMemo(() => {
    const sorted = [...rows].sort((a, b) => b.counters.spendMinor - a.counters.spendMinor);
    const head = sorted.slice(0, maxRows);
    const tail = sorted.slice(maxRows);

    const mapped: BarRow[] = head.map((row) => ({
      key: row.key,
      labelDe: shorten(row.labelDe),
      spendMinor: row.counters.spendMinor,
      leads: row.counters.leads,
      cplMinor: row.metrics.cpl.value,
    }));

    if (tail.length > 0) {
      const spendMinor = tail.reduce((sum, row) => sum + row.counters.spendMinor, 0);
      const leads = tail.reduce((sum, row) => sum + row.counters.leads, 0);
      mapped.push({
        key: '__rest__',
        labelDe: `Übrige (${tail.length})`,
        spendMinor,
        leads,
        cplMinor: leads > 0 ? Math.round(spendMinor / leads) : null,
      });
    }
    return mapped;
  }, [rows, maxRows]);

  const byLabel = React.useMemo(() => new Map(bars.map((bar) => [bar.labelDe, bar])), [bars]);
  const hasSpend = bars.some((bar) => bar.spendMinor > 0);

  const rowsFor = React.useCallback(
    (label: string, _payload: readonly VizTooltipEntry[]) => {
      const bar = byLabel.get(label);
      if (!bar) return [];
      return [
        { labelDe: 'Spend', valueDe: formatCurrencyMinor(bar.spendMinor), colorVar: VIZ_SERIES[0] },
        { labelDe: 'Leads', valueDe: formatNumber(bar.leads) },
        {
          labelDe: 'CPL',
          valueDe: formatCurrencyMinor(bar.cplMinor),
          basisDe: `${formatNumber(bar.spendMinor / 100)} € / ${formatNumber(bar.leads)}`,
        },
      ];
    },
    [byLabel],
  );

  const tableView = (
    <Table caption={`${titleDe} – Spend, Leads und CPL`}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Eintrag</TableHead>
          <TableHead scope="col" className="text-right">
            Spend
          </TableHead>
          <TableHead scope="col" className="text-right">
            Leads
          </TableHead>
          <TableHead scope="col" className="text-right">
            CPL
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bars.map((bar) => (
          <TableRow key={bar.key}>
            <TableCell>{bar.labelDe}</TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {formatCurrencyMinor(bar.spendMinor)}
            </TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {formatNumber(bar.leads)}
            </TableCell>
            <TableCell data-am-numeric="" className="text-right">
              {formatCurrencyMinor(bar.cplMinor)}
              <span className="ml-1 text-xs text-muted-foreground">
                {formatNumber(bar.spendMinor / 100)} € / {formatNumber(bar.leads)}
              </span>
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
      isEmpty={!hasSpend}
      emptyTitleDe="Kein Spend im gewählten Zeitraum"
      emptyDescriptionDe="Für diese Aufschlüsselung liegen keine Auslieferungsdaten vor."
      height={Math.max(180, bars.length * 34 + 48)}
      tableView={tableView}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={bars}
          layout="vertical"
          margin={{ top: 4, right: 88, bottom: 4, left: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid {...GRID_PROPS} vertical horizontal={false} />
          <XAxis
            type="number"
            {...AXIS_PROPS}
            axisLine={false}
            tickFormatter={(value: number) => formatAxisValue(value, 'MONEY')}
          />
          <YAxis type="category" dataKey="labelDe" {...AXIS_PROPS} width={220} axisLine={false} />
          <Tooltip cursor={{ fill: 'var(--viz-grid)', fillOpacity: 0.5 }} content={<VizTooltip rowsFor={rowsFor} />} />
          <Bar
            dataKey="spendMinor"
            name="Spend"
            fill={VIZ_SERIES[0]}
            maxBarSize={24}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="spendMinor"
              position="right"
              fill="var(--viz-ink)"
              fontSize={11}
              formatter={(value: unknown) =>
                formatCurrencyMinor(typeof value === 'number' ? value : null, 'EUR', 0)
              }
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
