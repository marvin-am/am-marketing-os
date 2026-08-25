import { assignArm } from '@am/tracking';
import type { FunnelExperimentRecord } from './ports';

/**
 * Server-side arm assignment.
 *
 * `assignArm` is a pure function of the visitor id and the experiment's salt, so
 * the same visitor lands on the same arm across reloads, return visits and
 * server restarts, with no write before the decision and no flash of the wrong
 * variant. A client-side coin flip would fail all three.
 *
 * Assignment is *not* an exposure. Nothing is recorded here — the
 * `experiment_exposed` event is emitted by the client once the assigned variant
 * has actually rendered, and the collector applies `shouldRecordExposure` on top
 * of that. A visitor bucketed into an arm they never saw would otherwise dilute
 * that arm's conversion rate with impressions that never happened.
 */

export interface ArmAssignment {
  experimentId: string;
  armId: string;
  /** The bucket in [0,1) that produced this arm. Kept for audits. */
  bucket: number;
  /** The funnel version this arm serves. */
  funnelVersionId: string;
}

/** Only a RUNNING experiment routes traffic. */
export const ASSIGNING_STATES = ['RUNNING'] as const;

export function assignFunnelArm(
  experiment: FunnelExperimentRecord | null,
  visitorId: string,
): ArmAssignment | null {
  if (!experiment) return null;
  if (!ASSIGNING_STATES.includes(experiment.state as (typeof ASSIGNING_STATES)[number])) {
    return null;
  }
  if (experiment.arms.length === 0) return null;

  const result = assignArm({
    visitorId,
    experimentId: experiment.experimentId,
    salt: experiment.assignmentSalt,
    arms: experiment.arms.map((arm) => ({ id: arm.armId, allocation: arm.allocation })),
  });

  const arm = experiment.arms.find((candidate) => candidate.armId === result.armId);
  if (!arm) return null;

  return {
    experimentId: experiment.experimentId,
    armId: arm.armId,
    bucket: result.bucket,
    funnelVersionId: arm.funnelVersionId,
  };
}
