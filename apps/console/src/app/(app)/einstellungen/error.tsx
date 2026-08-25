'use client';

import { useEffect } from 'react';
import { ErrorState } from '@am/ui';

/**
 * Route-level error boundary for Einstellungen. The operator always gets a
 * German sentence and a retry — never a blank page and never a stack trace
 * (AGENTS.md rule 8).
 */
export default function EinstellungenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('settings_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <ErrorState
      title="Die Einstellungen konnten nicht geladen werden."
      description="Der Fehler wurde protokolliert. Es wurde nichts geändert; die zuletzt gespeicherten Werte bleiben in Kraft."
      detail={error.digest ? `Referenz: ${error.digest}` : null}
      onRetry={reset}
    />
  );
}
