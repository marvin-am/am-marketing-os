'use client';

import { useEffect } from 'react';
import { ErrorState } from '@am/ui';

/**
 * Route-level error boundary for Heute. The operator always gets a
 * German sentence and a retry — never a blank page and never a stack trace
 * (AGENTS.md rule 8).
 */
export default function HeuteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('heute_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <ErrorState
      title="Der Tagesüberblick konnte nicht geladen werden."
      description="Der Fehler wurde protokolliert. Versuchen Sie es erneut — bleibt das Problem bestehen, prüfen Sie unter Integrationen den Status von Meta und HubSpot."
      detail={error.digest ? `Referenz: ${error.digest}` : null}
      onRetry={reset}
    />
  );
}
