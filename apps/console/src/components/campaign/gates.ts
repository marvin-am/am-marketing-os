import { DEFAULT_ROLE_BUDGET_LIMITS, type Role } from '@am/domain';
import { ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';
import type { CreativeBoardView } from '@/server/campaign-port';

/**
 * The two refusals that must read identically wherever they appear — in the
 * server action that enforces them and in the button that explains itself
 * before the operator presses it. Pure, so both can use them, and so both can
 * never drift apart.
 */

/**
 * The asset gate: fewer than five *conceptually distinct* approved creatives
 * blocks asset approval, and the refusal names the offending pairs.
 */
export function assetGateBlockedReasonDe(board: CreativeBoardView): string | null {
  if (board.approvedCount < board.minApproved) {
    return `Es sind erst ${board.approvedCount} von mindestens ${board.minApproved} erforderlichen Creatives freigegeben.`;
  }
  if (board.diversity.blocked) {
    const pairs = board.diversity.collisions
      .map((collision) => `„${collision.aName}" und „${collision.bName}"`)
      .join('; ');
    return `Nur ${board.diversity.distinctCount} von ${board.diversity.requiredDistinct} erforderlichen Creatives sind konzeptionell unterschiedlich. Zu ähnlich sind: ${pairs}. Ersetzen Sie eines der Konzepte je Paar.`;
  }
  return null;
}

/**
 * Budget authority. A change beyond the role's limit is **refused and routed**
 * to a role that may approve it — never silently reduced to what the role may
 * do (spec §7, §21, acceptance criterion 24).
 */
export function budgetRefusalDe(
  roles: readonly Role[],
  currentMinor: number,
  nextMinor: number,
): string | null {
  if (nextMinor <= 0) return 'Das Tagesbudget muss größer als 0,00 € sein.';
  const increasePct = (nextMinor - currentMinor) / Math.max(1, currentMinor);
  if (increasePct <= 0) return null;

  const permitted = roles
    .map((role) => DEFAULT_ROLE_BUDGET_LIMITS[role])
    .some(
      (limit) =>
        increasePct <= limit.maxSingleIncreasePct && nextMinor <= limit.maxDailyBudgetMinor,
    );
  if (permitted) return null;

  const approver = rolesWithPermission('campaign.scale_budget_major').find((role) => {
    const limit = DEFAULT_ROLE_BUDGET_LIMITS[role];
    return increasePct <= limit.maxSingleIncreasePct && nextMinor <= limit.maxDailyBudgetMinor;
  });

  const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(
    increasePct * 100,
  );
  return approver
    ? `Eine Erhöhung um ${pct} % überschreitet Ihr Rollenlimit. Die Änderung wird nicht gekürzt, sondern abgelehnt und muss durch die Rolle „${ROLE_LABELS_DE[approver]}" freigegeben werden.`
    : `Eine Erhöhung um ${pct} % überschreitet jedes hinterlegte Rollenlimit. Passen Sie die Limits unter Einstellungen an, bevor Sie es erneut versuchen.`;
}
