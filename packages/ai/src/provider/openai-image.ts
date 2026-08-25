import { getModelConfig } from '@am/config';
import { DomainError } from '@am/domain';
import { instrumented } from '@am/observability';
import type OpenAI from 'openai';
import { shortHash } from '../hash';
import { getOpenAiClient } from './openai-client';
import { withRetry, type RetryOptions } from './retry';
import { ASPECT_RATIO_SIZES, type ImageProvider, type ImageRequest, type ImageResult } from './types';

/**
 * `ImageProvider` backed by the images API (`client.images.generate`), using
 * whichever model `@am/config` maps to the image capability.
 *
 * Base64 is requested explicitly: a signed URL would expire before an asset
 * review is finished, and storing a provider URL as if it were our asset would
 * make the creative library silently rot.
 */

export interface OpenAiImageProviderOptions {
  client?: OpenAI;
  model?: string;
  retry?: RetryOptions;
}

const MIME_TYPES: Readonly<Record<'png' | 'jpeg' | 'webp', string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export class OpenAiImageProvider implements ImageProvider {
  readonly kind = 'openai' as const;
  readonly model: string;

  private readonly options: OpenAiImageProviderOptions;

  constructor(options: OpenAiImageProviderOptions = {}) {
    this.options = options;
    this.model = options.model ?? getModelConfig().image;
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const client = this.options.client ?? getOpenAiClient();
    const size = ASPECT_RATIO_SIZES[request.aspectRatio];
    const outputFormat = request.outputFormat ?? 'png';

    const response = await instrumented(
      'OPENAI',
      'images.generate',
      () =>
        withRetry(
          () =>
            client.images.generate({
              model: this.model,
              prompt: request.prompt,
              n: 1,
              size,
              quality: request.quality ?? 'high',
              background: request.background ?? 'auto',
              output_format: outputFormat,
              stream: false,
            }),
          { ...this.options.retry, operation: 'images.generate' },
        ),
      (value) => ({ created: value.created, count: value.data?.length ?? 0 }),
    );

    const first = response.data?.[0];
    if (!first?.b64_json) {
      throw new DomainError('PROVIDER_ERROR', {
        messageDe: 'Der Bildanbieter hat kein Bild zurückgegeben.',
        details: { model: this.model, size },
      });
    }

    const [pixelWidth, pixelHeight] = size.split('x').map(Number) as [number, number];

    return {
      base64: first.b64_json,
      mimeType: MIME_TYPES[outputFormat],
      model: this.model,
      size,
      pixelWidth,
      pixelHeight,
      aspectRatio: request.aspectRatio,
      promptHash: shortHash(request.prompt, 16),
      revisedPrompt: first.revised_prompt ?? null,
    };
  }
}
