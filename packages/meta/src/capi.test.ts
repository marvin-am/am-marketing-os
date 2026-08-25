import { describe, expect, it } from 'vitest';
import { DomainError, money } from '@am/domain';
import {
  CAPI_MAX_EVENT_AGE_DAYS,
  CAPI_OFFLINE_MAX_EVENT_AGE_DAYS,
  CAPI_STAGE_EVENT_NAMES,
  assertEventTimeAcceptable,
  assertNoSensitiveCustomData,
  assertServerSideValidated,
  buildInitialLeadEvent,
  buildPixelPayload,
  buildServerEvent,
  buildStageEvent,
  buildUserData,
  capiPayloadHash,
  createInMemoryConvertedLedger,
  deriveFbc,
  initialLeadEventId,
  isOncePerOpportunity,
  maxAgeDaysFor,
  normalizeCityForMeta,
  normalizeCountryForMeta,
  normalizeEmailForMeta,
  normalizeNameForMeta,
  normalizePhoneForMeta,
  normalizeZipForMeta,
  prepareConvertedEvent,
  redactCapiPayload,
  stageEventId,
  stageForSalesEvent,
  toUnixSeconds,
  willDeduplicate,
} from './capi';

const NOW = '2026-06-30T12:00:00.000Z';
const SUBMISSION_ID = '3f6c0a1e-6bd3-4a1f-9c2f-1a9b0c6d7e81';
const FORM_INSTANCE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

function leadInput(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: SUBMISSION_ID,
    pixelId: '1180347629945512',
    occurredAt: NOW,
    eventSourceUrl: 'https://funnel.am-beratung.de/potenzialanalyse?am_t=abc&utm_source=meta',
    identity: {
      email: '  Test@Example.COM ',
      phone: '+49 151 12345678',
      firstName: 'Anna',
      lastName: 'Müller',
      city: 'Frankfurt am Main',
      state: 'HE',
      postalCode: '60311',
      country: 'DE',
      externalId: 'person-42',
      fbp: 'fb.1.1750000000000.987654321',
      fbclid: 'IwAR0abcdef',
      clientIpAddress: '203.0.113.7',
      clientUserAgent: 'Mozilla/5.0 (Macintosh)',
    },
    consent: { adMeasurement: true },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('normalisation matches Meta’s rules', () => {
  it('normalises e-mail, phone, names, city, zip and country', () => {
    expect(normalizeEmailForMeta('  Test@Example.COM ')).toBe('test@example.com');
    expect(normalizePhoneForMeta('+49 151 12345678')).toBe('4915112345678');
    // A German national format must normalise onto the same string.
    expect(normalizePhoneForMeta('0151 12345678')).toBe('4915112345678');
    expect(normalizePhoneForMeta('nonsense')).toBeNull();
    expect(normalizeNameForMeta(' Anna-Lena! ')).toBe('annalena');
    expect(normalizeNameForMeta('Müller')).toBe('müller');
    expect(normalizeCityForMeta('Frankfurt am Main')).toBe('frankfurtammain');
    expect(normalizeZipForMeta('60311')).toBe('60311');
    expect(normalizeZipForMeta('90210-1234', 'us')).toBe('90210');
    expect(normalizeCountryForMeta('DE')).toBe('de');
    expect(normalizeCountryForMeta('Deutschland')).toBeNull();
  });

  it('hashes a known set of inputs to the expected SHA-256 values', async () => {
    const userData = await buildUserData(leadInput().identity, { adMeasurement: true });

    expect(userData.em).toBe(
      '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b',
    );
    expect(userData.ph).toBe(
      '8efb96404be52f6109b9db0f687274a81e9e3cc23fabd6f0da5d38baa3d2facd',
    );
    expect(userData.fn).toBe(
      '55579b557896d0ce1764c47fed644f9b35f58bad620674af23f356d80ed0c503',
    );
    expect(userData.ln).toBe(
      '2dbd218072117713f2d5996a726a9b216ed791ffd0783b6ba4ab6d61b8333192',
    );
    expect(userData.ct).toBe(
      '825051ba993e21e15aa1f6f0d63513532c76df19302521b0a339009429693b71',
    );
    expect(userData.st).toBe(
      '372f7e2fd2d01ce2a1d71dc072acbba4c6fd25a1087cd7f153f4ec0ce37e1ede',
    );
    expect(userData.zp).toBe(
      '2d359f81b29f274ed87b0f341cb128da9f5c9289b734e19b42369199bac73c85',
    );
    expect(userData.country).toBe(
      '959a45d44e6fcf58361ed004681556fe50129f2109e817dec098c00c9e5d2578',
    );
    expect(userData.external_id).toBe(
      'b4edfdd682da6ef9d08516941454ee3b18b3649ae99670c0107323ea0cd7c78e',
    );
  });

  it('never hashes fbp/fbc/ip/user agent', async () => {
    const userData = await buildUserData(leadInput().identity, { adMeasurement: true });
    expect(userData.fbp).toBe('fb.1.1750000000000.987654321');
    expect(userData.fbc).toMatch(/^fb\.1\.\d+\.IwAR0abcdef$/);
    expect(userData.client_ip_address).toBe('203.0.113.7');
    expect(userData.client_user_agent).toBe('Mozilla/5.0 (Macintosh)');
  });

  it('omits IP and user agent without consent for ad measurement', async () => {
    const userData = await buildUserData(leadInput().identity, { adMeasurement: false });
    expect(userData.client_ip_address).toBeUndefined();
    expect(userData.client_user_agent).toBeUndefined();
    // Hashed identifiers and click ids are unaffected.
    expect(userData.em).toBeDefined();
    expect(userData.fbp).toBeDefined();
  });

  it('derives fbc from fbclid in Meta’s cookie format', () => {
    expect(deriveFbc('IwAR0abcdef', 1_750_000_000_000)).toBe('fb.1.1750000000000.IwAR0abcdef');
    expect(deriveFbc(null, 1)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('initial website lead', () => {
  it('gives pixel and server event the same name and the same event_id', async () => {
    const pair = await buildInitialLeadEvent(leadInput());
    const pixel = await buildPixelPayload(leadInput());
    const server = await buildServerEvent(leadInput());

    expect(pair.pixel.eventID).toBe(pair.server.event_id);
    expect(pair.pixel.eventName).toBe(pair.server.event_name);
    expect(pair.eventName).toBe(CAPI_STAGE_EVENT_NAMES.INITIAL_LEAD);
    expect(willDeduplicate(pair.pixel, pair.server)).toBe(true);

    // The two convenience builders delegate to the same source.
    expect(pixel.eventID).toBe(server.event_id);
    expect(pixel).toEqual(pair.pixel);
    expect(server).toEqual(pair.server);
  });

  it('derives the event id from the submission, so a replay collapses onto one event', async () => {
    const first = await initialLeadEventId(SUBMISSION_ID);
    const second = await initialLeadEventId(SUBMISSION_ID);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await initialLeadEventId('other')).not.toBe(first);
  });

  it('uses the business event time, not the dispatch time', async () => {
    const occurredAt = '2026-06-28T08:15:00.000Z';
    const server = await buildServerEvent(leadInput({ occurredAt }));
    expect(server.event_time).toBe(toUnixSeconds(occurredAt));
    expect(server.action_source).toBe('website');
  });

  it('carries no raw personal data in the browser payload', async () => {
    const pixel = await buildPixelPayload(leadInput());
    const serialised = JSON.stringify(pixel);
    expect(serialised).not.toContain('Test@Example.COM');
    expect(serialised).not.toContain('test@example.com');
    expect(serialised).not.toContain('4915112345678');
  });
});

/* -------------------------------------------------------------------------- */

describe('event time limits', () => {
  it('accepts a recent event', () => {
    expect(() =>
      assertEventTimeAcceptable('2026-06-28T00:00:00.000Z', NOW, CAPI_MAX_EVENT_AGE_DAYS),
    ).not.toThrow();
  });

  it('refuses an over-age event instead of rewriting its timestamp', () => {
    let thrown: unknown;
    try {
      assertEventTimeAcceptable('2026-05-01T00:00:00.000Z', NOW, CAPI_MAX_EVENT_AGE_DAYS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const error = thrown as DomainError;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.retryable).toBe(false);
    expect(error.messageDe).toContain('Meta akzeptiert höchstens 7 Tage');
    expect(error.details.max_age_days).toBe(7);
  });

  it('refuses an event dated in the future', () => {
    expect(() => assertEventTimeAcceptable('2026-07-05T00:00:00.000Z', NOW)).toThrowError(
      /Zukunft/,
    );
  });

  it('allows offline events a longer window', () => {
    expect(maxAgeDaysFor('website')).toBe(CAPI_MAX_EVENT_AGE_DAYS);
    expect(maxAgeDaysFor('system_generated')).toBe(CAPI_OFFLINE_MAX_EVENT_AGE_DAYS);
    expect(() =>
      assertEventTimeAcceptable(
        '2026-05-20T00:00:00.000Z',
        NOW,
        CAPI_OFFLINE_MAX_EVENT_AGE_DAYS,
      ),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('down-funnel stages', () => {
  it('maps canonical sales events onto CAPI stages', () => {
    expect(stageForSalesEvent('FORM_COMPLETED')).toBe('INITIAL_LEAD');
    expect(stageForSalesEvent('VQ_SCHEDULED')).toBe('MARKETING_QUALIFIED_LEAD');
    expect(stageForSalesEvent('VQ_PASSED')).toBe('SALES_OPPORTUNITY');
    expect(stageForSalesEvent('CLOSED_WON')).toBe('CONVERTED');
    expect(stageForSalesEvent('CLOSED_LOST')).toBeNull();
    expect(isOncePerOpportunity('CONVERTED')).toBe(true);
    expect(isOncePerOpportunity('SALES_OPPORTUNITY')).toBe(false);
  });

  it('derives event_id from form instance, stage and transition version', async () => {
    const v1 = await stageEventId(FORM_INSTANCE_ID, 'SALES_OPPORTUNITY', 1);
    const v1Again = await stageEventId(FORM_INSTANCE_ID, 'SALES_OPPORTUNITY', 1);
    const v2 = await stageEventId(FORM_INSTANCE_ID, 'SALES_OPPORTUNITY', 2);

    expect(v1).toBe(v1Again);
    expect(v2).not.toBe(v1);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a stage event with the CRM source and the business time', async () => {
    const event = await buildStageEvent({
      formInstanceId: FORM_INSTANCE_ID,
      transitionVersion: 1,
      stage: 'MARKETING_QUALIFIED_LEAD',
      occurredAt: '2026-06-25T09:00:00.000Z',
      identity: { email: 'test@example.com' },
      consent: { adMeasurement: false },
      crmName: 'HubSpot',
    });

    expect(event.event_name).toBe('MarketingQualifiedLead');
    expect(event.action_source).toBe('system_generated');
    expect(event.event_time).toBe(toUnixSeconds('2026-06-25T09:00:00.000Z'));
    expect(event.custom_data?.lead_event_source).toBe('HubSpot');
    expect(event.custom_data?.event_source).toBe('crm');
  });

  it('refuses a CONVERTED without a booked value', async () => {
    await expect(
      buildStageEvent({
        formInstanceId: FORM_INSTANCE_ID,
        transitionVersion: 1,
        stage: 'CONVERTED',
        occurredAt: NOW,
        identity: { email: 'test@example.com' },
        consent: { adMeasurement: false },
      }),
    ).rejects.toThrowError(/gebuchten Wert/);
  });
});

/* -------------------------------------------------------------------------- */

describe('CONVERTED is dispatched at most once per opportunity', () => {
  const base = {
    formInstanceId: FORM_INSTANCE_ID,
    transitionVersion: 1,
    opportunityId: 'opp-1',
    closedWonAt: '2026-06-27T10:00:00.000Z',
    occurredAt: '2026-06-27T10:00:00.000Z',
    identity: { email: 'test@example.com' },
    consent: { adMeasurement: false },
    crmName: 'HubSpot',
  };

  it('carries value, ISO currency and the closed-won timestamp', async () => {
    const ledger = createInMemoryConvertedLedger();
    const outcome = await prepareConvertedEvent(
      { ...base, value: money(1_250_00, 'EUR') },
      ledger,
      NOW,
    );

    expect(outcome.dispatched).toBe(true);
    if (!outcome.dispatched) throw new Error('unreachable');
    expect(outcome.event.event_name).toBe('Converted');
    expect(outcome.event.custom_data?.value).toBe(1250);
    expect(outcome.event.custom_data?.currency).toBe('EUR');
    expect(outcome.event.event_time).toBe(toUnixSeconds(base.closedWonAt));
    expect(outcome.record.closedWonAt).toBe(base.closedWonAt);
  });

  it('turns a later deal-value change into a reconciliation discrepancy', async () => {
    const ledger = createInMemoryConvertedLedger();
    const first = await prepareConvertedEvent(
      { ...base, value: money(1_250_00, 'EUR') },
      ledger,
      NOW,
    );
    const second = await prepareConvertedEvent(
      { ...base, transitionVersion: 2, value: money(1_800_00, 'EUR') },
      ledger,
      NOW,
    );

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.event).toBeNull();
    expect(second.discrepancy?.kind).toBe('CONVERTED_VALUE_CHANGED');
    expect(second.discrepancy?.deltaMinor).toBe(55_000);
    expect(second.discrepancy?.dispatchedAmountMinor).toBe(125_000);
    expect(second.discrepancy?.noteDe).toContain('kein zweites CONVERTED');
  });

  it('reports an identical repeat as already dispatched', async () => {
    const ledger = createInMemoryConvertedLedger();
    await prepareConvertedEvent({ ...base, value: money(1_250_00, 'EUR') }, ledger, NOW);
    const repeat = await prepareConvertedEvent(
      { ...base, value: money(1_250_00, 'EUR') },
      ledger,
      NOW,
    );

    expect(repeat.dispatched).toBe(false);
    expect(repeat.discrepancy?.kind).toBe('CONVERTED_ALREADY_DISPATCHED');
    expect(repeat.discrepancy?.deltaMinor).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('guards and redaction', () => {
  it('requires spam and validity checks before dispatch', () => {
    expect(() =>
      assertServerSideValidated({ spamChecked: false, spamAccepted: true, validated: true }),
    ).toThrowError(/serverseitig geprüft/);
    expect(() =>
      assertServerSideValidated({ spamChecked: true, spamAccepted: false, validated: true }),
    ).toThrowError(/Spam/);
    expect(() =>
      assertServerSideValidated({ spamChecked: true, spamAccepted: true, validated: true }),
    ).not.toThrow();
  });

  it('rejects free text and personal data in custom_data', () => {
    expect(() => assertNoSensitiveCustomData(undefined)).not.toThrow();
    expect(() =>
      assertNoSensitiveCustomData({ content_name: 'Potenzialanalyse Handwerk' }),
    ).not.toThrow();
    expect(() =>
      assertNoSensitiveCustomData({ content_name: 'Bitte melden bei anna@example.com' }),
    ).toThrowError(/Freitext oder personenbezogene Daten/);
    expect(() => assertNoSensitiveCustomData({ status: 'x'.repeat(200) })).toThrowError(
      /Freitext/,
    );
  });

  it('redacts hashes, raw identifiers and the query string', async () => {
    const server = await buildServerEvent(leadInput());
    const redacted = redactCapiPayload(server);

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain(server.user_data.em as string);
    expect(serialised).not.toContain('203.0.113.7');
    expect(serialised).not.toContain('Mozilla/5.0');
    expect(serialised).not.toContain('am_t=abc');

    const user = (redacted.user_data as Record<string, unknown>);
    expect(user.em).toMatch(/^sha256:[0-9a-f]{8}…$/);
    expect(user.client_ip_address).toBe('[redigiert]');
    expect(user.fbp).toBe('[vorhanden]');
    expect(redacted.event_source_url).toBe('https://funnel.am-beratung.de/potenzialanalyse');
    expect(redacted.event_id).toBe(server.event_id);
  });

  it('hashes a payload stably regardless of key order', async () => {
    const server = await buildServerEvent(leadInput());
    const reordered = {
      ...server,
      user_data: Object.fromEntries(Object.entries(server.user_data).reverse()),
    };
    expect(await capiPayloadHash(server)).toBe(await capiPayloadHash(reordered));
    expect(await capiPayloadHash(server)).toMatch(/^[0-9a-f]{64}$/);
  });
});
