'use client';

import * as React from 'react';
import {
  HEALTH_STATUS_LABELS_DE,
  type HealthStatus,
  type Provider,
  type ProviderHealth,
} from '@am/domain';
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
import { ArrowRight, RotateCcw } from 'lucide-react';
import type { ActionResult } from '@/lib/action-result';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { MetaSetupSnapshot, MetaWizardStep } from '@/server/ops-port';
import { PermissionGate } from '@/components/settings/permission-gate';
import { ActionFeedback, useAction } from './action-feedback';

/**
 * The Meta setup wizard (spec §21).
 *
 * Ten steps, and every one of them is a real probe rather than a checkbox the
 * operator ticks: app connection, business, ad account, page/Instagram,
 * pixel/dataset, permissions, insights read, paused draft, Conversions API and
 * the aggregated final verdict. Two of them — the draft test and the CAPI test
 * — deliberately build a complete, valid request and then do not send it.
 *
 * Until credentials exist the wizard runs against the Meta fixture provider and
 * says so at the top, in those words. No step is ever green because a value was
 * typed into a form; a step is green because Meta answered.
 */

const STATUS_ORDER: Readonly<Record<HealthStatus, number>> = {
  FAIL: 0,
  AWAITING_EXTERNAL_INPUT: 1,
  WARN: 2,
  PASS: 3,
};

function stepTone(status: HealthStatus): 'success' | 'warning' | 'destructive' | 'info' {
  switch (status) {
    case 'PASS':
      return 'success';
    case 'WARN':
      return 'warning';
    case 'FAIL':
      return 'destructive';
    case 'AWAITING_EXTERNAL_INPUT':
      return 'info';
  }
}

export interface MetaWizardProps {
  snapshot: MetaSetupSnapshot;
  canManage: boolean;
  onRecheck: (input: { provider: Provider }) => Promise<ActionResult<ProviderHealth>>;
}

export function MetaWizard({ snapshot, canManage, onRecheck }: MetaWizardProps) {
  const [health, setHealth] = React.useState<ProviderHealth>(snapshot.health);
  const recheck = useAction(onRecheck);

  React.useEffect(() => {
    setHealth(snapshot.health);
  }, [snapshot.health]);

  const steps: MetaWizardStep[] = React.useMemo(
    () =>
      snapshot.steps.map((step) => {
        if (step.key === 'meta.final_health') {
          return { ...step, status: health.overall };
        }
        const check = health.checks.find((entry) => entry.key === step.key) ?? step.check;
        return { ...step, check, status: check?.status ?? step.status };
      }),
    [snapshot.steps, health],
  );

  const open = steps.filter((step) => step.status !== 'PASS').length;
  const worst = steps.reduce<HealthStatus>(
    (acc, step) => (STATUS_ORDER[step.status] < STATUS_ORDER[acc] ? step.status : acc),
    'PASS',
  );

  const handleRecheck = async () => {
    const result = await recheck.run({ provider: 'META' });
    if (result.status === 'ok') setHealth(result.data);
  };

  return (
    <div className="flex flex-col gap-6">
      {snapshot.fixtureNoticeDe ? (
        <Alert tone="info" data-meta-mode="FIXTURE">
          <AlertTitle>Fixture-Modus – keine Verbindung zu Meta</AlertTitle>
          <AlertDescription>{snapshot.fixtureNoticeDe}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind="connection" state={health.state} />
        <StatusBadge kind="health" state={worst} />
        <Badge tone="neutral">
          {open === 0
            ? 'Alle 10 Schritte abgeschlossen'
            : `${formatNumber(open)} von 10 Schritten offen`}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Zuletzt geprüft: {formatDateTime(health.checkedAt)}
        </span>
        <PermissionGate
          permission="integration.manage"
          allowed={canManage}
          actionLabelDe="Prüfungen ausführen"
        >
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={handleRecheck}
            loading={recheck.pending}
          >
            <RotateCcw aria-hidden="true" />
            Alle Schritte erneut prüfen
          </Button>
        </PermissionGate>
      </div>

      <ActionFeedback
        result={recheck.result}
        successTitleDe="Prüfungen abgeschlossen."
        successDescriptionDe="Die Schritte unten zeigen das aktuelle Ergebnis. Es wurde nichts bei Meta angelegt oder gesendet."
      />

      <Section
        heading="Schritte"
        description="Jeder Schritt ist eine echte Prüfung gegen die Meta-API. Ein Schritt wird nie grün, weil ein Wert eingetragen wurde — nur, weil Meta geantwortet hat."
      >
        <ol className="flex flex-col gap-3">
          {steps.map((step) => (
            <li key={step.key}>
              <Card data-meta-step={step.key} data-meta-step-status={step.status}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="outline" size="sm">
                      Schritt {step.order} von 10
                    </Badge>
                    <Badge tone={stepTone(step.status)} size="sm">
                      {HEALTH_STATUS_LABELS_DE[step.status]}
                    </Badge>
                  </div>
                  <CardTitle className="text-sm">{step.labelDe}</CardTitle>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {step.descriptionDe}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  {step.check?.detailDe ? (
                    <p className="leading-relaxed text-foreground">{step.check.detailDe}</p>
                  ) : null}
                  {step.check?.remediationDe ? (
                    <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2 text-xs leading-relaxed">
                      <ArrowRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <span className="font-semibold">Nächster Schritt: </span>
                        {step.check.remediationDe}
                      </span>
                    </p>
                  ) : null}
                  {step.key === 'meta.final_health' ? (
                    <p className="leading-relaxed text-muted-foreground">
                      Gesamtergebnis über alle Prüfungen:{' '}
                      <span className="font-medium text-foreground">
                        {HEALTH_STATUS_LABELS_DE[health.overall]}
                      </span>
                      . Ein offener „Wartet auf externen Input“ wird nie zu „OK“ aufgewertet.
                    </p>
                  ) : null}
                  {step.requiredEnvVars.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Benötigt:{' '}
                      {step.requiredEnvVars.map((name) => (
                        <code key={name} className="mr-1 font-mono">
                          {name}
                        </code>
                      ))}
                    </p>
                  ) : null}
                  {step.check?.blocksLiveOnly ? (
                    <p className="text-xs text-muted-foreground">
                      Blockiert nur den Live-Schritt — die Konsole arbeitet währenddessen normal
                      weiter.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        heading="Hinterlegte Angaben"
        description="Es wird nur angezeigt, was tatsächlich hinterlegt ist. Geheimnisse werden nie dargestellt, und im Fixture-Modus wird kein Wert als von Meta bestätigt ausgegeben."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Angabe</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Wert</TableHead>
                <TableHead>Herkunft</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.credentials.map((slot) => (
                <TableRow key={slot.envVar} data-credential={slot.envVar}>
                  <TableCell className="font-medium">{slot.labelDe}</TableCell>
                  <TableCell>
                    <Badge tone={slot.present ? 'success' : 'info'} size="sm">
                      {slot.present ? 'Hinterlegt' : 'Nicht hinterlegt'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {slot.displayValue ?? '–'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{slot.originDe}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section
        heading="Alle Prüfergebnisse"
        description="Dieselben Ergebnisse in kompakter Form, wie sie auch auf der Übersicht erscheinen."
      >
        <ProviderHealthList
          provider="META"
          checks={health.checks}
          overall={health.overall}
          connectionState={health.state}
          onRecheck={canManage ? handleRecheck : undefined}
          rechecking={recheck.pending}
        />
      </Section>
    </div>
  );
}
