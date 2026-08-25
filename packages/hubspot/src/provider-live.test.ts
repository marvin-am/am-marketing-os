process.env.LOG_LEVEL = 'error';

import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError, type FeatureFlags } from '@am/domain';
import { clearProviderCalls, getRecentProviderCalls } from '@am/observability';
import { LiveHubspotProvider, mapHubspotError, parseRetryAfterMs } from './provider-live';
import { isDryRunOutcome } from './provider-types';

const WRITES_ON: FeatureFlags = {
  demoMode: false,
  externalWritesEnabled: true,
  metaMutationsEnabled: false,
  metaCapiEnabled: false,
  hubspotWritesEnabled: true,
};
const WRITES_OFF: FeatureFlags = { ...WRITES_ON, externalWritesEnabled: false, hubspotWritesEnabled: false };

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch double. No test in this package ever touches the network. */
function fakeFetch(responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const next = queue.shift();
    if (!next) throw new Error('Unerwarteter zusätzlicher HTTP-Aufruf im Test.');
    return next;
  }) as unknown as typeof fetch;
  return { impl, requests };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function provider(
  responses: Response[],
  flags: FeatureFlags = WRITES_ON,
  sleeps: number[] = [],
): { instance: LiveHubspotProvider; requests: RecordedRequest[] } {
  const { impl, requests } = fakeFetch(responses);
  return {
    instance: new LiveHubspotProvider({
      token: 'test-token',
      flags,
      fetchImpl: impl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      clock: () => '2026-02-10T12:00:00.000Z',
    }),
    requests,
  };
}

beforeEach(() => {
  clearProviderCalls();
});

describe('write gating', () => {
  it('returns a DryRunResult and makes no request when the flags are off', async () => {
    const { instance, requests } = provider([], WRITES_OFF);
    const outcome = await instance.upsertContact({
      objectType: 'contacts',
      idProperty: 'email',
      idValue: 'nina@example.de',
      properties: { email: 'nina@example.de' },
      idempotencyKey: 'contact:1',
    });

    expect(isDryRunOutcome(outcome)).toBe(true);
    if (isDryRunOutcome(outcome)) {
      expect(outcome.provider).toBe('HUBSPOT');
      expect(outcome.wouldSend).toMatchObject({ objectType: 'contacts' });
      expect(outcome.blockedByDe).toMatch(/HUBSPOT_WRITES_ENABLED/);
    }
    expect(requests).toHaveLength(0);
  });

  it('blocks association writes as well', async () => {
    const { instance, requests } = provider([], WRITES_OFF);
    const outcome = await instance.createAssociation({
      fromObjectType: 'contacts',
      fromObjectId: '1',
      toObjectType: 'deals',
      toObjectId: '2',
      associationCategory: 'HUBSPOT_DEFINED',
      associationTypeId: null,
      idempotencyKey: 'assoc:1',
    });
    expect(isDryRunOutcome(outcome)).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('honours Retry-After and succeeds on the retry', async () => {
    const sleeps: number[] = [];
    const { instance, requests } = provider(
      [
        json({ message: 'You have reached your rate limit' }, 429, { 'retry-after': '2' }),
        json({ results: [{ id: '1', properties: { email: 'a@b.de' } }] }),
      ],
      WRITES_ON,
      sleeps,
    );

    const found = await instance.searchContactByEmail({
      objectType: 'contacts',
      identifierProperty: 'email',
      identifierValue: 'a@b.de',
      properties: ['email'],
    });

    expect(found?.id).toBe('1');
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('raises PROVIDER_RATE_LIMITED once the retries are exhausted', async () => {
    const sleeps: number[] = [];
    const responses = Array.from({ length: 6 }, () =>
      json({ message: 'rate limited' }, 429, { 'retry-after': '1' }),
    );
    const { instance } = provider(responses, WRITES_ON, sleeps);

    await expect(
      instance.searchContactByEmail({
        objectType: 'contacts',
        identifierProperty: 'email',
        identifierValue: 'a@b.de',
        properties: ['email'],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('reads Retry-After as seconds or milliseconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('10000')).toBe(10000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('unsinn')).toBeNull();
  });
});

describe('error mapping', () => {
  it('maps HTTP status codes onto the domain taxonomy with German messages', () => {
    expect(mapHubspotError(401, {}, 'op')).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(mapHubspotError(403, {}, 'op')).toMatchObject({ code: 'FORBIDDEN' });
    expect(mapHubspotError(404, {}, 'op')).toMatchObject({ code: 'NOT_FOUND' });
    expect(mapHubspotError(409, {}, 'op')).toMatchObject({ code: 'CONFLICT' });
    expect(mapHubspotError(429, {}, 'op')).toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(mapHubspotError(400, { message: 'Property fehlt' }, 'op').messageDe).toMatch(
      /Property fehlt/,
    );
    const serverError = mapHubspotError(503, {}, 'op');
    expect(serverError.code).toBe('PROVIDER_ERROR');
    expect(serverError.retryable).toBe(true);
  });

  it('propagates a mapped DomainError from a failing call', async () => {
    const { instance } = provider([json({ message: 'invalid token' }, 401)]);
    await expect(instance.listProperties('contacts')).rejects.toBeInstanceOf(DomainError);
  });

  it('retries a network failure and gives up as a retryable PROVIDER_ERROR', async () => {
    const sleeps: number[] = [];
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const instance = new LiveHubspotProvider({
      token: 't',
      flags: WRITES_ON,
      fetchImpl: impl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 1,
    });
    await expect(instance.listPipelines('deals')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
    });
    expect(sleeps).toHaveLength(1);
  });
});

describe('requests', () => {
  it('pages through properties with paging.next.after', async () => {
    const { instance, requests } = provider([
      json({
        results: [{ name: 'email', label: 'E-Mail' }],
        paging: { next: { after: 'cursor-1' } },
      }),
      json({ results: [{ name: 'firstname', label: 'Vorname' }] }),
    ]);

    const properties = await instance.listProperties('contacts');
    expect(properties.map((p) => p.name)).toEqual(['email', 'firstname']);
    expect(requests[0].url).toContain('/crm/v3/properties/contacts');
    expect(requests[1].url).toContain('after=cursor-1');
  });

  it('searches contacts through the v3 search endpoint', async () => {
    const { instance, requests } = provider([json({ results: [] })]);
    await instance.searchContactByEmail({
      objectType: 'contacts',
      identifierProperty: 'email',
      identifierValue: 'nina@example.de',
      properties: ['email', 'firstname'],
    });

    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toContain('/crm/v3/objects/contacts/search');
    expect(requests[0].body).toMatchObject({
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: 'nina@example.de' }] },
      ],
      properties: ['email', 'firstname'],
      limit: 1,
    });
  });

  it('uses the v4 default-label endpoint when no association type id is mapped', async () => {
    const { instance, requests } = provider([json({})]);
    await instance.createAssociation({
      fromObjectType: 'contacts',
      fromObjectId: '11',
      toObjectType: 'companies',
      toObjectId: '22',
      associationCategory: 'HUBSPOT_DEFINED',
      associationTypeId: null,
      idempotencyKey: 'assoc:1',
    });
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].url).toContain('/crm/v4/objects/contacts/11/associations/default/companies/22');
    expect(requests[0].body).toBeNull();
  });

  it('sends the association category and type id when the mapping supplies one', async () => {
    const { instance, requests } = provider([json({})]);
    await instance.createAssociation({
      fromObjectType: 'contacts',
      fromObjectId: '11',
      toObjectType: 'deals',
      toObjectId: '33',
      associationCategory: 'USER_DEFINED',
      associationTypeId: 42,
      idempotencyKey: 'assoc:2',
    });
    expect(requests[0].url).toContain('/crm/v4/objects/contacts/11/associations/deals/33');
    expect(requests[0].body).toEqual([
      { associationCategory: 'USER_DEFINED', associationTypeId: 42 },
    ]);
  });

  it('reads associations through their own batch endpoint', async () => {
    const { instance, requests } = provider([
      json({ results: [{ from: { id: '11' }, to: [{ toObjectId: 33 }] }] }),
    ]);
    const result = await instance.batchReadAssociations({
      fromObjectType: 'contacts',
      toObjectType: 'deals',
      fromObjectIds: ['11'],
    });
    expect(result).toEqual([{ fromObjectId: '11', toObjectIds: ['33'] }]);
    expect(requests[0].url).toContain('/crm/v4/associations/contacts/deals/batch/read');
  });

  it('batch reads objects with an explicit property list', async () => {
    const { instance, requests } = provider([
      json({ results: [{ id: '7001', properties: { dealstage: 'closedwon' } }] }),
    ]);
    const records = await instance.batchReadObjects({
      objectType: 'deals',
      ids: ['7001'],
      properties: ['dealstage'],
    });
    expect(records[0].properties.dealstage).toBe('closedwon');
    expect(requests[0].url).toContain('/crm/v3/objects/deals/batch/read');
    expect(requests[0].body).toMatchObject({ properties: ['dealstage'], inputs: [{ id: '7001' }] });
  });

  it('reports an unreachable portal without inventing a connection', async () => {
    const { instance } = provider([json({ message: 'invalid token' }, 401)]);
    const probe = await instance.health();
    expect(probe.reachable).toBe(false);
    expect(probe.state).toBe('NOT_CONFIGURED');
    expect(probe.grantedScopes).toEqual([]);
  });

  it('instruments every provider call', async () => {
    const { instance } = provider([json({ results: [] })]);
    await instance.listPipelines('deals');
    const calls = getRecentProviderCalls('HUBSPOT');
    expect(calls.some((c) => c.operation === 'hubspot.listPipelines' && c.ok)).toBe(true);
  });
});
