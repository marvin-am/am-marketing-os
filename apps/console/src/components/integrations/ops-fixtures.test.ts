import { resetProviderCache } from '@am/ai';
import { resetConfigCache } from '@am/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureOpsPort } from '@/server/ops-fixtures';

/**
 * Contract test for the fixture `OpsPort`.
 *
 * The component tests render props; this one exercises the implementation the
 * routes actually load, because the interesting behaviour lives in the real
 * probe functions of `@am/meta`, `@am/hubspot`, `@am/ai` and `@am/db` running
 * against their fixture path. It pins the four things the screens assert to the
 * operator:
 *
 * - a fixture provider is reported as `FIXTURE`, never as connected,
 * - a retry with writes disabled comes back as a dry run and confirms nothing,
 * - publishing a mapping appends an immutable version and does not open the
 *   launch gate on its own,
 * - retention starts unconfigured.
 *
 * The environment is stubbed rather than inherited. Every one of those claims is
 * about the *fixture* path, and which path the port takes is decided from
 * `DEMO_MODE` and the provider credentials — so on a machine with a real
 * `.env.local` this file used to build live providers and attempt real network
 * calls, and its verdict depended on whose machine ran it. A test that answers
 * differently per machine is not a gate.
 */

const FIXTURE_ENV: Readonly<Record<string, string>> = {
  DEMO_MODE: 'true',
  EXTERNAL_WRITES_ENABLED: 'false',
  META_MUTATIONS_ENABLED: 'false',
  META_CAPI_ENABLED: 'false',
  HUBSPOT_WRITES_ENABLED: 'false',
  META_ACCESS_TOKEN: '',
  META_AD_ACCOUNT_ID: '',
  HUBSPOT_PRIVATE_APP_TOKEN: '',
  HUBSPOT_CLIENT_ID: '',
  OPENAI_API_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  DATABASE_URL: '',
};

describe('fixture OpsPort', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(FIXTURE_ENV)) vi.stubEnv(key, value);
    resetConfigCache();
    // The OpenAI client memoises the key it was built with.
    resetProviderCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
    resetProviderCache();
  });

  it('serves every screen and reports fixture mode honestly', async () => {
    const port = createFixtureOpsPort();

    const today = await port.loadToday();
    expect(today.items.length).toBeGreaterThan(0);
    expect(today.items.some((item) => item.kind === 'ERROR')).toBe(true);

    const library = await port.loadLibrary();
    expect(library.creatives.length).toBeGreaterThan(0);
    // Every creative carries a data maturity, so no figure stands unqualified.
    expect(library.creatives.every((creative) => creative.performance.maturity)).toBe(true);

    const integrations = await port.loadIntegrations();
    expect(integrations.providers.map((provider) => provider.provider)).toEqual([
      'META',
      'HUBSPOT',
      'OPENAI',
      'SUPABASE',
    ]);
    for (const provider of integrations.providers) {
      expect(provider.health.checks.length).toBeGreaterThan(0);
      expect(provider.health.state).toBe('FIXTURE');
      expect(provider.connection.connectedAt).toBeNull();
    }

    // Meta and HubSpot own fixture providers that genuinely answer their probes.
    // OpenAI and Supabase have nothing to answer them without a credential, so
    // every one of their checks has to say so rather than pass.
    for (const provider of integrations.providers) {
      if (provider.provider !== 'OPENAI' && provider.provider !== 'SUPABASE') continue;
      expect(
        provider.health.checks.every((check) => check.status === 'AWAITING_EXTERNAL_INPUT'),
      ).toBe(true);
    }
  });

  it('runs all ten Meta steps against the fixture provider and says nothing is connected', async () => {
    const meta = await createFixtureOpsPort().loadMetaSetup();

    expect(meta.steps).toHaveLength(10);
    expect(meta.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(meta.mode).toBe('FIXTURE');
    expect(meta.fixtureNoticeDe).toContain('keine Verbindung zu Meta');
    expect(meta.health.state).toBe('FIXTURE');
    // No credential is ever presented as verified while running on fixtures.
    expect(meta.credentials.every((slot) => slot.displayValue === null)).toBe(true);
  });

  it('never presents an unreached OpenAI or Supabase as connected', async () => {
    // A key and a connection string, and nothing that answers them: the console
    // must report what it found, not what the environment implies.
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('OPENAI_API_KEY', 'sk-not-a-real-key');
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/v1');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-not-real');
    vi.stubEnv('DATABASE_URL', 'postgresql://nobody@127.0.0.1:1/nothing');
    resetConfigCache();
    resetProviderCache();

    const port = createFixtureOpsPort();
    const openai = await port.recheckProvider({ provider: 'OPENAI' });
    const supabase = await port.recheckProvider({ provider: 'SUPABASE' });

    for (const health of [openai, supabase]) {
      expect(health.state).not.toBe('CONNECTED');
      expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
      expect(health.checks.every((check) => check.detailDe)).toBe(true);
    }
  });

  it('returns a dry run for a retry while external writes are disabled', async () => {
    const port = createFixtureOpsPort();
    const outbox = await port.loadOutbox();
    const deadLetter = outbox.rows.find((row) => row.event.status === 'DEAD_LETTER');
    expect(deadLetter).toBeDefined();

    const outcome = await port.retryOutboxEvent({ eventId: deadLetter!.event.event_id });
    expect(outcome.dryRun).not.toBeNull();
    expect(outcome.providerConfirmed).toBe(false);
    expect(outcome.state).toBe('DEAD_LETTER');
  });

  it('walks the mapping wizard: incomplete, complete, published, still not launch-ready', async () => {
    const port = createFixtureOpsPort();

    const initial = await port.loadHubspotMapping();
    expect(initial.steps).toHaveLength(15);
    expect(initial.validation.ok).toBe(false);
    expect(initial.launchReady).toBe(false);
    expect(initial.missingForLaunchDe.length).toBeGreaterThan(0);

    const complete = await port.applyFixtureMapping();
    expect(complete.validation.ok).toBe(true);
    expect(complete.canPublish).toBe(true);
    // A complete document is still not a launched one: the test lead is missing.
    expect(complete.launchReady).toBe(false);

    const published = await port.publishMapping({
      publishedBy: '11111111-1111-4111-8111-111111111111',
      now: '2026-08-25T07:30:00.000Z',
    });
    expect(published.published).toBe(true);
    expect(published.version).toBe(1);

    const after = await port.loadHubspotMapping();
    expect(after.versions.some((version) => version.status === 'PUBLISHED')).toBe(true);
    expect(after.launchReady).toBe(false);
  });

  it('leaves the retention policy unconfigured and never invents a period', async () => {
    const settings = await createFixtureOpsPort().loadSettings();

    expect(settings.retention.submissionPiiDays).toBeNull();
    expect(settings.retention.rawProviderPayloadDays).toBeNull();
    expect(settings.retention.analyticsEventDays).toBeNull();
    expect(settings.retention.auditLogDays).toBeNull();
    expect(settings.retention.configuredAt).toBeNull();
    expect(settings.featureFlags).toHaveLength(5);
  });
});
