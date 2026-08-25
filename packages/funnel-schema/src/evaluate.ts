import {
  emailSchema,
  normalizeEmail,
  normalizePhoneE164,
  postcodeDeSchema,
  VALIDATION_MESSAGES_DE,
  type ConditionOperator,
  type PiiClass,
  type ValidationErrorCode,
} from '@am/domain';
import {
  conditionFieldIds,
  entryStepId,
  getField,
  getStep,
  isConditionGroup,
  isContactField,
  isTerminalTarget,
  routingRulesFor,
  type ConditionGroup,
  type ConditionNode,
  type ConditionValue,
  type FormField,
  type FormStep,
  type MultiStepFormSpec,
  type NormalizationRule,
  type QualificationOutcome,
  type QualificationResult,
  type ResultVariant,
  type StepTarget,
} from './form-spec';

/**
 * The runtime engine.
 *
 * Every function here is pure and free of DOM, React and I/O, because the
 * builder preview, the public runtime and the server-side submission handler all
 * call *these* functions. A branch that behaves differently in preview than in
 * production is impossible by construction, and client-side validation can never
 * disagree with the server.
 *
 * ## Null / empty semantics
 *
 * A value counts as **empty** when it is `undefined`, `null`, an empty or
 * whitespace-only string, or an empty array. `false` and `0` are answers, not
 * emptiness.
 *
 * The single rule that governs the operators: **an empty answer satisfies no
 * comparison.** `EQUALS`, `NOT_EQUALS`, `IN`, `NOT_IN`, `GREATER_THAN` and
 * `LESS_THAN` all return `false` when the answer is empty — including
 * `NOT_EQUALS`, so an unanswered question never routes a visitor down a "not X"
 * branch. Emptiness is inspected exclusively by `IS_EMPTY` / `IS_NOT_EMPTY`.
 */

/* -------------------------------------------------------------------------- */
/* Answers                                                                     */
/* -------------------------------------------------------------------------- */

export type AnswerValue = string | number | boolean | string[] | null | undefined;
export type Answers = Record<string, AnswerValue>;

export function isAnswerEmpty(value: AnswerValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function toNumber(value: AnswerValue | ConditionValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) && value.trim().length > 0 ? parsed : null;
  }
  return null;
}

function toStringList(value: AnswerValue | ConditionValue): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === null || value === undefined) return [];
  return [String(value)];
}

/** Tolerant scalar comparison — HTML forms deliver numbers and booleans as text. */
function scalarEquals(answer: AnswerValue, value: ConditionValue): boolean {
  if (typeof answer === 'boolean' || typeof value === 'boolean') {
    const asBool = (input: AnswerValue | ConditionValue): boolean | null => {
      if (typeof input === 'boolean') return input;
      if (input === 'true') return true;
      if (input === 'false') return false;
      return null;
    };
    const left = asBool(answer);
    const right = asBool(value);
    return left !== null && right !== null && left === right;
  }
  if (typeof answer === 'number' || typeof value === 'number') {
    const left = toNumber(answer);
    const right = toNumber(value);
    return left !== null && right !== null && left === right;
  }
  return String(answer) === String(value);
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

function evaluateOperator(
  operator: ConditionOperator,
  answer: AnswerValue,
  value: ConditionValue,
): boolean {
  const empty = isAnswerEmpty(answer);

  if (operator === 'IS_EMPTY') return empty;
  if (operator === 'IS_NOT_EMPTY') return !empty;
  if (empty) return false;

  switch (operator) {
    case 'EQUALS':
    case 'NOT_EQUALS': {
      let equal: boolean;
      if (Array.isArray(answer) && Array.isArray(value)) {
        const left = [...toStringList(answer)].sort();
        const right = [...toStringList(value)].sort();
        equal = left.length === right.length && left.every((item, i) => item === right[i]);
      } else if (Array.isArray(answer)) {
        equal = toStringList(answer).includes(String(value));
      } else if (Array.isArray(value)) {
        equal = false;
      } else {
        equal = scalarEquals(answer, value);
      }
      return operator === 'EQUALS' ? equal : !equal;
    }
    case 'IN':
    case 'NOT_IN': {
      const candidates = toStringList(value);
      const given = toStringList(answer);
      const hit = given.some((item) => candidates.includes(item));
      return operator === 'IN' ? hit : !hit;
    }
    case 'GREATER_THAN':
    case 'LESS_THAN': {
      const left = toNumber(Array.isArray(answer) ? null : answer);
      const right = toNumber(Array.isArray(value) ? null : value);
      if (left === null || right === null) return false;
      return operator === 'GREATER_THAN' ? left > right : left < right;
    }
    default:
      return false;
  }
}

/** Evaluates an atomic comparison or a nested `all` / `any` group. */
export function evaluateCondition(condition: ConditionNode, answers: Answers): boolean {
  if (isConditionGroup(condition)) {
    if ('all' in condition) {
      return condition.all.every((child) => evaluateCondition(child, answers));
    }
    return condition.any.some((child) => evaluateCondition(child, answers));
  }
  return evaluateOperator(condition.operator, answers[condition.fieldId], condition.value);
}

/** A `null` condition means "no condition" and always matches. */
export function matchesOptional(condition: ConditionGroup | null, answers: Answers): boolean {
  return condition === null ? true : evaluateCondition(condition, answers);
}

/** Whether a field is currently rendered on its step. */
export function isFieldVisible(field: FormField, answers: Answers): boolean {
  return matchesOptional(field.visibleWhen, answers);
}

export function visibleFields(
  spec: MultiStepFormSpec,
  step: FormStep,
  answers: Answers,
): FormField[] {
  return step.fieldIds
    .map((fieldId) => getField(spec, fieldId))
    .filter((field): field is FormField => field !== null && isFieldVisible(field, answers));
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Applies the routing rules of `currentStepId` in document order; the first
 * match wins, `step.defaultNext` is the fallthrough.
 */
export function nextTarget(
  spec: MultiStepFormSpec,
  currentStepId: string,
  answers: Answers,
): StepTarget | null {
  const step = getStep(spec, currentStepId);
  if (!step) return null;
  for (const rule of routingRulesFor(spec, currentStepId)) {
    if (evaluateCondition(rule.when, answers)) return rule.target;
  }
  return step.defaultNext;
}

/** The next step id, or `null` when the transition is terminal or unknown. */
export function nextStepId(
  spec: MultiStepFormSpec,
  currentStepId: string,
  answers: Answers,
): string | null {
  const target = nextTarget(spec, currentStepId, answers);
  if (!target || target.kind !== 'STEP') return null;
  return target.stepId;
}

export interface FormPath {
  /** Step ids in visit order, starting at the entry step. */
  stepIds: string[];
  /** The terminal transition the path ends in, or `null` when it could not end. */
  terminal: StepTarget | null;
  /** True when the walk was aborted (dangling target or a cycle). */
  truncated: boolean;
}

/** The concrete traversal a visitor takes given the answers they have so far. */
export function pathFor(spec: MultiStepFormSpec, answers: Answers): FormPath {
  const stepIds: string[] = [];
  const seen = new Set<string>();
  let current = entryStepId(spec);

  while (current !== null) {
    if (seen.has(current)) return { stepIds, terminal: null, truncated: true };
    const step = getStep(spec, current);
    if (!step) return { stepIds, terminal: null, truncated: true };
    seen.add(current);
    stepIds.push(current);

    const target = nextTarget(spec, current, answers);
    if (!target) return { stepIds, terminal: null, truncated: true };
    if (isTerminalTarget(target)) return { stepIds, terminal: target, truncated: false };
    current = target.stepId;
  }

  return { stepIds, terminal: null, truncated: true };
}

/** The steps this visitor will actually see, given the answers so far. */
export function visibleSteps(spec: MultiStepFormSpec, answers: Answers): FormStep[] {
  return pathFor(spec, answers)
    .stepIds.map((stepId) => getStep(spec, stepId))
    .filter((step): step is FormStep => step !== null);
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProgressState {
  /** 1-based position of the current step on the path taken so far. */
  stepIndex: number;
  /** Total number of steps, or `null` when the remaining length is unknown. */
  knownTotal: number | null;
  mode: 'exact' | 'indeterminate';
}

/**
 * Are all routing decisions of this step already determined by the answers
 * given? Only then does the step have exactly one possible successor.
 */
function successorsOf(spec: MultiStepFormSpec, step: FormStep, answers: Answers): StepTarget[] {
  const rules = routingRulesFor(spec, step.stepId);
  const decided = rules.every((rule) =>
    conditionFieldIds(rule.when).every((fieldId) => !isAnswerEmpty(answers[fieldId])),
  );
  if (decided) {
    const target = nextTarget(spec, step.stepId, answers);
    return target ? [target] : [];
  }
  return [...rules.map((rule) => rule.target), step.defaultNext];
}

/**
 * Shortest and longest number of remaining steps (current step included) before
 * a terminal transition. `null` when the graph cannot be measured — a cycle or a
 * dangling target — which always renders as indeterminate.
 */
function remainingBounds(
  spec: MultiStepFormSpec,
  stepId: string,
  answers: Answers,
  onStack: Set<string>,
  memo: Map<string, { min: number; max: number } | null>,
): { min: number; max: number } | null {
  const cached = memo.get(stepId);
  if (cached !== undefined) return cached;
  if (onStack.has(stepId)) return null;

  const step = getStep(spec, stepId);
  if (!step) return null;

  onStack.add(stepId);
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let measurable = true;

  const targets = successorsOf(spec, step, answers);
  if (targets.length === 0) measurable = false;

  for (const target of targets) {
    if (target.kind !== 'STEP') {
      min = Math.min(min, 1);
      max = Math.max(max, 1);
      continue;
    }
    const child = remainingBounds(spec, target.stepId, answers, onStack, memo);
    if (!child) {
      measurable = false;
      break;
    }
    min = Math.min(min, child.min + 1);
    max = Math.max(max, child.max + 1);
  }

  onStack.delete(stepId);
  const result = measurable && Number.isFinite(min) ? { min, max } : null;
  memo.set(stepId, result);
  return result;
}

/**
 * Progress that never lies.
 *
 * A percentage is only reported when every possible continuation from the
 * current step has the same length. On a branched path — a disqualifying answer
 * that ends the form early, an optional deep-dive branch — the mode is
 * `indeterminate` and the UI shows "Schritt 3" instead of a fabricated "43 %".
 */
export function computeProgress(
  spec: MultiStepFormSpec,
  currentStepId: string,
  answers: Answers,
): ProgressState {
  const path = pathFor(spec, answers);
  const onPath = path.stepIds.indexOf(currentStepId);
  const documentIndex = spec.steps.findIndex((step) => step.stepId === currentStepId);
  const stepIndex = onPath >= 0 ? onPath + 1 : documentIndex >= 0 ? documentIndex + 1 : 1;

  const bounds = remainingBounds(spec, currentStepId, answers, new Set(), new Map());
  if (!bounds || bounds.min !== bounds.max) {
    return { stepIndex, knownTotal: null, mode: 'indeterminate' };
  }
  return { stepIndex, knownTotal: stepIndex - 1 + bounds.min, mode: 'exact' };
}

/* -------------------------------------------------------------------------- */
/* Qualification                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Points contributed by the selected options. A `DISQUALIFYING` field scores
 * like a `SCORING` one — a budget question both rules people out and rates the
 * ones who stay.
 */
function optionScore(spec: MultiStepFormSpec, answers: Answers): number {
  let score = 0;
  for (const field of Object.values(spec.fields)) {
    if (field.qualificationClass !== 'SCORING' && field.qualificationClass !== 'DISQUALIFYING') {
      continue;
    }
    if (field.type !== 'SINGLE_SELECT' && field.type !== 'MULTI_SELECT') continue;
    const selected = toStringList(answers[field.fieldId]);
    for (const option of field.options) {
      if (selected.includes(option.optionId)) score += option.score;
    }
  }
  return score;
}

/**
 * Deterministic qualification. Disqualifiers win over everything, an explicit
 * qualifier wins over the score, and the score is mapped onto an outcome by the
 * `CLASSIFY` rule with the highest satisfied `minScore`.
 */
export function evaluateQualification(
  spec: MultiStepFormSpec,
  answers: Answers,
): QualificationResult {
  const matchedRuleIds: string[] = [];
  const reasonCodes: string[] = [];
  let score = optionScore(spec, answers);

  for (const rule of spec.qualificationRules) {
    if (rule.effect !== 'SCORE') continue;
    if (evaluateCondition(rule.when, answers)) {
      score += rule.points;
      matchedRuleIds.push(rule.ruleId);
      reasonCodes.push(rule.reasonCode);
    }
  }

  const disqualifiers = spec.qualificationRules.filter(
    (rule) => rule.effect === 'DISQUALIFY' && evaluateCondition(rule.when, answers),
  );
  if (disqualifiers.length > 0) {
    return {
      outcome: 'NOT_A_FIT',
      score,
      matchedRuleIds: [...matchedRuleIds, ...disqualifiers.map((rule) => rule.ruleId)],
      reasonCodes: [...reasonCodes, ...disqualifiers.map((rule) => rule.reasonCode)],
    };
  }

  const qualifiers = spec.qualificationRules.filter(
    (rule) => rule.effect === 'QUALIFY' && evaluateCondition(rule.when, answers),
  );
  if (qualifiers.length > 0) {
    return {
      outcome: 'QUALIFIED',
      score,
      matchedRuleIds: [...matchedRuleIds, ...qualifiers.map((rule) => rule.ruleId)],
      reasonCodes: [...reasonCodes, ...qualifiers.map((rule) => rule.reasonCode)],
    };
  }

  let chosen: {
    outcome: QualificationOutcome;
    ruleId: string;
    reasonCode: string;
    minScore: number;
  } | null = null;
  for (const rule of spec.qualificationRules) {
    if (rule.effect !== 'CLASSIFY') continue;
    if (score < rule.minScore) continue;
    if (!matchesOptional(rule.when, answers)) continue;
    if (chosen === null || rule.minScore > chosen.minScore) {
      chosen = {
        outcome: rule.outcome,
        ruleId: rule.ruleId,
        reasonCode: rule.reasonCode,
        minScore: rule.minScore,
      };
    }
  }

  if (chosen) {
    return {
      outcome: chosen.outcome,
      score,
      matchedRuleIds: [...matchedRuleIds, chosen.ruleId],
      reasonCodes: [...reasonCodes, chosen.reasonCode],
    };
  }

  return { outcome: 'NEEDS_REVIEW', score, matchedRuleIds, reasonCodes };
}

/* -------------------------------------------------------------------------- */
/* Result selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The first variant whose outcome filter and condition match. Falls back to the
 * thank-you variant and finally to the first declared variant, so a visitor is
 * never left on a blank terminal state.
 */
export function selectResultVariant(
  spec: MultiStepFormSpec,
  answers: Answers,
  qualification: QualificationResult,
): ResultVariant | null {
  for (const variant of spec.resultVariants) {
    const outcomeMatches =
      variant.forOutcomes.length === 0 || variant.forOutcomes.includes(qualification.outcome);
    if (!outcomeMatches) continue;
    if (!matchesOptional(variant.showWhen, answers)) continue;
    return variant;
  }
  return (
    spec.resultVariants.find((variant) => variant.kind === 'THANK_YOU') ??
    spec.resultVariants[0] ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Answer validation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Validates one answer against its field definition. The public runtime calls
 * this on blur, and the submission handler calls the identical function before
 * accepting a lead — there is no second, laxer server implementation.
 */
export function validateAnswer(field: FormField, value: AnswerValue): ValidationErrorCode | null {
  if (field.type === 'CONSENT') {
    return value === true || value === 'true' ? null : 'CONSENT_REQUIRED';
  }

  if (isAnswerEmpty(value)) {
    return field.required ? 'REQUIRED' : null;
  }

  switch (field.type) {
    case 'SINGLE_SELECT': {
      if (Array.isArray(value) || typeof value === 'boolean') return 'INVALID_FORMAT';
      const selected = String(value);
      return field.options.some((option) => option.optionId === selected) ? null : 'UNKNOWN_OPTION';
    }
    case 'MULTI_SELECT': {
      const selected = Array.isArray(value) ? value.map(String) : [String(value)];
      const known = new Set(field.options.map((option) => option.optionId));
      if (selected.some((item) => !known.has(item))) return 'UNKNOWN_OPTION';
      if (selected.length < field.minSelected) return 'TOO_SHORT';
      if (selected.length > field.maxSelected) return 'TOO_LONG';
      return null;
    }
    case 'BOOLEAN': {
      if (typeof value === 'boolean') return null;
      return value === 'true' || value === 'false' ? null : 'INVALID_FORMAT';
    }
    case 'NUMBER':
    case 'RANGE': {
      const parsed = toNumber(Array.isArray(value) ? null : value);
      if (parsed === null) return 'INVALID_FORMAT';
      if (parsed < field.min || parsed > field.max) return 'OUT_OF_RANGE';
      return null;
    }
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
    case 'FIRST_NAME':
    case 'LAST_NAME': {
      if (Array.isArray(value) || typeof value !== 'string') return 'INVALID_FORMAT';
      if (value.trim().length < field.minLength) return 'TOO_SHORT';
      if (value.length > field.maxLength) return 'TOO_LONG';
      return null;
    }
    case 'POSTCODE': {
      if (Array.isArray(value)) return 'INVALID_FORMAT';
      return postcodeDeSchema.safeParse(String(value)).success ? null : 'INVALID_POSTCODE';
    }
    case 'EMAIL': {
      if (Array.isArray(value)) return 'INVALID_FORMAT';
      const candidate = normalizeEmail(String(value));
      if (candidate.length > field.maxLength) return 'TOO_LONG';
      return emailSchema.safeParse(candidate).success ? null : 'INVALID_EMAIL';
    }
    case 'PHONE': {
      if (Array.isArray(value)) return 'INVALID_FORMAT';
      return normalizePhoneE164(String(value)) === null ? 'INVALID_PHONE' : null;
    }
    default:
      return null;
  }
}

export interface FieldValidationError {
  fieldId: string;
  code: ValidationErrorCode;
  messageDe: string;
}

export interface StepValidationResult {
  ok: boolean;
  errors: FieldValidationError[];
}

function fieldError(fieldId: string, code: ValidationErrorCode): FieldValidationError {
  return { fieldId, code, messageDe: VALIDATION_MESSAGES_DE[code] };
}

/** Validates every currently visible field of one step. */
export function validateStep(
  spec: MultiStepFormSpec,
  stepId: string,
  answers: Answers,
): StepValidationResult {
  const step = getStep(spec, stepId);
  if (!step) return { ok: false, errors: [] };

  const errors: FieldValidationError[] = [];
  for (const field of visibleFields(spec, step, answers)) {
    const code = validateAnswer(field, answers[field.fieldId]);
    if (code) errors.push(fieldError(field.fieldId, code));
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validates the whole traversal a submission claims to have taken. The server
 * calls this before accepting a lead so a hand-crafted POST cannot skip a step.
 */
export function validateSubmission(
  spec: MultiStepFormSpec,
  answers: Answers,
): StepValidationResult {
  const errors: FieldValidationError[] = [];
  for (const step of visibleSteps(spec, answers)) {
    errors.push(...validateStep(spec, step.stepId, answers).errors);
  }
  if (!errors.some((error) => error.fieldId === spec.consent.fieldId)) {
    const consentValue = answers[spec.consent.fieldId];
    if (consentValue !== true && consentValue !== 'true') {
      errors.push(fieldError(spec.consent.fieldId, 'CONSENT_REQUIRED'));
    }
  }
  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Applies a single normalisation rule. Unnormalisable input is kept verbatim. */
export function normalizeValue(rule: NormalizationRule, value: AnswerValue): AnswerValue {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => String(normalizeValue(rule, item)));
  }
  if (typeof value === 'boolean') return value;

  const raw = String(value);
  switch (rule) {
    case 'NONE':
      return value;
    case 'TRIM':
      return raw.trim();
    case 'COLLAPSE_WHITESPACE':
      return raw.trim().replace(/\s+/g, ' ');
    case 'LOWERCASE':
      return raw.trim().toLowerCase();
    case 'EMAIL':
      return normalizeEmail(raw);
    case 'PHONE_E164':
      /* Keeping the raw value is deliberate: guessing a country code would
         corrupt identity resolution downstream (`@am/domain`). */
      return normalizePhoneE164(raw) ?? raw.trim();
    case 'POSTCODE_DE':
    case 'DIGITS_ONLY':
      return raw.replace(/\D/g, '');
    case 'INTEGER': {
      const parsed = toNumber(raw);
      return parsed === null ? raw.trim() : Math.trunc(parsed);
    }
    default:
      return value;
  }
}

/** Applies each field's normalisation rule. Unknown keys are passed through. */
export function normalizeAnswers(spec: MultiStepFormSpec, answers: Answers): Answers {
  const normalized: Answers = {};
  for (const [fieldId, value] of Object.entries(answers)) {
    const field = getField(spec, fieldId);
    normalized[fieldId] = field ? normalizeValue(field.normalization, value) : value;
  }
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* PII split                                                                   */
/* -------------------------------------------------------------------------- */

export interface SplitAnswers {
  /** Qualification answers — safe for reporting and rollups. */
  nonPii: Answers;
  /** Personal data — stored separately and subject to the retention policy. */
  pii: Answers;
  /** Operational values (honeypot, timings, hidden context). */
  operational: Answers;
}

/**
 * Splits answers by `piiClass` so callers can persist them to different tables.
 *
 * Two safety nets on top of the declared class: an inherently personal field
 * type (`EMAIL`, `PHONE`, `FIRST_NAME`, `LAST_NAME`) always lands in `pii` even
 * if a spec mislabels it, and an answer whose field is unknown to the spec is
 * treated as personal. Failing closed is the only acceptable direction here.
 */
export function splitAnswers(spec: MultiStepFormSpec, answers: Answers): SplitAnswers {
  const result: SplitAnswers = { nonPii: {}, pii: {}, operational: {} };

  for (const [fieldId, value] of Object.entries(answers)) {
    const field = getField(spec, fieldId);
    if (!field) {
      result.pii[fieldId] = value;
      continue;
    }
    if (isContactField(field)) {
      result.pii[fieldId] = value;
      continue;
    }
    const bucket: PiiClass = field.piiClass;
    if (bucket === 'PII') result.pii[fieldId] = value;
    else if (bucket === 'OPERATIONAL') result.operational[fieldId] = value;
    else result.nonPii[fieldId] = value;
  }

  return result;
}
