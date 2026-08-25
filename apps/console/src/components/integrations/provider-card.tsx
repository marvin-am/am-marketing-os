'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  CONNECTION_STATE_LABELS_DE,
  HEALTH_STATUS_LABELS_DE,
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
  ConfirmDialog,
  ProviderHealthList,
  StatusBadge,
} from '@am/ui';
import { ArrowRight, RotateCcw } from 'lucide-react';
import type { ActionResult } from '@/lib/action-result';
import { formatDateTime, formatNumber } from '@/lib/format';
import { CONNECTION_STATE_HINTS_DE, type ProviderCardData } from '@/server/ops-port';
import { PermissionGate } from '@/components/settings/permission-gate';
import { ActionFeedback, useAction } from './action-feedback';

/**
 * One provider on the integrations overview.
 *
 * The card's job is to make three things unmistakable at a glance: whether the
 * product is connected at all, whether a probe is *waiting on input* rather
 * than broken, and how many events are stuck. `AWAITING_EXTERNAL_INPUT` gets
 * its own headline and its own wording — it is not a failure and must never be
 * coloured or worded like one (spec §29).
 */

const PROVIDER_LABELS_DE: Readonly<Record<Provider, string>> = {
  META: 'Meta',
  HUBSPOT: 'HubSpot',
  OPENAI: 'OpenAI',
  SUPABASE: 'Supabase',
};

export interface ProviderCardProps {
  data: ProviderCardData;
  canManage: boolean;
  onRecheck: (input: { provider: Provider }) => Promise<ActionResult<ProviderHealth>>;
  onRetryFailed: (input: { provider: Provider }) => Promise<ActionResult<{ attempted: number }>>;
}

export function ProviderCard({ data, canManage, onRecheck, onRetryFailed }: ProviderCardProps) {
  const [health, setHealth] = React.useState<ProviderHealth>(data.health);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const recheck = useAction(onRecheck);
  const retry = useAction(onRetryFailed);

  React.useEffect(() => {
    setHealth(data.health);
  }, [data.health]);

  const awaiting = health.checks.filter((check) => check.status === 'AWAITING_EXTERNAL_INPUT');
  const failing = health.checks.filter((check) => check.status === 'FAIL');
  const stuck = data.errorCount + data.deadLetterCount;

  const handleRecheck = async () => {
    const result = await recheck.run({ provider: data.provider });
    if (result.status === 'ok') setHealth(result.data);
  };

  return (
    <Card data-provider={data.provider} className="flex h-full flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="connection" state={health.state} />
          <StatusBadge kind="health" state={health.overall} />
        </div>
        <CardTitle className="text-base">{PROVIDER_LABELS_DE[data.provider]}</CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">{data.modeDe}</p>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        {failing.length > 0 ? (
          <Alert tone="destructive" data-provider-state="FAIL">
            <AlertTitle>
              {failing.length === 1
                ? '1 Prüfung ist fehlgeschlagen'
                : `${formatNumber(failing.length)} Prüfungen sind fehlgeschlagen`}
            </AlertTitle>
            <AlertDescription>
              Hier ist etwas kaputt, nicht nur unvollständig. Bitte die Fehlermeldungen unten
              bearbeiten.
            </AlertDescription>
          </Alert>
        ) : null}

        {awaiting.length > 0 ? (
          <Alert tone="info" data-provider-state="AWAITING_EXTERNAL_INPUT">
            <AlertTitle>
              {awaiting.length === 1
                ? '1 Prüfung wartet auf externen Input'
                : `${formatNumber(awaiting.length)} Prüfungen warten auf externen Input`}
            </AlertTitle>
            <AlertDescription>
              Das ist kein Fehler: Das Produkt funktioniert, es fehlen Zugangsdaten oder Angaben,
              die nur von außen kommen können. Bis dahin wird mit Testdaten gearbeitet.
            </AlertDescription>
          </Alert>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-surface-sunken px-3 py-2.5 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Verbindungsstatus</dt>
            <dd className="font-medium text-foreground">
              {CONNECTION_STATE_LABELS_DE[health.state]}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Gesamtergebnis</dt>
            <dd className="font-medium text-foreground">
              {HEALTH_STATUS_LABELS_DE[health.overall]}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Letzte Synchronisation</dt>
            <dd className="font-medium text-foreground">
              {data.lastSyncAt ? formatDateTime(data.lastSyncAt) : 'noch nie'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Zuletzt geprüft</dt>
            <dd className="font-medium text-foreground">{formatDateTime(health.checkedAt)}</dd>
          </div>
        </dl>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {CONNECTION_STATE_HINTS_DE[health.state]}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={data.errorCount > 0 ? 'warning' : 'neutral'} size="sm">
            {formatNumber(data.errorCount)} in Wiederholung
          </Badge>
          <Badge tone={data.deadLetterCount > 0 ? 'destructive' : 'neutral'} size="sm">
            {formatNumber(data.deadLetterCount)} im Dead Letter
          </Badge>
        </div>

        <ProviderHealthList
          checks={health.checks}
          overall={health.overall}
          onRecheck={canManage ? handleRecheck : undefined}
          rechecking={recheck.pending}
        />

        <ActionFeedback
          result={recheck.result}
          successTitleDe="Prüfung abgeschlossen."
          successDescriptionDe="Die Ergebnisse oben sind auf dem aktuellen Stand."
        />
        <ActionFeedback
          result={retry.result}
          successTitleDe="Wiederholung angestoßen."
          successDescriptionDe="Der Versand gilt erst als erfolgreich, wenn der Anbieter ihn bestätigt hat."
        />

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          {data.setupHref && data.setupLabelDe ? (
            <Link
              href={data.setupHref}
              className="inline-flex items-center gap-1 text-sm font-medium text-brand underline-offset-4 hover:underline"
            >
              {data.setupLabelDe}
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null}

          {stuck > 0 ? (
            <>
              <Link
                href="/integrationen/outbox"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand underline-offset-4 hover:underline"
              >
                Fehlerliste öffnen
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
              <PermissionGate
                permission="integration.manage"
                allowed={canManage}
                actionLabelDe="Fehlgeschlagene Ereignisse wiederholen"
              >
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setConfirmOpen(true)}
                  loading={retry.pending}
                >
                  <RotateCcw aria-hidden="true" />
                  {formatNumber(stuck)} erneut senden
                </Button>
              </PermissionGate>
            </>
          ) : null}
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`${formatNumber(stuck)} Ereignis(se) erneut an ${PROVIDER_LABELS_DE[data.provider]} senden`}
        description="Es werden ausschließlich die unten aufgeführten, bereits gespeicherten Ereignisse erneut zugestellt. Es entstehen keine neuen Ereignisse."
        preview={
          <ul className="flex flex-col gap-1 text-sm">
            <li>
              Anbieter: <span className="font-medium">{PROVIDER_LABELS_DE[data.provider]}</span>
            </li>
            <li>In Wiederholung: {formatNumber(data.errorCount)}</li>
            <li>Im Dead Letter: {formatNumber(data.deadLetterCount)}</li>
            <li className="text-muted-foreground">
              Sind externe Schreibzugriffe deaktiviert, endet der Versuch als Dry-Run und es wird
              nichts gesendet.
            </li>
          </ul>
        }
        confirmLabel="Erneut senden"
        cancelLabel="Abbrechen"
        tone="primary"
        pending={retry.pending}
        onConfirm={async () => {
          await retry.run({ provider: data.provider });
          setConfirmOpen(false);
        }}
      />
    </Card>
  );
}
