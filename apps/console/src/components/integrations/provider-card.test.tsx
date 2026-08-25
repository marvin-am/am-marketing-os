import { render, screen } from '@testing-library/react';
import type { HealthCheck, HealthStatus, Provider, ProviderHealth } from '@am/domain';
import { rollUpHealth } from '@am/domain';
import { describe, expect, it, vi } from 'vitest';
import { actionOk, type ActionResult } from '@/lib/action-result';
import type { ProviderCardData } from '@/server/ops-port';
import { ProviderCard } from './provider-card';

const CHECKED_AT = '2026-08-25T07:30:00.000Z';

function check(
  key: string,
  status: HealthStatus,
  detailDe: string,
  remediationDe: string | null = null,
): HealthCheck {
  return {
    key,
    labelDe: `Prüfung ${key}`,
    status,
    detailDe,
    checkedAt: CHECKED_AT,
    remediationDe,
    blocksLiveOnly: false,
  };
}

function health(checks: HealthCheck[], provider: Provider = 'META'): ProviderHealth {
  return {
    provider,
    state: 'FIXTURE',
    overall: rollUpHealth(checks),
    checks,
    checkedAt: CHECKED_AT,
  };
}

function cardData(overrides: Partial<ProviderCardData> = {}): ProviderCardData {
  const providerHealth = overrides.health ?? health([check('a', 'PASS', 'Alles in Ordnung.')]);
  return {
    provider: 'META',
    connection: {
      id: 'connection-meta',
      provider: 'META',
      state: providerHealth.state,
      accountLabel: null,
      externalAccountId: null,
      grantedScopes: [],
      connectedAt: null,
      expiresAt: null,
      lastCheckedAt: CHECKED_AT,
    },
    health: providerHealth,
    lastSyncAt: null,
    errorCount: 0,
    deadLetterCount: 0,
    modeDe: 'Fixture-Modus: keine Verbindung zum Anbieter.',
    setupHref: '/integrationen/meta',
    setupLabelDe: 'Meta-Assistent öffnen',
    ...overrides,
  };
}

const noopRecheck = async (): Promise<ActionResult<ProviderHealth>> =>
  actionOk(health([check('a', 'PASS', 'Alles in Ordnung.')]));
const noopRetry = async (): Promise<ActionResult<{ attempted: number }>> =>
  actionOk({ attempted: 0 });

describe('ProviderCard', () => {
  it('presents AWAITING_EXTERNAL_INPUT as waiting, clearly apart from a failure', () => {
    const { container } = render(
      <ProviderCard
        data={cardData({
          health: health([
            check(
              'meta.app_connection',
              'AWAITING_EXTERNAL_INPUT',
              'Es ist kein Meta-Zugriffstoken hinterlegt.',
              'META_ACCESS_TOKEN hinterlegen.',
            ),
          ]),
        })}
        canManage
        onRecheck={noopRecheck}
        onRetryFailed={noopRetry}
      />,
    );

    const waiting = container.querySelector('[data-provider-state="AWAITING_EXTERNAL_INPUT"]');
    expect(waiting).not.toBeNull();
    expect(waiting?.textContent).toContain('wartet auf externen Input');
    expect(waiting?.textContent).toContain('Das ist kein Fehler');

    // Nothing on the card claims a failure …
    expect(container.querySelector('[data-provider-state="FAIL"]')).toBeNull();
    // … and the roll-up keeps the waiting state instead of upgrading it to OK.
    expect(screen.getAllByText('Wartet auf externen Input').length).toBeGreaterThan(0);
    expect(screen.queryByText('Fehler')).not.toBeInTheDocument();
  });

  it('presents FAIL as broken, with its own wording', () => {
    const { container } = render(
      <ProviderCard
        data={cardData({
          health: health([
            check('meta.ad_account', 'FAIL', 'Das Werbekonto ist nicht sichtbar.', 'Zugriff erteilen.'),
          ]),
        })}
        canManage
        onRecheck={noopRecheck}
        onRetryFailed={noopRetry}
      />,
    );

    const failing = container.querySelector('[data-provider-state="FAIL"]');
    expect(failing).not.toBeNull();
    expect(failing?.textContent).toContain('fehlgeschlagen');
    expect(failing?.textContent).toContain('Hier ist etwas kaputt');
    expect(container.querySelector('[data-provider-state="AWAITING_EXTERNAL_INPUT"]')).toBeNull();
  });

  it('does not upgrade a waiting check to OK when another check passes', () => {
    const checks = [
      check('a', 'PASS', 'Ok.'),
      check('b', 'AWAITING_EXTERNAL_INPUT', 'Wartet auf ein Token.'),
    ];
    expect(rollUpHealth(checks)).toBe('AWAITING_EXTERNAL_INPUT');
  });

  it('hides the retry control from a role without integration.manage and names who may', () => {
    const onRetryFailed = vi.fn(noopRetry);
    const { container } = render(
      <ProviderCard
        data={cardData({ errorCount: 2, deadLetterCount: 1 })}
        canManage={false}
        onRecheck={noopRecheck}
        onRetryFailed={onRetryFailed}
      />,
    );

    expect(screen.queryByRole('button', { name: /erneut senden/i })).not.toBeInTheDocument();
    const denied = container.querySelector('[data-permission-denied="integration.manage"]');
    expect(denied).not.toBeNull();
    expect(denied?.textContent).toContain('RevOps');
    expect(denied?.textContent).toContain('Administrator');
    expect(onRetryFailed).not.toHaveBeenCalled();
  });

  it('offers the retry control to a role that holds integration.manage', () => {
    render(
      <ProviderCard
        data={cardData({ errorCount: 2, deadLetterCount: 1 })}
        canManage
        onRecheck={noopRecheck}
        onRetryFailed={noopRetry}
      />,
    );

    expect(screen.getByRole('button', { name: /3 erneut senden/ })).toBeInTheDocument();
  });
});
