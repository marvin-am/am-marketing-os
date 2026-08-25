'use client';

import { useEffect } from 'react';
import { ErrorState } from '@am/ui';

/**
 * Route-level error boundary for Integrationen. The operator always gets a
 * German sentence and a retry — never a blank page and never a stack trace
 * (AGENTS.md rule 8).
 */
export default function IntegrationenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('integrations_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <ErrorState
      title="Der Integrationsstatus konnte nicht ermittelt werden."
      description="Der Fehler wurde protokolliert. Ein fehlgeschlagener Statusabruf bedeutet nicht, dass eine Verbindung unterbrochen ist — bitte erneut prüfen."
      detail={error.digest ? `Referenz: ${error.digest}` : null}
      onRetry={reset}
    />
  );
}
