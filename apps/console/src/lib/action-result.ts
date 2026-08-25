import { DomainError, isDomainError, type DryRunResult } from '@am/domain';

/**
 * The uniform result shape every server action returns.
 *
 * Three outcomes rather than two, because "we did not perform the write, and
 * here is exactly what we would have sent" is a distinct thing from success and
 * from failure. Collapsing it into either one is how a dry run ends up rendered
 * as a completed action.
 */
export type ActionResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'dry_run'; dryRun: DryRunResult }
  | {
      status: 'error';
      code: string;
      messageDe: string;
      /** Field-level messages for form rendering, keyed by field path. */
      fieldErrors?: Record<string, string>;
      retryable: boolean;
    };

export function actionOk<T>(data: T): ActionResult<T> {
  return { status: 'ok', data };
}

export function actionDryRun<T>(dryRun: DryRunResult): ActionResult<T> {
  return { status: 'dry_run', dryRun };
}

export function actionError<T>(
  code: string,
  messageDe: string,
  options: { fieldErrors?: Record<string, string>; retryable?: boolean } = {},
): ActionResult<T> {
  return {
    status: 'error',
    code,
    messageDe,
    fieldErrors: options.fieldErrors,
    retryable: options.retryable ?? false,
  };
}

/**
 * Converts any thrown value into a German, renderable error. Unknown errors are
 * deliberately opaque to the client — the detail goes to the log, not to the
 * screen — but they are never rendered as an empty page.
 */
export function toActionError<T>(error: unknown): ActionResult<T> {
  if (isDomainError(error)) {
    const fieldErrors = extractFieldErrors(error);
    return {
      status: 'error',
      code: error.code,
      messageDe: error.messageDe,
      ...(fieldErrors ? { fieldErrors } : {}),
      retryable: error.retryable,
    };
  }
  return {
    status: 'error',
    code: 'INTERNAL',
    messageDe: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    retryable: true,
  };
}

function extractFieldErrors(error: DomainError): Record<string, string> | undefined {
  const raw = error.details.fieldErrors;
  if (!raw || typeof raw !== 'object') return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => typeof value === 'string',
  );
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

export function isDryRun<T>(
  result: ActionResult<T>,
): result is { status: 'dry_run'; dryRun: DryRunResult } {
  return result.status === 'dry_run';
}

export function isOk<T>(result: ActionResult<T>): result is { status: 'ok'; data: T } {
  return result.status === 'ok';
}
