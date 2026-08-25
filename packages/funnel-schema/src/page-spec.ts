import { z } from 'zod';
import { confidenceLabelSchema, localeSchema, slugSchema, uuidSchema } from '@am/domain';
import {
  bookingSpecSchema,
  ctaSpecSchema,
  keySchema,
  linkTargetSchema,
  mediaRefSchema,
  optionalPlainText,
  plainText,
  seoSpecSchema,
  themeSpecSchema,
  SPEC_SCHEMA_VERSION,
} from './common';
import { multiStepFormSpecSchema } from './form-spec';

/**
 * `LandingPageSpec` and `HybridFunnelSpec` — block-based page documents.
 *
 * A page is a validated list of typed blocks, never a string of markup. The
 * renderer owns the markup; the spec owns the content and the order. That is
 * what makes AI-authored pages safe to publish: the worst a bad generation can
 * do is produce a poor headline, never a script tag (AGENTS.md rule 5).
 */

/* -------------------------------------------------------------------------- */
/* Shared block pieces                                                         */
/* -------------------------------------------------------------------------- */

const blockBase = z.object({
  blockId: keySchema,
  /** Anchor used by in-page CTAs; `null` when the block is not linkable. */
  anchor: keySchema.nullable(),
});

/**
 * A number shown on a page must point at approved evidence or be labelled a
 * hypothesis — the model may explain, it may never invent a figure
 * (AGENTS.md rule 4).
 */
export const proofPointSchema = z.object({
  key: keySchema,
  label: plainText(160),
  value: plainText(60),
  note: optionalPlainText(300),
  evidenceItemId: uuidSchema.nullable(),
  confidence: confidenceLabelSchema,
});
export type ProofPoint = z.infer<typeof proofPointSchema>;

export const PAGE_BLOCK_TYPES = [
  'HERO',
  'PROBLEM',
  'BENEFIT',
  'PROOF',
  'CASE_STUDY',
  'TESTIMONIAL',
  'PROCESS',
  'COMPARISON',
  'OBJECTION_HANDLING',
  'FAQ',
  'CTA',
  'TRUST',
  'BOOKING_CTA',
  'EMBEDDED_CONTACT',
  'FOOTER_LEGAL',
] as const;
export const pageBlockTypeSchema = z.enum(PAGE_BLOCK_TYPES);
export type PageBlockType = z.infer<typeof pageBlockTypeSchema>;

export const PAGE_BLOCK_LABELS_DE: Readonly<Record<PageBlockType, string>> = {
  HERO: 'Hero',
  PROBLEM: 'Problem',
  BENEFIT: 'Nutzen',
  PROOF: 'Belege',
  CASE_STUDY: 'Fallstudie',
  TESTIMONIAL: 'Kundenstimmen',
  PROCESS: 'Ablauf',
  COMPARISON: 'Vergleich',
  OBJECTION_HANDLING: 'Einwandbehandlung',
  FAQ: 'Häufige Fragen',
  CTA: 'Handlungsaufforderung',
  TRUST: 'Vertrauen',
  BOOKING_CTA: 'Terminbuchung',
  EMBEDDED_CONTACT: 'Eingebettetes Formular',
  FOOTER_LEGAL: 'Fußzeile / Rechtliches',
};

/* -------------------------------------------------------------------------- */
/* Embedded form reference                                                     */
/* -------------------------------------------------------------------------- */

export const EMBED_MODES = ['INLINE', 'MODAL'] as const;
export const embedModeSchema = z.enum(EMBED_MODES);
export type EmbedMode = z.infer<typeof embedModeSchema>;

/** Reference to a published `MultiStepFormSpec`. */
export const embeddedFormRefSchema = z.object({
  mode: embedModeSchema,
  formId: uuidSchema,
  formVersionId: uuidSchema,
  /** Label of the button that opens the modal; unused for `INLINE`. */
  triggerLabel: plainText(80),
  /** Block the inline form is rendered after; `null` appends it at the end. */
  anchorBlockId: keySchema.nullable(),
});
export type EmbeddedFormRef = z.infer<typeof embeddedFormRefSchema>;

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

export const pageBlockSchema = z.discriminatedUnion('type', [
  blockBase.extend({
    type: z.literal('HERO'),
    eyebrow: optionalPlainText(80),
    headline: plainText(200),
    subline: optionalPlainText(600),
    bullets: z.array(plainText(200)).max(6),
    primaryCta: ctaSpecSchema,
    secondaryCta: ctaSpecSchema.nullable(),
    media: mediaRefSchema.nullable(),
    trustNote: optionalPlainText(200),
  }),
  blockBase.extend({
    type: z.literal('PROBLEM'),
    headline: plainText(200),
    intro: optionalPlainText(800),
    points: z
      .array(
        z.object({
          key: keySchema,
          title: plainText(160),
          body: plainText(800),
        }),
      )
      .min(1)
      .max(8),
  }),
  blockBase.extend({
    type: z.literal('BENEFIT'),
    headline: plainText(200),
    intro: optionalPlainText(800),
    benefits: z
      .array(
        z.object({
          key: keySchema,
          title: plainText(160),
          body: plainText(800),
          iconKey: keySchema.nullable(),
        }),
      )
      .min(1)
      .max(9),
  }),
  blockBase.extend({
    type: z.literal('PROOF'),
    headline: plainText(200),
    points: z.array(proofPointSchema).min(1).max(8),
    sourceNote: optionalPlainText(300),
  }),
  blockBase.extend({
    type: z.literal('CASE_STUDY'),
    headline: plainText(200),
    caseStudyId: uuidSchema.nullable(),
    client: plainText(200),
    industry: optionalPlainText(120),
    challenge: plainText(2000),
    approach: plainText(2000),
    outcome: plainText(2000),
    metrics: z
      .array(z.object({ key: keySchema, label: plainText(120), value: plainText(120) }))
      .max(6),
    cta: ctaSpecSchema.nullable(),
  }),
  blockBase.extend({
    type: z.literal('TESTIMONIAL'),
    headline: optionalPlainText(200),
    testimonials: z
      .array(
        z.object({
          key: keySchema,
          testimonialId: uuidSchema.nullable(),
          quote: plainText(1200),
          authorName: plainText(160),
          authorRole: optionalPlainText(160),
          company: optionalPlainText(200),
          media: mediaRefSchema.nullable(),
        }),
      )
      .min(1)
      .max(6),
  }),
  blockBase.extend({
    type: z.literal('PROCESS'),
    headline: plainText(200),
    intro: optionalPlainText(600),
    steps: z
      .array(
        z.object({
          key: keySchema,
          title: plainText(160),
          body: plainText(800),
          durationNote: optionalPlainText(80),
        }),
      )
      .min(2)
      .max(7),
  }),
  blockBase.extend({
    type: z.literal('COMPARISON'),
    headline: plainText(200),
    intro: optionalPlainText(600),
    columns: z
      .array(z.object({ key: keySchema, label: plainText(120), highlight: z.boolean() }))
      .min(2)
      .max(4),
    rows: z
      .array(
        z.object({
          key: keySchema,
          label: plainText(160),
          /** One cell per column, in column order. */
          cells: z.array(plainText(200)).min(2).max(4),
        }),
      )
      .min(1)
      .max(12),
  }),
  blockBase.extend({
    type: z.literal('OBJECTION_HANDLING'),
    headline: plainText(200),
    objections: z
      .array(
        z.object({
          key: keySchema,
          objection: plainText(300),
          response: plainText(1200),
        }),
      )
      .min(1)
      .max(8),
  }),
  blockBase.extend({
    type: z.literal('FAQ'),
    headline: plainText(200),
    items: z
      .array(
        z.object({
          key: keySchema,
          faqId: uuidSchema.nullable(),
          question: plainText(300),
          answer: plainText(2000),
        }),
      )
      .min(1)
      .max(15),
  }),
  blockBase.extend({
    type: z.literal('CTA'),
    headline: plainText(200),
    body: optionalPlainText(800),
    cta: ctaSpecSchema,
    urgencyNote: optionalPlainText(200),
  }),
  blockBase.extend({
    type: z.literal('TRUST'),
    headline: optionalPlainText(200),
    badges: z
      .array(
        z.object({
          key: keySchema,
          label: plainText(120),
          note: optionalPlainText(200),
        }),
      )
      .max(8),
    logos: z
      .array(
        z.object({
          key: keySchema,
          label: plainText(120),
          media: mediaRefSchema.nullable(),
        }),
      )
      .max(12),
  }),
  blockBase.extend({
    type: z.literal('BOOKING_CTA'),
    headline: plainText(200),
    body: plainText(1200),
    booking: bookingSpecSchema,
  }),
  blockBase.extend({
    type: z.literal('EMBEDDED_CONTACT'),
    headline: plainText(200),
    body: optionalPlainText(800),
    form: embeddedFormRefSchema,
  }),
  blockBase.extend({
    type: z.literal('FOOTER_LEGAL'),
    companyLine: plainText(300),
    imprintLink: linkTargetSchema,
    privacyLink: linkTargetSchema,
    additionalLinks: z
      .array(z.object({ key: keySchema, label: plainText(120), target: linkTargetSchema }))
      .max(6),
    disclaimers: z.array(plainText(600)).max(6),
  }),
]);
export type PageBlock = z.infer<typeof pageBlockSchema>;

export type PageBlockOf<T extends PageBlockType> = Extract<PageBlock, { type: T }>;

/* -------------------------------------------------------------------------- */
/* LandingPageSpec                                                             */
/* -------------------------------------------------------------------------- */

export const landingPageSpecSchema = z.object({
  kind: z.literal('LANDING_PAGE'),
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  pageId: uuidSchema,
  pageVersionId: uuidSchema,
  locale: localeSchema,
  title: plainText(200),
  slug: slugSchema,
  offerId: uuidSchema,
  angleId: uuidSchema,
  blocks: z.array(pageBlockSchema).min(2).max(30),
  seo: seoSpecSchema,
  theme: themeSpecSchema,
});
export type LandingPageSpec = z.infer<typeof landingPageSpecSchema>;

/* -------------------------------------------------------------------------- */
/* HybridFunnelSpec                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A short landing page plus an embedded or modal multi-step form. `formSpec` may
 * carry the referenced document inline so a fixture, a preview or an E2E run can
 * validate page and form as one unit; in production the runtime resolves the
 * reference against the published form version.
 */
export const hybridFunnelSpecSchema = z.object({
  kind: z.literal('HYBRID'),
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  pageId: uuidSchema,
  pageVersionId: uuidSchema,
  locale: localeSchema,
  title: plainText(200),
  slug: slugSchema,
  offerId: uuidSchema,
  angleId: uuidSchema,
  /** Short by design — the form is the conversion surface, not the page. */
  blocks: z.array(pageBlockSchema).min(1).max(8),
  form: embeddedFormRefSchema,
  formSpec: multiStepFormSpecSchema.nullable(),
  seo: seoSpecSchema,
  theme: themeSpecSchema,
});
export type HybridFunnelSpec = z.infer<typeof hybridFunnelSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Union                                                                       */
/* -------------------------------------------------------------------------- */

export const funnelSpecSchema = z.discriminatedUnion('kind', [
  landingPageSpecSchema,
  hybridFunnelSpecSchema,
  multiStepFormSpecSchema,
]);
export type FunnelSpec = z.infer<typeof funnelSpecSchema>;

export function getBlock(
  spec: LandingPageSpec | HybridFunnelSpec,
  blockId: string,
): PageBlock | null {
  return spec.blocks.find((block) => block.blockId === blockId) ?? null;
}

export function blocksOfType<T extends PageBlockType>(
  spec: LandingPageSpec | HybridFunnelSpec,
  type: T,
): PageBlockOf<T>[] {
  return spec.blocks.filter((block): block is PageBlockOf<T> => block.type === type);
}
