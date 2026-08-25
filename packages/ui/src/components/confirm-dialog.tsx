'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { Button } from './button';
import { CheckboxField } from './checkbox';
import { Input } from './input';
import { Label } from './label';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** German headline naming the exact action, e.g. "Kampagne live schalten". */
  title: string;
  /** German sentence describing the consequence. */
  description?: React.ReactNode;
  /**
   * A rendered preview of exactly what will happen: the request payload, a
   * `DiffList`, a `DryRunNotice`. Required — no external action is confirmed
   * blind (AGENTS.md rules 2–3).
   */
  preview: React.ReactNode;
  /**
   * Phrase the operator has to type. Omit only for reversible, local actions.
   * Defaults to nothing, so the caller decides deliberately.
   */
  confirmPhrase?: string;
  /** Optional acknowledgement the operator must tick before confirming. */
  acknowledgement?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'destructive' | 'primary';
  /** Shows the spinner and blocks a second submit while the action runs. */
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * The gate in front of every destructive or external action.
 *
 * Nothing is executed until the operator has seen the preview, typed the
 * confirmation phrase (when one is required) and pressed the confirm button.
 * Closing, cancelling or pressing Escape never fires `onConfirm`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  preview,
  confirmPhrase,
  acknowledgement,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
  tone = 'destructive',
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState('');
  const [acknowledged, setAcknowledged] = React.useState(false);
  const inputId = React.useId();
  const helpId = `${inputId}-help`;

  // Every opening starts from a clean slate: a previously typed phrase must
  // never carry over into the next confirmation.
  React.useEffect(() => {
    if (!open) {
      setTyped('');
      setAcknowledged(false);
    }
  }, [open]);

  const phraseSatisfied =
    confirmPhrase === undefined || typed.trim() === confirmPhrase.trim();
  const acknowledgementSatisfied = acknowledgement === undefined || acknowledged;
  const canConfirm = phraseSatisfied && acknowledgementSatisfied && !pending;

  const handleConfirm = () => {
    if (!canConfirm) return;
    void onConfirm();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description ??
              'Prüfen Sie die Vorschau. Die Aktion wird erst nach Ihrer Bestätigung ausgeführt.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogBody>
          <div className="flex flex-col gap-4">
            <section aria-label="Vorschau der Aktion" className="rounded-lg border border-border bg-surface-raised p-3">
              {preview}
            </section>

            {confirmPhrase !== undefined ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={inputId} required>
                  Zur Bestätigung <span className="font-mono">{confirmPhrase}</span> eingeben
                </Label>
                <Input
                  id={inputId}
                  value={typed}
                  autoComplete="off"
                  aria-describedby={helpId}
                  aria-invalid={typed.length > 0 && !phraseSatisfied}
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canConfirm) {
                      event.preventDefault();
                      handleConfirm();
                    }
                  }}
                />
                <p id={helpId} className="text-xs text-muted-foreground">
                  {phraseSatisfied
                    ? 'Bestätigung vollständig. Die Aktion kann jetzt ausgeführt werden.'
                    : 'Der eingegebene Text muss exakt übereinstimmen.'}
                </p>
              </div>
            ) : null}

            {acknowledgement !== undefined ? (
              <CheckboxField
                label={acknowledgement}
                checked={acknowledged}
                onCheckedChange={(next) => setAcknowledged(next === true)}
                className={cn('rounded-md border border-border px-3')}
              />
            ) : null}
          </div>
        </AlertDialogBody>

        <AlertDialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'primary'}
            onClick={handleConfirm}
            disabled={!canConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
