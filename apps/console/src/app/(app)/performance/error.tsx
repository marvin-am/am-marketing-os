'use client';

import { useEffect } from 'react';
import { ErrorState, PageHeader } from '@am/ui';

/**
 * Segment error boundary. `retry()` re-fetches the segment's data, which is the
 * right recovery here: these screens fail when a rollup read fails, not when
 * component state is wrong. There is never a blank page (AGENTS.md rule 8).
 */
export default function PerformanceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // The detail belongs in the log drain, not on the screen.
    console.error('performance_render_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Performance" description="Die Auswertung konnte nicht geladen werden." />
      <ErrorState
        title="Die Performance-Daten konnten nicht geladen werden."
        description="Die Rollups für den gewählten Zeitraum waren nicht lesbar. Versuchen Sie es erneut oder wählen Sie einen kürzeren Zeitraum."
        detail={error.digest ? `Referenz: ${error.digest}` : null}
        onRetry={retry}
      />
    </div>
  );
}
