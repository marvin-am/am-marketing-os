import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineAction, setAuditSink, type AuditSink } from './action';
import { createAuditSink } from '@/server/audit-sink';
import type { SessionUser } from './permissions';

/**
 * What `defineAction` guarantees about the audit trail.
 *
 * The trail is the product's answer to "who changed this, and to what" —
 * acceptance criterion 26. It is written from exactly one place, so the
 * properties below are the whole of it: if the wrapper drops an entry, no
 * handler compensates, and the Versionen tab keeps claiming to list every change
 * while listing only what someone seeded.
 *
 * `getSessionUser` reads a cookie through `next/headers`, which exists only
 * inside a request. Mocking it is what lets these run as unit tests; nothing
 * else about the wrapper is stubbed.
 */

const { session } = vi.hoisted(() => ({
  session: { current: null as SessionUser | null },
}));

vi.mock('./session', () => ({
  getSessionUser: async () => session.current,
}));

const LEAD: SessionUser = {
  id: '9f1c1c4e-2d3a-4b5c-8d6e-7f8a9b0c1d2e',
  email: 'lead@am-beratung.de',
  displayName: 'Marvin Flenche',
  roles: ['MARKETING_LEAD'],
  workspaceId: '00000000-0000-4000-8000-000000000001',
};

type Recorded = Parameters<AuditSink>[0];

function capture(): { rows: Recorded[]; sink: AuditSink } {
  const rows: Recorded[] = [];
  return {
    rows,
    sink: async (entry) => {
      rows.push(entry);
    },
  };
}

beforeEach(() => {
  session.current = LEAD;
});

afterEach(() => {
  vi.restoreAllMocks();
  // The module installs the configured sink at load; every test that replaced
  // it must put that back, or the next file to run inherits a stub.
  setAuditSink(createAuditSink());
});

describe('an action that declares an audit', () => {
  /**
   * The row has to carry enough to answer for the change on its own: who, what
   * kind of change, on which entity, and the before/after the Versionen tab
   * renders as a diff. An entry missing any of them is a line in a list, not an
   * audit record.
   */
  it('writes a row with actor, action, entity and the before/after diff', async () => {
    const { rows, sink } = capture();
    setAuditSink(sink);

    const act = defineAction<{ to: number }, { ok: true }>(
      { permission: 'campaign.approve_strategy', name: 'test.budget' },
      async (input, ctx) => {
        await ctx.audit({
          action: 'settings.changed',
          entityType: 'campaign_budget',
          entityId: 'c-1',
          campaignId: 'c-1',
          summaryDe: 'Tagesbudget geändert.',
          before: { dailyBudgetMinor: 9_000 },
          after: { dailyBudgetMinor: input.to },
        });
        return { ok: true };
      },
    );

    const result = await act({ to: 12_000 });

    expect(result.status).toBe('ok');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'settings.changed',
      entityType: 'campaign_budget',
      entityId: 'c-1',
      campaignId: 'c-1',
      summaryDe: 'Tagesbudget geändert.',
      actorId: LEAD.id,
      actorLabel: LEAD.displayName,
      workspaceId: LEAD.workspaceId,
      before: { dailyBudgetMinor: 9_000 },
      after: { dailyBudgetMinor: 12_000 },
    });
    expect(rows[0]?.correlationId).toMatch(/^test\.budget:/);
    expect(Date.parse(rows[0]?.occurredAt ?? '')).not.toBeNaN();
  });

  /**
   * AGENTS.md rule 7: no PII and no secrets in logs or audit rows. The guard has
   * to sit in the wrapper rather than in each handler, because the handler that
   * forgets is precisely the one that hands a whole submission to `ctx.audit`.
   */
  it('redacts contact data and credentials before they reach the sink', async () => {
    const { rows, sink } = capture();
    setAuditSink(sink);

    const act = defineAction<void, { ok: true }>(
      { permission: 'campaign.approve_strategy', name: 'test.redaction' },
      async (_input, ctx) => {
        await ctx.audit({
          action: 'hubspot.test_lead_sent',
          entityType: 'lead',
          entityId: 'l-1',
          summaryDe: 'Test-Lead gesendet.',
          before: null,
          after: {
            email: 'kundin@example.de',
            accessToken: 'EAAG-super-secret-token',
            note: 'Rückruf an kundin@example.de erbeten',
            stage: 'QUALIFIED',
          },
        });
        return { ok: true };
      },
    );

    await act();

    const after = rows[0]?.after as Record<string, unknown>;
    expect(after.email).toBe('[redacted]');
    expect(after.accessToken).toBe('[redacted]');
    // An address inside prose is replaced in place; the sentence around it stays.
    expect(after.note).toContain('[redacted]');
    expect(after.note).toContain('erbeten');
    // Redaction removes the personal data, not the reviewability of the change.
    expect(after.stage).toBe('QUALIFIED');
    expect(JSON.stringify(rows[0])).not.toContain('kundin@example.de');
    expect(JSON.stringify(rows[0])).not.toContain('EAAG-super-secret-token');
  });
});

describe('an action running without an audit sink', () => {
  /**
   * The defect this file was written for: no sink was ever installed, every
   * `ctx.audit` returned after a log line nobody reads, and the console recorded
   * nothing at all while the Versionen tab said it recorded everything.
   *
   * Refusal happens *before* the handler, which is the only point where it is
   * free: once a handler has performed its write, a failing audit can no longer
   * be turned into "nothing happened", and an unrecorded change is a control
   * failure rather than a warning.
   */
  it('is refused before its handler performs anything', async () => {
    setAuditSink(null);
    const performed = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const act = defineAction<void, { ok: true }>(
      { permission: 'campaign.approve_strategy', name: 'test.no_sink' },
      async (_input, ctx) => {
        performed();
        await ctx.audit({
          action: 'approval.granted',
          entityType: 'approval',
          entityId: 'a-1',
          summaryDe: 'Freigabe erteilt.',
        });
        return { ok: true };
      },
    );

    const result = await act();

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.code).toBe('INTERNAL');
    expect(result.messageDe).toContain('Audit-Log');
    // A retry cannot install a sink, so offering one would only repeat the wait.
    expect(result.retryable).toBe(false);
    expect(performed).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain('audit_sink_missing');
  });
});

describe('an audit sink that fails at write time', () => {
  /**
   * The counterpart to the check above. Here the write the entry describes has
   * already happened, so reporting failure would tell the operator a change did
   * not occur and invite them to repeat it. The outcome stands and the gap is
   * escalated at error level with the redacted row, which is what makes it
   * replayable and what keeps it from being a silent warning again.
   */
  it('keeps the business outcome and logs the gap as an error', async () => {
    setAuditSink(async () => {
      throw new Error('audit_logs insert rejected');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const act = defineAction<void, { state: string }>(
      { permission: 'campaign.approve_strategy', name: 'test.sink_down' },
      async (_input, ctx) => {
        await ctx.audit({
          action: 'approval.granted',
          entityType: 'approval',
          entityId: 'a-1',
          summaryDe: 'Freigabe erteilt.',
          after: { state: 'APPROVED' },
        });
        return { state: 'APPROVED' };
      },
    );

    const result = await act();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.data.state).toBe('APPROVED');

    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain('audit_write_failed');
    expect(line).toContain('approval.granted');
  });
});
