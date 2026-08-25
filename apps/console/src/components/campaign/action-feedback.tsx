'use client';

import * as React from 'react';
import { Alert, AlertDescription, AlertTitle, DryRunNotice } from '@am/ui';
import type { ActionResult } from '@/lib/action-result';

/**
 * The one way this screen reports the outcome of a server action.
 *
 * Three outcomes, never two: success, **dry run** and failure. A dry run is
 * rendered as a `DryRunNotice` and never as a success — that distinction is the
 * whole point of `ActionResult` (AGENTS.md rules 2 and 3).
 */
export type ActionPhase<T> =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'settled'; result: ActionResult<T> };

export interface ActionFeedbackProps<T> {
  phase: ActionPhase<T>;
  /** German sentence shown on success, e.g. „Strategie freigegeben." */
  successDe: string;
  /** German sentence shown while the action runs. */
  pendingDe?: string;
}

export function ActionFeedback<T>({
  phase,
  successDe,
  pendingDe = 'Aktion wird ausgeführt …',
}: ActionFeedbackProps<T>) {
  if (phase.kind === 'idle') return null;

  if (phase.kind === 'pending') {
    return (
      <Alert tone="info" role="status" aria-live="polite">
        <AlertTitle>{pendingDe}</AlertTitle>
        <AlertDescription>
          Bitte warten. Die Aktion wird erst nach der Antwort des Servers als abgeschlossen
          angezeigt.
        </AlertDescription>
      </Alert>
    );
  }

  const { result } = phase;

  if (result.status === 'dry_run') {
    return <DryRunNotice result={result.dryRun} defaultOpen />;
  }

  if (result.status === 'error') {
    return (
      <Alert tone="destructive">
        <AlertTitle>Aktion nicht ausgeführt</AlertTitle>
        <AlertDescription>
          {result.messageDe}
          {result.retryable ? (
            <span className="mt-1 block text-xs opacity-80">
              Dieser Fehler ist vorübergehend — ein erneuter Versuch kann erfolgreich sein.
            </span>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert tone="success">
      <AlertTitle>{successDe}</AlertTitle>
      <AlertDescription>Die Änderung ist gespeichert und im Audit-Log vermerkt.</AlertDescription>
    </Alert>
  );
}

/** Small state machine so every action on this screen behaves identically. */
export function useAction<TInput, TOutput>(
  run: (input: TInput) => Promise<ActionResult<TOutput>>,
): {
  phase: ActionPhase<TOutput>;
  pending: boolean;
  execute: (input: TInput) => Promise<ActionResult<TOutput>>;
  reset: () => void;
} {
  const [phase, setPhase] = React.useState<ActionPhase<TOutput>>({ kind: 'idle' });

  const execute = React.useCallback(
    async (input: TInput) => {
      setPhase({ kind: 'pending' });
      try {
        const result = await run(input);
        setPhase({ kind: 'settled', result });
        return result;
      } catch {
        const result: ActionResult<TOutput> = {
          status: 'error',
          code: 'INTERNAL',
          messageDe:
            'Die Aktion konnte nicht an den Server übermittelt werden. Bitte prüfen Sie die Verbindung und versuchen Sie es erneut.',
          retryable: true,
        };
        setPhase({ kind: 'settled', result });
        return result;
      }
    },
    [run],
  );

  return {
    phase,
    pending: phase.kind === 'pending',
    execute,
    reset: React.useCallback(() => setPhase({ kind: 'idle' }), []),
  };
}
