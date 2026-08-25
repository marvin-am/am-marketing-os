'use client';

import { useEffect } from 'react';
import { ErrorState } from '@am/ui';

/**
 * Route-level error boundary. A failed load of one tab never blanks the whole
 * Campaign Room, and it never shows a stack trace (AGENTS.md rule 8).
 */
export default function CampaignRoomError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('campaign_room_error', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <ErrorState
      title="Dieser Bereich der Kampagne konnte nicht geladen werden."
      description="Der Fehler wurde protokolliert. Versuchen Sie es erneut — bleibt das Problem bestehen, prüfen Sie unter Integrationen den Status von Meta und HubSpot."
      detail={error.digest ? `Referenz: ${error.digest}` : null}
      onRetry={reset}
    />
  );
}
