'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ValidationIssue } from '@am/funnel-schema';
import { Button } from '@am/ui';
import { InlineIssues } from './issue-views';
import { moveItem } from './move';
import { OrderableList } from './orderable';

/**
 * The repeated sub-structures inside a block: problem points, benefits, FAQ
 * entries, process steps, comparison rows, trust badges.
 *
 * They all behave identically — add, reorder, edit, remove, with a minimum and a
 * maximum from the schema — so they are one component rather than fifteen
 * near-copies. Each list item keeps its `key`, which is derived once from its
 * title and then left alone, for the same reason answer option ids are frozen.
 */

export interface ItemListEditorProps<T> {
  labelDe: string;
  /** German noun for one entry, e.g. „Problempunkt“. */
  itemNounDe: string;
  hintDe?: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  titleOf: (item: T) => string;
  /** Builds a new entry; receives the keys already in use. */
  createItem: (takenKeys: string[]) => T;
  onChange: (items: T[]) => void;
  renderItem: (item: T, update: (next: T) => void, index: number) => React.ReactNode;
  min?: number;
  max?: number;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
}

export function ItemListEditor<T>({
  labelDe,
  itemNounDe,
  hintDe,
  items,
  keyOf,
  titleOf,
  createItem,
  onChange,
  renderItem,
  min = 0,
  max = 20,
  disabled = false,
  issues = [],
}: ItemListEditorProps<T>) {
  const atMinimum = items.length <= min;

  return (
    <section className="flex flex-col gap-3" aria-label={labelDe}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{labelDe}</h4>
          {hintDe ? <p className="text-xs text-muted-foreground">{hintDe}</p> : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || items.length >= max}
          title={items.length >= max ? `Höchstens ${max} Einträge möglich.` : undefined}
          onClick={() => onChange([...items, createItem(items.map(keyOf))])}
        >
          <Plus aria-hidden="true" />
          {`${itemNounDe} hinzufügen`}
        </Button>
      </div>

      <OrderableList
        itemNounDe={itemNounDe}
        disabled={disabled}
        emptyDe={`Noch kein Eintrag unter „${labelDe}“.`}
        onReorder={(from, to) => onChange(moveItem(items, from, to))}
        entries={items.map((item, index) => ({
          id: keyOf(item),
          labelDe: titleOf(item),
          content: (
            <div className="flex flex-col gap-2 px-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {`${itemNounDe} ${index + 1}`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || atMinimum}
                  aria-label={`${itemNounDe} „${titleOf(item)}“ entfernen`}
                  title={
                    atMinimum
                      ? `Mindestens ${min} ${itemNounDe}-Einträge sind erforderlich.`
                      : undefined
                  }
                  onClick={() => onChange(items.filter((_, position) => position !== index))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              {renderItem(
                item,
                (next) =>
                  onChange(items.map((entry, position) => (position === index ? next : entry))),
                index,
              )}
            </div>
          ),
        }))}
      />

      <InlineIssues issues={issues} />
    </section>
  );
}
