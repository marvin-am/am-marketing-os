import { beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@am/config';
import { resetDemoDatabase } from '@am/db';
import { createAuditSink, readCampaignAuditLog, resetAuditStore } from './audit-sink';

/**
 * The sink the console actually installs, against the store it actually selects.
 *
 * The defect being guarded here is narrower than "no sink": a sink that accepts
 * a row and drops it reads the same from the call site and is the same failure —
 * a screen that promises a complete trail and shows a frozen one. So these tests
 * write through the real sink and read back through the real read side, rather
 * than asserting that `append` was called.
 */

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ACTOR = '9f1c1c4e-2d3a-4b5c-8d6e-7f8a9b0c1d2e';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    action: 'approval.granted' as const,
    entityType: 'approval',
    entityId: 'a-1',
    summaryDe: 'Freigabe „Strategie" erteilt.',
    campaignId: CAMPAIGN,
    before: { state: 'PENDING' },
    after: { state: 'APPROVED' },
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    actorLabel: 'Marvin Flenche',
    correlationId: 'campaign.approval.strategy:test',
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.DEMO_MODE = 'true';
  resetConfigCache();
  resetDemoDatabase();
  resetAuditStore();
});

describe('the configured audit sink', () => {
  /**
   * In demo mode the product runs with no database at all, and that is the mode
   * this deployment ships in. A sink that only persisted against Postgres would
   * therefore record nothing in the deployment anyone can actually click.
   */
  it('retains what it is given and reads it back for the campaign', async () => {
    await createAuditSink()(entry());

    const rows = await readCampaignAuditLog(WORKSPACE, CAMPAIGN);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: WORKSPACE,
      action: 'approval.granted',
      actor_id: ACTOR,
      actor_label: 'Marvin Flenche',
      entity_type: 'approval',
      entity_id: 'a-1',
      campaign_id: CAMPAIGN,
      summaryDe: 'Freigabe „Strategie" erteilt.',
      before: { state: 'PENDING' },
      after: { state: 'APPROVED' },
      correlation_id: 'campaign.approval.strategy:test',
    });
  });

  /** Another campaign's trail is another campaign's; the tab shows one of them. */
  it('does not hand one campaign the rows of another', async () => {
    const sink = createAuditSink();
    await sink(entry());
    await sink(entry({ campaignId: '3f2504e0-4f89-41d3-9a0c-0305e82c3399', entityId: 'a-2' }));

    expect(await readCampaignAuditLog(WORKSPACE, CAMPAIGN)).toHaveLength(1);
  });

  /**
   * `SupabaseAuditRepository` sanitises on the way in; the in-memory store does
   * not. Redacting in the sink is what makes AGENTS.md rule 7 hold in both
   * modes rather than only in the one with a database behind it.
   */
  it('redacts a payload the caller handed over verbatim', async () => {
    await createAuditSink()(
      entry({
        before: null,
        after: {
          contact_email: 'kundin@example.de',
          refreshToken: 'rt_live_9f2b',
          stage: 'QUALIFIED',
        },
      }),
    );

    const [row] = await readCampaignAuditLog(WORKSPACE, CAMPAIGN);
    const after = row?.after as Record<string, unknown>;

    expect(after.contact_email).toBe('[redacted]');
    expect(after.refreshToken).toBe('[redacted]');
    expect(after.stage).toBe('QUALIFIED');
    expect(JSON.stringify(row)).not.toContain('kundin@example.de');
    expect(JSON.stringify(row)).not.toContain('rt_live_9f2b');
  });
});
