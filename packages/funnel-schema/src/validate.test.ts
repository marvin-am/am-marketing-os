import { describe, expect, it } from 'vitest';
import { HYBRID_FUNNEL_SPEC, LANDING_PAGE_SPEC, POTENZIALANALYSE_FORM_SPEC } from './fixtures';
import { anyOf, atom, type FormStep, type MultiStepFormSpec } from './form-spec';
import { type LandingPageSpec } from './page-spec';
import {
  errorsOf,
  hasBlockingIssues,
  parseFormSpec,
  validateFormSpec,
  validateHybridSpec,
  validatePageSpec,
  type ValidationIssueCode,
} from './validate';

function formSpec(): MultiStepFormSpec {
  return structuredClone(POTENZIALANALYSE_FORM_SPEC);
}

function pageSpec(): LandingPageSpec {
  return structuredClone(LANDING_PAGE_SPEC);
}

function codes(spec: MultiStepFormSpec): ValidationIssueCode[] {
  return errorsOf(validateFormSpec(spec)).map((issue) => issue.code);
}

function step(spec: MultiStepFormSpec, stepId: string): FormStep {
  const found = spec.steps.find((entry) => entry.stepId === stepId);
  if (!found) throw new Error(`Fixture step ${stepId} missing`);
  return found;
}

describe('validateFormSpec — the fixtures are publishable', () => {
  it('reports no errors for the Potenzialanalyse fixture', () => {
    const issues = validateFormSpec(POTENZIALANALYSE_FORM_SPEC);
    expect(errorsOf(issues)).toEqual([]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('produces German messages and paths', () => {
    const spec = formSpec();
    step(spec, 'frage_2').defaultNext = { kind: 'STEP', stepId: 'frage_1' };
    const [issue] = errorsOf(validateFormSpec(spec));
    expect(issue?.messageDe).toMatch(/[a-zäöüß]/i);
    expect(issue?.pathDe.length).toBeGreaterThan(0);
  });
});

describe('validateFormSpec — step graph', () => {
  it('rejects a cyclic step graph', () => {
    const spec = formSpec();
    step(spec, 'frage_3').defaultNext = { kind: 'STEP', stepId: 'frage_2' };

    const issues = errorsOf(validateFormSpec(spec));
    const cycle = issues.find((issue) => issue.code === 'STEP_GRAPH_CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.messageDe).toContain('Kreis');
  });

  it('rejects an unreachable step', () => {
    const spec = formSpec();
    spec.steps.push({
      stepId: 'waisenschritt',
      kind: 'QUESTION',
      title: 'Nie erreichbar',
      subtitle: null,
      fieldIds: [],
      primaryCtaLabel: 'Weiter',
      secondaryCtaLabel: null,
      showProgress: true,
      defaultNext: { kind: 'SUBMIT' },
    });

    expect(codes(spec)).toContain('STEP_UNREACHABLE');
  });

  it('rejects a path that dead-ends in an unknown step', () => {
    const spec = formSpec();
    step(spec, 'frage_5').defaultNext = { kind: 'STEP', stepId: 'gibt_es_nicht' };

    const found = codes(spec);
    expect(found).toContain('UNKNOWN_STEP_TARGET');
    expect(found).toContain('STEP_NOT_TERMINATING');
  });

  it('rejects a transition into an unknown result variant', () => {
    const spec = formSpec();
    step(spec, 'kontakt').defaultNext = { kind: 'RESULT', variantId: 'unbekannt' };

    expect(codes(spec)).toContain('UNKNOWN_RESULT_VARIANT');
  });

  it('accepts a disqualification as a valid termination', () => {
    const spec = formSpec();
    step(spec, 'frage_5').defaultNext = {
      kind: 'DISQUALIFY',
      variantId: 'nicht_passend',
      reasonCode: 'MANUELL_BEENDET',
    };

    expect(codes(spec)).not.toContain('STEP_NOT_TERMINATING');
  });
});

describe('validateFormSpec — rules', () => {
  it('rejects a rule referencing an unknown field', () => {
    const spec = formSpec();
    spec.routingRules.push({
      ruleId: 'routing_unbekannt',
      fromStepId: 'frage_1',
      when: anyOf(atom('gibt_es_nicht', 'EQUALS', 'ja')),
      target: { kind: 'STEP', stepId: 'standort' },
      description: 'Verweist auf ein Feld, das es nicht gibt.',
    });

    expect(codes(spec)).toContain('UNKNOWN_FIELD_IN_RULE');
  });

  it('rejects a rule referencing an unknown option id', () => {
    const spec = formSpec();
    spec.routingRules.push({
      ruleId: 'routing_unbekannte_option',
      fromStepId: 'frage_1',
      when: anyOf(atom('rolle', 'IN', ['ceo'])),
      target: { kind: 'STEP', stepId: 'standort' },
      description: 'Verweist auf eine Antwort, die es nicht gibt.',
    });

    const issues = errorsOf(validateFormSpec(spec));
    const unknown = issues.find((issue) => issue.code === 'UNKNOWN_OPTION_IN_RULE');
    expect(unknown).toBeDefined();
    expect(unknown?.messageDe).toContain('ceo');
  });

  it('rejects branching on a question that has not been asked yet', () => {
    const spec = formSpec();
    spec.routingRules.push({
      ruleId: 'routing_zu_frueh',
      fromStepId: 'frage_1',
      when: anyOf(atom('zeitpunkt', 'EQUALS', 'sofort')),
      target: { kind: 'STEP', stepId: 'standort' },
      description: 'Verzweigt anhand einer späteren Frage.',
    });

    expect(codes(spec)).toContain('RULE_FIELD_NOT_ANSWERED_YET');
  });

  it('rejects IN without a list of option ids', () => {
    const spec = formSpec();
    spec.routingRules.push({
      ruleId: 'routing_kein_array',
      fromStepId: 'frage_1',
      when: anyOf(atom('rolle', 'IN', 'marketing')),
      target: { kind: 'STEP', stepId: 'standort' },
      description: 'IN erwartet eine Liste.',
    });

    expect(codes(spec)).toContain('LIST_OPERATOR_WITHOUT_LIST');
  });
});

describe('validateFormSpec — fields, PII and consent', () => {
  it('rejects contact fields that are not asked last', () => {
    const spec = formSpec();
    spec.fields.nachtrag = {
      fieldId: 'nachtrag',
      type: 'SHORT_TEXT',
      label: 'Womit dürfen wir starten?',
      helpText: null,
      placeholder: null,
      required: true,
      piiClass: 'QUALIFICATION',
      qualificationClass: 'NONE',
      normalization: 'COLLAPSE_WHITESPACE',
      maxLength: 200,
      minLength: 2,
      hubspotProperty: null,
      visibleWhen: null,
    };
    spec.steps.push({
      stepId: 'nachfrage',
      kind: 'QUESTION',
      title: 'Eine letzte Frage',
      subtitle: null,
      fieldIds: ['nachtrag'],
      primaryCtaLabel: 'Weiter',
      secondaryCtaLabel: null,
      showProgress: true,
      defaultNext: { kind: 'SUBMIT' },
    });
    step(spec, 'kontakt').defaultNext = { kind: 'STEP', stepId: 'nachfrage' };

    const issues = errorsOf(validateFormSpec(spec));
    const piiIssue = issues.find((issue) => issue.code === 'PII_NOT_LAST_STEP');
    expect(piiIssue).toBeDefined();
    expect(piiIssue?.messageDe).toContain('Kontaktdaten');
  });

  it('allows a separate consent step after the contact step', () => {
    const spec = formSpec();
    const kontakt = step(spec, 'kontakt');
    kontakt.fieldIds = kontakt.fieldIds.filter((fieldId) => fieldId !== 'einwilligung');
    kontakt.defaultNext = { kind: 'STEP', stepId: 'einwilligung_schritt' };
    spec.steps.push({
      stepId: 'einwilligung_schritt',
      kind: 'CONSENT',
      title: 'Einverständnis',
      subtitle: null,
      fieldIds: ['einwilligung'],
      primaryCtaLabel: 'Absenden',
      secondaryCtaLabel: 'Zurück',
      showProgress: false,
      defaultNext: { kind: 'SUBMIT' },
    });

    expect(codes(spec)).not.toContain('PII_NOT_LAST_STEP');
  });

  it('rejects a pre-checked consent box', () => {
    const spec = formSpec();
    (spec.consent as { defaultChecked: boolean }).defaultChecked = true;

    const issues = errorsOf(validateFormSpec(spec));
    expect(issues.map((issue) => issue.code)).toContain('CONSENT_PRECHECKED');
  });

  it('rejects a missing consent field', () => {
    const spec = formSpec();
    delete spec.fields.einwilligung;

    expect(codes(spec)).toContain('CONSENT_FIELD_MISSING');
  });

  it('rejects a postcode field that is not a five-digit German one', () => {
    const spec = formSpec();
    const postcode = spec.fields.plz;
    if (postcode.type !== 'POSTCODE') throw new Error('Fixture postcode field missing');
    postcode.maxLength = 10;

    expect(codes(spec)).toContain('POSTCODE_NOT_DE5');
  });

  it('rejects an empty label', () => {
    const spec = formSpec();
    spec.fields.rolle.label = '   ';

    expect(codes(spec)).toContain('EMPTY_LABEL');
  });

  it('rejects a field key that does not match its fieldId', () => {
    const spec = formSpec();
    spec.fields.rolle.fieldId = 'position';

    expect(codes(spec)).toContain('FIELD_ID_MISMATCH');
  });

  it('rejects a contact field that is not classified as PII', () => {
    const spec = formSpec();
    spec.fields.email.piiClass = 'QUALIFICATION';

    expect(codes(spec)).toContain('PII_CLASS_MISMATCH');
  });
});

describe('validateFormSpec — redirects and markup', () => {
  it('rejects an external redirect that is not flagged for the allowlist', () => {
    const spec = formSpec();
    spec.resultVariants.push({
      kind: 'REDIRECT',
      variantId: 'weiterleitung',
      forOutcomes: [],
      showWhen: null,
      headline: 'Weiterleitung',
      body: 'Sie werden weitergeleitet.',
      target: {
        href: 'https://fremde-domain.example/danke',
        external: true,
        requiresAllowlist: false,
        newTab: false,
      },
      delaySeconds: 0,
    });

    expect(codes(spec)).toContain('REDIRECT_NOT_ALLOWLISTED');
  });

  it('warns about a flagged external redirect instead of blocking it', () => {
    const spec = formSpec();
    spec.resultVariants.push({
      kind: 'REDIRECT',
      variantId: 'weiterleitung',
      forOutcomes: [],
      showWhen: null,
      headline: 'Weiterleitung',
      body: 'Sie werden weitergeleitet.',
      target: {
        href: 'https://partner.example/danke',
        external: true,
        requiresAllowlist: true,
        newTab: false,
      },
      delaySeconds: 3,
    });

    const issues = validateFormSpec(spec);
    expect(errorsOf(issues)).toEqual([]);
    expect(issues.map((issue) => issue.code)).toContain('REDIRECT_ALLOWLIST_PENDING');
  });

  it('rejects markup smuggled into a headline', () => {
    const spec = formSpec();
    spec.intro.headline = 'Jetzt starten <script>alert(1)</script>';

    expect(codes(spec)).toContain('MARKUP_NOT_ALLOWED');
  });
});

describe('parseFormSpec', () => {
  it('rejects untrusted input that is not a spec at all', () => {
    const result = parseFormSpec({ kind: 'MULTI_STEP_FORM' });
    expect(result.spec).toBeNull();
    expect(result.issues.every((issue) => issue.code === 'SCHEMA_INVALID')).toBe(true);
  });

  it('accepts the fixture round-tripped through JSON', () => {
    const result = parseFormSpec(JSON.parse(JSON.stringify(POTENZIALANALYSE_FORM_SPEC)));
    expect(result.spec).not.toBeNull();
    expect(errorsOf(result.issues)).toEqual([]);
  });
});

describe('validatePageSpec / validateHybridSpec', () => {
  it('accepts the landing page fixture', () => {
    expect(errorsOf(validatePageSpec(LANDING_PAGE_SPEC))).toEqual([]);
  });

  it('accepts the hybrid fixture including its embedded form', () => {
    expect(errorsOf(validateHybridSpec(HYBRID_FUNNEL_SPEC))).toEqual([]);
  });

  it('rejects a page without imprint and privacy links', () => {
    const spec = pageSpec();
    spec.blocks = spec.blocks.filter((block) => block.type !== 'FOOTER_LEGAL');

    expect(errorsOf(validatePageSpec(spec)).map((issue) => issue.code)).toContain('PAGE_NO_LEGAL');
  });

  it('rejects a comparison row with the wrong number of cells', () => {
    const spec = pageSpec();
    const comparison = spec.blocks.find((block) => block.type === 'COMPARISON');
    if (comparison?.type !== 'COMPARISON') throw new Error('Fixture comparison block missing');
    comparison.rows[0].cells = ['nur eine Spalte', 'und eine zweite'];

    expect(errorsOf(validatePageSpec(spec)).map((issue) => issue.code)).toContain(
      'COMPARISON_SHAPE_INVALID',
    );
  });

  it('rejects a hybrid whose embedded form belongs to another version', () => {
    const spec = structuredClone(HYBRID_FUNNEL_SPEC);
    spec.form.formVersionId = '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6aff';

    expect(errorsOf(validateHybridSpec(spec)).map((issue) => issue.code)).toContain(
      'HYBRID_FORM_REF_MISMATCH',
    );
  });
});
