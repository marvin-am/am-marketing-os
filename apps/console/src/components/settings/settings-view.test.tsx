import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { SETTINGS_TABS, resolveSettingsTab, type SettingsTab } from './tabs';

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
    saveMemberRoles: vi.fn(ok),
    saveRoleBudgetLimit: vi.fn(ok),
    saveApprovalThresholds: vi.fn(ok),
    saveExperimentThresholds: vi.fn(ok),
    saveRecommendationConfig: vi.fn(ok),
    saveAttributionWindow: vi.fn(ok),
    addConsentVersion: vi.fn(ok),
    saveRetentionPolicy: vi.fn(ok),
    saveBrandTokens: vi.fn(ok),
  };
}

/**
 * What each tab has to put on screen, and the controls that must reach a server
 * action. Keyed by tab id so a tab added to `SETTINGS_TABS` without content
 * fails here rather than shipping as an empty panel.
 */
const TAB_CONTENT: Record<
  SettingsTab,
  { headingDe: string; savesDe: readonly (keyof SettingsViewProps['actions'])[] }
> = {
  users: { headingDe: 'Nutzerinnen und Nutzer', savesDe: [] },
  limits: { headingDe: 'Budgetbefugnisse je Rolle', savesDe: ['saveApprovalThresholds'] },
  decisions: {
    headingDe: 'Experiment-Schwellen',
    savesDe: ['saveExperimentThresholds', 'saveRecommendationConfig', 'saveAttributionWindow'],
  },
  compliance: { headingDe: 'Einwilligungen', savesDe: ['saveRetentionPolicy'] },
  brand: { headingDe: 'Marken-Tokens', savesDe: ['saveBrandTokens'] },
  // Read-only by design: the safety rails are set in the environment.
  flags: { headingDe: 'Feature-Flags', savesDe: [] },
};

const SAVE_LABELS_DE: Record<keyof SettingsViewProps['actions'], string> = {
  saveMemberRoles: 'Rollen speichern',
  saveRoleBudgetLimit: 'Limit speichern',
  saveApprovalThresholds: 'Schwellen speichern',
  saveExperimentThresholds: 'Schwellen speichern',
  saveRecommendationConfig: 'Regeln speichern',
  saveAttributionWindow: 'Fenster speichern',
  addConsentVersion: 'Neue Version anlegen',
  saveRetentionPolicy: 'Fristen speichern',
  saveBrandTokens: 'Tokens speichern',
};

describe.each(SETTINGS_TABS.map((tab) => [tab.labelDe, tab] as const))(
  'SettingsView — tab „%s“',
  (_labelDe, tab) => {
    const expected = TAB_CONTENT[tab.id];

    it('is selected by its deep link and renders its section', () => {
      render(
        <SettingsView
          snapshot={snapshot()}
          canManageSettings
          canManageUsers
          defaultTab={resolveSettingsTab(tab.id)}
          actions={actions()}
        />,
      );

      expect(screen.getByRole('tab', { name: tab.labelDe })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const panel = screen.getByRole('tabpanel');
      expect(within(panel).getByRole('heading', { name: expected.headingDe })).toBeInTheDocument();
      expect(panel.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });

    it('reaches a server action from every save control it offers', async () => {
      const user = userEvent.setup();
      const handlers = actions();
      render(
        <SettingsView
          snapshot={snapshot()}
          canManageSettings
          canManageUsers
          defaultTab={tab.id}
          actions={handlers}
        />,
      );

      const panel = screen.getByRole('tabpanel');
      for (const key of expected.savesDe) {
        await user.click(within(panel).getByRole('button', { name: SAVE_LABELS_DE[key] }));
        expect(handlers[key]).toHaveBeenCalledTimes(1);
      }

      if (expected.savesDe.length === 0) {
        // Users edits roles through a dialog and flags carry no control at all;
        // both are asserted separately rather than pretended to be save buttons.
        expect(within(panel).queryByRole('button', { name: /speichern/i })).not.toBeInTheDocument();
      }
    });
  },
);

describe('SettingsView — two-step controls', () => {
  it('saves a role budget limit through the inline editor', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const { container } = render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="limits"
        actions={handlers}
      />,
    );

    const row = container.querySelector('[data-role-limit="MARKETING_LEAD"]');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Ändern' }));
    await user.click(screen.getByRole('button', { name: 'Limit speichern' }));

    expect(handlers.saveRoleBudgetLimit).toHaveBeenCalledTimes(1);
  });

  it('saves member roles through the confirmation dialog', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="users"
        actions={handlers}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Rollen ändern' }));
    await user.click(screen.getByRole('button', { name: 'Rollen speichern' }));

    expect(handlers.saveMemberRoles).toHaveBeenCalledWith({
      memberId: 'member-1',
      roles: ['MARKETING_LEAD'],
    });
  });

  it('creates a consent version through the confirmation dialog', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="compliance"
        actions={handlers}
      />,
    );

    const consentText = 'Ich willige in die Verarbeitung meiner Angaben zur Kontaktaufnahme ein.';
    await user.type(screen.getByLabelText(/Einwilligungstext/), consentText);
    await user.click(screen.getByRole('button', { name: 'Neue Version anlegen' }));
    await user.click(screen.getByRole('button', { name: 'Version anlegen' }));

    expect(handlers.addConsentVersion).toHaveBeenCalledWith({
      textDe: consentText,
      purposes: ['CONTACT'],
      privacyPolicyUrl: 'https://am-beratung.de/datenschutz',
    });
  });
});

describe('SettingsView — tab strip', () => {
  it('offers a trigger for every declared tab', () => {
    render(
      <SettingsView snapshot={snapshot()} canManageSettings canManageUsers actions={actions()} />,
    );

    const triggers = screen.getAllByRole('tab');
    expect(triggers.map((trigger) => trigger.textContent)).toEqual(
      SETTINGS_TABS.map((tab) => tab.labelDe),
    );
  });

  it('switches panels when another tab is chosen', async () => {
    const user = userEvent.setup();
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab="users"
        actions={actions()}
      />,
    );

    await user.click(screen.getByRole('tab', { name: 'Marke' }));
    expect(
      within(screen.getByRole('tabpanel')).getByRole('heading', { name: 'Marken-Tokens' }),
    ).toBeInTheDocument();
  });

  it('opens the default tab for an unknown deep link', () => {
    render(
      <SettingsView
        snapshot={snapshot()}
        canManageSettings
        canManageUsers
        defaultTab={resolveSettingsTab('gibt-es-nicht')}
        actions={actions()}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Nutzer und Rollen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

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
