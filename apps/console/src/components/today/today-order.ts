import {
  TODAY_ITEM_KINDS,
  TODAY_ITEM_KIND_HINTS_DE,
  TODAY_ITEM_KIND_LABELS_DE,
  type TodayItem,
  type TodayItemKind,
  type TodaySeverity,
} from '@/server/ops-port';

/**
 * The ordering rule of the daily start page (spec §8).
 *
 * It is a rule, not a preference, so it lives in a pure module the tests can
 * pin down: **errors first**, because a broken tracker or sync makes every
 * number below it unreliable; **then approvals**, because they block other
 * people's work; **then recommendations**, which this operator can decide
 * alone. Warnings, matured results, new proposals and immature cohorts follow
 * in descending urgency.
 */

const KIND_RANK: Readonly<Record<TodayItemKind, number>> = Object.fromEntries(
  TODAY_ITEM_KINDS.map((kind, index) => [kind, index]),
) as Record<TodayItemKind, number>;

const SEVERITY_RANK: Readonly<Record<TodaySeverity, number>> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

export function todayKindRank(kind: TodayItemKind): number {
  return KIND_RANK[kind];
}

/**
 * Sorts by kind, then severity, then age — oldest first, because something that
 * has been waiting since yesterday is more urgent than the same thing raised a
 * minute ago. Stable and non-mutating.
 */
export function orderTodayItems(items: readonly TodayItem[]): TodayItem[] {
  return [...items].sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  });
}

export interface TodayGroup {
  kind: TodayItemKind;
  labelDe: string;
  hintDe: string;
  items: TodayItem[];
}

/** Groups the ordered items, dropping kinds that have nothing to show. */
export function groupTodayItems(items: readonly TodayItem[]): TodayGroup[] {
  const ordered = orderTodayItems(items);
  const groups: TodayGroup[] = [];
  for (const kind of TODAY_ITEM_KINDS) {
    const inKind = ordered.filter((item) => item.kind === kind);
    if (inKind.length === 0) continue;
    groups.push({
      kind,
      labelDe: TODAY_ITEM_KIND_LABELS_DE[kind],
      hintDe: TODAY_ITEM_KIND_HINTS_DE[kind],
      items: inKind,
    });
  }
  return groups;
}

/** Items that make every number below them unreliable until they are resolved. */
export function blockingErrorCount(items: readonly TodayItem[]): number {
  return items.filter((item) => item.kind === 'ERROR').length;
}
