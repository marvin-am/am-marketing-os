import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ASPECT_RATIOS,
  REQUIRED_ASPECT_RATIOS,
  brandProfileSchema,
  type AspectRatio,
} from '@am/domain';
import { composeCreative, loadMotif, recrop, replaceBaseMotif, sha256Bytes } from './compose';
import { RATIO_DIMENSIONS } from './geometry';
import {
  FIXTURE_ALT_BRAND_PROFILE,
  FIXTURE_BRAND_PROFILE,
  createBrightMotif,
  createPlaceholderMotif,
  exampleRenderRequest,
} from './fixtures';
import { assertWellFormedSvg } from './xml';
import { motifFromPath, renditionKeyFor, type CreativeRenderRequest } from './types';

const TIMEOUT = 60_000;

let motif: Buffer;
let request: CreativeRenderRequest;

beforeAll(async () => {
  motif = await createPlaceholderMotif({ width: 1400, height: 1100 });
  request = await exampleRenderRequest({ motif, ratios: [...ASPECT_RATIOS] });
}, TIMEOUT);

describe('composeCreative', () => {
  it(
    'produces exactly the expected pixel dimensions for every ratio',
    async () => {
      const result = await composeCreative(request);
      expect(result.renditions).toHaveLength(3);

      for (const ratio of ASPECT_RATIOS) {
        const expected = RATIO_DIMENSIONS[ratio];
        const asset = result.assets.find((entry) => entry.aspectRatio === ratio);
        expect(asset, `missing asset for ${ratio}`).toBeDefined();

        const jpegMeta = await sharp(asset!.jpeg).metadata();
        expect({ width: jpegMeta.width, height: jpegMeta.height }).toEqual(expected);
        expect(jpegMeta.format).toBe('jpeg');

        const webpMeta = await sharp(asset!.webp).metadata();
        expect({ width: webpMeta.width, height: webpMeta.height }).toEqual(expected);
        expect(webpMeta.format).toBe('webp');

        const rendition = result.renditions.find((entry) => entry.aspectRatio === ratio)!;
        expect(rendition.width).toBe(expected.width);
        expect(rendition.height).toBe(expected.height);
        expect(rendition.outputs.jpeg.contentType).toBe('image/jpeg');
        expect(rendition.outputs.webp.contentType).toBe('image/webp');
        expect(rendition.outputs.jpeg.byteLength).toBe(asset!.jpeg.byteLength);
        expect(rendition.outputs.webp.byteLength).toBe(asset!.webp.byteLength);
      }
    },
    TIMEOUT,
  );

  it(
    'is deterministic: the same request yields identical output hashes',
    async () => {
      const first = await composeCreative(request);
      const second = await composeCreative(request);

      expect(second.renditions.map((r) => r.outputHash)).toEqual(
        first.renditions.map((r) => r.outputHash),
      );
      for (const [index, asset] of first.assets.entries()) {
        expect(await sha256Bytes(second.assets[index]!.jpeg)).toBe(await sha256Bytes(asset.jpeg));
        expect(await sha256Bytes(second.assets[index]!.webp)).toBe(await sha256Bytes(asset.webp));
        expect(second.assets[index]!.svg).toBe(asset.svg);
      }
    },
    TIMEOUT,
  );

  it(
    'hashes the source, both outputs and their combination',
    async () => {
      const result = await composeCreative(request);
      expect(result.sourceAssetHash).toBe(await sha256Bytes(motif));
      for (const [index, rendition] of result.renditions.entries()) {
        const asset = result.assets[index]!;
        expect(rendition.outputs.jpeg.sha256).toBe(await sha256Bytes(asset.jpeg));
        expect(rendition.outputs.webp.sha256).toBe(await sha256Bytes(asset.webp));
        expect(rendition.outputHash).toMatch(/^[0-9a-f]{64}$/);
        expect(rendition.sourceAssetHash).toBe(result.sourceAssetHash);
      }
      // Different ratios of the same motif are different assets.
      expect(new Set(result.renditions.map((r) => r.outputHash)).size).toBe(3);
    },
    TIMEOUT,
  );

  it(
    'records full provenance and a stable rendition key on every rendition',
    async () => {
      const result = await composeCreative(request);
      for (const rendition of result.renditions) {
        expect(rendition.renditionKey).toBe(
          renditionKeyFor(request.conceptKey, request.template, rendition.aspectRatio),
        );
        expect(rendition.provenance.imageModel).toBe(request.provenance.imageModel);
        expect(rendition.provenance.imagePrompt).toBe(request.provenance.imagePrompt);
        expect(rendition.provenance.creativeVersion).toBe(1);
        expect(rendition.provenance.principle).toBe(request.provenance.principle);
        expect(rendition.provenance.rendererVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(rendition.provenance.renderedAt).toBe(request.provenance.renderedAt);
        expect(rendition.mediaKind).toBe('IMAGE');
        expect(rendition.reviewState).toBe('DRAFT');
        expect(rendition.altText.length).toBeGreaterThan(10);
        expect(rendition.brandTokens.primary).toBe(request.brand.colors.primary);
      }
    },
    TIMEOUT,
  );

  it(
    'verifies WCAG AA contrast and reports the achieved ratio',
    async () => {
      const result = await composeCreative(request);
      for (const rendition of result.renditions) {
        expect(rendition.contrast.passes).toBe(true);
        expect(rendition.contrast.ratio).toBeGreaterThanOrEqual(rendition.contrast.target);
        expect(rendition.contrast.effectiveBackdrop).toMatch(/^#[0-9A-F]{6}$/);
        expect(rendition.contrast.sampledBackdrop).toMatch(/^#[0-9A-F]{6}$/);
        expect(rendition.contrast.scrimOpacity).toBeGreaterThanOrEqual(0);
        expect(rendition.contrast.scrimOpacity).toBeLessThanOrEqual(1);
      }
    },
    TIMEOUT,
  );

  it(
    'samples the motif rather than assuming a backdrop',
    async () => {
      const bright = await createBrightMotif(1200);
      const onBright = await composeCreative(
        await exampleRenderRequest({ motif: bright, ratios: ['1:1'], template: 'bold-statement' }),
      );
      const onNormal = await composeCreative({ ...request, ratios: ['1:1'] });

      const brightBackdrop = onBright.renditions[0]!.contrast.sampledBackdrop;
      const normalBackdrop = onNormal.renditions[0]!.contrast.sampledBackdrop;
      expect(brightBackdrop).not.toBe(normalBackdrop);
      expect(Number.parseInt(brightBackdrop.slice(1, 3), 16)).toBeGreaterThan(
        Number.parseInt(normalBackdrop.slice(1, 3), 16),
      );
      expect(onBright.renditions[0]!.contrast.passes).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'fixes a white-on-white palette by swapping the scrim colour',
    async () => {
      // A brand whose overlay text and scrim are both white: on a near-white
      // motif that is a 1:1 contrast ratio, i.e. invisible copy.
      const pathological = brandProfileSchema.parse({
        ...FIXTURE_BRAND_PROFILE,
        id: '33333333-3333-4333-8333-333333333333',
        colors: {
          primary: '#D7182A',
          foreground: '#111111',
          background: '#FFFFFF',
          accent: '#FFFFFF',
        },
      });
      const bright = await createBrightMotif(1200);
      const result = await composeCreative(
        await exampleRenderRequest({
          motif: bright,
          brand: pathological,
          ratios: ['1:1'],
          template: 'bold-statement',
        }),
      );

      const contrast = result.renditions[0]!.contrast;
      expect(contrast.passes).toBe(true);
      expect(contrast.ratio).toBeGreaterThanOrEqual(contrast.target);
      expect(contrast.scrimColor).not.toBe('#FFFFFF');
      expect(contrast.adjustments.join(' ')).toMatch(/Overlay-Farbe|Textfarbe/);
      expect(result.warnings.some((warning) => warning.includes('Overlay-Farbe'))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'emits a well-formed SVG overlay alongside the raster output',
    async () => {
      const result = await composeCreative({ ...request, ratios: ['4:5'] });
      const root = assertWellFormedSvg(result.assets[0]!.svg);
      expect(root.attributes.width).toBe('1080');
      expect(root.attributes.height).toBe('1350');
    },
    TIMEOUT,
  );

  it(
    'carries a foreign brand palette through to the pixels',
    async () => {
      const alt = await exampleRenderRequest({
        motif,
        brand: FIXTURE_ALT_BRAND_PROFILE,
        ratios: ['1:1'],
      });
      const result = await composeCreative(alt);
      expect(result.renditions[0]!.brandTokens.primary).toBe(
        FIXTURE_ALT_BRAND_PROFILE.colors.primary,
      );
      expect(result.assets[0]!.svg).toContain(FIXTURE_ALT_BRAND_PROFILE.colors.primary);
      expect(result.assets[0]!.svg).not.toContain('#D7182A');
    },
    TIMEOUT,
  );

  it('renders only the requested ratios and deduplicates them', async () => {
    const result = await composeCreative({
      ...request,
      ratios: ['4:5', '4:5', '1:1'] as AspectRatio[],
    });
    expect(result.renditions.map((r) => r.aspectRatio)).toEqual(['4:5', '1:1']);
  }, TIMEOUT);

  it('covers both ratios Meta requires at launch', async () => {
    const result = await composeCreative(request);
    for (const ratio of REQUIRED_ASPECT_RATIOS) {
      expect(result.renditions.some((r) => r.aspectRatio === ratio)).toBe(true);
    }
  }, TIMEOUT);

  it('reads a motif from disk as well as from memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'am-creative-'));
    const file = join(dir, 'motif.png');
    await writeFile(file, motif);
    const fromDisk = await composeCreative({
      ...request,
      motif: motifFromPath(file),
      ratios: ['1:1'],
    });
    const fromMemory = await composeCreative({ ...request, ratios: ['1:1'] });
    expect(fromDisk.renditions[0]!.outputHash).toBe(fromMemory.renditions[0]!.outputHash);
  }, TIMEOUT);

  it('refuses an unreadable motif instead of rendering a placeholder', async () => {
    await expect(
      composeCreative({ ...request, motif: { kind: 'BUFFER', data: Buffer.from('nicht-bild') } }),
    ).rejects.toThrow(/kein lesbares Bild/);
    await expect(loadMotif({ kind: 'FILE', path: '/does/not/exist.png' })).rejects.toThrow(
      /nicht gelesen/,
    );
    await expect(
      composeCreative({ ...request, motif: { kind: 'BUFFER', data: new Uint8Array(0) } }),
    ).rejects.toThrow(/leer/);
  }, TIMEOUT);

  it('rejects an invalid request at the boundary', async () => {
    await expect(composeCreative({ ...request, template: 'nope' } as never)).rejects.toThrow();
    await expect(
      composeCreative({ ...request, focusPoint: { x: 4, y: 0 } } as never),
    ).rejects.toThrow();
  });
});

describe('recrop', () => {
  it(
    'changes the pixels but nothing else',
    async () => {
      const single = { ...request, ratios: ['1:1'] as AspectRatio[] };
      const centred = await composeCreative({ ...single, focusPoint: { x: 0.5, y: 0.5 } });
      const shifted = await recrop(single as CreativeRenderRequest, { x: 0.1, y: 0.9 });

      expect(shifted.renditions[0]!.outputHash).not.toBe(centred.renditions[0]!.outputHash);
      expect(shifted.renditions[0]!.focusPoint).toEqual({ x: 0.1, y: 0.9 });
      expect(shifted.renditions[0]!.altText).toBe(centred.renditions[0]!.altText);
      expect(shifted.renditions[0]!.provenance).toEqual(centred.renditions[0]!.provenance);
      expect(shifted.sourceAssetHash).toBe(centred.sourceAssetHash);
      expect(shifted.renditions[0]!.width).toBe(1080);
    },
    TIMEOUT,
  );

  it(
    'can be limited to a single ratio',
    async () => {
      const result = await recrop(request, { x: 0.3, y: 0.3 }, { ratios: ['9:16'] });
      expect(result.renditions).toHaveLength(1);
      expect(result.renditions[0]!.aspectRatio).toBe('9:16');
      expect(result.renditions[0]!.height).toBe(1920);
    },
    TIMEOUT,
  );
});

describe('replaceBaseMotif', () => {
  it(
    'renders a new source and records the new provenance',
    async () => {
      const replacement = await createPlaceholderMotif({
        width: 1200,
        height: 1200,
        seed: 99,
        from: '#402015',
        to: '#C9B8A0',
      });
      const result = await replaceBaseMotif(
        request,
        { kind: 'BUFFER', data: replacement },
        {
          ratios: ['1:1'],
          provenance: { imagePrompt: 'Zweiter Versuch, wärmeres Licht.', creativeVersion: 2 },
        },
      );

      expect(result.sourceAssetHash).toBe(await sha256Bytes(replacement));
      expect(result.sourceAssetHash).not.toBe(await sha256Bytes(motif));
      expect(result.renditions[0]!.provenance.imagePrompt).toBe(
        'Zweiter Versuch, wärmeres Licht.',
      );
      expect(result.renditions[0]!.provenance.creativeVersion).toBe(2);
      // Untouched provenance fields survive the swap.
      expect(result.renditions[0]!.provenance.imageModel).toBe(request.provenance.imageModel);
    },
    TIMEOUT,
  );
});
