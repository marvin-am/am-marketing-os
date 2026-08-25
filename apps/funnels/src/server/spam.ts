import type { TrafficKind } from '@am/domain';
import { isBotUserAgent } from '@am/tracking';

/**
 * Bot and spam defence for the submit endpoint.
 *
 * Four independent signals, scored rather than short-circuited, because each on
 * its own has a real false-positive mode: a screen reader can fill a honeypot,
 * a returning visitor with autofill can complete a form in two seconds, a
 * privacy extension can strip `Origin`, and a corporate proxy can mangle a
 * user-agent. A single signal only rejects when it is unambiguous evidence of
 * automation (a filled honeypot, a foreign origin); the rest accumulate.
 *
 * Everything here is pure so the thresholds can be argued about in a test
 * instead of in production.
 */

export type SpamSignal =
  | 'HONEYPOT_FILLED'
  | 'TOO_FAST'
  | 'FOREIGN_ORIGIN'
  | 'BOT_USER_AGENT'
  | 'NON_PRODUCTION_TRAFFIC'
  | 'NO_INTERACTION'
  | 'IMPLAUSIBLE_DURATION';

export interface SpamAssessmentInput {
  /** Value submitted for the spec's honeypot field, if it declares one. */
  honeypotValue?: unknown;
  /** Seconds between the form being opened and the submit. */
  elapsedSeconds: number | null;
  /** `spec.submit.minCompletionSeconds`. */
  minCompletionSeconds: number;
  /** Result of `checkOrigin`. */
  originOk: boolean;
  userAgent?: string | null;
  trafficKind: TrafficKind;
  /** Number of steps the visitor actually walked through. */
  stepsVisited?: number;
}

export interface SpamAssessment {
  /** 0 (clean) … 100 (certain automation). */
  score: number;
  signals: SpamSignal[];
  /** True when the submission must be refused. */
  rejected: boolean;
  /** German copy for the response; never the scoring detail. */
  reasonDe: string | null;
}

/**
 * Weight per signal. The sum decides; `REJECT_AT` is the line.
 *
 * The three that reject on their own are the ones that are not heuristics: a
 * filled honeypot is machine input, a foreign origin has no legitimate reason to
 * reach this endpoint, and `minCompletionSeconds` is a floor the *form author*
 * declared for this specific form. The rest are indicators and only reject in
 * combination, because each has a real false positive — a mislabelled corporate
 * proxy UA is not a reason to throw away a lead.
 */
export const SPAM_WEIGHTS: Readonly<Record<SpamSignal, number>> = {
  HONEYPOT_FILLED: 100,
  FOREIGN_ORIGIN: 100,
  TOO_FAST: 100,
  BOT_USER_AGENT: 50,
  NO_INTERACTION: 40,
  IMPLAUSIBLE_DURATION: 20,
  /* Preview, internal and test traffic is not spam — it is simply excluded from
     production metrics, which happens on the event, not here. */
  NON_PRODUCTION_TRAFFIC: 0,
};

export const SPAM_REJECT_AT = 100;

/** Nobody fills a five-step qualification form in under this many seconds. */
export const IMPLAUSIBLY_FAST_SECONDS = 2;

/** A form open for longer than this was almost certainly left and resumed. */
export const IMPLAUSIBLE_DURATION_SECONDS = 6 * 60 * 60;

export function assessSubmission(input: SpamAssessmentInput): SpamAssessment {
  const signals: SpamSignal[] = [];

  /* A honeypot is hidden from the accessibility tree as well as from sight, so
     a non-empty value is machine input, not a mis-click. */
  if (typeof input.honeypotValue === 'string' && input.honeypotValue.trim().length > 0) {
    signals.push('HONEYPOT_FILLED');
  } else if (input.honeypotValue === true) {
    signals.push('HONEYPOT_FILLED');
  }

  if (!input.originOk) signals.push('FOREIGN_ORIGIN');

  const elapsed = input.elapsedSeconds;
  if (elapsed !== null) {
    const floor = Math.max(input.minCompletionSeconds, IMPLAUSIBLY_FAST_SECONDS);
    if (elapsed < floor) signals.push('TOO_FAST');
    if (elapsed > IMPLAUSIBLE_DURATION_SECONDS) signals.push('IMPLAUSIBLE_DURATION');
  }

  if (isBotUserAgent(input.userAgent)) signals.push('BOT_USER_AGENT');

  if (typeof input.stepsVisited === 'number' && input.stepsVisited <= 0) {
    signals.push('NO_INTERACTION');
  }

  if (input.trafficKind !== 'PRODUCTION') signals.push('NON_PRODUCTION_TRAFFIC');

  const score = Math.min(
    100,
    signals.reduce((total, signal) => total + SPAM_WEIGHTS[signal], 0),
  );

  const rejected = score >= SPAM_REJECT_AT;
  return {
    score,
    signals,
    rejected,
    reasonDe: rejected
      ? 'Ihre Anfrage konnte nicht verarbeitet werden. Bitte laden Sie die Seite neu und versuchen Sie es erneut.'
      : null,
  };
}
