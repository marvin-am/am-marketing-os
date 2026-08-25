'use client';

import * as React from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { cn, Button } from '@am/ui';
import { moveItem } from './move';

/**
 * Reordering that does not require a mouse.
 *
 * Drag and drop is the fast path, so every row carries a dnd-kit handle wired to
 * both a pointer and a keyboard sensor. But dnd-kit's keyboard drag depends on
 * measured layout, which makes it a poor *only* option — so every row also has
 * plain "nach oben" / "nach unten" buttons with German accessible names. They
 * are ordinary focusable buttons: tab to one, press Enter, the item moves. That
 * is the path an operator on a keyboard actually uses, and the path the tests
 * exercise.
 *
 * Both routes call the same `onReorder(from, to)`, so there is exactly one
 * reorder implementation per list regardless of input device.
 */

export interface OrderableEntry {
  id: string;
  /** German accessible name, used in move buttons and drag announcements. */
  labelDe: string;
  content: React.ReactNode;
}

export interface OrderableListProps {
  entries: readonly OrderableEntry[];
  onReorder: (from: number, to: number) => void;
  /** German noun for one entry, e.g. „Schritt“. */
  itemNounDe: string;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
  emptyDe?: string;
}

function germanAnnouncements(itemNounDe: string, labelOf: (id: string) => string): Announcements {
  return {
    onDragStart: ({ active }) =>
      `${itemNounDe} ${labelOf(String(active.id))} aufgenommen. Mit den Pfeiltasten verschieben, mit der Leertaste ablegen.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${itemNounDe} ${labelOf(String(active.id))} schwebt über ${labelOf(String(over.id))}.`
        : `${itemNounDe} ${labelOf(String(active.id))} befindet sich außerhalb der Liste.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${itemNounDe} ${labelOf(String(active.id))} wurde bei ${labelOf(String(over.id))} abgelegt.`
        : `${itemNounDe} ${labelOf(String(active.id))} wurde abgelegt; die Reihenfolge bleibt unverändert.`,
    onDragCancel: ({ active }) =>
      `Verschieben abgebrochen. ${itemNounDe} ${labelOf(String(active.id))} bleibt an seiner Position.`,
  };
}

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'Mit der Leertaste aufnehmen, mit den Pfeiltasten verschieben, erneut Leertaste zum Ablegen, Escape zum Abbrechen. ' +
    'Alternativ stehen in jeder Zeile die Schaltflächen „nach oben“ und „nach unten“ zur Verfügung.',
};

interface SortableRowProps {
  entry: OrderableEntry;
  index: number;
  total: number;
  itemNounDe: string;
  disabled: boolean;
  className?: string;
  onMove: (from: number, to: number) => void;
}

function SortableRow({
  entry,
  index,
  total,
  itemNounDe,
  disabled,
  className,
  onMove,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.id, disabled });

  return (
    <li
      ref={setNodeRef}
      data-testid={`orderable-item-${entry.id}`}
      data-position={index + 1}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition: transition ?? undefined,
      }}
      className={cn(
        'flex items-start gap-1 rounded-md border border-border bg-surface',
        isDragging && 'z-10 shadow-md',
        className,
      )}
    >
      <div className="flex flex-col items-center gap-0.5 py-1 pl-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          disabled={disabled}
          aria-label={`${itemNounDe} ${entry.labelDe} mit der Tastatur oder Maus verschieben`}
          className={cn(
            'flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            'hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50',
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          disabled={disabled || index === 0}
          aria-label={`${itemNounDe} ${entry.labelDe} nach oben verschieben`}
          onClick={() => onMove(index, index - 1)}
        >
          <ChevronUp aria-hidden="true" className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          disabled={disabled || index === total - 1}
          aria-label={`${itemNounDe} ${entry.labelDe} nach unten verschieben`}
          onClick={() => onMove(index, index + 1)}
        >
          <ChevronDown aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div className="min-w-0 flex-1 py-1 pr-1">{entry.content}</div>
    </li>
  );
}

export function OrderableList({
  entries,
  onReorder,
  itemNounDe,
  disabled = false,
  className,
  itemClassName,
  emptyDe,
}: OrderableListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const labelOf = React.useCallback(
    (id: string) => entries.find((entry) => entry.id === id)?.labelDe ?? id,
    [entries],
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = entries.findIndex((entry) => entry.id === active.id);
    const to = entries.findIndex((entry) => entry.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(from, to);
  };

  if (entries.length === 0) {
    return emptyDe ? (
      <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        {emptyDe}
      </p>
    ) : null;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements: germanAnnouncements(itemNounDe, labelOf),
        screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
      }}
    >
      <SortableContext
        items={entries.map((entry) => entry.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className={cn('flex flex-col gap-2', className)}>
          {entries.map((entry, index) => (
            <SortableRow
              key={entry.id}
              entry={entry}
              index={index}
              total={entries.length}
              itemNounDe={itemNounDe}
              disabled={disabled}
              className={itemClassName}
              onMove={onReorder}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

export { moveItem };
