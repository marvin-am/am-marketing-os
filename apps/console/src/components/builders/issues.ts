import { errorsOf, hasBlockingIssues, warningsOf, type ValidationIssue } from '@am/funnel-schema';

/**
 * Routing validation issues to the element they are about.
 *
 * `validateFormSpec` / `validatePageSpec` return one flat list with a German
 * `pathDe` such as `Schritt „Wo befindet sich Ihr Unternehmen?“ (standort)` or a
 * schema path such as `steps.3.title`. The builders render each issue next to
 * the thing that is wrong, so they need to ask "which of these belong to step
 * `standort`?".
 *
 * Rather than re-deriving the validator's knowledge, the builders hand over the
 * identifiers a UI element owns (`standort`, `steps.3`) and this module matches
 * them against `pathDe` on token boundaries — `frage_1` must not match
 * `frage_10`.
 */

export type IssueToken = string | null | undefined;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `pathDe` mentions `token` as a standalone identifier. */
export function pathMentions(pathDe: string, token: string): boolean {
  if (token.length === 0) return false;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}([^A-Za-z0-9_]|$)`);
  return pattern.test(pathDe);
}

/** Every issue whose path mentions at least one of the given tokens. */
export function issuesFor(
  issues: readonly ValidationIssue[],
  ...tokens: IssueToken[]
): ValidationIssue[] {
  const wanted = tokens.filter((token): token is string => Boolean(token));
  if (wanted.length === 0) return [];
  return issues.filter((issue) => wanted.some((token) => pathMentions(issue.pathDe, token)));
}

export interface IssueCounts {
  errors: number;
  warnings: number;
}

export function countIssues(issues: readonly ValidationIssue[]): IssueCounts {
  return { errors: errorsOf(issues).length, warnings: warningsOf(issues).length };
}

/** The strongest severity present, or `null` for a clean element. */
export function worstSeverity(issues: readonly ValidationIssue[]): 'ERROR' | 'WARNING' | null {
  if (issues.length === 0) return null;
  return hasBlockingIssues(issues) ? 'ERROR' : 'WARNING';
}

/** German one-liner for the persistent summary and for button hints. */
export function issueSummaryTextDe(issues: readonly ValidationIssue[]): string {
  const { errors, warnings } = countIssues(issues);
  if (errors === 0 && warnings === 0) return 'Keine offenen Hinweise. Die Version ist gültig.';

  const parts: string[] = [];
  if (errors > 0) parts.push(errors === 1 ? '1 Fehler' : `${errors} Fehler`);
  if (warnings > 0) parts.push(warnings === 1 ? '1 Warnung' : `${warnings} Warnungen`);
  const listed = parts.join(' und ');

  return errors > 0
    ? `${listed}. Fehler verhindern das Speichern und das Veröffentlichen.`
    : `${listed}. Warnungen verhindern das Speichern nicht.`;
}

/** Tokens a form step owns: its id and its position in the schema document. */
export function stepTokens(stepId: string, index: number): string[] {
  return [stepId, `steps.${index}`];
}

export function fieldTokens(fieldId: string): string[] {
  return [fieldId, `fields.${fieldId}`];
}

export function routingRuleTokens(ruleId: string, index: number): string[] {
  return [ruleId, `routingRules.${index}`];
}

export function qualificationRuleTokens(ruleId: string, index: number): string[] {
  return [ruleId, `qualificationRules.${index}`];
}

export function resultVariantTokens(variantId: string, index: number): string[] {
  return [variantId, `resultVariants.${index}`];
}

export function blockTokens(blockId: string, index: number): string[] {
  return [blockId, `blocks.${index}`];
}
