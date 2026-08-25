import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceFilters } from './performance-filters';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const CAMPAIGNS = [
  {
    id: 'cmp-a',
    labelDe: 'Fördermittel-Check 2026',
    firstDay: '2026-03-13',
    lastDay: '2026-08-25',
  },
  {
    id: 'cmp-b',
    labelDe: 'Nachfolgeberatung Mittelstand',
    firstDay: '2025-10-09',
    lastDay: '2026-05-13',
  },
];

const FUNNELS = [
  { id: 'fv-1', labelDe: 'Multi-Step-Formular, 4 Schritte (v5) · Multi-Step-Formular' },
  { id: 'fv-2', labelDe: 'Hybrid: Landingpage + Formular (v4) · Hybrid' },
];

function renderFilters() {
  return render(
    <PerformanceFilters
      basePath="/performance"
      presetId="letzte-30-tage"
      range={{ from: '2026-07-27', to: '2026-08-25' }}
      campaigns={CAMPAIGNS}
      campaignId={null}
      funnelVersions={FUNNELS}
      funnelVersionId={null}
      minDate="2025-02-28"
      maxDate="2026-08-25"
    />,
  );
}

describe('PerformanceFilters', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it('states the evaluated period in German', () => {
    renderFilters();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Ausgewertet wird 27.07.2026 bis 25.08.2026.',
    );
  });

  it('writes the selected preset into the URL', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.click(screen.getByRole('combobox', { name: 'Zeitraum' }));
    await user.click(screen.getByRole('option', { name: 'Letzte 90 Tage' }));

    expect(replace).toHaveBeenCalledWith('/performance?zeitraum=letzte-90-tage', { scroll: false });
  });

  it('writes the selected campaign into the URL and keeps the period', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.click(screen.getByRole('combobox', { name: 'Kampagne' }));
    await user.click(screen.getByRole('option', { name: 'Fördermittel-Check 2026' }));

    expect(replace).toHaveBeenCalledWith('/performance?zeitraum=letzte-30-tage&kampagne=cmp-a', {
      scroll: false,
    });
  });

  it('writes the funnel selection for the step analysis into the URL', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.click(screen.getByRole('combobox', { name: 'Funnel für die Schritt-Analyse' }));
    await user.click(screen.getByRole('option', { name: FUNNELS[1].labelDe }));

    expect(replace).toHaveBeenCalledWith('/performance?zeitraum=letzte-30-tage&funnel=fv-2', {
      scroll: false,
    });
  });

  it('applies a custom range only on the explicit action, and refuses a reversed one', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.click(screen.getByRole('combobox', { name: 'Zeitraum' }));
    await user.click(screen.getByRole('option', { name: 'Benutzerdefiniert' }));
    replace.mockClear();

    const from = screen.getByLabelText('Von');
    await user.clear(from);
    await user.type(from, '2026-09-30');
    // Typing alone must not navigate — the operator confirms the range.
    expect(replace).not.toHaveBeenCalled();

    const apply = screen.getByRole('button', { name: 'Zeitraum anwenden' });
    expect(apply).toBeDisabled();
    expect(screen.getByText('Das Startdatum muss vor dem Enddatum liegen.')).toBeInTheDocument();

    await user.clear(from);
    await user.type(from, '2026-08-01');
    expect(screen.getByRole('button', { name: 'Zeitraum anwenden' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Zeitraum anwenden' }));
    expect(replace).toHaveBeenCalledWith(
      '/performance?zeitraum=benutzerdefiniert&von=2026-08-01&bis=2026-08-25',
      { scroll: false },
    );
  });
});
