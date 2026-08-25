/**
 * Stable DOM ids derived from spec keys.
 *
 * The runtime has to move focus to the first invalid field after a failed step,
 * which means the id a `<label htmlFor>` points at and the id the error handler
 * looks up must be produced by the same function. Two ad-hoc template strings
 * that agree today are a focus bug tomorrow.
 */

export function fieldDomId(fieldId: string): string {
  return `feld-${fieldId}`;
}

export function fieldErrorDomId(fieldId: string): string {
  return `feld-${fieldId}-fehler`;
}

export function fieldHelpDomId(fieldId: string): string {
  return `feld-${fieldId}-hilfe`;
}

export function optionDomId(fieldId: string, optionId: string): string {
  return `feld-${fieldId}-option-${optionId}`;
}

/** `aria-describedby` for a control: help text and error, in reading order. */
export function describedBy(fieldId: string, hasHelp: boolean, hasError: boolean): string | undefined {
  const ids = [
    hasHelp ? fieldHelpDomId(fieldId) : null,
    hasError ? fieldErrorDomId(fieldId) : null,
  ].filter((id): id is string => id !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
