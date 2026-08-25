import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { resetConfigCache } from '@am/config';
import { resetDemoDatabase } from '@am/db';
import { VersionHistory } from '@/components/campaign/version-history';
import { decideStrategyApproval } from '@/app/(app)/kampagnen/[id]/actions';
import type { SessionUser } from '@/lib/permissions';
import { resetAuditStore } from './audit-sink';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from './campaign-fixtures';

/**
 * The Versionen tab, end to end: real action → installed sink → audit store →
 * the port the route reads → the rendered list.
 *
 * Written as one chain on purpose. Every link was individually fine while the
 * screen was wrong: `defineAction` called `ctx.audit`, the repository could
 * append, the component rendered whatever it was handed — and because no sink
 * was installed and the port returned only seeded rows, the tab showed eight
 * entries of fixture history and none of what the operator had just done, under
 * a heading promising "jede Änderung".
 *
 * Nothing installs a sink here: the point is that the console's own composition
 * does. Only the two things that need a Next request context are mocked.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { session } = vi.hoisted(() => ({
  session: { current: null as SessionUser | null },
}));

vi.mock('@/lib/session', () => ({
  getSessionUser: async () => session.current,
}));

const LEAD: SessionUser = {
  id: '9f1c1c4e-2d3a-4b5c-8d6e-7f8a9b0c1d2e',
  email: 'lead@am-beratung.de',
  displayName: 'Marvin Flenche',
  roles: ['MARKETING_LEAD'],
  workspaceId: '00000000-0000-4000-8000-000000000001',
};

beforeEach(() => {
  process.env.DEMO_MODE = 'true';
  resetConfigCache();
  resetDemoDatabase();
  resetAuditStore();
  session.current = LEAD;
});

describe('the Versionen tab after an approval granted in the console', () => {
  it('lists the approval next to the seeded history, with its actor and correlation id', async () => {
    const id = FIXTURE_CAMPAIGN_IDS.strategyReview;
    const port = getCampaignPort();

    const strategy = await port.getStrategy(id);
    const before = await port.getHistory(id);
    // This fixture has no granted approval, so any entry found afterwards was
    // produced by the action below and cannot be a seeded row misread as one.
    expect(before?.auditLog.some((row) => row.action === 'approval.granted')).toBe(false);

    const result = await decideStrategyApproval({
      campaignId: id,
      decision: 'APPROVE',
      contentHash: strategy!.contentHash,
    });
    expect(result.status).toBe('ok');

    const after = await port.getHistory(id);
    expect(after!.auditLog.length).toBe(before!.auditLog.length + 1);

    render(<VersionHistory view={after!} />);

    const granted = document.querySelectorAll('[data-audit-action="approval.granted"]');
    expect(granted).toHaveLength(1);
    const text = granted[0]?.textContent ?? '';
    expect(text).toContain('Freigabe erteilt');
    expect(text).toContain(LEAD.displayName);
    // `fixture:…` is what a seeded row carries; this one names the action that
    // wrote it, which is the difference the whole fix is about.
    expect(text).toContain('campaign.approval.strategy:');

    // The seeded chain is still part of the same list, not replaced by it.
    expect(document.querySelector('[data-audit-action="campaign.created"]')).not.toBeNull();
    expect(document.querySelector('[data-audit-action="proposal.generated"]')).not.toBeNull();
  });
});
