import { DomainError, hasPermission, type Permission, type Role } from '@am/domain';

/**
 * The console's authorisation surface.
 *
 * Everything checks a `Permission`, never a role directly — the role matrix in
 * `@am/domain` stays the single place a capability moves.
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  workspaceId: string;
}

export function can(user: SessionUser | null, permission: Permission): boolean {
  if (!user) return false;
  return hasPermission(user.roles, permission);
}

/** Throws a `DomainError` that the action wrapper renders in German. */
export function requirePermission(user: SessionUser | null, permission: Permission): SessionUser {
  if (!user) {
    throw new DomainError('UNAUTHENTICATED');
  }
  if (!hasPermission(user.roles, permission)) {
    throw new DomainError('FORBIDDEN', {
      details: { permission, roles: user.roles },
      messageDe: `Ihre Rolle erlaubt diese Aktion nicht (benötigt: ${permission}).`,
    });
  }
  return user;
}

/**
 * Names a role that *could* perform an action the current user may not. Used to
 * turn a refusal into something actionable — "bitte durch Executive freigeben
 * lassen" beats a bare "keine Berechtigung".
 */
export function rolesWithPermission(permission: Permission): Role[] {
  const all: Role[] = [
    'MARKETING_OPERATOR',
    'CREATIVE_REVIEWER',
    'MARKETING_LEAD',
    'REVOPS',
    'EXECUTIVE',
    'ADMIN',
  ];
  return all.filter((role) => hasPermission([role], permission));
}

export const ROLE_LABELS_DE: Readonly<Record<Role, string>> = {
  VIEWER: 'Betrachter',
  MARKETING_OPERATOR: 'Marketing Operator',
  CREATIVE_REVIEWER: 'Creative Reviewer',
  MARKETING_LEAD: 'Marketing Lead',
  REVOPS: 'RevOps',
  EXECUTIVE: 'Executive',
  ADMIN: 'Administrator',
};

export const ROLE_DESCRIPTIONS_DE: Readonly<Record<Role, string>> = {
  VIEWER: 'Liest Kampagnen, Ergebnisse und Audit-Einträge.',
  MARKETING_OPERATOR: 'Bearbeitet Vorschläge, Entwürfe, Creatives und Funnel.',
  CREATIVE_REVIEWER: 'Gibt Inhalte und Claims frei.',
  MARKETING_LEAD:
    'Veröffentlicht und pausiert Kampagnen und skaliert Budgets innerhalb des Rollenlimits.',
  REVOPS: 'Verwaltet HubSpot-Mappings sowie Revenue- und VQ-Definitionen.',
  EXECUTIVE: 'Gibt größere Budgetänderungen frei.',
  ADMIN: 'Verwaltet Integrationen, Nutzer, Rollen und globale Limits.',
};
