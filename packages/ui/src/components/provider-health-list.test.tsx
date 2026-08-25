import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type HealthCheck } from '@am/domain';
import { ProviderHealthList } from './provider-health-list';

const CHECKS: HealthCheck[] = [
  {
    key: 'meta.token',
    labelDe: 'Meta-Zugangstoken',
    status: 'AWAITING_EXTERNAL_INPUT',
    detailDe: 'Es wurde noch kein Systembenutzer-Token hinterlegt.',
    checkedAt: '2026-08-25T07:00:00.000Z',
    remediationDe: 'Token in den Einstellungen unter Integrationen hinterlegen.',
    blocksLiveOnly: true,
  },
  {
    key: 'meta.pixel',
    labelDe: 'Pixel-Ereignisse',
    status: 'WARN',
    detailDe: 'Seit 6 Stunden keine Ereignisse empfangen.',
    checkedAt: '2026-08-25T07:00:00.000Z',
    remediationDe: null,
    blocksLiveOnly: false,
  },
];

describe('ProviderHealthList', () => {
  it('renders every probe with its German status label and remediation', () => {
    render(<ProviderHealthList provider="META" checks={CHECKS} />);

    expect(screen.getByText('Meta-Zugangstoken')).toBeInTheDocument();
    expect(screen.getByText('Pixel-Ereignisse')).toBeInTheDocument();
    expect(screen.getAllByText('Wartet auf externen Input').length).toBeGreaterThan(0);
    expect(screen.getByText('Warnung')).toBeInTheDocument();
    expect(
      screen.getByText(/Token in den Einstellungen unter Integrationen hinterlegen\./),
    ).toBeInTheDocument();
  });

  it('rolls up to AWAITING_EXTERNAL_INPUT rather than masking it as a warning', () => {
    render(<ProviderHealthList provider="META" checks={CHECKS} />);

    const region = screen.getByRole('region', { name: 'Systemstatus META' });
    expect(region.querySelector('[data-status-kind="health"]')).toHaveAttribute(
      'data-status-state',
      'AWAITING_EXTERNAL_INPUT',
    );
  });

  it('rolls up to FAIL as soon as one probe fails', () => {
    render(
      <ProviderHealthList
        provider="HUBSPOT"
        checks={[
          ...CHECKS,
          {
            key: 'hubspot.mapping',
            labelDe: 'Pipeline-Mapping',
            status: 'FAIL',
            detailDe: 'Kein veröffentlichtes Mapping vorhanden.',
            checkedAt: '2026-08-25T07:00:00.000Z',
            remediationDe: 'Mapping veröffentlichen.',
            blocksLiveOnly: false,
          },
        ]}
      />,
    );

    const region = screen.getByRole('region', { name: 'Systemstatus HUBSPOT' });
    expect(region.querySelector('[data-status-kind="health"]')).toHaveAttribute(
      'data-status-state',
      'FAIL',
    );
  });

  it('offers a German empty state when nothing has been checked yet', () => {
    render(<ProviderHealthList provider="OPENAI" checks={[]} />);

    expect(screen.getByText('Noch keine Prüfungen ausgeführt')).toBeInTheDocument();
  });
});
