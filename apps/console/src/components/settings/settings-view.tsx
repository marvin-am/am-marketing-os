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
import { UsersPanel } from './users-panel';

/**
 * The settings surface.
 *
 * Every panel receives the same snapshot and hands back the snapshot the server
 * returned, so a change in one area is immediately visible in another — role
 * limits and approval thresholds in particular are read together.
 */

export const SETTINGS_TABS = [
  'users',
  'limits',
  'decisions',
  'compliance',
  'brand',
  'flags',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

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
  defaultTab = 'users',
  actions,
}: SettingsViewProps) {
  const [snapshot, setSnapshot] = React.useState(initial);

  React.useEffect(() => {
    setSnapshot(initial);
  }, [initial]);

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList className="flex-wrap">
        <TabsTrigger value="users">Nutzer und Rollen</TabsTrigger>
        <TabsTrigger value="limits">Limits und Freigaben</TabsTrigger>
        <TabsTrigger value="decisions">Entscheidungsregeln</TabsTrigger>
        <TabsTrigger value="compliance">Einwilligung und Aufbewahrung</TabsTrigger>
        <TabsTrigger value="brand">Marke</TabsTrigger>
        <TabsTrigger value="flags">Feature-Flags</TabsTrigger>
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
