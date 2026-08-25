import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { summarizeLaunchQa, type LaunchCheckResult } from '@am/domain';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import type { LaunchQaView } from '@/server/campaign-port';
import { LaunchQaPanel } from './launch-qa-panel';

async function qa(id: string): Promise<LaunchQaView> {
  const view = await getCampaignPort().getLaunchQa(id);
  if (!view) throw new Error(`Fixture campaign ${id} missing`);
  return view;
}

function check(overrides: Partial<LaunchCheckResult>): LaunchCheckResult {
  return {
    key: 'meta_permissions_valid',
    labelDe: 'Meta-Berechtigungen gültig',
    status: 'AWAITING_EXTERNAL_INPUT',
    detailDe: 'Es liegt kein Meta-Zugriffstoken vor.',
    remediationDe: 'Meta-Werbekonto unter Integrationen verbinden.',
    blocksLiveOnly: true,
    href: '/integrationen',
    ...overrides,
  };
}

describe('LaunchQaPanel', () => {
  it('renders AWAITING_EXTERNAL_INPUT distinctly from FAIL', async () => {
    const view = await qa(FIXTURE_CAMPAIGN_IDS.metaDraft);
    render(<LaunchQaPanel view={view} />);

    const awaiting = document.querySelector(
      '[data-launch-check="meta_permissions_valid"][data-launch-check-status="AWAITING_EXTERNAL_INPUT"]',
    );
    expect(awaiting).not.toBeNull();
    expect(awaiting).toHaveTextContent('Wartet auf externen Input');
    expect(awaiting).toHaveTextContent('Blockiert nur die Live-Schaltung');
    expect(awaiting).not.toHaveTextContent('Fehler');
  });

  /**
   * The whole point of the two gates: a missing credential must not stop the
   * paused Meta draft, only a real failure may.
   */
  it('opens the draft gate while external input is outstanding but nothing fails', async () => {
    const view = await qa(FIXTURE_CAMPAIGN_IDS.metaDraft);
    expect(view.report.awaitingExternalDe.length).toBeGreaterThan(0);
    expect(view.report.blockingDe).toHaveLength(0);

    render(<LaunchQaPanel view={view} />);

    expect(document.querySelector('[data-gate="gate-meta-draft"]')).toHaveAttribute(
      'data-gate-open',
      'true',
    );
    expect(document.querySelector('[data-gate="gate-go-live"]')).toHaveAttribute(
      'data-gate-open',
      'false',
    );
    expect(
      screen.getByText(/Der pausierte Entwurf darf erstellt werden/),
    ).toBeInTheDocument();
  });

  it('closes the draft gate as soon as a check actually fails', async () => {
    const base = await qa(FIXTURE_CAMPAIGN_IDS.metaDraft);
    const checks = base.report.checks.map((entry) =>
      entry.key === 'creatives_distinct'
        ? check({
            key: 'creatives_distinct',
            labelDe: 'Freigegebene Creatives sind konzeptionell unterschiedlich',
            status: 'FAIL',
            blocksLiveOnly: false,
            detailDe: 'Nur vier von fünf Konzepten sind unterschiedlich.',
          })
        : entry,
    );
    const report = summarizeLaunchQa(base.campaignId, checks, base.report.evaluated_at);
    expect(report.canCreateMetaDraft).toBe(false);

    render(<LaunchQaPanel view={{ ...base, report }} />);

    expect(document.querySelector('[data-gate="gate-meta-draft"]')).toHaveAttribute(
      'data-gate-open',
      'false',
    );
    const failing = document.querySelector(
      '[data-launch-check="creatives_distinct"][data-launch-check-status="FAIL"]',
    );
    expect(failing).not.toBeNull();
    expect(failing).toHaveTextContent('Fehler');
  });

  it('lists all twenty checks with a remediation and a deep link', async () => {
    const view = await qa(FIXTURE_CAMPAIGN_IDS.metaDraft);
    render(<LaunchQaPanel view={view} />);

    expect(document.querySelectorAll('[data-launch-check]')).toHaveLength(20);

    const remediable = view.report.checks.filter((entry) => entry.remediationDe !== null);
    expect(remediable.length).toBeGreaterThan(0);
    for (const entry of remediable) {
      const node = document.querySelector(`[data-launch-check="${entry.key}"]`);
      expect(node).toHaveTextContent(entry.remediationDe as string);
      expect(node?.querySelector('a')?.getAttribute('href')).toBe(entry.href);
    }

    expect(screen.getAllByRole('link', { name: /Zur Behebung/ }).length).toBe(20);
  });
});
