import { describe, expect, it } from 'vitest';
import { createInMemorySyncStore, FIXTURE_MAPPING } from './fixtures';
import {
  HUBSPOT_SIGNATURE_HEADER,
  HUBSPOT_TIMESTAMP_HEADER,
  createInMemoryWebhookDedupe,
  handleHubspotWebhook,
  parseWebhookPayload,
  signHubspotRequest,
  subscriptionObjectType,
  verifyHubspotSignature,
  type WebhookRequest,
} from './webhooks';

const SECRET = 'fixture-webhook-secret';
const NOW = '2026-02-10T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const URL = 'https://console.example/api/webhooks/hubspot';

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      eventId: 100,
      subscriptionId: 7,
      portalId: 4242,
      occurredAt: NOW_MS,
      subscriptionType: 'deal.propertyChange',
      attemptNumber: 0,
      objectId: 7001,
      propertyName: 'dealstage',
      propertyValue: 'qualifiedtobuy',
      changeSource: 'CRM_UI',
      ...overrides,
    },
  ]);
}

async function signedRequest(rawBody: string, timestampMs = NOW_MS): Promise<WebhookRequest> {
  const signature = await signHubspotRequest(
    { method: 'POST', url: URL, rawBody },
    SECRET,
    timestampMs,
  );
  return {
    method: 'POST',
    url: URL,
    rawBody,
    headers: {
      [HUBSPOT_SIGNATURE_HEADER]: signature,
      [HUBSPOT_TIMESTAMP_HEADER]: String(timestampMs),
      'content-type': 'application/json',
    },
  };
}

describe('verifyHubspotSignature', () => {
  it('accepts a correctly signed request', async () => {
    const request = await signedRequest(payload());
    const result = await verifyHubspotSignature(request, { secret: SECRET, now: () => NOW });
    expect(result.verified).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('rejects a tampered body', async () => {
    const request = await signedRequest(payload());
    const tampered: WebhookRequest = {
      ...request,
      rawBody: request.rawBody.replace('qualifiedtobuy', 'closedwon'),
    };
    const result = await verifyHubspotSignature(tampered, { secret: SECRET, now: () => NOW });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
    expect(result.messageDe).toMatch(/ungültig/);
  });

  it('rejects a replay outside the timestamp window', async () => {
    const oldTimestamp = NOW_MS - 10 * 60 * 1000;
    const request = await signedRequest(payload(), oldTimestamp);
    const result = await verifyHubspotSignature(request, { secret: SECRET, now: () => NOW });
    expect(result.reason).toBe('TIMESTAMP_OUT_OF_WINDOW');
  });

  it('rejects a request signed with the wrong secret', async () => {
    const request = await signedRequest(payload());
    const result = await verifyHubspotSignature(request, {
      secret: 'a-different-secret',
      now: () => NOW,
    });
    expect(result.verified).toBe(false);
  });

  it('rejects when no secret is configured, rather than trusting the body', async () => {
    const request = await signedRequest(payload());
    const result = await verifyHubspotSignature(request, { secret: null, now: () => NOW });
    expect(result.reason).toBe('SECRET_NOT_CONFIGURED');
  });

  it('rejects missing headers', async () => {
    const base = await signedRequest(payload());
    const withoutSignature = { ...base, headers: { [HUBSPOT_TIMESTAMP_HEADER]: String(NOW_MS) } };
    const withoutTimestamp = {
      ...base,
      headers: { [HUBSPOT_SIGNATURE_HEADER]: base.headers[HUBSPOT_SIGNATURE_HEADER] },
    };
    expect((await verifyHubspotSignature(withoutSignature, { secret: SECRET, now: () => NOW })).reason).toBe(
      'MISSING_SIGNATURE',
    );
    expect((await verifyHubspotSignature(withoutTimestamp, { secret: SECRET, now: () => NOW })).reason).toBe(
      'MISSING_TIMESTAMP',
    );
  });

  it('signs over method, uri, body and timestamp — a different URI does not verify', async () => {
    const request = await signedRequest(payload());
    const otherUri = { ...request, url: `${URL}?replay=1` };
    expect((await verifyHubspotSignature(otherUri, { secret: SECRET, now: () => NOW })).verified).toBe(
      false,
    );
  });
});

describe('parseWebhookPayload', () => {
  it('parses and normalises ids to strings', () => {
    const events = parseWebhookPayload(payload());
    expect(events[0].eventId).toBe('100');
    expect(events[0].objectId).toBe('7001');
    expect(events[0].propertyValue).toBe('qualifiedtobuy');
  });

  it('rejects a non-HubSpot body with a German error', () => {
    expect(() => parseWebhookPayload('{"nope":true}')).toThrowError(/HubSpot-Format/);
    expect(() => parseWebhookPayload('not json')).toThrowError(/HubSpot-Format/);
  });

  it('maps subscription types onto the mapped object types', () => {
    expect(subscriptionObjectType('deal.propertyChange', FIXTURE_MAPPING)).toBe('deals');
    expect(subscriptionObjectType('contact.creation', FIXTURE_MAPPING)).toBe('contacts');
    expect(subscriptionObjectType('company.propertyChange', FIXTURE_MAPPING)).toBe('companies');
    expect(subscriptionObjectType('ticket.creation', FIXTURE_MAPPING)).toBeNull();
  });
});

describe('handleHubspotWebhook', () => {
  it('never touches an unverified body', async () => {
    const store = createInMemorySyncStore();
    const request = await signedRequest(payload());
    const result = await handleHubspotWebhook(
      { ...request, rawBody: 'this is not even json' },
      { secret: SECRET, mapping: FIXTURE_MAPPING, store, now: () => NOW },
    );
    expect(result.verified).toBe(false);
    expect(result.events).toEqual([]);
    expect(store.events.size).toBe(0);
    expect(store.mirrors.size).toBe(0);
  });

  it('emits one canonical event for a genuine stage change', async () => {
    const store = createInMemorySyncStore();
    await store.saveMirror({
      objectType: 'deals',
      objectId: '7001',
      properties: { pipeline: 'default', dealstage: 'appointmentscheduled' },
      observedAt: '2026-02-09T00:00:00.000Z',
    });

    const request = await signedRequest(payload());
    const result = await handleHubspotWebhook(request, {
      secret: SECRET,
      mapping: FIXTURE_MAPPING,
      store,
      now: () => NOW,
    });

    expect(result.verified).toBe(true);
    expect(result.appended.map((e) => e.type)).toEqual(['VQ_PASSED']);
    expect(result.messageDe).toMatch(/übernommen/);
  });

  it('emits nothing when the reported value is already mirrored', async () => {
    const store = createInMemorySyncStore();
    await store.saveMirror({
      objectType: 'deals',
      objectId: '7001',
      properties: { pipeline: 'default', dealstage: 'qualifiedtobuy' },
      observedAt: '2026-02-09T00:00:00.000Z',
    });

    const request = await signedRequest(payload());
    const result = await handleHubspotWebhook(request, {
      secret: SECRET,
      mapping: FIXTURE_MAPPING,
      store,
      now: () => NOW,
    });
    expect(result.events).toEqual([]);
    expect(result.messageDe).toMatch(/keine echte Zustandsänderung/);
  });

  it('deduplicates a redelivered event id', async () => {
    const store = createInMemorySyncStore();
    const dedupe = createInMemoryWebhookDedupe();
    await store.saveMirror({
      objectType: 'deals',
      objectId: '7001',
      properties: { pipeline: 'default', dealstage: 'appointmentscheduled' },
      observedAt: '2026-02-09T00:00:00.000Z',
    });

    const request = await signedRequest(payload());
    const deps = { secret: SECRET, mapping: FIXTURE_MAPPING, store, dedupe, now: () => NOW };

    const first = await handleHubspotWebhook(request, deps);
    const second = await handleHubspotWebhook(request, deps);

    expect(first.appended).toHaveLength(1);
    expect(second.duplicates).toBe(1);
    expect(second.appended).toEqual([]);
    expect(store.eventTypes().filter((t) => t === 'VQ_PASSED')).toHaveLength(1);
  });
});
