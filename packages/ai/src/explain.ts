import { DomainError } from '@am/domain';
import { runPrompt } from './pipeline/run-step';
import type { PipelineDeps, StepRunResult } from './pipeline/types';
import { metricExplanationPrompt } from './prompts/definitions';
import type { MetricExplanation } from './prompts/schemas';

/**
 * Narrow, guarded explanation helpers.
 *
 * "Data beats model opinion" (AGENTS.md rule 4) is not enforceable by asking
 * nicely. The model is handed a deterministic facts object, told to interpret
 * and never to compute — and then the answer is checked: every digit sequence
 * it contains must already appear in the facts. A rejected answer goes through
 * the same bounded repair turn as a schema violation and, failing that, becomes
 * `AI_OUTPUT_INVALID`.
 *
 * The check compares *digit signatures* rather than formatted strings, so
 * "1.234,5", "1234.5" and "12345" are the same number to it. That is lenient
 * about German versus machine formatting and strict about the digits
 * themselves, which is exactly the property the rule needs: the model may
 * reformat nothing into existence.
 */

/* -------------------------------------------------------------------------- */
/* Facts                                                                       */
/* -------------------------------------------------------------------------- */

export interface ExplainFact {
  label: string;
  /** Pre-formatted German value, e.g. "1,8 %" or "12 von 340". */
  valueDe: string;
  /** Optional German note — data maturity, attribution coverage, caveats. */
  noteDe?: string | null;
}

export interface ExplainFacts {
  titleDe: string;
  periodDe?: string | null;
  facts: readonly ExplainFact[];
  /** Deterministically derived maturity/attribution statement. */
  dataQualityDe?: string | null;
}

/** Renders the facts into the single block the prompt may draw numbers from. */
export function renderFactsBlockDe(facts: ExplainFacts): string {
  const lines: string[] = [facts.titleDe];
  if (facts.periodDe) lines.push(`Zeitraum: ${facts.periodDe}`);
  lines.push('');
  for (const fact of facts.facts) {
    lines.push(`- ${fact.label}: ${fact.valueDe}${fact.noteDe ? ` (${fact.noteDe})` : ''}`);
  }
  if (facts.dataQualityDe) {
    lines.push('', `Datenqualität: ${facts.dataQualityDe}`);
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Number guard                                                                */
/* -------------------------------------------------------------------------- */

/** Matches a number with German or machine grouping/decimal separators. */
const NUMBER_PATTERN = /\d+(?:[.,]\d+)*/g;

export function extractNumberTokens(text: string): string[] {
  return text.match(NUMBER_PATTERN) ?? [];
}

/** Digits only — the comparison key that ignores formatting. */
export function numberSignature(token: string): string {
  return token.replace(/\D/g, '');
}

/** Every digit signature that appears anywhere in the supplied facts. */
export function allowedNumberSignatures(facts: unknown): Set<string> {
  const haystack = typeof facts === 'string' ? facts : JSON.stringify(facts ?? '');
  return new Set(extractNumberTokens(haystack).map(numberSignature));
}

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, into));
  }
  return into;
}

/**
 * Returns the number tokens in `value` whose digits do not appear in `facts`.
 * `value` may be a string or any object — every string field is scanned.
 */
export function findInventedNumbers(value: unknown, facts: unknown): string[] {
  const allowed = allowedNumberSignatures(facts);
  const invented = new Set<string>();
  for (const text of collectStrings(value)) {
    for (const token of extractNumberTokens(text)) {
      if (!allowed.has(numberSignature(token))) invented.add(token);
    }
  }
  return [...invented].sort();
}

export function assertNoInventedNumbers(value: unknown, facts: unknown): void {
  const invented = findInventedNumbers(value, facts);
  if (invented.length === 0) return;
  throw new DomainError('AI_OUTPUT_INVALID', {
    messageDe:
      'Die Erklärung enthält Zahlen, die nicht aus den berechneten Fakten stammen. Kennzahlen werden ausschließlich berechnet, nie erzeugt.',
    details: { inventedNumbers: invented },
    retryable: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Explanation                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExplainInput {
  facts: ExplainFacts;
  /** The German question the explanation should answer. */
  questionDe: string;
}

export type ExplainResult = StepRunResult<MetricExplanation>;

/**
 * Asks the model to explain already-computed figures and propose the next
 * hypothesis. The answer is rejected — and one repair turn spent — if it
 * contains a number the facts do not.
 */
export function explainMetrics(input: ExplainInput, deps: PipelineDeps): Promise<ExplainResult> {
  const factsBlockDe = renderFactsBlockDe(input.facts);
  return runPrompt<{ factsBlockDe: string; questionDe: string }, MetricExplanation>(
    metricExplanationPrompt,
    { factsBlockDe, questionDe: input.questionDe },
    deps,
    {
      postValidate: (output) =>
        findInventedNumbers(output, factsBlockDe).map(
          (token) =>
            `(root): Die Zahl „${token}“ kommt in den berechneten Fakten nicht vor. Entfernen Sie sie oder beschreiben Sie den Effekt qualitativ.`,
        ),
    },
  );
}
