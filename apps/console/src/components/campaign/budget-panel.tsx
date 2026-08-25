'use client';

import * as React from 'react';
import type { Role } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  DiffList,
  formatMoneyMinorDe,
  Input,
  Label,
  Textarea,
} from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import type { CampaignHeaderView } from '@/server/campaign-port';
import { ActionFeedback, useAction } from './action-feedback';
import { budgetRefusalDe } from './gates';

export interface BudgetChangeRunner {
  (input: {
    campaignId: string;
    newDailyBudgetMinor: number;
    reasonDe: string;
  }): Promise<ActionResult<CampaignHeaderView>>;
}

/**
 * Change the daily budget, inside the role's authority.
 *
 * The refusal is shown *before* the operator commits, and it names the role
 * that may approve the change. Nothing is ever clamped down to what the current
 * role happens to be allowed to do — that would silently do something other
 * than what was asked (spec §21, acceptance criterion 24).
 */
export function BudgetPanel({
  campaignId,
  currentMinor,
  currency,
  roles,
  canChange,
  change,
}: {
  campaignId: string;
  currentMinor: number;
  currency: string;
  roles: Role[];
  canChange: boolean;
  change: BudgetChangeRunner;
}) {
  const [amount, setAmount] = React.useState((currentMinor / 100).toFixed(2));
  const [reason, setReason] = React.useState('');
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const action = useAction(change);

  const parsed = Number.parseFloat(amount.replace(',', '.'));
  const nextMinor = Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN;
  const valid = Number.isFinite(nextMinor) && nextMinor > 0;
  const refusal = valid ? budgetRefusalDe(roles, currentMinor, nextMinor) : null;
  const changed = valid && nextMinor !== currentMinor;

  if (!canChange) {
    return (
      <p className="text-sm text-muted-foreground">
        Ihre Rolle darf das Budget nicht ändern. Zuständig sind Marketing Lead (bis +20 %) und
        Executive (darüber hinaus).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="budget-neu" required>
            Neues Tagesbudget in {currency}
          </Label>
          <Input
            id="budget-neu"
            inputMode="decimal"
            value={amount}
            aria-invalid={!valid}
            aria-describedby="budget-hinweis"
            onChange={(event) => setAmount(event.target.value)}
          />
          <p id="budget-hinweis" className="text-xs text-muted-foreground">
            Aktuell {formatMoneyMinorDe(currentMinor, currency)} pro Tag.
            {valid && changed
              ? ` Neu ${formatMoneyMinorDe(nextMinor, currency)} pro Tag.`
              : ''}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="budget-grund" required>
            Begründung
          </Label>
          <Textarea
            id="budget-grund"
            value={reason}
            minLength={5}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Warum wird das Budget geändert?"
          />
        </div>
      </div>

      {!valid ? (
        <Alert tone="warning">
          <AlertTitle>Kein gültiger Betrag</AlertTitle>
          <AlertDescription>
            Bitte geben Sie einen Betrag größer als 0,00 {currency} ein.
          </AlertDescription>
        </Alert>
      ) : null}

      {refusal ? (
        <Alert tone="destructive" data-budget-refusal="">
          <AlertTitle>Budgetänderung wird abgelehnt</AlertTitle>
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Button
          size="sm"
          disabled={!valid || !changed || refusal !== null || reason.trim().length < 5 || action.pending}
          onClick={() => setDialogOpen(true)}
        >
          Budget ändern
        </Button>
      </div>

      <ActionFeedback
        phase={action.phase}
        successDe="Tagesbudget geändert."
        pendingDe="Budgetänderung wird gespeichert …"
      />

      <ConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Tagesbudget ändern"
        description="Prüfen Sie die Änderung. Sie wird erst nach Ihrer Bestätigung gespeichert."
        tone="primary"
        confirmLabel="Änderung speichern"
        pending={action.pending}
        preview={
          <DiffList
            entries={[
              {
                path: 'dailyBudgetMinor',
                labelDe: 'Tagesbudget',
                before: formatMoneyMinorDe(currentMinor, currency),
                after: valid ? formatMoneyMinorDe(nextMinor, currency) : '–',
                change: 'changed',
              },
              {
                path: 'reasonDe',
                labelDe: 'Begründung',
                before: undefined,
                after: reason,
                change: 'added',
              },
            ]}
          />
        }
        onConfirm={async () => {
          await action.execute({
            campaignId,
            newDailyBudgetMinor: nextMinor,
            reasonDe: reason,
          });
          setDialogOpen(false);
        }}
      />
    </div>
  );
}
