import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CampaignFilters } from '@/components/campaign/campaign-filters';
import { CampaignTable } from '@/components/campaign/campaign-table';
import { getCampaignPort } from '@/server/campaign-fixtures';
import type { CampaignListPage, CampaignListQuery } from '@/server/campaign-port';
import { buildCampaignHref, isFiltered, parseCampaignQuery } from './query';

const port = getCampaignPort();

async function list(params: Record<string, string | string[] | undefined> = {}): Promise<{
  query: CampaignListQuery;
  page: CampaignListPage;
}> {
  const query = parseCampaignQuery(params);
  return { query, page: await port.listCampaigns(query) };
}

describe('parseCampaignQuery', () => {
  it('reads state, angle, offer, date and pagination out of the URL', () => {
    const query = parseCampaignQuery({
      status: ['LIVE', 'PAUSED', 'NOT_A_STATE'],
      angle: 'Planbare Anfragen statt Empfehlungsglück',
      offer: 'Kostenlose Potenzialanalyse',
      von: '2026-08-01',
      bis: '2026-08-31',
      q: 'Handwerk',
      seite: '2',
    });

    expect(query.states).toEqual(['LIVE', 'PAUSED']);
    expect(query.angles).toEqual(['Planbare Anfragen statt Empfehlungsglück']);
    expect(query.offers).toEqual(['Kostenlose Potenzialanalyse']);
    expect(query.from).toBe('2026-08-01');
    expect(query.to).toBe('2026-08-31');
    expect(query.search).toBe('Handwerk');
    expect(query.page).toBe(2);
    expect(isFiltered(query)).toBe(true);
  });

  it('falls back to an unfiltered first page and ignores malformed input', () => {
    const query = parseCampaignQuery({ seite: 'zwei', von: '01.08.2026' });
    expect(query.page).toBe(1);
    expect(query.from).toBeNull();
    expect(isFiltered(query)).toBe(false);
  });

  it('round-trips a query through the URL it builds', () => {
    const query = parseCampaignQuery({ status: 'LIVE', q: 'Dach' });
    const href = buildCampaignHref(query, 3);
    const roundTripped = parseCampaignQuery(
      Object.fromEntries(new URL(href, 'https://example.test').searchParams.entries()),
    );
    expect(roundTripped.states).toEqual(['LIVE']);
    expect(roundTripped.search).toBe('Dach');
    expect(roundTripped.page).toBe(3);
  });
});

describe('campaign list', () => {
  it('filters by state and by angle', async () => {
    const byState = await list({ status: 'LIVE' });
    expect(byState.page.rows.length).toBeGreaterThan(0);
    expect(byState.page.rows.every((row) => row.state === 'LIVE')).toBe(true);

    const angle = byState.page.rows[0].angleName;
    const byAngle = await list({ angle });
    expect(byAngle.page.rows.every((row) => row.angleName === angle)).toBe(true);
  });

  it('paginates and keeps the filter in the page links', async () => {
    const { query, page } = await list({ status: ['LIVE', 'PAUSED', 'COMPLETED'] });
    expect(buildCampaignHref(query, 2)).toContain('seite=2');
    expect(buildCampaignHref(query, 2)).toContain('status=LIVE');
    expect(page.page).toBe(1);
  });

  it('renders each row with its state, angle, offer, metric, budget, action and sync', async () => {
    const { query, page } = await list();
    render(
      <CampaignTable
        page={page}
        filtered={isFiltered(query)}
        buildPageHref={(next) => buildCampaignHref(query, next)}
      />,
    );

    const first = page.rows[0];
    const row = document.querySelector(`[data-campaign-row="${first.id}"]`) as HTMLElement;
    expect(row).not.toBeNull();

    const cells = within(row);
    expect(cells.getByRole('link', { name: first.name })).toHaveAttribute(
      'href',
      `/kampagnen/${first.id}/strategie`,
    );
    expect(row).toHaveTextContent(first.angleName);
    expect(row).toHaveTextContent(first.offerName);
    expect(row).toHaveTextContent(first.nextAction.labelDe);
    expect(row).toHaveAttribute('data-reality', first.reality);
    expect(row).toHaveTextContent('META');
    expect(row).toHaveTextContent('HUBSPOT');
    // The primary metric always carries its basis, never a bare number.
    expect(row.querySelector('[data-am-metric]')).not.toBeNull();
  });

  it('tells the operator how to create the first campaign when there is none', () => {
    const emptyQuery = parseCampaignQuery({});
    render(
      <CampaignTable
        page={{
          rows: [],
          total: 0,
          page: 1,
          pageSize: 10,
          facets: { angles: [], offers: [], states: [] },
        }}
        filtered={false}
        buildPageHref={(next) => buildCampaignHref(emptyQuery, next)}
      />,
    );

    expect(screen.getByText('Noch keine Kampagne angelegt.')).toBeInTheDocument();
    expect(screen.getByText(/Angle und den Offer an/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zur Library' })).toHaveAttribute('href', '/library');
  });

  it('offers a reset instead of a dead end when a filter matches nothing', () => {
    const query = parseCampaignQuery({ q: 'gibt-es-nicht' });
    render(
      <CampaignTable
        page={{
          rows: [],
          total: 0,
          page: 1,
          pageSize: 10,
          facets: { angles: [], offers: [], states: [] },
        }}
        filtered={isFiltered(query)}
        buildPageHref={(next) => buildCampaignHref(query, next)}
      />,
    );

    expect(screen.getByText('Keine Kampagne entspricht diesem Filter.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Filter zurücksetzen' })).toHaveAttribute(
      'href',
      '/kampagnen',
    );
  });
});

describe('CampaignFilters', () => {
  it('submits every filter as a GET query so the list stays linkable', async () => {
    const { query, page } = await list({ status: 'LIVE' });
    render(<CampaignFilters query={query} facets={page.facets} total={page.total} />);

    const form = screen.getByRole('form', { name: 'Kampagnen filtern' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/kampagnen');

    expect(screen.getByLabelText('Name enthält')).toBeInTheDocument();
    expect(screen.getByLabelText('Angle')).toBeInTheDocument();
    expect(screen.getByLabelText('Offer')).toBeInTheDocument();
    expect(screen.getByLabelText('Geändert ab')).toBeInTheDocument();
    expect(screen.getByLabelText('Geändert bis')).toBeInTheDocument();
    expect(screen.getByLabelText('Live')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Filter anwenden' })).toBeInTheDocument();
  });
});
