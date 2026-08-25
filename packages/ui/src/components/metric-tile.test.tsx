import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { rate, type MetricValue } from '@am/domain';
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
