import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { actionError, actionOk } from '@/lib/action-result';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import type { ApprovalStatus, CampaignHeaderView } from '@/server/campaign-port';
import { ApprovalPanel } from './approval-panel';

async function strategyApproval(id: string): Promise<{
  status: ApprovalStatus;
  header: CampaignHeaderView;
}> {
  const port = getCampaignPort();
  const [view, header] = await Promise.all([port.getStrategy(id), port.getHeader(id, false)]);
  if (!view || !header) throw new Error(`Fixture campaign ${id} missing`);
  return { status: view.approval, header };
}

describe('ApprovalPanel — content-hash invalidation', () => {
  it('renders the German invalidation warning and disables the advance action', async () => {
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.invalidatedApproval);
    expect(status.valid).toBe(false);

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(status))}
        advance={{
          labelDe: 'Weiter zur Launch-QA',
          to: 'READY_FOR_LAUNCH_QA',
          run: vi.fn(async () => actionOk(header)),
          permitted: true,
        }}
      />,
    );

    const warning = document.querySelector('[data-approval-invalid]');
    expect(warning).not.toBeNull();
    expect(warning).toHaveTextContent(/ungültig/);
    expect(warning).toHaveTextContent(
      /Der nächste Schritt bleibt gesperrt, bis der aktuelle Stand erneut freigegeben wurde/,
    );

    expect(screen.getByRole('button', { name: 'Weiter zur Launch-QA' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Erneut freigeben' })).toBeEnabled();
  });

  it('does not call the advance action while the approval is stale', async () => {
    const user = userEvent.setup();
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.invalidatedApproval);
    const run = vi.fn(async () => actionOk(header));

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(status))}
        advance={{ labelDe: 'Weiter zur Launch-QA', to: 'READY_FOR_LAUNCH_QA', run, permitted: true }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Weiter zur Launch-QA' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('enables the advance action once the approval covers the current content', async () => {
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.metaDraft);
    expect(status.valid).toBe(true);

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(status))}
        advance={{
          labelDe: 'Weiter zur Launch-QA',
          to: 'READY_FOR_LAUNCH_QA',
          run: vi.fn(async () => actionOk(header)),
          permitted: true,
        }}
      />,
    );

    expect(document.querySelector('[data-approval-invalid]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Weiter zur Launch-QA' })).toBeEnabled();
  });

  it('names the responsible role instead of showing a dead button', async () => {
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.strategyReview);

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide={false}
        requiredRoleDe="Marketing Lead, Executive"
        decide={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Freigeben' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Zuständig ist: Marketing Lead, Executive\./),
    ).toBeInTheDocument();
  });

  it('surfaces a refused approval as a German error rather than a success', async () => {
    const user = userEvent.setup();
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.strategyReview);

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () =>
          actionError<ApprovalStatus>(
            'CONTENT_CHANGED',
            'Der Inhalt hat sich geändert, während Sie ihn geprüft haben.',
          ),
        )}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Freigeben' }));

    expect(await screen.findByText('Aktion nicht ausgeführt')).toBeInTheDocument();
    expect(
      screen.getByText(/Der Inhalt hat sich geändert, während Sie ihn geprüft haben\./),
    ).toBeInTheDocument();
  });
});
