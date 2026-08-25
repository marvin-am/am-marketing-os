'use client';

import * as React from 'react';
import { CopyPlus, History, Save, Upload } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  PageHeader,
  StatusBadge,
  toast,
} from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import { formatDateTime } from '@/lib/format';
import { PUBLISHED_IMMUTABLE_NOTE_DE } from './labels';
import type { BuilderCommands, VersionSummary } from './port';

/**
 * The bar that owns a version's lifecycle: save, publish, fork, restore.
 *
 * A published version is frozen (AGENTS.md rule 6), so the bar does not pretend
 * otherwise: on a published version every editor control is read-only, the save
 * button is gone rather than disabled-and-mysterious, and the only offered path
 * forward is "Als neuen Entwurf bearbeiten", which says in one sentence what it
 * will do.
 *
 * Errors block saving. That is not a UI preference — storing a spec that
 * `validateFormSpec` rejects would put a broken document one click away from
 * being published — so the button is disabled with the reason spelled out next
 * to it, and warnings deliberately do not block anything.
 */

type Busy = 'save' | 'publish' | 'duplicate' | 'restore' | null;

interface Feedback {
  tone: 'success' | 'destructive' | 'info';
  messageDe: string;
}

export interface VersionBarProps<TSpec> {
  titleDe: string;
  descriptionDe: string;
  spec: TSpec;
  version: number;
  published: boolean;
  dirty: boolean;
  /** True when `validateFormSpec` / `validatePageSpec` reported an error. */
  blocking: boolean;
  issueSummaryDe: string;
  versions: readonly VersionSummary[];
  commands: BuilderCommands<TSpec>;
  /** Navigates to another version; the route wires this to the router. */
  onOpenVersion: (versionId: string) => void;
  onSaved: () => void;
}

export function VersionBar<TSpec>({
  titleDe,
  descriptionDe,
  spec,
  version,
  published,
  dirty,
  blocking,
  issueSummaryDe,
  versions,
  commands,
  onOpenVersion,
  onSaved,
}: VersionBarProps<TSpec>) {
  const [busy, setBusy] = React.useState<Busy>(null);
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);

  async function run<T>(
    kind: NonNullable<Busy>,
    action: () => Promise<ActionResult<T>>,
    onOk: (data: T) => Feedback,
  ): Promise<void> {
    setBusy(kind);
    setFeedback(null);
    try {
      const result = await action();
      if (result.status === 'ok') {
        const next = onOk(result.data);
        setFeedback(next);
        toast.success(next.messageDe);
        return;
      }
      if (result.status === 'dry_run') {
        /* A dry run is never rendered as success (AGENTS.md rule 2). */
        setFeedback({
          tone: 'info',
          messageDe:
            'Es wurde nichts gespeichert: Der Vorgang lief als Probelauf. Prüfen Sie die Freigabe für Schreibvorgänge.',
        });
        return;
      }
      setFeedback({ tone: 'destructive', messageDe: result.messageDe });
      toast.error(result.messageDe);
    } catch {
      const messageDe =
        'Die Aktion konnte nicht ausgeführt werden. Bitte versuchen Sie es erneut.';
      setFeedback({ tone: 'destructive', messageDe });
      toast.error(messageDe);
    } finally {
      setBusy(null);
    }
  }

  const saveHint = published
    ? 'Veröffentlichte Versionen lassen sich nicht überschreiben.'
    : blocking
      ? 'Fehler verhindern das Speichern. Beheben Sie zuerst die markierten Stellen.'
      : dirty
        ? undefined
        : 'Es gibt keine ungespeicherten Änderungen.';

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title={titleDe}
        description={descriptionDe}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="funnelVersion" state={published ? 'PUBLISHED' : 'DRAFT'} />
            <Badge tone="neutral" size="sm">{`Version ${version}`}</Badge>
            {dirty && !published ? (
              <Badge tone="warning" size="sm">
                Nicht gespeicherte Änderungen
              </Badge>
            ) : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((current) => !current)}
            >
              <History aria-hidden="true" />
              Versionen
            </Button>

            <Button
              type="button"
              variant="secondary"
              loading={busy === 'duplicate'}
              loadingLabel="Entwurf wird erstellt …"
              disabled={busy !== null}
              onClick={() =>
                void run('duplicate', commands.duplicate, (data) => {
                  onOpenVersion(data.versionId);
                  return {
                    tone: 'success',
                    messageDe: `Neue Entwurfsversion ${data.version} erstellt.`,
                  };
                })
              }
            >
              <CopyPlus aria-hidden="true" />
              Als neuen Entwurf bearbeiten
            </Button>

            {published ? null : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy === 'save'}
                  loadingLabel="Wird gespeichert …"
                  disabled={busy !== null || blocking || !dirty}
                  title={saveHint}
                  onClick={() =>
                    void run(
                      'save',
                      () => commands.save(spec),
                      (data) => {
                        onSaved();
                        return {
                          tone: 'success',
                          messageDe: `Entwurf ${data.version} gespeichert.`,
                        };
                      },
                    )
                  }
                >
                  <Save aria-hidden="true" />
                  Entwurf speichern
                </Button>

                <Button
                  type="button"
                  loading={busy === 'publish'}
                  loadingLabel="Wird veröffentlicht …"
                  disabled={busy !== null || blocking}
                  title={
                    blocking
                      ? 'Fehler verhindern das Veröffentlichen.'
                      : 'Die Version wird eingefroren.'
                  }
                  onClick={() => setPublishOpen(true)}
                >
                  <Upload aria-hidden="true" />
                  Veröffentlichen
                </Button>
              </>
            )}
          </div>
        }
      />

      {published ? (
        <Alert tone="info">
          <AlertTitle>Veröffentlichte Version — schreibgeschützt</AlertTitle>
          <AlertDescription>{PUBLISHED_IMMUTABLE_NOTE_DE}</AlertDescription>
        </Alert>
      ) : null}

      {feedback ? (
        <Alert tone={feedback.tone}>
          <AlertDescription>{feedback.messageDe}</AlertDescription>
        </Alert>
      ) : null}

      {/* Announces the running action only. The result is announced by the alert
          above, which is a live region itself — saying it twice would make a
          screen reader repeat every save. */}
      <p role="status" className="sr-only">
        {busy === 'save'
          ? 'Der Entwurf wird gespeichert.'
          : busy === 'publish'
            ? 'Die Version wird veröffentlicht.'
            : busy === 'duplicate'
              ? 'Es wird eine neue Entwurfsversion erstellt.'
              : busy === 'restore'
                ? 'Die gewählte Version wird als neuer Entwurf wiederhergestellt.'
                : ''}
      </p>

      {historyOpen ? (
        <section
          aria-label="Versionsverlauf"
          className="rounded-lg border border-border bg-surface p-3"
        >
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
            Wiederherstellen überschreibt nichts: Es entsteht eine neue Entwurfsversion mit dem
            Inhalt der gewählten Version.
          </p>
          <ul className="flex flex-col gap-2">
            {versions.length === 0 ? (
              <li className="text-sm text-muted-foreground">Kein Versionsverlauf verfügbar.</li>
            ) : null}
            {versions.map((entry) => (
              <li
                key={entry.versionId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <StatusBadge
                  kind="funnelVersion"
                  state={entry.published ? 'PUBLISHED' : 'DRAFT'}
                  size="sm"
                />
                <span className="text-sm font-medium">{entry.labelDe}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(entry.updatedAt)}
                </span>
                <span className="flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenVersion(entry.versionId)}
                >
                  Öffnen
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={busy === 'restore'}
                  loadingLabel="Wird wiederhergestellt …"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      'restore',
                      () => commands.restore(entry.versionId),
                      (data) => {
                        onOpenVersion(data.versionId);
                        return {
                          tone: 'success',
                          messageDe: `Version ${entry.version} als neuer Entwurf ${data.version} wiederhergestellt.`,
                        };
                      },
                    )
                  }
                >
                  Als Entwurf wiederherstellen
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        tone="primary"
        title="Version veröffentlichen"
        description="Nach dem Veröffentlichen ist diese Version unveränderlich. Weitere Änderungen entstehen als neue Entwurfsversion."
        confirmLabel="Version veröffentlichen"
        pending={busy === 'publish'}
        acknowledgement="Mir ist bewusst, dass diese Version danach nicht mehr geändert werden kann."
        preview={
          <div className="flex flex-col gap-2 text-sm">
            <p>{`Entwurfsversion ${version} wird eingefroren und ausgeliefert.`}</p>
            <p className="text-muted-foreground">{issueSummaryDe}</p>
          </div>
        }
        onConfirm={() =>
          void run(
            'publish',
            () => commands.publish(spec),
            () => {
              setPublishOpen(false);
              onSaved();
              return { tone: 'success', messageDe: 'Version veröffentlicht.' };
            },
          )
        }
      />
    </div>
  );
}
