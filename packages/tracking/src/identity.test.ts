import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSessionCookie,
  buildVisitorCookie,
  classifyTraffic,
  INTERNAL_COOKIE,
  isBotUserAgent,
  isProductionTraffic,
  parseVisitorCookie,
  PREVIEW_COOKIE,
  resolveVisitor,
  SESSION_COOKIE,
  SESSION_IDLE_MINUTES,
  TEST_COOKIE,
  VISITOR_COOKIE,
} from './identity';

const CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const NOW = new Date('2026-03-01T10:00:00.000Z');

function cookieHeaderFrom(setCookies: readonly string[]): string {
  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('cookies', () => {
  it('sets first-party attributes', () => {
    const cookie = buildVisitorCookie(randomUUID());
    expect(cookie).toContain(`${VISITOR_COOKIE}=`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
  });

  it('scopes the session cookie to the idle window', () => {
    const cookie = buildSessionCookie({
      sessionId: randomUUID(),
      startedAt: NOW.getTime(),
      lastSeenAt: NOW.getTime(),
    });
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain(`Max-Age=${SESSION_IDLE_MINUTES * 60}`);
  });

  it('allows an insecure cookie only when explicitly asked', () => {
    expect(buildVisitorCookie(randomUUID(), { secure: false })).not.toContain('Secure');
  });

  it('ignores a malformed visitor cookie instead of trusting it', () => {
    expect(parseVisitorCookie('am_vid=not-a-uuid; am_sid=garbage').visitorId).toBeNull();
    expect(parseVisitorCookie('am_vid=not-a-uuid; am_sid=garbage').session).toBeNull();
    expect(parseVisitorCookie(null).visitorId).toBeNull();
  });
});

describe('resolveVisitor', () => {
  it('mints a visitor and a session on the first request', () => {
    const resolved = resolveVisitor({ cookieHeader: null, now: NOW });
    expect(resolved.isNew).toBe(true);
    expect(resolved.isNewSession).toBe(true);
    expect(resolved.setCookies).toHaveLength(2);
    expect(resolved.visitorId).not.toBe(resolved.sessionId);
  });

  it('keeps the visitor and the session on a request inside the idle window', () => {
    const first = resolveVisitor({ cookieHeader: null, now: NOW });
    const later = resolveVisitor({
      cookieHeader: cookieHeaderFrom(first.setCookies),
      now: new Date(NOW.getTime() + 29 * 60_000),
    });

    expect(later.visitorId).toBe(first.visitorId);
    expect(later.sessionId).toBe(first.sessionId);
    expect(later.isNew).toBe(false);
    expect(later.isNewSession).toBe(false);
    expect(later.session.startedAt).toBe(first.session.startedAt);
  });

  it('slides the window: activity extends the session past 30 minutes total', () => {
    const first = resolveVisitor({ cookieHeader: null, now: NOW });
    const middle = resolveVisitor({
      cookieHeader: cookieHeaderFrom(first.setCookies),
      now: new Date(NOW.getTime() + 25 * 60_000),
    });
    const last = resolveVisitor({
      cookieHeader: cookieHeaderFrom(middle.setCookies),
      now: new Date(NOW.getTime() + 50 * 60_000),
    });

    expect(last.sessionId).toBe(first.sessionId);
    expect(last.isNewSession).toBe(false);
  });

  it('starts a new session after 30 minutes of inactivity but keeps the visitor', () => {
    const first = resolveVisitor({ cookieHeader: null, now: NOW });
    const later = resolveVisitor({
      cookieHeader: cookieHeaderFrom(first.setCookies),
      now: new Date(NOW.getTime() + 30 * 60_000),
    });

    expect(later.visitorId).toBe(first.visitorId);
    expect(later.sessionId).not.toBe(first.sessionId);
    expect(later.isNew).toBe(false);
    expect(later.isNewSession).toBe(true);
  });
});

describe('classifyTraffic', () => {
  it('classifies a real browser as production', () => {
    expect(classifyTraffic({ userAgent: CHROME_UA, host: 'funnel.example.com' })).toBe(
      'PRODUCTION',
    );
    expect(isProductionTraffic('PRODUCTION')).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  ])('classifies %s as BOT', (userAgent) => {
    expect(isBotUserAgent(userAgent)).toBe(true);
    expect(classifyTraffic({ userAgent })).toBe('BOT');
  });

  it('treats a missing user agent as a bot rather than as production', () => {
    expect(classifyTraffic({ userAgent: null })).toBe('BOT');
  });

  it('detects automation behind a spoofed user agent', () => {
    expect(classifyTraffic({ userAgent: CHROME_UA, headless: { webdriver: true } })).toBe('BOT');
    expect(
      classifyTraffic({
        userAgent: CHROME_UA,
        headless: { hasSecFetchHeaders: false, hasAcceptLanguage: false },
      }),
    ).toBe('BOT');
  });

  it('keeps preview, internal and test traffic out of production', () => {
    expect(classifyTraffic({ userAgent: CHROME_UA, isPreview: true })).toBe('PREVIEW');
    expect(classifyTraffic({ userAgent: CHROME_UA, host: 'am-funnels-abc.vercel.app' })).toBe(
      'PREVIEW',
    );
    expect(
      classifyTraffic({ userAgent: CHROME_UA, cookieHeader: `${PREVIEW_COOKIE}=1` }),
    ).toBe('PREVIEW');
    expect(classifyTraffic({ userAgent: CHROME_UA, isInternal: true })).toBe('INTERNAL');
    expect(
      classifyTraffic({ userAgent: CHROME_UA, cookieHeader: `${INTERNAL_COOKIE}=1` }),
    ).toBe('INTERNAL');
    expect(classifyTraffic({ userAgent: CHROME_UA, cookieHeader: `${TEST_COOKIE}=1` })).toBe(
      'TEST',
    );

    for (const kind of ['PREVIEW', 'INTERNAL', 'TEST', 'BOT'] as const) {
      expect(isProductionTraffic(kind)).toBe(false);
    }
  });

  it('classifies a crawler on a preview deployment as a bot', () => {
    expect(
      classifyTraffic({
        userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
        isPreview: true,
      }),
    ).toBe('BOT');
  });
});
