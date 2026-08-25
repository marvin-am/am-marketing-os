import { describe, expect, it } from 'vitest';
import { createFixtureOpsPort } from '@/server/ops-fixtures';

/**
 * Contract test for the fixture `OpsPort`.
 *
 * The component tests render props; this one exercises the implementation the
 * routes actually load, because the interesting behaviour lives in the real
 * probe functions of `@am/meta` and `@am/hubspot` running against their fixture
 * providers. It pins the four things the screens assert to the operator:
 *
 * - a fixture provider is reported as `FIXTURE`, never as connected,
 * - a retry with writes disabled comes back as a dry run and confirms nothing,
 * - publishing a mapping appends an immutable version and does not open the
 *   launch gate on its own,
 * - retention starts unconfigured.
 */
describe('fixture OpsPort', () => {
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
      expect(provider.health.state).not.toBe('CONNECTED');
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
