import { resetConfigCache } from '@am/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOpenAiHealth, type OpenAiHealthClient } from './health';
import { resetProviderCache } from './factory';

/**
 * The rule under test is the one the specification states verbatim: never report
 * a connection that was not established. A key in the environment is not a
 * connection, so every assertion here is about what the probe *did*, not about
 * what the environment contains.
 *
 * The client is injected in every live case. Depending on whether the machine
 * running the suite can reach `api.openai.com` would make the verdict a property
 * of the network rather than of the code.
 */

const MODEL = 'test-text-model';

function listingClient(ids: readonly string[]): OpenAiHealthClient {
  return { models: { list: () => Promise.resolve({ data: ids.map((id) => ({ id })) }) } };
}

function failingClient(error: unknown): OpenAiHealthClient {
  return { models: { list: () => Promise.reject(error) } };
}

function statuses(health: { checks: { key: string; status: string }[] }): Record<string, string> {
  return Object.fromEntries(health.checks.map((check) => [check.key, check.status]));
}

describe('checkOpenAiHealth', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OPENAI_API_KEY', '');
    resetConfigCache();
    resetProviderCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
    resetProviderCache();
  });

  it('reports fixtures, not a connection, when no key is configured', async () => {
    const health = await checkOpenAiHealth();

    expect(health.state).toBe('FIXTURE');
    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.every((check) => check.status === 'AWAITING_EXTERNAL_INPUT')).toBe(true);
    expect(health.checks.every((check) => check.detailDe)).toBe(true);
  });

  it('never reports CONNECTED when the provider cannot be reached', async () => {
    const health = await checkOpenAiHealth({
      mode: 'LIVE',
      modelId: MODEL,
      client: failingClient(new Error('fetch failed: ECONNREFUSED 127.0.0.1:443')),
    });

    expect(health.state).toBe('ERROR');
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
    expect(statuses(health)['openai.api_key']).toBe('FAIL');
    // The operator is told what actually happened and what to do about it.
    expect(health.checks[0]!.detailDe).toContain('ECONNREFUSED');
    expect(health.checks[0]!.remediationDe).toBeTruthy();
    // A check that never ran does not pass and does not pretend to have failed.
    expect(statuses(health)['openai.model_access']).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks[1]!.detailDe).toContain('Nicht geprüft');
  });

  it('treats a rejected key as external input rather than as a product defect', async () => {
    const health = await checkOpenAiHealth({
      mode: 'LIVE',
      modelId: MODEL,
      client: failingClient(Object.assign(new Error('Incorrect API key'), { status: 401 })),
    });

    expect(health.state).toBe('ERROR');
    expect(statuses(health)['openai.api_key']).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
  });

  it('reports CONNECTED once the provider has actually answered', async () => {
    const health = await checkOpenAiHealth({
      mode: 'LIVE',
      modelId: MODEL,
      client: listingClient([MODEL, 'other-model']),
    });

    expect(health.state).toBe('CONNECTED');
    expect(statuses(health)['openai.api_key']).toBe('PASS');
    expect(statuses(health)['openai.model_access']).toBe('PASS');
    expect(health.checks[1]!.detailDe).toContain(MODEL);
    // No cost cap exists yet, so the integration is connected and still not clean.
    expect(statuses(health)['openai.budget']).toBe('WARN');
    expect(health.overall).toBe('WARN');
  });

  it('does not claim the configured model is available when the listing omits it', async () => {
    const health = await checkOpenAiHealth({
      mode: 'LIVE',
      modelId: MODEL,
      client: listingClient(['some-other-model']),
    });

    expect(health.state).toBe('DEGRADED');
    expect(statuses(health)['openai.model_access']).toBe('WARN');
    expect(health.checks[1]!.remediationDe).toBeTruthy();
  });

  it('does not propagate a probe that throws', async () => {
    const client: OpenAiHealthClient = {
      models: {
        list: () => {
          throw new Error('client exploded before any request was made');
        },
      },
    };

    const health = await checkOpenAiHealth({ mode: 'LIVE', modelId: MODEL, client });

    expect(health.state).toBe('ERROR');
    expect(health.checks).toHaveLength(3);
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
  });

  it('gives up on a provider that never answers instead of holding the render open', async () => {
    const client: OpenAiHealthClient = { models: { list: () => new Promise(() => {}) } };

    const health = await checkOpenAiHealth({
      mode: 'LIVE',
      modelId: MODEL,
      client,
      timeoutMs: 20,
    });

    expect(health.state).toBe('ERROR');
    expect(health.checks[0]!.detailDe).toContain('Zeitüberschreitung');
  });
});
