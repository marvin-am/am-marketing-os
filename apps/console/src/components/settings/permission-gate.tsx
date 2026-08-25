'use client';

import * as React from 'react';
import type { Permission } from '@am/domain';
import { Lock } from 'lucide-react';
import { ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';

/**
 * Hides a mutating control from anyone whose roles do not carry the permission,
 * and says who could do it instead.
 *
 * A greyed-out button is not a refusal an operator can act on — naming the role
 * that may perform the action turns „keine Berechtigung“ into „bitte durch
 * Marketing Lead freigeben lassen“. The server action re-checks the same
 * permission through `defineAction`; this component is the affordance, never
 * the guard.
 *
 * It lives with the settings components because roles are configured there, but
 * every configuration surface in the console uses it.
 */
export interface PermissionGateProps {
  permission: Permission;
  /** Computed on the server with `can(user, permission)`. */
  allowed: boolean;
  /** The German name of the action, e.g. „Mapping veröffentlichen“. */
  actionLabelDe: string;
  children: React.ReactNode;
}

export function PermissionGate({
  permission,
  allowed,
  actionLabelDe,
  children,
}: PermissionGateProps) {
  if (allowed) return <>{children}</>;

  const roles = rolesWithPermission(permission).map((role) => ROLE_LABELS_DE[role]);

  return (
    <p
      data-permission-denied={permission}
      className="flex items-start gap-2 rounded-md border border-dashed border-border bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-muted-foreground"
    >
      <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-semibold text-foreground">{actionLabelDe}</span> ist Ihrer Rolle nicht
        erlaubt.{' '}
        {roles.length > 0
          ? `Diese Aktion kann von folgenden Rollen ausgeführt werden: ${roles.join(', ')}.`
          : 'Für diese Aktion ist keine Rolle vorgesehen.'}
      </span>
    </p>
  );
}
