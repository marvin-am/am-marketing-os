import { describe, expect, it } from 'vitest';
import { type FeatureFlags } from '@am/domain';
import { FIXTURE_MAPPING, INCOMPLETE_FIXTURE_MAPPING, createFixtureClock } from './fixtures';
import { FixtureHubspotProvider } from './provider-fixture';
import { REQUIRED_HUBSPOT_SCOPES, type ProviderConnectionProbe } from './provider-types';
import type { HubspotProvider } from './provider';
import { checkHubspotHealth } from './health';

const NOW = '2026-03-01T09:00:00.000Z';

const WRITES_OFF: FeatureFlags = {
  demoMode: true,
  externalWritesEnabled: false,
  metaMutationsEnabled: false,
  metaCapiEnabled: false,
  hubspotWritesEnabled: false,
};
const WRITES_ON: FeatureFlags = { ...WRITES_OFF, externalWritesEnabled: true, hubspotWritesEnabled: true };

function connectedProvider(overrides: Partial<ProviderConnectionProbe> = {}): HubspotProvider {
  const base = new FixtureHubspotProvider({ flags: WRITES_ON, clock: createFixtureClock() });
  // Only the connection probe is stubbed; every other call stays on the fixture.
  base.health = async (): Promise<ProviderConnectionProbe> => ({
    reachable: true,
    state: 'CONNECTED',
    grantedScopes: [...REQUIRED_HUBSPOT_SCOPES],
    accountLabel: 'Testportal',
    portalId: '4242',
    detailDe: null,
    checkedAt: NOW,
    ...overrides,
  });
  return base as unknown as HubspotProvider;
}

function fixtureProvider(): HubspotProvider {
  return new FixtureHubspotProvider({
    flags: WRITES_OFF,
    clock: createFixtureClock(),
  }) as unknown as HubspotProvider;
}

function statusOf(checks: { key: string; status: string }[], key: string): string | undefined {
  return checks.find((c) => c.key === key)?.status;
}

describe('checkHubspotHealth', () => {
  it('reports AWAITING_EXTERNAL_INPUT — never a fake FAIL — in fixture mode', async () => {
    const health = await checkHubspotHealth(
      { mapping: null, flags: WRITES_OFF },
      { provider: fixtureProvider(), now: () => NOW },
    );

    expect(health.provider).toBe('HUBSPOT');
    expect(health.state).toBe('FIXTURE');
    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.every((c) => c.status !== 'FAIL')).toBe(true);
    expect(statusOf(health.checks, 'connection')).toBe('AWAITING_EXTERNAL_INPUT');
    expect(statusOf(health.checks, 'mapping_complete')).toBe('AWAITING_EXTERNAL_INPUT');
    expect(statusOf(health.checks, 'test_lead')).toBe('AWAITING_EXTERNAL_INPUT');
    expect(statusOf(health.checks, 'write_flags')).toBe('AWAITING_EXTERNAL_INPUT');
  });

  it('marks every waiting check as live-blocking only', async () => {
    const health = await checkHubspotHealth(
      { mapping: null, flags: WRITES_OFF },
      { provider: fixtureProvider(), now: () => NOW },
    );
    for (const c of health.checks.filter((x) => x.status === 'AWAITING_EXTERNAL_INPUT')) {
      expect(c.blocksLiveOnly).toBe(true);
      expect(c.remediationDe ?? c.detailDe).toBeTruthy();
    }
  });

  it('reports an incomplete mapping as waiting, with the missing pieces in German', async () => {
    const health = await checkHubspotHealth(
      { mapping: INCOMPLETE_FIXTURE_MAPPING, flags: WRITES_ON },
      { provider: connectedProvider(), now: () => NOW },
    );
    const mappingCheck = health.checks.find((c) => c.key === 'mapping_complete');
    expect(mappingCheck?.status).toBe('AWAITING_EXTERNAL_INPUT');
    expect(mappingCheck?.detailDe).toMatch(/Pflichtangabe/);
  });

  it('passes every check once the portal, mapping and test lead are in place', async () => {
    const health = await checkHubspotHealth(
      {
        mapping: FIXTURE_MAPPING,
        flags: WRITES_ON,
        lastSuccessfulSyncAt: '2026-03-01T08:00:00.000Z',
        webhookSubscription: {
          active: true,
          subscribedTypes: ['deal.propertyChange'],
          secretConfigured: true,
        },
        testLead: { status: 'PASS', at: '2026-03-01T07:00:00.000Z' },
      },
      { provider: connectedProvider(), now: () => NOW },
    );
    expect(health.overall).toBe('PASS');
    expect(health.state).toBe('CONNECTED');
  });

  it('never invents a scope PASS when the token cannot be introspected', async () => {
    const health = await checkHubspotHealth(
      { mapping: FIXTURE_MAPPING, flags: WRITES_ON },
      { provider: connectedProvider({ grantedScopes: [] }), now: () => NOW },
    );
    const scopes = health.checks.find((c) => c.key === 'scopes');
    expect(scopes?.status).toBe('AWAITING_EXTERNAL_INPUT');
    expect(scopes?.remediationDe).toContain('crm.objects.contacts.write');
  });

  it('fails when a required scope is genuinely missing', async () => {
    const health = await checkHubspotHealth(
      { mapping: FIXTURE_MAPPING, flags: WRITES_ON },
      {
        provider: connectedProvider({ grantedScopes: ['crm.objects.contacts.read'] }),
        now: () => NOW,
      },
    );
    expect(statusOf(health.checks, 'scopes')).toBe('FAIL');
    expect(health.overall).toBe('FAIL');
  });

  it('treats a dry-run test lead as not yet successful', async () => {
    const health = await checkHubspotHealth(
      {
        mapping: FIXTURE_MAPPING,
        flags: WRITES_ON,
        testLead: { status: 'DRY_RUN', at: NOW },
      },
      { provider: connectedProvider(), now: () => NOW },
    );
    const testLead = health.checks.find((c) => c.key === 'test_lead');
    expect(testLead?.status).toBe('AWAITING_EXTERNAL_INPUT');
    expect(testLead?.detailDe).toMatch(/Dry-Run/);
  });

  it('warns when the last successful sync is stale', async () => {
    const health = await checkHubspotHealth(
      {
        mapping: FIXTURE_MAPPING,
        flags: WRITES_ON,
        lastSuccessfulSyncAt: '2026-02-20T09:00:00.000Z',
        staleSyncHours: 24,
        webhookSubscription: { active: true, subscribedTypes: ['deal.propertyChange'], secretConfigured: true },
        testLead: { status: 'PASS', at: NOW },
      },
      { provider: connectedProvider(), now: () => NOW },
    );
    expect(statusOf(health.checks, 'last_successful_sync')).toBe('WARN');
    expect(health.overall).toBe('WARN');
  });
});
