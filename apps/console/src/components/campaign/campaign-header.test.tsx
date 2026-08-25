import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    ['META_DRAFT_PAUSED', FIXTURE_CAMPAIGN_IDS.metaDraft, 'Meta-Entwurf – pausiert'],
    ['LIVE', FIXTURE_CAMPAIGN_IDS.live, 'Live – liefert aus'],
    ['PAUSED', FIXTURE_CAMPAIGN_IDS.paused, 'Pausiert'],
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

  it('warns in German when an approval was invalidated by a later change', async () => {
    const view = await header(FIXTURE_CAMPAIGN_IDS.invalidatedApproval);
    render(<CampaignHeader header={view} />);

    expect(screen.getByText('Freigabe durch Änderung ungültig')).toBeInTheDocument();
    expect(
      screen.getByText(/muss erneut erteilt werden, bevor die Kampagne weitergeführt werden kann/),
    ).toBeInTheDocument();
  });
});
