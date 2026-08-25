import { describe, expect, it } from 'vitest';
import type { TestLeadResult } from '@am/hubspot';
import { createFixtureOpsPort } from '@/server/ops-fixtures';
import { testLeadActionResult } from './test-lead-outcome';

/**
 * The test lead is the hard gate in front of the live launch, so how its
 * outcome is reported is not cosmetic. Returning the result whatever its status
 * rendered a green "Test-Lead ausgeführt" directly beneath the amber panel
 * saying the lead had never been sent (AGENTS.md rules 1 and 8).
 */

function result(overrides: Partial<TestLeadResult> = {}): TestLeadResult {
  return {
    status: 'PASS',
    dryRun: false,
    startedAt: '2026-08-25T09:00:00.000Z',
    finishedAt: '2026-08-25T09:00:02.000Z',
    steps: [],
    contactId: null,
    companyId: null,
    dealId: null,
    associationVerified: false,
    cleanup: 'NONE',
    email: 'test-lead+abc@example.invalid',
    messagesDe: [],
    gatePassed: false,
    ...overrides,
  };
}

describe('testLeadActionResult', () => {
  it('reports only a passed probe as a success', () => {
    const passed = result({
      gatePassed: true,
      contactId: '1',
      dealId: '2',
      associationVerified: true,
    });
    const outcome = testLeadActionResult(passed);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.data).toBe(passed);
  });

  /** The refusal is the probe's own sentence, not a generic failure. */
  it('reports a refused test lead as a refusal', () => {
    const outcome = testLeadActionResult(
      result({
        status: 'AWAITING_EXTERNAL_INPUT',
        messagesDe: [
          'Der Test-Lead wurde nicht gesendet, weil das Pflichtmapping unvollständig ist.',
        ],
      }),
    );

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.code).toBe('AWAITING_EXTERNAL_INPUT');
    expect(outcome.messageDe).toContain('nicht gesendet');
    expect(outcome.messageDe).toContain('Der Live-Launch bleibt gesperrt.');
    // Pressing again cannot complete a mapping; the wizard can.
    expect(outcome.retryable).toBe(false);
  });

  it('reports a failed test lead as a retryable error', () => {
    const outcome = testLeadActionResult(
      result({ status: 'FAIL', messagesDe: ['HubSpot antwortete mit 502.'] }),
    );

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.code).toBe('TEST_LEAD_FAILED');
    expect(outcome.retryable).toBe(true);
  });

  it('reports a blocked test lead as a dry run, never as success', () => {
    const outcome = testLeadActionResult(
      result({ status: 'DRY_RUN', dryRun: true, messagesDe: ['Es wurde nichts gesendet.'] }),
    );

    expect(outcome.status).toBe('dry_run');
    if (outcome.status !== 'dry_run') throw new Error('unreachable');
    expect(outcome.dryRun.provider).toBe('HUBSPOT');
    expect(outcome.dryRun.operation).toBe('hubspot.test_lead');
    expect(outcome.dryRun.blockedByDe).toMatch(/HUBSPOT_WRITES_ENABLED/);
  });

  /**
   * Against the fixture port — the implementation the route loads — the mapping
   * is incomplete, so the run this deployment actually produces must not be
   * reported as executed.
   */
  it('reports the run this deployment produces as not executed', async () => {
    const port = createFixtureOpsPort();
    const run = await port.runMappingTestLead({
      initiatedBy: '11111111-1111-4111-8111-111111111111',
    });
    expect(run.status).not.toBe('PASS');
    expect(run.gatePassed).toBe(false);

    expect(testLeadActionResult(run).status).not.toBe('ok');
  });
});
