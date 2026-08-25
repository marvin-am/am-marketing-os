'use client';

import * as React from 'react';
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_LABELS_DE,
  type ConfidenceLabel,
  FUNNEL_KINDS,
  type FunnelKind,
  type LearningCard,
} from '@am/domain';
import {
  Button,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@am/ui';
import { Search } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import { ALL_FILTER_VALUE, FUNNEL_KIND_LABELS_DE } from './labels';
import { LearningCardView } from './learning-card';

export interface LearningsBrowserProps {
  cards: readonly LearningCard[];
}

interface Filters {
  query: string;
  angle: string;
  offer: string;
  funnelKind: string;
  confidence: string;
}

const EMPTY_FILTERS: Filters = {
  query: '',
  angle: ALL_FILTER_VALUE,
  offer: ALL_FILTER_VALUE,
  funnelKind: ALL_FILTER_VALUE,
  confidence: ALL_FILTER_VALUE,
};

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, 'de-DE'),
  );
}

function matches(card: LearningCard, filters: Filters): boolean {
  if (filters.angle !== ALL_FILTER_VALUE && card.angleName !== filters.angle) return false;
  if (filters.offer !== ALL_FILTER_VALUE && card.offerName !== filters.offer) return false;
  if (filters.funnelKind !== ALL_FILTER_VALUE && card.funnelKind !== filters.funnelKind) return false;
  if (filters.confidence !== ALL_FILTER_VALUE && card.confidence !== filters.confidence) return false;

  const query = filters.query.trim().toLocaleLowerCase('de-DE');
  if (query.length === 0) return true;

  const haystack = [
    card.titleDe,
    card.whatWasTestedDe,
    card.outcomeDe,
    card.angleName,
    card.offerName,
    card.creativeConceptDe,
    card.audienceDe,
    card.possibleExplanationDe,
    card.suggestedNextTestDe,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('de-DE');

  return haystack.includes(query);
}

/**
 * Filter and search over the learning memory.
 *
 * Filtering is client-side because the whole set is small and an operator
 * narrowing "which angle worked for which offer" should not wait for a round
 * trip. Every control is wired; an empty result says so in German instead of
 * rendering nothing.
 */
export function LearningsBrowser({ cards }: LearningsBrowserProps): React.JSX.Element {
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);

  const angles = React.useMemo(() => distinct(cards.map((card) => card.angleName)), [cards]);
  const offers = React.useMemo(() => distinct(cards.map((card) => card.offerName)), [cards]);
  const funnelKinds = React.useMemo(
    () =>
      FUNNEL_KINDS.filter((kind: FunnelKind) => cards.some((card) => card.funnelKind === kind)),
    [cards],
  );

  const visible = React.useMemo(() => cards.filter((card) => matches(card, filters)), [cards, filters]);
  const isFiltered = React.useMemo(
    () =>
      filters.query.trim().length > 0 ||
      filters.angle !== ALL_FILTER_VALUE ||
      filters.offer !== ALL_FILTER_VALUE ||
      filters.funnelKind !== ALL_FILTER_VALUE ||
      filters.confidence !== ALL_FILTER_VALUE,
    [filters],
  );

  const searchId = React.useId();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="grid gap-3 lg:grid-cols-5">
          <div className="flex flex-col gap-1.5 lg:col-span-2">
            <Label htmlFor={searchId}>Suche</Label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={searchId}
                type="search"
                value={filters.query}
                placeholder="Titel, Ergebnis, Zielgruppe …"
                className="pl-9"
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              />
            </div>
          </div>

          <FilterSelect
            labelDe="Angle"
            value={filters.angle}
            allLabelDe="Alle Angles"
            options={angles.map((angle) => ({ value: angle, labelDe: angle }))}
            onChange={(value) => setFilters((current) => ({ ...current, angle: value }))}
          />
          <FilterSelect
            labelDe="Offer"
            value={filters.offer}
            allLabelDe="Alle Offers"
            options={offers.map((offer) => ({ value: offer, labelDe: offer }))}
            onChange={(value) => setFilters((current) => ({ ...current, offer: value }))}
          />
          <FilterSelect
            labelDe="Funnel-Typ"
            value={filters.funnelKind}
            allLabelDe="Alle Funnel-Typen"
            options={funnelKinds.map((kind) => ({ value: kind, labelDe: FUNNEL_KIND_LABELS_DE[kind] }))}
            onChange={(value) => setFilters((current) => ({ ...current, funnelKind: value }))}
          />
          <FilterSelect
            labelDe="Belegstärke"
            value={filters.confidence}
            allLabelDe="Alle Belegstärken"
            options={CONFIDENCE_LABELS.map((label: ConfidenceLabel) => ({
              value: label,
              labelDe: CONFIDENCE_LABELS_DE[label],
            }))}
            onChange={(value) => setFilters((current) => ({ ...current, confidence: value }))}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            <span data-am-numeric="">{formatNumber(visible.length)}</span> von{' '}
            <span data-am-numeric="">{formatNumber(cards.length)}</span> Learnings
          </p>
          {isFiltered ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Filter zurücksetzen
            </Button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="Keine Learnings für diese Filter"
          description="Zu dieser Kombination aus Angle, Offer, Funnel-Typ und Belegstärke liegt kein Learning vor. Setzen Sie die Filter zurück, um alle Karten zu sehen."
          action={
            <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Filter zurücksetzen
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {visible.map((card) => (
            <LearningCardView key={`${card.id}-${card.version}`} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

interface FilterSelectProps {
  labelDe: string;
  allLabelDe: string;
  value: string;
  options: Array<{ value: string; labelDe: string }>;
  onChange: (value: string) => void;
}

function FilterSelect({
  labelDe,
  allLabelDe,
  value,
  options,
  onChange,
}: FilterSelectProps): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{labelDe}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={labelDe}>
          <SelectValue placeholder={allLabelDe} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>{allLabelDe}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.labelDe}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
