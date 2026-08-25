import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { METRIC_CATALOG, METRIC_KEYS, rate, type MetricValue } from '@am/domain';
import { MetricTile } from './metric-tile';

function valueOf(container: HTMLElement): string {
  return container.querySelector('[data-am-metric-value]')?.textContent ?? '';
}

function basisOf(container: HTMLElement): string {
  return container.querySelector('[data-am-metric-basis]')?.textContent ?? '';
}

describe('MetricTile', () => {
  it('renders the German value together with its numerator and denominator', () => {
    const { container } = render(
      <MetricTile metric="ctr" value={rate(12, 340)} maturity="PARTIAL" />,
    );

    expect(valueOf(container)).toBe('3,5 %');
    expect(basisOf(container)).toContain('12 / 340');
    expect(screen.getByText('CTR')).toBeInTheDocument();
  });

  it('shows a dash — never 0 — when the denominator is zero', () => {
    const { container } = render(
      <MetricTile metric="submission_rate" value={rate(0, 0)} maturity="IMMATURE" />,
    );

    expect(valueOf(container)).toBe('–');
    expect(valueOf(container)).not.toContain('0');
    // The basis is still rendered so the dash is explainable.
    expect(basisOf(container)).toContain('0 / 0');
  });

  it('marks a derived metric as derived, right next to the number', () => {
    /* The CRM records no "the call happened" event, so attendance is inferred
       from a deal leaving the scheduled stage. A show rate rendered exactly
       like a measured number is an estimate someone will steer a budget on. */
    const { container } = render(<MetricTile metric="show_rate" value={rate(31, 44)} maturity="MATURE" />);

    expect(container.querySelector('[data-am-derived]')).toBeInTheDocument();
    expect(screen.getByText('Abgeleitet')).toBeInTheDocument();
  });

  it('does not mark a measured metric', () => {
    const { container } = render(<MetricTile metric="leads" value={rate(31, 44)} maturity="MATURE" />);

    expect(container.querySelector('[data-am-derived]')).not.toBeInTheDocument();
  });

  it('marks every metric the catalogue calls derived, and only those', () => {
    // Asserted over the whole catalogue rather than one example, so a metric
    // added later cannot introduce an unmarked estimate.
    for (const key of METRIC_KEYS) {
      const { container, unmount } = render(<MetricTile metric={key} value={rate(1, 2)} maturity="MATURE" />);
      const marked = container.querySelector('[data-am-derived]') !== null;
      expect(marked, key).toBe(METRIC_CATALOG[key].measurement === 'DERIVED');
      unmount();
    }
  });

  it('renders the data maturity badge beside the label', () => {
    render(<MetricTile metric="cpl" value={rate(4, 90)} maturity="IMMATURE" />);

    expect(screen.getByText('Unreif')).toBeInTheDocument();
  });

  it('takes metric, maturity and coverage from a MetricValue envelope', () => {
    const metricValue: MetricValue = {
      metric: 'revenue',
      numerator: 3,
      denominator: 12,
      value: 1_250_00,
      currency: 'EUR',
      maturity: 'MATURE',
      attributionCoverage: 0.92,
    };

    const { container } = render(<MetricTile value={metricValue} />);

    // Intl separates the amount from the currency with a non-breaking space.
    expect(valueOf(container)).toBe('1.250,00\u00A0€');
    expect(basisOf(container)).toContain('3 / 12');
    expect(screen.getByText('Reif')).toBeInTheDocument();
    expect(screen.getByText('92 %')).toBeInTheDocument();
  });

  it('compares against a target and names the direction in words', () => {
    render(<MetricTile metric="ctr" value={rate(20, 400)} target={0.03} maturity="MATURE" />);

    expect(screen.getByText(/^Ziel/)).toBeInTheDocument();
    expect(screen.getByText(/\+2,0 pp/)).toBeInTheDocument();
    expect(screen.getByText(/besser als Ziel/)).toBeInTheDocument();
  });
});
