import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { rate, type MetricValue } from '@am/domain';
import { MetricValueInline, RateValue } from './rate-value';

/**
 * Acceptance criterion 19: a rate is never shown without the numbers it came
 * from, and a zero denominator is a dash — never a zero, which would read as a
 * measurement.
 */
describe('RateValue', () => {
  it('renders the percentage next to its numerator and denominator', () => {
    render(<RateValue rate={rate(12, 340)} />);

    expect(screen.getByText('3,5 %')).toBeInTheDocument();
    expect(screen.getByText(/12 \/ 340/)).toBeInTheDocument();
  });

  it('renders a dash and names the missing denominator when it is zero', () => {
    render(<RateValue rate={rate(0, 0)} />);

    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText(/kein Nenner, daher –/)).toBeInTheDocument();
    expect(screen.queryByText('0,0 %')).not.toBeInTheDocument();
  });

  it('labels the basis when the caller supplies one', () => {
    render(<RateValue rate={rate(12, 340)} basisLabelDe="Leads" />);

    expect(screen.getByText(/Leads: 12 \/ 340/)).toBeInTheDocument();
  });
});

describe('MetricValueInline', () => {
  it('carries the basis and the data maturity alongside the value', () => {
    const value: MetricValue = {
      metric: 'submission_rate',
      numerator: 12,
      denominator: 340,
      value: 12 / 340,
      currency: null,
      maturity: 'PARTIAL',
      attributionCoverage: 0.8,
    };

    render(<MetricValueInline value={value} />);

    expect(screen.getByText('3,5 %')).toBeInTheDocument();
    expect(screen.getByText(/12 Leads \/ 340 Sessions/)).toBeInTheDocument();
    expect(screen.getByText('Teilweise reif')).toBeInTheDocument();
  });

  it('shows a dash rather than a zero when the denominator is zero', () => {
    const value: MetricValue = {
      metric: 'cpl',
      numerator: 48_000,
      denominator: 0,
      value: null,
      currency: 'EUR',
      maturity: 'IMMATURE',
      attributionCoverage: null,
    };

    render(<MetricValueInline value={value} />);

    expect(screen.getByText('–')).toBeInTheDocument();
    // The note names which denominator is missing, so the dash is explainable
    // without going back to the formula.
    expect(screen.getByText(/Kein Nenner: Leads = 0/)).toBeInTheDocument();
  });

  it('renders a money numerator as money rather than as a bare count', () => {
    /* "Kosten je qualifiziertem VQ 52,75 €" was annotated "158.264 / 30". */
    const value: MetricValue = {
      metric: 'cost_per_qualified_vq',
      numerator: 1_582_64,
      denominator: 30,
      value: 52_75,
      currency: 'EUR',
      maturity: 'MATURE',
      attributionCoverage: null,
    };

    render(<MetricValueInline value={value} />);

    expect(screen.getByText(/1\.582,64/)).toBeInTheDocument();
    expect(screen.getByText(/30 qualifizierte VQs/)).toBeInTheDocument();
  });
});
