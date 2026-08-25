'use client';

import * as React from 'react';
import { Alert, AlertDescription, AlertTitle, DryRunNotice } from '@am/ui';
import type { ActionResult } from '@/lib/action-result';

/**
 * The single way a server action's outcome is rendered.
 *
 * Three outcomes, three visuals, and the middle one is the point: a
 * `DryRunResult` is rendered as `DryRunNotice` — "nicht ausgeführt" — and never
 * as a success. Collapsing it into a green toast is exactly how an operator
 * ends up believing an external write happened when it did not (AGENTS.md
 * rule 2).
 */
export interface ActionFeedbackProps {
  result: ActionResult<unknown> | null;
  /** German headline for the success case. */
  successTitleDe: string;
  /** German sentence for the success case. */
  successDescriptionDe?: React.ReactNode;
  onRetry?: () => void;
}

export function ActionFeedback({
  result,
  successTitleDe,
  successDescriptionDe,
  onRetry,
}: ActionFeedbackProps) {
  if (!result) return null;

  if (result.status === 'dry_run') {
    return <DryRunNotice result={result.dryRun} />;
  }

  if (result.status === 'error') {
    return (
      <Alert tone="destructive" data-action-error={result.code}>
        <AlertTitle>Die Aktion wurde nicht ausgeführt.</AlertTitle>
        <AlertDescription>
          {result.messageDe}
          {result.fieldErrors ? (
            <ul className="mt-2 list-inside list-disc">
              {Object.entries(result.fieldErrors).map(([field, message]) => (
                <li key={field}>
                  <span className="font-mono text-xs">{field}</span>: {message}
                </li>
              ))}
            </ul>
          ) : null}
          {result.retryable && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 text-sm font-medium underline underline-offset-4"
            >
              Erneut versuchen
            </button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert tone="success" data-action-ok="true">
      <AlertTitle>{successTitleDe}</AlertTitle>
      {successDescriptionDe ? <AlertDescription>{successDescriptionDe}</AlertDescription> : null}
    </Alert>
  );
}

/**
 * Runs a server action and keeps its pending state and last result.
 *
 * Deliberately does not clear the result on the next run until the call
 * resolves, so a dry-run notice does not flash away and reappear.
 */
export function useAction<TInput, TOutput>(
  action: (input: TInput) => Promise<ActionResult<TOutput>>,
): {
  run: (input: TInput) => Promise<ActionResult<TOutput>>;
  pending: boolean;
  result: ActionResult<TOutput> | null;
  reset: () => void;
} {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ActionResult<TOutput> | null>(null);

  const run = React.useCallback(
    async (input: TInput) => {
      setPending(true);
      try {
        const next = await action(input);
        setResult(next);
        return next;
      } finally {
        setPending(false);
      }
    },
    [action],
  );

  return { run, pending, result, reset: () => setResult(null) };
}
