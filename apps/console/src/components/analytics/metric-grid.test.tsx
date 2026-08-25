import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { computeAllMetrics, emptyCounters, type MetricCounters } from '@am/experiments';
import { assessMaturity } from '@am/experiments';
import type { MetricSnapshot } from '@/server/analytics-port';
import { MetricGrid } from './metric-grid';

/**
 * The rules these screens exist to enforce, asserted on the component that
 * renders every number: a rate always shows its numerator and denominator, a
 * zero denominator is a dash rather than a zero, and a revenue figure is never
 * shown without the attribution coverage it rests on.
 */

const NOW = '2026-08-25T09:00:00.000Z';

function snapshotOf(
  counters: Partial<MetricCounters>,
  options: { coverage?: number | null; cohortStartedAt?: string } = {},
): MetricSnapshot {
  const full: MetricCounters = { ...emptyCounters(), ...counters };
  const maturityAssessment = assessMaturity({
    cohortStartedAt: options.cohortStartedAt ?? '2026-06-01T00:00:00.000Z',
    now: NOW,
    crmMaturityDays: 21,
    observedOutcomes: full.qualifiedVq + full.opportunities + full.closedWon,
  });
  const coverage = options.coverage === undefined ? 0.83 : options.coverage;
  return {
    counters: full,
    metrics: computeAllMetrics(full, {
      crmMaturity: maturityAssessment.maturity,
      attributionCoverage: coverage,
      currency: 'EUR',
    }),
    attributionCoverage: coverage,
    attributedRecords: full.leads,
    maturity: maturityAssessment.maturity,
    maturityAssessment,
    cohortStartedAt: options.cohortStartedAt ?? '2026-06-01T00:00:00.000Z',
    currency: 'EUR',
  };
}

/** German number formats use non-breaking spaces; normalise before comparing. */
function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/[\u00a0\u202f]/g, ' ');
}

function tile(container: HTMLElement, metric: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-metric="${metric}"]`);
  if (!node) throw new Error(`Kachel für ${metric} nicht gefunden`);
  return node;
}

describe('MetricGrid', () => {
  it('renders a rate together with its numerator and denominator', () => {
    const { container } = render(
      <MetricGrid snapshot={snapshotOf({ linkClicks: 12, impressions: 340 })} keys={['ctr']} />,
    );

    const ctr = tile(container, 'ctr');
    expect(ctr.querySelector('[data-am-metric-value]')).toHaveTextContent('3,5 %');
    expect(ctr.querySelector('[data-am-metric-basis]')).toHaveTextContent(
      '12 Link-Klicks / 340 Impressionen',
    );
  });

  it('renders a zero denominator as a dash and never as 0 %', () => {
    const { container } = render(
      <MetricGrid snapshot={snapshotOf({ linkClicks: 0, impressions: 0 })} keys={['ctr']} />,
    );

    const ctr = tile(container, 'ctr');
    const value = ctr.querySelector('[data-am-metric-value]');
    expect(value).toHaveTextContent('–');
    expect(value).not.toHaveTextContent('0 %');
    expect(ctr.textContent).toContain('Kein Nenner: Impressionen = 0.');
  });

  it('renders a cost-per-unit basis in its own units, not as a raw minor amount', () => {
    const { container } = render(
      <MetricGrid snapshot={snapshotOf({ spendMinor: 1_305_465, leads: 310 })} keys={['cpl']} />,
    );

    const cpl = tile(container, 'cpl');
    expect(cpl.querySelector('[data-am-metric-value]')).toHaveTextContent('42,11 €');
    expect(normalize(cpl.querySelector('[data-am-metric-basis]')?.textContent)).toBe(
      '13.054,65 € Spend / 310 Leads',
    );
  });

  it('renders the attribution coverage next to revenue', () => {
    const { container } = render(
      <MetricGrid
        snapshot={snapshotOf({ spendMinor: 1_000_000, revenueMinor: 4_000_000, closedWon: 3 }, { coverage: 0.42 })}
        keys={['revenue', 'roas']}
      />,
    );

    const revenue = tile(container, 'revenue');
    const badge = revenue.querySelector('[data-coverage]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('42 %');
    expect(revenue.textContent).toContain('Attributionsabdeckung');

    // The ROAS built on the same weak matches carries the qualifier too.
    const roas = tile(container, 'roas');
    expect(roas.querySelector('[data-coverage]')).toHaveTextContent('42 %');
    expect(normalize(roas.querySelector('[data-am-metric-basis]')?.textContent)).toBe(
      '40.000,00 € attribuierter Umsatz / 10.000,00 € Spend',
    );
  });

  it('shows the data maturity badge on every tile', () => {
    const { container } = render(
      <MetricGrid
        snapshot={snapshotOf({ spendMinor: 500_000, leads: 40 }, { cohortStartedAt: '2026-08-20T00:00:00.000Z' })}
        keys={['cpl', 'revenue']}
      />,
    );

    expect(tile(container, 'cpl').querySelector('[data-maturity]')).not.toBeNull();
    expect(tile(container, 'revenue').querySelector('[data-maturity]')).toHaveAttribute(
      'data-maturity',
      'IMMATURE',
    );
    expect(screen.getAllByText('Unreif').length).toBeGreaterThan(0);
  });
});
