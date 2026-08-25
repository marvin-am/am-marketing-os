import { z } from 'zod';
import { INHERENTLY_PII_FIELD_TYPES } from '@am/domain';
import { findMarkupViolations, isAnchorHref, isRelativeHref, type LinkTarget } from './common';
import {
  conditionFieldIds,
  entryStepId,
  getField,
  getStep,
  isConditionGroup,
  isContactField,
  isSelectField,
  multiStepFormSpecSchema,
  outgoingTargets,
  routingRulesFor,
  stepOfField,
  LIST_OPERATORS,
  NUMERIC_OPERATORS,
  UNARY_OPERATORS,
  type ConditionGroup,
  type ConditionNode,
  type FormField,
  type FormStep,
  type MultiStepFormSpec,
  type QualificationOutcome,
} from './form-spec';
import {
  hybridFunnelSpecSchema,
  landingPageSpecSchema,
  type HybridFunnelSpec,
  type LandingPageSpec,
  type PageBlock,
} from './page-spec';

/**
 * Publish-time validation.
 *
 * A spec that produces zero `ERROR` issues is safe to freeze into a published
 * version: its step graph is acyclic, every step is reachable, every path ends
 * in a submit, a result variant or a defined disqualification, no rule points at
 * something that does not exist, contact data is asked last, and consent is
 * present and unticked.
 *
 * Every issue carries a German `messageDe` and a German `pathDe` so the builder
 * can render it inline next to the offending element without a translation layer.
 */

/* -------------------------------------------------------------------------- */
/* Issue model                                                                 */
/* -------------------------------------------------------------------------- */

export const VALIDATION_ISSUE_CODES = [
  'SCHEMA_INVALID',
  'MARKUP_NOT_ALLOWED',
  /* graph */
  'NO_STEPS',
  'DUPLICATE_STEP_ID',
  'STEP_GRAPH_CYCLE',
  'STEP_UNREACHABLE',
  'STEP_NOT_TERMINATING',
  'UNKNOWN_STEP_TARGET',
  'UNKNOWN_RESULT_VARIANT',
  'DUPLICATE_RESULT_VARIANT_ID',
  /* fields */
  'FIELD_ID_MISMATCH',
  'EMPTY_LABEL',
  'UNKNOWN_FIELD_REFERENCE',
  'FIELD_NOT_PLACED',
  'FIELD_PLACED_TWICE',
  'DUPLICATE_OPTION_ID',
  'POSTCODE_NOT_DE5',
  'PII_CLASS_MISMATCH',
  'PII_NOT_LAST_STEP',
  /* rules */
  'DUPLICATE_RULE_ID',
  'RULE_FROM_UNKNOWN_STEP',
  'UNKNOWN_FIELD_IN_RULE',
  'UNKNOWN_OPTION_IN_RULE',
  'RULE_FIELD_NOT_ANSWERED_YET',
  'LIST_OPERATOR_WITHOUT_LIST',
  'OPERATOR_TYPE_MISMATCH',
  'UNARY_OPERATOR_WITH_VALUE',
  /* qualification */
  'NO_CLASSIFY_RULE',
  'OUTCOME_WITHOUT_VARIANT',
  /* consent */
  'CONSENT_FIELD_MISSING',
  'CONSENT_NOT_REQUIRED',
  'CONSENT_PRECHECKED',
  'CONSENT_NOT_PLACED',
  'CONSENT_VERSION_MISMATCH',
  /* links */
  'REDIRECT_NOT_ALLOWLISTED',
  'REDIRECT_ALLOWLIST_PENDING',
  'INVALID_RELATIVE_TARGET',
  /* pages */
  'DUPLICATE_BLOCK_ID',
  'PAGE_NO_HERO',
  'PAGE_NO_CTA',
  'PAGE_NO_LEGAL',
  'COMPARISON_SHAPE_INVALID',
  'UNKNOWN_ANCHOR',
  'HYBRID_FORM_REF_MISMATCH',
] as const;
export const validationIssueCodeSchema = z.enum(VALIDATION_ISSUE_CODES);
export type ValidationIssueCode = z.infer<typeof validationIssueCodeSchema>;

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: IssueSeverity;
  /** German, human-readable location, e.g. `Schritt „Kontakt" (kontakt)`. */
  pathDe: string;
  /** German explanation the builder renders inline. */
  messageDe: string;
}

function issue(
  code: ValidationIssueCode,
  severity: IssueSeverity,
  pathDe: string,
  messageDe: string,
): ValidationIssue {
  return { code, severity, pathDe, messageDe };
}

export function errorsOf(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((entry) => entry.severity === 'ERROR');
}

export function warningsOf(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((entry) => entry.severity === 'WARNING');
}

/** True when at least one issue blocks publishing. */
export function hasBlockingIssues(issues: readonly ValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === 'ERROR');
}

/* -------------------------------------------------------------------------- */
/* German path helpers                                                         */
/* -------------------------------------------------------------------------- */

function quoted(value: string): string {
  return `„${value}“`;
}

function stepPath(step: FormStep): string {
  return `Schritt ${quoted(step.title)} (${step.stepId})`;
}

function fieldPath(spec: MultiStepFormSpec, fieldId: string): string {
  const field = getField(spec, fieldId);
  return field ? `Feld ${quoted(field.label)} (${fieldId})` : `Feld (${fieldId})`;
}

/* -------------------------------------------------------------------------- */
/* Schema issues                                                               */
/* -------------------------------------------------------------------------- */

const ZOD_MESSAGES_DE: Readonly<Record<string, string>> = {
  invalid_type: 'Falscher Datentyp.',
  too_small: 'Der Wert ist zu klein bzw. zu kurz.',
  too_big: 'Der Wert ist zu groß bzw. zu lang.',
  invalid_format: 'Ungültiges Format.',
  not_multiple_of: 'Der Wert passt nicht zum erlaubten Raster.',
  unrecognized_keys: 'Unbekannte Felder im Dokument.',
  invalid_union: 'Der Wert passt zu keiner erlaubten Variante.',
  invalid_key: 'Ungültiger Schlüssel.',
  invalid_element: 'Ungültiger Eintrag in einer Liste.',
  invalid_value: 'Unzulässiger Wert.',
};

function germanZodMessage(zodIssue: z.core.$ZodIssue): string {
  if (zodIssue.code === 'custom') return zodIssue.message;
  return ZOD_MESSAGES_DE[zodIssue.code] ?? zodIssue.message;
}

function pathString(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'Dokument' : path.map((part) => String(part)).join('.');
}

function schemaIssues(schema: z.ZodType, input: unknown): ValidationIssue[] {
  const parsed = schema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((zodIssue) =>
    issue('SCHEMA_INVALID', 'ERROR', pathString(zodIssue.path), germanZodMessage(zodIssue)),
  );
}

interface MarkupScan {
  issues: ValidationIssue[];
  /** Paths already reported as markup — the schema issue for them is redundant. */
  paths: Set<string>;
}

/**
 * Markup is reported under its own code rather than as a generic schema
 * violation, so the builder can offer "Text bereinigen" instead of a raw
 * validation message.
 */
function markupIssues(input: unknown): MarkupScan {
  const issues: ValidationIssue[] = [];
  const paths = new Set<string>();

  for (const violation of findMarkupViolations(input)) {
    const match = /^(.*) \(([^)]*)\)$/.exec(violation);
    const path = (match?.[1] ?? violation).replace(/^\$\./, '');
    const reason = match?.[2] ?? 'Markup';
    paths.add(path);
    issues.push(
      issue(
        'MARKUP_NOT_ALLOWED',
        'ERROR',
        path,
        `Specs dürfen kein Markup, kein Skript und kein CSS enthalten (gefunden: ${reason}).`,
      ),
    );
  }

  return { issues, paths };
}

/* -------------------------------------------------------------------------- */
/* Link targets                                                                */
/* -------------------------------------------------------------------------- */

interface FoundLink {
  target: LinkTarget;
  path: string;
}

function collectLinkTargets(value: unknown, path: string, found: FoundLink[]): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLinkTargets(item, `${path}[${index}]`, found));
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.href === 'string' &&
    typeof record.external === 'boolean' &&
    typeof record.requiresAllowlist === 'boolean'
  ) {
    found.push({ target: record as unknown as LinkTarget, path });
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    collectLinkTargets(child, `${path}.${key}`, found);
  }
}

/**
 * Redirect and link targets are either application-internal or explicitly
 * flagged for the caller's allowlist check. This package never resolves a host.
 */
function linkIssues(spec: unknown, root: string): ValidationIssue[] {
  const found: FoundLink[] = [];
  collectLinkTargets(spec, root, found);
  const issues: ValidationIssue[] = [];

  for (const { target, path } of found) {
    if (!target.external) {
      if (!isRelativeHref(target.href) && !isAnchorHref(target.href)) {
        issues.push(
          issue(
            'INVALID_RELATIVE_TARGET',
            'ERROR',
            path,
            `Das interne Ziel ${quoted(target.href)} ist kein anwendungsinterner Pfad (erwartet z. B. /danke oder #formular).`,
          ),
        );
      }
      continue;
    }
    if (!target.requiresAllowlist) {
      issues.push(
        issue(
          'REDIRECT_NOT_ALLOWLISTED',
          'ERROR',
          path,
          `Das externe Ziel ${quoted(target.href)} ist nicht für die Allowlist-Prüfung markiert und darf nicht veröffentlicht werden.`,
        ),
      );
      continue;
    }
    issues.push(
      issue(
        'REDIRECT_ALLOWLIST_PENDING',
        'WARNING',
        path,
        `Das externe Ziel ${quoted(target.href)} muss vor der Veröffentlichung gegen die Redirect-Allowlist geprüft werden.`,
      ),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Step graph                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Classic three-colour DFS. Returns the first cycle found as a step-id path
 * (`a → b → a`), or `null` when the routing graph is acyclic.
 */
export function findStepCycle(spec: MultiStepFormSpec): string[] | null {
  const known = new Set(spec.steps.map((step) => step.stepId));
  const color = new Map<string, 'GRAY' | 'BLACK'>();
  const stack: string[] = [];

  const visit = (stepId: string): string[] | null => {
    color.set(stepId, 'GRAY');
    stack.push(stepId);

    for (const target of outgoingTargets(spec, stepId)) {
      if (target.kind !== 'STEP') continue;
      const next = target.stepId;
      if (!known.has(next)) continue;
      const state = color.get(next);
      if (state === 'GRAY') {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state === undefined) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }

    color.set(stepId, 'BLACK');
    stack.pop();
    return null;
  };

  for (const step of spec.steps) {
    if (color.get(step.stepId) === undefined) {
      const cycle = visit(step.stepId);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Steps reachable from `startId` following `STEP` transitions (exclusive). */
export function reachableSteps(spec: MultiStepFormSpec, startId: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [startId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const target of outgoingTargets(spec, current)) {
      if (target.kind !== 'STEP') continue;
      if (seen.has(target.stepId)) continue;
      seen.add(target.stepId);
      queue.push(target.stepId);
    }
  }
  return seen;
}

/**
 * Steps from which *every* continuation reaches a terminal transition. Only
 * meaningful on an acyclic graph, so the caller runs it after the cycle check.
 */
function terminatingSteps(spec: MultiStepFormSpec): Set<string> {
  const known = new Set(spec.steps.map((step) => step.stepId));
  const resolved = new Map<string, boolean>();

  const terminates = (stepId: string, onStack: Set<string>): boolean => {
    const cached = resolved.get(stepId);
    if (cached !== undefined) return cached;
    if (onStack.has(stepId)) return false;

    onStack.add(stepId);
    const targets = outgoingTargets(spec, stepId);
    let ok = targets.length > 0;
    for (const target of targets) {
      if (target.kind !== 'STEP') continue;
      if (!known.has(target.stepId) || !terminates(target.stepId, onStack)) {
        ok = false;
        break;
      }
    }
    onStack.delete(stepId);
    resolved.set(stepId, ok);
    return ok;
  };

  const result = new Set<string>();
  for (const step of spec.steps) {
    if (terminates(step.stepId, new Set())) result.add(step.stepId);
  }
  return result;
}

function graphIssues(spec: MultiStepFormSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set(spec.steps.map((step) => step.stepId));
  const variantIds = new Set(spec.resultVariants.map((variant) => variant.variantId));

  if (spec.steps.length === 0) {
    issues.push(
      issue('NO_STEPS', 'ERROR', 'Dokument', 'Das Formular enthält keinen einzigen Schritt.'),
    );
    return issues;
  }

  const seenStepIds = new Set<string>();
  for (const step of spec.steps) {
    if (seenStepIds.has(step.stepId)) {
      issues.push(
        issue(
          'DUPLICATE_STEP_ID',
          'ERROR',
          stepPath(step),
          `Die Schritt-Kennung ${quoted(step.stepId)} wird mehrfach verwendet.`,
        ),
      );
    }
    seenStepIds.add(step.stepId);
  }

  const seenVariantIds = new Set<string>();
  for (const variant of spec.resultVariants) {
    if (seenVariantIds.has(variant.variantId)) {
      issues.push(
        issue(
          'DUPLICATE_RESULT_VARIANT_ID',
          'ERROR',
          `Ergebnis ${quoted(variant.variantId)}`,
          'Die Kennung dieser Ergebnisvariante wird mehrfach verwendet.',
        ),
      );
    }
    seenVariantIds.add(variant.variantId);
  }

  /* Dangling transitions. */
  for (const step of spec.steps) {
    const transitions: { label: string; target: ReturnType<typeof outgoingTargets>[number] }[] = [
      ...routingRulesFor(spec, step.stepId).map((rule) => ({
        label: `Regel ${quoted(rule.ruleId)}`,
        target: rule.target,
      })),
      { label: 'Standardübergang', target: step.defaultNext },
    ];

    for (const { label, target } of transitions) {
      const where = `${stepPath(step)} → ${label}`;
      if (target.kind === 'STEP' && !known.has(target.stepId)) {
        issues.push(
          issue(
            'UNKNOWN_STEP_TARGET',
            'ERROR',
            where,
            `Der Übergang zeigt auf den unbekannten Schritt ${quoted(target.stepId)}. Dieser Pfad endet im Nichts.`,
          ),
        );
      }
      if (
        (target.kind === 'RESULT' || target.kind === 'DISQUALIFY') &&
        !variantIds.has(target.variantId)
      ) {
        issues.push(
          issue(
            'UNKNOWN_RESULT_VARIANT',
            'ERROR',
            where,
            `Der Übergang zeigt auf die unbekannte Ergebnisvariante ${quoted(target.variantId)}.`,
          ),
        );
      }
    }
  }

  /* Acyclicity. */
  const cycle = findStepCycle(spec);
  if (cycle) {
    issues.push(
      issue(
        'STEP_GRAPH_CYCLE',
        'ERROR',
        `Schrittfolge ${cycle.join(' → ')}`,
        `Die Schrittfolge enthält einen Kreis (${cycle.join(' → ')}). Besucherinnen und Besucher könnten das Formular nie beenden.`,
      ),
    );
  }

  /* Reachability from the entry step. */
  const entry = entryStepId(spec);
  if (entry) {
    const reachable = reachableSteps(spec, entry);
    for (const step of spec.steps) {
      if (step.stepId === entry || reachable.has(step.stepId)) continue;
      issues.push(
        issue(
          'STEP_UNREACHABLE',
          'ERROR',
          stepPath(step),
          `Dieser Schritt ist vom Startschritt ${quoted(entry)} aus nicht erreichbar.`,
        ),
      );
    }
  }

  /* Termination — only decidable once the graph is acyclic. */
  if (!cycle) {
    const terminating = terminatingSteps(spec);
    for (const step of spec.steps) {
      if (terminating.has(step.stepId)) continue;
      issues.push(
        issue(
          'STEP_NOT_TERMINATING',
          'ERROR',
          stepPath(step),
          'Von diesem Schritt aus führt nicht jeder Pfad zu einem Abschluss (Absenden, Ergebnisvariante oder Disqualifikation).',
        ),
      );
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

function fieldIssues(spec: MultiStepFormSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const placement = new Map<string, string[]>();

  for (const step of spec.steps) {
    for (const fieldId of step.fieldIds) {
      if (!getField(spec, fieldId)) {
        issues.push(
          issue(
            'UNKNOWN_FIELD_REFERENCE',
            'ERROR',
            `${stepPath(step)} → ${fieldId}`,
            `Der Schritt verweist auf das unbekannte Feld ${quoted(fieldId)}.`,
          ),
        );
        continue;
      }
      placement.set(fieldId, [...(placement.get(fieldId) ?? []), step.stepId]);
    }
  }

  for (const [fieldId, field] of Object.entries(spec.fields)) {
    const where = fieldPath(spec, fieldId);

    if (field.fieldId !== fieldId) {
      issues.push(
        issue(
          'FIELD_ID_MISMATCH',
          'ERROR',
          where,
          `Der Schlüssel ${quoted(fieldId)} und die Feld-Kennung ${quoted(field.fieldId)} stimmen nicht überein.`,
        ),
      );
    }

    if (field.label.trim().length === 0) {
      issues.push(
        issue('EMPTY_LABEL', 'ERROR', where, 'Jedes Feld benötigt eine sichtbare Beschriftung.'),
      );
    }

    const steps = placement.get(fieldId) ?? [];
    if (steps.length === 0) {
      issues.push(
        issue(
          'FIELD_NOT_PLACED',
          'WARNING',
          where,
          'Dieses Feld ist keinem Schritt zugeordnet und wird nie angezeigt.',
        ),
      );
    } else if (steps.length > 1) {
      issues.push(
        issue(
          'FIELD_PLACED_TWICE',
          'ERROR',
          where,
          `Dieses Feld ist mehreren Schritten zugeordnet (${steps.join(', ')}).`,
        ),
      );
    }

    if (isSelectField(field)) {
      const seen = new Set<string>();
      for (const option of field.options) {
        if (seen.has(option.optionId)) {
          issues.push(
            issue(
              'DUPLICATE_OPTION_ID',
              'ERROR',
              `${where} → Option ${quoted(option.optionId)}`,
              'Antwort-Kennungen müssen innerhalb eines Feldes eindeutig sein.',
            ),
          );
        }
        seen.add(option.optionId);
        if (option.label.trim().length === 0) {
          issues.push(
            issue(
              'EMPTY_LABEL',
              'ERROR',
              `${where} → Option ${quoted(option.optionId)}`,
              'Jede Antwortoption benötigt eine sichtbare Beschriftung.',
            ),
          );
        }
      }
    }

    if (field.type === 'POSTCODE') {
      if (
        field.country !== 'DE' ||
        field.maxLength !== 5 ||
        field.normalization !== 'POSTCODE_DE'
      ) {
        issues.push(
          issue(
            'POSTCODE_NOT_DE5',
            'ERROR',
            where,
            'Eine deutsche Postleitzahl muss auf genau fünf Ziffern geprüft werden (Land DE, maxLength 5, Normalisierung POSTCODE_DE).',
          ),
        );
      }
    }

    if (INHERENTLY_PII_FIELD_TYPES.includes(field.type) && field.piiClass !== 'PII') {
      issues.push(
        issue(
          'PII_CLASS_MISMATCH',
          'ERROR',
          where,
          `Felder vom Typ ${field.type} enthalten immer personenbezogene Daten und müssen als PII klassifiziert sein.`,
        ),
      );
    }
  }

  return issues;
}

/**
 * Contact data is asked last.
 *
 * Formally: from a step that collects personal data, no further step may collect
 * anything other than consent. That holds on every branch of the graph, which is
 * why this is a reachability check and not a "is it the last element" check.
 */
function piiPlacementIssues(spec: MultiStepFormSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const collectsData = (step: FormStep): boolean =>
    step.fieldIds.some((fieldId) => {
      const field = getField(spec, fieldId);
      return field !== null && field.type !== 'CONSENT';
    });

  for (const step of spec.steps) {
    const hasContact = step.fieldIds.some((fieldId) => {
      const field = getField(spec, fieldId);
      return field !== null && isContactField(field);
    });
    if (!hasContact) continue;

    const offenders = [...reachableSteps(spec, step.stepId)]
      .filter((stepId) => stepId !== step.stepId)
      .map((stepId) => getStep(spec, stepId))
      .filter((next): next is FormStep => next !== null && collectsData(next));

    if (offenders.length > 0) {
      issues.push(
        issue(
          'PII_NOT_LAST_STEP',
          'ERROR',
          stepPath(step),
          `Kontaktdaten werden zuletzt erfragt. Nach diesem Schritt folgen noch fachliche Fragen: ${offenders
            .map((next) => quoted(next.title))
            .join(', ')}.`,
        ),
      );
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

function conditionAtoms(
  node: ConditionNode,
): { fieldId: string; operator: string; value: unknown }[] {
  if (isConditionGroup(node)) {
    const children = 'all' in node ? node.all : node.any;
    return children.flatMap((child) => conditionAtoms(child));
  }
  return [node];
}

function conditionIssues(
  spec: MultiStepFormSpec,
  condition: ConditionGroup,
  where: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const entry of conditionAtoms(condition)) {
    const field: FormField | null = getField(spec, entry.fieldId);
    const at = `${where} → ${entry.fieldId}`;

    if (!field) {
      issues.push(
        issue(
          'UNKNOWN_FIELD_IN_RULE',
          'ERROR',
          at,
          `Die Bedingung verweist auf das unbekannte Feld ${quoted(entry.fieldId)}.`,
        ),
      );
      continue;
    }

    const operator = entry.operator as (typeof UNARY_OPERATORS)[number];

    if (UNARY_OPERATORS.includes(operator)) {
      if (entry.value !== null) {
        issues.push(
          issue(
            'UNARY_OPERATOR_WITH_VALUE',
            'WARNING',
            at,
            `Der Operator ${entry.operator} vergleicht keinen Wert; der angegebene Wert wird ignoriert.`,
          ),
        );
      }
      continue;
    }

    if (LIST_OPERATORS.includes(operator) && !Array.isArray(entry.value)) {
      issues.push(
        issue(
          'LIST_OPERATOR_WITHOUT_LIST',
          'ERROR',
          at,
          `Der Operator ${entry.operator} erwartet eine Liste von Antwort-Kennungen.`,
        ),
      );
      continue;
    }

    if (NUMERIC_OPERATORS.includes(operator) && field.type !== 'NUMBER' && field.type !== 'RANGE') {
      issues.push(
        issue(
          'OPERATOR_TYPE_MISMATCH',
          'WARNING',
          at,
          `Der Operator ${entry.operator} vergleicht Zahlen, das Feld ${quoted(field.label)} ist aber vom Typ ${field.type}.`,
        ),
      );
      continue;
    }

    if (isSelectField(field)) {
      const known = new Set(field.options.map((option) => option.optionId));
      const referenced = Array.isArray(entry.value)
        ? entry.value.map((item) => String(item))
        : entry.value === null || typeof entry.value === 'boolean'
          ? []
          : [String(entry.value)];
      for (const optionId of referenced) {
        if (!known.has(optionId)) {
          issues.push(
            issue(
              'UNKNOWN_OPTION_IN_RULE',
              'ERROR',
              at,
              `Die Bedingung verweist auf die unbekannte Antwortoption ${quoted(optionId)} des Feldes ${quoted(field.label)}.`,
            ),
          );
        }
      }
    }
  }

  return issues;
}

function ruleIssues(spec: MultiStepFormSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set(spec.steps.map((step) => step.stepId));
  const seenRuleIds = new Set<string>();

  const checkRuleId = (ruleId: string, where: string): void => {
    if (seenRuleIds.has(ruleId)) {
      issues.push(
        issue(
          'DUPLICATE_RULE_ID',
          'ERROR',
          where,
          `Die Regel-Kennung ${quoted(ruleId)} wird mehrfach verwendet.`,
        ),
      );
    }
    seenRuleIds.add(ruleId);
  };

  for (const rule of spec.routingRules) {
    const where = `Routing-Regel ${quoted(rule.ruleId)}`;
    checkRuleId(rule.ruleId, where);

    if (!known.has(rule.fromStepId)) {
      issues.push(
        issue(
          'RULE_FROM_UNKNOWN_STEP',
          'ERROR',
          where,
          `Die Regel gehört zum unbekannten Schritt ${quoted(rule.fromStepId)}.`,
        ),
      );
    }

    issues.push(...conditionIssues(spec, rule.when, where));

    /* A branch may only depend on questions that were already asked. */
    for (const fieldId of conditionFieldIds(rule.when)) {
      const fieldStep = stepOfField(spec, fieldId);
      if (!fieldStep || !known.has(rule.fromStepId)) continue;
      if (fieldStep.stepId === rule.fromStepId) continue;
      const answeredBefore = reachableSteps(spec, fieldStep.stepId).has(rule.fromStepId);
      if (!answeredBefore) {
        issues.push(
          issue(
            'RULE_FIELD_NOT_ANSWERED_YET',
            'ERROR',
            `${where} → ${fieldId}`,
            `Die Regel verzweigt anhand von ${fieldPath(spec, fieldId)}, das erst nach ${quoted(rule.fromStepId)} erfragt wird.`,
          ),
        );
      }
    }
  }

  for (const rule of spec.qualificationRules) {
    const where = `Qualifizierungsregel ${quoted(rule.ruleId)}`;
    checkRuleId(rule.ruleId, where);
    if (rule.when !== null) {
      issues.push(...conditionIssues(spec, rule.when, where));
    }
  }

  const hasClassify = spec.qualificationRules.some((rule) => rule.effect === 'CLASSIFY');
  if (!hasClassify) {
    issues.push(
      issue(
        'NO_CLASSIFY_RULE',
        'WARNING',
        'Qualifizierung',
        'Ohne CLASSIFY-Regel endet jede Einreichung ohne Disqualifikation in der manuellen Prüfung.',
      ),
    );
  }

  const producibleOutcomes = new Set<QualificationOutcome>(['NEEDS_REVIEW']);
  for (const rule of spec.qualificationRules) {
    if (rule.effect === 'DISQUALIFY') producibleOutcomes.add('NOT_A_FIT');
    if (rule.effect === 'QUALIFY') producibleOutcomes.add('QUALIFIED');
    if (rule.effect === 'CLASSIFY') producibleOutcomes.add(rule.outcome);
  }
  for (const outcome of producibleOutcomes) {
    const covered = spec.resultVariants.some(
      (variant) => variant.forOutcomes.length === 0 || variant.forOutcomes.includes(outcome),
    );
    if (!covered) {
      issues.push(
        issue(
          'OUTCOME_WITHOUT_VARIANT',
          'WARNING',
          `Qualifizierung → ${outcome}`,
          `Für das Ergebnis ${quoted(outcome)} ist keine Ergebnisvariante hinterlegt.`,
        ),
      );
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Consent                                                                     */
/* -------------------------------------------------------------------------- */

function consentIssues(spec: MultiStepFormSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const where = `Einwilligung (${spec.consent.fieldId})`;

  if (spec.consent.required !== true) {
    issues.push(
      issue('CONSENT_NOT_REQUIRED', 'ERROR', where, 'Die Einwilligung muss verpflichtend sein.'),
    );
  }
  if (spec.consent.defaultChecked !== false) {
    issues.push(
      issue(
        'CONSENT_PRECHECKED',
        'ERROR',
        where,
        'Eine vorangekreuzte Einwilligung ist keine Einwilligung. Das Kästchen muss leer starten.',
      ),
    );
  }

  const field = getField(spec, spec.consent.fieldId);
  if (!field || field.type !== 'CONSENT') {
    issues.push(
      issue(
        'CONSENT_FIELD_MISSING',
        'ERROR',
        where,
        `Es gibt kein Feld vom Typ CONSENT mit der Kennung ${quoted(spec.consent.fieldId)}.`,
      ),
    );
    return issues;
  }

  if (!field.required) {
    issues.push(
      issue('CONSENT_NOT_REQUIRED', 'ERROR', where, 'Das Einwilligungsfeld muss Pflicht sein.'),
    );
  }
  if (field.consentVersionId !== spec.consent.consentVersionId) {
    issues.push(
      issue(
        'CONSENT_VERSION_MISMATCH',
        'ERROR',
        where,
        'Feld und Einwilligungstext verweisen auf unterschiedliche Consent-Versionen.',
      ),
    );
  }
  if (!stepOfField(spec, spec.consent.fieldId)) {
    issues.push(
      issue(
        'CONSENT_NOT_PLACED',
        'ERROR',
        where,
        'Das Einwilligungsfeld ist keinem Schritt zugeordnet und würde nie angezeigt.',
      ),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Public API — forms                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Full publish-time validation of a multi-step form. Returns every issue at
 * once; `hasBlockingIssues` decides whether the version may be frozen.
 */
export function validateFormSpec(spec: MultiStepFormSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const markup = markupIssues(spec);
  issues.push(...markup.issues);
  issues.push(
    ...schemaIssues(multiStepFormSpecSchema, spec).filter(
      (entry) => !markup.paths.has(entry.pathDe),
    ),
  );
  issues.push(...graphIssues(spec));
  issues.push(...fieldIssues(spec));
  issues.push(...piiPlacementIssues(spec));
  issues.push(...ruleIssues(spec));
  issues.push(...consentIssues(spec));
  issues.push(...linkIssues(spec, 'Formular'));
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Public API — pages                                                          */
/* -------------------------------------------------------------------------- */

function blockLabel(block: PageBlock): string {
  return `Block ${quoted(block.blockId)} (${block.type})`;
}

function blockIssues(blocks: readonly PageBlock[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const anchors = new Set<string>();

  for (const block of blocks) {
    if (seen.has(block.blockId)) {
      issues.push(
        issue(
          'DUPLICATE_BLOCK_ID',
          'ERROR',
          blockLabel(block),
          'Block-Kennungen müssen eindeutig sein.',
        ),
      );
    }
    seen.add(block.blockId);
    if (block.anchor) anchors.add(block.anchor);

    if (block.type === 'COMPARISON') {
      for (const row of block.rows) {
        if (row.cells.length !== block.columns.length) {
          issues.push(
            issue(
              'COMPARISON_SHAPE_INVALID',
              'ERROR',
              `${blockLabel(block)} → Zeile ${quoted(row.label)}`,
              `Die Zeile hat ${row.cells.length} Zellen, die Tabelle aber ${block.columns.length} Spalten.`,
            ),
          );
        }
      }
    }
  }

  /* In-page anchors must point at a block that actually declares them. */
  const found: FoundLink[] = [];
  collectLinkTargets(blocks, 'Blöcke', found);
  for (const { target, path } of found) {
    if (target.external || !isAnchorHref(target.href)) continue;
    if (!anchors.has(target.href.slice(1))) {
      issues.push(
        issue(
          'UNKNOWN_ANCHOR',
          'WARNING',
          path,
          `Der Sprungpunkt ${quoted(target.href)} verweist auf keinen Block dieser Seite.`,
        ),
      );
    }
  }

  const hasHero = blocks.some((block) => block.type === 'HERO');
  if (!hasHero) {
    issues.push(issue('PAGE_NO_HERO', 'WARNING', 'Seite', 'Die Seite beginnt ohne Hero-Block.'));
  }

  const hasCta = blocks.some(
    (block) =>
      block.type === 'CTA' ||
      block.type === 'BOOKING_CTA' ||
      block.type === 'EMBEDDED_CONTACT' ||
      block.type === 'HERO',
  );
  if (!hasCta) {
    issues.push(
      issue(
        'PAGE_NO_CTA',
        'ERROR',
        'Seite',
        'Die Seite enthält keine Handlungsaufforderung und kann keine Anfragen erzeugen.',
      ),
    );
  }

  const hasLegal = blocks.some((block) => block.type === 'FOOTER_LEGAL');
  if (!hasLegal) {
    issues.push(
      issue(
        'PAGE_NO_LEGAL',
        'ERROR',
        'Seite',
        'Impressum und Datenschutzerklärung müssen auf jeder veröffentlichten Seite verlinkt sein.',
      ),
    );
  }

  return issues;
}

export function validatePageSpec(spec: LandingPageSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const markup = markupIssues(spec);
  issues.push(...markup.issues);
  issues.push(
    ...schemaIssues(landingPageSpecSchema, spec).filter((entry) => !markup.paths.has(entry.pathDe)),
  );
  issues.push(...blockIssues(spec.blocks));
  issues.push(...linkIssues(spec.blocks, 'Blöcke'));
  return issues;
}

export function validateHybridSpec(spec: HybridFunnelSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const markup = markupIssues(spec);
  issues.push(...markup.issues);
  issues.push(
    ...schemaIssues(hybridFunnelSpecSchema, spec).filter(
      (entry) => !markup.paths.has(entry.pathDe),
    ),
  );
  issues.push(...blockIssues(spec.blocks));
  issues.push(...linkIssues(spec.blocks, 'Blöcke'));

  if (spec.form.anchorBlockId && !spec.blocks.some((b) => b.blockId === spec.form.anchorBlockId)) {
    issues.push(
      issue(
        'HYBRID_FORM_REF_MISMATCH',
        'ERROR',
        `Formularreferenz (${spec.form.anchorBlockId})`,
        `Der Ankerblock ${quoted(spec.form.anchorBlockId)} existiert auf dieser Seite nicht.`,
      ),
    );
  }

  if (spec.formSpec) {
    if (
      spec.formSpec.formId !== spec.form.formId ||
      spec.formSpec.formVersionId !== spec.form.formVersionId
    ) {
      issues.push(
        issue(
          'HYBRID_FORM_REF_MISMATCH',
          'ERROR',
          'Formularreferenz',
          'Das eingebettete Formular gehört nicht zur referenzierten Formularversion.',
        ),
      );
    }
    issues.push(
      ...validateFormSpec(spec.formSpec).map((entry) => ({
        ...entry,
        pathDe: `Formular → ${entry.pathDe}`,
      })),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Parsing at the AI / API boundary                                            */
/* -------------------------------------------------------------------------- */

export interface ParseResult<T> {
  spec: T | null;
  issues: ValidationIssue[];
}

/** Parses untrusted input (AI output, an API payload) and validates it. */
export function parseFormSpec(input: unknown): ParseResult<MultiStepFormSpec> {
  const parsed = multiStepFormSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      spec: null,
      issues: parsed.error.issues.map((zodIssue) =>
        issue('SCHEMA_INVALID', 'ERROR', pathString(zodIssue.path), germanZodMessage(zodIssue)),
      ),
    };
  }
  return { spec: parsed.data, issues: validateFormSpec(parsed.data) };
}

export function parsePageSpec(input: unknown): ParseResult<LandingPageSpec> {
  const parsed = landingPageSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      spec: null,
      issues: parsed.error.issues.map((zodIssue) =>
        issue('SCHEMA_INVALID', 'ERROR', pathString(zodIssue.path), germanZodMessage(zodIssue)),
      ),
    };
  }
  return { spec: parsed.data, issues: validatePageSpec(parsed.data) };
}
