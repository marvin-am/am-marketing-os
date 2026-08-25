import { describe, expect, it } from 'vitest';
import { DomainError } from '@am/domain';
import {
  ROLE_DESCRIPTIONS_DE,
  ROLE_LABELS_DE,
  type SessionUser,
  can,
  requirePermission,
  rolesWithPermission,
} from './permissions';

const user = (roles: SessionUser['roles']): SessionUser => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'max@am-beratung.de',
  displayName: 'Max Mustermann',
  roles,
  workspaceId: '22222222-2222-4222-8222-222222222222',
});

describe('can', () => {
  it('denies an unauthenticated caller', () => {
    expect(can(null, 'campaign.read')).toBe(false);
  });

  it('grants what the role matrix grants', () => {
    expect(can(user(['MARKETING_LEAD']), 'campaign.publish')).toBe(true);
    expect(can(user(['MARKETING_OPERATOR']), 'campaign.publish')).toBe(false);
  });
});

describe('requirePermission', () => {
  it('throws UNAUTHENTICATED with no user', () => {
    try {
      requirePermission(null, 'campaign.read');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('throws FORBIDDEN with a German message naming the permission', () => {
    try {
      requirePermission(user(['VIEWER']), 'campaign.publish');
      expect.unreachable('should have thrown');
    } catch (error) {
      const domainError = error as DomainError;
      expect(domainError.code).toBe('FORBIDDEN');
      expect(domainError.messageDe).toContain('campaign.publish');
      expect(domainError.messageDe).toMatch(/Rolle/);
    }
  });

  it('returns the user when authorised', () => {
    const authorized = requirePermission(user(['ADMIN']), 'settings.manage');
    expect(authorized.email).toBe('max@am-beratung.de');
  });
});

describe('rolesWithPermission', () => {
  it('names who can approve a major budget change', () => {
    const roles = rolesWithPermission('campaign.scale_budget_major');
    expect(roles).toContain('EXECUTIVE');
    expect(roles).toContain('ADMIN');
    expect(roles).not.toContain('MARKETING_LEAD');
  });

  it('never suggests VIEWER as a remedy', () => {
    expect(rolesWithPermission('campaign.read')).not.toContain('VIEWER');
  });
});

describe('role copy', () => {
  it('has a German label and description for every role', () => {
    for (const role of Object.keys(ROLE_LABELS_DE) as Array<keyof typeof ROLE_LABELS_DE>) {
      expect(ROLE_LABELS_DE[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS_DE[role].length).toBeGreaterThan(10);
    }
  });
});
