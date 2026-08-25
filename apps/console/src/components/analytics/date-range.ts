import type { DateRange } from '@/server/analytics-port';

/**
 * Date-range resolution for the Performance screen.
 *
 * Pure and shared by the server page (which reads the query string) and the
 * client filter bar (which writes it), so the selected range is a URL, not a
 * piece of component state — a link to "Fördermittel-Check, letzte 90 Tage"
 * has to reproduce the same numbers for the next person who opens it.
 */

const MS_PER_DAY = 86_400_000;

export function toDayIndex(iso: string): number {
  return Math.floor(Date.parse(iso) / MS_PER_DAY);
}

export function toIsoDate(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}

export interface RangePreset {
  id: string;
  labelDe: string;
  /** Length in days, counting today. `null` marks the custom range. */
  days: number | null;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: 'letzte-7-tage', labelDe: 'Letzte 7 Tage', days: 7 },
  { id: 'letzte-30-tage', labelDe: 'Letzte 30 Tage', days: 30 },
  { id: 'letzte-90-tage', labelDe: 'Letzte 90 Tage', days: 90 },
  { id: 'letzte-180-tage', labelDe: 'Letzte 180 Tage', days: 180 },
  { id: 'letzte-12-monate', labelDe: 'Letzte 12 Monate', days: 365 },
  { id: 'gesamter-zeitraum', labelDe: 'Gesamter Zeitraum', days: 548 },
  { id: 'benutzerdefiniert', labelDe: 'Benutzerdefiniert', days: null },
];

export const DEFAULT_PRESET_ID = 'letzte-30-tage';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function rangeForPreset(presetId: string, now: string): DateRange {
  const preset = RANGE_PRESETS.find((candidate) => candidate.id === presetId);
  const days = preset?.days ?? 30;
  const end = toDayIndex(now);
  return { from: toIsoDate(end - (days - 1)), to: toIsoDate(end) };
}

export interface RangeSelection {
  range: DateRange;
  presetId: string;
}

/**
 * Resolves the query string into a range. Unparseable or reversed input falls
 * back to the default preset rather than rendering an empty or negative period.
 */
export function resolveRange(
  params: { zeitraum?: string; von?: string; bis?: string },
  now: string,
): RangeSelection {
  const requested = params.zeitraum ?? DEFAULT_PRESET_ID;

  if (requested === 'benutzerdefiniert') {
    const from = params.von && ISO_DATE.test(params.von) ? params.von : null;
    const to = params.bis && ISO_DATE.test(params.bis) ? params.bis : null;
    if (from && to && from <= to) {
      return { range: { from, to }, presetId: 'benutzerdefiniert' };
    }
    return { range: rangeForPreset(DEFAULT_PRESET_ID, now), presetId: DEFAULT_PRESET_ID };
  }

  const preset = RANGE_PRESETS.find((candidate) => candidate.id === requested);
  const presetId = preset ? preset.id : DEFAULT_PRESET_ID;
  return { range: rangeForPreset(presetId, now), presetId };
}

/** Number of days in an inclusive range. */
export function rangeLengthDays(range: DateRange): number {
  return Math.max(1, toDayIndex(range.to) - toDayIndex(range.from) + 1);
}
