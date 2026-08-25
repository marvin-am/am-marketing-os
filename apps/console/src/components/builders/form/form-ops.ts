import type { ConditionOperator, FieldType } from '@am/domain';
import {
  allOf,
  atom,
  getField,
  getStep,
  internalLink,
  isConditionGroup,
  isSelectField,
  reachableSteps,
  routingRulesFor,
  stepOfField,
  DEFAULT_MAX_LENGTH,
  DEFAULT_NORMALIZATION,
  type ConditionAtom,
  type ConditionGroup,
  type ConditionNode,
  type ConditionValue,
  type FieldOption,
  type FormField,
  type FormStep,
  type MultiStepFormSpec,
  type QualificationRule,
  type ResultVariant,
  type RoutingRule,
  type StepTarget,
} from '@am/funnel-schema';
import { deriveKey, deriveUniqueKey, uniqueKey } from '../keys';
import { moveItem } from '../move';

/**
 * Every edit the form builder can perform, as pure functions over a
 * `MultiStepFormSpec`.
 *
 * Keeping mutation out of the components buys three things: the operations are
 * unit-testable without a DOM, the editor can hold a single immutable spec in
 * state, and — the point of the exercise — an operator never sees the JSON these
 * functions produce.
 *
 * The functions are deliberately *not* validators. They keep the document
 * structurally sound (ids stay unique, records stay in sync with their keys) and
 * leave every judgement about publishability to `validateFormSpec`, so there is
 * exactly one place that decides what "valid" means.
 */

export const LIMITS = {
  steps: 20,
  fieldsPerStep: 12,
  optionsPerField: 12,
  minOptionsPerField: 2,
  routingRules: 60,
  qualificationRules: 60,
  resultVariants: 10,
} as const;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

export function stepIds(spec: MultiStepFormSpec): string[] {
  return spec.steps.map((step) => step.stepId);
}

export function fieldIds(spec: MultiStepFormSpec): string[] {
  return Object.keys(spec.fields);
}

export function ruleIds(spec: MultiStepFormSpec): string[] {
  return [
    ...spec.routingRules.map((rule) => rule.ruleId),
    ...spec.qualificationRules.map((rule) => rule.ruleId),
  ];
}

export function variantIds(spec: MultiStepFormSpec): string[] {
  return spec.resultVariants.map((variant) => variant.variantId);
}

function withSteps(spec: MultiStepFormSpec, steps: FormStep[]): MultiStepFormSpec {
  return { ...spec, steps };
}

export function updateStep(
  spec: MultiStepFormSpec,
  stepId: string,
  updater: (step: FormStep) => FormStep,
): MultiStepFormSpec {
  return withSteps(
    spec,
    spec.steps.map((step) => (step.stepId === stepId ? updater(step) : step)),
  );
}

export function updateField(
  spec: MultiStepFormSpec,
  fieldId: string,
  updater: (field: FormField) => FormField,
): MultiStepFormSpec {
  const field = spec.fields[fieldId];
  if (!field) return spec;
  return { ...spec, fields: { ...spec.fields, [fieldId]: updater(field) } };
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Inserts a new step **into the chain** after `afterStepId`: the predecessor now
 * leads to the new step and the new step continues where the predecessor used
 * to. Appending an orphan step would produce an immediately unreachable step —
 * a validation error the operator did not ask for.
 */
export function addStep(
  spec: MultiStepFormSpec,
  afterStepId: string | null,
): { spec: MultiStepFormSpec; stepId: string } {
  const index = afterStepId ? spec.steps.findIndex((step) => step.stepId === afterStepId) : -1;
  const predecessor = index >= 0 ? spec.steps[index] : null;
  const position = index >= 0 ? index + 1 : spec.steps.length;

  const title = 'Neue Frage';
  const stepId = uniqueKey(deriveKey(`schritt_${spec.steps.length + 1}`, 'schritt'), stepIds(spec));

  const continuation: StepTarget = predecessor
    ? predecessor.defaultNext
    : (spec.steps[0]
        ? { kind: 'STEP', stepId: spec.steps[0].stepId }
        : { kind: 'SUBMIT' });

  const step: FormStep = {
    stepId,
    kind: 'QUESTION',
    title,
    subtitle: null,
    fieldIds: [],
    primaryCtaLabel: 'Weiter',
    secondaryCtaLabel: position === 0 ? null : 'Zurück',
    showProgress: true,
    defaultNext: continuation,
  };

  const steps = [...spec.steps];
  steps.splice(position, 0, step);

  const rewired = predecessor
    ? steps.map((entry) =>
        entry.stepId === predecessor.stepId
          ? { ...entry, defaultNext: { kind: 'STEP', stepId } as StepTarget }
          : entry,
      )
    : steps;

  return { spec: withSteps(spec, rewired), stepId };
}

export interface StepDeletionImpact {
  /** Fields that exist only on this step and are removed with it. */
  removedFieldIds: string[];
  /** Rules that belong to this step and are removed with it. */
  removedRuleIds: string[];
  /** Transitions elsewhere that will point at a step that no longer exists. */
  danglingFromStepIds: string[];
}

/** What deleting a step will do — rendered in the confirmation before it happens. */
export function stepDeletionImpact(spec: MultiStepFormSpec, stepId: string): StepDeletionImpact {
  const step = getStep(spec, stepId);
  if (!step) {
    return { removedFieldIds: [], removedRuleIds: [], danglingFromStepIds: [] };
  }

  const elsewhere = new Set(
    spec.steps.filter((entry) => entry.stepId !== stepId).flatMap((entry) => entry.fieldIds),
  );

  const dangling = spec.steps
    .filter((entry) => entry.stepId !== stepId)
    .filter((entry) =>
      [...routingRulesFor(spec, entry.stepId).map((rule) => rule.target), entry.defaultNext].some(
        (target) => target.kind === 'STEP' && target.stepId === stepId,
      ),
    )
    .map((entry) => entry.stepId);

  return {
    removedFieldIds: step.fieldIds.filter((fieldId) => !elsewhere.has(fieldId)),
    removedRuleIds: routingRulesFor(spec, stepId).map((rule) => rule.ruleId),
    danglingFromStepIds: dangling,
  };
}

/**
 * Removes the step, the fields only it carried and the rules that started on it.
 *
 * Transitions *into* the step are left untouched on purpose: silently rewiring
 * another step's branch would change the funnel behind the operator's back. The
 * validator reports them as `UNKNOWN_STEP_TARGET` and the builder shows the
 * error next to the step that now points nowhere.
 */
export function deleteStep(spec: MultiStepFormSpec, stepId: string): MultiStepFormSpec {
  const impact = stepDeletionImpact(spec, stepId);
  const fields = { ...spec.fields };
  for (const fieldId of impact.removedFieldIds) delete fields[fieldId];

  return {
    ...spec,
    steps: spec.steps.filter((step) => step.stepId !== stepId),
    fields,
    routingRules: spec.routingRules.filter((rule) => rule.fromStepId !== stepId),
  };
}

export function duplicateStep(
  spec: MultiStepFormSpec,
  stepId: string,
): { spec: MultiStepFormSpec; stepId: string } {
  const index = spec.steps.findIndex((step) => step.stepId === stepId);
  const original = spec.steps[index];
  if (!original) return { spec, stepId };

  const takenSteps = new Set(stepIds(spec));
  const newStepId = uniqueKey(`${original.stepId}_kopie`, takenSteps);

  const takenFields = new Set(fieldIds(spec));
  const fields = { ...spec.fields };
  const copiedFieldIds: string[] = [];

  for (const fieldId of original.fieldIds) {
    const field = spec.fields[fieldId];
    if (!field) continue;
    /* A consent field exists exactly once per form — a copy would collide with
       `spec.consent.fieldId`, so the duplicate simply omits it. */
    if (field.type === 'CONSENT') continue;
    const copyId = uniqueKey(`${fieldId}_kopie`, takenFields);
    takenFields.add(copyId);
    fields[copyId] = { ...field, fieldId: copyId };
    copiedFieldIds.push(copyId);
  }

  const copy: FormStep = {
    ...original,
    stepId: newStepId,
    title: `${original.title} (Kopie)`,
    fieldIds: copiedFieldIds,
  };

  const steps = [...spec.steps];
  steps.splice(index + 1, 0, copy);

  const takenRules = new Set(ruleIds(spec));
  const copiedRules: RoutingRule[] = routingRulesFor(spec, stepId).map((rule) => {
    const ruleId = uniqueKey(`${rule.ruleId}_kopie`, takenRules);
    takenRules.add(ruleId);
    return { ...rule, ruleId, fromStepId: newStepId };
  });

  return {
    spec: { ...spec, steps, fields, routingRules: [...spec.routingRules, ...copiedRules] },
    stepId: newStepId,
  };
}

export function moveStep(spec: MultiStepFormSpec, from: number, to: number): MultiStepFormSpec {
  return withSteps(spec, moveItem(spec.steps, from, to));
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

const INHERENTLY_PII: readonly FieldType[] = ['EMAIL', 'PHONE', 'FIRST_NAME', 'LAST_NAME'];

const DEFAULT_FIELD_LABELS_DE: Readonly<Record<FieldType, string>> = {
  SINGLE_SELECT: 'Neue Auswahlfrage',
  MULTI_SELECT: 'Neue Mehrfachauswahl',
  BOOLEAN: 'Neue Ja-Nein-Frage',
  NUMBER: 'Neue Zahlenfrage',
  RANGE: 'Neue Schiebereglerfrage',
  SHORT_TEXT: 'Neue Textfrage',
  LONG_TEXT: 'Neue ausführliche Frage',
  POSTCODE: 'Postleitzahl',
  EMAIL: 'E-Mail-Adresse',
  PHONE: 'Telefonnummer',
  FIRST_NAME: 'Vorname',
  LAST_NAME: 'Nachname',
  CONSENT: 'Einwilligung zur Datenverarbeitung',
};

function defaultOptions(): FieldOption[] {
  return [
    { optionId: 'erste_antwort', label: 'Erste Antwort', helpText: null, score: 0 },
    { optionId: 'zweite_antwort', label: 'Zweite Antwort', helpText: null, score: 0 },
  ];
}

/** Builds a fully materialised field of `type`; no zod defaults exist to lean on. */
export function createField(
  type: FieldType,
  fieldId: string,
  label: string,
  consentVersionId: string,
): FormField {
  const base = {
    fieldId,
    label,
    helpText: null,
    placeholder: null,
    required: true,
    piiClass: INHERENTLY_PII.includes(type) ? ('PII' as const) : ('QUALIFICATION' as const),
    qualificationClass:
      type === 'SINGLE_SELECT' || type === 'MULTI_SELECT'
        ? ('SCORING' as const)
        : ('NONE' as const),
    normalization: DEFAULT_NORMALIZATION[type],
    maxLength: DEFAULT_MAX_LENGTH[type],
    hubspotProperty: null,
    visibleWhen: null,
  };

  switch (type) {
    case 'SINGLE_SELECT':
      return { ...base, type: 'SINGLE_SELECT', options: defaultOptions(), display: 'CARDS' };
    case 'MULTI_SELECT':
      return {
        ...base,
        type: 'MULTI_SELECT',
        options: defaultOptions(),
        minSelected: 1,
        maxSelected: 2,
      };
    case 'BOOLEAN':
      return { ...base, type: 'BOOLEAN', trueLabel: 'Ja', falseLabel: 'Nein' };
    case 'NUMBER':
      return { ...base, type: 'NUMBER', min: 0, max: 1000, step: 1, unit: null };
    case 'RANGE':
      return {
        ...base,
        type: 'RANGE',
        min: 0,
        max: 100,
        step: 1,
        unit: null,
        minLabel: null,
        maxLabel: null,
      };
    case 'SHORT_TEXT':
      return { ...base, type: 'SHORT_TEXT', minLength: 2 };
    case 'LONG_TEXT':
      return { ...base, type: 'LONG_TEXT', minLength: 10, rows: 4 };
    case 'POSTCODE':
      return {
        ...base,
        type: 'POSTCODE',
        country: 'DE',
        maxLength: 5,
        normalization: 'POSTCODE_DE',
        qualificationClass: 'ROUTING_ONLY',
      };
    case 'EMAIL':
      return { ...base, type: 'EMAIL' };
    case 'PHONE':
      return { ...base, type: 'PHONE', defaultCountry: '+49' };
    case 'FIRST_NAME':
      return { ...base, type: 'FIRST_NAME', minLength: 2 };
    case 'LAST_NAME':
      return { ...base, type: 'LAST_NAME', minLength: 2 };
    case 'CONSENT':
      return { ...base, type: 'CONSENT', consentVersionId, piiClass: 'OPERATIONAL' };
    default:
      return { ...base, type: 'SHORT_TEXT', minLength: 0 };
  }
}

export function addFieldToStep(
  spec: MultiStepFormSpec,
  stepId: string,
  type: FieldType,
): { spec: MultiStepFormSpec; fieldId: string } {
  const step = getStep(spec, stepId);
  if (!step || step.fieldIds.length >= LIMITS.fieldsPerStep) return { spec, fieldId: '' };

  const label = DEFAULT_FIELD_LABELS_DE[type];
  const fieldId = deriveUniqueKey(label, fieldIds(spec), 'feld');
  const field = createField(type, fieldId, label, spec.consent.consentVersionId);

  return {
    spec: {
      ...updateStepFields(spec, stepId, [...step.fieldIds, fieldId]),
      fields: { ...spec.fields, [fieldId]: field },
    },
    fieldId,
  };
}

function updateStepFields(
  spec: MultiStepFormSpec,
  stepId: string,
  nextFieldIds: string[],
): MultiStepFormSpec {
  return updateStep(spec, stepId, (step) => ({ ...step, fieldIds: nextFieldIds }));
}

/**
 * Removes a field from the document. References to it inside rules stay put and
 * become visible errors — the same reasoning as `deleteStep`.
 */
export function deleteField(spec: MultiStepFormSpec, fieldId: string): MultiStepFormSpec {
  const fields = { ...spec.fields };
  delete fields[fieldId];
  return {
    ...spec,
    fields,
    steps: spec.steps.map((step) => ({
      ...step,
      fieldIds: step.fieldIds.filter((entry) => entry !== fieldId),
    })),
  };
}

/** Rules that would lose their subject if `fieldId` were deleted. */
export function rulesReferencingField(spec: MultiStepFormSpec, fieldId: string): string[] {
  const mentions = (node: ConditionNode): boolean => {
    if (isConditionGroup(node)) {
      const children = 'all' in node ? node.all : node.any;
      return children.some(mentions);
    }
    return node.fieldId === fieldId;
  };

  return [
    ...spec.routingRules.filter((rule) => mentions(rule.when)).map((rule) => rule.ruleId),
    ...spec.qualificationRules
      .filter((rule) => rule.when !== null && mentions(rule.when))
      .map((rule) => rule.ruleId),
  ];
}

export function moveFieldInStep(
  spec: MultiStepFormSpec,
  stepId: string,
  from: number,
  to: number,
): MultiStepFormSpec {
  const step = getStep(spec, stepId);
  if (!step) return spec;
  return updateStepFields(spec, stepId, moveItem(step.fieldIds, from, to));
}

/** Rebuilds a field as `type`, keeping label, help text and placement. */
export function changeFieldType(
  spec: MultiStepFormSpec,
  fieldId: string,
  type: FieldType,
): MultiStepFormSpec {
  const current = spec.fields[fieldId];
  if (!current || current.type === type) return spec;

  const rebuilt = createField(type, fieldId, current.label, spec.consent.consentVersionId);
  const carried: FormField = {
    ...rebuilt,
    helpText: current.helpText,
    placeholder: current.placeholder,
    required: current.required,
    visibleWhen: current.visibleWhen,
    hubspotProperty: current.hubspotProperty,
  };

  /* Answer options survive a switch between the two select types; everything
     else would be a silent data loss the operator did not ask for. */
  if (isSelectField(carried) && isSelectField(current)) {
    return updateField(spec, fieldId, () => ({
      ...carried,
      options: current.options,
      ...(carried.type === 'MULTI_SELECT'
        ? { minSelected: 1, maxSelected: Math.max(1, current.options.length) }
        : {}),
    }));
  }

  return updateField(spec, fieldId, () => carried);
}

/* -------------------------------------------------------------------------- */
/* Answer options                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Adds an option whose id is derived from its label **once**. From here on the
 * id is frozen: `updateOptionLabel` deliberately cannot change it.
 */
export function addOption(
  spec: MultiStepFormSpec,
  fieldId: string,
  label = 'Neue Antwort',
): { spec: MultiStepFormSpec; optionId: string } {
  const field = spec.fields[fieldId];
  if (!field || !isSelectField(field) || field.options.length >= LIMITS.optionsPerField) {
    return { spec, optionId: '' };
  }

  const optionId = deriveUniqueKey(
    label,
    field.options.map((option) => option.optionId),
    'antwort',
  );

  return {
    spec: updateField(spec, fieldId, (entry) =>
      isSelectField(entry)
        ? { ...entry, options: [...entry.options, { optionId, label, helpText: null, score: 0 }] }
        : entry,
    ),
    optionId,
  };
}

export interface OptionPatch {
  label?: string;
  helpText?: string | null;
  score?: number;
}

/** Updates the *visible* parts of an option. The id is never part of the patch. */
export function updateOption(
  spec: MultiStepFormSpec,
  fieldId: string,
  optionId: string,
  patch: OptionPatch,
): MultiStepFormSpec {
  return updateField(spec, fieldId, (field) =>
    isSelectField(field)
      ? {
          ...field,
          options: field.options.map((option) =>
            option.optionId === optionId ? { ...option, ...patch, optionId } : option,
          ),
        }
      : field,
  );
}

export function deleteOption(
  spec: MultiStepFormSpec,
  fieldId: string,
  optionId: string,
): MultiStepFormSpec {
  return updateField(spec, fieldId, (field) =>
    isSelectField(field)
      ? { ...field, options: field.options.filter((option) => option.optionId !== optionId) }
      : field,
  );
}

export function moveOption(
  spec: MultiStepFormSpec,
  fieldId: string,
  from: number,
  to: number,
): MultiStepFormSpec {
  return updateField(spec, fieldId, (field) =>
    isSelectField(field) ? { ...field, options: moveItem(field.options, from, to) } : field,
  );
}

/** Every rule that names this option id, so deleting it is never silent. */
export function rulesReferencingOption(spec: MultiStepFormSpec, optionId: string): string[] {
  const mentions = (node: ConditionNode): boolean => {
    if (isConditionGroup(node)) {
      const children = 'all' in node ? node.all : node.any;
      return children.some(mentions);
    }
    const value = node.value;
    return Array.isArray(value) ? value.includes(optionId) : String(value) === optionId;
  };

  return [
    ...spec.routingRules.filter((rule) => mentions(rule.when)).map((rule) => rule.ruleId),
    ...spec.qualificationRules
      .filter((rule) => rule.when !== null && mentions(rule.when))
      .map((rule) => rule.ruleId),
  ];
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

const SELECT_OPERATORS: readonly ConditionOperator[] = [
  'EQUALS',
  'NOT_EQUALS',
  'IN',
  'NOT_IN',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
];
const NUMERIC_FIELD_OPERATORS: readonly ConditionOperator[] = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'LESS_THAN',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
];
const SCALAR_OPERATORS: readonly ConditionOperator[] = [
  'EQUALS',
  'NOT_EQUALS',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
];

/**
 * The operators that make sense for a field type. Offering `GREATER_THAN` on a
 * dropdown would only produce a validator warning later, so the builder never
 * offers it in the first place.
 */
export function allowedOperators(field: FormField | null): readonly ConditionOperator[] {
  if (!field) return SCALAR_OPERATORS;
  if (field.type === 'SINGLE_SELECT' || field.type === 'MULTI_SELECT') return SELECT_OPERATORS;
  if (field.type === 'NUMBER' || field.type === 'RANGE') return NUMERIC_FIELD_OPERATORS;
  return SCALAR_OPERATORS;
}

/** A value that matches the operator's arity and the field's type. */
export function defaultConditionValue(
  field: FormField | null,
  operator: ConditionOperator,
): ConditionValue {
  if (operator === 'IS_EMPTY' || operator === 'IS_NOT_EMPTY') return null;
  if (operator === 'IN' || operator === 'NOT_IN') {
    return field && isSelectField(field) && field.options[0]
      ? [field.options[0].optionId]
      : [];
  }
  if (!field) return '';
  if (isSelectField(field)) return field.options[0]?.optionId ?? '';
  if (field.type === 'NUMBER' || field.type === 'RANGE') return field.min;
  if (field.type === 'BOOLEAN' || field.type === 'CONSENT') return true;
  return '';
}

/**
 * Fields a rule on `fromStepId` may branch on: those asked on this very step, or
 * on a step from which this step is reachable. Anything else would branch on an
 * answer the visitor has not given yet.
 */
export function conditionFieldsAvailable(
  spec: MultiStepFormSpec,
  fromStepId: string | null,
): FormField[] {
  const all = Object.values(spec.fields);
  if (!fromStepId) return all;

  return all.filter((field) => {
    const placement = stepOfField(spec, field.fieldId);
    if (!placement) return false;
    if (placement.stepId === fromStepId) return true;
    return reachableSteps(spec, placement.stepId).has(fromStepId);
  });
}

export function defaultAtom(spec: MultiStepFormSpec, fromStepId: string | null): ConditionAtom {
  const candidates = conditionFieldsAvailable(spec, fromStepId);
  const field = candidates[0] ?? Object.values(spec.fields)[0] ?? null;
  const operator = allowedOperators(field)[0] ?? 'EQUALS';
  return atom(field?.fieldId ?? '', operator, defaultConditionValue(field, operator));
}

/** Replaces the node at `path` (indexes from the root group) inside a tree. */
export function setConditionNode(
  group: ConditionGroup,
  path: readonly number[],
  next: ConditionNode | null,
): ConditionGroup {
  const key = 'all' in group ? 'all' : 'any';
  const children = 'all' in group ? group.all : group.any;
  const [head, ...rest] = path;

  if (head === undefined) return group;

  const updated: ConditionNode[] = [];
  children.forEach((child, index) => {
    if (index !== head) {
      updated.push(child);
      return;
    }
    if (rest.length === 0) {
      if (next !== null) updated.push(next);
      return;
    }
    if (isConditionGroup(child)) updated.push(setConditionNode(child, rest, next));
    else updated.push(child);
  });

  return { [key]: updated } as ConditionGroup;
}

export function appendConditionNode(
  group: ConditionGroup,
  path: readonly number[],
  node: ConditionNode,
): ConditionGroup {
  const key = 'all' in group ? 'all' : 'any';
  const children = 'all' in group ? group.all : group.any;

  if (path.length === 0) {
    return { [key]: [...children, node] } as ConditionGroup;
  }

  const [head, ...rest] = path;
  const updated = children.map((child, index) =>
    index === head && isConditionGroup(child) ? appendConditionNode(child, rest, node) : child,
  );
  return { [key]: updated } as ConditionGroup;
}

/** Flips a group between "alle Bedingungen" (AND) and "mindestens eine" (OR). */
export function setGroupMode(group: ConditionGroup, mode: 'all' | 'any'): ConditionGroup {
  const children = 'all' in group ? group.all : group.any;
  return (mode === 'all' ? { all: children } : { any: children }) as ConditionGroup;
}

export function groupChildren(group: ConditionGroup): ConditionNode[] {
  return 'all' in group ? group.all : group.any;
}

export function groupMode(group: ConditionGroup): 'all' | 'any' {
  return 'all' in group ? 'all' : 'any';
}

/* -------------------------------------------------------------------------- */
/* Routing rules                                                               */
/* -------------------------------------------------------------------------- */

export function addRoutingRule(
  spec: MultiStepFormSpec,
  fromStepId: string,
): { spec: MultiStepFormSpec; ruleId: string } {
  const step = getStep(spec, fromStepId);
  if (!step || spec.routingRules.length >= LIMITS.routingRules) return { spec, ruleId: '' };

  const ruleId = uniqueKey(`regel_${fromStepId}`, ruleIds(spec));
  const rule: RoutingRule = {
    ruleId,
    fromStepId,
    when: allOf(defaultAtom(spec, fromStepId)),
    /* Starts as a no-op copy of the fallthrough: a freshly added rule must not
       change where anybody lands until it has been configured. */
    target: step.defaultNext,
    description: `Verzweigung ab Schritt „${step.title}“.`,
  };

  return { spec: { ...spec, routingRules: [...spec.routingRules, rule] }, ruleId };
}

export function updateRoutingRule(
  spec: MultiStepFormSpec,
  ruleId: string,
  updater: (rule: RoutingRule) => RoutingRule,
): MultiStepFormSpec {
  return {
    ...spec,
    routingRules: spec.routingRules.map((rule) => (rule.ruleId === ruleId ? updater(rule) : rule)),
  };
}

export function deleteRoutingRule(spec: MultiStepFormSpec, ruleId: string): MultiStepFormSpec {
  return { ...spec, routingRules: spec.routingRules.filter((rule) => rule.ruleId !== ruleId) };
}

/** Rules are evaluated in document order, so their order is a real setting. */
export function moveRoutingRule(
  spec: MultiStepFormSpec,
  fromStepId: string,
  from: number,
  to: number,
): MultiStepFormSpec {
  const own = routingRulesFor(spec, fromStepId);
  const reordered = moveItem(own, from, to);
  let cursor = 0;
  return {
    ...spec,
    routingRules: spec.routingRules.map((rule) =>
      rule.fromStepId === fromStepId ? (reordered[cursor++] as RoutingRule) : rule,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Qualification rules                                                         */
/* -------------------------------------------------------------------------- */

export function createQualificationRule(
  spec: MultiStepFormSpec,
  effect: QualificationRule['effect'],
  ruleId: string,
): QualificationRule {
  const when = allOf(defaultAtom(spec, null));
  switch (effect) {
    case 'SCORE':
      return {
        effect: 'SCORE',
        ruleId,
        when,
        points: 1,
        reasonCode: 'PUNKTE',
        description: 'Vergibt zusätzliche Punkte, wenn die Bedingung zutrifft.',
      };
    case 'DISQUALIFY':
      return {
        effect: 'DISQUALIFY',
        ruleId,
        when,
        reasonCode: 'NICHT_PASSEND',
        description: 'Beendet die Anfrage als nicht passend.',
      };
    case 'QUALIFY':
      return {
        effect: 'QUALIFY',
        ruleId,
        when,
        reasonCode: 'PASSEND',
        description: 'Stuft die Anfrage unabhängig von der Punktzahl als qualifiziert ein.',
      };
    case 'CLASSIFY':
    default:
      return {
        effect: 'CLASSIFY',
        ruleId,
        when: null,
        minScore: 0,
        outcome: 'NEEDS_REVIEW',
        reasonCode: 'EINSTUFUNG',
        description: 'Ordnet die erreichte Punktzahl einem Ergebnis zu.',
      };
  }
}

export function addQualificationRule(
  spec: MultiStepFormSpec,
  effect: QualificationRule['effect'],
): { spec: MultiStepFormSpec; ruleId: string } {
  if (spec.qualificationRules.length >= LIMITS.qualificationRules) return { spec, ruleId: '' };
  const ruleId = uniqueKey(`qual_${effect.toLowerCase()}`, ruleIds(spec));
  return {
    spec: {
      ...spec,
      qualificationRules: [
        ...spec.qualificationRules,
        createQualificationRule(spec, effect, ruleId),
      ],
    },
    ruleId,
  };
}

export function updateQualificationRule(
  spec: MultiStepFormSpec,
  ruleId: string,
  updater: (rule: QualificationRule) => QualificationRule,
): MultiStepFormSpec {
  return {
    ...spec,
    qualificationRules: spec.qualificationRules.map((rule) =>
      rule.ruleId === ruleId ? updater(rule) : rule,
    ),
  };
}

export function changeQualificationEffect(
  spec: MultiStepFormSpec,
  ruleId: string,
  effect: QualificationRule['effect'],
): MultiStepFormSpec {
  return updateQualificationRule(spec, ruleId, (rule) => {
    if (rule.effect === effect) return rule;
    const rebuilt = createQualificationRule(spec, effect, ruleId);
    const carriedWhen = rule.when ?? allOf(defaultAtom(spec, null));
    return rebuilt.effect === 'CLASSIFY'
      ? { ...rebuilt, description: rule.description, reasonCode: rule.reasonCode }
      : {
          ...rebuilt,
          when: carriedWhen,
          description: rule.description,
          reasonCode: rule.reasonCode,
        };
  });
}

export function deleteQualificationRule(
  spec: MultiStepFormSpec,
  ruleId: string,
): MultiStepFormSpec {
  return {
    ...spec,
    qualificationRules: spec.qualificationRules.filter((rule) => rule.ruleId !== ruleId),
  };
}

export function moveQualificationRule(
  spec: MultiStepFormSpec,
  from: number,
  to: number,
): MultiStepFormSpec {
  return { ...spec, qualificationRules: moveItem(spec.qualificationRules, from, to) };
}

/* -------------------------------------------------------------------------- */
/* Result variants                                                             */
/* -------------------------------------------------------------------------- */

export function createResultVariant(kind: ResultVariant['kind'], variantId: string): ResultVariant {
  const base = {
    variantId,
    forOutcomes: [] as ResultVariant['forOutcomes'],
    showWhen: null,
    headline: 'Vielen Dank für Ihre Angaben',
    body: 'Wir melden uns innerhalb eines Werktages bei Ihnen.',
  };

  switch (kind) {
    case 'LEAD_MAGNET':
      return {
        ...base,
        kind: 'LEAD_MAGNET',
        headline: 'Ihr Download ist bereit',
        assetPath: null,
        assetLabel: 'Unterlagen',
        deliveryNote: 'Sie erhalten die Unterlagen zusätzlich per E-Mail.',
      };
    case 'ANALYSIS':
      return {
        ...base,
        kind: 'ANALYSIS',
        headline: 'Ihre Auswertung',
        sections: [
          {
            key: 'einordnung',
            title: 'Ihre Einordnung',
            body: 'Wir vergleichen Ihre Angaben mit vergleichbaren Unternehmen.',
            showWhen: null,
          },
        ],
        cta: null,
        methodNote:
          'Alle Aussagen beruhen auf Ihren Angaben und ausgewerteten Kampagnendaten — es handelt sich nicht um eine Garantie.',
      };
    case 'QUALIFIED':
      return {
        ...base,
        kind: 'QUALIFIED',
        headline: 'Das passt zusammen',
        forOutcomes: ['QUALIFIED'],
        bullets: [],
        cta: null,
        booking: null,
      };
    case 'NOT_A_FIT':
      return {
        ...base,
        kind: 'NOT_A_FIT',
        headline: 'Wir sind aktuell nicht die richtige Wahl',
        body: 'Auf Basis Ihrer Antworten könnten wir Ihnen heute kein sinnvolles Ergebnis liefern.',
        forOutcomes: ['NOT_A_FIT'],
        alternativeNote:
          'Melden Sie sich gerne erneut, sobald sich Budget, Zeitplan oder Zielsetzung geändert haben.',
        cta: null,
      };
    case 'BOOKING':
      return {
        ...base,
        kind: 'BOOKING',
        headline: 'Wählen Sie Ihren Wunschtermin',
        booking: {
          mode: 'LINK',
          target: null,
          label: 'Termin auswählen',
          helpText: 'Terminbuchung noch nicht verbunden.',
        },
        bullets: [],
      };
    case 'REDIRECT':
      return {
        ...base,
        kind: 'REDIRECT',
        headline: 'Sie werden weitergeleitet',
        target: internalLink('/danke'),
        delaySeconds: 3,
      };
    case 'THANK_YOU':
    default:
      return { ...base, kind: 'THANK_YOU', bullets: [], cta: null };
  }
}

export function addResultVariant(
  spec: MultiStepFormSpec,
  kind: ResultVariant['kind'],
): { spec: MultiStepFormSpec; variantId: string } {
  if (spec.resultVariants.length >= LIMITS.resultVariants) return { spec, variantId: '' };
  const variantId = uniqueKey(deriveKey(kind.toLowerCase(), 'ergebnis'), variantIds(spec));
  return {
    spec: {
      ...spec,
      resultVariants: [...spec.resultVariants, createResultVariant(kind, variantId)],
    },
    variantId,
  };
}

export function updateResultVariant(
  spec: MultiStepFormSpec,
  variantId: string,
  updater: (variant: ResultVariant) => ResultVariant,
): MultiStepFormSpec {
  return {
    ...spec,
    resultVariants: spec.resultVariants.map((variant) =>
      variant.variantId === variantId ? updater(variant) : variant,
    ),
  };
}

export function changeResultVariantKind(
  spec: MultiStepFormSpec,
  variantId: string,
  kind: ResultVariant['kind'],
): MultiStepFormSpec {
  return updateResultVariant(spec, variantId, (variant) => {
    if (variant.kind === kind) return variant;
    const rebuilt = createResultVariant(kind, variantId);
    return {
      ...rebuilt,
      headline: variant.headline,
      body: variant.body,
      forOutcomes: variant.forOutcomes,
      showWhen: variant.showWhen,
    };
  });
}

export function deleteResultVariant(
  spec: MultiStepFormSpec,
  variantId: string,
): MultiStepFormSpec {
  return {
    ...spec,
    resultVariants: spec.resultVariants.filter((variant) => variant.variantId !== variantId),
  };
}

export function moveResultVariant(
  spec: MultiStepFormSpec,
  from: number,
  to: number,
): MultiStepFormSpec {
  return { ...spec, resultVariants: moveItem(spec.resultVariants, from, to) };
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/** A target of `kind`, pre-filled with the first sensible destination. */
export function createTarget(spec: MultiStepFormSpec, kind: StepTarget['kind']): StepTarget {
  switch (kind) {
    case 'STEP':
      return { kind: 'STEP', stepId: spec.steps[0]?.stepId ?? '' };
    case 'RESULT':
      return { kind: 'RESULT', variantId: spec.resultVariants[0]?.variantId ?? '' };
    case 'DISQUALIFY':
      return {
        kind: 'DISQUALIFY',
        variantId:
          spec.resultVariants.find((variant) => variant.kind === 'NOT_A_FIT')?.variantId ??
          spec.resultVariants[0]?.variantId ??
          '',
        reasonCode: 'NICHT_PASSEND',
      };
    case 'SUBMIT':
    default:
      return { kind: 'SUBMIT' };
  }
}

/** German one-line description of where a transition leads. */
export function describeTarget(spec: MultiStepFormSpec, target: StepTarget): string {
  switch (target.kind) {
    case 'STEP': {
      const step = getStep(spec, target.stepId);
      return step ? `weiter zu „${step.title}“` : `weiter zu unbekanntem Schritt (${target.stepId})`;
    }
    case 'SUBMIT':
      return 'Formular absenden';
    case 'RESULT': {
      const variant = spec.resultVariants.find((entry) => entry.variantId === target.variantId);
      return variant
        ? `Ergebnis „${variant.headline}“`
        : `unbekannte Ergebnisvariante (${target.variantId})`;
    }
    case 'DISQUALIFY':
      return `als nicht passend beenden (${target.reasonCode})`;
    default:
      return 'unbekannter Übergang';
  }
}

/** German label for a field in dropdowns: the visible label plus its key. */
export function fieldLabel(spec: MultiStepFormSpec, fieldId: string): string {
  const field = getField(spec, fieldId);
  return field ? `${field.label} (${fieldId})` : `Unbekanntes Feld (${fieldId})`;
}
