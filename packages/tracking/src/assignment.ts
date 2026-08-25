import { createHash } from 'node:crypto';
import { DomainError, type ExperimentState } from '@am/domain';

/**
 * Deterministic variant assignment.
 *
 * Assignment is a pure function of `visitorId` and the experiment's salt. No
 * random number is drawn, nothing is written before the decision, and the same
 * visitor therefore lands on the same arm across reloads, return visits, devices
 * that share the visitor cookie, and server restarts — forever, for a given
 * salt (acceptance criterion 11).
 *
 * This runs server-side. A client-side coin flip would produce a flash of the
 * wrong variant, would be trivially re-rollable by the visitor, and would make
 * the arm depend on whether JavaScript executed at all.
 */

export interface AssignmentArm {
  id: string;
  /** Share of traffic in [0,1]. Weights are normalised, so they need not sum to 1. */
  allocation: number;
}

export interface AssignmentResult {
  armId: string;
  /** The bucket in [0,1) that produced this arm. Persisted for audits. */
  bucket: number;
}

export interface AssignArmInput {
  visitorId: string;
  experimentId: string;
  /**
   * Per-experiment salt (`experiments.assignment_salt`), frozen while the
   * experiment is RUNNING. It — not the experiment id — is what makes buckets
   * independent between experiments, which means re-bucketing is an explicit,
   * auditable act (changing the salt) rather than a side effect of copying an
   * experiment.
   */
  salt: string;
  arms: readonly AssignmentArm[];
}

export const MIN_SALT_LENGTH = 8;

/** 48 bits of the digest is 2.8e14 buckets — far beyond any traffic volume. */
const BUCKET_HEX_DIGITS = 12;
const BUCKET_SPACE = 2 ** 48;

/**
 * Maps `visitorId:salt` onto [0,1) via SHA-256. Cryptographic hashing is used
 * for its uniformity, not its secrecy: a weak hash leaves visible correlation
 * between arms across experiments that share a visitor population.
 */
export function bucketFor(visitorId: string, salt: string): number {
  const digest = createHash('sha256').update(`${visitorId}:${salt}`, 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, BUCKET_HEX_DIGITS), 16) / BUCKET_SPACE;
}

export function assignArm(input: AssignArmInput): AssignmentResult {
  const { visitorId, salt, arms } = input;

  if (typeof visitorId !== 'string' || visitorId.length === 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Für die Varianten-Zuteilung fehlt die Besucher-Kennung.',
    });
  }
  if (typeof salt !== 'string' || salt.length < MIN_SALT_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: `Der Zuteilungs-Salt muss mindestens ${MIN_SALT_LENGTH} Zeichen lang sein.`,
    });
  }
  const eligible = arms.filter((arm) => arm.allocation > 0);
  if (eligible.length === 0) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Das Experiment hat keine Variante mit positiver Zuteilung.',
    });
  }

  const total = eligible.reduce((sum, arm) => sum + arm.allocation, 0);
  const bucket = bucketFor(visitorId, salt);

  let cumulative = 0;
  for (const arm of eligible) {
    cumulative += arm.allocation / total;
    if (bucket < cumulative) return { armId: arm.id, bucket };
  }

  // Floating-point drift can leave the final cumulative fractionally below 1.
  // The last arm with a positive allocation absorbs it, so no bucket is ever
  // unassigned and the drift cannot silently shift traffic to the control.
  return { armId: (eligible[eligible.length - 1] as AssignmentArm).id, bucket };
}

/**
 * Expected share of traffic per arm, for the launch-QA screen. Deliberately not
 * derived from observed exposures — this is the intent, the observation is a
 * separate number and the two being different is exactly what an operator needs
 * to see.
 */
export function allocationShares(arms: readonly AssignmentArm[]): Record<string, number> {
  const eligible = arms.filter((arm) => arm.allocation > 0);
  const total = eligible.reduce((sum, arm) => sum + arm.allocation, 0);
  const shares: Record<string, number> = {};
  for (const arm of arms) {
    shares[arm.id] = total > 0 && arm.allocation > 0 ? arm.allocation / total : 0;
  }
  return shares;
}

/* -------------------------------------------------------------------------- */
/* Allocation changes                                                          */
/* -------------------------------------------------------------------------- */

/** States in which the arm set and its weights may still be edited. */
export const ALLOCATION_MUTABLE_STATES: readonly ExperimentState[] = ['DRAFT', 'READY'];

export type AllocationChangeReason =
  | 'NO_CHANGE'
  | 'ALLOWED'
  | 'EXPERIMENT_LOCKED'
  | 'ARM_SET_CHANGED'
  | 'INVALID_ALLOCATION';

export interface AllocationChangeCheck {
  safe: boolean;
  changed: boolean;
  reason: AllocationChangeReason;
  reasonDe: string;
}

const ALLOCATION_EPSILON = 1e-9;

/**
 * Refuses an allocation change on a live experiment.
 *
 * Re-weighting arms mid-flight silently invalidates the comparison: visitors
 * already bucketed keep their arm, so the new weights apply only to newcomers
 * and the resulting mixture is neither the old design nor the new one. Any
 * statistic computed over the combined period is then meaningless, and there is
 * no way to detect that after the fact. The fix is to conclude the experiment
 * and start a new one, never to edit a running design.
 */
export function isAllocationChangeSafe(
  experimentState: ExperimentState,
  oldArms: readonly AssignmentArm[],
  newArms: readonly AssignmentArm[],
): AllocationChangeCheck {
  const sameArmSet =
    oldArms.length === newArms.length &&
    oldArms.every((arm) => newArms.some((candidate) => candidate.id === arm.id));

  const sameWeights =
    sameArmSet &&
    oldArms.every((arm) => {
      const next = newArms.find((candidate) => candidate.id === arm.id);
      return next !== undefined && Math.abs(next.allocation - arm.allocation) < ALLOCATION_EPSILON;
    });

  if (sameArmSet && sameWeights) {
    return {
      safe: true,
      changed: false,
      reason: 'NO_CHANGE',
      reasonDe: 'Die Zuteilung ist unverändert.',
    };
  }

  if (!ALLOCATION_MUTABLE_STATES.includes(experimentState)) {
    return {
      safe: false,
      changed: true,
      reason: sameArmSet ? 'EXPERIMENT_LOCKED' : 'ARM_SET_CHANGED',
      reasonDe:
        'Die Zuteilung eines laufenden Experiments kann nicht geändert werden. Beenden Sie das Experiment und starten Sie ein neues.',
    };
  }

  const total = newArms.reduce((sum, arm) => sum + arm.allocation, 0);
  if (newArms.length === 0 || total <= 0 || newArms.some((arm) => arm.allocation < 0)) {
    return {
      safe: false,
      changed: true,
      reason: 'INVALID_ALLOCATION',
      reasonDe: 'Die Zuteilung muss mindestens eine Variante mit positivem Anteil enthalten.',
    };
  }

  return {
    safe: true,
    changed: true,
    reason: 'ALLOWED',
    reasonDe: 'Die Zuteilung kann in diesem Zustand geändert werden.',
  };
}
