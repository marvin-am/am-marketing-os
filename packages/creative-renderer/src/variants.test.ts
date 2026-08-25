import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { CREATIVE_PRINCIPLES, REQUIRED_ASPECT_RATIOS } from '@am/domain';
import {
  FIXTURE_BRAND_PROFILE,
  FIXTURE_COMPARISON_CONCEPT,
  FIXTURE_CONCEPT,
  FIXTURE_IMAGE_MODEL,
  createPlaceholderMotif,
} from './fixtures';
import { RATIO_DIMENSIONS } from './geometry';
import { InMemoryCreativeStorage, storeRenditionAssets } from './storage';
import {
  ASSET_REVIEW_STATE_LABELS_DE,
  approvedRatios,
  isLaunchReady,
  missingRequiredRatios,
  pendingRequiredRatios,
  renderAllFormats,
  setVariantReviewState,
  templateForPrinciple,
  variantFor,
  variantSetSummaryDe,
  type CreativeVariantSet,
} from './variants';
import { TEMPLATE_IDS } from './types';

const TIMEOUT = 60_000;

let motif: Buffer;
let feedOnly: CreativeVariantSet;

beforeAll(async () => {
  motif = await createPlaceholderMotif({ width: 1300, height: 1000 });
  feedOnly = await renderAllFormats(FIXTURE_CONCEPT, FIXTURE_BRAND_PROFILE, {
    motif,
    imageModel: FIXTURE_IMAGE_MODEL,
  });
}, TIMEOUT);

describe('templateForPrinciple', () => {
  it('maps every principle to a known template', () => {
    for (const principle of CREATIVE_PRINCIPLES) {
      expect(TEMPLATE_IDS).toContain(templateForPrinciple(principle));
    }
  });

  it('sends a data point to the figure layout and a comparison to the columns', () => {
    expect(templateForPrinciple('PROOF_CASE_DATAPOINT')).toBe('data-point');
    expect(templateForPrinciple('COMPARISON_ALTERNATIVE')).toBe('comparison');
  });
});

describe('renderAllFormats', () => {
  it('renders both required formats by default', () => {
    expect(feedOnly.variants.map((variant) => variant.aspectRatio)).toEqual([
      ...REQUIRED_ASPECT_RATIOS,
    ]);
    expect(missingRequiredRatios(feedOnly)).toEqual([]);
    for (const variant of feedOnly.variants) {
      expect(variant.required).toBe(true);
      expect(variant.reviewState).toBe('DRAFT');
      expect(variant.reviewNoteDe).toBeNull();
      expect(variant.contrastPasses).toBe(true);
    }
  });

  it(
    'produces real bytes at the right dimensions per format',
    async () => {
      for (const variant of feedOnly.variants) {
        const expected = RATIO_DIMENSIONS[variant.aspectRatio];
        const jpeg = await sharp(variant.jpeg).metadata();
        const webp = await sharp(variant.webp).metadata();
        expect({ width: jpeg.width, height: jpeg.height }).toEqual(expected);
        expect({ width: webp.width, height: webp.height }).toEqual(expected);
        expect(variant.svg).toContain('<svg');
      }
    },
    TIMEOUT,
  );

  it(
    'adds the story format when the concept asks for it',
    async () => {
      const withStory = await renderAllFormats(
        { ...FIXTURE_CONCEPT, aspectRatios: ['1:1', '4:5', '9:16'] },
        FIXTURE_BRAND_PROFILE,
        { motif, imageModel: FIXTURE_IMAGE_MODEL },
      );
      expect(withStory.variants.map((v) => v.aspectRatio)).toEqual(['1:1', '4:5', '9:16']);
      expect(variantFor(withStory, '9:16')?.required).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'adds the story format on explicit request',
    async () => {
      const withStory = await renderAllFormats(FIXTURE_CONCEPT, FIXTURE_BRAND_PROFILE, {
        motif,
        imageModel: FIXTURE_IMAGE_MODEL,
        includeStory: true,
      });
      expect(withStory.variants).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    'picks the template from the principle and reports it in German',
    async () => {
      expect(feedOnly.template).toBe('data-point');
      expect(feedOnly.templateLabelDe).toContain('Kennzahl');

      const comparison = await renderAllFormats(
        FIXTURE_COMPARISON_CONCEPT,
        FIXTURE_BRAND_PROFILE,
        { motif, imageModel: FIXTURE_IMAGE_MODEL, ratios: ['1:1'] },
      );
      expect(comparison.template).toBe('comparison');
    },
    TIMEOUT,
  );

  it('shares one alt text and one source hash across all formats', () => {
    expect(feedOnly.altText.length).toBeGreaterThan(10);
    for (const variant of feedOnly.variants) {
      expect(variant.rendition.altText).toBe(feedOnly.altText);
      expect(variant.rendition.sourceAssetHash).toBe(feedOnly.sourceAssetHash);
      expect(variant.rendition.provenance.imageModel).toBe(FIXTURE_IMAGE_MODEL);
    }
  });

  it(
    'honours an explicit template and content override',
    async () => {
      const set = await renderAllFormats(FIXTURE_CONCEPT, FIXTURE_BRAND_PROFILE, {
        motif,
        imageModel: FIXTURE_IMAGE_MODEL,
        template: 'quote-proof',
        ratios: ['1:1'],
        contentOverrides: { attributionName: 'Sabine Roth', attributionRole: 'Geschäftsführerin' },
      });
      expect(set.template).toBe('quote-proof');
      expect(set.variants[0]!.svg).toContain('Sabine Roth');
      expect(set.variants[0]!.svg).toContain('Geschäftsführerin');
    },
    TIMEOUT,
  );
});

describe('per-format approval', () => {
  it('approves one format without touching the others', () => {
    const afterFirst = setVariantReviewState(feedOnly, '1:1', 'APPROVED');
    expect(approvedRatios(afterFirst)).toEqual(['1:1']);
    expect(variantFor(afterFirst, '4:5')?.reviewState).toBe('DRAFT');
    // The original set is untouched.
    expect(approvedRatios(feedOnly)).toEqual([]);
    expect(variantFor(afterFirst, '1:1')?.rendition.reviewState).toBe('APPROVED');
  });

  it('only becomes launch-ready once both required formats are approved', () => {
    expect(isLaunchReady(feedOnly)).toBe(false);
    const half = setVariantReviewState(feedOnly, '1:1', 'APPROVED');
    expect(isLaunchReady(half)).toBe(false);
    expect(pendingRequiredRatios(half)).toEqual(['4:5']);
    const full = setVariantReviewState(half, '4:5', 'APPROVED');
    expect(isLaunchReady(full)).toBe(true);
    expect(pendingRequiredRatios(full)).toEqual([]);
  });

  it('an optional story format never blocks the launch', async () => {
    const withStory = await renderAllFormats(FIXTURE_CONCEPT, FIXTURE_BRAND_PROFILE, {
      motif,
      imageModel: FIXTURE_IMAGE_MODEL,
      includeStory: true,
    });
    const approved = setVariantReviewState(
      setVariantReviewState(withStory, '1:1', 'APPROVED'),
      '4:5',
      'APPROVED',
    );
    expect(variantFor(approved, '9:16')?.reviewState).toBe('DRAFT');
    expect(isLaunchReady(approved)).toBe(true);

    const rejectedStory = setVariantReviewState(approved, '9:16', 'REJECTED', 'Text zu nah am UI.');
    expect(isLaunchReady(rejectedStory)).toBe(true);
    expect(variantFor(rejectedStory, '9:16')?.reviewNoteDe).toBe('Text zu nah am UI.');
  }, TIMEOUT);

  it('requires a reason for a rejection', () => {
    expect(() => setVariantReviewState(feedOnly, '1:1', 'REJECTED')).toThrow(/Begründung/);
    expect(() => setVariantReviewState(feedOnly, '1:1', 'REJECTED', '   ')).toThrow(/Begründung/);
  });

  it('refuses to review a format that was never rendered', () => {
    expect(() => setVariantReviewState(feedOnly, '9:16', 'APPROVED')).toThrow(/keine Variante/);
  });

  it('summarises the state in German', () => {
    expect(variantSetSummaryDe(feedOnly)).toContain('0/2');
    const full = setVariantReviewState(
      setVariantReviewState(feedOnly, '1:1', 'APPROVED'),
      '4:5',
      'APPROVED',
    );
    expect(variantSetSummaryDe(full)).toContain('startbereit');
    expect(variantSetSummaryDe(setVariantReviewState(feedOnly, '1:1', 'APPROVED'))).toContain(
      'offen: 4:5',
    );
  });

  it('labels every review state in German', () => {
    expect(ASSET_REVIEW_STATE_LABELS_DE.APPROVED).toBe('Freigegeben');
    expect(Object.values(ASSET_REVIEW_STATE_LABELS_DE)).toHaveLength(4);
  });
});

describe('variants and storage', () => {
  it('stores every rendered format under a distinct path', async () => {
    const storage = new InMemoryCreativeStorage();
    for (const variant of feedOnly.variants) {
      await storeRenditionAssets(storage, variant.rendition, {
        jpeg: variant.jpeg,
        webp: variant.webp,
      });
    }
    expect(storage.size).toBe(feedOnly.variants.length * 2);
    expect(new Set(storage.list().map((object) => object.path)).size).toBe(storage.size);
  });
});
