import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PERMISSIONS,
  DEFAULT_ROLE_BUDGET_LIMITS,
  LIVE_ONLY_CHECKS,
  LAUNCH_CHECK_KEYS,
  LAUNCH_CHECK_LABELS_DE,
  ROLE_PERMISSIONS,
  type Approval,
  type LaunchCheckResult,
  approvalsInvalidatedBy,
  canDispatchCapi,
  canWriteHubspot,
  canWriteMeta,
  canonicalize,
  dryRun,
  hasPermission,
  isApprovalValid,
  permissionsFor,
  redact,
  rollUpHealth,
  summarizeLaunchQa,
} from './index';

describe('role permissions', () => {
  it('gives VIEWER read access and nothing more', () => {
    expect(hasPermission(['VIEWER'], 'campaign.read')).toBe(true);
    expect(hasPermission(['VIEWER'], 'campaign.publish')).toBe(false);
    expect(hasPermission(['VIEWER'], 'campaign.scale_budget')).toBe(false);
  });

  it('does not let a marketing operator publish or approve', () => {
    expect(hasPermission(['MARKETING_OPERATOR'], 'campaign.edit')).toBe(true);
    expect(hasPermission(['MARKETING_OPERATOR'], 'campaign.publish')).toBe(false);
    expect(hasPermission(['MARKETING_OPERATOR'], 'campaign.approve_strategy')).toBe(false);
  });

  it('reserves major budget changes for executives and admins', () => {
    expect(hasPermission(['MARKETING_LEAD'], 'campaign.scale_budget')).toBe(true);
    expect(hasPermission(['MARKETING_LEAD'], 'campaign.scale_budget_major')).toBe(false);
    expect(hasPermission(['EXECUTIVE'], 'campaign.scale_budget_major')).toBe(true);
    expect(hasPermission(['ADMIN'], 'campaign.scale_budget_major')).toBe(true);
  });

  it('keeps CRM mapping with RevOps and admins only', () => {
    expect(hasPermission(['REVOPS'], 'crm.mapping.manage')).toBe(true);
    expect(hasPermission(['MARKETING_LEAD'], 'crm.mapping.manage')).toBe(false);
  });

  it('unions permissions across multiple roles', () => {
    const combined = permissionsFor(['MARKETING_OPERATOR', 'CREATIVE_REVIEWER']);
    expect(combined).toContain('campaign.edit');
    expect(combined).toContain('creative.approve');
    expect(new Set(combined).size).toBe(combined.length);
  });

  it('gives ADMIN every permission', () => {
    expect(ROLE_PERMISSIONS.ADMIN.length).toBeGreaterThan(20);
  });

  it('maps every approval kind to a permission that some role holds', () => {
    for (const [kind, permission] of Object.entries(APPROVAL_PERMISSIONS)) {
      const holders = Object.entries(ROLE_PERMISSIONS).filter(([, perms]) =>
        perms.includes(permission),
      );
      expect(holders.length, `${kind} has no holder`).toBeGreaterThan(0);
    }
  });
});

describe('budget limits', () => {
  it('gives no scale authority to operators or viewers', () => {
    expect(DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_OPERATOR.maxSingleIncreasePct).toBe(0);
    expect(DEFAULT_ROLE_BUDGET_LIMITS.VIEWER.maxScalesPer24h).toBe(0);
  });

  it('caps a marketing lead at +20 % and one scale per day', () => {
    expect(DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD.maxSingleIncreasePct).toBeCloseTo(0.2);
    expect(DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD.maxScalesPer24h).toBe(1);
  });

  it('gives executives more headroom than leads', () => {
    expect(DEFAULT_ROLE_BUDGET_LIMITS.EXECUTIVE.maxDailyBudgetMinor).toBeGreaterThan(
      DEFAULT_ROLE_BUDGET_LIMITS.MARKETING_LEAD.maxDailyBudgetMinor,
    );
  });
});

describe('approval invalidation', () => {
  const approval = (hash: string): Approval => ({
    id: '11111111-1111-4111-8111-111111111111',
    campaign_id: '22222222-2222-4222-8222-222222222222',
    kind: 'STRATEGY',
    state: 'APPROVED',
    approved_content_hash: hash,
    approved_by: '33333333-3333-4333-8333-333333333333',
    approved_at: '2026-03-01T10:00:00.000Z',
    rejected_reason_de: null,
    invalidated_at: null,
    invalidated_reason_de: null,
    created_at: '2026-03-01T09:00:00.000Z',
  });

  it('holds while the content hash matches', () => {
    expect(isApprovalValid(approval('abc'), 'abc')).toBe(true);
  });

  it('lapses as soon as the content changes', () => {
    expect(isApprovalValid(approval('abc'), 'def')).toBe(false);
  });

  it('lapses once explicitly invalidated', () => {
    const invalidated = { ...approval('abc'), invalidated_at: '2026-03-02T10:00:00.000Z' };
    expect(isApprovalValid(invalidated, 'abc')).toBe(false);
  });

  it('cascades a claim change to the asset and publish approvals', () => {
    const affected = approvalsInvalidatedBy('claims');
    expect(affected).toContain('STRATEGY');
    expect(affected).toContain('ASSETS');
    expect(affected).toContain('PUBLISH');
  });

  it('does not invalidate the test plan when only a creative changes', () => {
    expect(approvalsInvalidatedBy('creative')).not.toContain('TEST_PLAN');
  });

  it('returns nothing for an unknown content area', () => {
    expect(approvalsInvalidatedBy('unrelated')).toEqual([]);
  });
});

describe('canonicalize', () => {
  it('is stable across property order', () => {
    expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalize({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('distinguishes a real content change', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });

  it('preserves array order, which is content', () => {
    expect(canonicalize({ a: [1, 2] })).not.toBe(canonicalize({ a: [2, 1] }));
  });

  it('treats undefined and missing alike', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe('feature flags', () => {
  const flags = (over: Partial<Record<string, boolean>> = {}) => ({
    demoMode: false,
    externalWritesEnabled: false,
    metaMutationsEnabled: false,
    metaCapiEnabled: false,
    hubspotWritesEnabled: false,
    ...over,
  });

  it('blocks every write while the master switch is off', () => {
    const f = flags({ metaMutationsEnabled: true, metaCapiEnabled: true, hubspotWritesEnabled: true });
    expect(canWriteMeta(f)).toBe(false);
    expect(canDispatchCapi(f)).toBe(false);
    expect(canWriteHubspot(f)).toBe(false);
  });

  it('still requires the specific flag once the master switch is on', () => {
    const f = flags({ externalWritesEnabled: true });
    expect(canWriteMeta(f)).toBe(false);
    expect(canWriteMeta({ ...f, metaMutationsEnabled: true })).toBe(true);
  });

  it('produces a dry run that cannot be mistaken for success', () => {
    const result = dryRun('META', 'createPausedDraft', { name: 'X' });
    expect(result.dryRun).toBe(true);
    expect(result.blockedByDe).toMatch(/deaktiviert/);
  });
});

describe('launch QA', () => {
  const check = (
    key: (typeof LAUNCH_CHECK_KEYS)[number],
    status: LaunchCheckResult['status'],
  ): LaunchCheckResult => ({
    key,
    labelDe: LAUNCH_CHECK_LABELS_DE[key],
    status,
    detailDe: null,
    remediationDe: null,
    blocksLiveOnly: LIVE_ONLY_CHECKS.includes(key),
    href: null,
  });

  const allPassing = LAUNCH_CHECK_KEYS.map((key) => check(key, 'PASS'));

  it('has a German label for every check', () => {
    for (const key of LAUNCH_CHECK_KEYS) {
      expect(LAUNCH_CHECK_LABELS_DE[key]).toBeTruthy();
    }
  });

  it('allows both a draft and a launch when everything passes', () => {
    const report = summarizeLaunchQa('c1', allPassing, '2026-03-01T10:00:00.000Z');
    expect(report.canCreateMetaDraft).toBe(true);
    expect(report.canGoLive).toBe(true);
  });

  it('lets the paused draft proceed while only external input is missing', () => {
    const checks = allPassing.map((c) =>
      c.key === 'hubspot_test_lead_successful' ? { ...c, status: 'AWAITING_EXTERNAL_INPUT' as const } : c,
    );
    const report = summarizeLaunchQa('c1', checks, '2026-03-01T10:00:00.000Z');
    expect(report.canCreateMetaDraft).toBe(true);
    expect(report.canGoLive).toBe(false);
    expect(report.awaitingExternalDe.length).toBe(1);
  });

  it('blocks the draft when a product-side check is merely waiting', () => {
    const checks = allPassing.map((c) =>
      c.key === 'creatives_approved' ? { ...c, status: 'AWAITING_EXTERNAL_INPUT' as const } : c,
    );
    expect(summarizeLaunchQa('c1', checks, '2026-03-01T10:00:00.000Z').canCreateMetaDraft).toBe(false);
  });

  it('blocks everything on a real failure, even a live-only one', () => {
    const checks = allPassing.map((c) =>
      c.key === 'meta_permissions_valid' ? { ...c, status: 'FAIL' as const } : c,
    );
    const report = summarizeLaunchQa('c1', checks, '2026-03-01T10:00:00.000Z');
    expect(report.canCreateMetaDraft).toBe(false);
    expect(report.canGoLive).toBe(false);
    expect(report.blockingDe).toContain(LAUNCH_CHECK_LABELS_DE.meta_permissions_valid);
  });
});

describe('health roll-up', () => {
  const at = '2026-03-01T10:00:00.000Z';
  const probe = (status: 'PASS' | 'WARN' | 'FAIL' | 'AWAITING_EXTERNAL_INPUT') => ({
    key: 'k',
    labelDe: 'L',
    status,
    detailDe: null,
    checkedAt: at,
    remediationDe: null,
    blocksLiveOnly: false,
  });

  it('reports awaiting-input for an empty probe set rather than pass', () => {
    expect(rollUpHealth([])).toBe('AWAITING_EXTERNAL_INPUT');
  });

  it('never lets awaiting-input mask a real failure', () => {
    expect(rollUpHealth([probe('AWAITING_EXTERNAL_INPUT'), probe('FAIL')])).toBe('FAIL');
  });

  it('prefers awaiting-input over a warning', () => {
    expect(rollUpHealth([probe('WARN'), probe('AWAITING_EXTERNAL_INPUT')])).toBe(
      'AWAITING_EXTERNAL_INPUT',
    );
  });

  it('passes only when everything passes', () => {
    expect(rollUpHealth([probe('PASS'), probe('PASS')])).toBe('PASS');
  });
});

describe('redaction', () => {
  it('replaces sensitive values but keeps the shape', () => {
    const result = redact({
      contact: { email: 'a@b.de', first_name: 'Max', role: 'CEO' },
      access_token: 'secret',
      count: 3,
    });
    expect(result).toEqual({
      contact: { email: '[redacted]', first_name: '[redacted]', role: 'CEO' },
      access_token: '[redacted]',
      count: 3,
    });
  });

  it('walks arrays', () => {
    expect(redact({ list: [{ phone: '+4917012345' }] })).toEqual({
      list: [{ phone: '[redacted]' }],
    });
  });

  it('is case-insensitive on keys', () => {
    expect(redact({ Email: 'a@b.de' })).toEqual({ Email: '[redacted]' });
  });
});
