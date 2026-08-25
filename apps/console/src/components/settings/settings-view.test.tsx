import { render, screen } from '@testing-library/react';
import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DEFAULT_RECOMMENDATION_CONFIG,
  DEFAULT_ROLE_BUDGET_LIMITS,
  UNCONFIGURED_RETENTION_POLICY,
} from '@am/domain';
import { describe, expect, it, vi } from 'vitest';
import { actionOk, type ActionResult } from '@/lib/action-result';
import type { SettingsSnapshot } from '@/server/ops-port';
import { SettingsView, type SettingsViewProps } from './settings-view';

const AT = '2026-08-25T07:30:00.000Z';

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    generatedAt: AT,
    members: [
      {
        id: 'member-1',
        displayName: 'Lea Brandt',
        email: 'lea.brandt@am-beratung.de',
        roles: ['MARKETING_LEAD'],
        lastActiveAt: AT,
      },
    ],
    roleBudgetLimits: { ...DEFAULT_ROLE_BUDGET_LIMITS },
    approvalThresholds: {
      budgetScaleApprovalPct: 0.2,
      majorChangeApprovalPct: 0.5,
      dailyBudgetApprovalMinor: 20_000_00,
      currency: 'EUR',
    },
    experimentThresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS },
    recommendationConfig: { ...DEFAULT_RECOMMENDATION_CONFIG },
    attributionWindowDays: 30,
    consentVersions: [
      {
        id: 'consent-1',
        version: 1,
        textDe:
          'Ich willige ein, dass A&M mich zu meiner Anfrage per E-Mail und Telefon kontaktiert.',
        purposes: ['CONTACT'],
        privacyPolicyUrl: 'https://am-beratung.de/datenschutz',
        effectiveFrom: AT,
        effectiveUntil: null,
      },
    ],
    retention: { ...UNCONFIGURED_RETENTION_POLICY },
    brand: {
      primary: '#D7182A',
      foreground: '#111111',
      background: '#FFFFFF',
      accent: '#000000',
      logoAssetPath: null,
    },
    featureFlags: [
      {
        key: 'externalWritesEnabled',
        labelDe: 'Externe Schreibzugriffe',
        value: false,
        envVar: 'EXTERNAL_WRITES_ENABLED',
        explanationDe: 'Hauptschalter. Solange er aus ist, liefert jeder Adapter einen Dry-Run.',
      },
      {
        key: 'hubspotWritesEnabled',
        labelDe: 'HubSpot-Schreibzugriffe',
        value: false,
        envVar: 'HUBSPOT_WRITES_ENABLED',
        explanationDe: 'Erlaubt das Anlegen und Aktualisieren von Kontakten und Deals.',
      },
    ],
    ...overrides,
  };
}

const ok = async (): Promise<ActionResult<SettingsSnapshot>> => actionOk(snapshot());

function actions(): SettingsViewProps['actions'] {
  return {
    saveMemberRoles: ok,
    saveRoleBudgetLimit: ok,
    saveApprovalThresholds: ok,
    saveExperimentThresholds: ok,
    saveRecommendationConfig: ok,
    saveAttributionWindow: ok,
    addConsentVersion: ok,
    saveRetentionPolicy: ok,
    saveBrandTokens: ok,
  };
}

describe('SettingsView — retention', () => {
  it('renders every retention period as „nicht konfiguriert“ by default', () => {
    const { container } = render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="compliance"
        actions={actions()}
      />,
    );

    const rows = container.querySelectorAll('[data-retention-field]');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.textContent).toContain('nicht konfiguriert');
    }

    expect(
      screen.getByText('Es ist keine Aufbewahrungsfrist konfiguriert.'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-retention-configured="false"]')).not.toBeNull();
  });

  it('never invents a legal period and says why', () => {
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="compliance"
        actions={actions()}
      />,
    );

    expect(screen.getByText(/Es wird nichts automatisch gelöscht/)).toBeInTheDocument();
    expect(
      screen.getByText(/entscheidet die verantwortliche Stelle/),
    ).toBeInTheDocument();
  });

  it('shows a configured period instead of the placeholder', () => {
    const { container } = render(
      <SettingsView
        snapshot={snapshot({
          retention: {
            ...UNCONFIGURED_RETENTION_POLICY,
            submissionPiiDays: 365,
            configuredBy: 'member-1',
            configuredAt: AT,
          },
        })}
        canManageSettings
        canManageUsers
        defaultTab="compliance"
        actions={actions()}
      />,
    );

    const row = container.querySelector('[data-retention-field="submissionPiiDays"]');
    expect(row?.textContent).toContain('365 Tage');
    expect(row?.textContent).not.toContain('nicht konfiguriert');
    // The remaining fields stay unset rather than inheriting a period.
    expect(
      container.querySelector('[data-retention-field="auditLogDays"]')?.textContent,
    ).toContain('nicht konfiguriert');
  });
});

describe('SettingsView — permissions', () => {
  it('hides the retention control from a role without settings.manage and names who may', () => {
    const saveRetentionPolicy = vi.fn(ok);
    const { container } = render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings={false}
        canManageUsers={false}
        defaultTab="compliance"
        actions={{ ...actions(), saveRetentionPolicy }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Fristen speichern' })).not.toBeInTheDocument();
    const denied = container.querySelectorAll('[data-permission-denied="settings.manage"]');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]?.textContent).toContain('Administrator');
    expect(saveRetentionPolicy).not.toHaveBeenCalled();
  });

  it('hides the role editor from a role without user.manage', () => {
    const { container } = render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers={false}
        defaultTab="users"
        actions={actions()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rollen ändern' })).not.toBeInTheDocument();
    expect(container.querySelector('[data-permission-denied="user.manage"]')).not.toBeNull();
  });

  it('shows the mutating controls to a role that holds the permission', () => {
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="compliance"
        actions={actions()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Fristen speichern' })).toBeInTheDocument();
  });

  it('describes each role with its German description', () => {
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="users"
        actions={actions()}
      />,
    );

    expect(
      screen.getByText(
        'Veröffentlicht und pausiert Kampagnen und skaliert Budgets innerhalb des Rollenlimits.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Verwaltet HubSpot-Mappings sowie Revenue- und VQ-Definitionen.'),
    ).toBeInTheDocument();
  });
});

describe('SettingsView — feature flags', () => {
  it('renders feature flags read-only with their environment variable', () => {
    const { container } = render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="flags"
        actions={actions()}
      />,
    );

    expect(screen.getByText('Externe Schreibzugriffe sind deaktiviert.')).toBeInTheDocument();
    expect(screen.getByText('EXTERNAL_WRITES_ENABLED')).toBeInTheDocument();
    expect(
      screen.getByText(/Umgebung der Deployment-Konfiguration, nicht/),
    ).toBeInTheDocument();

    // Read-only means read-only: no switch, no checkbox, no save button.
    const flagsPanel = container.querySelector('#feature-flags');
    expect(flagsPanel?.querySelectorAll('button')).toHaveLength(0);
    expect(flagsPanel?.querySelectorAll('input')).toHaveLength(0);
  });
});
