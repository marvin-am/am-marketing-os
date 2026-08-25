import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TodayItem } from '@/server/ops-port';
import { TodayBoard } from './today-board';
import { orderTodayItems } from './today-order';

const GENERATED_AT = '2026-08-25T07:30:00.000Z';

function item(overrides: Partial<TodayItem> & Pick<TodayItem, 'id' | 'kind'>): TodayItem {
  return {
    titleDe: `Titel ${overrides.id}`,
    detailDe: 'Detail',
    href: '/kampagnen',
    hrefLabelDe: 'Öffnen',
    occurredAt: GENERATED_AT,
    campaignNameDe: null,
    badge: null,
    severity: 'MEDIUM',
    ...overrides,
  };
}

function renderedKinds(): string[] {
  return screen
    .getAllByRole('link')
    .map((node) => node.getAttribute('data-today-kind'))
    .filter((kind): kind is string => kind !== null);
}

describe('TodayBoard', () => {
  it('places errors before approvals and approvals before recommendations', () => {
    // Deliberately supplied in the wrong order.
    const items = [
      item({ id: 'rec', kind: 'RECOMMENDATION' }),
      item({ id: 'proposal', kind: 'PROPOSAL' }),
      item({ id: 'approval', kind: 'APPROVAL' }),
      item({ id: 'error', kind: 'ERROR' }),
    ];

    render(<TodayBoard generatedAt={GENERATED_AT} activeCampaigns={[]} items={items} />);

    expect(renderedKinds()).toEqual(['ERROR', 'APPROVAL', 'RECOMMENDATION', 'PROPOSAL']);
  });

  it('sorts by severity and then by age inside one kind', () => {
    const items = [
      item({ id: 'low-new', kind: 'ERROR', severity: 'LOW', occurredAt: '2026-08-25T07:00:00.000Z' }),
      item({ id: 'high-new', kind: 'ERROR', severity: 'HIGH', occurredAt: '2026-08-25T07:00:00.000Z' }),
      item({ id: 'high-old', kind: 'ERROR', severity: 'HIGH', occurredAt: '2026-08-24T07:00:00.000Z' }),
    ];

    expect(orderTodayItems(items).map((entry) => entry.id)).toEqual([
      'high-old',
      'high-new',
      'low-new',
    ]);
  });

  it('warns that errors invalidate the numbers below them', () => {
    render(
      <TodayBoard
        generatedAt={GENERATED_AT}
        activeCampaigns={[]}
        items={[item({ id: 'error', kind: 'ERROR' })]}
      />,
    );

    expect(screen.getByText('1 kritischer Fehler blockiert die Auswertung')).toBeInTheDocument();
  });

  it('renders a calm empty state on a genuinely empty day', () => {
    render(<TodayBoard generatedAt={GENERATED_AT} activeCampaigns={[]} items={[]} />);

    expect(screen.getByText('Heute ist nichts offen.')).toBeInTheDocument();
    expect(screen.queryByTestId('today-groups')).not.toBeInTheDocument();
    // No manufactured urgency: nothing claims a blocking error.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows active campaigns with their data maturity, never a bare number', () => {
    render(
      <TodayBoard
        generatedAt={GENERATED_AT}
        activeCampaigns={[
          {
            id: 'c1',
            nameDe: 'Q3 Neukunden',
            state: 'LIVE',
            errorState: null,
            spendTodayMinor: 41_250,
            currency: 'EUR',
            leadsToday: 6,
            targetCostPerLeadMinor: 6_000,
            costPerLeadMinor: 6_875,
            maturity: 'IMMATURE',
            attributionCoverage: null,
            href: '/kampagnen/c1',
          },
        ]}
        items={[]}
      />,
    );

    expect(screen.getByText('Q3 Neukunden')).toBeInTheDocument();
    expect(screen.getByText('Unreif')).toBeInTheDocument();
    // A missing coverage is never rendered as 0 %.
    expect(screen.getByText('keine Daten')).toBeInTheDocument();
  });
});
