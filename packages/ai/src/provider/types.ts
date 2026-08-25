import { type AspectRatio } from '@am/domain';
import { type z } from 'zod';

/**
 * Capability-based provider interfaces (spec §5).
 *
 * Business logic asks for a *capability* — text, image, embedding — never for a
 * model. Which model serves a capability is decided once, by `@am/config`, and
 * is visible to callers only as an opaque string on the result.
 */

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export interface RepairContext {
  /** The raw text the model returned that failed validation. */
  previousRaw: string;
  /** Human-readable Zod issues, fed back verbatim so the model can correct. */
  issues: string[];
}

export interface StructuredRequest<T> {
  /** Contract the response is validated against. The only authority. */
  schema: z.ZodType<T>;
  /** Stable name for the response format; also selects fixture content. */
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  /** Omitted for reasoning models that reject the parameter. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Present on the single bounded repair turn. */
  repair?: RepairContext;
  /** Small, non-PII key/value pairs recorded with the provider call. */
  metadata?: Record<string, string>;
}

export type FinishReason = 'completed' | 'incomplete' | 'refusal';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredResult<T> {
  /** Parsed *and* schema-validated payload. `null` whenever validation failed. */
  data: T | null;
  /** The raw model text, kept so a repair turn can quote it back. */
  raw: string;
  /** Zod issues rendered as `path: message`. Empty when `data` is set. */
  issues: string[];
  model: string;
  finishReason: FinishReason;
  /** Set when the model declined; already German-safe for display. */
  refusal: string | null;
  usage: TokenUsage | null;
  /** Stable hash of the request, recorded on the `ai_jobs` row. */
  requestHash: string;
}

export interface TextProvider {
  readonly kind: 'openai' | 'fixture';
  /** Model id serving the text capability — for the `ai_jobs.model` column. */
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/* -------------------------------------------------------------------------- */
/* Image                                                                       */
/* -------------------------------------------------------------------------- */

export type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';

/** Meta placements map onto the three sizes the images API renders natively. */
export const ASPECT_RATIO_SIZES: Readonly<Record<AspectRatio, ImageSize>> = {
  '1:1': '1024x1024',
  '4:5': '1024x1536',
  '9:16': '1024x1536',
};

export interface ImageRequest {
  /** Base motif only — no text, no logo, no UI typography (spec §13). */
  prompt: string;
  aspectRatio: AspectRatio;
  quality?: 'low' | 'medium' | 'high';
  background?: 'transparent' | 'opaque' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
}

export interface ImageResult {
  /** Base64-encoded image bytes, without a data-URI prefix. */
  base64: string;
  mimeType: string;
  model: string;
  /** The API-level size the request mapped to. */
  size: ImageSize;
  /** Actual pixel dimensions of `base64`. A fixture renders a smaller proxy. */
  pixelWidth: number;
  pixelHeight: number;
  aspectRatio: AspectRatio;
  /** Hash of the prompt actually sent — the provenance link to the concept. */
  promptHash: string;
  /** Prompt the provider rewrote to, when it reports one. */
  revisedPrompt: string | null;
}

export interface ImageProvider {
  readonly kind: 'openai' | 'fixture';
  readonly model: string;
  generateImage(request: ImageRequest): Promise<ImageResult>;
}

/* -------------------------------------------------------------------------- */
/* Embeddings                                                                  */
/* -------------------------------------------------------------------------- */

export interface EmbeddingProvider {
  readonly kind: 'openai' | 'fixture';
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
