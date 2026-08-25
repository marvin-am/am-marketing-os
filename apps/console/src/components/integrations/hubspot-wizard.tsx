'use client';

import * as React from 'react';
import { HEALTH_STATUS_LABELS_DE } from '@am/domain';
import type { HubspotMappingDocument, MappingIssue, MappingWizardStepKey } from '@am/hubspot';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  ProviderHealthList,
  Section,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { CheckCircle2, ChevronDown, Lock, Play, Save } from 'lucide-react';
import type { ActionResult } from '@/lib/action-result';
import { formatDateTime, formatNumber } from '@/lib/format';
import type {
  HubspotMappingSnapshot,
  ProbeResultView,
  PublishMappingOutcome,
} from '@/server/ops-port';
import type { TestLeadResult } from '@am/hubspot';
import { PermissionGate } from '@/components/settings/permission-gate';
import { ActionFeedback, useAction } from './action-feedback';
import { MAPPING_FIELDS } from './mapping-fields';
import { MappingStepEditor } from './mapping-step-editor';

/**
 * The HubSpot mapping wizard (spec §22).
 *
 * All fifteen steps of `MAPPING_WIZARD_STEPS` are editable and resumable: the
 * draft is validated by `validateMapping` after every save, and each step shows
 * its own German issues together with what they block — publishing the version,
 * only the live launch, or nothing at all.
 *
 * Two gates, and they are different things:
 *
 * - **Publish** creates a new immutable version. The console requires a
 *   validation without errors, because a version that cannot go live is not
 *   worth freezing.
 * - **Live launch** additionally requires a *successful* test lead. A green
 *   mapping is a statement about our document; only a test lead that came back
 *   with a contact, a deal and a verified association is evidence that the
 *   portal actually accepts our writes.
 */

const BLOCKING_LABELS_DE: Readonly<Record<MappingIssue['blocking'], string>> = {
  PUBLISH: 'Blockiert die Veröffentlichung',
  LAUNCH: 'Blockiert den Live-Launch',
  NONE: 'Hinweis',
};

export interface HubspotWizardProps {
  snapshot: HubspotMappingSnapshot;
  canManage: boolean;
  onSaveStep: (input: {
    step: MappingWizardStepKey;
    patch: Partial<HubspotMappingDocument>;
  }) => Promise<ActionResult<HubspotMappingSnapshot>>;
  onApplyFixture: (input: { confirm: true }) => Promise<ActionResult<HubspotMappingSnapshot>>;
  onPublish: (input: { confirm: true }) => Promise<ActionResult<PublishMappingOutcome>>;
  onRunTestLead: (input: { confirm: true }) => Promise<ActionResult<TestLeadResult>>;
  onRunWebhookTest: (input: { confirm: true }) => Promise<ActionResult<ProbeResultView>>;
  onRunReconciliationTest: (input: { confirm: true }) => Promise<ActionResult<ProbeResultView>>;
}

export function HubspotWizard(props: HubspotWizardProps) {
  const { canManage } = props;
  const [snapshot, setSnapshot] = React.useState(props.snapshot);
  const [draft, setDraft] = React.useState<HubspotMappingDocument>(props.snapshot.draft);
  const [openStep, setOpenStep] = React.useState<MappingWizardStepKey | null>(
    props.snapshot.steps.find((step) => !step.complete)?.key ?? null,
  );
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [testLeadOpen, setTestLeadOpen] = React.useState(false);

  React.useEffect(() => {
    setSnapshot(props.snapshot);
    setDraft(props.snapshot.draft);
  }, [props.snapshot]);

  const save = useAction(props.onSaveStep);
  const fixture = useAction(props.onApplyFixture);
  const publish = useAction(props.onPublish);
  const testLead = useAction(props.onRunTestLead);
  const webhook = useAction(props.onRunWebhookTest);
  const reconciliation = useAction(props.onRunReconciliationTest);

  const adopt = (result: ActionResult<HubspotMappingSnapshot>) => {
    if (result.status === 'ok') {
      setSnapshot(result.data);
      setDraft(result.data.draft);
    }
  };

  // The console publishes only a validation-clean document: a frozen version
  // that could never go live is not worth having in the history.
  const blockers = snapshot.validation.errors;
  const canPublishNow = snapshot.canPublish && blockers.length === 0;
  const dirty = draft !== snapshot.draft;

  return (
    <div className="flex flex-col gap-8">
      <Section
        heading="Verbindung"
        description="Der Assistent kann ohne Verbindung vollständig ausgefüllt werden. Erst der Test-Lead braucht ein erreichbares Portal."
      >
        <ProviderHealthList
          provider="HUBSPOT"
          checks={snapshot.connection.checks}
          overall={snapshot.connection.overall}
          connectionState={snapshot.connection.state}
        />
      </Section>

      <LaunchGate snapshot={snapshot} />

      <Section
        heading="Schritte"
        description={`${formatNumber(snapshot.steps.filter((step) => step.complete).length)} von ${formatNumber(snapshot.steps.length)} Schritten vollständig. Jeder Schritt wird beim Speichern erneut geprüft; Sie können den Assistenten jederzeit verlassen und später fortsetzen.`}
        actions={
          <PermissionGate
            permission="crm.mapping.manage"
            allowed={canManage}
            actionLabelDe="Fixture-Mapping übernehmen"
          >
            <Button
              variant="secondary"
              size="sm"
              loading={fixture.pending}
              onClick={async () => adopt(await fixture.run({ confirm: true }))}
            >
              Fixture-Mapping als Ausgangspunkt übernehmen
            </Button>
          </PermissionGate>
        }
      >
        <ActionFeedback
          result={fixture.result}
          successTitleDe="Fixture-Mapping übernommen."
          successDescriptionDe="Der Entwurf enthält jetzt das vollständige Testdatensatz-Mapping. Es beschreibt kein echtes Kundenportal und ist als Fixture gekennzeichnet."
        />
        <ActionFeedback
          result={save.result}
          successTitleDe="Schritt gespeichert."
          successDescriptionDe="Der Entwurf wurde erneut geprüft. Ein gespeicherter Entwurf ist noch keine veröffentlichte Version."
        />

        <ol className="mt-4 flex flex-col gap-3">
          {snapshot.steps.map((step) => {
            const isOpen = openStep === step.key;
            const fields = MAPPING_FIELDS[step.key];
            return (
              <li key={step.key}>
                <Card data-mapping-step={step.key} data-mapping-step-complete={step.complete}>
                  <CardHeader>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpenStep(isOpen ? null : step.key)}
                      className="flex w-full flex-col gap-2 text-left"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="outline" size="sm">
                          Schritt {step.order} von {snapshot.steps.length}
                        </Badge>
                        <Badge tone={step.complete ? 'success' : 'warning'} size="sm">
                          {step.complete ? 'Vollständig' : 'Offen'}
                        </Badge>
                        {step.requiredForLaunch ? (
                          <Badge tone="info" size="sm">
                            Pflicht für den Live-Launch
                          </Badge>
                        ) : null}
                        <ChevronDown
                          aria-hidden="true"
                          className={`ml-auto size-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        />
                      </span>
                      <CardTitle className="text-sm">{step.labelDe}</CardTitle>
                      <span className="text-sm leading-relaxed text-muted-foreground">
                        {step.descriptionDe}
                      </span>
                    </button>
                  </CardHeader>

                  <CardContent className="flex flex-col gap-4">
                    <IssueList issues={step.issues} />

                    {isOpen ? (
                      <>
                        <MappingStepEditor
                          fields={fields}
                          document={draft}
                          onChange={setDraft}
                          disabled={!canManage || save.pending}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <PermissionGate
                            permission="crm.mapping.manage"
                            allowed={canManage}
                            actionLabelDe="Mapping bearbeiten"
                          >
                            <Button
                              size="sm"
                              loading={save.pending}
                              disabled={!dirty}
                              onClick={async () =>
                                adopt(await save.run({ step: step.key, patch: draft }))
                              }
                            >
                              <Save aria-hidden="true" />
                              Schritt speichern
                            </Button>
                          </PermissionGate>
                          {dirty ? (
                            <span className="text-xs text-warning-foreground">
                              Nicht gespeicherte Änderungen.
                            </span>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {step.summaryDe.map((line, index) => (
                          <li key={index} className="font-mono">
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ol>
      </Section>

      <Section
        heading="Prüfen"
        description="Test-Lead, Webhook und Abgleich prüfen, ob das Portal unsere Schreib- und Lesezugriffe tatsächlich annimmt."
      >
        <div className="flex flex-col gap-4">
          <Card data-probe="test_lead">
            <CardHeader>
              <CardTitle className="text-sm">
                Test-Lead inklusive Verknüpfungsprüfung Kontakt ↔ Deal
              </CardTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Sendet einen eindeutig gekennzeichneten Test-Lead und liest anschließend Kontakt,
                Deal und deren Verknüpfung aus HubSpot zurück. Nur ein bestandener Test-Lead gibt
                den Live-Launch frei.
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <TestLeadResultView result={snapshot.testLead} />
              <ActionFeedback
                result={testLead.result}
                successTitleDe="Test-Lead ausgeführt."
                successDescriptionDe="Das Ergebnis der einzelnen Schritte steht oben."
              />
              <PermissionGate
                permission="crm.mapping.manage"
                allowed={canManage}
                actionLabelDe="Test-Lead ausführen"
              >
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  loading={testLead.pending}
                  onClick={() => setTestLeadOpen(true)}
                >
                  <Play aria-hidden="true" />
                  Test-Lead ausführen
                </Button>
              </PermissionGate>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <ProbeCard
              testId="webhook_test"
              titleDe="Webhook-Test"
              descriptionDe="Prüft, ob Abonnements und Signaturgeheimnis hinterlegt sind. Ohne gültige Signatur werden eingehende Webhooks abgelehnt."
              result={snapshot.webhookTest}
              feedback={webhook.result}
              pending={webhook.pending}
              canManage={canManage}
              onRun={() => webhook.run({ confirm: true })}
            />
            <ProbeCard
              testId="reconciliation_test"
              titleDe="Abgleich-Test"
              descriptionDe="Liest die zuletzt geänderten Objekte und prüft, ob daraus dieselben kanonischen Ereignisse entstehen wie über die Webhooks."
              result={snapshot.reconciliationTest}
              feedback={reconciliation.result}
              pending={reconciliation.pending}
              canManage={canManage}
              onRun={() => reconciliation.run({ confirm: true })}
            />
          </div>
        </div>
      </Section>

      <Section
        heading="Veröffentlichen"
        description="Eine veröffentlichte Version ist unveränderlich. Jede spätere Änderung erzeugt eine neue Version; die Historie zeigt immer, was tatsächlich in Kraft war."
      >
        <div className="flex flex-col gap-4">
          {canPublishNow ? (
            <Alert tone="success" data-publish-gate="open">
              <AlertTitle>Der Entwurf kann veröffentlicht werden.</AlertTitle>
              <AlertDescription>
                Alle Pflichtangaben sind vollständig. Beim Veröffentlichen entsteht Version{' '}
                {formatNumber(
                  (snapshot.versions.filter((v) => v.status === 'PUBLISHED').at(-1)?.version ?? 0) +
                    1,
                )}
                .
              </AlertDescription>
            </Alert>
          ) : (
            <Alert tone="warning" data-publish-gate="blocked">
              <AlertTitle>
                Veröffentlichen ist gesperrt: {formatNumber(blockers.length)} Pflichtangabe(n)
                fehlen.
              </AlertTitle>
              <AlertDescription>
                <p className="mb-2">
                  Offene Schritte: {snapshot.validation.incompleteStepsDe.join(', ') || 'keine'}
                </p>
                <ul className="list-inside list-disc" data-testid="publish-blockers">
                  {blockers.map((issue) => (
                    <li key={`${issue.path}-${issue.code}`}>
                      <span className="font-mono text-xs">{issue.path}</span>: {issue.messageDe}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <ActionFeedback
            result={publish.result}
            successTitleDe="Version veröffentlicht."
            successDescriptionDe={
              publish.result?.status === 'ok' ? publish.result.data.messageDe : undefined
            }
          />

          <PermissionGate
            permission="crm.mapping.manage"
            allowed={canManage}
            actionLabelDe="Mapping veröffentlichen"
          >
            <Button
              className="self-start"
              disabled={!canPublishNow}
              loading={publish.pending}
              onClick={() => setPublishOpen(true)}
            >
              Als neue Version veröffentlichen
            </Button>
          </PermissionGate>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Veröffentlicht am</TableHead>
                  <TableHead>Herkunft</TableHead>
                  <TableHead>Notiz</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.versions.map((version) => (
                  <TableRow key={`${version.id}-${version.version}-${version.status}`}>
                    <TableCell className="tabular-nums">v{version.version}</TableCell>
                    <TableCell>
                      <StatusBadge kind="funnelVersion" state={version.status} size="sm" />
                    </TableCell>
                    <TableCell>
                      {version.publishedAt ? formatDateTime(version.publishedAt) : '–'}
                    </TableCell>
                    <TableCell>{version.sourceDe}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {version.notesDe ?? '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </Section>

      <ConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title="Mapping als neue Version veröffentlichen"
        description="Die Version wird eingefroren und kann danach nicht mehr geändert werden. Änderungen erzeugen künftig eine neue Version."
        preview={
          <ul className="flex flex-col gap-1 text-sm">
            <li>Portal: {snapshot.draft.portalId ?? 'nicht hinterlegt'}</li>
            <li>Pipeline: {snapshot.draft.pipeline.pipelineId ?? 'nicht ausgewählt'}</li>
            <li>Stage-Regeln: {formatNumber(snapshot.draft.stageEvents.length)}</li>
            <li>Wertregeln: {formatNumber(snapshot.draft.propertyValueEvents.length)}</li>
            <li>Formularfelder: {formatNumber(snapshot.draft.formFieldMappings.length)}</li>
            <li>Hinweise ohne Blockade: {formatNumber(snapshot.validation.warnings.length)}</li>
            <li className="text-muted-foreground">
              Es wird nichts an HubSpot gesendet. Veröffentlichen betrifft nur unser eigenes,
              versioniertes Mapping-Dokument.
            </li>
          </ul>
        }
        confirmPhrase="VEROEFFENTLICHEN"
        confirmLabel="Version veröffentlichen"
        tone="primary"
        pending={publish.pending}
        onConfirm={async () => {
          await publish.run({ confirm: true });
          setPublishOpen(false);
        }}
      />

      <ConfirmDialog
        open={testLeadOpen}
        onOpenChange={setTestLeadOpen}
        title="Test-Lead an HubSpot senden"
        description="Es wird ein echter, als Testdatensatz gekennzeichneter Kontakt samt Deal im Portal angelegt und anschließend zurückgelesen."
        preview={
          <ul className="flex flex-col gap-1 text-sm">
            <li>
              Adresse:{' '}
              <span className="font-mono text-xs">
                {snapshot.draft.testLead.emailDomain
                  ? `${snapshot.draft.testLead.emailLocalPart}+<token>@${snapshot.draft.testLead.emailDomain}`
                  : 'keine E-Mail-Domain hinterlegt'}
              </span>
            </li>
            <li>
              Kennzeichnung: {snapshot.draft.testLead.markerProperty ?? 'nicht hinterlegt'} ={' '}
              {snapshot.draft.testLead.markerValue}
            </li>
            <li>Auslösendes Ereignis: {snapshot.draft.dealCreation.trigger}</li>
            <li className="text-muted-foreground">
              Sind HubSpot-Schreibzugriffe deaktiviert, endet der Test als Dry-Run. Ein Dry-Run gibt
              den Live-Launch nicht frei.
            </li>
          </ul>
        }
        confirmLabel="Test-Lead senden"
        tone="primary"
        pending={testLead.pending}
        onConfirm={async () => {
          await testLead.run({ confirm: true });
          setTestLeadOpen(false);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Launch gate                                                                 */
/* -------------------------------------------------------------------------- */

function LaunchGate({ snapshot }: { snapshot: HubspotMappingSnapshot }) {
  if (snapshot.launchReady) {
    return (
      <Alert tone="success" data-launch-gate="open">
        <AlertTitle>Live-Launch freigegeben.</AlertTitle>
        <AlertDescription>
          Das Pflichtmapping ist vollständig und ein Test-Lead wurde erfolgreich verarbeitet —
          Kontakt, Deal und Verknüpfung wurden in HubSpot nachgewiesen.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert tone="warning" data-launch-gate="blocked">
      <AlertTitle>Live-Launch gesperrt.</AlertTitle>
      <AlertDescription>
        <p className="mb-2">
          Es fehlt noch Folgendes. Bis dahin nimmt keine Kampagne echte Leads entgegen:
        </p>
        <ul className="list-inside list-disc" data-testid="launch-blockers">
          {snapshot.missingForLaunchDe.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/* -------------------------------------------------------------------------- */
/* Issues                                                                      */
/* -------------------------------------------------------------------------- */

function IssueList({ issues }: { issues: readonly MappingIssue[] }) {
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-success-foreground">
        <CheckCircle2 aria-hidden="true" className="size-3.5" />
        Keine offenen Punkte in diesem Schritt.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue) => (
        <li
          key={`${issue.path}-${issue.code}`}
          data-issue-blocking={issue.blocking}
          className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-sm ${
            issue.severity === 'ERROR'
              ? 'border-destructive-border bg-destructive-surface'
              : 'border-warning-border bg-warning-surface'
          }`}
        >
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={issue.severity === 'ERROR' ? 'destructive' : 'warning'} size="sm">
              {issue.severity === 'ERROR' ? 'Fehler' : 'Hinweis'}
            </Badge>
            <Badge tone="outline" size="sm">
              {BLOCKING_LABELS_DE[issue.blocking]}
            </Badge>
            <code className="font-mono text-xs text-muted-foreground">{issue.path}</code>
          </span>
          <span className="leading-relaxed text-foreground">{issue.messageDe}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Probes                                                                      */
/* -------------------------------------------------------------------------- */

function TestLeadResultView({ result }: { result: TestLeadResult | null }) {
  if (!result) {
    return (
      <p className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
        <Lock aria-hidden="true" className="size-3.5 shrink-0" />
        Es wurde noch kein Test-Lead ausgeführt. Der Live-Launch bleibt bis dahin gesperrt.
      </p>
    );
  }

  const tone =
    result.status === 'PASS' ? 'success' : result.status === 'FAIL' ? 'destructive' : 'warning';

  return (
    <div className="flex flex-col gap-3" data-test-lead-status={result.status}>
      <Alert tone={tone}>
        <AlertTitle>
          {result.status === 'PASS'
            ? 'Test-Lead erfolgreich.'
            : result.status === 'FAIL'
              ? 'Test-Lead fehlgeschlagen.'
              : result.status === 'DRY_RUN'
                ? 'Dry-Run – nicht ausgeführt.'
                : 'Test-Lead wartet auf externen Input.'}
        </AlertTitle>
        <AlertDescription>
          {result.messagesDe.join(' ')}
          {result.gatePassed ? '' : ' Der Live-Launch bleibt gesperrt.'}
        </AlertDescription>
      </Alert>

      <ul className="flex flex-col gap-1.5">
        {result.steps.map((step) => (
          <li
            key={step.key}
            data-test-lead-step={step.key}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-foreground">{step.labelDe}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{step.detailDe}</span>
            </span>
            <StatusBadge kind="health" state={step.status} size="sm" />
          </li>
        ))}
      </ul>

      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Kontakt-ID</dt>
          <dd className="font-mono">{result.contactId ?? 'nicht angelegt'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Deal-ID</dt>
          <dd className="font-mono">{result.dealId ?? 'nicht angelegt'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Verknüpfung geprüft</dt>
          <dd>{result.associationVerified ? 'ja' : 'nein'}</dd>
        </div>
      </dl>
    </div>
  );
}

interface ProbeCardProps {
  testId: string;
  titleDe: string;
  descriptionDe: string;
  result: ProbeResultView | null;
  feedback: ActionResult<ProbeResultView> | null;
  pending: boolean;
  canManage: boolean;
  onRun: () => void;
}

function ProbeCard({
  testId,
  titleDe,
  descriptionDe,
  result,
  feedback,
  pending,
  canManage,
  onRun,
}: ProbeCardProps) {
  return (
    <Card data-probe={testId} className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="text-sm">{titleDe}</CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">{descriptionDe}</p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {result ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="health" state={result.status} size="sm" />
              <span className="text-xs text-muted-foreground">
                {HEALTH_STATUS_LABELS_DE[result.status]} · {formatDateTime(result.checkedAt)}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-foreground">{result.detailDe}</p>
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
            Noch nicht ausgeführt.
          </p>
        )}

        <ActionFeedback
          result={feedback}
          successTitleDe="Prüfung ausgeführt."
          successDescriptionDe="Das Ergebnis steht oben."
        />

        <PermissionGate
          permission="crm.mapping.manage"
          allowed={canManage}
          actionLabelDe={titleDe}
        >
          <Button
            variant="secondary"
            size="sm"
            className="mt-auto self-start"
            loading={pending}
            onClick={onRun}
          >
            <Play aria-hidden="true" />
            Jetzt prüfen
          </Button>
        </PermissionGate>
      </CardContent>
    </Card>
  );
}
