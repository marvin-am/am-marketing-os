import { z } from 'zod';
import {
  conditionOperatorSchema,
  consentSpecSchema,
  fieldTypeSchema,
  localeSchema,
  piiClassSchema,
  qualificationClassSchema,
  uuidSchema,
  type ConditionOperator,
  type FieldType,
} from '@am/domain';
import {
  bookingSpecSchema,
  ctaSpecSchema,
  keySchema,
  linkTargetSchema,
  mediaRefSchema,
  optionalPlainText,
  plainText,
  reasonCodeSchema,
  relativePathSchema,
  themeSpecSchema,
  SPEC_SCHEMA_VERSION,
} from './common';

/**
 * `MultiStepFormSpec` — the contract between the console builder, the public
 * funnel runtime, the AI pipeline and the E2E suite.
 *
 * The document is **declarative only**: routing and qualification are groups of
 * atomic comparisons over `fieldId` + option ids, using exactly the eight
 * operators from `@am/domain`. There is no expression language, no regex, no
 * script hook and no external URL that has not been flagged for allowlist
 * checking. Anything a spec cannot express is a missing feature of this schema,
 * never something an author works around with code.
 */

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

export type ConditionValue = string | number | boolean | string[] | null;

/** One atomic comparison: `<field> <operator> <value>`. */
export interface ConditionAtom {
  fieldId: string;
  operator: ConditionOperator;
  /** Option id(s) for select fields, scalar for number/boolean/text, `null` for the unary operators. */
  value: ConditionValue;
}

export type ConditionNode = ConditionAtom | ConditionGroup;

/** Boolean grouping. `all` is AND, `any` is OR; groups nest arbitrarily. */
export type ConditionGroup = { all: ConditionNode[] } | { any: ConditionNode[] };

export const conditionValueSchema = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(50),
  z.null(),
]);

export const conditionAtomSchema = z.object({
  fieldId: keySchema,
  operator: conditionOperatorSchema,
  value: conditionValueSchema,
});

export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([conditionAtomSchema, conditionGroupSchema]),
);

export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionNodeSchema).min(1).max(20) }),
    z.object({ any: z.array(conditionNodeSchema).min(1).max(20) }),
  ]),
);

export function isConditionGroup(node: ConditionNode): node is ConditionGroup {
  return typeof node === 'object' && node !== null && ('all' in node || 'any' in node);
}

/** Operators that ignore `value` entirely. */
export const UNARY_OPERATORS: readonly ConditionOperator[] = ['IS_EMPTY', 'IS_NOT_EMPTY'];

/** Operators that expect a list of option ids. */
export const LIST_OPERATORS: readonly ConditionOperator[] = ['IN', 'NOT_IN'];

/** Operators that expect a numeric comparison value. */
export const NUMERIC_OPERATORS: readonly ConditionOperator[] = ['GREATER_THAN', 'LESS_THAN'];

export function atom(
  fieldId: string,
  operator: ConditionOperator,
  value: ConditionValue = null,
): ConditionAtom {
  return { fieldId, operator, value };
}

export function allOf(...nodes: ConditionNode[]): ConditionGroup {
  return { all: nodes };
}

export function anyOf(...nodes: ConditionNode[]): ConditionGroup {
  return { any: nodes };
}

/** Collects every `fieldId` referenced anywhere inside a condition tree. */
export function conditionFieldIds(node: ConditionNode): string[] {
  if (isConditionGroup(node)) {
    const children = 'all' in node ? node.all : node.any;
    return children.flatMap((child) => conditionFieldIds(child));
  }
  return [node.fieldId];
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

export const NORMALIZATION_RULES = [
  'NONE',
  'TRIM',
  'COLLAPSE_WHITESPACE',
  'LOWERCASE',
  'EMAIL',
  'PHONE_E164',
  'POSTCODE_DE',
  'DIGITS_ONLY',
  'INTEGER',
] as const;
export const normalizationRuleSchema = z.enum(NORMALIZATION_RULES);
export type NormalizationRule = z.infer<typeof normalizationRuleSchema>;

/** The normalisation every field type gets unless the author overrides it. */
export const DEFAULT_NORMALIZATION: Readonly<Record<FieldType, NormalizationRule>> = {
  SINGLE_SELECT: 'NONE',
  MULTI_SELECT: 'NONE',
  BOOLEAN: 'NONE',
  NUMBER: 'NONE',
  RANGE: 'NONE',
  SHORT_TEXT: 'COLLAPSE_WHITESPACE',
  LONG_TEXT: 'COLLAPSE_WHITESPACE',
  POSTCODE: 'POSTCODE_DE',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE_E164',
  FIRST_NAME: 'COLLAPSE_WHITESPACE',
  LAST_NAME: 'COLLAPSE_WHITESPACE',
  CONSENT: 'NONE',
};

/** Sensible `maxLength` per field type. */
export const DEFAULT_MAX_LENGTH: Readonly<Record<FieldType, number>> = {
  SINGLE_SELECT: 64,
  MULTI_SELECT: 64,
  BOOLEAN: 5,
  NUMBER: 12,
  RANGE: 12,
  SHORT_TEXT: 200,
  LONG_TEXT: 2000,
  POSTCODE: 5,
  EMAIL: 254,
  PHONE: 32,
  FIRST_NAME: 80,
  LAST_NAME: 80,
  CONSENT: 5,
};

/**
 * An answer option. The stable `optionId` is what rules, analytics and HubSpot
 * see; `label` is the visible German text and may be rewritten at any time
 * without invalidating historical answers.
 */
export const fieldOptionSchema = z.object({
  optionId: keySchema,
  label: plainText(200),
  helpText: optionalPlainText(300),
  /** Points added to the qualification score when this option is selected. */
  score: z.number().int().min(-100).max(100),
});
export type FieldOption = z.infer<typeof fieldOptionSchema>;

/**
 * Mapping slot for the CRM. `null` means "no mapping supplied yet" — the real
 * HubSpot internal property names arrive later and are never invented here
 * (AGENTS.md rule 1). `confirmed` only ever becomes true after a live schema
 * read.
 */
export const hubspotPropertyMappingSchema = z.object({
  object: z.enum(['CONTACT', 'COMPANY', 'DEAL']),
  property: z.string().min(1).max(120),
  confirmed: z.boolean(),
});
export type HubspotPropertyMapping = z.infer<typeof hubspotPropertyMappingSchema>;

const fieldBase = z.object({
  /** Stable spec key. Also the record key under `spec.fields`. */
  fieldId: keySchema,
  /** Visible German label. */
  label: plainText(200),
  helpText: optionalPlainText(400),
  placeholder: optionalPlainText(120),
  required: z.boolean(),
  piiClass: piiClassSchema,
  qualificationClass: qualificationClassSchema,
  normalization: normalizationRuleSchema,
  maxLength: z.number().int().min(1).max(8000),
  /** Filled in once the real HubSpot mapping arrives. */
  hubspotProperty: hubspotPropertyMappingSchema.nullable(),
  /** Conditional visibility inside its step; `null` means always visible. */
  visibleWhen: conditionGroupSchema.nullable(),
});

const textLike = fieldBase.extend({ minLength: z.number().int().min(0).max(8000) });

export const formFieldSchema = z.discriminatedUnion('type', [
  fieldBase.extend({
    type: z.literal('SINGLE_SELECT'),
    options: z.array(fieldOptionSchema).min(2).max(12),
    display: z.enum(['CARDS', 'RADIO', 'DROPDOWN']),
  }),
  fieldBase.extend({
    type: z.literal('MULTI_SELECT'),
    options: z.array(fieldOptionSchema).min(2).max(12),
    minSelected: z.number().int().min(0).max(12),
    maxSelected: z.number().int().min(1).max(12),
  }),
  fieldBase.extend({
    type: z.literal('BOOLEAN'),
    trueLabel: plainText(60),
    falseLabel: plainText(60),
  }),
  fieldBase.extend({
    type: z.literal('NUMBER'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    unit: optionalPlainText(20),
  }),
  fieldBase.extend({
    type: z.literal('RANGE'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    unit: optionalPlainText(20),
    minLabel: optionalPlainText(60),
    maxLabel: optionalPlainText(60),
  }),
  textLike.extend({ type: z.literal('SHORT_TEXT') }),
  textLike.extend({ type: z.literal('LONG_TEXT'), rows: z.number().int().min(2).max(12) }),
  fieldBase.extend({ type: z.literal('POSTCODE'), country: z.literal('DE') }),
  fieldBase.extend({ type: z.literal('EMAIL') }),
  fieldBase.extend({ type: z.literal('PHONE'), defaultCountry: z.literal('+49') }),
  textLike.extend({ type: z.literal('FIRST_NAME') }),
  textLike.extend({ type: z.literal('LAST_NAME') }),
  fieldBase.extend({
    type: z.literal('CONSENT'),
    /** Must reference the same consent version as `spec.consent`. */
    consentVersionId: uuidSchema,
  }),
]);
export type FormField = z.infer<typeof formFieldSchema>;

export type SelectField = Extract<FormField, { type: 'SINGLE_SELECT' | 'MULTI_SELECT' }>;

export function isSelectField(field: FormField): field is SelectField {
  return field.type === 'SINGLE_SELECT' || field.type === 'MULTI_SELECT';
}

/** Field types that carry personal data no matter how they are configured. */
export function isContactField(field: FormField): boolean {
  return (
    field.piiClass === 'PII' ||
    field.type === 'EMAIL' ||
    field.type === 'PHONE' ||
    field.type === 'FIRST_NAME' ||
    field.type === 'LAST_NAME'
  );
}

/** Every field type is supported; there is deliberately no upload field. */
export const SUPPORTED_FIELD_TYPES = fieldTypeSchema.options;

/* -------------------------------------------------------------------------- */
/* Steps and routing                                                           */
/* -------------------------------------------------------------------------- */

export const STEP_KINDS = ['QUESTION', 'LOCATION', 'CONTACT', 'CONSENT', 'REVIEW'] as const;
export const stepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof stepKindSchema>;

/**
 * Where a transition leads. Three of the four kinds are terminal — that is what
 * makes "every path terminates" a decidable property of the graph.
 */
export const stepTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('STEP'), stepId: keySchema }),
  z.object({ kind: z.literal('SUBMIT') }),
  z.object({ kind: z.literal('RESULT'), variantId: keySchema }),
  z.object({
    kind: z.literal('DISQUALIFY'),
    variantId: keySchema,
    reasonCode: reasonCodeSchema,
  }),
]);
export type StepTarget = z.infer<typeof stepTargetSchema>;

/** A transition that ends the flow: submit, a result variant, a disqualification. */
export type TerminalTarget = Exclude<StepTarget, { kind: 'STEP' }>;

export function isTerminalTarget(target: StepTarget): target is TerminalTarget {
  return target.kind !== 'STEP';
}

export const formStepSchema = z.object({
  stepId: keySchema,
  kind: stepKindSchema,
  title: plainText(160),
  subtitle: optionalPlainText(400),
  /** Field ids rendered on this step, in order. */
  fieldIds: z.array(keySchema).max(12),
  primaryCtaLabel: plainText(60),
  secondaryCtaLabel: optionalPlainText(60),
  showProgress: z.boolean(),
  /** Taken when no routing rule for this step matches. */
  defaultNext: stepTargetSchema,
});
export type FormStep = z.infer<typeof formStepSchema>;

/**
 * Declarative branching. Rules are evaluated in array order for the step they
 * belong to; the first match wins and `step.defaultNext` is the fallthrough.
 */
export const routingRuleSchema = z.object({
  ruleId: keySchema,
  fromStepId: keySchema,
  when: conditionGroupSchema,
  target: stepTargetSchema,
  /** German explanation shown in the builder. */
  description: plainText(300),
});
export type RoutingRule = z.infer<typeof routingRuleSchema>;

/* -------------------------------------------------------------------------- */
/* Qualification                                                               */
/* -------------------------------------------------------------------------- */

export const QUALIFICATION_OUTCOMES = ['QUALIFIED', 'NEEDS_REVIEW', 'NOT_A_FIT'] as const;
export const qualificationOutcomeSchema = z.enum(QUALIFICATION_OUTCOMES);
export type QualificationOutcome = z.infer<typeof qualificationOutcomeSchema>;

export const QUALIFICATION_OUTCOME_LABELS_DE: Readonly<Record<QualificationOutcome, string>> = {
  QUALIFIED: 'Qualifiziert',
  NEEDS_REVIEW: 'Manuelle Prüfung',
  NOT_A_FIT: 'Nicht passend',
};

/**
 * Qualification is a scoreboard, not a program.
 *
 * - `SCORE` adds points when its condition matches (on top of the option scores
 *   of every `SCORING` field).
 * - `DISQUALIFY` forces `NOT_A_FIT` immediately.
 * - `QUALIFY` forces `QUALIFIED` unless a disqualifier matched.
 * - `CLASSIFY` maps the final score onto an outcome; the matching rule with the
 *   highest `minScore` wins. Thresholds therefore live inside the rule list and
 *   need no separate configuration block.
 */
export const qualificationRuleSchema = z.discriminatedUnion('effect', [
  z.object({
    effect: z.literal('SCORE'),
    ruleId: keySchema,
    when: conditionGroupSchema,
    points: z.number().int().min(-100).max(100),
    reasonCode: reasonCodeSchema,
    description: plainText(300),
  }),
  z.object({
    effect: z.literal('DISQUALIFY'),
    ruleId: keySchema,
    when: conditionGroupSchema,
    reasonCode: reasonCodeSchema,
    description: plainText(300),
  }),
  z.object({
    effect: z.literal('QUALIFY'),
    ruleId: keySchema,
    when: conditionGroupSchema,
    reasonCode: reasonCodeSchema,
    description: plainText(300),
  }),
  z.object({
    effect: z.literal('CLASSIFY'),
    ruleId: keySchema,
    /** `null` means "applies to every submission". */
    when: conditionGroupSchema.nullable(),
    minScore: z.number().int().min(-1000).max(1000),
    outcome: qualificationOutcomeSchema,
    reasonCode: reasonCodeSchema,
    description: plainText(300),
  }),
]);
export type QualificationRule = z.infer<typeof qualificationRuleSchema>;

export interface QualificationResult {
  outcome: QualificationOutcome;
  matchedRuleIds: string[];
  score: number;
  reasonCodes: string[];
}

/* -------------------------------------------------------------------------- */
/* Result variants                                                             */
/* -------------------------------------------------------------------------- */

const resultBase = z.object({
  variantId: keySchema,
  /** Restricts the variant to these outcomes; `[]` means "any outcome". */
  forOutcomes: z.array(qualificationOutcomeSchema).max(3),
  /** Additional answer condition; `null` means "no further condition". */
  showWhen: conditionGroupSchema.nullable(),
  headline: plainText(200),
  body: plainText(2000),
});

/** One rule-based block of an analysis result. */
export const analysisSectionSchema = z.object({
  key: keySchema,
  title: plainText(160),
  body: plainText(2000),
  showWhen: conditionGroupSchema.nullable(),
});
export type AnalysisSection = z.infer<typeof analysisSectionSchema>;

export const resultVariantSchema = z.discriminatedUnion('kind', [
  resultBase.extend({
    kind: z.literal('THANK_YOU'),
    bullets: z.array(plainText(200)).max(6),
    cta: ctaSpecSchema.nullable(),
  }),
  resultBase.extend({
    kind: z.literal('LEAD_MAGNET'),
    /** In-app download route; `null` while the asset has not been uploaded. */
    assetPath: relativePathSchema.nullable(),
    assetLabel: plainText(120),
    deliveryNote: plainText(400),
  }),
  resultBase.extend({
    kind: z.literal('ANALYSIS'),
    /** Rule-based: each section renders only when its condition matches. */
    sections: z.array(analysisSectionSchema).min(1).max(10),
    cta: ctaSpecSchema.nullable(),
    /** Rendered next to every computed statement. */
    methodNote: plainText(400),
  }),
  resultBase.extend({
    kind: z.literal('QUALIFIED'),
    bullets: z.array(plainText(200)).max(6),
    cta: ctaSpecSchema.nullable(),
    booking: bookingSpecSchema.nullable(),
  }),
  resultBase.extend({
    kind: z.literal('NOT_A_FIT'),
    /** Honest alternative offered instead of a booking. */
    alternativeNote: plainText(600),
    cta: ctaSpecSchema.nullable(),
  }),
  resultBase.extend({
    kind: z.literal('BOOKING'),
    booking: bookingSpecSchema,
    bullets: z.array(plainText(200)).max(6),
  }),
  resultBase.extend({
    kind: z.literal('REDIRECT'),
    target: linkTargetSchema,
    delaySeconds: z.number().int().min(0).max(30),
  }),
]);
export type ResultVariant = z.infer<typeof resultVariantSchema>;

/* -------------------------------------------------------------------------- */
/* Intro, submit, success                                                      */
/* -------------------------------------------------------------------------- */

export const introSpecSchema = z.object({
  eyebrow: optionalPlainText(80),
  headline: plainText(160),
  subline: optionalPlainText(400),
  bullets: z.array(plainText(200)).max(6),
  /** e.g. "2 Minuten" — the effort promise the offer makes. */
  effortPromise: optionalPlainText(80),
  trustNote: optionalPlainText(200),
  primaryCtaLabel: plainText(60),
  media: mediaRefSchema.nullable(),
});
export type IntroSpec = z.infer<typeof introSpecSchema>;

export const submitSpecSchema = z.object({
  /** In-app route; the runtime never posts to a third party directly. */
  endpointPath: relativePathSchema,
  submitLabel: plainText(60),
  submittingLabel: plainText(60),
  errorMessage: plainText(300),
  requireDoubleOptIn: z.boolean(),
  /** Hidden anti-spam field; `null` disables the honeypot. */
  honeypotFieldId: keySchema.nullable(),
  minCompletionSeconds: z.number().int().min(0).max(600),
  maxAttemptsPerHour: z.number().int().min(1).max(100),
});
export type SubmitSpec = z.infer<typeof submitSpecSchema>;

/** The terminal state after a successful submission. */
export const successSpecSchema = z.object({
  headline: plainText(200),
  body: plainText(2000),
  bullets: z.array(plainText(200)).max(6),
  primaryCta: ctaSpecSchema.nullable(),
  secondaryCta: ctaSpecSchema.nullable(),
  booking: bookingSpecSchema.nullable(),
  /** Optional automatic redirect after the thank-you state was rendered. */
  redirect: z
    .object({
      target: linkTargetSchema,
      delaySeconds: z.number().int().min(0).max(30),
    })
    .nullable(),
  showAnswerSummary: z.boolean(),
  legalNote: optionalPlainText(600),
});
export type SuccessSpec = z.infer<typeof successSpecSchema>;

/* -------------------------------------------------------------------------- */
/* MultiStepFormSpec                                                           */
/* -------------------------------------------------------------------------- */

export const multiStepFormSpecSchema = z.object({
  kind: z.literal('MULTI_STEP_FORM'),
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  formId: uuidSchema,
  formVersionId: uuidSchema,
  locale: localeSchema,
  title: plainText(200),
  offerId: uuidSchema,
  angleId: uuidSchema,
  intro: introSpecSchema,
  steps: z.array(formStepSchema).min(1).max(20),
  fields: z.record(keySchema, formFieldSchema),
  routingRules: z.array(routingRuleSchema).max(60),
  qualificationRules: z.array(qualificationRuleSchema).max(60),
  resultVariants: z.array(resultVariantSchema).min(1).max(10),
  consent: consentSpecSchema,
  submit: submitSpecSchema,
  success: successSpecSchema,
  theme: themeSpecSchema,
});
export type MultiStepFormSpec = z.infer<typeof multiStepFormSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Accessors                                                                   */
/* -------------------------------------------------------------------------- */

/** The entry step is always the first step in document order. */
export function entryStepId(spec: MultiStepFormSpec): string | null {
  return spec.steps[0]?.stepId ?? null;
}

export function getStep(spec: MultiStepFormSpec, stepId: string): FormStep | null {
  return spec.steps.find((step) => step.stepId === stepId) ?? null;
}

export function getField(spec: MultiStepFormSpec, fieldId: string): FormField | null {
  return spec.fields[fieldId] ?? null;
}

export function getResultVariant(spec: MultiStepFormSpec, variantId: string): ResultVariant | null {
  return spec.resultVariants.find((variant) => variant.variantId === variantId) ?? null;
}

export function routingRulesFor(spec: MultiStepFormSpec, stepId: string): RoutingRule[] {
  return spec.routingRules.filter((rule) => rule.fromStepId === stepId);
}

/** Every outgoing edge of a step: its routing rules first, then the fallthrough. */
export function outgoingTargets(spec: MultiStepFormSpec, stepId: string): StepTarget[] {
  const step = getStep(spec, stepId);
  if (!step) return [];
  return [...routingRulesFor(spec, stepId).map((rule) => rule.target), step.defaultNext];
}

/** The step a field is rendered on, or `null` when it is not placed anywhere. */
export function stepOfField(spec: MultiStepFormSpec, fieldId: string): FormStep | null {
  return spec.steps.find((step) => step.fieldIds.includes(fieldId)) ?? null;
}
