/**
 * Import-mode guard.
 *
 * While a historical import runs, we are reconstructing the past. Any outbound
 * dispatch triggered from that reconstruction would be a lie: a CAPI event for
 * a lead from March 2024, or a CRM sync for a deal that closed a year ago.
 *
 * The guard is a depth counter rather than an `AsyncLocalStorage` on purpose —
 * this package is consumed by the funnel runtime, which may be bundled for
 * environments without `node:async_hooks`. The counter over-suppresses if an
 * import and a live dispatch genuinely overlap in one process, which is the
 * safe direction to be wrong in, and job scheduling keeps them apart anyway.
 */
import { DomainError } from '@am/domain';

let importDepth = 0;

export function isImportModeActive(): boolean {
  return importDepth > 0;
}

export function beginImportMode(): void {
  importDepth += 1;
}

export function endImportMode(): void {
  importDepth = Math.max(0, importDepth - 1);
}

/** Test seam — never called by product code. */
export function resetImportMode(): void {
  importDepth = 0;
}

/**
 * Runs `fn` with outbound dispatch suppressed. Always restores the previous
 * depth, including on a thrown error.
 */
export async function runInImportMode<T>(fn: () => Promise<T>): Promise<T> {
  beginImportMode();
  try {
    return await fn();
  } finally {
    endImportMode();
  }
}

/**
 * Called by every outbound path (CAPI dispatch, command execution) before it
 * touches the network.
 */
export function assertOutboundAllowed(operation: string): void {
  if (!isImportModeActive()) return;
  throw new DomainError('FORBIDDEN', {
    messageDe:
      'Während eines historischen Imports werden keine Ereignisse an Meta oder das CRM gesendet.',
    retryable: false,
    details: { operation, reason: 'IMPORT_MODE_ACTIVE' },
  });
}
