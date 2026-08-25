import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { brandProfileSchema, creativeConceptSchema } from '@am/domain';
import { sha256Bytes } from './compose';
import {
  FIXTURE_ALT_BRAND_PROFILE,
  FIXTURE_BRAND_PROFILE,
  FIXTURE_COMPARISON_CONCEPT,
  FIXTURE_CONCEPT,
  FIXTURE_IMAGE_MODEL,
  createBrightMotif,
  createPlaceholderMotif,
  exampleRenderRequest,
  exampleRenderRequests,
} from './fixtures';
import { TEMPLATE_IDS, creativeRenderRequestSchema } from './types';

const TIMEOUT = 60_000;

describe('createPlaceholderMotif', () => {
  it('generates a real image with the requested dimensions', async () => {
    const motif = await createPlaceholderMotif({ width: 640, height: 480 });
    const metadata = await sharp(motif).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(480);
  });

  it('is byte-identical for the same seed and different for another', async () => {
    const [a, b, c] = await Promise.all([
      createPlaceholderMotif({ width: 320, height: 320, seed: 7 }),
      createPlaceholderMotif({ width: 320, height: 320, seed: 7 }),
      createPlaceholderMotif({ width: 320, height: 320, seed: 8 }),
    ]);
    expect(await sha256Bytes(b)).toBe(await sha256Bytes(a));
    expect(await sha256Bytes(c)).not.toBe(await sha256Bytes(a));
  });

  it('has real tonal range, so the contrast solver has something to work with', async () => {
    const motif = await createPlaceholderMotif({ width: 400, height: 400 });
    const stats = await sharp(motif).stats();
    expect(stats.channels[0]!.stdev).toBeGreaterThan(10);
    expect(stats.channels[0]!.max).toBeGreaterThan(stats.channels[0]!.min + 60);
  });

  it('creates a near-white motif on demand', async () => {
    const stats = await sharp(await createBrightMotif(200)).stats();
    expect(stats.channels[0]!.mean).toBeGreaterThan(240);
  });
});

describe('fixture data', () => {
  it('matches the domain schemas', () => {
    expect(() => brandProfileSchema.parse(FIXTURE_BRAND_PROFILE)).not.toThrow();
    expect(() => brandProfileSchema.parse(FIXTURE_ALT_BRAND_PROFILE)).not.toThrow();
    expect(() => creativeConceptSchema.parse(FIXTURE_CONCEPT)).not.toThrow();
    expect(() => creativeConceptSchema.parse(FIXTURE_COMPARISON_CONCEPT)).not.toThrow();
  });

  it('uses A&M’s default palette and a distinct second brand', () => {
    expect(FIXTURE_BRAND_PROFILE.colors.primary).toBe('#D7182A');
    expect(FIXTURE_ALT_BRAND_PROFILE.colors.primary).not.toBe('#D7182A');
  });

  it('never pretends a real image model ran', () => {
    expect(FIXTURE_IMAGE_MODEL.startsWith('fixture:')).toBe(true);
  });

  it('keeps typography out of the motif prompt', () => {
    expect(FIXTURE_CONCEPT.imagePrompt.toLowerCase()).toContain('keinerlei text');
    expect(FIXTURE_CONCEPT.imagePrompt.toLowerCase()).toContain('keine logos');
  });
});

describe('example requests', () => {
  it(
    'produces a valid request without touching the network',
    async () => {
      const request = await exampleRenderRequest();
      expect(() => creativeRenderRequestSchema.parse(request)).not.toThrow();
      expect(request.motif.kind).toBe('BUFFER');
      expect(request.provenance.renderedAt).toBe('2026-01-15T09:00:00.000Z');
    },
    TIMEOUT,
  );

  it(
    'covers every template',
    async () => {
      const requests = await exampleRenderRequests();
      expect(requests.map((request) => request.template)).toEqual([...TEMPLATE_IDS]);
      for (const request of requests) {
        expect(request.ratios).toEqual(['1:1', '4:5', '9:16']);
        expect(request.altText.length).toBeGreaterThan(10);
      }
    },
    TIMEOUT,
  );
});
