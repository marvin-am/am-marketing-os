/**
 * Contract tests for the pixel + Conversions API flow, against the fixture
 * provider. No network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type DomainError, SAFE_DEFAULT_FLAGS, money } from '@am/domain';
import {
  CAPI_DEDUP_WINDOW_HOURS,
  CAPI_MAX_EVENT_AGE_DAYS,
  FIXTURE_DATASET_ID,
  FIXTURE_PIXEL_ID,
  FixtureMetaProvider,
  buildInitialLeadEvent,
  buildPixelPayload,
  buildServerEvent,
  buildStageEvent,
  createInMemoryConvertedLedger,
  dispatchCapiEvents,
  isDryRun,
  prepareConvertedEvent,
  redactCapiPayload,
  resetImportMode,
  runInImportMode,
  stageForSalesEvent,
} from '../src/index';

const NOW = '2026-06-30T12:00:00.000Z';
const SUBMISSION_ID = '9a7b3c1d-1111-4111-8111-111111111111';
const FORM_INSTANCE_ID = '9a7b3c1d-2222-4222-8222-222222222222';
const OPPORTUNITY_ID = '9a7b3c1d-3333-4333-8333-333333333333';

const CAPI_ON = {
  ...SAFE_DEFAULT_FLAGS,
  demoMode: false,
  externalWritesEnabled: true,
  metaCapiEnabled: true,
};

const GATE = { spamChecked: true, spamAccepted: true, validated: true } as const;

const IDENTITY = {
  email: 'anna.mueller@example.de',
  phone: '+49 151 12345678',
  firstName: 'Anna',
  lastName: 'Müller',
  postalCode: '60311',
  country: 'DE',
  externalId: 'person-42',
  fbp: 'fb.1.1750000000000.987654321',
  fbclid: 'IwAR0abcdef',
  fbclidObservedAtMs: 1_750_000_000_000,
  clientIpAddress: '203.0.113.7',
  clientUserAgent: 'Mozilla/5.0',
};

function leadInput() {
  return {
    submissionId: SUBMISSION_ID,
    pixelId: FIXTURE_PIXEL_ID,
    occurredAt: '2026-06-29T09:30:00.000Z',
    eventSourceUrl: 'https://funnel.am-beratung.de/potenzialanalyse?am_t=signed-token',
    identity: IDENTITY,
    consent: { adMeasurement: true },
  };
}

afterEach(() => {
  resetImportMode();
});

/* -------------------------------------------------------------------------- */

describe('the initial lead deduplicates across pixel and server', () => {
  it('shares one event name and one event_id, built from a single source', async () => {
    const pixel = await buildPixelPayload(leadInput());
    const server = await buildServerEvent(leadInput());

    expect(pixel.eventID).toBe(server.event_id);
    expect(pixel.eventName).toBe(server.event_name);
    expect(pixel.eventName).toBe('Lead');
    expect(CAPI_DEDUP_WINDOW_HOURS).toBe(48);
  });

  it('produces the same ids on a retry, because both derive from the submission', async () => {
    const first = await buildInitialLeadEvent(leadInput());
    const retry = await buildInitialLeadEvent(leadInput());

    expect(retry.eventId).toBe(first.eventId);
    expect(retry.server.event_time).toBe(first.server.event_time);
    expect(retry.server.user_data.fbc).toBe(first.server.user_data.fbc);
  });

  it('keeps event_time on the business event even when dispatch happens later', async () => {
    const provider = new FixtureMetaProvider({ flags: CAPI_ON });
    const event = await buildServerEvent(leadInput());

    const result = await dispatchCapiEvents([event], provider, CAPI_ON, {
      destinationId: FIXTURE_PIXEL_ID,
      gate: GATE,
      now: NOW,
    });

    expect(isDryRun(result)).toBe(false);
    const dispatched = provider.dispatchedCapiBatches()[0];
    expect(dispatched.events[0].event_time).toBe(
      Math.floor(new Date('2026-06-29T09:30:00.000Z').getTime() / 1000),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('dispatch guards', () => {
  it('returns a DryRunResult and performs no write when CAPI is disabled', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS });
    const event = await buildServerEvent(leadInput());

    const result = await dispatchCapiEvents([event], provider, SAFE_DEFAULT_FLAGS, {
      destinationId: FIXTURE_PIXEL_ID,
      gate: GATE,
      now: NOW,
    });

    expect(isDryRun(result)).toBe(true);
    if (!isDryRun(result)) throw new Error('unreachable');
    expect(result.operation).toBe('meta.send_capi_events');
    expect(result.blockedByDe).toContain('deaktiviert');
    expect(result.wouldSend.event_count).toBe(1);
    expect(provider.dispatchedCapiBatches()).toHaveLength(0);
  });

  it('refuses to dispatch before spam and validity checks completed', async () => {
    const provider = new FixtureMetaProvider({ flags: CAPI_ON });
    const event = await buildServerEvent(leadInput());

    await expect(
      dispatchCapiEvents([event], provider, CAPI_ON, {
        destinationId: FIXTURE_PIXEL_ID,
        gate: { spamChecked: true, spamAccepted: false, validated: true },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'SPAM_REJECTED' });

    expect(provider.dispatchedCapiBatches()).toHaveLength(0);
  });

  it('refuses an over-age event instead of rewriting its timestamp', async () => {
    const provider = new FixtureMetaProvider({ flags: CAPI_ON });
    const stale = await buildServerEvent({
      ...leadInput(),
      occurredAt: '2026-01-15T09:30:00.000Z',
    });

    let thrown: unknown;
    try {
      await dispatchCapiEvents([stale], provider, CAPI_ON, {
        destinationId: FIXTURE_PIXEL_ID,
        gate: GATE,
        now: NOW,
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details.max_age_days).toBe(CAPI_MAX_EVENT_AGE_DAYS);
    expect(error.messageDe).toContain('nicht gesendet');
    expect(provider.dispatchedCapiBatches()).toHaveLength(0);
  });

  it('suppresses dispatch entirely while a historical import runs', async () => {
    const provider = new FixtureMetaProvider({ flags: CAPI_ON });
    const event = await buildServerEvent(leadInput());

    await runInImportMode(async () => {
      await expect(
        dispatchCapiEvents([event], provider, CAPI_ON, {
          destinationId: FIXTURE_PIXEL_ID,
          gate: GATE,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    expect(provider.dispatchedCapiBatches()).toHaveLength(0);

    // Once the import is over, the very same event dispatches normally.
    const result = await dispatchCapiEvents([event], provider, CAPI_ON, {
      destinationId: FIXTURE_PIXEL_ID,
      gate: GATE,
      now: NOW,
    });
    expect(isDryRun(result)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('down-funnel stages', () => {
  const stageBase = {
    formInstanceId: FORM_INSTANCE_ID,
    identity: IDENTITY,
    consent: { adMeasurement: false },
    crmName: 'HubSpot',
  };

  it('walks INITIAL_LEAD → MQL → SALES_OPPORTUNITY → CONVERTED with distinct ids', async () => {
    const lead = await buildServerEvent(leadInput());
    const mql = await buildStageEvent({
      ...stageBase,
      transitionVersion: 1,
      stage: stageForSalesEvent('VQ_SCHEDULED') ?? 'MARKETING_QUALIFIED_LEAD',
      occurredAt: '2026-06-29T14:00:00.000Z',
    });
    const opportunity = await buildStageEvent({
      ...stageBase,
      transitionVersion: 1,
      stage: stageForSalesEvent('VQ_PASSED') ?? 'SALES_OPPORTUNITY',
      occurredAt: '2026-06-30T08:00:00.000Z',
    });
    const converted = await buildStageEvent({
      ...stageBase,
      transitionVersion: 1,
      stage: 'CONVERTED',
      occurredAt: '2026-06-30T11:00:00.000Z',
      value: money(2_400_00, 'EUR'),
      opportunityId: OPPORTUNITY_ID,
    });

    const names = [lead, mql, opportunity, converted].map((event) => event.event_name);
    expect(names).toEqual(['Lead', 'MarketingQualifiedLead', 'SalesOpportunity', 'Converted']);

    const ids = new Set([lead, mql, opportunity, converted].map((event) => event.event_id));
    expect(ids.size).toBe(4);

    expect(converted.custom_data?.value).toBe(2400);
    expect(converted.custom_data?.currency).toBe('EUR');
  });

  it('dispatches CONVERTED once and turns a later value change into a discrepancy', async () => {
    const provider = new FixtureMetaProvider({ flags: CAPI_ON });
    const ledger = createInMemoryConvertedLedger();
    const input = {
      ...stageBase,
      transitionVersion: 1,
      occurredAt: '2026-06-30T11:00:00.000Z',
      opportunityId: OPPORTUNITY_ID,
      closedWonAt: '2026-06-30T11:00:00.000Z',
      value: money(2_400_00, 'EUR'),
    };

    const first = await prepareConvertedEvent(input, ledger, NOW);
    expect(first.dispatched).toBe(true);
    if (!first.dispatched) throw new Error('unreachable');

    await dispatchCapiEvents([first.event], provider, CAPI_ON, {
      destinationId: FIXTURE_DATASET_ID,
      gate: GATE,
      now: NOW,
    });

    // The deal value is corrected upwards a day later.
    const second = await prepareConvertedEvent(
      { ...input, transitionVersion: 2, value: money(3_100_00, 'EUR') },
      ledger,
      NOW,
    );

    expect(second.dispatched).toBe(false);
    expect(second.event).toBeNull();
    expect(second.discrepancy?.kind).toBe('CONVERTED_VALUE_CHANGED');
    expect(second.discrepancy?.deltaMinor).toBe(70_000);

    // Exactly one CONVERTED reached the provider.
    const converted = provider
      .dispatchedCapiBatches()
      .flatMap((batch) => batch.events)
      .filter((event) => event.event_name === 'Converted');
    expect(converted).toHaveLength(1);
    expect(converted[0].event_time).toBe(
      Math.floor(new Date('2026-06-30T11:00:00.000Z').getTime() / 1000),
    );
  });

  it('sends CRM stage events to the dataset with a longer accepted age', async () => {
    const provider = new FixtureMetaProvider({ flags: CAPI_ON });
    const event = await buildStageEvent({
      ...stageBase,
      transitionVersion: 1,
      stage: 'SALES_OPPORTUNITY',
      // Three weeks old: too old for a website event, fine for an offline one.
      occurredAt: '2026-06-09T10:00:00.000Z',
    });

    const result = await dispatchCapiEvents([event], provider, CAPI_ON, {
      destinationId: FIXTURE_DATASET_ID,
      gate: GATE,
      now: NOW,
    });

    expect(isDryRun(result)).toBe(false);
    if (isDryRun(result)) throw new Error('unreachable');
    expect(result.destinationId).toBe(FIXTURE_DATASET_ID);
    expect(result.eventsReceived).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('nothing sensitive leaves the process', () => {
  it('never puts raw personal data into a redacted payload', async () => {
    const server = await buildServerEvent(leadInput());
    const redacted = JSON.stringify(redactCapiPayload(server));

    for (const secret of [
      'anna.mueller@example.de',
      'Anna',
      'Müller',
      '4915112345678',
      '203.0.113.7',
      'Mozilla/5.0',
      'signed-token',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('sha256:');
  });

  it('drops qualification answers because custom_data is a closed schema', async () => {
    const server = await buildServerEvent({
      ...leadInput(),
      // A caller trying to smuggle an answer through gets it stripped, not sent.
      contentName: 'Potenzialanalyse',
    });
    const asRecord = server.custom_data as Record<string, unknown>;
    expect(asRecord.content_name).toBe('Potenzialanalyse');
    expect(Object.keys(asRecord)).not.toContain('answers');
    expect(JSON.stringify(server.custom_data)).not.toContain('Umsatz');
  });
});
