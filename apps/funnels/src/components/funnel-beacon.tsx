'use client';

import { useEffect, useRef } from 'react';
import type { TrackerContext } from '@am/tracking/beacon';
import { useTracker } from '@/lib/use-tracker';

/**
 * The entry beacon for pages that carry no form.
 *
 * A landing page has no interactive runtime, so this is the only client
 * component it ships: a few hundred bytes that emit `funnel_viewed` and, when
 * the visitor was bucketed into an experiment arm, exactly one
 * `experiment_exposed`.
 *
 * The exposure fires **here**, on a render that actually happened — never at
 * assignment time on the server. A visitor bucketed into an arm they never saw
 * (a redirect, a bounce before paint, a prefetch) would otherwise dilute that
 * arm's conversion rate with impressions that did not exist, which is the
 * classic way an A/B test reports a loser as a winner. The collector applies
 * `shouldRecordExposure` on top, so a remount cannot produce a second one.
 */

export interface FunnelBeaconProps {
  collectEndpoint: string;
  trackerContext: TrackerContext;
  experiment: { experimentId: string; armId: string } | null;
}

export function FunnelBeacon({ collectEndpoint, trackerContext, experiment }: FunnelBeaconProps) {
  const tracker = useTracker(collectEndpoint, trackerContext);
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;
    tracker.funnelViewed();
    if (experiment) {
      tracker.experimentExposed({
        experiment_id: experiment.experimentId,
        experiment_arm_id: experiment.armId,
      });
    }
  }, [tracker, experiment]);

  return null;
}
