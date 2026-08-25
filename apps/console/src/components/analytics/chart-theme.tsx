'use client';

import * as React from 'react';
import { formatCurrencyMinor, formatNumber, formatPercent } from '@/lib/format';

/**
 * Chart tokens and chrome shared by every visualisation in Performance.
 *
 * Three rules from the house data-viz conventions are enforced here rather than
 * repeated per chart:
 *
 * 1. **Colour is never the only encoding.** Series carry a legend and a direct
 *    label, and every chart ships with a table view of the same numbers.
 * 2. **The palette is validated, not eyeballed.** The four categorical slots and
 *    their dark-mode steps below pass the lightness band, chroma floor, adjacent
 *    CVD separation (worst ΔE 9.1 light / 8.4 dark) and normal-vision floor
 *    against the console's own surfaces. Three of the light steps sit under 3:1
 *    contrast, which is why the table view is mandatory rather than optional.
 * 3. **Axis and tooltip text is German, with tabular figures.**
 *
 * The tokens are injected as CSS custom properties so the dark theme — which is
 * class driven on `<html>` — swaps them without re-rendering the chart.
 */

export const VIZ_STYLES = `
[data-am-viz] {
  --viz-1: #2a78d6;
  --viz-2: #eb6834;
  --viz-3: #1baf7a;
  --viz-4: #eda100;
  --viz-muted: #a1a1aa;
  --viz-grid: #e4e4e7;
  --viz-axis: #d4d4d8;
  --viz-ink: #62626b;
  --viz-surface: #ffffff;
}
.dark [data-am-viz] {
  --viz-1: #3987e5;
  --viz-2: #d95926;
  --viz-3: #199e70;
  --viz-4: #c98500;
  --viz-muted: #6b6b74;
  --viz-grid: #2c2c2e;
  --viz-axis: #3a3a3d;
  --viz-ink: #a3a3ad;
  --viz-surface: #101012;
}
`;

/**
 * Declared by every chart frame. React hoists and de-duplicates by `href`, so a
 * page with eight charts still ships one stylesheet — and a chart rendered on
 * its own (a test, a detail view) still gets its tokens.
 */
export function VizStyles(): React.JSX.Element {
  return (
    <style href="am-viz-palette" precedence="default">
      {VIZ_STYLES}
    </style>
  );
}

export const VIZ_SERIES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)'] as const;
export const VIZ_MUTED = 'var(--viz-muted)';

export const AXIS_PROPS = {
  stroke: 'var(--viz-axis)',
  tick: { fill: 'var(--viz-ink)', fontSize: 11 },
  tickLine: false,
} as const;

export const GRID_PROPS = {
  stroke: 'var(--viz-grid)',
  strokeDasharray: '0',
  vertical: false,
} as const;

/* -------------------------------------------------------------------------- */
/* Value formatting                                                            */
/* -------------------------------------------------------------------------- */

export type VizUnit = 'MONEY' | 'COUNT' | 'RATE';

/** Axis ticks stay short: whole euros, thousands separated. */
export function formatAxisValue(value: number, unit: VizUnit): string {
  switch (unit) {
    case 'MONEY':
      return `${formatNumber(Math.round(value / 100))} €`;
    case 'RATE':
      return formatPercent(value, 0);
    case 'COUNT':
    default:
      return formatNumber(value);
  }
}

/** Tooltips show the exact value in full. */
export function formatExactValue(value: number | null, unit: VizUnit, currency = 'EUR'): string {
  if (value === null || !Number.isFinite(value)) return '–';
  switch (unit) {
    case 'MONEY':
      return formatCurrencyMinor(value, currency);
    case 'RATE':
      return formatPercent(value);
    case 'COUNT':
    default:
      return formatNumber(value);
  }
}

const GERMAN_DAY = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const GERMAN_DAY_LONG = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatAxisDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? date : GERMAN_DAY.format(parsed);
}

export function formatTooltipDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? date : GERMAN_DAY_LONG.format(parsed);
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Permissive shape of what Recharts clones into a custom tooltip element. Only
 * the fields this tooltip reads are declared.
 */
export interface VizTooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string | null;
  color?: string;
}

export interface VizTooltipRow {
  labelDe: string;
  valueDe: string;
  /** German basis line, e.g. "12 / 340". Rendered under the value. */
  basisDe?: string | null;
  colorVar?: string;
}

export interface VizTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: readonly VizTooltipEntry[];
  /** Turns the raw payload into rows. Keeps all formatting in one place. */
  rowsFor: (label: string, payload: readonly VizTooltipEntry[]) => VizTooltipRow[];
  /** German heading, usually the formatted date. */
  headingFor?: (label: string) => string;
}

export function VizTooltip({
  active,
  label,
  payload,
  rowsFor,
  headingFor,
}: VizTooltipProps): React.JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const rawLabel = label === undefined ? '' : String(label);
  const rows = rowsFor(rawLabel, payload);
  if (rows.length === 0) return null;

  return (
    <div className="min-w-44 rounded-md border border-border bg-surface px-3 py-2 shadow-md">
      <p className="mb-1.5 text-xs font-semibold text-foreground">
        {headingFor ? headingFor(rawLabel) : rawLabel}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.labelDe} className="flex items-baseline justify-between gap-4 text-xs">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              {row.colorVar ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: row.colorVar }}
                />
              ) : null}
              {row.labelDe}
            </span>
            <span className="text-right">
              <span data-am-numeric="" className="font-medium text-foreground">
                {row.valueDe}
              </span>
              {row.basisDe ? (
                <span data-am-numeric="" className="block text-[0.6875rem] text-muted-foreground">
                  {row.basisDe}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Legend                                                                      */
/* -------------------------------------------------------------------------- */

export interface VizLegendItem {
  labelDe: string;
  colorVar: string;
  /** A dash pattern or hatch note, so identity survives greyscale. */
  patternDe?: string;
}

/**
 * A legend is always present from two series upwards. A single-series chart gets
 * none — its heading already names what is plotted.
 */
export function VizLegend({
  items,
}: {
  items: readonly VizLegendItem[];
}): React.JSX.Element | null {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.labelDe} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: item.colorVar }}
          />
          <span>{item.labelDe}</span>
          {item.patternDe ? <span className="text-[0.6875rem]">({item.patternDe})</span> : null}
        </li>
      ))}
    </ul>
  );
}
