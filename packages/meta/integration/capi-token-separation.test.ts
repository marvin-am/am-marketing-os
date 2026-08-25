import { describe, expect, it } from 'vitest';
import { SAFE_DEFAULT_FLAGS } from '@am/domain';
import { LiveMetaProvider } from '../src/live-provider';

/**
 * The Conversions API is normally granted its own token — a system user scoped
 * to the dataset, on a different lifetime from the Marketing API token. Sending
 * one where the other belongs fails in a way that is genuinely hard to diagnose:
 * Meta answers a mismatched `appsecret_proof` with a generic auth error that
 * names neither token, and the visible symptom is conversions quietly going
 * missing rather than an obviously broken call.
 *
 * These tests pin the two properties that make the separation real: the CAPI
 * dispatch sends the CAPI token, and the `appsecret_proof` is computed over
 * *that* token rather than over the Marketing API one.
 *
 * No network: `fetchImpl` is captured and the responses are canned.
 */

const WRITES_ON = {
  ...SAFE_DEFAULT_FLAGS,
  demoMode: false,
  externalWritesEnabled: true,
  metaCapiEnabled: true,
  metaMutationsEnabled: true,
};

const MARKETING_TOKEN = 'EAAmarketing-token';
const CAPI_TOKEN = 'EAAcapi-token';
const APP_SECRET = 'app-secret';

interface Captured {
  url: string;
  authorization: string;
  proof: string | null;
}

function providerWith(capiAccessToken: string | null): {
  provider: LiveMetaProvider;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const provider = new LiveMetaProvider({
    apiVersion: 'v23.0',
    accessToken: MARKETING_TOKEN,
    capiAccessToken,
    adAccountId: 'act_1257002114460912',
    appId: '2236084886702651',
    appSecret: APP_SECRET,
    pixelId: '1048497165333604',
    datasetId: '1048497165333604',
    flags: WRITES_ON,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const headers = new Headers(init?.headers);
      calls.push({
        url: parsed.pathname,
        authorization: headers.get('authorization') ?? '',
        proof: parsed.searchParams.get('appsecret_proof'),
      });
      return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'A1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { provider, calls };
}

/** The same HMAC Meta expects, computed independently of the implementation. */
async function expectedProof(token: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const dispatch = { destinationId: '1048497165333604', events: [{ event_name: 'Lead' }] };

describe('Conversions API token separation', () => {
  it('sends the CAPI token, not the Marketing API one', async () => {
    const { provider, calls } = providerWith(CAPI_TOKEN);
    const outcome = await provider.sendCapiEvents(dispatch);

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${CAPI_TOKEN}`);
    expect(calls[0]?.authorization).not.toContain(MARKETING_TOKEN);
  });

  it('signs the proof over the token it actually sends', async () => {
    const { provider, calls } = providerWith(CAPI_TOKEN);
    await provider.sendCapiEvents(dispatch);

    expect(calls[0]?.proof).toBe(await expectedProof(CAPI_TOKEN));
    expect(calls[0]?.proof).not.toBe(await expectedProof(MARKETING_TOKEN));
  });

  it('falls back to the Marketing API token when no CAPI token is configured', async () => {
    // Null means "reuse the other one", never "CAPI is off" — whether CAPI runs
    // at all is a decision the feature flags own.
    const { provider, calls } = providerWith(null);
    await provider.sendCapiEvents(dispatch);

    expect(calls[0]?.authorization).toBe(`Bearer ${MARKETING_TOKEN}`);
    expect(calls[0]?.proof).toBe(await expectedProof(MARKETING_TOKEN));
  });

  it('leaves every other call on the Marketing API token', async () => {
    const { provider, calls } = providerWith(CAPI_TOKEN);
    await provider.health();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.authorization, call.url).toBe(`Bearer ${MARKETING_TOKEN}`);
    }
  });
});
