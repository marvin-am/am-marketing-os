/**
 * The contract of `@am/creative-renderer`.
 *
 * The image model produces the base motif and nothing else — no headline, no
 * logo, no button, no UI text. Everything typographic is composed here, from
 * validated inputs, so that a creative is on-brand, legible and reproducible:
 * the same request always yields the same bytes, and every rendition carries the
 * provenance needed to answer "which model, which prompt, which version made
 * this?" months later.
 */

import { z } from 'zod';
import {
  aspectRatioSchema,
  assetReviewStateSchema,
  brandProfileSchema,
  creativePrincipleSchema,
  isoTimestampSchema,
  mediaKindSchema,
  metaCopySchema,
  nowIso,
  type AspectRatio,
  type BrandProfile,
} from '@am/domain';
import { bestContrastColor, mix, toHex } from './color';
import { DEFAULT_FONT_STACK } from './fonts';

/** Bumped whenever a template's visual output changes. Part of provenance. */
export const RENDERER_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

export const TEMPLATE_IDS = [
  'bold-statement',
  'split-panel',
  'data-point',
  'quote-proof',
  'comparison',
] as const;
export const templateIdSchema = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof templateIdSchema>;

export const TEMPLATE_LABELS_DE: Readonly<Record<TemplateId, string>> = {
  'bold-statement': 'Statement (vollflächig)',
  'split-panel': 'Split-Panel (Motiv + Farbfläche)',
  'data-point': 'Kennzahl (Zahl im Fokus)',
  'quote-proof': 'Zitat / Kundenstimme',
  'comparison': 'Vergleich (zwei Spalten)',
};

/** Which of the six communication principles each template serves best. */
export const TEMPLATE_PRINCIPLE_AFFINITY: Readonly<
  Record<TemplateId, readonly z.infer<typeof creativePrincipleSchema>[]>
> = {
  'bold-statement': ['PROBLEM_PAIN', 'CONTRARIAN_INSIGHT'],
  'split-panel': ['CONCRETE_RESULT', 'OBJECTION_HANDLING'],
  'data-point': ['PROOF_CASE_DATAPOINT', 'CONCRETE_RESULT'],
  'quote-proof': ['PROOF_CASE_DATAPOINT', 'OBJECTION_HANDLING'],
  'comparison': ['COMPARISON_ALTERNATIVE', 'CONTRARIAN_INSIGHT'],
};

/* -------------------------------------------------------------------------- */
/* Brand tokens                                                                */
/* -------------------------------------------------------------------------- */

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Erwartet einen Hex-Farbwert wie #D7182A');

/**
 * Resolved design tokens. Templates read only from here — a hard-coded hex
 * anywhere in `templates/` is a bug, because the whole point is that a different
 * brand profile produces a different, still coherent, creative.
 */
export const brandTokensSchema = z.object({
  primary: hexColorSchema,
  foreground: hexColorSchema,
  background: hexColorSchema,
  accent: hexColorSchema,
  /** Text colour that clears AA on the primary field. */
  onPrimary: hexColorSchema,
  /** Text colour that clears AA on the accent field. */
  onAccent: hexColorSchema,
  /** Secondary text on the background field. */
  muted: hexColorSchema,
  fontStack: z.string().min(1),
  /** Wordmark drawn as type; the model never renders a logo. */
  wordmark: z.string().max(40).nullable().default(null),
});
export type BrandTokens = z.infer<typeof brandTokensSchema>;

export const A_AND_M_DEFAULT_COLORS = {
  primary: '#D7182A',
  foreground: '#111111',
  background: '#FFFFFF',
  accent: '#000000',
} as const;

export interface BrandTokenOverrides {
  fontStack?: string;
  wordmark?: string | null;
}

/** Derives the render tokens from an approved brand profile. */
export function brandTokensFromProfile(
  brand: BrandProfile,
  overrides: BrandTokenOverrides = {},
): BrandTokens {
  const colors = brand.colors ?? A_AND_M_DEFAULT_COLORS;
  const onPrimary = bestContrastColor(colors.primary, [
    colors.background,
    '#FFFFFF',
    colors.foreground,
    '#000000',
  ]).color;
  const onAccent = bestContrastColor(colors.accent, [
    colors.background,
    '#FFFFFF',
    colors.foreground,
    '#000000',
  ]).color;
  return brandTokensSchema.parse({
    primary: colors.primary,
    foreground: colors.foreground,
    background: colors.background,
    accent: colors.accent,
    onPrimary,
    onAccent,
    muted: mutedFrom(colors.foreground, colors.background),
    fontStack: overrides.fontStack ?? DEFAULT_FONT_STACK,
    wordmark: overrides.wordmark !== undefined ? overrides.wordmark : brand.name.toUpperCase(),
  });
}

/**
 * A muted tone derived from the brand pair itself: the foreground faded towards
 * the background as far as it can go while still clearing AA. Nothing is
 * hard-coded, so a dark-background brand gets a muted tone that reads as muted
 * there too.
 */
function mutedFrom(foreground: string, background: string): string {
  let muted = foreground;
  for (const amount of [0.15, 0.3, 0.45, 0.6]) {
    const candidate = toHex(mix(foreground, background, amount));
    if (bestContrastColor(background, [candidate]).ratio < 4.5) break;
    muted = candidate;
  }
  return muted;
}

/* -------------------------------------------------------------------------- */
/* Content slots                                                               */
/* -------------------------------------------------------------------------- */

export const comparisonColumnSchema = z.object({
  label: z.string().min(1).max(40),
  items: z.array(z.string().min(1).max(120)).min(1).max(4),
});
export type ComparisonColumn = z.infer<typeof comparisonColumnSchema>;

/**
 * Everything a template may draw. Slots a given template does not use are simply
 * ignored; slots it needs are filled deterministically by `contentFromConcept`
 * so that no template can ever render an empty box.
 */
export const creativeContentSchema = z.object({
  headline: z.string().min(1).max(160),
  subline: z.string().max(220).nullable().default(null),
  callToAction: z.string().min(1).max(40),
  /** Small eyebrow label above the headline. */
  kicker: z.string().max(40).nullable().default(null),
  /** Oversized figure for `data-point`, e.g. "38 %" or "3,4×". */
  statValue: z.string().max(12).nullable().default(null),
  statCaption: z.string().max(160).nullable().default(null),
  sourceLine: z.string().max(160).nullable().default(null),
  quote: z.string().max(320).nullable().default(null),
  attributionName: z.string().max(60).nullable().default(null),
  attributionRole: z.string().max(80).nullable().default(null),
  /** Initials shown in the avatar slot when no photo is available. */
  attributionInitials: z.string().max(3).nullable().default(null),
  comparison: z
    .object({ left: comparisonColumnSchema, right: comparisonColumnSchema })
    .nullable()
    .default(null),
});
export type CreativeContent = z.infer<typeof creativeContentSchema>;

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

export const imageParameterSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Where the base motif came from and what composed it. Recorded on every
 * rendition: a creative that cannot say which model and prompt produced its
 * motif cannot be reproduced, and an unreproducible asset must not go live.
 */
export const renderProvenanceSchema = z.object({
  /** Model id, e.g. the configured `OPENAI_IMAGE_MODEL`. */
  imageModel: z.string().min(1).max(120),
  /** The exact motif prompt — never contains typography instructions. */
  imagePrompt: z.string().min(1).max(4000),
  imageParameters: z.record(z.string(), imageParameterSchema).default({}),
  /** Version of the creative this rendition belongs to; frozen at publish. */
  creativeVersion: z.number().int().min(1).default(1),
  conceptKey: z.string().min(1).max(60),
  principle: creativePrincipleSchema,
  promptVersionId: z.string().max(64).nullable().default(null),
  aiJobId: z.string().max(64).nullable().default(null),
  rendererVersion: z.string().min(1).max(20).default(RENDERER_VERSION),
  renderedAt: isoTimestampSchema.default(() => nowIso()),
});
export type RenderProvenance = z.infer<typeof renderProvenanceSchema>;

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

export const focusPointSchema = z.object({
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
});
export type FocusPointInput = z.infer<typeof focusPointSchema>;

const bytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
  message: 'Erwartet die Bilddaten als Buffer.',
});

/** The base motif: raw bytes in memory or a file on disk. Never a remote URL. */
export const baseMotifSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('BUFFER'), data: bytesSchema }),
  z.object({ kind: z.literal('FILE'), path: z.string().min(1).max(1000) }),
]);
export type BaseMotif = z.infer<typeof baseMotifSchema>;

export function motifFromBuffer(data: Uint8Array): BaseMotif {
  return { kind: 'BUFFER', data };
}

export function motifFromPath(path: string): BaseMotif {
  return { kind: 'FILE', path };
}

export const outputQualitySchema = z.object({
  jpegQuality: z.number().int().min(40).max(100).default(84),
  webpQuality: z.number().int().min(40).max(100).default(84),
  /** 4:4:4 keeps the brand red from bleeding along type edges. */
  chromaSubsampling: z.enum(['4:4:4', '4:2:0']).default('4:4:4'),
  progressive: z.boolean().default(true),
});
export type OutputQuality = z.infer<typeof outputQualitySchema>;

export const creativeRenderRequestSchema = z.object({
  conceptKey: z.string().min(1).max(60),
  template: templateIdSchema,
  ratios: z.array(aspectRatioSchema).min(1).max(3),
  motif: baseMotifSchema,
  focusPoint: focusPointSchema.default({ x: 0.5, y: 0.5 }),
  brand: brandProfileSchema,
  copy: metaCopySchema,
  content: creativeContentSchema,
  altText: z.string().min(1).max(400),
  provenance: renderProvenanceSchema,
  reviewState: assetReviewStateSchema.default('DRAFT'),
  quality: outputQualitySchema.default({
    jpegQuality: 84,
    webpQuality: 84,
    chromaSubsampling: '4:4:4',
    progressive: true,
  }),
  /** Token overrides, e.g. a campaign-specific wordmark. */
  brandTokenOverrides: z
    .object({ fontStack: z.string().min(1).optional(), wordmark: z.string().max(40).nullable().optional() })
    .default({}),
});
export type CreativeRenderRequest = z.infer<typeof creativeRenderRequestSchema>;
export type CreativeRenderRequestInput = z.input<typeof creativeRenderRequestSchema>;

export function parseRenderRequest(input: unknown): CreativeRenderRequest {
  return creativeRenderRequestSchema.parse(input);
}

/* -------------------------------------------------------------------------- */
/* Rendition                                                                   */
/* -------------------------------------------------------------------------- */

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Erwartet einen SHA-256-Hex-Hash');

export const OUTPUT_FORMATS = ['jpeg', 'webp'] as const;
export const outputFormatSchema = z.enum(OUTPUT_FORMATS);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const CONTENT_TYPES: Readonly<Record<OutputFormat, string>> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const renditionOutputSchema = z.object({
  format: outputFormatSchema,
  contentType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sha256: sha256Schema,
});
export type RenditionOutput = z.infer<typeof renditionOutputSchema>;

export const contrastReportSchema = z.object({
  ratio: z.number().min(1),
  target: z.number().min(1),
  passes: z.boolean(),
  textColor: hexColorSchema,
  scrimColor: hexColorSchema,
  scrimOpacity: z.number().min(0).max(1),
  /** Colour the text sits on after the scrim was applied. */
  effectiveBackdrop: hexColorSchema,
  /** Conservative estimate of the motif under the text before the scrim. */
  sampledBackdrop: hexColorSchema,
  adjustments: z.array(z.string()).default([]),
});
export type ContrastReport = z.infer<typeof contrastReportSchema>;

export const textFitReportSchema = z.object({
  slot: z.string().min(1),
  fontSizePx: z.number().positive(),
  lines: z.number().int().min(0),
  widthPx: z.number().min(0),
  heightPx: z.number().min(0),
  boxWidthPx: z.number().min(0),
  boxHeightPx: z.number().min(0),
  truncated: z.boolean(),
});
export type TextFitReport = z.infer<typeof textFitReportSchema>;

export const creativeRenditionSchema = z.object({
  /** Stable key: `<concept>__<template>__<ratio>`. */
  renditionKey: z.string().min(1).max(160),
  conceptKey: z.string().min(1).max(60),
  template: templateIdSchema,
  aspectRatio: aspectRatioSchema,
  mediaKind: mediaKindSchema.default('IMAGE'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Tokens this rendition was actually drawn with. */
  brandTokens: brandTokensSchema,
  focusPoint: focusPointSchema,
  /** SHA-256 of the base motif bytes. */
  sourceAssetHash: sha256Schema,
  outputs: z.object({ jpeg: renditionOutputSchema, webp: renditionOutputSchema }),
  /** Identity of the composed result: hash over both encoded outputs. */
  outputHash: sha256Schema,
  contrast: contrastReportSchema,
  textFit: z.array(textFitReportSchema).default([]),
  safeArea: z.object({
    top: z.number().int().min(0),
    right: z.number().int().min(0),
    bottom: z.number().int().min(0),
    left: z.number().int().min(0),
  }),
  altText: z.string().min(1).max(400),
  reviewState: assetReviewStateSchema.default('DRAFT'),
  provenance: renderProvenanceSchema,
  warnings: z.array(z.string()).default([]),
});
export type CreativeRendition = z.infer<typeof creativeRenditionSchema>;

export function renditionKeyFor(
  conceptKey: string,
  template: TemplateId,
  ratio: AspectRatio,
): string {
  return `${conceptKey}__${template}__${ratio.replace(':', 'x')}`;
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export const renderResultSchema = z.object({
  conceptKey: z.string().min(1),
  template: templateIdSchema,
  sourceAssetHash: sha256Schema,
  renditions: z.array(creativeRenditionSchema).min(1),
  warnings: z.array(z.string()).default([]),
  durationMs: z.number().min(0),
});
export type RenderResultMetadata = z.infer<typeof renderResultSchema>;

/** Encoded bytes for one rendition. Held in memory, never part of a DB row. */
export interface RenderedAsset {
  renditionKey: string;
  aspectRatio: AspectRatio;
  jpeg: Buffer;
  webp: Buffer;
  /** The composed overlay, kept for debugging and for the console preview. */
  svg: string;
}

export interface RenderResult extends RenderResultMetadata {
  assets: RenderedAsset[];
}

export function assetFor(result: RenderResult, ratio: AspectRatio): RenderedAsset | undefined {
  return result.assets.find((asset) => asset.aspectRatio === ratio);
}

export function renditionFor(
  result: RenderResult,
  ratio: AspectRatio,
): CreativeRendition | undefined {
  return result.renditions.find((rendition) => rendition.aspectRatio === ratio);
}
