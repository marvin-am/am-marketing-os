/**
 * Contract tests for the setup-wizard probes, against the fixture provider.
 * No network.
 */
import { describe, expect, it } from 'vitest';
import { HEALTH_STATUS_LABELS_DE, SAFE_DEFAULT_FLAGS } from '@am/domain';
import {
  FIXTURE_AD_ACCOUNT_ID,
  FIXTURE_DATASET_ID,
  FIXTURE_INSTAGRAM_ACTOR_ID,
  FIXTURE_PAGE_ID,
  FIXTURE_PIXEL_ID,
  FixtureMetaProvider,
  META_HEALTH_KEYS,
  type MetaCredentials,
  REQUIRED_META_SCOPES,
  runMetaHealthChecks,
} from '../src/index';

const NOW = '2026-06-30T10:00:00.000Z';

const CONFIGURED: MetaCredentials = {
  appId: '1122334455',
  accessToken: 'fixture-token',
  capiAccessToken: null,
  businessId: '210946325118804',
  adAccountId: FIXTURE_AD_ACCOUNT_ID,
  pageId: FIXTURE_PAGE_ID,
  instagramActorId: FIXTURE_INSTAGRAM_ACTOR_ID,
  pixelId: FIXTURE_PIXEL_ID,
  datasetId: FIXTURE_DATASET_ID,
  apiVersion: 'v23.0',
};

const UNCONFIGURED: MetaCredentials = {
  appId: null,
  accessToken: null,
  capiAccessToken: null,
  businessId: null,
  adAccountId: null,
  pageId: null,
  instagramActorId: null,
  pixelId: null,
  datasetId: null,
  apiVersion: 'v23.0',
};

/* -------------------------------------------------------------------------- */

describe('the fixture provider never claims a connection', () => {
  it('reports state FIXTURE from the provider itself', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await provider.health();

    expect(health.state).toBe('FIXTURE');
    expect(health.provider).toBe('META');
    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.every((check) => check.status === 'AWAITING_EXTERNAL_INPUT')).toBe(true);
    for (const check of health.checks) {
      expect(check.detailDe).toContain('Fixture-Modus');
      expect(check.remediationDe).toBeTruthy();
    }
  });

  it('stays FIXTURE in the composite wizard even with every credential present', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: CONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    expect(health.state).toBe('FIXTURE');
    expect(health.checks.map((check) => check.key)).toEqual([...META_HEALTH_KEYS]);
    expect(health.checkedAt).toBe(NOW);
  });
});

/* -------------------------------------------------------------------------- */

describe('missing credentials are awaiting input, not failures', () => {
  it('never reports FAIL when nothing is configured', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: UNCONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(HEALTH_STATUS_LABELS_DE[health.overall]).toBe('Wartet auf externen Input');
    expect(health.checks.some((check) => check.status === 'FAIL')).toBe(false);

    const awaiting = health.checks.filter(
      (check) => check.status === 'AWAITING_EXTERNAL_INPUT',
    );
    expect(awaiting.length).toBeGreaterThanOrEqual(6);
    for (const check of awaiting) {
      expect(check.remediationDe).toBeTruthy();
      expect(check.labelDe.length).toBeGreaterThan(0);
    }
  });

  it('names the scopes it needs instead of pretending they were granted', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: UNCONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    const permissions = health.checks.find((check) => check.key === 'meta.permissions');
    expect(permissions?.status).toBe('AWAITING_EXTERNAL_INPUT');
    for (const scope of REQUIRED_META_SCOPES) {
      expect(permissions?.detailDe).toContain(scope);
    }
  });

  it('carries a German label and remediation on every check', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: UNCONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    for (const check of health.checks) {
      expect(check.labelDe).toMatch(/[A-Za-zÄÖÜäöüß]/);
      expect(check.detailDe).toBeTruthy();
      if (check.status !== 'PASS') expect(check.remediationDe).toBeTruthy();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the wizard reports what it can actually do', () => {
  it('validates the paused draft plan without creating anything', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: CONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    const draft = health.checks.find((check) => check.key === 'meta.draft_test');
    expect(draft?.status).toBe('AWAITING_EXTERNAL_INPUT');
    expect(draft?.detailDe).toContain('alle Objekte pausiert');
    expect(draft?.detailDe).toContain('nichts angelegt');
    expect(draft?.blocksLiveOnly).toBe(true);
    expect(await provider.findDraftByIdempotencyKey('healthcheck-2026-06-30')).toBeNull();
  });

  it('proves the pixel and server events would deduplicate, without sending', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: CONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    const capi = health.checks.find((check) => check.key === 'meta.capi_test');
    expect(capi?.detailDe).toContain('Deduplizierung möglich');
    expect(capi?.detailDe).toContain('nichts gesendet');
    expect(capi?.detailDe).toContain('sha256:');
    // The redacted preview must not leak the test address.
    expect(capi?.detailDe).not.toContain('health.check@example.de');
    expect(provider.dispatchedCapiBatches()).toHaveLength(0);
  });

  it('reads insights as part of the wizard', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const health = await runMetaHealthChecks({
      provider,
      credentials: CONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    const insights = health.checks.find((check) => check.key === 'meta.insights_read');
    expect(insights?.status).toBe('PASS');
    expect(insights?.detailDe).toContain('Zeile(n)');
  });
});

/* -------------------------------------------------------------------------- */

describe('a real failure is never masked by an awaiting status', () => {
  it('rolls up to FAIL when the provider denies access', async () => {
    const provider = new FixtureMetaProvider({
      flags: SAFE_DEFAULT_FLAGS,
      simulatePermissionError: true,
    });
    const health = await runMetaHealthChecks({
      provider,
      credentials: CONFIGURED,
      flags: SAFE_DEFAULT_FLAGS,
      now: NOW,
    });

    expect(health.overall).toBe('FAIL');
    // The connection state still says FIXTURE — no connection was ever made.
    expect(health.state).toBe('FIXTURE');

    const failing = health.checks.filter((check) => check.status === 'FAIL');
    expect(failing.length).toBeGreaterThan(0);
    for (const check of failing) {
      expect(check.detailDe).toContain('Berechtigungen');
      expect(check.remediationDe).toBeTruthy();
    }
  });
});
