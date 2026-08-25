import { render, screen } from '@testing-library/react';
import {
  FIXTURE_MAPPING,
  INCOMPLETE_FIXTURE_MAPPING,
  MAPPING_WIZARD_STEPS,
  canPublishMapping,
  missingRequiredMappings,
  requiredMappingsComplete,
  validateMapping,
  type HubspotMappingDocument,
  type TestLeadResult,
} from '@am/hubspot';
import { rollUpHealth } from '@am/domain';
import { describe, expect, it, vi } from 'vitest';
import { actionOk, type ActionResult } from '@/lib/action-result';
import type {
  HubspotMappingSnapshot,
  ProbeResultView,
  PublishMappingOutcome,
} from '@/server/ops-port';
import { HubspotWizard } from './hubspot-wizard';

const AT = '2026-08-25T07:30:00.000Z';

const PASSING_TEST_LEAD: TestLeadResult = {
  status: 'PASS',
  dryRun: false,
  startedAt: AT,
  finishedAt: AT,
  steps: [
    {
      key: 'contact_deal_association',
      labelDe: 'Verknüpfung Kontakt ↔ Deal',
      status: 'PASS',
      detailDe: 'Kontakt und Deal sind in HubSpot verknüpft.',
    },
  ],
  contactId: '801',
  companyId: '901',
  dealId: '701',
  associationVerified: true,
  cleanup: 'MARKED',
  email: 'am-marketing-os-test+abc@fixture.invalid',
  messagesDe: ['Der Test-Lead war erfolgreich. Kontakt, Deal und Verknüpfung wurden geprüft.'],
  gatePassed: true,
};

const DRY_RUN_TEST_LEAD: TestLeadResult = {
  ...PASSING_TEST_LEAD,
  status: 'DRY_RUN',
  dryRun: true,
  contactId: null,
  companyId: null,
  dealId: null,
  associationVerified: false,
  cleanup: 'NONE',
  steps: [
    {
      key: 'writes_enabled',
      labelDe: 'Schreibzugriffe freigegeben',
      status: 'AWAITING_EXTERNAL_INPUT',
      detailDe: 'HubSpot-Schreibzugriffe sind deaktiviert.',
    },
  ],
  messagesDe: ['Dry-Run – nicht ausgeführt.'],
  gatePassed: false,
};

function snapshotFor(
  draft: HubspotMappingDocument,
  testLead: TestLeadResult | null = null,
): HubspotMappingSnapshot {
  const validation = validateMapping(draft);
  const complete = requiredMappingsComplete(draft);
  const gatePassed = testLead?.gatePassed === true;

  return {
    generatedAt: AT,
    connection: {
      provider: 'HUBSPOT',
      state: 'FIXTURE',
      overall: rollUpHealth([]),
      checks: [],
      checkedAt: AT,
    },
    draft,
    versions: [
      {
        id: draft.id,
        version: draft.version,
        status: 'DRAFT',
        publishedAt: null,
        sourceDe: 'Fixture-Mapping',
        notesDe: null,
      },
    ],
    steps: MAPPING_WIZARD_STEPS.map((step) => {
      const issues = validation.issues.filter((issue) => issue.step === step.key);
      return {
        key: step.key,
        order: step.order,
        labelDe: step.labelDe,
        descriptionDe: step.descriptionDe,
        requiredForLaunch: step.requiredForLaunch,
        issues,
        complete: !issues.some((issue) => issue.severity === 'ERROR'),
        summaryDe: [],
      };
    }),
    validation,
    canPublish: canPublishMapping(draft),
    launchReady: complete && gatePassed,
    missingForLaunchDe: [
      ...missingRequiredMappings(draft).map((issue) => issue.messageDe),
      ...(gatePassed
        ? []
        : [
            'Es liegt noch kein erfolgreicher Test-Lead vor. Der Live-Launch bleibt gesperrt, bis Kontakt, Deal und Verknüpfung in HubSpot nachgewiesen wurden.',
          ]),
    ],
    testLead,
    webhookTest: null,
    reconciliationTest: null,
    flags: {
      demoMode: true,
      externalWritesEnabled: false,
      metaMutationsEnabled: false,
      metaCapiEnabled: false,
      hubspotWritesEnabled: false,
    },
  };
}

const noopSnapshot = (snapshot: HubspotMappingSnapshot) => async () =>
  actionOk(snapshot) as ActionResult<HubspotMappingSnapshot>;
const noopPublish = async (): Promise<ActionResult<PublishMappingOutcome>> =>
  actionOk({ published: true, version: 1, issues: [], messageDe: 'Veröffentlicht.' });
const noopTestLead = async (): Promise<ActionResult<TestLeadResult>> =>
  actionOk(PASSING_TEST_LEAD);
const noopProbe = async (): Promise<ActionResult<ProbeResultView>> =>
  actionOk({
    key: 'webhook_test',
    labelDe: 'Webhook-Test',
    status: 'PASS',
    detailDe: 'Ok.',
    checkedAt: AT,
    dryRun: null,
  });

function renderWizard(snapshot: HubspotMappingSnapshot, canManage = true) {
  return render(
    <HubspotWizard
      snapshot={snapshot}
      canManage={canManage}
      onSaveStep={noopSnapshot(snapshot)}
      onApplyFixture={noopSnapshot(snapshot)}
      onPublish={noopPublish}
      onRunTestLead={noopTestLead}
      onRunWebhookTest={noopProbe}
      onRunReconciliationTest={noopProbe}
    />,
  );
}

describe('HubspotWizard', () => {
  it('renders all fifteen mapping steps', () => {
    const { container } = renderWizard(snapshotFor(FIXTURE_MAPPING));
    expect(container.querySelectorAll('[data-mapping-step]')).toHaveLength(15);
    expect(MAPPING_WIZARD_STEPS).toHaveLength(15);
  });

  it('blocks publishing while a required mapping is missing and names what is missing', () => {
    const { container } = renderWizard(snapshotFor(INCOMPLETE_FIXTURE_MAPPING));

    expect(container.querySelector('[data-publish-gate="blocked"]')).not.toBeNull();
    expect(container.querySelector('[data-publish-gate="open"]')).toBeNull();

    const publishButton = screen.getByRole('button', { name: 'Als neue Version veröffentlichen' });
    expect(publishButton).toBeDisabled();

    // The blockers are named, not just counted.
    const blockers = screen.getByTestId('publish-blockers').textContent ?? '';
    expect(blockers).toContain('Es ist keine Deal-Pipeline ausgewählt');
    expect(blockers).toContain('Es ist keine Eigenschaft für den Umsatzbetrag hinterlegt');
    expect(screen.getByText(/Offene Schritte: .*Pipeline/)).toBeInTheDocument();
  });

  it('allows publishing once the mapping validates', () => {
    const { container } = renderWizard(snapshotFor(FIXTURE_MAPPING));

    expect(container.querySelector('[data-publish-gate="open"]')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Als neue Version veröffentlichen' }),
    ).not.toBeDisabled();
  });

  it('keeps the launch gate closed while no test lead has succeeded', () => {
    const { container } = renderWizard(snapshotFor(FIXTURE_MAPPING, null));

    expect(container.querySelector('[data-launch-gate="blocked"]')).not.toBeNull();
    expect(screen.getByText('Live-Launch gesperrt.')).toBeInTheDocument();
    expect(screen.getByTestId('launch-blockers').textContent).toContain(
      'kein erfolgreicher Test-Lead',
    );
  });

  it('keeps the launch gate closed when the test lead only ran as a dry run', () => {
    const { container } = renderWizard(snapshotFor(FIXTURE_MAPPING, DRY_RUN_TEST_LEAD));

    expect(container.querySelector('[data-launch-gate="blocked"]')).not.toBeNull();
    expect(container.querySelector('[data-test-lead-status="DRY_RUN"]')).not.toBeNull();
    expect(screen.getByText('Dry-Run – nicht ausgeführt.')).toBeInTheDocument();
  });

  it('opens the launch gate once a test lead passed', () => {
    const { container } = renderWizard(snapshotFor(FIXTURE_MAPPING, PASSING_TEST_LEAD));

    expect(container.querySelector('[data-launch-gate="open"]')).not.toBeNull();
    expect(screen.getByText('Live-Launch freigegeben.')).toBeInTheDocument();
    expect(container.querySelector('[data-launch-gate="blocked"]')).toBeNull();
  });

  it('renders each issue with its blocking level', () => {
    const { container } = renderWizard(snapshotFor(INCOMPLETE_FIXTURE_MAPPING));
    const launchBlocking = container.querySelectorAll('[data-issue-blocking="LAUNCH"]');
    expect(launchBlocking.length).toBeGreaterThan(0);
    expect(screen.getAllByText('Blockiert den Live-Launch').length).toBeGreaterThan(0);
  });

  it('hides every mutating control from a role without crm.mapping.manage', () => {
    const onPublish = vi.fn(noopPublish);
    const { container } = render(
      <HubspotWizard
        snapshot={snapshotFor(FIXTURE_MAPPING)}
        canManage={false}
        onSaveStep={noopSnapshot(snapshotFor(FIXTURE_MAPPING))}
        onApplyFixture={noopSnapshot(snapshotFor(FIXTURE_MAPPING))}
        onPublish={onPublish}
        onRunTestLead={noopTestLead}
        onRunWebhookTest={noopProbe}
        onRunReconciliationTest={noopProbe}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Als neue Version veröffentlichen' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test-Lead ausführen/ })).not.toBeInTheDocument();

    const denied = container.querySelectorAll('[data-permission-denied="crm.mapping.manage"]');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]?.textContent).toContain('RevOps');
    expect(onPublish).not.toHaveBeenCalled();
  });
});
