import { describe, expect, it } from 'vitest';
import {
  computeProgress,
  evaluateCondition,
  evaluateQualification,
  isAnswerEmpty,
  nextStepId,
  nextTarget,
  normalizeAnswers,
  normalizeValue,
  pathFor,
  selectResultVariant,
  splitAnswers,
  validateAnswer,
  validateStep,
  validateSubmission,
  visibleSteps,
  type Answers,
} from './evaluate';
import {
  DISQUALIFIED_ANSWERS,
  PARTIAL_ANSWERS,
  POTENZIALANALYSE_FORM_SPEC,
  QUALIFIED_ANSWERS,
} from './fixtures';
import { allOf, anyOf, atom, type FormField, type MultiStepFormSpec } from './form-spec';

function spec(): MultiStepFormSpec {
  return structuredClone(POTENZIALANALYSE_FORM_SPEC);
}

function field(fieldId: string): FormField {
  const found = POTENZIALANALYSE_FORM_SPEC.fields[fieldId];
  if (!found) throw new Error(`Fixture field ${fieldId} missing`);
  return structuredClone(found);
}

/* -------------------------------------------------------------------------- */
/* Operators                                                                   */
/* -------------------------------------------------------------------------- */

describe('evaluateCondition — the eight operators', () => {
  const answers: Answers = {
    rolle: 'marketing',
    quellen: ['empfehlung', 'google'],
    anfragen: 12,
    aktiv: false,
    leer: '',
    liste_leer: [],
  };

  it('EQUALS compares scalars, and matches membership for list answers', () => {
    expect(evaluateCondition(atom('rolle', 'EQUALS', 'marketing'), answers)).toBe(true);
    expect(evaluateCondition(atom('rolle', 'EQUALS', 'vertrieb'), answers)).toBe(false);
    expect(evaluateCondition(atom('quellen', 'EQUALS', 'google'), answers)).toBe(true);
    expect(evaluateCondition(atom('anfragen', 'EQUALS', '12'), answers)).toBe(true);
    expect(evaluateCondition(atom('aktiv', 'EQUALS', false), answers)).toBe(true);
  });

  it('NOT_EQUALS is the negation for answered questions', () => {
    expect(evaluateCondition(atom('rolle', 'NOT_EQUALS', 'vertrieb'), answers)).toBe(true);
    expect(evaluateCondition(atom('rolle', 'NOT_EQUALS', 'marketing'), answers)).toBe(false);
  });

  it('IN and NOT_IN work on scalars and on multi-select answers', () => {
    expect(evaluateCondition(atom('rolle', 'IN', ['marketing', 'vertrieb']), answers)).toBe(true);
    expect(evaluateCondition(atom('rolle', 'NOT_IN', ['marketing']), answers)).toBe(false);
    expect(evaluateCondition(atom('quellen', 'IN', ['google']), answers)).toBe(true);
    expect(evaluateCondition(atom('quellen', 'NOT_IN', ['social']), answers)).toBe(true);
  });

  it('GREATER_THAN and LESS_THAN coerce numeric text', () => {
    expect(evaluateCondition(atom('anfragen', 'GREATER_THAN', 10), answers)).toBe(true);
    expect(evaluateCondition(atom('anfragen', 'LESS_THAN', 10), answers)).toBe(false);
    expect(evaluateCondition(atom('anfragen', 'LESS_THAN', '20'), answers)).toBe(true);
    /* A non-numeric answer never satisfies a numeric comparison. */
    expect(evaluateCondition(atom('rolle', 'GREATER_THAN', 1), answers)).toBe(false);
  });

  it('IS_EMPTY and IS_NOT_EMPTY are the only operators that inspect emptiness', () => {
    expect(evaluateCondition(atom('unbeantwortet', 'IS_EMPTY'), answers)).toBe(true);
    expect(evaluateCondition(atom('leer', 'IS_EMPTY'), answers)).toBe(true);
    expect(evaluateCondition(atom('liste_leer', 'IS_EMPTY'), answers)).toBe(true);
    expect(evaluateCondition(atom('rolle', 'IS_NOT_EMPTY'), answers)).toBe(true);
    /* `false` and `0` are answers, not emptiness. */
    expect(evaluateCondition(atom('aktiv', 'IS_EMPTY'), answers)).toBe(false);
    expect(evaluateCondition(atom('anfragen', 'IS_NOT_EMPTY'), answers)).toBe(true);
  });

  it('lets no comparison succeed on an empty answer — not even NOT_EQUALS', () => {
    const empty: Answers = { rolle: null, quellen: [], text: '   ' };
    for (const operator of [
      'EQUALS',
      'NOT_EQUALS',
      'IN',
      'NOT_IN',
      'GREATER_THAN',
      'LESS_THAN',
    ] as const) {
      const value = operator === 'IN' || operator === 'NOT_IN' ? ['marketing'] : 'marketing';
      expect(evaluateCondition(atom('rolle', operator, value), empty)).toBe(false);
      expect(evaluateCondition(atom('fehlt', operator, value), empty)).toBe(false);
      expect(evaluateCondition(atom('text', operator, value), empty)).toBe(false);
    }
  });

  it('evaluates nested all / any groups', () => {
    const condition = allOf(
      atom('rolle', 'EQUALS', 'marketing'),
      anyOf(atom('anfragen', 'GREATER_THAN', 100), atom('quellen', 'IN', ['google'])),
    );
    expect(evaluateCondition(condition, answers)).toBe(true);

    const failing = allOf(atom('rolle', 'EQUALS', 'vertrieb'), atom('quellen', 'IN', ['google']));
    expect(evaluateCondition(failing, answers)).toBe(false);
  });

  it('classifies emptiness consistently', () => {
    expect(isAnswerEmpty(undefined)).toBe(true);
    expect(isAnswerEmpty(null)).toBe(true);
    expect(isAnswerEmpty(' ')).toBe(true);
    expect(isAnswerEmpty([])).toBe(true);
    expect(isAnswerEmpty(false)).toBe(false);
    expect(isAnswerEmpty(0)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

describe('nextStepId / pathFor — deterministic branching', () => {
  it('walks the full path for a qualified visitor', () => {
    const path = pathFor(POTENZIALANALYSE_FORM_SPEC, QUALIFIED_ANSWERS);
    expect(path.stepIds).toEqual([
      'frage_1',
      'frage_2',
      'frage_3',
      'frage_4',
      'frage_5',
      'standort',
      'kontakt',
    ]);
    expect(path.terminal?.kind).toBe('SUBMIT');
    expect(path.truncated).toBe(false);
  });

  it('leaves the flow at the disqualifying answer', () => {
    const path = pathFor(POTENZIALANALYSE_FORM_SPEC, DISQUALIFIED_ANSWERS);
    expect(path.stepIds).toEqual(['frage_1', 'frage_2', 'frage_3', 'frage_4']);
    expect(path.terminal).toEqual({
      kind: 'DISQUALIFY',
      variantId: 'nicht_passend',
      reasonCode: 'NICHT_PASSEND_WERBEBUDGET',
    });
  });

  it('applies routing rules before the default fallthrough', () => {
    expect(nextStepId(POTENZIALANALYSE_FORM_SPEC, 'frage_4', QUALIFIED_ANSWERS)).toBe('frage_5');
    expect(nextStepId(POTENZIALANALYSE_FORM_SPEC, 'frage_4', DISQUALIFIED_ANSWERS)).toBeNull();
    expect(nextTarget(POTENZIALANALYSE_FORM_SPEC, 'frage_4', DISQUALIFIED_ANSWERS)?.kind).toBe(
      'DISQUALIFY',
    );
  });

  it('returns the steps a visitor actually sees', () => {
    expect(
      visibleSteps(POTENZIALANALYSE_FORM_SPEC, DISQUALIFIED_ANSWERS).map((s) => s.kind),
    ).toEqual(['QUESTION', 'QUESTION', 'QUESTION', 'QUESTION']);
  });

  it('never loops forever on a cyclic spec', () => {
    const cyclic = spec();
    cyclic.steps[2].defaultNext = { kind: 'STEP', stepId: 'frage_1' };
    const path = pathFor(cyclic, QUALIFIED_ANSWERS);
    expect(path.truncated).toBe(true);
    expect(path.terminal).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

describe('computeProgress — never a misleading percentage', () => {
  it('is indeterminate while a branch is still undecided', () => {
    const progress = computeProgress(POTENZIALANALYSE_FORM_SPEC, 'frage_1', {});
    expect(progress.mode).toBe('indeterminate');
    expect(progress.knownTotal).toBeNull();
    expect(progress.stepIndex).toBe(1);
  });

  it('becomes exact once the branching answers are known', () => {
    const progress = computeProgress(POTENZIALANALYSE_FORM_SPEC, 'frage_1', QUALIFIED_ANSWERS);
    expect(progress).toEqual({ stepIndex: 1, knownTotal: 7, mode: 'exact' });
  });

  it('is exact on a linear spec even without answers', () => {
    const linear = spec();
    linear.routingRules = [];
    expect(computeProgress(linear, 'frage_1', {})).toEqual({
      stepIndex: 1,
      knownTotal: 7,
      mode: 'exact',
    });
  });

  it('counts the position along the path actually taken', () => {
    const progress = computeProgress(POTENZIALANALYSE_FORM_SPEC, 'standort', QUALIFIED_ANSWERS);
    expect(progress.stepIndex).toBe(6);
    expect(progress.knownTotal).toBe(7);
  });

  it('is indeterminate on a cyclic spec instead of throwing', () => {
    const cyclic = spec();
    cyclic.steps[2].defaultNext = { kind: 'STEP', stepId: 'frage_1' };
    expect(computeProgress(cyclic, 'frage_1', {}).mode).toBe('indeterminate');
  });
});

/* -------------------------------------------------------------------------- */
/* Qualification and results                                                   */
/* -------------------------------------------------------------------------- */

describe('evaluateQualification / selectResultVariant', () => {
  it('qualifies a visitor with a strong profile', () => {
    const result = evaluateQualification(POTENZIALANALYSE_FORM_SPEC, QUALIFIED_ANSWERS);
    expect(result.outcome).toBe('QUALIFIED');
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain('SCORE_HOCH');
    expect(result.matchedRuleIds).toContain('klasse_qualifiziert');
  });

  it('disqualifies on the budget answer regardless of the score', () => {
    const result = evaluateQualification(POTENZIALANALYSE_FORM_SPEC, DISQUALIFIED_ANSWERS);
    expect(result.outcome).toBe('NOT_A_FIT');
    expect(result.reasonCodes).toContain('NICHT_PASSEND_WERBEBUDGET');
  });

  it('selects the matching result variant per outcome', () => {
    const qualified = evaluateQualification(POTENZIALANALYSE_FORM_SPEC, QUALIFIED_ANSWERS);
    expect(
      selectResultVariant(POTENZIALANALYSE_FORM_SPEC, QUALIFIED_ANSWERS, qualified)?.variantId,
    ).toBe('analyse');

    const rejected = evaluateQualification(POTENZIALANALYSE_FORM_SPEC, DISQUALIFIED_ANSWERS);
    const variant = selectResultVariant(POTENZIALANALYSE_FORM_SPEC, DISQUALIFIED_ANSWERS, rejected);
    expect(variant?.variantId).toBe('nicht_passend');
    expect(variant?.kind).toBe('NOT_A_FIT');
  });

  it('sends an incomplete profile to the honest not-a-fit state', () => {
    const result = evaluateQualification(POTENZIALANALYSE_FORM_SPEC, PARTIAL_ANSWERS);
    expect(result.outcome).toBe('NOT_A_FIT');
    expect(result.reasonCodes).toContain('SCORE_ZU_NIEDRIG');
  });
});

/* -------------------------------------------------------------------------- */
/* Answer validation                                                           */
/* -------------------------------------------------------------------------- */

describe('validateAnswer', () => {
  it('rejects a postcode that is not five digits', () => {
    expect(validateAnswer(field('plz'), '4843')).toBe('INVALID_POSTCODE');
    expect(validateAnswer(field('plz'), '484311')).toBe('INVALID_POSTCODE');
    expect(validateAnswer(field('plz'), 'ABCDE')).toBe('INVALID_POSTCODE');
    expect(validateAnswer(field('plz'), '48431')).toBeNull();
  });

  it('rejects malformed e-mail addresses and phone numbers', () => {
    expect(validateAnswer(field('email'), 'keine-adresse')).toBe('INVALID_EMAIL');
    expect(validateAnswer(field('email'), 'k.bergmann@example.de')).toBeNull();
    expect(validateAnswer(field('telefon'), 'ruf mich an')).toBe('INVALID_PHONE');
    expect(validateAnswer(field('telefon'), '02571 987654')).toBeNull();
  });

  it('reports REQUIRED for an empty mandatory field', () => {
    expect(validateAnswer(field('rolle'), null)).toBe('REQUIRED');
    expect(validateAnswer(field('rolle'), '')).toBe('REQUIRED');
  });

  it('rejects an option that is not offered', () => {
    expect(validateAnswer(field('rolle'), 'ceo')).toBe('UNKNOWN_OPTION');
    expect(validateAnswer(field('anfragequellen'), ['empfehlung', 'tiktok'])).toBe(
      'UNKNOWN_OPTION',
    );
  });

  it('requires an actively ticked consent box', () => {
    expect(validateAnswer(field('einwilligung'), false)).toBe('CONSENT_REQUIRED');
    expect(validateAnswer(field('einwilligung'), null)).toBe('CONSENT_REQUIRED');
    expect(validateAnswer(field('einwilligung'), true)).toBeNull();
  });

  it('reports OUT_OF_RANGE for numbers outside their bounds', () => {
    const numeric: FormField = {
      ...field('plz'),
      fieldId: 'mitarbeitende',
      type: 'NUMBER',
      label: 'Wie viele Mitarbeitende?',
      min: 1,
      max: 500,
      step: 1,
      unit: null,
      normalization: 'INTEGER',
      maxLength: 5,
    };
    expect(validateAnswer(numeric, 700)).toBe('OUT_OF_RANGE');
    expect(validateAnswer(numeric, 24)).toBeNull();
  });
});

describe('validateStep / validateSubmission — one implementation for client and server', () => {
  it('accepts a complete submission', () => {
    expect(validateSubmission(POTENZIALANALYSE_FORM_SPEC, QUALIFIED_ANSWERS).ok).toBe(true);
  });

  it('rejects a submission without consent and explains it in German', () => {
    const withoutConsent = { ...QUALIFIED_ANSWERS, einwilligung: false };
    const result = validateSubmission(POTENZIALANALYSE_FORM_SPEC, withoutConsent);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('CONSENT_REQUIRED');
    expect(result.errors[0]?.messageDe).toContain('Bitte');
  });

  it('reports every missing field of a step at once', () => {
    const result = validateStep(POTENZIALANALYSE_FORM_SPEC, 'kontakt', {});
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.fieldId)).toEqual([
      'vorname',
      'nachname',
      'email',
      'firma',
      'telefon',
      'einwilligung',
    ]);
  });

  it('skips fields whose visibility condition does not match', () => {
    const conditional = spec();
    conditional.fields.firma.visibleWhen = anyOf(atom('rolle', 'EQUALS', 'vertrieb'));
    const result = validateStep(conditional, 'kontakt', { rolle: 'marketing' });
    expect(result.errors.map((error) => error.fieldId)).not.toContain('firma');
  });
});

/* -------------------------------------------------------------------------- */
/* Normalisation and PII split                                                 */
/* -------------------------------------------------------------------------- */

describe('normalizeAnswers', () => {
  it('applies each field rule', () => {
    const normalized = normalizeAnswers(POTENZIALANALYSE_FORM_SPEC, {
      email: '  Katrin.Bergmann@Example.DE ',
      telefon: '02571 / 98 76 54',
      plz: '48 431',
      vorname: '  Katrin   ',
      rolle: 'geschaeftsfuehrung',
    });

    expect(normalized.email).toBe('katrin.bergmann@example.de');
    expect(normalized.telefon).toBe('+492571987654');
    expect(normalized.plz).toBe('48431');
    expect(normalized.vorname).toBe('Katrin');
    expect(normalized.rolle).toBe('geschaeftsfuehrung');
  });

  it('keeps an unnormalisable phone number verbatim instead of guessing', () => {
    expect(normalizeValue('PHONE_E164', ' 12 ')).toBe('12');
  });

  it('passes unknown keys through untouched', () => {
    expect(normalizeAnswers(POTENZIALANALYSE_FORM_SPEC, { fremd: ' X ' }).fremd).toBe(' X ');
  });
});

describe('splitAnswers', () => {
  it('never routes contact data into the non-PII bucket', () => {
    const split = splitAnswers(POTENZIALANALYSE_FORM_SPEC, QUALIFIED_ANSWERS);

    for (const fieldId of ['email', 'telefon', 'vorname', 'nachname', 'firma']) {
      expect(split.nonPii).not.toHaveProperty(fieldId);
      expect(split.operational).not.toHaveProperty(fieldId);
      expect(split.pii).toHaveProperty(fieldId);
    }

    expect(Object.keys(split.nonPii).sort()).toEqual([
      'anfragen_pro_monat',
      'anfragequellen',
      'plz',
      'rolle',
      'werbebudget',
      'zeitpunkt',
    ]);
    expect(split.operational).toHaveProperty('einwilligung');
  });

  it('overrides a mislabelled contact field and fails closed on unknown keys', () => {
    const mislabelled = spec();
    mislabelled.fields.email.piiClass = 'QUALIFICATION';

    const split = splitAnswers(mislabelled, { ...QUALIFIED_ANSWERS, fremdes_feld: 'a@b.de' });
    expect(split.pii).toHaveProperty('email');
    expect(split.nonPii).not.toHaveProperty('email');
    expect(split.pii).toHaveProperty('fremdes_feld');
  });
});
