import { z } from 'zod';
import {
  attributionLevelSchema,
  confidenceLabelSchema,
  evidenceKindSchema,
  funnelKindSchema,
} from './enums';
import { uuidSchema } from './ids';
import { currencySchema, isoTimestampSchema, shortTextSchema } from './primitives';

/* -------------------------------------------------------------------------- */
/* Brand knowledge — the only context the AI layer may read                    */
/* -------------------------------------------------------------------------- */

export const brandProfileSchema = z.object({
  id: uuidSchema,
  name: shortTextSchema,
  positioning: z.string().min(20).max(3000),
  toneOfVoice: z.string().min(20).max(2000),
  /** Words and constructions to avoid, e.g. "günstig", "billig". */
  avoidTerms: z.array(z.string().max(120)).max(80).default([]),
  preferredTerms: z.array(z.string().max(120)).max(80).default([]),
  /** Brand tokens; configurable, defaulting to the A&M red/black/white world. */
  colors: z
    .object({
      primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })
    .default({
      primary: '#D7182A',
      foreground: '#111111',
      background: '#FFFFFF',
      accent: '#000000',
    }),
  logoAssetPath: z.string().max(500).nullable().default(null),
});
export type BrandProfile = z.infer<typeof brandProfileSchema>;

export const audienceSegmentSchema = z.object({
  id: uuidSchema,
  name: shortTextSchema,
  description: z.string().min(20).max(3000),
  companySize: z.string().max(120).nullable().default(null),
  industries: z.array(z.string().max(120)).max(30).default([]),
  roles: z.array(z.string().max(120)).max(30).default([]),
  painPoints: z.array(z.string().max(400)).max(20).default([]),
  buyingTriggers: z.array(z.string().max(400)).max(20).default([]),
  objections: z.array(z.string().max(400)).max(20).default([]),
});
export type AudienceSegment = z.infer<typeof audienceSegmentSchema>;

export const evidenceItemSchema = z.object({
  id: uuidSchema,
  kind: evidenceKindSchema,
  statement: z.string().min(5).max(1000),
  source: z.string().max(500),
  /** Only approved evidence may back a claim. */
  approved: z.boolean().default(false),
  approvedAt: isoTimestampSchema.nullable().default(null),
  validUntil: isoTimestampSchema.nullable().default(null),
  numericValue: z.number().nullable().default(null),
  numericUnit: z.string().max(40).nullable().default(null),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/** A guardrail is a hard content rule the AI output is checked against. */
export const guardrailSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['FORBIDDEN_CLAIM', 'FORBIDDEN_TERM', 'REQUIRED_DISCLAIMER', 'STYLE_RULE']),
  pattern: z.string().min(1).max(400),
  /** Whether `pattern` is matched case-insensitively as a plain substring. */
  matchMode: z.enum(['SUBSTRING', 'WORD']).default('SUBSTRING'),
  reasonDe: z.string().min(5).max(600),
  severity: z.enum(['BLOCK', 'WARN']).default('BLOCK'),
});
export type Guardrail = z.infer<typeof guardrailSchema>;

export const caseStudySchema = z.object({
  id: uuidSchema,
  client: z.string().max(200),
  industry: z.string().max(120).nullable().default(null),
  challenge: z.string().min(10).max(2000),
  approach: z.string().min(10).max(2000),
  outcome: z.string().min(10).max(2000),
  metrics: z.array(z.object({ label: z.string().max(120), value: z.string().max(120) })).default([]),
  approved: z.boolean().default(false),
  usableInAds: z.boolean().default(false),
});
export type CaseStudy = z.infer<typeof caseStudySchema>;

export const testimonialSchema = z.object({
  id: uuidSchema,
  quote: z.string().min(10).max(1200),
  authorName: z.string().max(160),
  authorRole: z.string().max(160).nullable().default(null),
  company: z.string().max(200).nullable().default(null),
  approved: z.boolean().default(false),
  usableInAds: z.boolean().default(false),
});
export type Testimonial = z.infer<typeof testimonialSchema>;

export const faqSchema = z.object({
  id: uuidSchema,
  question: z.string().min(5).max(400),
  answer: z.string().min(5).max(3000),
  approved: z.boolean().default(false),
});
export type Faq = z.infer<typeof faqSchema>;

/**
 * The complete, approved context handed to the AI pipeline. Assembling this
 * object is the *only* way context reaches a model — there is no path from lead
 * or CRM data into a prompt (spec §12).
 */
export const aiContextBundleSchema = z.object({
  brand: brandProfileSchema,
  audiences: z.array(audienceSegmentSchema).default([]),
  services: z
    .array(z.object({ id: uuidSchema, name: z.string(), description: z.string() }))
    .default([]),
  offers: z
    .array(z.object({ id: uuidSchema, name: z.string(), description: z.string() }))
    .default([]),
  evidence: z.array(evidenceItemSchema).default([]),
  caseStudies: z.array(caseStudySchema).default([]),
  testimonials: z.array(testimonialSchema).default([]),
  faqs: z.array(faqSchema).default([]),
  guardrails: z.array(guardrailSchema).default([]),
  historicalCampaigns: z.array(z.unknown()).default([]),
  historicalLearnings: z.array(z.unknown()).default([]),
  activeCampaignSummaries: z.array(z.unknown()).default([]),
});
export type AiContextBundle = z.infer<typeof aiContextBundleSchema>;

/* -------------------------------------------------------------------------- */
/* Learning memory                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A versioned learning card distilled from a concluded campaign or experiment
 * (spec §11). The `confidence` label is computed from data maturity and
 * attribution coverage — the model may not upgrade it.
 */
export const learningCardSchema = z.object({
  id: uuidSchema,
  version: z.number().int().min(1),
  campaign_id: uuidSchema.nullable().default(null),
  experiment_id: uuidSchema.nullable().default(null),
  created_at: isoTimestampSchema,

  titleDe: z.string().min(5).max(200),
  whatWasTestedDe: z.string().min(10).max(1500),

  angleName: z.string().max(200).nullable().default(null),
  angle_id: uuidSchema.nullable().default(null),
  offerName: z.string().max(200).nullable().default(null),
  offer_id: uuidSchema.nullable().default(null),
  creativeConceptDe: z.string().max(1000).nullable().default(null),
  funnelKind: funnelKindSchema.nullable().default(null),
  audienceDe: z.string().max(600).nullable().default(null),

  periodStart: isoTimestampSchema.nullable().default(null),
  periodEnd: isoTimestampSchema.nullable().default(null),
  spendMinor: z.number().int().min(0).default(0),
  currency: currencySchema.default('EUR'),

  /** Deterministically computed outcome summary — numbers come from rollups. */
  outcomeDe: z.string().min(5).max(1500),
  outcomeFacts: z
    .array(
      z.object({
        label: z.string().max(160),
        numerator: z.number().nullable(),
        denominator: z.number().nullable(),
        value: z.number().nullable(),
        unit: z.string().max(20).nullable().default(null),
      }),
    )
    .default([]),

  dataMaturity: z.enum(['IMMATURE', 'PARTIAL', 'MATURE']),
  attributionLevel: attributionLevelSchema,
  attributionCoverage: z.number().min(0).max(1).nullable().default(null),

  possibleExplanationDe: z.string().max(1500).nullable().default(null),
  suggestedNextTestDe: z.string().max(1000).nullable().default(null),
  confidence: confidenceLabelSchema,
});
export type LearningCard = z.infer<typeof learningCardSchema>;

/**
 * Confidence is derived, never asserted by a model.
 *
 * FACT requires mature data *and* trustworthy attribution. Anything weaker is
 * at most an INDICATION, and an immature cohort is always a HYPOTHESIS.
 */
export function deriveConfidence(input: {
  maturity: 'IMMATURE' | 'PARTIAL' | 'MATURE';
  attributionCoverage: number | null;
  sampleSize: number;
  minSampleForFact?: number;
}): z.infer<typeof confidenceLabelSchema> {
  const minSample = input.minSampleForFact ?? 20;
  const coverage = input.attributionCoverage ?? 0;

  if (input.maturity === 'MATURE' && coverage >= 0.8 && input.sampleSize >= minSample) {
    return 'FACT';
  }
  if (input.maturity !== 'IMMATURE' && coverage >= 0.5 && input.sampleSize >= Math.ceil(minSample / 2)) {
    return 'INDICATION';
  }
  return 'HYPOTHESIS';
}

export const CONFIDENCE_LABELS_DE: Readonly<
  Record<z.infer<typeof confidenceLabelSchema>, string>
> = {
  FACT: 'Fakt',
  INDICATION: 'Indikation',
  HYPOTHESIS: 'Hypothese',
};

/* -------------------------------------------------------------------------- */
/* Angle distinctness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Similarity above `iterationThreshold` means the proposed angle is an
 * iteration of an existing one, not a new angle. Above `blockThreshold` it must
 * be regenerated (spec §11).
 */
export const ANGLE_DISTINCTNESS = {
  iterationThreshold: 0.82,
  blockThreshold: 0.93,
  /** Only campaigns from this window count as "recently used". */
  recencyDays: 180,
} as const;

export const ANGLE_VERDICTS = ['DISTINCT', 'ITERATION', 'TOO_SIMILAR'] as const;
export const angleVerdictSchema = z.enum(ANGLE_VERDICTS);
export type AngleVerdict = z.infer<typeof angleVerdictSchema>;

export function classifyAngleSimilarity(
  maxSimilarity: number,
  thresholds: { iterationThreshold: number; blockThreshold: number } = ANGLE_DISTINCTNESS,
): AngleVerdict {
  if (maxSimilarity >= thresholds.blockThreshold) return 'TOO_SIMILAR';
  if (maxSimilarity >= thresholds.iterationThreshold) return 'ITERATION';
  return 'DISTINCT';
}

export const ANGLE_VERDICT_LABELS_DE: Readonly<Record<AngleVerdict, string>> = {
  DISTINCT: 'Eigenständiger Angle',
  ITERATION: 'Iteration eines bestehenden Angles',
  TOO_SIMILAR: 'Zu ähnlich – bitte neu entwickeln',
};
