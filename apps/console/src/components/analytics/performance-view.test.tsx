import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Breakdown, FunnelDropOff, PerformanceOverview } from '@/server/analytics-port';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';
import { BreakdownTable } from './breakdown-table';
import { CrmDelayNotice } from './crm-delay-notice';
import { DEFAULT_PRESET_ID, rangeLengthDays, resolveRange } from './date-range';
import { FunnelDropOffView } from './funnel-dropoff';

const NOW = '2026-08-25T09:00:00.000Z';
const port = createAnalyticsFixturePort({ now: NOW });
const RANGE = { from: '2026-07-27', to: '2026-08-25' };

let overview: PerformanceOverview;
let dropOff: FunnelDropOff;
let campaignBreakdown: Breakdown;

beforeAll(async () => {
  overview = await port.getPerformanceOverview({ range: RANGE, now: NOW });
  dropOff = await port.getFunnelDropOff({ range: RANGE, now: NOW });
  const breakdowns = await port.getBreakdowns({ range: RANGE, now: NOW });
  const found = breakdowns.find((breakdown) => breakdown.dimension === 'CAMPAIGN');
  if (!found) throw new Error('Kampagnen-Aufschlüsselung fehlt');
  campaignBreakdown = found;
});

describe('CrmDelayNotice', () => {
  it('states which part of the period is not yet mature, in days and as a share', () => {
    const { container } = render(
      <CrmDelayNotice statement={overview.crmDelay} snapshot={overview.total} />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain('CRM-Verzug im gewählten Zeitraum');
    expect(text).toContain('CRM-Reifefenster');
    expect(text).toMatch(/\d+ \/ \d+/);
    expect(text).toContain('Reif:');
    expect(text).toContain('Teilweise reif:');
    expect(text).toContain('Unreif:');
  });

  it('names the cut-off date after which no cohort can be mature', () => {
    render(<CrmDelayNotice statement={overview.crmDelay} snapshot={overview.total} />);
    expect(screen.getByText(/Kohorten ab dem/)).toBeInTheDocument();
  });

  it('shows the data maturity badge of the numbers it qualifies', () => {
    const { container } = render(
      <CrmDelayNotice statement={overview.crmDelay} snapshot={overview.total} />,
    );
    expect(container.querySelector('[data-maturity]')).toHaveAttribute(
      'data-maturity',
      overview.total.maturity,
    );
  });
});

describe('FunnelDropOffView', () => {
  it('names the analysis window and the funnel version it belongs to', () => {
    const { container } = render(<FunnelDropOffView dropOff={dropOff} />);
    expect(container.textContent).toContain('Auswertungsfenster');
    expect(container.textContent).toContain(dropOff.funnelLabelDe);
  });

  it('lists validation failures by field and error code with the German message', () => {
    render(<FunnelDropOffView dropOff={dropOff} />);

    expect(screen.getByText('Validierungsfehler nach Feld und Fehlercode')).toBeInTheDocument();
    const table = screen
      .getAllByRole('table')
      .find((candidate) => within(candidate).queryByRole('columnheader', { name: 'Fehlercode' }));
    expect(table).toBeDefined();

    const first = dropOff.analysis.topValidationFailures[0];
    expect(table?.textContent).toContain(first.fieldId);
    expect(table?.textContent).toContain(first.errorCode);
    expect(table?.textContent).toContain(first.messageDe);
  });

  it('reports the non-production traffic it excluded before counting', () => {
    const { container } = render(<FunnelDropOffView dropOff={dropOff} />);
    expect(container.textContent).toContain('Vor der Auswertung ausgeschlossen');
    expect(container.textContent).toContain('BOT');
  });

  it('renders every headline rate with its basis', () => {
    const { container } = render(<FunnelDropOffView dropOff={dropOff} />);
    const startRate = container.querySelector('[data-metric="form_start_rate"]');
    expect(startRate?.querySelector('[data-am-metric-basis]')?.textContent).toContain(
      'Formularstarts / ',
    );
  });
});

describe('BreakdownTable', () => {
  it('renders maturity and attribution coverage on every row', () => {
    const { container } = render(
      <BreakdownTable
        rows={campaignBreakdown.rows}
        entityLabelDe="Kampagne"
        captionDe="Kennzahlen je Kampagne"
      />,
    );

    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(campaignBreakdown.rows.length);
    for (const row of bodyRows) {
      expect(row.querySelector('[data-maturity]')).not.toBeNull();
      expect(row.querySelector('[data-coverage]')).not.toBeNull();
    }
  });

  it('renders every rate cell together with the fraction it came from', () => {
    const { container } = render(
      <BreakdownTable
        rows={campaignBreakdown.rows}
        entityLabelDe="Kampagne"
        captionDe="Kennzahlen je Kampagne"
      />,
    );

    const firstRow = container.querySelector('tbody tr');
    expect(firstRow?.textContent).toMatch(/\d+ Leads \/ [\d.]+ Sessions/);
    expect(firstRow?.textContent).toMatch(/Link-Klicks \/ [\d.]+ Impressionen/);
  });

  it('says so in German when a dimension produced no rows', () => {
    render(<BreakdownTable rows={[]} entityLabelDe="Kampagne" captionDe="Leer" />);
    expect(screen.getByText('Keine Einträge im gewählten Zeitraum')).toBeInTheDocument();
  });
});

describe('date range resolution', () => {
  it('falls back to the default preset for an unknown range', () => {
    const selection = resolveRange({ zeitraum: 'gibt-es-nicht' }, NOW);
    expect(selection.presetId).toBe(DEFAULT_PRESET_ID);
    expect(rangeLengthDays(selection.range)).toBe(30);
  });

  it('accepts a valid custom range and rejects a reversed one', () => {
    const valid = resolveRange(
      { zeitraum: 'benutzerdefiniert', von: '2026-01-01', bis: '2026-01-31' },
      NOW,
    );
    expect(valid.presetId).toBe('benutzerdefiniert');
    expect(rangeLengthDays(valid.range)).toBe(31);

    const reversed = resolveRange(
      { zeitraum: 'benutzerdefiniert', von: '2026-02-01', bis: '2026-01-01' },
      NOW,
    );
    expect(reversed.presetId).toBe(DEFAULT_PRESET_ID);
  });

  it('always ends a preset range on the evaluation day', () => {
    const selection = resolveRange({ zeitraum: 'letzte-90-tage' }, NOW);
    expect(selection.range.to).toBe('2026-08-25');
    expect(rangeLengthDays(selection.range)).toBe(90);
  });
});
