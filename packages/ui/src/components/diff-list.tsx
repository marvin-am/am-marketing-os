'use client';

import * as React from 'react';
import { Minus, PenLine, Plus } from 'lucide-react';
import { cn } from '../lib/cn';
import { formatNumberDe, NO_VALUE } from '../lib/format';

export type DiffChange = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffEntry {
  /** Dot path into the audited payload, e.g. `offer.priceMinor`. */
  path: string;
  /** German field label. Falls back to the path when absent. */
  labelDe?: string;
  before: unknown;
  after: unknown;
  change: DiffChange;
}

const MISSING = Symbol('missing');

/** Path used when the audited payload is a bare value rather than an object. */
const ROOT_PATH = '(Wert)';

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.set(prefix === '' ? ROOT_PATH : prefix, value);
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    // An empty payload contributes no rows; an empty *nested* object is a leaf.
    if (prefix !== '') out.set(prefix, value);
    return out;
  }
  for (const [key, child] of entries) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Turns an audit row's redacted `before` / `after` payloads into a flat,
 * renderable list of field changes.
 */
export function buildDiffEntries(
  before: unknown,
  after: unknown,
  labels: Readonly<Record<string, string>> = {},
): DiffEntry[] {
  const beforeMap = flatten(before ?? {}, '', new Map());
  const afterMap = flatten(after ?? {}, '', new Map());
  const paths = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();

  return paths.map((path) => {
    const b = beforeMap.has(path) ? beforeMap.get(path) : MISSING;
    const a = afterMap.has(path) ? afterMap.get(path) : MISSING;
    let change: DiffChange;
    if (b === MISSING) change = 'added';
    else if (a === MISSING) change = 'removed';
    else change = sameValue(b, a) ? 'unchanged' : 'changed';
    return {
      path,
      labelDe: labels[path],
      before: b === MISSING ? undefined : b,
      after: a === MISSING ? undefined : a,
      change,
    };
  });
}

/** Renders a single audited value in German, without inventing anything. */
export function formatDiffValue(value: unknown): string {
  if (value === undefined) return 'nicht gesetzt';
  if (value === null) return NO_VALUE;
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'number') return formatNumberDe(value, { maximumFractionDigits: 4 });
  if (typeof value === 'string') return value === '' ? '(leer)' : value;
  return JSON.stringify(value);
}

const CHANGE_META: Record<
  DiffChange,
  { labelDe: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  added: { labelDe: 'Hinzugefügt', icon: Plus, className: 'text-success' },
  removed: { labelDe: 'Entfernt', icon: Minus, className: 'text-destructive' },
  changed: { labelDe: 'Geändert', icon: PenLine, className: 'text-warning' },
  unchanged: { labelDe: 'Unverändert', icon: PenLine, className: 'text-muted-foreground' },
};

export interface DiffListProps extends React.HTMLAttributes<HTMLDivElement> {
  entries: readonly DiffEntry[];
  /** Keep rows whose value did not change. Default: false. */
  includeUnchanged?: boolean;
  /** German text when there is nothing to show. */
  emptyLabel?: string;
}

/**
 * Before/after list for audit and approval views. Each row names the change
 * kind in words and with an icon, so the colour is never the only signal.
 */
export const DiffList = React.forwardRef<HTMLDivElement, DiffListProps>(function DiffList(
  { className, entries, includeUnchanged = false, emptyLabel = 'Keine Änderungen.', ...props },
  ref,
) {
  const visible = includeUnchanged ? entries : entries.filter((e) => e.change !== 'unchanged');

  if (visible.length === 0) {
    return (
      <div
        ref={ref}
        className={cn('rounded-lg border border-border bg-surface-raised px-4 py-6 text-center text-sm text-muted-foreground', className)}
        {...props}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn('divide-y divide-border rounded-lg border border-border bg-surface', className)}
      {...props}
    >
      {visible.map((entry) => {
        const meta = CHANGE_META[entry.change];
        const Icon = meta.icon;
        return (
          <div key={entry.path} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', meta.className)} />
              <span className="font-mono text-xs text-foreground">
                {entry.labelDe ?? entry.path}
              </span>
              <span className={cn('text-xs font-medium', meta.className)}>{meta.labelDe}</span>
            </div>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Vorher
                </dt>
                <dd
                  className={cn(
                    'break-words rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs',
                    entry.change === 'changed' || entry.change === 'removed'
                      ? 'text-muted-foreground line-through decoration-1'
                      : 'text-muted-foreground',
                  )}
                >
                  {formatDiffValue(entry.before)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Nachher
                </dt>
                <dd className="break-words rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs text-foreground">
                  {formatDiffValue(entry.after)}
                </dd>
              </div>
            </dl>
          </div>
        );
      })}
    </div>
  );
});
