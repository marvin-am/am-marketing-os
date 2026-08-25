'use client';

import * as React from 'react';
import type { ExperimentThresholds, RecommendationConfig, RetentionPolicy, Role, RoleBudgetLimit } from '@am/domain';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import type {
  ApprovalThresholds,
  BrandTokens,
  SaveConsentVersionInput,
  SettingsSnapshot,
} from '@/server/ops-port';
import { BrandPanel } from './brand-panel';
import { CompliancePanel } from './compliance-panel';
import { DecisionPanel } from './decision-panel';
import { FeatureFlagsPanel } from './feature-flags-panel';
import { LimitsPanel } from './limits-panel';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, type SettingsTab } from './tabs';
import { UsersPanel } from './users-panel';

/**
 * The settings surface.
 *
 * Every panel receives the same snapshot and hands back the snapshot the server
 * returned, so a change in one area is immediately visible in another — role
 * limits and approval thresholds in particular are read together.
 *
 * The tab identifiers and their labels come from `./tabs`, which the server
 * component also reads to validate the `?tab=` deep link.
 */

export interface SettingsViewProps {
  snapshot: SettingsSnapshot;
  canManageSettings: boolean;
  canManageUsers: boolean;
  defaultTab?: SettingsTab;
  actions: {
    saveMemberRoles: (input: {
      memberId: string;
      roles: Role[];
    }) => Promise<ActionResult<SettingsSnapshot>>;
    saveRoleBudgetLimit: (input: {
      limit: RoleBudgetLimit;
    }) => Promise<ActionResult<SettingsSnapshot>>;
    saveApprovalThresholds: (input: {
      thresholds: ApprovalThresholds;
    }) => Promise<ActionResult<SettingsSnapshot>>;
    saveExperimentThresholds: (input: {
      thresholds: ExperimentThresholds;
    }) => Promise<ActionResult<SettingsSnapshot>>;
    saveRecommendationConfig: (input: {
      config: RecommendationConfig;
    }) => Promise<ActionResult<SettingsSnapshot>>;
    saveAttributionWindow: (input: {
      windowDays: number;
    }) => Promise<ActionResult<SettingsSnapshot>>;
    addConsentVersion: (
      input: SaveConsentVersionInput,
    ) => Promise<ActionResult<SettingsSnapshot>>;
    saveRetentionPolicy: (input: {
      policy: Omit<RetentionPolicy, 'configuredBy' | 'configuredAt'>;
    }) => Promise<ActionResult<SettingsSnapshot>>;
    saveBrandTokens: (input: { brand: BrandTokens }) => Promise<ActionResult<SettingsSnapshot>>;
  };
}

export function SettingsView({
  snapshot: initial,
  canManageSettings,
  canManageUsers,
  defaultTab = DEFAULT_SETTINGS_TAB,
  actions,
}: SettingsViewProps) {
  const [snapshot, setSnapshot] = React.useState(initial);

  React.useEffect(() => {
    setSnapshot(initial);
  }, [initial]);

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList className="flex-wrap">
        {SETTINGS_TABS.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.labelDe}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="users">
        <UsersPanel
          snapshot={snapshot}
          canManageUsers={canManageUsers}
          onSaveRoles={actions.saveMemberRoles}
          onChanged={setSnapshot}
        />
      </TabsContent>

      <TabsContent value="limits">
        <LimitsPanel
          snapshot={snapshot}
          canManage={canManageSettings}
          onSaveRoleLimit={actions.saveRoleBudgetLimit}
          onSaveApprovalThresholds={actions.saveApprovalThresholds}
          onChanged={setSnapshot}
        />
      </TabsContent>

      <TabsContent value="decisions">
        <DecisionPanel
          snapshot={snapshot}
          canManage={canManageSettings}
          onSaveExperimentThresholds={actions.saveExperimentThresholds}
          onSaveRecommendationConfig={actions.saveRecommendationConfig}
          onSaveAttributionWindow={actions.saveAttributionWindow}
          onChanged={setSnapshot}
        />
      </TabsContent>

      <TabsContent value="compliance">
        <CompliancePanel
          snapshot={snapshot}
          canManage={canManageSettings}
          onAddConsentVersion={actions.addConsentVersion}
          onSaveRetention={actions.saveRetentionPolicy}
          onChanged={setSnapshot}
        />
      </TabsContent>

      <TabsContent value="brand">
        <BrandPanel
          snapshot={snapshot}
          canManage={canManageSettings}
          onSave={actions.saveBrandTokens}
          onChanged={setSnapshot}
        />
      </TabsContent>

      <TabsContent value="flags">
        <FeatureFlagsPanel flags={snapshot.featureFlags} />
      </TabsContent>
    </Tabs>
  );
}
