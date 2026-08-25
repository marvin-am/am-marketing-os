'use client';

import { useEffect } from 'react';
import { ErrorState } from '@am/ui';

/**
 * Global error boundary. There is deliberately no path that renders a blank
 * page or a raw stack trace: the operator always gets a German sentence and a
 * way forward (spec §33).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The detail belongs in the log drain, not on the screen.
    console.error('console_render_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <ErrorState
        title="Diese Ansicht konnte nicht geladen werden."
        description="Der Fehler wurde protokolliert. Bitte versuchen Sie es erneut — bleibt das Problem bestehen, prüfen Sie unter Integrationen den Status der Provider."
        retryLabel="Erneut versuchen"
        onRetry={reset}
        detail={error.digest ? `Referenz: ${error.digest}` : undefined}
      />
    </div>
  );
}
