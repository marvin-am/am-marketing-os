'use client';

import * as React from 'react';
import { ROLES, ROLE_PERMISSIONS, type Role } from '@am/domain';
import {
  Badge,
  Button,
  CheckboxField,
  ConfirmDialog,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import { formatDateTime, formatNumber } from '@/lib/format';
import { ROLE_DESCRIPTIONS_DE, ROLE_LABELS_DE } from '@/lib/permissions';
import type { SettingsSnapshot, WorkspaceMemberView } from '@/server/ops-port';
import { ActionFeedback, useAction } from '@/components/integrations/action-feedback';
import { PermissionGate } from './permission-gate';

/**
 * Users and roles.
 *
 * A role is shown with what it actually means — `ROLE_DESCRIPTIONS_DE` plus the
 * number of permissions it carries — because "Marketing Lead" alone does not
 * tell an administrator whether that person may publish a campaign.
 */
export interface UsersPanelProps {
  snapshot: SettingsSnapshot;
  canManageUsers: boolean;
  onSaveRoles: (input: {
    memberId: string;
    roles: Role[];
  }) => Promise<ActionResult<SettingsSnapshot>>;
  onChanged: (snapshot: SettingsSnapshot) => void;
}

export function UsersPanel({ snapshot, canManageUsers, onSaveRoles, onChanged }: UsersPanelProps) {
  const [editing, setEditing] = React.useState<WorkspaceMemberView | null>(null);
  const [selected, setSelected] = React.useState<Role[]>([]);
  const save = useAction(onSaveRoles);

  const startEdit = (member: WorkspaceMemberView) => {
    setEditing(member);
    setSelected(member.roles);
  };

  return (
    <div className="flex flex-col gap-8">
      <Section
        id="users"
        heading="Nutzerinnen und Nutzer"
        description="Berechtigungen werden nie direkt vergeben, sondern über Rollen. Eine Person kann mehrere Rollen haben; die Rechte sind deren Vereinigung."
      >
        <div className="flex flex-col gap-4">
          <ActionFeedback
            result={save.result}
            successTitleDe="Rollen gespeichert."
            successDescriptionDe="Die Änderung wirkt ab der nächsten Anfrage dieser Person."
          />

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Rollen</TableHead>
                  <TableHead>Zuletzt aktiv</TableHead>
                  <TableHead>Aktion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.members.map((member) => (
                  <TableRow key={member.id} data-member={member.id}>
                    <TableCell>
                      <span className="block font-medium">{member.displayName}</span>
                      <span className="block text-xs text-muted-foreground">{member.email}</span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {member.roles.map((role) => (
                          <Badge key={role} tone="outline" size="sm">
                            {ROLE_LABELS_DE[role]}
                          </Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {member.lastActiveAt ? formatDateTime(member.lastActiveAt) : 'noch nie'}
                    </TableCell>
                    <TableCell>
                      <PermissionGate
                        permission="user.manage"
                        allowed={canManageUsers}
                        actionLabelDe="Rollen ändern"
                      >
                        <Button variant="secondary" size="sm" onClick={() => startEdit(member)}>
                          Rollen ändern
                        </Button>
                      </PermissionGate>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </Section>

      <Section
        heading="Rollen und ihre Bedeutung"
        description="Was eine Rolle darf, steht in der Rollenmatrix des Domänenpakets — nicht in einzelnen Bildschirmen."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rolle</TableHead>
                <TableHead>Beschreibung</TableHead>
                <TableHead className="text-right">Berechtigungen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROLES.map((role) => (
                <TableRow key={role} data-role={role}>
                  <TableCell className="font-medium">{ROLE_LABELS_DE[role]}</TableCell>
                  <TableCell className="text-sm leading-relaxed text-muted-foreground">
                    {ROLE_DESCRIPTIONS_DE[role]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(ROLE_PERMISSIONS[role].length)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <ConfirmDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing ? `Rollen von ${editing.displayName} ändern` : 'Rollen ändern'}
        description="Die Änderung wirkt sofort auf alle Berechtigungsprüfungen dieser Person."
        preview={
          <div className="flex flex-col gap-2">
            {ROLES.map((role) => (
              <CheckboxField
                key={role}
                label={ROLE_LABELS_DE[role]}
                description={ROLE_DESCRIPTIONS_DE[role]}
                checked={selected.includes(role)}
                onCheckedChange={(next) =>
                  setSelected((current) =>
                    next === true ? [...current, role] : current.filter((entry) => entry !== role),
                  )
                }
              />
            ))}
            {selected.length === 0 ? (
              <p className="text-xs text-destructive">
                Mindestens eine Rolle ist erforderlich; ohne Rolle hat die Person keinen Zugang.
              </p>
            ) : null}
          </div>
        }
        confirmLabel="Rollen speichern"
        tone="primary"
        pending={save.pending}
        onConfirm={async () => {
          if (!editing || selected.length === 0) return;
          const result = await save.run({ memberId: editing.id, roles: selected });
          if (result.status === 'ok') onChanged(result.data);
          setEditing(null);
        }}
      />
    </div>
  );
}
