import { describe, expect, it } from 'vitest';
import {
  CLIENT_EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
  SERVER_EVENT_TYPES,
  VALIDATION_MESSAGES_DE,
  assertNoPii,
  findPiiViolations,
  trackingEventSchema,
} from './index';

const baseEvent = {
  event_id: '11111111-1111-4111-8111-111111111111',
  event_type: 'form_step_completed' as const,
  event_schema_version: EVENT_SCHEMA_VERSION,
  occurred_at: '2026-03-01T10:00:00.000Z',
  environment: 'production' as const,
  visitor_id: '22222222-2222-4222-8222-222222222222',
  session_id: '33333333-3333-4333-8333-333333333333',
};

describe('tracking event schema', () => {
  it('accepts a minimal valid event and fills nullable defaults', () => {
    const parsed = trackingEventSchema.parse(baseEvent);
    expect(parsed.campaign_id).toBeNull();
    expect(parsed.consent_status).toBe('UNKNOWN');
    expect(parsed.traffic_kind).toBe('PRODUCTION');
    expect(parsed.metadata).toEqual({});
  });

  it('rejects an unknown event type', () => {
    const result = trackingEventSchema.safeParse({ ...baseEvent, event_type: 'form_hacked' });
    expect(result.success).toBe(false);
  });

  it('rejects a step id that is not a spec key', () => {
    const result = trackingEventSchema.safeParse({ ...baseEvent, step_id: 'Not A Key!' });
    expect(result.success).toBe(false);
  });

  it('keeps form_abandoned out of the client-emittable set', () => {
    expect(CLIENT_EVENT_TYPES).not.toContain('form_abandoned');
    expect(SERVER_EVENT_TYPES).toContain('form_abandoned');
  });

  it('has a German message for every validation error code', () => {
    for (const [code, message] of Object.entries(VALIDATION_MESSAGES_DE)) {
      expect(message.length, code).toBeGreaterThan(5);
    }
  });
});

describe('PII guard', () => {
  it('flags a forbidden key', () => {
    const violations = findPiiViolations({ ...baseEvent, email: 'x' });
    expect(violations.join(' ')).toContain('email');
  });

  it('flags an e-mail address hiding in a free-text value', () => {
    const violations = findPiiViolations({
      ...baseEvent,
      metadata: { note: 'kontakt max.mustermann@example.de bitte' },
    });
    expect(violations.join(' ')).toContain('E-Mail-Muster');
  });

  it('flags a phone number pattern', () => {
    const violations = findPiiViolations({ metadata: { v: '+49 170 1234567' } });
    expect(violations.join(' ')).toContain('Telefonnummer-Muster');
  });

  it('flags PII nested inside arrays', () => {
    const violations = findPiiViolations({ items: [{ ok: 1 }, { vorname: 'Max' }] });
    expect(violations.join(' ')).toContain('vorname');
  });

  it('flags a full answer set', () => {
    expect(findPiiViolations({ answers: { q1: 'a' } }).length).toBeGreaterThan(0);
  });

  it('passes a clean validation-failure event', () => {
    const event = {
      ...baseEvent,
      event_type: 'form_validation_failed' as const,
      field_id: 'postcode',
      error_code: 'INVALID_POSTCODE' as const,
    };
    expect(findPiiViolations(event)).toEqual([]);
    expect(() => assertNoPii(event)).not.toThrow();
    expect(trackingEventSchema.safeParse(event).success).toBe(true);
  });

  it('throws with a German message when asserting a dirty payload', () => {
    expect(() => assertNoPii({ email: 'a@b.de' })).toThrow(/personenbezogene Daten/);
  });

  it('does not mistake a UUID for a phone number', () => {
    // `00123456-7890-…` trips a naive phone heuristic. A guard that rejects
    // valid events is a guard that gets switched off.
    expect(
      findPiiViolations({
        ...baseEvent,
        visitor_id: '00123456-7890-4abc-8def-000111222333',
        campaign_id: '00998877-6655-4444-8333-222111000999',
      }),
    ).toEqual([]);
  });

  it('does not flag ISO timestamps', () => {
    expect(findPiiViolations({ occurred_at: '2026-03-01T10:00:00.000Z' })).toEqual([]);
  });

  it('still flags a real German number written with separators', () => {
    expect(findPiiViolations({ metadata: { v: '0049 (0) 170 123-4567' } }).length).toBeGreaterThan(
      0,
    );
  });

  it('does not flag a short numeric code', () => {
    expect(findPiiViolations({ metadata: { v: '+49 12' } })).toEqual([]);
  });

  it('does not flag ordinary marketing parameters', () => {
    expect(
      findPiiViolations({
        utm_source: 'facebook',
        utm_campaign: 'potenzialanalyse-q1',
        fbclid: 'IwAR0abcdef',
      }),
    ).toEqual([]);
  });
});
