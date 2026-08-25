import { dryRun } from '@am/domain';
import type { TestLeadResult, TestLeadStatus } from '@am/hubspot';
import { actionDryRun, actionError, actionOk, type ActionResult } from '@/lib/action-result';

/**
 * How a test-lead run is reported.
 *
 * `runTestLead` answers with four statuses and only one of them means the
 * portal accepted a contact, a deal and their association. Returning the result
 * regardless of status renders a green "Test-Lead ausgeführt" underneath the
 * amber panel that just said the lead was never sent — two contradictory
 * statements about the same run, and the green one wins the reader's attention.
 *
 * So the status decides the envelope: only `PASS` is a success, `DRY_RUN` is a
 * dry run, and a refusal is an error carrying the probe's own German sentences.
 */
export function testLeadActionResult(result: TestLeadResult): ActionResult<TestLeadResult> {
  if (result.status === 'PASS') return actionOk(result);

  const detailDe = result.messagesDe.join(' ').trim();

  if (result.status === 'DRY_RUN') {
    return actionDryRun<TestLeadResult>(
      dryRun(
        'HUBSPOT',
        'hubspot.test_lead',
        {
          email: result.email,
          steps: result.steps.map((step) => ({ key: step.key, status: step.status })),
        },
        'HubSpot-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / HUBSPOT_WRITES_ENABLED = false). Es wurde nichts gesendet.',
      ),
    );
  }

  return actionError<TestLeadResult>(
    result.status === 'AWAITING_EXTERNAL_INPUT' ? 'AWAITING_EXTERNAL_INPUT' : 'TEST_LEAD_FAILED',
    `${detailDe || fallbackDetailDe(result.status)} Der Live-Launch bleibt gesperrt.`,
    // A missing mapping field is fixed in the wizard, not by pressing again.
    { retryable: result.status === 'FAIL' },
  );
}

function fallbackDetailDe(status: TestLeadStatus): string {
  return status === 'AWAITING_EXTERNAL_INPUT'
    ? 'Der Test-Lead wurde nicht gesendet, weil noch Angaben fehlen.'
    : 'Der Test-Lead ist fehlgeschlagen.';
}
