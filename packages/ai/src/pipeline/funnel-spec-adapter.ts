import type { ConfidenceLabel, ConsentPurpose, FieldType, OfferType } from '@am/domain';
import { DomainError } from '@am/domain';
import {
  buildDefaultLandingPage,
  buildDefaultMultiStepForm,
  type LandingPageSpec,
  type MultiStepFormSpec,
  type QuestionDraft,
  type QuestionFieldType,
} from '@am/funnel-schema';
import { clampText } from '../text';
import type { FunnelSpecDraft } from '../prompts/schemas';

/**
 * The single point where `@am/ai` touches `@am/funnel-schema`.
 *
 * Step 10 has the model emit a `FunnelSpecDraft` — structure and German copy,
 * never markup — and this file turns that draft into the real
 * `MultiStepFormSpec` / `LandingPageSpec`. Keeping the coupling in one module
 * means a change to the funnel document shape touches one file here, not the
 * prompt registry and not the pipeline.
 *
 * Two things are deliberately *not* taken from the model:
 *
 * - qualification scores and disqualifying options, because those are numeric
 *   decisions (AGENTS.md rule 4) configured in the console;
 * - consent version, privacy URL and the legal company line, because inventing
 *   any of them would be a fabricated external (AGENTS.md rule 1).
 */

/** Draft field types that can become a qualification question. */
const QUESTION_FIELD_TYPES: readonly FieldType[] = [
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
  'NUMBER',
  'RANGE',
  'SHORT_TEXT',
  'LONG_TEXT',
];

function isQuestionFieldType(type: FieldType): type is QuestionFieldType {
  return QUESTION_FIELD_TYPES.includes(type);
}

export interface FormAdapterOptions {
  formId: string;
  formVersionId: string;
  offerId: string;
  angleId: string;
  angleName: string;
  offerType: OfferType;
  offerName?: string;
  effortPromise?: string | null;
  /** Supplied by the workspace consent configuration — never invented. */
  consentVersionId: string;
  privacyPolicyUrl: string;
  consentPurposes?: readonly ConsentPurpose[];
  collectPhone?: boolean;
  collectCompany?: boolean;
}

export interface PageAdapterOptions {
  pageId: string;
  pageVersionId: string;
  offerId: string;
  angleId: string;
  slug: string;
  /** Legal footer line from the workspace settings. */
  companyLine: string;
  /**
   * Confidence attached to generated proof points. Defaults to HYPOTHESIS: the
   * model may arrange a proof section, it may not certify one.
   */
  proofConfidence?: ConfidenceLabel;
}

/* -------------------------------------------------------------------------- */
/* Multi-step form                                                             */
/* -------------------------------------------------------------------------- */

export function draftToQuestions(draft: FunnelSpecDraft): QuestionDraft[] {
  return draft.steps.flatMap((step) =>
    step.fields
      .filter((field) => field.piiClass !== 'PII' && isQuestionFieldType(field.type))
      .map((field): QuestionDraft => ({
        key: field.key,
        label: field.labelDe,
        helpText: field.helpTextDe,
        type: field.type as QuestionFieldType,
        required: field.required,
        qualificationClass: field.qualification,
        // Scores and disqualifying flags stay unset on purpose — see the
        // module comment.
        options: field.options.map((option) => ({ id: option.key, label: option.labelDe })),
      })),
  );
}

export function toMultiStepFormSpec(
  draft: FunnelSpecDraft,
  options: FormAdapterOptions,
): MultiStepFormSpec {
  if (draft.kind === 'LANDING_PAGE') {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Ein Landingpage-Entwurf kann nicht in ein mehrstufiges Formular übersetzt werden.',
      details: { funnelKey: draft.funnelKey, kind: draft.kind },
    });
  }

  const questions = draftToQuestions(draft);
  if (questions.length === 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Der Funnel-Entwurf enthält keine Qualifizierungsfragen.',
      details: { funnelKey: draft.funnelKey },
    });
  }

  return buildDefaultMultiStepForm({
    formId: options.formId,
    formVersionId: options.formVersionId,
    offerId: options.offerId,
    angleId: options.angleId,
    title: clampText(draft.headlineDe, 200),
    offerType: options.offerType,
    angleName: options.angleName,
    ...(options.offerName ? { offerName: options.offerName } : {}),
    effortPromise: options.effortPromise ?? null,
    intro: {
      headline: clampText(draft.headlineDe, 200),
      subline: clampText(draft.subheadlineDe, 300),
      primaryCtaLabel: clampText(draft.ctaLabelDe, 60),
    },
    questions,
    consent: {
      consentVersionId: options.consentVersionId,
      textDe: draft.consentTextDe,
      purposes: [...(options.consentPurposes ?? ['CONTACT'])],
      privacyPolicyUrl: options.privacyPolicyUrl,
    },
    ...(options.collectPhone !== undefined ? { collectPhone: options.collectPhone } : {}),
    ...(options.collectCompany !== undefined ? { collectCompany: options.collectCompany } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Landing page                                                                */
/* -------------------------------------------------------------------------- */

function sectionOf(draft: FunnelSpecDraft, kind: FunnelSpecDraft['sections'][number]['kind']) {
  return draft.sections.find((section) => section.kind === kind) ?? null;
}

function keyedItems(
  bullets: readonly string[],
  prefix: string,
  fallbackBody: string,
): { key: string; title: string; body: string }[] {
  return bullets.map((bullet, index) => ({
    key: `${prefix}_${index + 1}`,
    title: clampText(bullet, 120),
    body: clampText(bullet.length > 120 ? bullet : fallbackBody, 600),
  }));
}

/** Splits "Frage? Antwort." into its two halves; falls back to the section body. */
function splitQuestionAnswer(bullet: string, fallbackAnswer: string): { question: string; answer: string } {
  const mark = bullet.indexOf('?');
  if (mark > 0 && mark < bullet.length - 1) {
    return {
      question: clampText(bullet.slice(0, mark + 1), 300),
      answer: clampText(bullet.slice(mark + 1), 2000),
    };
  }
  return { question: clampText(bullet, 300), answer: clampText(fallbackAnswer, 2000) };
}

export function toLandingPageSpec(
  draft: FunnelSpecDraft,
  options: PageAdapterOptions,
): LandingPageSpec {
  const hero = sectionOf(draft, 'HERO');
  const problem = sectionOf(draft, 'PROBLEM');
  const benefits = sectionOf(draft, 'BENEFITS');
  const proof = sectionOf(draft, 'PROOF');
  const process = sectionOf(draft, 'PROCESS');
  const faq = sectionOf(draft, 'FAQ');
  const cta = sectionOf(draft, 'CTA');
  const confidence: ConfidenceLabel = options.proofConfidence ?? 'HYPOTHESIS';

  return buildDefaultLandingPage({
    pageId: options.pageId,
    pageVersionId: options.pageVersionId,
    offerId: options.offerId,
    angleId: options.angleId,
    title: clampText(draft.headlineDe, 200),
    slug: options.slug,
    hero: {
      headline: clampText(hero?.headlineDe ?? draft.headlineDe, 160),
      subline: clampText(hero?.bodyDe ?? draft.subheadlineDe, 300),
      bullets: (hero?.bulletsDe ?? []).map((bullet) => clampText(bullet, 200)),
      primaryCtaLabel: clampText(draft.ctaLabelDe, 60),
    },
    ...(problem
      ? {
          problem: {
            headline: clampText(problem.headlineDe, 160),
            intro: clampText(problem.bodyDe, 600),
            points: keyedItems(problem.bulletsDe, 'problem', problem.bodyDe),
          },
        }
      : {}),
    ...(benefits
      ? {
          benefits: {
            headline: clampText(benefits.headlineDe, 160),
            items: keyedItems(benefits.bulletsDe, 'nutzen', benefits.bodyDe),
          },
        }
      : {}),
    ...(proof
      ? {
          proof: {
            headline: clampText(proof.headlineDe, 160),
            // A proof point carries no figure unless approved evidence supplies
            // one; "—" says so honestly instead of inventing a number.
            points: proof.bulletsDe.map((bullet, index) => ({
              key: `beleg_${index + 1}`,
              label: clampText(bullet, 160),
              value: '—',
              note: null,
              evidenceItemId: null,
              confidence,
            })),
            sourceNote: clampText(proof.bodyDe, 300),
          },
        }
      : {}),
    ...(process
      ? {
          process: {
            headline: clampText(process.headlineDe, 160),
            intro: clampText(process.bodyDe, 600),
            steps: keyedItems(process.bulletsDe, 'schritt', process.bodyDe).map((item) => ({
              ...item,
              durationNote: null,
            })),
          },
        }
      : {}),
    ...(faq
      ? {
          faq: {
            headline: clampText(faq.headlineDe, 160),
            items: (faq.bulletsDe.length > 0
              ? faq.bulletsDe.map((bullet) => splitQuestionAnswer(bullet, faq.bodyDe))
              : [{ question: clampText(faq.headlineDe, 300), answer: clampText(faq.bodyDe, 2000) }]
            ).map((item, index) => ({ key: `faq_${index + 1}`, ...item })),
          },
        }
      : {}),
    cta: {
      headline: clampText(cta?.headlineDe ?? draft.headlineDe, 160),
      body: clampText(cta?.bodyDe ?? draft.resultScreenDe, 600),
      label: clampText(draft.ctaLabelDe, 60),
    },
    legal: { companyLine: options.companyLine },
  });
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

export type AdaptedFunnelSpec =
  | { kind: 'MULTI_STEP_FORM'; spec: MultiStepFormSpec }
  | { kind: 'LANDING_PAGE'; spec: LandingPageSpec };

/**
 * Converts a draft into the concrete funnel document. `HYBRID` drafts are built
 * as multi-step forms; the page shell around them is composed by the console,
 * which owns the embedded-form reference.
 */
export function toFunnelSpec(
  draft: FunnelSpecDraft,
  options: FormAdapterOptions & PageAdapterOptions,
): AdaptedFunnelSpec {
  if (draft.kind === 'LANDING_PAGE') {
    return { kind: 'LANDING_PAGE', spec: toLandingPageSpec(draft, options) };
  }
  return { kind: 'MULTI_STEP_FORM', spec: toMultiStepFormSpec(draft, options) };
}
