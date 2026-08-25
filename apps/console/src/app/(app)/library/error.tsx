'use client';

import { useEffect } from 'react';
import { ErrorState } from '@am/ui';

/**
 * Route-level error boundary for Library. The operator always gets a
 * German sentence and a retry — never a blank page and never a stack trace
 * (AGENTS.md rule 8).
 */
export default function LibraryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('library_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <ErrorState
      title="Die Library konnte nicht geladen werden."
      description="Der Fehler wurde protokolliert. Versuchen Sie es erneut — bestehende Creatives, Angles und Belege sind davon nicht betroffen."
      detail={error.digest ? `Referenz: ${error.digest}` : null}
      onRetry={reset}
    />
  );
}
