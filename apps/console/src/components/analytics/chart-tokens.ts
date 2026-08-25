import { formatCurrencyMinor, formatNumber, formatPercent } from '@/lib/format';

/**
 * Chart tokens and value formatting, deliberately free of a `'use client'`
 * directive.
 *
 * `chart-theme.tsx` is a client module, and a client module's exports do not
 * reach a server component as themselves — the bundler substitutes a client
 * reference, so a plain array read from there is not an array. That failure is
 * invisible to `tsc` and to jsdom, and it is quiet at runtime: reading
 * `VIZ_SERIES.length` off a reference yields `undefined`, `index % undefined`
 * is `NaN`, and a colour swatch simply renders blank.
 *
 * Values and pure functions therefore live here, where a server component may
 * read them; the React components that render them stay in `chart-theme.tsx`.
 * The palette rationale is documented there, next to the components that make
 * the legend and table view mandatory.
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
