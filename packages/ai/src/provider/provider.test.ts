import { isDomainError } from '@am/domain';
import { resetConfigCache } from '@am/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FixtureEmbeddingProvider } from './fixture-embedding';
import { FixtureImageProvider } from './fixture-image';
import { FixtureTextProvider } from './fixture-text';
import { getEmbeddingProvider, getTextProvider, isFixtureMode, resetProviderCache } from './factory';
import { OpenAiEmbeddingProvider } from './openai-embedding';
import { OpenAiImageProvider } from './openai-image';
import { OpenAiTextProvider } from './openai-text';
import { encodePngRgb, toBase64 } from './png';
import { backoffDelayMs, retryAfterMs, withRetry } from './retry';
import { cosineSimilarity } from '../similarity';

const PNG_SIGNATURE = 'iVBORw0KGgo';

/* -------------------------------------------------------------------------- */
/* Fixture providers                                                           */
/* -------------------------------------------------------------------------- */

describe('FixtureTextProvider', () => {
  const schema = z.object({
    brandSummaryDe: z.string(),
    audienceSummaryDe: z.string(),
    offerLandscapeDe: z.string(),
    approvedFacts: z.array(
      z.object({ statementDe: z.string(), sourceRef: z.string().nullable(), confidence: z.string() }),
    ),
    guardrailNotesDe: z.array(z.string()),
    openQuestionsDe: z.array(z.string()),
  });

  const request = {
    schema,
    schemaName: 'context.summarize',
    systemPrompt: 'system',
    userPrompt: 'user',
  };

  it('is deterministic for identical input', async () => {
    const a = await new FixtureTextProvider().generateStructured(request);
    const b = await new FixtureTextProvider().generateStructured(request);
    expect(b.raw).toBe(a.raw);
    expect(b.requestHash).toBe(a.requestHash);
  });

  it('varies across prompts while every variant stays schema-valid', async () => {
    const provider = new FixtureTextProvider();
    const results = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((suffix) =>
        provider.generateStructured({ ...request, userPrompt: `Auftrag ${suffix}` }),
      ),
    );

    expect(results.every((result) => result.data !== null)).toBe(true);
    // Not every prompt has to produce a different variant, but a fixture that
    // returned one frozen answer would hide ordering bugs downstream.
    expect(new Set(results.map((result) => result.raw)).size).toBeGreaterThan(1);
  });

  it('returns realistic German content', async () => {
    const { data } = await new FixtureTextProvider().generateStructured(request);
    expect(data!.brandSummaryDe).toMatch(/Handwerks/);
    expect(data!.approvedFacts.map((fact) => fact.confidence)).toContain('HYPOTHESIS');
  });

  it('refuses to serve a prompt it has no fixture for', async () => {
    expect.assertions(2);
    try {
      await new FixtureTextProvider().generateStructured({ ...request, schemaName: 'unknown.step' });
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('PROVIDER_NOT_CONFIGURED');
    }
  });
});

describe('FixtureEmbeddingProvider', () => {
  const provider = new FixtureEmbeddingProvider();

  it('produces stable, unit-length, non-negative vectors', async () => {
    const [first] = await provider.embed(['Mitarbeitergewinnung im Handwerk']);
    const [again] = await provider.embed(['Mitarbeitergewinnung im Handwerk']);

    expect(first).toEqual(again);
    expect(first).toHaveLength(provider.dimensions);
    expect(first!.every((value) => value >= 0)).toBe(true);
    expect(Math.hypot(...first!)).toBeCloseTo(1, 6);
  });

  it('scores related text far above unrelated text', async () => {
    const [base, related, unrelated] = await provider.embed([
      'Mitarbeitergewinnung für Handwerksbetriebe ohne Zeitarbeit',
      'Mitarbeitergewinnung für Handwerksbetriebe ohne Zeitarbeit und ohne Vermittler',
      'Rezept für Apfelkuchen mit Zimt und Streuseln aus dem Backofen',
    ]);

    expect(cosineSimilarity(base!, related!)).toBeGreaterThan(0.8);
    expect(cosineSimilarity(base!, unrelated!)).toBeLessThan(0.2);
  });

  it('returns an empty result for an empty batch', async () => {
    expect(await provider.embed([])).toEqual([]);
  });
});

describe('FixtureImageProvider', () => {
  const provider = new FixtureImageProvider();

  it('returns a decodable PNG with honest metadata', async () => {
    const result = await provider.generateImage({
      prompt: 'Leerer Betriebshof in der blauen Morgenstunde',
      aspectRatio: '1:1',
    });

    expect(result.base64.startsWith(PNG_SIGNATURE)).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(result.model).toBe('fixture-image-v1');
    expect(result.size).toBe('1024x1024');
    expect(result.pixelWidth).toBe(128);
    expect(result.pixelHeight).toBe(128);
    expect(result.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic per prompt and differs across prompts', async () => {
    const a = await provider.generateImage({ prompt: 'Motiv A', aspectRatio: '1:1' });
    const again = await provider.generateImage({ prompt: 'Motiv A', aspectRatio: '1:1' });
    const b = await provider.generateImage({ prompt: 'Motiv B', aspectRatio: '1:1' });

    expect(again.base64).toBe(a.base64);
    expect(b.base64).not.toBe(a.base64);
  });

  it('maps portrait placements to a portrait canvas', async () => {
    const result = await provider.generateImage({ prompt: 'Motiv', aspectRatio: '4:5' });
    expect(result.size).toBe('1024x1536');
    expect(result.pixelHeight).toBeGreaterThan(result.pixelWidth);
  });
});

describe('png encoder', () => {
  it('emits the PNG signature, IHDR, IDAT and IEND', () => {
    const bytes = encodePngRgb(2, 2, new Uint8Array(2 * 2 * 3).fill(200));
    const ascii = String.fromCharCode(...bytes);

    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(ascii).toContain('IHDR');
    expect(ascii).toContain('IDAT');
    expect(ascii.endsWith('IEND®B`')).toBe(true);
  });

  it('rejects a pixel buffer of the wrong size', () => {
    expect(() => encodePngRgb(2, 2, new Uint8Array(3))).toThrow(/expected 12 bytes/);
  });

  it('base64-encodes with correct padding', () => {
    expect(toBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu');
    expect(toBase64(new Uint8Array([77, 97]))).toBe('TWE=');
    expect(toBase64(new Uint8Array([77]))).toBe('TQ==');
  });
});

/* -------------------------------------------------------------------------- */
/* Retry                                                                       */
/* -------------------------------------------------------------------------- */

describe('withRetry', () => {
  const noSleep = { sleepFn: () => Promise.resolve(), random: () => 0.5, baseDelayMs: 1 };

  it('retries 429 and succeeds', async () => {
    let attempts = 0;
    const value = await withRetry(() => {
      attempts++;
      if (attempts < 3) return Promise.reject(Object.assign(new Error('rate'), { status: 429 }));
      return Promise.resolve('ok');
    }, noSleep);

    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('surfaces an exhausted rate limit as PROVIDER_RATE_LIMITED', async () => {
    expect.assertions(3);
    try {
      await withRetry(
        () => Promise.reject(Object.assign(new Error('rate'), { status: 429 })),
        { ...noSleep, maxAttempts: 2 },
      );
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('PROVIDER_RATE_LIMITED');
        expect(error.retryable).toBe(true);
      }
    }
  });

  it('retries 5xx but never a 400', async () => {
    let serverAttempts = 0;
    await expect(
      withRetry(() => {
        serverAttempts++;
        return Promise.reject(Object.assign(new Error('boom'), { status: 503 }));
      }, { ...noSleep, maxAttempts: 3 }),
    ).rejects.toThrow();
    expect(serverAttempts).toBe(3);

    let badAttempts = 0;
    await expect(
      withRetry(() => {
        badAttempts++;
        return Promise.reject(Object.assign(new Error('bad'), { status: 400 }));
      }, noSleep),
    ).rejects.toThrow();
    expect(badAttempts).toBe(1);
  });

  it('maps 401 to PROVIDER_NOT_CONFIGURED', async () => {
    expect.assertions(1);
    try {
      await withRetry(
        () => Promise.reject(Object.assign(new Error('nope'), { status: 401 })),
        noSleep,
      );
    } catch (error) {
      if (isDomainError(error)) expect(error.code).toBe('PROVIDER_NOT_CONFIGURED');
    }
  });

  it('honours retry-after over the computed backoff', () => {
    expect(retryAfterMs({ headers: new Headers({ 'retry-after': '2' }) })).toBe(2000);
    expect(retryAfterMs({ headers: { 'retry-after': '0.5' } })).toBe(500);
    expect(retryAfterMs({ headers: new Headers() })).toBeNull();
    expect(retryAfterMs(new Error('no headers'))).toBeNull();
  });

  it('applies full-jitter exponential backoff within the cap', () => {
    const options = { baseDelayMs: 500, maxDelayMs: 20_000, random: () => 1 };
    expect(backoffDelayMs(0, options)).toBe(500);
    expect(backoffDelayMs(1, options)).toBe(1000);
    expect(backoffDelayMs(6, options)).toBe(20_000);
    expect(backoffDelayMs(3, { ...options, random: () => 0 })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* OpenAI adapters against an injected client (no network)                     */
/* -------------------------------------------------------------------------- */

function responsesClient(handler: (params: any) => any) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      responses: {
        create: (params: any) => {
          calls.push(params);
          return Promise.resolve(handler(params));
        },
      },
    } as any,
  };
}

function completedResponse(payload: unknown) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'test-text-model',
    output: [
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(payload), annotations: [] }],
      },
    ],
    output_text: JSON.stringify(payload),
    parallel_tool_calls: false,
    temperature: null,
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
  };
}

describe('OpenAiTextProvider', () => {
  const schema = z.object({ titel: z.string().min(3), punkte: z.array(z.string()).min(1) });
  const base = {
    schema,
    schemaName: 'context.summarize',
    systemPrompt: 'You are the campaign strategist.',
    userPrompt: 'Fasse den Kontext zusammen.',
    temperature: 0.2,
  };

  it('calls the Responses API with a strict json_schema format', async () => {
    const { client, calls } = responsesClient(() =>
      completedResponse({ titel: 'Zusammenfassung', punkte: ['Ein Punkt'] }),
    );
    const provider = new OpenAiTextProvider({ client, model: 'test-text-model' });

    const result = await provider.generateStructured(base);

    expect(calls).toHaveLength(1);
    const params = calls[0];
    expect(params.model).toBe('test-text-model');
    expect(params.instructions).toBe(base.systemPrompt);
    expect(params.input).toEqual([{ role: 'user', content: base.userPrompt }]);
    expect(params.store).toBe(false);
    expect(params.stream).toBe(false);
    expect(params.temperature).toBe(0.2);
    expect(params.text.format).toMatchObject({
      type: 'json_schema',
      name: 'context_summarize',
      strict: true,
    });
    expect(params.text.format.schema.additionalProperties).toBe(false);
    expect(params.text.format.schema.required).toEqual(['titel', 'punkte']);

    expect(result.data).toEqual({ titel: 'Zusammenfassung', punkte: ['Ein Punkt'] });
    expect(result.model).toBe('test-text-model');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(result.finishReason).toBe('completed');
  });

  it('sends the previous answer and the issues on a repair turn', async () => {
    const { client, calls } = responsesClient(() =>
      completedResponse({ titel: 'Korrigiert', punkte: ['Ein Punkt'] }),
    );
    const provider = new OpenAiTextProvider({ client, model: 'test-text-model' });

    await provider.generateStructured({
      ...base,
      repair: { previousRaw: '{"titel":"x"}', issues: ['punkte: erforderlich'] },
    });

    const input = calls[0].input;
    expect(input).toHaveLength(3);
    expect(input[1]).toEqual({ role: 'assistant', content: '{"titel":"x"}' });
    expect(input[2].content).toContain('punkte: erforderlich');
    expect(input[2].content).toContain('did not satisfy the required JSON schema');
  });

  it('reports schema violations instead of throwing', async () => {
    const { client } = responsesClient(() => completedResponse({ titel: 'x', punkte: [] }));
    const provider = new OpenAiTextProvider({ client, model: 'test-text-model' });

    const result = await provider.generateStructured(base);
    expect(result.data).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.join(' ')).toContain('titel');
  });

  it('reports invalid JSON as an issue, not as a crash', async () => {
    const { client } = responsesClient(() => ({
      ...completedResponse({}),
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'kein JSON', annotations: [] }],
        },
      ],
      output_text: 'kein JSON',
    }));
    const provider = new OpenAiTextProvider({ client, model: 'test-text-model' });

    const result = await provider.generateStructured(base);
    expect(result.data).toBeNull();
    expect(result.issues[0]).toContain('kein gültiges JSON');
  });

  it('surfaces a refusal', async () => {
    const { client } = responsesClient(() => ({
      ...completedResponse({}),
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'Das kann ich nicht erzeugen.' }],
        },
      ],
      output_text: '',
    }));
    const provider = new OpenAiTextProvider({ client, model: 'test-text-model' });

    const result = await provider.generateStructured(base);
    expect(result.finishReason).toBe('refusal');
    expect(result.refusal).toBe('Das kann ich nicht erzeugen.');
    expect(result.data).toBeNull();
  });

  it('reports a truncated response with its reason', async () => {
    const { client } = responsesClient(() => ({
      ...completedResponse({ titel: 'abc', punkte: ['x'] }),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }));
    const provider = new OpenAiTextProvider({ client, model: 'test-text-model' });

    const result = await provider.generateStructured(base);
    expect(result.finishReason).toBe('incomplete');
    expect(result.issues[0]).toContain('max_output_tokens');
  });

  it('retries once without temperature when the model rejects the parameter', async () => {
    let attempt = 0;
    const { client, calls } = responsesClient(() => {
      attempt++;
      if (attempt === 1) {
        throw Object.assign(new Error("Unsupported parameter: 'temperature' is not supported"), {
          status: 400,
        });
      }
      return completedResponse({ titel: 'Zusammenfassung', punkte: ['Ein Punkt'] });
    });
    const provider = new OpenAiTextProvider({ client, model: 'reasoning-model' });

    const result = await provider.generateStructured(base);
    expect(calls).toHaveLength(2);
    expect(calls[0].temperature).toBe(0.2);
    expect(calls[1].temperature).toBeUndefined();
    expect(result.data).not.toBeNull();
  });
});

describe('OpenAiImageProvider', () => {
  it('requests base64 output and returns prompt provenance', async () => {
    const calls: any[] = [];
    const client = {
      images: {
        generate: (params: any) => {
          calls.push(params);
          return Promise.resolve({
            created: 1,
            data: [{ b64_json: 'QUJD', revised_prompt: 'überarbeitet' }],
          });
        },
      },
    } as any;

    const provider = new OpenAiImageProvider({ client, model: 'test-image-model' });
    const result = await provider.generateImage({ prompt: 'Ein Motiv ohne Schrift', aspectRatio: '4:5' });

    expect(calls[0]).toMatchObject({
      model: 'test-image-model',
      prompt: 'Ein Motiv ohne Schrift',
      n: 1,
      size: '1024x1536',
      output_format: 'png',
      stream: false,
    });
    expect(result.base64).toBe('QUJD');
    expect(result.pixelWidth).toBe(1024);
    expect(result.pixelHeight).toBe(1536);
    expect(result.revisedPrompt).toBe('überarbeitet');
  });

  it('fails loudly when the provider returns no image', async () => {
    expect.assertions(2);
    const client = { images: { generate: () => Promise.resolve({ created: 1, data: [] }) } } as any;
    const provider = new OpenAiImageProvider({ client, model: 'test-image-model' });

    try {
      await provider.generateImage({ prompt: 'Motiv', aspectRatio: '1:1' });
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('PROVIDER_ERROR');
    }
  });
});

describe('OpenAiEmbeddingProvider', () => {
  it('batches inputs and restores index order', async () => {
    const calls: any[] = [];
    const client = {
      embeddings: {
        create: (params: any) => {
          calls.push(params);
          const inputs = params.input as string[];
          return Promise.resolve({
            model: params.model,
            // Deliberately out of order: the adapter must not trust arrival order.
            data: inputs
              .map((_, index) => ({ index, embedding: [index, 1] }))
              .reverse(),
          });
        },
      },
    } as any;

    const provider = new OpenAiEmbeddingProvider({
      client,
      model: 'test-embedding',
      batchSize: 2,
      dimensions: 2,
    });
    const vectors = await provider.embed(['a', 'b', 'c']);

    expect(calls).toHaveLength(2);
    expect(calls[0].input).toEqual(['a', 'b']);
    expect(calls[0].dimensions).toBe(2);
    expect(vectors).toEqual([
      [0, 1],
      [1, 1],
      [0, 1],
    ]);
  });

  it('rejects an incomplete batch response', async () => {
    expect.assertions(1);
    const client = {
      embeddings: {
        create: () => Promise.resolve({ model: 'm', data: [{ index: 0, embedding: [1] }] }),
      },
    } as any;
    const provider = new OpenAiEmbeddingProvider({ client, model: 'test-embedding' });

    try {
      await provider.embed(['a', 'b']);
    } catch (error) {
      if (isDomainError(error)) expect(error.code).toBe('PROVIDER_ERROR');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

describe('provider factory', () => {
  /**
   * Demo mode is stubbed rather than inherited. `isFixtureMode()` reads
   * `DEMO_MODE`, which defaults to true — so an inherited environment made this
   * test assert the developer's shell instead of the product, and it flipped to
   * red the moment a real `.env.local` with `DEMO_MODE=false` was present.
   * A test whose verdict depends on whose machine runs it is not a gate.
   */
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'true');
    resetConfigCache();
    resetProviderCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
    resetProviderCache();
  });

  it('selects fixtures in demo mode and memoises the choice', () => {
    expect(isFixtureMode()).toBe(true);

    const text = getTextProvider();
    expect(text.kind).toBe('fixture');
    expect(text.model).toBe('fixture-text-v1');
    expect(getTextProvider()).toBe(text);

    const embeddings = getEmbeddingProvider();
    expect(embeddings.kind).toBe('fixture');
    expect(getEmbeddingProvider()).toBe(embeddings);

    resetProviderCache();
    expect(getTextProvider()).not.toBe(text);
  });
});
