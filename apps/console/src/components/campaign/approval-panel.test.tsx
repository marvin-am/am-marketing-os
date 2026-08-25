import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dryRun } from '@am/domain';
import { actionError, actionOk, type ActionResult } from '@/lib/action-result';
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
          /* Same reason as above: an invalidated strategy approval takes
             READY_FOR_LAUNCH_QA out of the allowed transitions. */
          approvalsMet: false,
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
        advance={{
          labelDe: 'Weiter zur Launch-QA',
          to: 'READY_FOR_LAUNCH_QA',
          run,
          permitted: true,
          /* The strategy approval no longer covers the current content, and
             READY_FOR_LAUNCH_QA requires it — so the port does not list the
             target among the allowed transitions. */
          approvalsMet: false,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Weiter zur Launch-QA' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('does not require the panel\u2019s own approval when the step does not', async () => {
    /*
     * The paused-draft step is rendered inside the PUBLISH approval panel,
     * which made it wait for a publication approval that
     * `REQUIRED_APPROVALS_FOR_STATE` never asks for — the section's own
     * description says the opposite, that the draft is created and stays
     * paused until publication is approved. Which panel a step is rendered in
     * is layout; what it requires is a domain fact, and only the second one
     * may disable the button.
     */
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.metaDraft);
    const pending: typeof status = {
      ...status,
      kind: 'PUBLISH',
      valid: false,
      approval: { ...status.approval, kind: 'PUBLISH', state: 'PENDING' },
    };

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={pending}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(pending))}
        advance={{
          labelDe: 'Pausierten Meta-Entwurf erstellen',
          to: 'META_DRAFT_CREATED',
          run: vi.fn(async () => actionOk(header)),
          permitted: true,
          approvalsMet: true,
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Pausierten Meta-Entwurf erstellen' }),
    ).toBeEnabled();
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
          approvalsMet: true,
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

  /**
   * A rollback is legal, but it is not progress. Offering it as the primary
   * „next step" is how the campaign ended up walking backwards on a single
   * click, so it is kept apart, worded as a step back, and confirmed.
   */
  it('keeps the way back apart from the next step and asks before taking it', async () => {
    const user = userEvent.setup();
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.metaDraft);
    const run = vi.fn(async () => actionOk(header));

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(status))}
        advance={{
          labelDe: 'Kampagne live schalten',
          to: 'LIVE',
          run: vi.fn(async () => actionOk(header)),
          permitted: true,
          approvalsMet: true,
        }}
        rollback={{
          labelDe: 'Zurück auf „Bereit für Meta-Entwurf"',
          to: 'READY_FOR_META_DRAFT',
          confirmDe: 'Das ist kein Fortschritt im Kampagnenablauf.',
          run,
          permitted: true,
        }}
      />,
    );

    const section = document.querySelector('[data-rollback-section]');
    expect(section).toHaveTextContent('Schritt zurücknehmen');
    expect(section).toHaveTextContent('kein Fortschritt im Kampagnenablauf');
    expect(section).not.toContainElement(
      screen.getByRole('button', { name: 'Kampagne live schalten' }),
    );

    await user.click(screen.getByRole('button', { name: 'Zurück auf „Bereit für Meta-Entwurf"' }));
    expect(run).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Ja, zurücksetzen' }));
    expect(run).toHaveBeenCalledWith({ campaignId: header.id, to: 'READY_FOR_META_DRAFT' });
  });

  /**
   * Creating the paused Meta draft is the most outward-facing action in the
   * product. It used to fire on a single click, with no dialog and no payload,
   * and then report a plain green success — the one shape a step that reaches a
   * provider may never have (AGENTS.md rules 2 and 3).
   */
  it('confirms a step that writes to Meta against the payload before running it', async () => {
    const user = userEvent.setup();
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.metaDraft);
    const run = vi.fn(async () => actionOk(header));
    const payload = {
      ad_account_id: null,
      campaign: { name: 'AM | Benchmark Metallbau — Pilot', status: 'PAUSED' },
    };

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(status))}
        advance={{
          labelDe: 'Pausierten Meta-Entwurf erstellen',
          to: 'META_DRAFT_CREATED',
          run,
          permitted: true,
          approvalsMet: true,
          externalConfirm: { operation: 'meta.create_paused_draft_campaign', payload },
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Pausierten Meta-Entwurf erstellen' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('meta.create_paused_draft_campaign');
    expect(dialog).toHaveTextContent('"ad_account_id": null');
    expect(dialog).toHaveTextContent(/Ein Dry-Run legt bei Meta nichts an/);
    expect(run).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'An Meta senden' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(run).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), 'AUSFÜHREN');
    await user.click(screen.getByRole('button', { name: 'An Meta senden' }));

    expect(run).toHaveBeenCalledWith({ campaignId: header.id, to: 'META_DRAFT_CREATED' });
  });

  /** A dry run is not a success and must never be rendered as one. */
  it('renders the dry run of that step as a dry run', async () => {
    const user = userEvent.setup();
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.metaDraft);

    render(
      <ApprovalPanel
        campaignId={header.id}
        status={status}
        canDecide
        requiredRoleDe="Marketing Lead"
        decide={vi.fn(async () => actionOk(status))}
        advance={{
          labelDe: 'Pausierten Meta-Entwurf erstellen',
          to: 'META_DRAFT_CREATED',
          run: vi.fn(
            async (): Promise<ActionResult<CampaignHeaderView>> => ({
              status: 'dry_run',
              dryRun: dryRun(
                'META',
                'meta.create_paused_draft_campaign',
                { ad_account_id: null },
                'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts angelegt und der Status wurde nicht geändert.',
              ),
            }),
          ),
          permitted: true,
          approvalsMet: true,
          externalConfirm: { operation: 'meta.create_paused_draft_campaign', payload: {} },
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Pausierten Meta-Entwurf erstellen' }));
    await screen.findByRole('alertdialog');
    await user.type(screen.getByRole('textbox'), 'AUSFÜHREN');
    await user.click(screen.getByRole('button', { name: 'An Meta senden' }));

    await waitFor(() => expect(document.querySelector('[data-dry-run="true"]')).not.toBeNull());
    expect(screen.getByText('Dry-Run – nicht ausgeführt')).toBeInTheDocument();
    expect(screen.getByText(/Status wurde nicht geändert/)).toBeInTheDocument();
    expect(screen.queryByText('Status geändert.')).not.toBeInTheDocument();
  });

  /** A step that only moves our own record needs no such gate. */
  it('runs a purely internal step without a Meta dialog', async () => {
    const user = userEvent.setup();
    const { status, header } = await strategyApproval(FIXTURE_CAMPAIGN_IDS.metaDraft);
    const run = vi.fn(async () => actionOk(header));

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
          run,
          permitted: true,
          approvalsMet: true,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Weiter zur Launch-QA' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(run).toHaveBeenCalledWith({ campaignId: header.id, to: 'READY_FOR_LAUNCH_QA' });
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
