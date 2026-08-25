import { describe, expect, it } from 'vitest';
import { findPiiViolations, isForbiddenEventKey, redact } from './index';

/**
 * Regression suite for the PII guard.
 *
 * Every case here is a bypass an adversarial review actually found against the
 * first implementation. They are grouped by the mistake that let them through:
 * exact-key matching, an international-only phone pattern, and scanning strings
 * but not numbers.
 */

describe('forbidden key matching', () => {
  it('catches the variants an exact-match list misses', () => {
    for (const key of [
      'email',
      'email_address',
      'emailAddress',
      'contact_email',
      'e-mail',
      'phone',
      'phone_number',
      'phoneNumber',
      'telefonnummer',
      'first_name',
      'firstName',
      'vorname',
      'answers',
      'antworten',
    ]) {
      expect(isForbiddenEventKey(key), key).toBe(true);
    }
  });

  it('leaves legitimate event keys alone', () => {
    for (const key of [
      'campaign_id',
      'utm_source',
      'step_id',
      'field_id',
      'error_code',
      'consent_status',
      'viewport_bucket',
      'experiment_arm_id',
    ]) {
      expect(isForbiddenEventKey(key), key).toBe(false);
    }
  });
});

describe('phone detection', () => {
  it('catches the German national format a visitor actually types', () => {
    // The original pattern required a leading + or 00, so it caught the rare
    // case and missed the common one.
    for (const value of ['0151 23456789', '01512345678', '030/12345678', '0151-234-56789']) {
      expect(findPiiViolations({ metadata: { v: value } }), value).not.toEqual([]);
    }
  });

  it('still catches international formats', () => {
    for (const value of ['+49 151 23456789', '0049 151 23456789', '+1 (415) 555-0132']) {
      expect(findPiiViolations({ metadata: { v: value } }), value).not.toEqual([]);
    }
  });

  it('catches a phone number that arrived as a number rather than a string', () => {
    expect(findPiiViolations({ metadata: { v: 4915123456789 } })).not.toEqual([]);
  });

  it('does not fire on ordinary numeric metadata', () => {
    expect(findPiiViolations({ metadata: { step: 3, elapsed: 42, width: 375 } })).toEqual([]);
  });

  it('does not fire on identifiers or timestamps', () => {
    expect(
      findPiiViolations({
        visitor_id: '00123456-7890-4abc-8def-000111222333',
        occurred_at: '2026-03-01T10:00:00.000Z',
        meta_campaign_id: '120210000000000000',
      }),
    ).toEqual([]);
  });
});

describe('email detection', () => {
  it('sees through percent-encoding, which arrives from query strings routinely', () => {
    expect(findPiiViolations({ metadata: { v: 'max%40example.de' } })).not.toEqual([]);
  });

  it('catches an address hidden in a landing URL', () => {
    expect(
      findPiiViolations({ landing_url: 'https://go.am-beratung.de/f/x?e=max@example.de' }),
    ).not.toEqual([]);
  });
});

describe('redact', () => {
  it('redacts key variants, not just exact matches', () => {
    const result = redact({
      email: 'a@b.de',
      phone_number: '+4915112345678',
      nested: { emailAddress: 'c@d.de', contact_phone: '0151 23456789' },
      access_token: 'abc',
      answers: { q1: 'ja' },
    });

    expect(result).toEqual({
      email: '[redacted]',
      phone_number: '[redacted]',
      nested: { emailAddress: '[redacted]', contact_phone: '[redacted]' },
      access_token: '[redacted]',
      answers: '[redacted]',
    });
  });

  it('redacts contact data inside a value whose key looks innocent', () => {
    const result = redact({
      landing_url: 'https://x.de/?e=max@example.de',
      note: 'Rückruf unter 0151 23456789 erbeten',
    });

    expect(result.landing_url).not.toContain('max@example.de');
    expect(result.note).not.toContain('23456789');
  });

  it('keeps the surrounding value readable rather than nuking it', () => {
    // A log line people stop reading is a log line that protects nobody.
    const result = redact({ landing_url: 'https://x.de/?e=max@example.de&utm_source=facebook' });
    expect(result.landing_url).toContain('https://x.de/');
    expect(result.landing_url).toContain('utm_source=facebook');
  });

  it('leaves ordinary values untouched', () => {
    const payload = {
      campaign_id: '11111111-1111-4111-8111-111111111111',
      state: 'LIVE',
      spend_minor: 123456,
      utm_source: 'facebook',
    };
    expect(redact(payload)).toEqual(payload);
  });

  it('walks arrays', () => {
    expect(redact({ list: [{ phoneNumber: '+4915112345678' }] })).toEqual({
      list: [{ phoneNumber: '[redacted]' }],
    });
  });
});
