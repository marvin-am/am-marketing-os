import { beforeEach, describe, expect, it } from 'vitest';
import {
  LAUNCH_CHECK_LABELS_DE,
  LIVE_ONLY_CHECKS,
  summarizeLaunchQa,
  type FeatureFlags,
  type LaunchCheckResult,
} from '@am/domain';
import {
  FIXTURE_MAPPING,
  FixtureHubspotProvider,
  INCOMPLETE_FIXTURE_MAPPING,
  checkHubspotHealth,
  createFixtureClock,
  createInMemorySyncStore,
  isTestLeadGatePassed,
  requiredMappingsComplete,
  runTestLead,
  type HubspotMappingDocument,
  type InMemorySyncStore,
  type TestLeadResult,
} from '../src/index';

/**
 * The live-launch gate: a campaign may only go live once the required mappings
 * exist *and* a real test lead has succeeded. Everything short of that reports
 * `AWAITING_EXTERNAL_INPUT` and leaves the rest of the product usable.
 */

const WRITES_OFF: FeatureFlags = {
  demoMode: true,
  externalWritesEnabled: false,
  metaMutationsEnabled: false,
  metaCapiEnabled: false,
  hubspotWritesEnabled: false,
};
const WRITES_ON: FeatureFlags = { ...WRITES_OFF, externalWritesEnabled: true, hubspotWritesEnabled: true };

const CAMPAIGN = '00000000-0000-4000-8000-0000000c0001';
const OPERATOR = '00000000-0000-4000-8000-0000000c0002';

let store: InMemorySyncStore;
let clock: () => string;

beforeEach(() => {
  clock = createFixtureClock('2026-03-01T09:00:00.000Z');
  store = createInMemorySyncStore();
});

function uuidFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

async function probe(
  mapping: HubspotMappingDocument,
  flags: FeatureFlags,
): Promise<TestLeadResult> {
  const provider = new FixtureHubspotProvider({ flags, clock });
  return runTestLead(
    { mapping, initiatedBy: OPERATOR },
    { provider, store, flags, now: clock, newUuid: uuidFactory() },
  );
}

/** Projects the HubSpot health onto the two HubSpot launch-QA checks. */
function launchChecks(
  mappingComplete: boolean,
  testLead: TestLeadResult | null,
): LaunchCheckResult[] {
  const toStatus = (ok: boolean) => (ok ? ('PASS' as const) : ('AWAITING_EXTERNAL_INPUT' as const));
  return [
    {
      key: 'hubspot_mapping_complete',
      labelDe: LAUNCH_CHECK_LABELS_DE.hubspot_mapping_complete,
      status: toStatus(mappingComplete),
      detailDe: null,
      remediationDe: null,
      blocksLiveOnly: LIVE_ONLY_CHECKS.includes('hubspot_mapping_complete'),
      href: null,
    },
    {
      key: 'hubspot_test_lead_successful',
      labelDe: LAUNCH_CHECK_LABELS_DE.hubspot_test_lead_successful,
      status: toStatus(isTestLeadGatePassed(testLead)),
      detailDe: null,
      remediationDe: null,
      blocksLiveOnly: LIVE_ONLY_CHECKS.includes('hubspot_test_lead_successful'),
      href: null,
    },
  ];
}

describe('the live-launch gate', () => {
  it('blocks going live while the mapping is incomplete, without blocking the draft', async () => {
    expect(requiredMappingsComplete(INCOMPLETE_FIXTURE_MAPPING)).toBe(false);

    const testLead = await probe(INCOMPLETE_FIXTURE_MAPPING, WRITES_ON);
    expect(testLead.status).toBe('AWAITING_EXTERNAL_INPUT');

    const report = summarizeLaunchQa(CAMPAIGN, launchChecks(false, testLead), clock());
    expect(report.canGoLive).toBe(false);
    // The rest of the workflow — including a paused Meta draft — stays usable.
    expect(report.canCreateMetaDraft).toBe(true);
    expect(report.awaitingExternalDe).toContain(LAUNCH_CHECK_LABELS_DE.hubspot_mapping_complete);
  });

  it('still blocks going live when only a dry-run test lead exists', async () => {
    expect(requiredMappingsComplete(FIXTURE_MAPPING)).toBe(true);

    const testLead = await probe(FIXTURE_MAPPING, WRITES_OFF);
    expect(testLead.status).toBe('DRY_RUN');
    expect(isTestLeadGatePassed(testLead)).toBe(false);

    const report = summarizeLaunchQa(CAMPAIGN, launchChecks(true, testLead), clock());
    expect(report.canGoLive).toBe(false);
    expect(report.awaitingExternalDe).toEqual([
      LAUNCH_CHECK_LABELS_DE.hubspot_test_lead_successful,
    ]);
  });

  it('opens the gate once the mapping is complete and a real test lead succeeded', async () => {
    const testLead = await probe(FIXTURE_MAPPING, WRITES_ON);
    expect(testLead.status).toBe('PASS');
    expect(isTestLeadGatePassed(testLead)).toBe(true);

    const report = summarizeLaunchQa(CAMPAIGN, launchChecks(true, testLead), clock());
    expect(report.canGoLive).toBe(true);
    expect(report.blockingDe).toEqual([]);
  });
});

describe('health reflects the same state as the gate', () => {
  it('waits for external input rather than failing while nothing is configured', async () => {
    const provider = new FixtureHubspotProvider({ flags: WRITES_OFF, clock });
    const health = await checkHubspotHealth(
      { mapping: null, flags: WRITES_OFF },
      { provider, now: clock },
    );

    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.some((c) => c.status === 'FAIL')).toBe(false);
    expect(health.state).toBe('FIXTURE');
  });

  it('carries the test-lead outcome into the health panel', async () => {
    const provider = new FixtureHubspotProvider({ flags: WRITES_ON, clock });
    const testLead = await probe(FIXTURE_MAPPING, WRITES_ON);

    const health = await checkHubspotHealth(
      {
        mapping: FIXTURE_MAPPING,
        flags: WRITES_ON,
        testLead: { status: testLead.status, at: testLead.finishedAt },
        lastSuccessfulSyncAt: testLead.finishedAt,
      },
      { provider, now: clock },
    );

    const check = health.checks.find((c) => c.key === 'test_lead');
    expect(check?.status).toBe('PASS');
    // The connection itself is still a fixture, so the overall state says so.
    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.find((c) => c.key === 'connection')?.status).toBe(
      'AWAITING_EXTERNAL_INPUT',
    );
  });
});
