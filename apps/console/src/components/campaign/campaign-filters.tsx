import Link from 'next/link';
import { CAMPAIGN_STATE_LABELS_DE, CAMPAIGN_STATES, type CampaignState } from '@am/domain';
import { Button, cn, inputVariants, Label } from '@am/ui';
import { Search } from 'lucide-react';
import type { CampaignListQuery } from '@/server/campaign-port';

/**
 * Filters as a plain GET form.
 *
 * Every filter ends up in the URL, so a filtered list is linkable and the back
 * button behaves. It also means the list keeps working without client-side
 * JavaScript, which matters for a tool people live in all day.
 */
export interface CampaignFiltersProps {
  query: CampaignListQuery;
  facets: { angles: string[]; offers: string[]; states: CampaignState[] };
  /** Number of rows the current filter produces, shown next to the button. */
  total: number;
}

export function CampaignFilters({ query, facets, total }: CampaignFiltersProps) {
  const active =
    query.states.length > 0 ||
    query.angles.length > 0 ||
    query.offers.length > 0 ||
    query.from !== null ||
    query.to !== null ||
    (query.search ?? '') !== '';

  return (
    <form
      method="get"
      action="/kampagnen"
      aria-label="Kampagnen filtern"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
    >
      <div className="grid gap-4 lg:grid-cols-4">
        <Field id="filter-suche" label="Name enthält">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              id="filter-suche"
              name="q"
              type="search"
              defaultValue={query.search ?? ''}
              placeholder="z. B. Potenzialanalyse"
              className={cn(inputVariants(), 'pl-9')}
            />
          </div>
        </Field>

        <Field id="filter-angle" label="Angle">
          <select
            id="filter-angle"
            name="angle"
            defaultValue={query.angles[0] ?? ''}
            className={cn(inputVariants())}
          >
            <option value="">Alle Angles</option>
            {facets.angles.map((angle) => (
              <option key={angle} value={angle}>
                {angle}
              </option>
            ))}
          </select>
        </Field>

        <Field id="filter-offer" label="Offer">
          <select
            id="filter-offer"
            name="offer"
            defaultValue={query.offers[0] ?? ''}
            className={cn(inputVariants())}
          >
            <option value="">Alle Offers</option>
            {facets.offers.map((offer) => (
              <option key={offer} value={offer}>
                {offer}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field id="filter-von" label="Geändert ab">
            <input
              id="filter-von"
              name="von"
              type="date"
              defaultValue={query.from ?? ''}
              className={cn(inputVariants())}
            />
          </Field>
          <Field id="filter-bis" label="Geändert bis">
            <input
              id="filter-bis"
              name="bis"
              type="date"
              defaultValue={query.to ?? ''}
              className={cn(inputVariants())}
            />
          </Field>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Status
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {CAMPAIGN_STATES.filter((state) => facets.states.includes(state) || query.states.includes(state)).map(
            (state) => (
              <label
                key={state}
                htmlFor={`filter-status-${state}`}
                className="inline-flex min-h-9 items-center gap-2 text-sm text-foreground"
              >
                <input
                  id={`filter-status-${state}`}
                  type="checkbox"
                  name="status"
                  value={state}
                  defaultChecked={query.states.includes(state)}
                  className="size-4 rounded border-border-strong accent-[var(--color-brand)]"
                />
                {CAMPAIGN_STATE_LABELS_DE[state]}
              </label>
            ),
          )}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm">
          Filter anwenden
        </Button>
        {active ? (
          <Button asChild variant="ghost" size="sm">
            <Link href="/kampagnen">Filter zurücksetzen</Link>
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground" role="status">
          {total === 1 ? '1 Kampagne' : `${total} Kampagnen`} entsprechen dem aktuellen Filter.
        </p>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
