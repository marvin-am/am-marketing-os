import { PageHeader } from '@am/ui';
import { SETTINGS_TABS, SettingsView, type SettingsTab } from '@/components/settings/settings-view';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { getOpsPort } from '@/server/ops-fixtures';
import {
  addConsentVersionAction,
  saveApprovalThresholdsAction,
  saveAttributionWindowAction,
  saveBrandTokensAction,
  saveExperimentThresholdsAction,
  saveMemberRolesAction,
  saveRecommendationConfigAction,
  saveRetentionPolicyAction,
  saveRoleBudgetLimitAction,
} from './actions';

export const metadata = {
  title: 'Einstellungen · A&M Marketing OS',
};

/**
 * Settings: users and roles, budget authority and approval thresholds, the
 * thresholds the statistics and rules engines read, the attribution window,
 * consent versions, the retention policy, brand tokens and the
 * environment-controlled feature flags.
 */
export default async function EinstellungenPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser('campaign.read');
  const snapshot = await getOpsPort().loadSettings();
  const requested = (await searchParams).tab;
  // Deep links from „Heute“ and the integrations pages point at one area.
  const defaultTab: SettingsTab = SETTINGS_TABS.includes(requested as SettingsTab)
    ? (requested as SettingsTab)
    : 'users';

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Einstellungen"
        description="Rollen, Limits, Entscheidungsschwellen, Einwilligung, Aufbewahrung und Marke. Sicherheitsschalter liegen bewusst in der Umgebung."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(snapshot.generatedAt)}
          </span>
        }
      />
      <SettingsView
        snapshot={snapshot}
        canManageSettings={can(user, 'settings.manage')}
        canManageUsers={can(user, 'user.manage')}
        defaultTab={defaultTab}
        actions={{
          saveMemberRoles: saveMemberRolesAction,
          saveRoleBudgetLimit: saveRoleBudgetLimitAction,
          saveApprovalThresholds: saveApprovalThresholdsAction,
          saveExperimentThresholds: saveExperimentThresholdsAction,
          saveRecommendationConfig: saveRecommendationConfigAction,
          saveAttributionWindow: saveAttributionWindowAction,
          addConsentVersion: addConsentVersionAction,
          saveRetentionPolicy: saveRetentionPolicyAction,
          saveBrandTokens: saveBrandTokensAction,
        }}
      />
    </div>
  );
}
