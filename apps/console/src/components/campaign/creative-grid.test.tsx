import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { actionOk } from '@/lib/action-result';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import type { CreativeBoardView } from '@/server/campaign-port';
import { ApprovalPanel } from './approval-panel';
import { CreativeGrid } from './creative-grid';
import { assetGateBlockedReasonDe } from './gates';

async function board(id: string): Promise<CreativeBoardView> {
  const view = await getCampaignPort().getCreativeBoard(id);
  if (!view) throw new Error(`Fixture campaign ${id} missing`);
  return view;
}

function approvalSlot(view: CreativeBoardView) {
  return (
    <ApprovalPanel
      campaignId={view.campaignId}
      status={view.approval}
      canDecide
      requiredRoleDe="Marketing Lead"
      decide={vi.fn(async () => actionOk(view.approval))}
      approvalBlockedReasonDe={assetGateBlockedReasonDe(view)}
    />
  );
}

describe('CreativeGrid — the five-creative gate', () => {
  it('blocks asset approval and names the offending pairs when fewer than five concepts are distinct', async () => {
    const view = await board(FIXTURE_CAMPAIGN_IDS.assetReview);
    expect(view.diversity.blocked).toBe(true);

    render(
      <CreativeGrid
        board={view}
        canReview
        review={vi.fn(async () => actionOk(view))}
        approvalSlot={approvalSlot(view)}
      />,
    );

    expect(screen.getByText('Asset-Freigabe blockiert')).toBeInTheDocument();

    const collision = view.diversity.collisions[0];
    const blocked = screen.getAllByText(
      new RegExp(`${collision.aName}[\\s\\S]*${collision.bName}`),
    );
    expect(blocked.length).toBeGreaterThan(0);

    const pair = document.querySelector(
      `[data-diversity-pair="${collision.aKey}-${collision.bKey}"]`,
    );
    expect(pair).not.toBeNull();
    expect(pair).toHaveTextContent(collision.aName);
    expect(pair).toHaveTextContent(collision.bName);

    const approve = screen.getByRole('button', { name: /^Freigeben$/ });
    expect(approve).toBeDisabled();
  });

  it('marks the diversity panel as blocked and states how many concepts are distinct', async () => {
    const view = await board(FIXTURE_CAMPAIGN_IDS.assetReview);
    render(<CreativeGrid board={view} canReview={false} review={vi.fn()} />);

    const panel = document.querySelector('[data-diversity-blocked="true"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent(
      `${view.diversity.distinctCount} von ${view.diversity.requiredDistinct} erforderlichen Konzepten`,
    );
    expect(panel).toHaveTextContent('Freigabe blockiert');
  });

  it('allows asset approval once every concept is conceptually distinct', async () => {
    const view = await board(FIXTURE_CAMPAIGN_IDS.metaDraft);
    expect(view.diversity.blocked).toBe(false);

    render(
      <CreativeGrid
        board={view}
        canReview
        review={vi.fn(async () => actionOk(view))}
        approvalSlot={approvalSlot(view)}
      />,
    );

    expect(screen.queryByText('Asset-Freigabe blockiert')).not.toBeInTheDocument();
    expect(document.querySelector('[data-diversity-blocked="false"]')).not.toBeNull();
  });

  it('renders every concept with its principle, copy, hypothesis, proof and renditions', async () => {
    const view = await board(FIXTURE_CAMPAIGN_IDS.live);
    render(<CreativeGrid board={view} canReview={false} review={vi.fn()} />);

    const first = document.querySelector(`[data-creative-key="${view.creatives[0].key}"]`);
    expect(first).not.toBeNull();
    const labels = [...(first as HTMLElement).querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Headline',
        'Primärtext',
        'Hypothese',
        'Verwendeter Beleg',
        'Funnel-Versprechen',
      ]),
    );
    expect(first?.querySelector('[data-aspect-ratio="1:1"]')).not.toBeNull();
    expect(first?.querySelector('[data-aspect-ratio="4:5"]')).not.toBeNull();
  });

  it('submits a per-format creative decision through the supplied action', async () => {
    const user = userEvent.setup();
    const view = await board(FIXTURE_CAMPAIGN_IDS.assetReview);
    const review = vi.fn(async () => actionOk(view));

    render(<CreativeGrid board={view} canReview review={review} />);

    const pending = view.creatives.find((creative) => creative.reviewState !== 'APPROVED');
    expect(pending).toBeDefined();
    const card = document.querySelector(
      `[data-creative-key="${pending?.key}"]`,
    ) as HTMLElement;

    await user.click(within(card).getByRole('button', { name: 'Creative freigeben' }));

    expect(review).toHaveBeenCalledWith({
      campaignId: view.campaignId,
      creativeId: pending?.id,
      decision: 'APPROVE',
    });
  });
});
