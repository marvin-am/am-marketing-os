import { seedFrom, seededRandom, shortHash } from '../hash';
import { encodePngRgb, toBase64 } from './png';
import { ASPECT_RATIO_SIZES, type ImageProvider, type ImageRequest, type ImageResult } from './types';

/**
 * Deterministic image fixture.
 *
 * Produces a real, decodable PNG whose colours and gradient direction are
 * derived from a hash of the prompt, so the same concept always yields the same
 * bytes and two different concepts are visibly different in a review grid.
 *
 * It renders a deliberately small proxy rather than a full 1024 px canvas —
 * `pixelWidth`/`pixelHeight` report the truth and `size` reports the API size
 * the request maps to, so nothing downstream can mistake a placeholder for a
 * generated asset. `model` says `fixture-image-v1` for the same reason.
 */

export interface FixtureImageProviderOptions {
  /** Longest edge of the rendered proxy, in pixels. Defaults to 128. */
  longEdge?: number;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6] as [number, number, number];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export class FixtureImageProvider implements ImageProvider {
  readonly kind = 'fixture' as const;
  readonly model = 'fixture-image-v1';

  private readonly longEdge: number;

  constructor(options: FixtureImageProviderOptions = {}) {
    this.longEdge = options.longEdge ?? 128;
  }

  generateImage(request: ImageRequest): Promise<ImageResult> {
    const size = ASPECT_RATIO_SIZES[request.aspectRatio];
    const [apiWidth, apiHeight] = size.split('x').map(Number) as [number, number];
    const scale = this.longEdge / Math.max(apiWidth, apiHeight);
    const width = Math.max(8, Math.round(apiWidth * scale));
    const height = Math.max(8, Math.round(apiHeight * scale));

    const seed = seedFrom(`${request.prompt}|${request.aspectRatio}`);
    const random = seededRandom(seed);
    const baseHue = random();
    const accentHue = (baseHue + 0.25 + random() * 0.4) % 1;
    const diagonal = random() > 0.5;

    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = diagonal ? (x / width + y / height) / 2 : y / height;
        const hue = baseHue + (accentHue - baseHue) * t;
        const [r, g, b] = hsvToRgb((hue + 1) % 1, 0.35 + 0.25 * t, 0.45 + 0.4 * (1 - t));
        const offset = (y * width + x) * 3;
        rgb[offset] = r;
        rgb[offset + 1] = g;
        rgb[offset + 2] = b;
      }
    }

    return Promise.resolve({
      base64: toBase64(encodePngRgb(width, height, rgb)),
      mimeType: 'image/png',
      model: this.model,
      size,
      pixelWidth: width,
      pixelHeight: height,
      aspectRatio: request.aspectRatio,
      promptHash: shortHash(request.prompt, 16),
      revisedPrompt: null,
    });
  }
}
