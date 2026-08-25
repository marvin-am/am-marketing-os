/**
 * Deterministic composition: base motif + brand typography → Meta renditions.
 *
 * The image model delivers a motif and nothing else. Everything typographic —
 * headline, kicker, CTA, wordmark, colour fields, rules — is drawn here, from an
 * SVG this package generated, over a crop this package computed. That is what
 * makes a creative on-brand rather than "usually on-brand", and it is why the
 * same request always produces the same bytes: no clock, no randomness, no
 * network, integer crop maths and a fixed encoder configuration.
 *
 * Contrast is not assumed. For every rendition the motif under the text is
 * sampled, a worst-case backdrop derived, and the scrim solved until the text
 * clears WCAG AA — the achieved ratio is recorded on the rendition either way.
 */

import { readFile } from 'node:fs/promises';
import sharp, { type Metadata } from 'sharp';
import {
  DomainError,
  sha256Hex,
  type AspectRatio,
} from '@am/domain';
import { parseHex, svgColor, type Rgb } from './color';
import {
  WCAG_AA_LARGE,
  WCAG_AA_NORMAL,
  resolveLegibility,
  worstCaseBackdrop,
} from './contrast';
import {
  canvasFor,
  clampRectToPixels,
  coverCrop,
  rectContains,
  type CanvasGeometry,
  type Rect,
} from './geometry';
import { missingSlotWarnings } from './content';
import { getTemplate } from './templates';
import type { TemplateInput } from './templates/shared';
import {
  CONTENT_TYPES,
  brandTokensFromProfile,
  creativeRenditionSchema,
  creativeRenderRequestSchema,
  renderResultSchema,
  renditionKeyFor,
  type BaseMotif,
  type BrandTokens,
  type ContrastReport,
  type CreativeRendition,
  type CreativeRenderRequest,
  type CreativeRenderRequestInput,
  type FocusPointInput,
  type RenderProvenance,
  type RenderResult,
  type RenderedAsset,
  type TextFitReport,
} from './types';
import { assertWellFormedSvg } from './xml';

/** Hard ceiling so a corrupt or hostile motif cannot exhaust the worker. */
export const MAX_MOTIF_BYTES = 30 * 1024 * 1024;
export const MAX_MOTIF_DIMENSION = 8192;

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/** Lowercase hex SHA-256 of raw bytes, matching `sha256Hex` for strings. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Motif loading                                                               */
/* -------------------------------------------------------------------------- */

export async function loadMotif(motif: BaseMotif): Promise<Buffer> {
  const bytes =
    motif.kind === 'BUFFER' ? Buffer.from(motif.data) : await readFile(motif.path).catch((cause) => {
      throw new DomainError('NOT_FOUND', {
        messageDe: 'Das Basismotiv konnte nicht gelesen werden.',
        details: { path: motif.path },
        cause,
      });
    });
  if (bytes.byteLength === 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Das Basismotiv ist leer.',
    });
  }
  if (bytes.byteLength > MAX_MOTIF_BYTES) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: `Das Basismotiv ist größer als ${Math.round(MAX_MOTIF_BYTES / (1024 * 1024))} MB.`,
      details: { byteLength: bytes.byteLength },
    });
  }
  return bytes;
}

interface MotifInfo {
  width: number;
  height: number;
}

async function readMotifInfo(bytes: Buffer): Promise<MotifInfo> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch (cause) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Das Basismotiv ist kein lesbares Bild.',
      cause,
    });
  }
  const { width, height } = metadata;
  if (!width || !height) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Das Basismotiv hat keine lesbaren Abmessungen.',
    });
  }
  if (width > MAX_MOTIF_DIMENSION || height > MAX_MOTIF_DIMENSION) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: `Das Basismotiv überschreitet ${MAX_MOTIF_DIMENSION} px Kantenlänge.`,
      details: { width, height },
    });
  }
  return { width, height };
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                    */
/* -------------------------------------------------------------------------- */

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

async function cropToCanvas(
  motif: Buffer,
  info: MotifInfo,
  canvas: CanvasGeometry,
  focus: FocusPointInput,
  background: string,
): Promise<RawImage> {
  const crop = coverCrop(info, { width: canvas.width, height: canvas.height }, focus);
  const { data, info: raw } = await sharp(motif)
    .resize({
      width: crop.scaledWidth,
      height: crop.scaledHeight,
      fit: 'fill',
      kernel: 'lanczos3',
    })
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .flatten({ background })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: raw.width, height: raw.height, channels: raw.channels };
}

/** Mean and standard deviation of a region, per channel. */
async function sampleRegion(image: RawImage, region: Rect): Promise<{ mean: Rgb; stdev: Rgb }> {
  const clamped = clampRectToPixels(region, { width: image.width, height: image.height });
  const stats = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: image.channels },
  })
    .extract({ left: clamped.x, top: clamped.y, width: clamped.width, height: clamped.height })
    .stats();
  const channel = (index: number): { mean: number; stdev: number } =>
    stats.channels[index] ?? stats.channels[0] ?? { mean: 128, stdev: 0 };
  return {
    mean: { r: channel(0).mean, g: channel(1).mean, b: channel(2).mean },
    stdev: { r: channel(0).stdev, g: channel(1).stdev, b: channel(2).stdev },
  };
}

/* -------------------------------------------------------------------------- */
/* Rendition rendering                                                         */
/* -------------------------------------------------------------------------- */

interface RenditionDraft {
  rendition: CreativeRendition;
  asset: RenderedAsset;
  warnings: string[];
}

async function renderRendition(options: {
  request: CreativeRenderRequest;
  ratio: AspectRatio;
  motif: Buffer;
  info: MotifInfo;
  tokens: BrandTokens;
  sourceAssetHash: string;
}): Promise<RenditionDraft> {
  const { request, ratio, tokens } = options;
  const canvas = canvasFor(ratio);
  const template = getTemplate(request.template);
  const warnings: string[] = [];

  const cropped = await cropToCanvas(
    options.motif,
    options.info,
    canvas,
    request.focusPoint,
    tokens.background,
  );

  /* Contrast: sample, solve, then hand the result to the template. */
  const plan = template.plan(canvas, tokens);
  let sampledBackdrop: Rgb;
  if (plan.opaqueBackdrop) {
    sampledBackdrop = parseHex(plan.opaqueBackdrop);
  } else {
    const { mean, stdev } = await sampleRegion(cropped, plan.sampleRect);
    sampledBackdrop = worstCaseBackdrop(mean, stdev, plan.textColor);
  }
  const target = plan.largeText ? WCAG_AA_LARGE : WCAG_AA_NORMAL;
  const legibility = resolveLegibility({
    backdrop: sampledBackdrop,
    textColor: plan.textColor,
    scrimColor: plan.scrimColor,
    baseOpacity: plan.baseOpacity,
    target,
    fallbackScrims: [tokens.accent, '#000000', '#FFFFFF'],
    fallbackTextColors: [tokens.background, tokens.foreground, '#FFFFFF', '#000000'],
  });
  if (!legibility.passes) {
    warnings.push(
      `${ratio}: Kontrast ${legibility.ratio}:1 erreicht die AA-Schwelle von ${target}:1 nicht.`,
    );
  }
  warnings.push(...legibility.adjustments.map((note) => `${ratio}: ${note}`));

  const contrast: ContrastReport = {
    ratio: legibility.ratio,
    target: legibility.target,
    passes: legibility.passes,
    textColor: legibility.textColor.toUpperCase(),
    scrimColor: legibility.scrimColor.toUpperCase(),
    scrimOpacity: legibility.opacity,
    effectiveBackdrop: legibility.effectiveBackdrop,
    sampledBackdrop: svgColor(sampledBackdrop),
    adjustments: legibility.adjustments,
  };

  /* Layout — pure, no I/O, fully determined by the input above. */
  const templateInput: TemplateInput = {
    canvas,
    tokens,
    content: request.content,
    scrim: { color: legibility.scrimColor, opacity: legibility.opacity },
    overlayTextColor: legibility.textColor,
  };
  const layout = template.layout(templateInput);
  assertWellFormedSvg(layout.svg);

  const textFit: TextFitReport[] = layout.fits;
  for (const fit of textFit) {
    if (fit.truncated) {
      warnings.push(
        `${ratio}: Text im Slot "${fit.slot}" musste gekürzt werden – bitte Copy verkürzen.`,
      );
    }
  }
  for (const bound of layout.bounds) {
    if (!rectContains(canvas.safe, bound, 1)) {
      warnings.push(
        `${ratio}: Ein Textblock verlässt die Meta-Sicherheitszone (x ${Math.round(bound.x)}, y ${Math.round(bound.y)}).`,
      );
    }
  }

  /* Encode. */
  const composed = sharp(cropped.data, {
    raw: { width: cropped.width, height: cropped.height, channels: cropped.channels },
  }).composite([{ input: Buffer.from(layout.svg, 'utf8'), top: 0, left: 0 }]);

  const [jpeg, webp] = await Promise.all([
    composed
      .clone()
      .jpeg({
        quality: request.quality.jpegQuality,
        chromaSubsampling: request.quality.chromaSubsampling,
        progressive: request.quality.progressive,
        mozjpeg: true,
      })
      .toBuffer(),
    composed
      .clone()
      .webp({ quality: request.quality.webpQuality, effort: 4, smartSubsample: true })
      .toBuffer(),
  ]);

  const [jpegHash, webpHash] = await Promise.all([sha256Bytes(jpeg), sha256Bytes(webp)]);
  const outputHash = await sha256Hex(`${jpegHash}:${webpHash}`);
  const renditionKey = renditionKeyFor(request.conceptKey, request.template, ratio);

  const rendition = creativeRenditionSchema.parse({
    renditionKey,
    conceptKey: request.conceptKey,
    template: request.template,
    aspectRatio: ratio,
    mediaKind: 'IMAGE',
    width: canvas.width,
    height: canvas.height,
    brandTokens: tokens,
    focusPoint: request.focusPoint,
    sourceAssetHash: options.sourceAssetHash,
    outputs: {
      jpeg: {
        format: 'jpeg',
        contentType: CONTENT_TYPES.jpeg,
        width: canvas.width,
        height: canvas.height,
        byteLength: jpeg.byteLength,
        sha256: jpegHash,
      },
      webp: {
        format: 'webp',
        contentType: CONTENT_TYPES.webp,
        width: canvas.width,
        height: canvas.height,
        byteLength: webp.byteLength,
        sha256: webpHash,
      },
    },
    outputHash,
    contrast,
    textFit,
    safeArea: canvas.insets,
    altText: request.altText,
    reviewState: request.reviewState,
    provenance: request.provenance,
    warnings,
  } satisfies Record<string, unknown>);

  return {
    rendition,
    asset: { renditionKey, aspectRatio: ratio, jpeg, webp, svg: layout.svg },
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Composes one creative across every requested aspect ratio.
 *
 * Ratios are rendered sequentially: sharp is already multi-threaded per
 * operation, and a deterministic order keeps the warning list stable.
 */
export async function composeCreative(
  input: CreativeRenderRequestInput | CreativeRenderRequest,
): Promise<RenderResult> {
  const startedAt = Date.now();
  const request = creativeRenderRequestSchema.parse(input);

  const motif = await loadMotif(request.motif);
  const info = await readMotifInfo(motif);
  const sourceAssetHash = await sha256Bytes(motif);
  const tokens = brandTokensFromProfile(request.brand, request.brandTokenOverrides);

  const warnings: string[] = missingSlotWarnings(request.template, request.content);
  const renditions: CreativeRendition[] = [];
  const assets: RenderedAsset[] = [];

  const ratios = dedupeRatios(request.ratios);
  for (const ratio of ratios) {
    const draft = await renderRendition({
      request,
      ratio,
      motif,
      info,
      tokens,
      sourceAssetHash,
    });
    renditions.push(draft.rendition);
    assets.push(draft.asset);
  }
  for (const rendition of renditions) warnings.push(...rendition.warnings);

  const metadata = renderResultSchema.parse({
    conceptKey: request.conceptKey,
    template: request.template,
    sourceAssetHash,
    renditions,
    warnings: dedupe(warnings),
    durationMs: Date.now() - startedAt,
  });

  return { ...metadata, assets };
}

/**
 * Re-renders with a different focus point.
 *
 * Only the crop window moves — copy, tokens, template and provenance are carried
 * over unchanged, so an operator nudging the crop cannot accidentally alter what
 * the creative says.
 */
export async function recrop(
  request: CreativeRenderRequest,
  focusPoint: FocusPointInput,
  options: { ratios?: readonly AspectRatio[] } = {},
): Promise<RenderResult> {
  return composeCreative({
    ...request,
    focusPoint,
    ratios: [...(options.ratios ?? request.ratios)],
  });
}

/** Re-renders a single existing rendition at a new focus point. */
export async function recropRendition(
  request: CreativeRenderRequest,
  rendition: CreativeRendition,
  focusPoint: FocusPointInput,
): Promise<RenderResult> {
  return recrop(request, focusPoint, { ratios: [rendition.aspectRatio] });
}

export interface ReplaceMotifOptions {
  focusPoint?: FocusPointInput;
  /** Provenance for the *new* motif: a different prompt or model must be recorded. */
  provenance?: Partial<RenderProvenance>;
  ratios?: readonly AspectRatio[];
}

/**
 * Swaps the base motif and re-renders.
 *
 * The provenance of the replacement is merged in explicitly: a rendition that
 * still claimed the old prompt would be unreproducible, which is the one thing
 * this package exists to prevent.
 */
export async function replaceBaseMotif(
  request: CreativeRenderRequest,
  motif: BaseMotif,
  options: ReplaceMotifOptions = {},
): Promise<RenderResult> {
  return composeCreative({
    ...request,
    motif,
    focusPoint: options.focusPoint ?? request.focusPoint,
    ratios: [...(options.ratios ?? request.ratios)],
    provenance: { ...request.provenance, ...options.provenance },
  });
}

function dedupeRatios(ratios: readonly AspectRatio[]): AspectRatio[] {
  return [...new Set(ratios)];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
