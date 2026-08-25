'use client';

import { useEffect, useRef } from 'react';
import { createTracker, type Tracker, type TrackerContext } from '@am/tracking/beacon';

/**
 * The browser tracker, bound to a component's lifetime.
 *
 * Imported from `@am/tracking/beacon` rather than the package barrel on
 * purpose: the barrel pulls in `node:crypto` through the token and assignment
 * modules, and a signing secret must never be reachable from a client bundle.
 * The beacon module itself has no runtime dependencies at all — no validation
 * library, no framework binding — which is what keeps analytics off the
 * critical path of a mobile ad click.
 *
 * The tracker is created once and torn down on unmount, which flushes whatever
 * is still queued. Page-lifecycle flushes (`visibilitychange`, `pagehide`) are
 * handled inside `createTracker`; `form_abandoned` is deliberately *not* emitted
 * here — it is derived server-side from inactivity, because `beforeunload` does
 * not fire reliably on mobile Safari.
 */
export function useTracker(endpoint: string, context: TrackerContext): Tracker {
  const ref = useRef<Tracker | null>(null);
  if (ref.current === null) {
    ref.current = createTracker({ endpoint, context });
  }

  useEffect(() => {
    const tracker = ref.current;
    return () => {
      tracker?.destroy();
    };
  }, []);

  return ref.current;
}
