import { beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@am/config';
import { buildDemoSessionCookie, decodeDemoSession, encodeDemoSession } from './session';

const SECRET = 'test-tracking-secret-value-at-least-32-chars';

beforeEach(() => {
  process.env.TRACKING_SIGNING_SECRET = SECRET;
  resetConfigCache();
});

const payload = () => ({
  email: 'max@am-beratung.de',
  name: 'Max Mustermann',
  roles: ['MARKETING_LEAD' as const],
  exp: Math.floor(Date.now() / 1000) + 3600,
});

describe('demo session token', () => {
  it('round-trips', () => {
    const decoded = decodeDemoSession(encodeDemoSession(payload()));
    expect(decoded?.email).toBe('max@am-beratung.de');
    expect(decoded?.roles).toEqual(['MARKETING_LEAD']);
  });

  it('rejects a tampered payload', () => {
    const token = encodeDemoSession(payload());
    const [body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...payload(), roles: ['ADMIN'] }),
      'utf8',
    ).toString('base64url');
    expect(body).not.toBe(forged);
    expect(decodeDemoSession(`${forged}.${signature}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = encodeDemoSession(payload());
    const body = token.slice(0, token.lastIndexOf('.'));
    expect(decodeDemoSession(`${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = encodeDemoSession({ ...payload(), exp: Math.floor(Date.now() / 1000) - 10 });
    expect(decodeDemoSession(expired)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = encodeDemoSession(payload());
    process.env.TRACKING_SIGNING_SECRET = 'a-completely-different-secret-value-32ch';
    resetConfigCache();
    expect(decodeDemoSession(token)).toBeNull();
  });

  it('rejects a token carrying no recognised role', () => {
    const token = encodeDemoSession({ ...payload(), roles: ['SUPERUSER'] as never });
    expect(decodeDemoSession(token)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(decodeDemoSession(undefined)).toBeNull();
    expect(decodeDemoSession('')).toBeNull();
    expect(decodeDemoSession('nodot')).toBeNull();
    expect(decodeDemoSession('!!!.!!!')).toBeNull();
  });
});

describe('demo session cookie', () => {
  it('is http-only, lax and scoped to the whole app', () => {
    const cookie = buildDemoSessionCookie('max@am-beratung.de', 'Max', ['ADMIN']);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe('lax');
    expect(cookie.options.path).toBe('/');
    expect(cookie.options.maxAge).toBeGreaterThan(0);
    expect(decodeDemoSession(cookie.value)?.roles).toEqual(['ADMIN']);
  });
});
