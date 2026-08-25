'use server';

import { revalidatePath } from 'next/cache';
import { dryRun, nowIso, type Provider, type ProviderHealth } from '@am/domain';
import type { HubspotMappingDocument, MappingWizardStepKey, TestLeadResult } from '@am/hubspot';
import { actionDryRun, actionError } from '@/lib/action-result';
import { defineAction } from '@/lib/action';
import { testLeadActionResult } from '@/components/integrations/test-lead-outcome';
import type {
  HubspotMappingSnapshot,
  OutboxRetryOutcome,
  ProbeResultView,
  PublishMappingOutcome,
} from '@/server/ops-port';
import { getOpsPort } from '@/server/ops-fixtures';

/**
 * Server actions for the integrations area.
 *
 * Every one of them goes through `defineAction`, so the permission is checked
 * before the handler runs and the outcome comes back as a German
 * `ActionResult` rather than a thrown stack trace. Anything that would touch a
 * provider returns its `DryRunResult` as `status: 'dry_run'`, which the UI
 * renders as `DryRunNotice` — never as success.
 */

export const recheckProviderAction = defineAction<{ provider: Provider }, ProviderHealth>(
  { permission: 'integration.manage', name: 'integration.recheck' },
  async ({ provider }) => {
    const health = await getOpsPort().recheckProvider({ provider });
    revalidatePath('/integrationen');
    return health;
  },
);

export const retryOutboxEventAction = defineAction<{ eventId: string }, OutboxRetryOutcome>(
  { permission: 'integration.manage', name: 'outbox.retry' },
  async ({ eventId }, ctx) => {
    const outcome = await getOpsPort().retryOutboxEvent({ eventId });
    if (outcome.dryRun) {
      return actionDryRun<OutboxRetryOutcome>(outcome.dryRun);
    }
    await ctx.audit({
      action: 'hubspot.sync_retried',
      entityType: 'outbox_event',
      entityId: eventId,
      summaryDe: `Wiederholung für Ereignis ${eventId} ausgelöst.`,
      after: { state: outcome.state, providerConfirmed: outcome.providerConfirmed },
    });
    revalidatePath('/integrationen/outbox');
    return outcome;
  },
);

export const retryProviderFailedAction = defineAction<
  { provider: Provider },
  { attempted: number; providerConfirmed: number }
>({ permission: 'integration.manage', name: 'outbox.retry_provider' }, async ({ provider }, ctx) => {
  const port = getOpsPort();
  const snapshot = await port.loadOutbox();
  const targets = snapshot.rows.filter((row) => {
    if (!row.retryable) return false;
    return provider === 'HUBSPOT'
      ? row.event.destination === 'HUBSPOT'
      : row.event.destination !== 'HUBSPOT';
  });

  if (targets.length === 0) {
    return actionError<{ attempted: number; providerConfirmed: number }>(
      'NOTHING_TO_RETRY',
      'Für diesen Anbieter gibt es derzeit kein Ereignis, das wiederholt werden könnte.',
    );
  }

  const outcomes: OutboxRetryOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await port.retryOutboxEvent({ eventId: target.event.event_id }));
  }

  const blocked = outcomes.filter((outcome) => outcome.dryRun !== null);
  if (blocked.length === outcomes.length) {
    const first = blocked[0]?.dryRun;
    return actionDryRun<{ attempted: number; providerConfirmed: number }>(
      dryRun(
        provider,
        'outbox.retry_batch',
        { events: targets.map((target) => target.event.event_id) },
        first?.blockedByDe ??
          'Externe Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED=false).',
      ),
    );
  }

  await ctx.audit({
    action: 'hubspot.sync_retried',
    entityType: 'outbox_batch',
    entityId: provider,
    summaryDe: `${outcomes.length} Ereignis(se) für ${provider} erneut zugestellt.`,
    after: { attempted: outcomes.length },
  });
  revalidatePath('/integrationen');

  return {
    attempted: outcomes.length,
    providerConfirmed: outcomes.filter((outcome) => outcome.providerConfirmed).length,
  };
});

/* -------------------------------------------------------------------------- */
/* HubSpot mapping wizard                                                      */
/* -------------------------------------------------------------------------- */

export const saveMappingStepAction = defineAction<
  { step: MappingWizardStepKey; patch: Partial<HubspotMappingDocument> },
  HubspotMappingSnapshot
>({ permission: 'crm.mapping.manage', name: 'hubspot.mapping_step_saved' }, async (input, ctx) => {
  const snapshot = await getOpsPort().saveMappingStep(input);
  await ctx.audit({
    action: 'settings.changed',
    entityType: 'hubspot_mapping_draft',
    entityId: snapshot.draft.id,
    summaryDe: `Mapping-Schritt „${input.step}“ gespeichert.`,
    after: { step: input.step, ok: snapshot.validation.ok },
  });
  revalidatePath('/integrationen/hubspot');
  return snapshot;
});

export const applyFixtureMappingAction = defineAction<{ confirm: true }, HubspotMappingSnapshot>(
  { permission: 'crm.mapping.manage', name: 'hubspot.mapping_fixture_applied' },
  async (_input, ctx) => {
    const snapshot = await getOpsPort().applyFixtureMapping();
    await ctx.audit({
      action: 'settings.changed',
      entityType: 'hubspot_mapping_draft',
      entityId: snapshot.draft.id,
      summaryDe: 'Fixture-Mapping als Entwurf übernommen (kein echtes Kundenportal).',
    });
    revalidatePath('/integrationen/hubspot');
    return snapshot;
  },
);

export const publishMappingAction = defineAction<{ confirm: true }, PublishMappingOutcome>(
  { permission: 'crm.mapping.manage', name: 'hubspot.mapping_published' },
  async (_input, ctx) => {
    const outcome = await getOpsPort().publishMapping({
      publishedBy: ctx.user.id,
      now: nowIso(),
    });
    if (!outcome.published) {
      return actionError<PublishMappingOutcome>('MAPPING_INCOMPLETE', outcome.messageDe, {
        fieldErrors: Object.fromEntries(
          outcome.issues.map((issue) => [issue.path, issue.messageDe]),
        ),
      });
    }
    await ctx.audit({
      action: 'hubspot.mapping_published',
      entityType: 'hubspot_mapping',
      entityId: String(outcome.version),
      summaryDe: outcome.messageDe,
      after: { version: outcome.version },
    });
    revalidatePath('/integrationen/hubspot');
    return outcome;
  },
);

export const runTestLeadAction = defineAction<{ confirm: true }, TestLeadResult>(
  { permission: 'crm.mapping.manage', name: 'hubspot.test_lead' },
  async (_input, ctx) => {
    const result = await getOpsPort().runMappingTestLead({ initiatedBy: ctx.user.id });
    await ctx.audit({
      action: 'hubspot.test_lead_sent',
      entityType: 'hubspot_test_lead',
      entityId: result.startedAt,
      summaryDe:
        result.status === 'PASS'
          ? 'Test-Lead ausgeführt und in HubSpot nachgewiesen.'
          : `Test-Lead nicht ausgeführt: ${result.status}.`,
      after: { status: result.status, gatePassed: result.gatePassed },
    });
    revalidatePath('/integrationen/hubspot');
    return testLeadActionResult(result);
  },
);

export const runWebhookTestAction = defineAction<{ confirm: true }, ProbeResultView>(
  { permission: 'crm.mapping.manage', name: 'hubspot.webhook_test' },
  async () => {
    const result = await getOpsPort().runWebhookTest();
    revalidatePath('/integrationen/hubspot');
    return result;
  },
);

export const runReconciliationTestAction = defineAction<{ confirm: true }, ProbeResultView>(
  { permission: 'crm.mapping.manage', name: 'hubspot.reconciliation_test' },
  async () => {
    const result = await getOpsPort().runReconciliationTest();
    revalidatePath('/integrationen/hubspot');
    return result;
  },
);
