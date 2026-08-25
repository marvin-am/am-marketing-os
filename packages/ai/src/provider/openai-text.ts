import { getModelConfig } from '@am/config';
import { instrumented } from '@am/observability';
import type OpenAI from 'openai';
import { type z } from 'zod';
import { hashUnknown } from '../hash';
import { toResponseFormat, type StrictJsonSchemaOptions } from '../json-schema';
import { getOpenAiClient } from './openai-client';
import { statusOf, withRetry, type RetryOptions } from './retry';
import type { FinishReason, StructuredRequest, StructuredResult, TextProvider } from './types';

/**
 * `TextProvider` backed by the OpenAI **Responses API** with **Structured
 * Outputs** (`text.format = { type: 'json_schema', strict: true, … }`).
 *
 * The request shape is taken from the `openai@7.5.0` TypeScript definitions
 * (`ResponseCreateParams`, `ResponseFormatTextJSONSchemaConfig`,
 * `ResponseOutputMessage`) — the published reference was not reachable from the
 * build environment, so no parameter is used that the installed SDK does not
 * declare.
 *
 * The provider validates the response against the caller's Zod schema and
 * returns `data: null` plus the concrete issues when it does not match. It
 * never retries a semantically invalid generation: that decision belongs to the
 * pipeline, which owns the single bounded repair turn.
 */

export interface OpenAiTextProviderOptions {
  client?: OpenAI;
  model?: string;
  retry?: RetryOptions;
  jsonSchema?: StrictJsonSchemaOptions;
  /** Default cap when a request does not set one. */
  maxOutputTokens?: number;
}

function renderIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

function buildRepairPrompt(request: StructuredRequest<unknown>): string {
  const issues = request.repair?.issues ?? [];
  return [
    'Your previous answer did not satisfy the required JSON schema.',
    'Fix exactly these validation errors and return the complete corrected object.',
    'Do not change any content that was already valid, and do not add commentary.',
    '',
    'Validation errors:',
    ...issues.map((issue) => `- ${issue}`),
  ].join('\n');
}

/** Collects the assistant text and any refusal from the Responses output array. */
function readOutput(response: OpenAI.Responses.Response): { text: string; refusal: string | null } {
  let refusal: string | null = null;
  const chunks: string[] = [];

  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'output_text') chunks.push(part.text);
      else if (part.type === 'refusal') refusal = part.refusal;
    }
  }

  const text = chunks.length > 0 ? chunks.join('') : (response.output_text ?? '');
  return { text, refusal };
}

function readFinishReason(response: OpenAI.Responses.Response, refusal: string | null): FinishReason {
  if (refusal !== null) return 'refusal';
  if (response.status === 'incomplete') return 'incomplete';
  return 'completed';
}

/** A 400 naming an unsupported parameter — reasoning models reject `temperature`. */
function isUnsupportedParameter(error: unknown, parameter: string): boolean {
  if (statusOf(error) !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(parameter);
}

export class OpenAiTextProvider implements TextProvider {
  readonly kind = 'openai' as const;
  readonly model: string;

  private readonly options: OpenAiTextProviderOptions;

  constructor(options: OpenAiTextProviderOptions = {}) {
    this.options = options;
    this.model = options.model ?? getModelConfig().text;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const client = this.options.client ?? getOpenAiClient();
    const format = toResponseFormat(request.schemaName, request.schema, this.options.jsonSchema);
    const requestHash = hashUnknown({
      model: this.model,
      schemaName: request.schemaName,
      system: request.systemPrompt,
      user: request.userPrompt,
      repair: request.repair?.issues ?? null,
    });

    const input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: request.userPrompt }];
    if (request.repair) {
      input.push({ role: 'assistant', content: request.repair.previousRaw });
      input.push({ role: 'user', content: buildRepairPrompt(request) });
    }

    const baseParams: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.model,
      instructions: request.systemPrompt,
      input,
      text: { format },
      max_output_tokens: request.maxOutputTokens ?? this.options.maxOutputTokens ?? 16_000,
      store: false,
      stream: false,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    const call = async (withTemperature: boolean): Promise<OpenAI.Responses.Response> =>
      client.responses.create(
        withTemperature && request.temperature !== undefined
          ? { ...baseParams, temperature: request.temperature }
          : baseParams,
      );

    const response = await instrumented(
      'OPENAI',
      `responses.create:${request.schemaName}`,
      () =>
        withRetry(
          async () => {
            try {
              return await call(true);
            } catch (error) {
              // Reasoning models reject `temperature`; retry once without it
              // rather than hard-coding which model ids support the parameter.
              if (request.temperature !== undefined && isUnsupportedParameter(error, 'temperature')) {
                return await call(false);
              }
              throw error;
            }
          },
          { ...this.options.retry, operation: `responses.create:${request.schemaName}` },
        ),
      (value) => ({ id: value.id, status: value.status, model: value.model }),
    );

    const { text, refusal } = readOutput(response);
    const finishReason = readFinishReason(response, refusal);
    const usage = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : null;

    const base = {
      raw: text,
      model: typeof response.model === 'string' ? response.model : this.model,
      finishReason,
      refusal,
      usage,
      requestHash,
    };

    if (finishReason !== 'completed' || text.trim().length === 0) {
      return {
        ...base,
        data: null,
        issues: [
          refusal
            ? `refusal: ${refusal}`
            : `(root): Die Antwort wurde nicht vollständig erzeugt (${response.incomplete_details?.reason ?? finishReason}).`,
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return {
        ...base,
        data: null,
        issues: [`(root): Antwort ist kein gültiges JSON (${(cause as Error).message})`],
      };
    }

    const result = request.schema.safeParse(parsed);
    if (!result.success) {
      return { ...base, data: null, issues: renderIssues(result.error) };
    }
    return { ...base, data: result.data, issues: [] };
  }
}
