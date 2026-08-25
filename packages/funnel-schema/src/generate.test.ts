import { describe, expect, it } from 'vitest';
import { FIELD_TYPES, isDomainError } from '@am/domain';
import { FIXTURE_CONSENT_TEXT_DE, FIXTURE_IDS, LANDING_PAGE_SPEC } from './fixtures';
import {
  buildDefaultHybrid,
  buildDefaultLandingPage,
  buildDefaultMultiStepForm,
  defaultQualificationQuestions,
  type BuildFormInput,
  type BuildPageInput,
  type QuestionDraft,
} from './generate';
import {
  formFieldSchema,
  DEFAULT_MAX_LENGTH,
  DEFAULT_NORMALIZATION,
  SUPPORTED_FIELD_TYPES,
} from './form-spec';
import { errorsOf, validateFormSpec, validateHybridSpec, validatePageSpec } from './validate';

const baseInput: BuildFormInput = {
  formId: FIXTURE_IDS.formId,
  formVersionId: FIXTURE_IDS.formVersionId,
  offerId: FIXTURE_IDS.offerId,
  angleId: FIXTURE_IDS.angleId,
  title: 'Kostenlose Potenzialanalyse',
  offerType: 'POTENTIAL_ANALYSIS',
  angleName: 'planbare Anfragen',
  consent: {
    consentVersionId: FIXTURE_IDS.consentVersionId,
    textDe: FIXTURE_CONSENT_TEXT_DE,
    purposes: ['CONTACT'],
    privacyPolicyUrl: '/datenschutz',
  },
};

describe('buildDefaultMultiStepForm — the mandated default flow', () => {
  it('produces a spec that validates without a single error', () => {
    const spec = buildDefaultMultiStepForm(baseInput);
    expect(errorsOf(validateFormSpec(spec))).toEqual([]);
  });

  it('asks exactly five qualification questions by default', () => {
    const spec = buildDefaultMultiStepForm(baseInput);
    const questionSteps = spec.steps.filter((step) => step.kind === 'QUESTION');
    expect(questionSteps).toHaveLength(5);
    expect(defaultQualificationQuestions('planbare Anfragen')).toHaveLength(5);
  });

  it('orders the flow intro → Fragen → Postleitzahl → Kontakt → Einwilligung → Abschluss', () => {
    const spec = buildDefaultMultiStepForm(baseInput);

    expect(spec.intro.headline.length).toBeGreaterThan(0);
    expect(spec.steps.map((step) => step.kind)).toEqual([
      'QUESTION',
      'QUESTION',
      'QUESTION',
      'QUESTION',
      'QUESTION',
      'LOCATION',
      'CONTACT',
    ]);

    const contact = spec.steps[6];
    expect(contact.fieldIds).toContain('einwilligung');
    expect(contact.fieldIds[contact.fieldIds.length - 1]).toBe('einwilligung');
    expect(contact.defaultNext).toEqual({ kind: 'SUBMIT' });
    expect(spec.resultVariants.some((variant) => variant.kind === 'THANK_YOU')).toBe(true);
  });

  it('keeps consent required and unticked', () => {
    const spec = buildDefaultMultiStepForm(baseInput);
    expect(spec.consent.required).toBe(true);
    expect(spec.consent.defaultChecked).toBe(false);
    expect(spec.fields.einwilligung.required).toBe(true);
  });

  it('accepts four to seven questions and rejects anything else', () => {
    const question = (index: number): QuestionDraft => ({
      key: `frage_${index}`,
      label: `Frage ${index}?`,
      options: [
        { id: 'ja', label: 'Ja', score: 2 },
        { id: 'nein', label: 'Nein', score: 0 },
      ],
    });

    for (const count of [4, 5, 6, 7]) {
      const questions = Array.from({ length: count }, (_, index) => question(index + 1));
      const spec = buildDefaultMultiStepForm({ ...baseInput, questions });
      expect(spec.steps.filter((step) => step.kind === 'QUESTION')).toHaveLength(count);
      expect(errorsOf(validateFormSpec(spec))).toEqual([]);
    }

    for (const count of [3, 8]) {
      const questions = Array.from({ length: count }, (_, index) => question(index + 1));
      expect(() => buildDefaultMultiStepForm({ ...baseInput, questions })).toThrow(
        /Qualifizierungsfragen/,
      );
      try {
        buildDefaultMultiStepForm({ ...baseInput, questions });
      } catch (error) {
        expect(isDomainError(error) && error.code).toBe('VALIDATION_FAILED');
      }
    }
  });

  it('leaves every HubSpot mapping slot empty until a real mapping arrives', () => {
    const spec = buildDefaultMultiStepForm(baseInput);
    expect(Object.values(spec.fields).every((field) => field.hubspotProperty === null)).toBe(true);
  });

  it('never invents a booking link', () => {
    const spec = buildDefaultMultiStepForm({
      ...baseInput,
      booking: { label: 'Termin auswählen' },
    });
    expect(spec.success.booking?.target).toBeNull();
    expect(errorsOf(validateFormSpec(spec))).toEqual([]);
  });

  it('flags a supplied booking link for the allowlist check', () => {
    const spec = buildDefaultMultiStepForm({
      ...baseInput,
      booking: { href: 'https://meetings.example/am/erstgespraech' },
    });
    expect(spec.success.booking?.target?.requiresAllowlist).toBe(true);
    expect(errorsOf(validateFormSpec(spec))).toEqual([]);
  });

  it('routes a disqualifying answer straight to the not-a-fit variant', () => {
    const spec = buildDefaultMultiStepForm(baseInput);
    const rule = spec.routingRules.find((entry) => entry.ruleId === 'routing_disq_werbebudget');
    expect(rule?.target).toEqual({
      kind: 'DISQUALIFY',
      variantId: 'nicht_passend',
      reasonCode: 'NICHT_PASSEND_WERBEBUDGET',
    });
  });

  it('merges brand token overrides without dropping the rest of the theme', () => {
    const spec = buildDefaultMultiStepForm({
      ...baseInput,
      theme: { radius: 'FULL', colors: { primary: '#123456' } },
    });
    expect(spec.theme.radius).toBe('FULL');
    expect(spec.theme.colors.primary).toBe('#123456');
    expect(spec.theme.colors.background).toBe('#FFFFFF');
  });
});

describe('field types', () => {
  it('supports all thirteen field types and no upload field', () => {
    expect(SUPPORTED_FIELD_TYPES).toHaveLength(13);
    expect([...SUPPORTED_FIELD_TYPES]).toEqual([...FIELD_TYPES]);
    expect(SUPPORTED_FIELD_TYPES).not.toContain('UPLOAD');
  });

  it('parses one field of every type', () => {
    const extras: Record<string, Record<string, unknown>> = {
      SINGLE_SELECT: {
        options: [
          { optionId: 'a', label: 'A', helpText: null, score: 1 },
          { optionId: 'b', label: 'B', helpText: null, score: 0 },
        ],
        display: 'CARDS',
      },
      MULTI_SELECT: {
        options: [
          { optionId: 'a', label: 'A', helpText: null, score: 1 },
          { optionId: 'b', label: 'B', helpText: null, score: 0 },
        ],
        minSelected: 1,
        maxSelected: 2,
      },
      BOOLEAN: { trueLabel: 'Ja', falseLabel: 'Nein' },
      NUMBER: { min: 0, max: 10, step: 1, unit: null },
      RANGE: { min: 0, max: 10, step: 1, unit: null, minLabel: null, maxLabel: null },
      SHORT_TEXT: { minLength: 0 },
      LONG_TEXT: { minLength: 0, rows: 4 },
      POSTCODE: { country: 'DE' },
      EMAIL: {},
      PHONE: { defaultCountry: '+49' },
      FIRST_NAME: { minLength: 0 },
      LAST_NAME: { minLength: 0 },
      CONSENT: { consentVersionId: FIXTURE_IDS.consentVersionId },
    };

    for (const type of FIELD_TYPES) {
      const parsed = formFieldSchema.safeParse({
        fieldId: 'testfeld',
        type,
        label: 'Testfeld',
        helpText: null,
        placeholder: null,
        required: true,
        piiClass: 'QUALIFICATION',
        qualificationClass: 'NONE',
        normalization: DEFAULT_NORMALIZATION[type],
        maxLength: DEFAULT_MAX_LENGTH[type],
        hubspotProperty: null,
        visibleWhen: null,
        ...extras[type],
      });
      expect(parsed.success, `${type} sollte parsen`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

const minimalPage: BuildPageInput = {
  pageId: FIXTURE_IDS.landingPageId,
  pageVersionId: FIXTURE_IDS.landingPageVersionId,
  offerId: FIXTURE_IDS.offerId,
  angleId: FIXTURE_IDS.angleId,
  title: 'Planbare Anfragen',
  slug: 'planbare-anfragen',
  hero: {
    headline: 'Planbare Anfragen statt Empfehlungsglück',
    primaryCtaLabel: 'Potenzialanalyse starten',
  },
  legal: { companyLine: 'A&M Marketing GmbH, Musterstraße 1, 48431 Rheine' },
};

describe('buildDefaultLandingPage / buildDefaultHybrid', () => {
  it('builds a minimal page that still carries imprint and privacy links', () => {
    const page = buildDefaultLandingPage(minimalPage);
    expect(errorsOf(validatePageSpec(page))).toEqual([]);
    expect(page.blocks.map((block) => block.type)).toEqual(['HERO', 'FOOTER_LEGAL']);
    expect(page.seo.noindex).toBe(true);
  });

  it('emits the canonical block order for a full page', () => {
    expect(LANDING_PAGE_SPEC.blocks.map((block) => block.type)).toEqual([
      'HERO',
      'PROBLEM',
      'BENEFIT',
      'PROOF',
      'PROCESS',
      'CASE_STUDY',
      'TESTIMONIAL',
      'COMPARISON',
      'OBJECTION_HANDLING',
      'FAQ',
      'TRUST',
      'CTA',
      'FOOTER_LEGAL',
    ]);
  });

  it('keeps a hybrid short and never drops the legal footer', () => {
    const hybrid = buildDefaultHybrid({
      ...minimalPage,
      pageId: FIXTURE_IDS.hybridPageId,
      pageVersionId: FIXTURE_IDS.hybridPageVersionId,
      slug: 'planbare-anfragen-kurz',
      form: {
        mode: 'MODAL',
        formId: FIXTURE_IDS.formId,
        formVersionId: FIXTURE_IDS.formVersionId,
        triggerLabel: 'Analyse starten',
        anchorBlockId: null,
      },
      formSpec: buildDefaultMultiStepForm(baseInput),
    });

    expect(hybrid.blocks.length).toBeLessThanOrEqual(8);
    expect(hybrid.blocks[hybrid.blocks.length - 1].type).toBe('FOOTER_LEGAL');
    expect(errorsOf(validateHybridSpec(hybrid))).toEqual([]);
  });

  it('drops an anchor reference that does not exist on the trimmed page', () => {
    const hybrid = buildDefaultHybrid({
      ...minimalPage,
      pageId: FIXTURE_IDS.hybridPageId,
      pageVersionId: FIXTURE_IDS.hybridPageVersionId,
      slug: 'planbare-anfragen-kurz',
      form: {
        mode: 'INLINE',
        formId: FIXTURE_IDS.formId,
        formVersionId: FIXTURE_IDS.formVersionId,
        triggerLabel: 'Analyse starten',
        anchorBlockId: 'gibt_es_nicht',
      },
    });

    expect(hybrid.form.anchorBlockId).toBeNull();
    expect(errorsOf(validateHybridSpec(hybrid))).toEqual([]);
  });
});
