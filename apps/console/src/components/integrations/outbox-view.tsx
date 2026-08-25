'use client';

import * as React from 'react';
import Link from 'next/link';
import type { OutboxState } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Section,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { ChevronDown, RotateCcw } from 'lucide-react';
import type { ActionResult } from '@/lib/action-result';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import type { OutboxRetryOutcome, OutboxRow, OutboxSnapshot } from '@/server/ops-port';
import { PermissionGate } from '@/components/settings/permission-gate';
import { ActionFeedback, useAction } from './action-feedback';

/**
 * The outbox and its dead letter.
 *
 * Everything the transactional outbox is for becomes visible here: what is
 * queued, what is retrying, what gave up — each with the provider's own error
 * and its **redacted** response, because a raw provider payload carries PII
 * (AGENTS.md rule 7). A retry re-delivers an existing stored event; it never
 * creates a new one, and a successful dispatch is only reported as confirmed
 * once the provider acknowledged it.
 */

const FILTERS = [
  { key: 'ALL', labelDe: 'Alle' },
  { key: 'PENDING', labelDe: 'Ausstehend' },
  { key: 'FAILED_RETRYING', labelDe: 'In Wiederholung' },
  { key: 'DEAD_LETTER', labelDe: 'Dead Letter' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

function matchesFilter(status: OutboxState, filter: FilterKey): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'PENDING') return status === 'PENDING' || status === 'PROCESSING';
  return status === filter;
}

export interface OutboxViewProps {
  snapshot: OutboxSnapshot;
  canManage: boolean;
  onRetry: (input: { eventId: string }) => Promise<ActionResult<OutboxRetryOutcome>>;
}

export function OutboxView({ snapshot, canManage, onRetry }: OutboxViewProps) {
  const [filter, setFilter] = React.useState<FilterKey>('ALL');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [pendingRow, setPendingRow] = React.useState<OutboxRow | null>(null);
  const retry = useAction(onRetry);

  const rows = snapshot.rows.filter((row) => matchesFilter(row.event.status, filter));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{formatNumber(snapshot.pendingCount)} ausstehend</Badge>
        <Badge tone={snapshot.retryingCount > 0 ? 'warning' : 'neutral'}>
          {formatNumber(snapshot.retryingCount)} in Wiederholung
        </Badge>
        <Badge tone={snapshot.deadLetterCount > 0 ? 'destructive' : 'neutral'}>
          {formatNumber(snapshot.deadLetterCount)} im Dead Letter
        </Badge>
      </div>

      {snapshot.deadLetterCount > 0 ? (
        <Alert tone="destructive">
          <AlertTitle>
            {snapshot.deadLetterCount === 1
              ? '1 Ereignis hat aufgegeben'
              : `${formatNumber(snapshot.deadLetterCount)} Ereignisse haben aufgegeben`}
          </AlertTitle>
          <AlertDescription>
            Diese Ereignisse haben den Anbieter nie erreicht. Alle Kennzahlen, die auf ihnen
            beruhen, sind unvollständig, bis sie erfolgreich zugestellt wurden.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Status filtern">
        {FILTERS.map((entry) => (
          <Button
            key={entry.key}
            variant={filter === entry.key ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={filter === entry.key}
            onClick={() => setFilter(entry.key)}
          >
            {entry.labelDe}
          </Button>
        ))}
      </div>

      <ActionFeedback
        result={retry.result}
        successTitleDe="Wiederholung angestoßen."
        successDescriptionDe={
          retry.result?.status === 'ok' ? retry.result.data.messageDe : undefined
        }
      />

      <Section
        heading="Ereignisse"
        description="Geschäftszeit ist der Zeitpunkt des Ereignisses, nicht der des Zustellversuchs."
      >
        {rows.length === 0 ? (
          <EmptyState
            size="sm"
            title="Keine Ereignisse in diesem Status."
            description="Wählen Sie einen anderen Filter, um weitere Ereignisse zu sehen."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ereignis</TableHead>
                  <TableHead>Ziel</TableHead>
                  <TableHead>Geschäftszeit</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Versuche</TableHead>
                  <TableHead>Nächster Versuch</TableHead>
                  <TableHead>Aktion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isOpen = expanded === row.event.event_id;
                  return (
                    <React.Fragment key={row.event.event_id}>
                      <TableRow data-outbox-row={row.event.event_id}>
                        <TableCell>
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() =>
                              setExpanded(isOpen ? null : row.event.event_id)
                            }
                            className="flex items-start gap-1.5 text-left"
                          >
                            <ChevronDown
                              aria-hidden="true"
                              className={`mt-0.5 size-3.5 shrink-0 transition-transform ${
                                isOpen ? 'rotate-180' : ''
                              }`}
                            />
                            <span>
                              <span className="block font-medium">{row.event.event_name}</span>
                              <span className="block font-mono text-xs text-muted-foreground">
                                {row.event.event_id}
                              </span>
                            </span>
                          </button>
                        </TableCell>
                        <TableCell>{row.destinationLabelDe}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatDateTime(row.event.event_time)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge kind="outbox" state={row.event.status} size="sm" />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(row.event.attempt_count)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {row.event.next_attempt_at
                            ? formatRelative(row.event.next_attempt_at)
                            : '–'}
                        </TableCell>
                        <TableCell>
                          {row.retryable ? (
                            <PermissionGate
                              permission="integration.manage"
                              allowed={canManage}
                              actionLabelDe="Ereignis erneut senden"
                            >
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setPendingRow(row)}
                              >
                                <RotateCcw aria-hidden="true" />
                                Erneut senden
                              </Button>
                            </PermissionGate>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              keine Wiederholung nötig
                            </span>
                          )}
                        </TableCell>
                      </TableRow>

                      {isOpen ? (
                        <TableRow data-outbox-detail={row.event.event_id}>
                          <TableCell colSpan={7} className="bg-surface-sunken">
                            <div className="flex flex-col gap-3 py-1">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Letzter Fehler
                                </p>
                                <p className="text-sm leading-relaxed text-foreground">
                                  {row.event.last_error ?? 'Kein Fehler aufgetreten.'}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Antwort des Anbieters (redigiert)
                                </p>
                                <pre className="mt-1 max-h-56 overflow-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed">
                                  {row.event.provider_response_redacted
                                    ? JSON.stringify(row.event.provider_response_redacted, null, 2)
                                    : 'Keine Antwort gespeichert.'}
                                </pre>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Personenbezogene Felder werden vor dem Speichern entfernt; die
                                  Rohantwort wird nie abgelegt.
                                </p>
                              </div>
                              <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                                <div>
                                  <dt className="text-muted-foreground">Payload-Hash</dt>
                                  <dd className="font-mono">{row.event.payload_hash.slice(0, 16)}…</dd>
                                </div>
                                <div>
                                  <dt className="text-muted-foreground">Erstellt</dt>
                                  <dd>{formatDateTime(row.event.created_at)}</dd>
                                </div>
                                <div>
                                  <dt className="text-muted-foreground">Gesendet</dt>
                                  <dd>
                                    {row.event.sent_at ? formatDateTime(row.event.sent_at) : 'nie'}
                                  </dd>
                                </div>
                              </dl>
                              {row.href ? (
                                <Link
                                  href={row.href}
                                  className="text-sm font-medium text-brand underline-offset-4 hover:underline"
                                >
                                  Zugehörige Kampagne öffnen
                                </Link>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={pendingRow !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRow(null);
        }}
        title="Ereignis erneut an den Anbieter senden"
        description="Das bereits gespeicherte Ereignis wird noch einmal zugestellt. Durch die Deduplizierungs-ID entsteht beim Anbieter kein zweites Ereignis."
        preview={
          pendingRow ? (
            <ul className="flex flex-col gap-1 text-sm">
              <li>
                Ereignis: <span className="font-medium">{pendingRow.event.event_name}</span>
              </li>
              <li className="font-mono text-xs">{pendingRow.event.event_id}</li>
              <li>Ziel: {pendingRow.destinationLabelDe}</li>
              <li>Geschäftszeit: {formatDateTime(pendingRow.event.event_time)}</li>
              <li>Bisherige Versuche: {formatNumber(pendingRow.event.attempt_count)}</li>
              <li className="text-muted-foreground">
                Sind externe Schreibzugriffe deaktiviert, endet der Versuch als Dry-Run und es wird
                nichts gesendet.
              </li>
            </ul>
          ) : null
        }
        confirmLabel="Erneut senden"
        cancelLabel="Abbrechen"
        tone="primary"
        pending={retry.pending}
        onConfirm={async () => {
          if (!pendingRow) return;
          await retry.run({ eventId: pendingRow.event.event_id });
          setPendingRow(null);
        }}
      />
    </div>
  );
}
