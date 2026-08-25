import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@am/config';
import { createLiveOpsPort } from '../src/server/ops-live';
import { createFixtureOpsPort } from '../src/server/ops-fixtures';
import type { OpsPort } from '../src/server/ops-port';
import { HAS_DATABASE, announceSkip } from '../../../supabase/tests/harness';
import {
  UNSEEDED_WORKSPACE_ID,
  setupConsoleDatabase,
  type ConsoleHarness,
} from './console-pg-harness';

/**
 * The live `OpsPort` against a real Postgres.
 *
 * The claim under test is the plain one: the Outbox screen lists the rows the
 * table holds and counts them the way SQL counts them, and the Einstellungen
 * screen shows the thresholds `workspace_settings` actually stores. Both are
 * asserted against queries issued on the same database, so neither can pass on a
 * port that answered from module scope.
 *
 * The environment is stubbed to fixture providers. The provider probes are real
 * and would otherwise attempt network calls whose outcome depends on the machine
 * — and this file is about the store, not about reachability, which
 * `packages/db/integration/supabase-health.test.ts` covers.
 *
 * Skips cleanly without `DATABASE_URL`. The scratch database is created and
 * dropped by the harness.
 */

const FIXTURE_ENV: Readonly<Record<string, string>> = {
  DEMO_MODE: 'true',
  EXTERNAL_WRITES_ENABLED: 'false',
  META_MUTATIONS_ENABLED: 'false',
  META_CAPI_ENABLED: 'false',
  HUBSPOT_WRITES_ENABLED: 'false',
  META_ACCESS_TOKEN: '',
  HUBSPOT_PRIVATE_APP_TOKEN: '',
  OPENAI_API_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  DATABASE_URL: '',
};

const NOW = '2026-08-25T09:00:00.000Z';

if (!HAS_DATABASE) announceSkip('apps/console/integration/ops-outbox-postgres.test.ts');

describe.skipIf(!HAS_DATABASE)('live OpsPort over the real schema', () => {
  let console_: ConsoleHarness;
  let port: OpsPort;
  let workspaceId: string;
  let campaignId: string;

  beforeAll(async () => {
    console_ = await setupConsoleDatabase('ops_outbox', { applySeed: true });

    const campaign = await console_.sql.query<{ id: string; workspace_id: string }>(
      `select id, workspace_id from public.campaigns order by created_at limit 1`,
    );
    campaignId = campaign.rows[0].id;
    workspaceId = campaign.rows[0].workspace_id;

    const rows: Array<[string, string, string, number, string | null]> = [
      ['lead:pending-1', 'META_CAPI', 'PENDING', 0, null],
      ['lead:retrying-1', 'HUBSPOT', 'FAILED_RETRYING', 3, 'HTTP 429 – Rate Limit erreicht.'],
      ['lead:dead-1', 'META_CAPI', 'DEAD_LETTER', 8, 'HTTP 400 – user_data fehlt.'],
      ['lead:processing-1', 'HUBSPOT', 'PROCESSING', 1, null],
    ];
    for (const [eventId, destination, status, attempts, error] of rows) {
      await console_.sql.query(
        `insert into public.outbox_events
           (workspace_id, destination, event_id, dataset_id, event_name, event_time,
            payload, payload_hash, status, attempt_count, last_error, campaign_id)
         values ($1, $2, $3, '', 'Lead', $4, '{}'::jsonb, $5, $6, $7, $8, $9)`,
        [
          workspaceId,
          destination,
          eventId,
          NOW,
          'a'.repeat(64),
          status,
          attempts,
          error,
          campaignId,
        ],
      );
    }

    port = createLiveOpsPort({
      db: console_.db,
      // Not the seeded workspace: the port has to find it by slug.
      workspaceId: UNSEEDED_WORKSPACE_ID,
      now: () => NOW,
    });
  });

  beforeEach(() => {
    for (const [key, value] of Object.entries(FIXTURE_ENV)) vi.stubEnv(key, value);
    resetConfigCache();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    resetConfigCache();
    await console_?.teardown();
  });

  it('lists exactly the outbox rows the table holds', async () => {
    const snapshot = await port.loadOutbox();

    const stored = await console_.sql.query<{ event_id: string; status: string }>(
      `select event_id, status from public.outbox_events where workspace_id = $1`,
      [workspaceId],
    );

    expect(snapshot.rows).toHaveLength(stored.rows.length);
    expect(new Set(snapshot.rows.map((row) => row.event.event_id))).toEqual(
      new Set(stored.rows.map((row) => row.event_id)),
    );

    const seeded = snapshot.rows.find((row) => row.event.event_id === 'lead:retrying-1');
    expect(seeded?.event.status).toBe('FAILED_RETRYING');
    expect(seeded?.event.attempt_count).toBe(3);
    expect(seeded?.event.last_error).toContain('Rate Limit');
    expect(seeded?.destinationLabelDe).toBe('HubSpot');
    expect(seeded?.href).toBe(`/kampagnen/${campaignId}`);
    expect(seeded?.retryable).toBe(true);

    const accepted = snapshot.rows.find((row) => row.event.status === 'ACCEPTED');
    expect(accepted).toBeDefined();
    expect(accepted?.retryable).toBe(false);
  });

  it('counts the queue the way the database counts it', async () => {
    const snapshot = await port.loadOutbox();
    const counts = await console_.sql.query<{ status: string; total: number }>(
      `select status, count(*)::int as total from public.outbox_events
        where workspace_id = $1 group by status`,
      [workspaceId],
    );
    const by = new Map(counts.rows.map((row) => [row.status, Number(row.total)]));

    expect(snapshot.pendingCount).toBe((by.get('PENDING') ?? 0) + (by.get('PROCESSING') ?? 0));
    expect(snapshot.retryingCount).toBe(by.get('FAILED_RETRYING') ?? 0);
    expect(snapshot.deadLetterCount).toBe(by.get('DEAD_LETTER') ?? 0);
  });

  it('prepares a retry as a dry run and changes nothing while writes are off', async () => {
    const before = await console_.sql.query<{ status: string; attempt_count: number }>(
      `select status, attempt_count from public.outbox_events where event_id = 'lead:dead-1'`,
    );

    const outcome = await port.retryOutboxEvent({ eventId: 'lead:dead-1' });
    expect(outcome.dryRun).not.toBeNull();
    expect(outcome.providerConfirmed).toBe(false);
    expect(outcome.state).toBe('DEAD_LETTER');

    const after = await console_.sql.query<{ status: string; attempt_count: number }>(
      `select status, attempt_count from public.outbox_events where event_id = 'lead:dead-1'`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('reads the thresholds, limits, consent texts and brand colours that are stored', async () => {
    const settings = await port.loadSettings();

    const stored = await console_.sql.query<{
      attribution_window_days: number;
      experiment_thresholds: Record<string, number>;
      retention_policy: Record<string, number | null>;
    }>(
      `select attribution_window_days, experiment_thresholds, retention_policy
         from public.workspace_settings where workspace_id = $1`,
      [workspaceId],
    );
    expect(settings.attributionWindowDays).toBe(stored.rows[0].attribution_window_days);
    expect(settings.experimentThresholds.crmMaturityDays).toBe(
      stored.rows[0].experiment_thresholds.crmMaturityDays,
    );
    expect(settings.retention.analyticsEventDays).toBe(
      stored.rows[0].retention_policy.analyticsEventDays,
    );

    const limit = await console_.sql.query<{ max_daily_budget_minor: number }>(
      `select max_daily_budget_minor from public.role_limits
        where workspace_id = $1 and role = 'MARKETING_LEAD'`,
      [workspaceId],
    );
    expect(settings.roleBudgetLimits.MARKETING_LEAD.maxDailyBudgetMinor).toBe(
      Number(limit.rows[0].max_daily_budget_minor),
    );
    // A role with no stored limit falls back to the product default rather than
    // to nothing — the screen must never show an unlimited budget.
    expect(settings.roleBudgetLimits.VIEWER.maxDailyBudgetMinor).toBe(0);

    const consent = await console_.sql.query<{ version: number; text_de: string }>(
      `select version, text_de from public.consent_versions where workspace_id = $1 order by version`,
      [workspaceId],
    );
    expect(settings.consentVersions.map((entry) => entry.version)).toEqual(
      consent.rows.map((row) => row.version),
    );
    expect(settings.consentVersions[0].textDe).toBe(consent.rows[0].text_de);

    const brand = await console_.sql.query<{ colors: Record<string, string> }>(
      `select colors from public.brand_profiles where workspace_id = $1 and is_default`,
      [workspaceId],
    );
    expect(settings.brand.primary).toBe(brand.rows[0].colors.primary);

    // Documented gap: `workspace_members` carries roles and a profile id, and no
    // repository reads `profiles`, so there is no name or e-mail to show.
    expect(settings.members).toEqual([]);
  });

  it('appends a consent version instead of editing the previous text', async () => {
    const before = await port.loadSettings();
    const after = await port.addConsentVersion({
      textDe: 'Ich willige in die Kontaktaufnahme per E-Mail ein.',
      purposes: ['CONTACT'],
      privacyPolicyUrl: 'https://www.am-beratung.de/datenschutz',
      now: NOW,
    });

    expect(after.consentVersions).toHaveLength(before.consentVersions.length + 1);
    expect(after.consentVersions[0].textDe).toBe(before.consentVersions[0].textDe);
    expect(after.consentVersions.at(-1)?.version).toBe(
      (before.consentVersions.at(-1)?.version ?? 0) + 1,
    );
  });

  it('persists a threshold change instead of holding it in memory', async () => {
    const updated = await port.saveExperimentThresholds({
      thresholds: { ...(await port.loadSettings()).experimentThresholds, minSessionsPerArm: 321 },
    });
    expect(updated.experimentThresholds.minSessionsPerArm).toBe(321);

    const stored = await console_.sql.query<{ thresholds: Record<string, number> }>(
      `select experiment_thresholds as thresholds from public.workspace_settings
        where workspace_id = $1`,
      [workspaceId],
    );
    expect(stored.rows[0].thresholds.minSessionsPerArm).toBe(321);
  });

  it('refuses a setting the schema cannot store rather than dropping it silently', async () => {
    await expect(
      port.saveApprovalThresholds({
        thresholds: {
          budgetScaleApprovalPct: 0.3,
          majorChangeApprovalPct: 0.6,
          dailyBudgetApprovalMinor: 30_000_00,
          currency: 'EUR',
        },
      }),
    ).rejects.toThrow(/keine Spalte/);

    await expect(port.saveMappingStep({ step: 'objects', patch: {} })).rejects.toThrow(
      /hubspot_mappings/,
    );
  });

  it('reports the connections the table holds without claiming a connection', async () => {
    const snapshot = await port.loadIntegrations();

    expect(snapshot.providers.map((provider) => provider.provider)).toEqual([
      'META',
      'HUBSPOT',
      'OPENAI',
      'SUPABASE',
    ]);

    const labels = await console_.sql.query<{ provider: string; account_label: string | null }>(
      `select provider, account_label from public.integration_connections where workspace_id = $1`,
      [workspaceId],
    );
    const stored = new Map(labels.rows.map((row) => [row.provider, row.account_label]));
    for (const provider of snapshot.providers) {
      if (!stored.has(provider.provider)) continue;
      expect(provider.connection.accountLabel).toBe(stored.get(provider.provider));
    }

    // The probe, not the stored row, decides the state — and with no credential
    // the probe never says CONNECTED.
    for (const provider of snapshot.providers) {
      expect(provider.connection.state).toBe(provider.health.state);
      expect(provider.health.state).not.toBe('CONNECTED');
    }

    const capiFailures = await console_.sql.query<{ total: number }>(
      `select count(*)::int as total from public.outbox_events
        where workspace_id = $1 and destination <> 'HUBSPOT' and status = 'DEAD_LETTER'`,
      [workspaceId],
    );
    const meta = snapshot.providers.find((provider) => provider.provider === 'META');
    expect(meta?.deadLetterCount).toBe(Number(capiFailures.rows[0].total));
  });

  it('shows the daily start page the campaigns and failures the database holds', async () => {
    const today = await port.loadToday();

    const active = await console_.sql.query<{ id: string; name: string }>(
      `select id, name from public.campaigns
        where workspace_id = $1 and state in ('LIVE', 'PAUSED')`,
      [workspaceId],
    );
    expect(new Set(today.activeCampaigns.map((campaign) => campaign.id))).toEqual(
      new Set(active.rows.map((row) => row.id)),
    );
    expect(today.items.some((item) => item.kind === 'ERROR')).toBe(true);
    expect(today.items[0].kind).toBe('ERROR');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture and live must answer the same shapes                                */
/* -------------------------------------------------------------------------- */

describe.skipIf(!HAS_DATABASE)('OpsPort read contract — fixture and postgres', () => {
  let console_: ConsoleHarness;
  let live: OpsPort;

  beforeAll(async () => {
    console_ = await setupConsoleDatabase('ops_contract', { applySeed: true });
    live = createLiveOpsPort({
      db: console_.db,
      workspaceId: UNSEEDED_WORKSPACE_ID,
      now: () => NOW,
    });
  });

  beforeEach(() => {
    for (const [key, value] of Object.entries(FIXTURE_ENV)) vi.stubEnv(key, value);
    resetConfigCache();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    resetConfigCache();
    await console_?.teardown();
  });

  it('reports the same outbox invariants from both stores', async () => {
    for (const port of [createFixtureOpsPort(), live]) {
      const snapshot = await port.loadOutbox();
      expect(snapshot.generatedAt).not.toBe('');

      const counted = {
        pending: snapshot.rows.filter(
          (row) => row.event.status === 'PENDING' || row.event.status === 'PROCESSING',
        ).length,
        retrying: snapshot.rows.filter((row) => row.event.status === 'FAILED_RETRYING').length,
        dead: snapshot.rows.filter((row) => row.event.status === 'DEAD_LETTER').length,
      };
      expect(snapshot.pendingCount).toBe(counted.pending);
      expect(snapshot.retryingCount).toBe(counted.retrying);
      expect(snapshot.deadLetterCount).toBe(counted.dead);

      for (const row of snapshot.rows) {
        // Only a state a retry can still change is offered as retryable, and a
        // row is only ever linked to a campaign it actually names.
        expect(row.retryable).toBe(
          row.event.status === 'FAILED_RETRYING' || row.event.status === 'DEAD_LETTER',
        );
        expect(row.href === null).toBe(row.event.campaign_id === null);
        expect(row.destinationLabelDe).not.toBe('');
      }
    }
  });

  it('never presents an unreached provider as connected, from either store', async () => {
    for (const port of [createFixtureOpsPort(), live]) {
      const snapshot = await port.loadIntegrations();
      expect(snapshot.providers).toHaveLength(4);
      for (const provider of snapshot.providers) {
        expect(provider.health.checks.length).toBeGreaterThan(0);
        expect(provider.health.state).not.toBe('CONNECTED');
        expect(provider.modeDe).not.toBe('');
      }
    }
  });

  it('leaves the HubSpot launch gate closed and says what is missing, from either store', async () => {
    for (const port of [createFixtureOpsPort(), live]) {
      const snapshot = await port.loadHubspotMapping();
      expect(snapshot.steps).toHaveLength(15);
      expect(snapshot.launchReady).toBe(false);
      expect(snapshot.missingForLaunchDe.length).toBeGreaterThan(0);
      expect(snapshot.testLead).toBeNull();
    }
  });

  it('runs all ten Meta wizard steps from either store', async () => {
    for (const port of [createFixtureOpsPort(), live]) {
      const setup = await port.loadMetaSetup();
      expect(setup.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(setup.mode).toBe('FIXTURE');
      expect(setup.credentials.every((slot) => slot.displayValue === null)).toBe(true);
    }
  });

  it('never invents a retention period, from either store', async () => {
    const fixture = await createFixtureOpsPort().loadSettings();
    expect(fixture.retention.submissionPiiDays).toBeNull();

    const stored = await live.loadSettings();
    const row = await console_.sql.query<{ retention_policy: Record<string, number | null> }>(
      `select retention_policy from public.workspace_settings`,
    );
    expect(stored.retention.submissionPiiDays).toBe(
      row.rows[0].retention_policy.submissionPiiDays ?? null,
    );
    expect(stored.featureFlags).toHaveLength(5);
  });
});
