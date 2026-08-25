import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CAMPAIGN_STATE_LABELS_DE, CAMPAIGN_STATES } from '@am/domain';
import { CampaignHeader } from './campaign-header';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import type { CampaignHeaderView } from '@/server/campaign-port';

async function header(id: string): Promise<CampaignHeaderView> {
  const view = await getCampaignPort().getHeader(id, false);
  if (!view) throw new Error(`Fixture campaign ${id} missing`);
  return view;
}

describe('CampaignHeader', () => {
  it('names the next required action and links to where it is done', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.strategyReview);
    render(<CampaignHeader header={view} />);

    expect(screen.getByText('Nächster erforderlicher Schritt:')).toBeInTheDocument();
    expect(screen.getByText('Strategie freigeben')).toBeInTheDocument();

    const callout = document.querySelector('[data-next-action="approve_strategy"]');
    expect(callout).not.toBeNull();
    expect(callout?.querySelector('a')?.getAttribute('href')).toBe(
      `/kampagnen/${FIXTURE_CAMPAIGN_IDS.strategyReview}/strategie`,
    );
  });

  it('states the blocking reason when the next action cannot be taken yet', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.assetReview);
    render(<CampaignHeader header={view} />);

    expect(screen.getByText('Creatives und Funnel freigeben')).toBeInTheDocument();
    expect(screen.getByText(/^Blockiert:/)).toHaveTextContent(
      /konzeptionell unterschiedlich/,
    );
    expect(screen.getByRole('link', { name: /Blocker ansehen/ })).toBeInTheDocument();
  });

  it('carries status, angle, offer, audience, metric, budget, approvals and sync', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.live);
    render(<CampaignHeader header={view} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(view.name);
    expect(screen.getByText(`Angle: ${view.angleName}`)).toBeInTheDocument();
    expect(screen.getByText(`Offer: ${view.offerName}`)).toBeInTheDocument();
    expect(screen.getByText(`Zielgruppe: ${view.audienceName}`)).toBeInTheDocument();
    expect(screen.getByText('Primärmetrik')).toBeInTheDocument();
    expect(screen.getByText('Aktuelles Tagesbudget')).toBeInTheDocument();
    expect(screen.getByText('Freigabestatus')).toBeInTheDocument();
    expect(screen.getByText('Provider-Sync')).toBeInTheDocument();
  });

  /**
   * Preview, draft, the paused Meta draft and an actually delivering campaign
   * must be unmistakable from one another, and not by colour alone.
   */
  it.each([
    ['DRAFT', FIXTURE_CAMPAIGN_IDS.strategyReview, 'Entwurf'],
    ['META_DRAFT_PAUSED', FIXTURE_CAMPAIGN_IDS.metaDraft, 'Meta-Entwurf – von Meta nicht bestätigt'],
    ['LIVE', FIXTURE_CAMPAIGN_IDS.live, 'Live – von Meta nicht bestätigt'],
    ['PAUSED', FIXTURE_CAMPAIGN_IDS.paused, 'Pausiert – von Meta nicht bestätigt'],
  ])('renders the %s reality with its own word and marker', async (reality, id, labelDe) => {
    const view = await header(id);
    render(<CampaignHeader header={view} />);

    const banner = document.querySelector(`[data-reality-banner="${reality}"]`);
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent(labelDe);
    expect(document.querySelector('[data-campaign-header]')).toHaveAttribute(
      'data-reality',
      reality,
    );
  });

  it('renders preview as its own reality, explicitly not delivered', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.live);
    render(<CampaignHeader header={{ ...view, reality: 'PREVIEW' }} />);

    const banner = document.querySelector('[data-reality-banner="PREVIEW"]');
    expect(banner).toHaveTextContent('Vorschau');
    expect(banner).toHaveTextContent(/Nichts davon ist ausgeliefert/);
    expect(document.querySelector('[data-reality-banner="LIVE"]')).toBeNull();
  });

  /**
   * The header used to state „Bei Meta existiert ein Entwurf im Status PAUSED"
   * beside a provider-sync panel reporting that no access token is configured.
   * Both cannot be true, and the panel is the one reading the provider.
   */
  it('does not claim a Meta-side draft while the provider is not connected', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.metaDraft);
    expect(view.providerSync.find((sync) => sync.provider === 'META')?.connection).not.toBe(
      'CONNECTED',
    );
    render(<CampaignHeader header={view} />);

    const banner = document.querySelector('[data-reality-banner="META_DRAFT_PAUSED"]');
    expect(banner).not.toHaveTextContent('Bei Meta existiert ein Entwurf im Status PAUSED.');
    expect(banner).toHaveTextContent(/von Meta nicht bestätigt/);
  });

  it('states the Meta-side draft once the provider actually confirms it', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.metaDraft);
    render(
      <CampaignHeader
        header={{
          ...view,
          providerSync: view.providerSync.map((sync) =>
            sync.provider === 'META'
              ? { ...sync, connection: 'CONNECTED', health: 'PASS' }
              : sync,
          ),
        }}
      />,
    );

    const banner = document.querySelector('[data-reality-banner="META_DRAFT_PAUSED"]');
    expect(banner).toHaveTextContent('Bei Meta existiert ein Entwurf im Status PAUSED.');
  });

  it('warns in German when an approval was invalidated by a later change', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.invalidatedApproval);
    render(<CampaignHeader header={view} />);

    expect(screen.getByText('Freigabe durch Änderung ungültig')).toBeInTheDocument();
    expect(
      screen.getByText(/muss erneut erteilt werden, bevor die Kampagne weitergeführt werden kann/),
    ).toBeInTheDocument();
  });
});

describe('CampaignHeader — the next required step as it renders', () => {
  /**
   * „Jetzt erledigen" is a promise. A paused campaign's stated next step is to
   * resume or conclude it, and the console has no control for either, so the
   * header must not offer to do it on a page that only shows numbers.
   */
  it('does not offer to resume a paused campaign where nothing can be resumed', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.paused);
    render(<CampaignHeader header={view} />);

    const callout = document.querySelector('[data-next-action]');
    expect(callout).toHaveTextContent('Fortsetzen oder abschließen');
    expect(callout?.querySelector('a')).not.toHaveTextContent('Jetzt erledigen');
    expect(document.querySelector('[data-next-action-no-control]')).toHaveTextContent(
      /Fortsetzen, Abschließen und Archivieren sind im Kampagnenraum derzeit nicht steuerbar/,
    );
  });

  it('does not offer to archive a completed campaign from the learnings page', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.completed);
    render(<CampaignHeader header={view} />);

    const callout = document.querySelector('[data-next-action]');
    expect(callout).toHaveTextContent('Learnings prüfen und archivieren');
    expect(callout).toHaveAttribute('data-next-action-target', 'inspect');
    expect(callout?.querySelector('a')).toHaveTextContent('„Learnings" ansehen');
  });

  /**
   * The port falls back to this step whenever no specific one applies. It names
   * no button and builds its sentence from the raw state, so the header has to
   * do both: name the control that exists and speak German.
   */
  it('names the advance button and its tab instead of printing the raw state', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.assetReview);
    render(
      <CampaignHeader
        header={{
          ...view,
          nextAction: {
            key: 'advance_state',
            labelDe: 'Nächsten Schritt auslösen',
            detailDe: `Aktueller Status: ${view.state}.`,
            href: `/kampagnen/${view.id}/strategie`,
            permission: 'campaign.edit',
            blocked: false,
            blockedReasonDe: null,
          },
        }}
      />,
    );

    const callout = document.querySelector('[data-next-action="advance_state"]');
    expect(callout).toHaveTextContent('Weiter zum Testplan');
    expect(callout).toHaveTextContent('Aktueller Status: Assets in Prüfung.');
    expect(callout).not.toHaveTextContent('ASSET_REVIEW');
    expect(callout?.querySelector('a')?.getAttribute('href')).toBe(
      `/kampagnen/${view.id}/creatives`,
    );
  });

  /**
   * Scoped to the callout on purpose: „PAUSED" is also Meta's own word for the
   * state of a draft over there, and the reality banner is entitled to quote
   * the provider. The campaign's own state has a German label and only that
   * label belongs in the guidance.
   */
  it('states the campaign state in German and never as a raw name in the guidance', async () => {
    const rawState = new RegExp(`\\b(${CAMPAIGN_STATES.join('|')})\\b`);

    for (const id of Object.values(FIXTURE_CAMPAIGN_IDS)) {
      const view = await header(id);
      const { unmount } = render(<CampaignHeader header={view} />);

      expect(document.querySelector('[data-next-action]')?.textContent ?? '').not.toMatch(rawState);
      expect(document.querySelector('[data-campaign-header]')).toHaveTextContent(
        CAMPAIGN_STATE_LABELS_DE[view.state],
      );
      unmount();
    }
  });
});
