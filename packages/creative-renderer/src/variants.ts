/**
 * Per-format variants and their individual approval state.
 *
 * A creative is not one file. Meta needs 1:1 and 4:5 for feed, optionally 9:16
 * for Stories and Reels, and the 9:16 crop is exactly the one a reviewer is most
 * likely to reject — a headline that reads perfectly in the square can collide
 * with the story UI. So approval is tracked per format: an operator can approve
 * the two feed formats and send the story crop back for a re-crop without
 * blocking the launch.
 */

import {
  REQUIRED_ASPECT_RATIOS,
  type AspectRatio,
  type AssetReviewState,
  type BrandProfile,
  type CreativeConcept,
  type CreativePrinciple,
} from '@am/domain';
import { altTextForConcept } from './alt-text';
import { composeCreative } from './compose';
import { contentFromConcept } from './content';
import {
  RENDERER_VERSION,
  TEMPLATE_LABELS_DE,
  TEMPLATE_PRINCIPLE_AFFINITY,
  creativeRenderRequestSchema,
  motifFromBuffer,
  type BaseMotif,
  type CreativeContent,
  type CreativeRendition,
  type CreativeRenderRequest,
  type FocusPointInput,
  type OutputQuality,
  type TemplateId,
} from './types';

export const ASSET_REVIEW_STATE_LABELS_DE: Readonly<Record<AssetReviewState, string>> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  APPROVED: 'Freigegeben',
  REJECTED: 'Abgelehnt',
};

export interface FormatVariant {
  aspectRatio: AspectRatio;
  /** True for the ratios Meta requires at launch (1:1 and 4:5). */
  required: boolean;
  rendition: CreativeRendition;
  jpeg: Buffer;
  webp: Buffer;
  svg: string;
  reviewState: AssetReviewState;
  reviewNoteDe: string | null;
  /** Mirrors `rendition.contrast.passes` for a quick list view. */
  contrastPasses: boolean;
}

export interface CreativeVariantSet {
  conceptKey: string;
  template: TemplateId;
  templateLabelDe: string;
  sourceAssetHash: string;
  altText: string;
  variants: FormatVariant[];
  warnings: string[];
}

/** Deterministic template choice when the operator did not pick one. */
export function templateForPrinciple(principle: CreativePrinciple): TemplateId {
  for (const [id, principles] of Object.entries(TEMPLATE_PRINCIPLE_AFFINITY)) {
    if (principles.includes(principle)) return id as TemplateId;
  }
  return 'bold-statement';
}

export interface RenderAllFormatsOptions {
  /** The base motif from the image model. */
  motif: BaseMotif | Uint8Array;
  /** Which model produced the motif. Required — never inferred, never faked. */
  imageModel: string;
  imagePrompt?: string;
  imageParameters?: Record<string, string | number | boolean | null>;
  creativeVersion?: number;
  promptVersionId?: string | null;
  aiJobId?: string | null;
  renderedAt?: string;
  template?: TemplateId;
  /** Explicit ratio list; otherwise the required pair plus 9:16 when asked for. */
  ratios?: readonly AspectRatio[];
  includeStory?: boolean;
  focusPoint?: FocusPointInput;
  quality?: Partial<OutputQuality>;
  contentOverrides?: Partial<CreativeContent>;
  brandTokenOverrides?: { fontStack?: string; wordmark?: string | null };
  initialReviewState?: AssetReviewState;
}

function resolveRatios(
  concept: CreativeConcept,
  options: RenderAllFormatsOptions,
): AspectRatio[] {
  if (options.ratios) return [...new Set(options.ratios)];
  const ratios: AspectRatio[] = [...REQUIRED_ASPECT_RATIOS];
  const wantsStory = options.includeStory === true || concept.aspectRatios.includes('9:16');
  if (wantsStory) ratios.push('9:16');
  return [...new Set(ratios)];
}

function toMotif(motif: BaseMotif | Uint8Array): BaseMotif {
  return motif instanceof Uint8Array ? motifFromBuffer(motif) : motif;
}

/**
 * Renders every required format (plus the optional story format) from one motif,
 * and returns them with per-format review state attached.
 */
export async function renderAllFormats(
  concept: CreativeConcept,
  brand: BrandProfile,
  options: RenderAllFormatsOptions,
): Promise<CreativeVariantSet> {
  const template = options.template ?? templateForPrinciple(concept.principle);
  const content = contentFromConcept(concept, {
    brandName: brand.name,
    overrides: options.contentOverrides,
  });
  const altText = altTextForConcept(concept, template, content);
  const ratios = resolveRatios(concept, options);
  const initialReviewState = options.initialReviewState ?? 'DRAFT';

  const request: CreativeRenderRequest = creativeRenderRequestSchema.parse({
    conceptKey: concept.key,
    template,
    ratios,
    motif: toMotif(options.motif),
    focusPoint: options.focusPoint ?? { x: 0.5, y: 0.5 },
    brand,
    copy: concept.copy,
    content,
    altText: altText.text,
    provenance: {
      imageModel: options.imageModel,
      imagePrompt: options.imagePrompt ?? concept.imagePrompt,
      imageParameters: options.imageParameters ?? {},
      creativeVersion: options.creativeVersion ?? 1,
      conceptKey: concept.key,
      principle: concept.principle,
      promptVersionId: options.promptVersionId ?? null,
      aiJobId: options.aiJobId ?? null,
      rendererVersion: RENDERER_VERSION,
      ...(options.renderedAt ? { renderedAt: options.renderedAt } : {}),
    },
    reviewState: initialReviewState,
    ...(options.quality ? { quality: options.quality } : {}),
    brandTokenOverrides: options.brandTokenOverrides ?? {},
  });

  const result = await composeCreative(request);

  const variants: FormatVariant[] = result.renditions.map((rendition) => {
    const asset = result.assets.find((entry) => entry.renditionKey === rendition.renditionKey);
    if (!asset) {
      throw new Error(`Fehlende Bilddaten für Rendition ${rendition.renditionKey}.`);
    }
    return {
      aspectRatio: rendition.aspectRatio,
      required: REQUIRED_ASPECT_RATIOS.includes(rendition.aspectRatio),
      rendition,
      jpeg: asset.jpeg,
      webp: asset.webp,
      svg: asset.svg,
      reviewState: rendition.reviewState,
      reviewNoteDe: null,
      contrastPasses: rendition.contrast.passes,
    };
  });

  return {
    conceptKey: concept.key,
    template,
    templateLabelDe: TEMPLATE_LABELS_DE[template],
    sourceAssetHash: result.sourceAssetHash,
    altText: altText.text,
    variants,
    warnings: result.warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-format approval                                                         */
/* -------------------------------------------------------------------------- */

/** Immutable update of one format's review state. */
export function setVariantReviewState(
  set: CreativeVariantSet,
  ratio: AspectRatio,
  state: AssetReviewState,
  reviewNoteDe: string | null = null,
): CreativeVariantSet {
  if (!set.variants.some((variant) => variant.aspectRatio === ratio)) {
    throw new Error(`Für das Format ${ratio} existiert keine Variante.`);
  }
  if (state === 'REJECTED' && (reviewNoteDe ?? '').trim().length === 0) {
    throw new Error('Eine Ablehnung benötigt eine Begründung.');
  }
  return {
    ...set,
    variants: set.variants.map((variant) =>
      variant.aspectRatio === ratio
        ? {
            ...variant,
            reviewState: state,
            reviewNoteDe,
            rendition: { ...variant.rendition, reviewState: state },
          }
        : variant,
    ),
  };
}

export function variantFor(
  set: CreativeVariantSet,
  ratio: AspectRatio,
): FormatVariant | undefined {
  return set.variants.find((variant) => variant.aspectRatio === ratio);
}

export function approvedRatios(set: CreativeVariantSet): AspectRatio[] {
  return set.variants
    .filter((variant) => variant.reviewState === 'APPROVED')
    .map((variant) => variant.aspectRatio);
}

/** Required ratios that were never rendered. */
export function missingRequiredRatios(set: CreativeVariantSet): AspectRatio[] {
  return REQUIRED_ASPECT_RATIOS.filter(
    (ratio) => !set.variants.some((variant) => variant.aspectRatio === ratio),
  );
}

/** Required ratios that exist but are not approved yet. */
export function pendingRequiredRatios(set: CreativeVariantSet): AspectRatio[] {
  return REQUIRED_ASPECT_RATIOS.filter((ratio) => {
    const variant = variantFor(set, ratio);
    return variant === undefined || variant.reviewState !== 'APPROVED';
  });
}

/** A creative may go to launch QA only with both required formats approved. */
export function isLaunchReady(set: CreativeVariantSet): boolean {
  return pendingRequiredRatios(set).length === 0;
}

/** One-line German status for the console list view. */
export function variantSetSummaryDe(set: CreativeVariantSet): string {
  const approved = approvedRatios(set);
  const total = set.variants.length;
  const missing = missingRequiredRatios(set);
  if (missing.length > 0) {
    return `${approved.length}/${total} Formaten freigegeben – Pflichtformat fehlt: ${missing.join(', ')}.`;
  }
  if (isLaunchReady(set)) {
    return `${approved.length}/${total} Formaten freigegeben – startbereit.`;
  }
  return `${approved.length}/${total} Formaten freigegeben – offen: ${pendingRequiredRatios(set).join(', ')}.`;
}
