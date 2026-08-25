'use client';

import * as React from 'react';
import { ROLES, type Role, type RoleBudgetLimit } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  CheckboxField,
  FormFieldRow,
  Input,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import { formatCurrencyMinor, formatNumber, formatPercent } from '@/lib/format';
import { ROLE_LABELS_DE } from '@/lib/permissions';
import type { ApprovalThresholds, SettingsSnapshot } from '@/server/ops-port';
import { ActionFeedback, useAction } from '@/components/integrations/action-feedback';
import { PermissionGate } from './permission-gate';

/**
 * Budget authority per role, and the thresholds above which an approval becomes
 * mandatory.
 *
 * A request that exceeds a role's limit is never silently clamped — it is
 * refused and routed to a role that may approve it. The panel therefore shows
 * both halves of that decision on one screen.
 */
export interface LimitsPanelProps {
  snapshot: SettingsSnapshot;
  canManage: boolean;
  onSaveRoleLimit: (input: { limit: RoleBudgetLimit }) => Promise<ActionResult<SettingsSnapshot>>;
  onSaveApprovalThresholds: (input: {
    thresholds: ApprovalThresholds;
  }) => Promise<ActionResult<SettingsSnapshot>>;
  onChanged: (snapshot: SettingsSnapshot) => void;
}

export function LimitsPanel({
  snapshot,
  canManage,
  onSaveRoleLimit,
  onSaveApprovalThresholds,
  onChanged,
}: LimitsPanelProps) {
  return (
    <div className="flex flex-col gap-8">
      <RoleLimits
        snapshot={snapshot}
        canManage={canManage}
        onSaveRoleLimit={onSaveRoleLimit}
        onChanged={onChanged}
      />
      <ApprovalThresholdsSection
        snapshot={snapshot}
        canManage={canManage}
        onSaveApprovalThresholds={onSaveApprovalThresholds}
        onChanged={onChanged}
      />
    </div>
  );
}

function RoleLimits({
  snapshot,
  canManage,
  onSaveRoleLimit,
  onChanged,
}: Omit<LimitsPanelProps, 'onSaveApprovalThresholds'>) {
  const [editing, setEditing] = React.useState<Role | null>(null);
  const [draft, setDraft] = React.useState<RoleBudgetLimit | null>(null);
  const save = useAction(onSaveRoleLimit);

  const start = (role: Role) => {
    setEditing(role);
    setDraft({ ...snapshot.roleBudgetLimits[role] });
  };

  return (
    <Section
      id="budget-limits"
      heading="Budgetbefugnisse je Rolle"
      description="Eine Anfrage über dem Limit wird nicht gekürzt, sondern abgelehnt und an eine Rolle weitergeleitet, die sie freigeben darf."
    >
      <div className="flex flex-col gap-4">
        <ActionFeedback
          result={save.result}
          successTitleDe="Budgetlimit gespeichert."
          successDescriptionDe="Die Grenze gilt ab der nächsten Skalierungsanfrage."
        />

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rolle</TableHead>
                <TableHead className="text-right">Max. Erhöhung je Aktion</TableHead>
                <TableHead className="text-right">Max. Tagesbudget</TableHead>
                <TableHead className="text-right">Skalierungen / 24 h</TableHead>
                <TableHead>Darf pausieren</TableHead>
                <TableHead>Aktion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROLES.map((role) => {
                const limit = snapshot.roleBudgetLimits[role];
                return (
                  <TableRow key={role} data-role-limit={role}>
                    <TableCell className="font-medium">{ROLE_LABELS_DE[role]}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {limit.maxSingleIncreasePct === 0
                        ? 'keine'
                        : formatPercent(limit.maxSingleIncreasePct, 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {limit.maxDailyBudgetMinor === 0
                        ? 'keins'
                        : formatCurrencyMinor(
                            limit.maxDailyBudgetMinor,
                            snapshot.approvalThresholds.currency,
                            0,
                          )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(limit.maxScalesPer24h)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={limit.mayPause ? 'success' : 'neutral'} size="sm">
                        {limit.mayPause ? 'ja' : 'nein'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <PermissionGate
                        permission="settings.manage"
                        allowed={canManage}
                        actionLabelDe="Budgetlimit ändern"
                      >
                        <Button variant="secondary" size="sm" onClick={() => start(role)}>
                          Ändern
                        </Button>
                      </PermissionGate>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {editing && draft ? (
          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium text-foreground">
              Limit für {ROLE_LABELS_DE[editing]}
            </legend>
            <div className="grid gap-3 md:grid-cols-2">
              <FormFieldRow
                label="Max. Erhöhung je Aktion (%)"
                help="0 bedeutet: Diese Rolle darf Budgets nicht erhöhen."
              >
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={String(Math.round(draft.maxSingleIncreasePct * 100))}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        maxSingleIncreasePct: (Number(event.target.value) || 0) / 100,
                      })
                    }
                  />
                )}
              </FormFieldRow>
              <FormFieldRow label="Max. Tagesbudget (in Euro)">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={String(Math.round(draft.maxDailyBudgetMinor / 100))}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        maxDailyBudgetMinor: Math.round((Number(event.target.value) || 0) * 100),
                      })
                    }
                  />
                )}
              </FormFieldRow>
              <FormFieldRow label="Skalierungen je 24 Stunden">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={String(draft.maxScalesPer24h)}
                    onChange={(event) =>
                      setDraft({ ...draft, maxScalesPer24h: Number(event.target.value) || 0 })
                    }
                  />
                )}
              </FormFieldRow>
              <CheckboxField
                label="Darf ohne zusätzliche Freigabe pausieren und Budget senken"
                checked={draft.mayPause}
                onCheckedChange={(next) => setDraft({ ...draft, mayPause: next === true })}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                loading={save.pending}
                onClick={async () => {
                  const result = await save.run({ limit: draft });
                  if (result.status === 'ok') onChanged(result.data);
                  setEditing(null);
                }}
              >
                Limit speichern
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Abbrechen
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
    </Section>
  );
}

function ApprovalThresholdsSection({
  snapshot,
  canManage,
  onSaveApprovalThresholds,
  onChanged,
}: Omit<LimitsPanelProps, 'onSaveRoleLimit'>) {
  const [draft, setDraft] = React.useState<ApprovalThresholds>(snapshot.approvalThresholds);
  const save = useAction(onSaveApprovalThresholds);

  React.useEffect(() => {
    setDraft(snapshot.approvalThresholds);
  }, [snapshot.approvalThresholds]);

  return (
    <Section
      id="approval-thresholds"
      heading="Freigabeschwellen"
      description="Ab welcher Größenordnung eine Änderung eine ausdrückliche Freigabe braucht."
    >
      <div className="flex flex-col gap-4">
        <Alert tone="info">
          <AlertTitle>Freigaben hängen am Inhalt, nicht nur am Betrag.</AlertTitle>
          <AlertDescription>
            Eine Freigabe verweist immer auf den Inhalts-Hash des freigegebenen Stands. Ändert sich
            der Inhalt danach, verfällt die Freigabe automatisch.
          </AlertDescription>
        </Alert>

        <div className="grid gap-3 md:grid-cols-3">
          <FormFieldRow
            label="Freigabe ab Erhöhung (%)"
            help="Darüber ist eine BUDGET_SCALE-Freigabe nötig."
          >
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={0}
                disabled={!canManage}
                value={String(Math.round(draft.budgetScaleApprovalPct * 100))}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    budgetScaleApprovalPct: (Number(event.target.value) || 0) / 100,
                  })
                }
              />
            )}
          </FormFieldRow>
          <FormFieldRow
            label="Größere Änderung ab (%)"
            help="Darüber gilt die Änderung als MAJOR_CHANGE."
          >
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={0}
                disabled={!canManage}
                value={String(Math.round(draft.majorChangeApprovalPct * 100))}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    majorChangeApprovalPct: (Number(event.target.value) || 0) / 100,
                  })
                }
              />
            )}
          </FormFieldRow>
          <FormFieldRow
            label="Freigabe ab Tagesbudget (Euro)"
            help="Ab diesem Tagesbudget braucht jede Änderung eine Freigabe."
          >
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={0}
                disabled={!canManage}
                value={String(Math.round(draft.dailyBudgetApprovalMinor / 100))}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    dailyBudgetApprovalMinor: Math.round((Number(event.target.value) || 0) * 100),
                  })
                }
              />
            )}
          </FormFieldRow>
        </div>

        <ActionFeedback
          result={save.result}
          successTitleDe="Freigabeschwellen gespeichert."
          successDescriptionDe="Sie gelten ab der nächsten Anfrage."
        />

        <PermissionGate
          permission="settings.manage"
          allowed={canManage}
          actionLabelDe="Freigabeschwellen ändern"
        >
          <Button
            className="self-start"
            loading={save.pending}
            onClick={async () => {
              const result = await save.run({ thresholds: draft });
              if (result.status === 'ok') onChanged(result.data);
            }}
          >
            Schwellen speichern
          </Button>
        </PermissionGate>
      </div>
    </Section>
  );
}
