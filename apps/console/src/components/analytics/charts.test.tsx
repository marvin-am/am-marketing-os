import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FunnelStepAnalysis } from '@am/experiments';
import { computeAllMetrics, emptyCounters, assessMaturity } from '@am/experiments';
import type {
  BreakdownRow,
  DailyPoint,
  FunnelDropOff,
  MetricSnapshot,
} from '@/server/analytics-port';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';
import { BreakdownBarChart } from './breakdown-bar-chart';
import { ChartFrame } from './chart-frame';
import { FunnelStepChart } from './funnel-step-chart';
import { TimeSeriesChart } from './time-series-chart';

/**
 * The data-viz rule these charts must never break: an empty or
 * insufficient-data series renders an explicit German state, not a bare axis
 * that reads as a measured zero. Every chart also carries a table view of the
 * same figures, which is what lets the light-mode palette stay legible.
 */

const NOW = '2026-08-25T09:00:00.000Z';
const port = createAnalyticsFixturePort({ now: NOW });

function snapshot(cohortStartedAt: string): MetricSnapshot {
  const counters = emptyCounters();
  const maturityAssessment = assessMaturity({
    cohortStartedAt,
    now: NOW,
    crmMaturityDays: 21,
    observedOutcomes: 0,
  });
  return {
    counters,
    metrics: computeAllMetrics(counters, {
      crmMaturity: maturityAssessment.maturity,
      attributionCoverage: null,
      currency: 'EUR',
    }),
    attributionCoverage: null,
    attributedRecords: 0,
    maturity: maturityAssessment.maturity,
    maturityAssessment,
    cohortStartedAt,
    currency: 'EUR',
  };
}

function emptySeries(days: number): DailyPoint[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { date, ...snapshot(`${date}T00:00:00.000Z`) };
  });
}

describe('TimeSeriesChart', () => {
  it('renders an explicit empty state instead of an empty axis', () => {
    render(<TimeSeriesChart titleDe="Spend je Tag" points={emptySeries(7)} metric="spend" />);

    expect(screen.getByText('Keine Spend im gewählten Zeitraum')).toBeInTheDocument();
    expect(
      screen.getByText(/Eine leere Achse würde einen gemessenen Nullwert vortäuschen\./),
    ).toBeInTheDocument();
  });

  it('renders no data points at all as an empty state', () => {
    render(<TimeSeriesChart titleDe="Leads je Tag" points={[]} metric="leads" />);
    expect(screen.getByText('Keine Leads im gewählten Zeitraum')).toBeInTheDocument();
  });

  it('keeps a table view of the same values beside the plot', async () => {
    const overview = await port.getPerformanceOverview({
      range: { from: '2026-08-11', to: '2026-08-25' },
      now: NOW,
    });
    render(<TimeSeriesChart titleDe="Spend je Tag" points={overview.series} metric="spend" />);

    expect(screen.getByText('Werte als Tabelle')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tag' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Bezugsgröße' })).toBeInTheDocument();
    expect(screen.queryByText(/Keine Spend im gewählten Zeitraum/)).toBeNull();
  });

  it('shows a day without a denominator as a dash rather than as 0 €', async () => {
    const points = emptySeries(3);
    render(<TimeSeriesChart titleDe="CPL je Tag" points={points} metric="cpl" shape="line" />);

    // No leads on any day, so the CPL has no denominator on any day.
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('–');
    expect(table.textContent).not.toContain('0,00 €');
  });
});

describe('FunnelStepChart', () => {
  it('renders an empty state when no step was delivered', () => {
    render(<FunnelStepChart steps={[]} />);
    expect(screen.getByText('Keine Schrittdaten vorhanden')).toBeInTheDocument();
  });

  it('renders each step with its drop-off rate and basis', () => {
    const steps: FunnelStepAnalysis[] = [
      {
        stepKey: 'kontakt',
        label: 'Kontaktdaten',
        index: 0,
        viewed: 340,
        completed: 12,
        completionRate: { numerator: 12, denominator: 340, value: 12 / 340 },
        dropOffRate: { numerator: 328, denominator: 340, value: 328 / 340 },
        lostSessions: 328,
        validationFailures: [],
        validationFailureCount: 0,
        sessionsWithValidationFailure: 0,
      },
    ];
    render(<FunnelStepChart steps={steps} />);

    const table = screen.getByRole('table');
    expect(table.textContent).toContain('1. Kontaktdaten');
    expect(table.textContent).toContain('96,5 %');
    expect(table.textContent).toContain('328 / 340');
  });

  it('names both stacked segments in a legend rather than relying on colour', () => {
    const steps: FunnelStepAnalysis[] = [
      {
        stepKey: 'plz',
        label: 'Postleitzahl',
        index: 0,
        viewed: 100,
        completed: 60,
        completionRate: { numerator: 60, denominator: 100, value: 0.6 },
        dropOffRate: { numerator: 40, denominator: 100, value: 0.4 },
        lostSessions: 40,
        validationFailures: [],
        validationFailureCount: 0,
        sessionsWithValidationFailure: 0,
      },
    ];
    const { container } = render(<FunnelStepChart steps={steps} />);
    const legend = container.querySelector('ul');
    expect(legend?.textContent).toContain('Abgeschlossen');
    expect(legend?.textContent).toContain('Abgebrochen');
  });
});

describe('BreakdownBarChart', () => {
  it('renders an empty state when nothing was spent', () => {
    render(<BreakdownBarChart titleDe="Spend je Kampagne" rows={[]} />);
    expect(screen.getByText('Kein Spend im gewählten Zeitraum')).toBeInTheDocument();
  });

  it('folds the tail into "Übrige" instead of inventing more colours', async () => {
    const breakdowns = await port.getBreakdowns({
      range: { from: '2025-09-01', to: '2026-08-25' },
      now: NOW,
    });
    const creatives = breakdowns.find((breakdown) => breakdown.dimension === 'CREATIVE');
    const rows = (creatives?.rows ?? []) as BreakdownRow[];
    expect(rows.length).toBeGreaterThan(2);

    render(<BreakdownBarChart titleDe="Spend je Creative" rows={rows} maxRows={2} />);
    expect(screen.getByText(new RegExp(`Übrige \\(${rows.length - 2}\\)`))).toBeInTheDocument();
  });
});

describe('ChartFrame', () => {
  it('always offers the table view, even when the plot is suppressed', () => {
    render(
      <ChartFrame isEmpty titleDe="Testdiagramm" tableView={<p>Tabelle</p>}>
        <span>Plot</span>
      </ChartFrame>,
    );

    expect(screen.getByText('Werte als Tabelle')).toBeInTheDocument();
    expect(screen.getByText('Tabelle')).toBeInTheDocument();
    expect(screen.queryByText('Plot')).toBeNull();
  });
});

describe('FunnelDropOff fixture wiring', () => {
  it('exposes validation failures by field and error code', async () => {
    const dropOff: FunnelDropOff = await port.getFunnelDropOff({
      range: { from: '2026-07-27', to: '2026-08-25' },
      now: NOW,
    });

    expect(dropOff.analysis.topValidationFailures.length).toBeGreaterThan(0);
    for (const failure of dropOff.analysis.topValidationFailures) {
      expect(failure.fieldId).toBeTruthy();
      expect(failure.errorCode).toBeTruthy();
      expect(failure.messageDe).toBeTruthy();
    }
  });
});
