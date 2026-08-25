import { type DataMaturity, type IsoTimestamp } from '@am/domain';

/**
 * Data maturity for a CRM cohort.
 *
 * The single most expensive mistake this product can make is to scale a budget
 * on numbers that have not finished arriving. A cohort acquired eight days ago
 * has produced almost none of its qualified VQs, no opportunities and no
 * revenue; its measured cost-per-qualified-VQ is therefore not "high", it is
 * *unknown*. Every decision surface reads maturity from here, and the winner and
 * scale gates refuse to fire on anything but `MATURE`.
 */

export const MILLISECONDS_PER_DAY = 86_400_000;

export interface MaturityInput {
  /** Start of the cohort — normally the experiment's `started_at`. */
  cohortStartedAt: IsoTimestamp;
  now: IsoTimestamp;
  /** Days a cohort must age before its CRM outcomes count as complete. */
  crmMaturityDays: number;
  /** CRM outcomes observed for this cohort so far (qualified VQs, deals, …). */
  observedOutcomes: number;
  /**
   * Typical lag between conversion and the CRM outcome being measured. When it
   * exceeds `crmMaturityDays` it, not the configured window, sets the bar — a
   * 21-day maturity window is meaningless for an outcome that takes 40 days.
   */
  expectedLagDays?: number;
  /**
   * Share of the window that must have elapsed before a cohort with at least
   * one observed outcome counts as PARTIAL rather than IMMATURE.
   */
  partialThreshold?: number;
}

export interface MaturityAssessment {
  maturity: DataMaturity;
  /** Elapsed share of the maturity window, clamped to [0, 1]. */
  matureFraction: number;
  /** Age of the cohort in days. */
  ageDays: number;
  /** The window actually applied — max(crmMaturityDays, expectedLagDays). */
  windowDays: number;
  observedOutcomes: number;
  /** Earliest instant at which this cohort can be treated as MATURE. */
  earliestMatureAt: IsoTimestamp;
  /** Whole days still to wait. Zero once mature. */
  remainingDays: number;
  /** German explanations, rendered verbatim next to any affected number. */
  reasonsDe: string[];
}

export const DEFAULT_PARTIAL_THRESHOLD = 0.5;

function toEpoch(iso: IsoTimestamp): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

function formatDaysDe(days: number): string {
  const rounded = Math.round(days * 10) / 10;
  return rounded.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

/**
 * Assess how far a cohort has aged towards complete CRM outcomes.
 *
 * - `MATURE`   — the full window has elapsed. The absence of outcomes is now
 *                itself a finding, which is exactly what the "no qualified VQ"
 *                pause rule needs.
 * - `PARTIAL`  — at least half the window has elapsed *and* outcomes are
 *                already arriving. Good enough to look at, never good enough to
 *                scale on.
 * - `IMMATURE` — anything else, including "half the window elapsed but nothing
 *                has arrived yet", where the data is silent rather than negative.
 */
export function assessMaturity(input: MaturityInput): MaturityAssessment {
  const partialThreshold = input.partialThreshold ?? DEFAULT_PARTIAL_THRESHOLD;
  const windowDays = Math.max(0, Math.max(input.crmMaturityDays, input.expectedLagDays ?? 0));

  const startedAt = toEpoch(input.cohortStartedAt);
  const now = toEpoch(input.now);
  const ageDays = Math.max(0, (now - startedAt) / MILLISECONDS_PER_DAY);

  const earliestMatureAt = new Date(startedAt + windowDays * MILLISECONDS_PER_DAY).toISOString();
  const matureFraction = windowDays === 0 ? 1 : Math.min(1, Math.max(0, ageDays / windowDays));
  const remainingDays = Math.max(0, Math.ceil(windowDays - ageDays));
  const observedOutcomes = Math.max(0, input.observedOutcomes);

  const reasonsDe: string[] = [];
  let maturity: DataMaturity;

  if (ageDays >= windowDays) {
    maturity = 'MATURE';
    reasonsDe.push(
      `Kohorte ist ${formatDaysDe(ageDays)} Tage alt und hat das CRM-Reifefenster von ${windowDays} Tagen vollständig durchlaufen.`,
    );
    if (observedOutcomes === 0) {
      reasonsDe.push(
        'Trotz abgeschlossenem Reifefenster wurden keine CRM-Ergebnisse beobachtet — das ist ein belastbares Ergebnis, kein fehlender Datenstand.',
      );
    }
  } else if (observedOutcomes > 0 && matureFraction >= partialThreshold) {
    maturity = 'PARTIAL';
    reasonsDe.push(
      `CRM-Daten sind teilweise reif: ${formatDaysDe(ageDays)} von ${windowDays} Tagen verstrichen (${Math.round(matureFraction * 100)} %).`,
    );
    reasonsDe.push(
      `${observedOutcomes} CRM-Ergebnis(se) liegen vor, weitere sind bis zum ${earliestMatureAt.slice(0, 10)} zu erwarten.`,
    );
  } else {
    maturity = 'IMMATURE';
    reasonsDe.push(
      `CRM-Daten sind unreif: erst ${formatDaysDe(ageDays)} von ${windowDays} Tagen des Reifefensters verstrichen.`,
    );
    if (observedOutcomes === 0) {
      reasonsDe.push(
        'Es liegen noch keine CRM-Ergebnisse vor. Ein Ausbleiben ist zu diesem Zeitpunkt erwartbar und darf nicht als schlechtes Ergebnis gelesen werden.',
      );
    }
    reasonsDe.push(`Frühestens am ${earliestMatureAt.slice(0, 10)} sind belastbare Aussagen möglich.`);
  }

  return {
    maturity,
    matureFraction,
    ageDays,
    windowDays,
    observedOutcomes,
    earliestMatureAt,
    remainingDays,
    reasonsDe,
  };
}

/**
 * The one gate every irreversible or money-spending decision must pass.
 * PARTIAL is explicitly not enough: half-arrived CRM outcomes systematically
 * understate cost per outcome, which biases every scale decision upward.
 */
export function isMatureForDecision(maturity: DataMaturity): boolean {
  return maturity === 'MATURE';
}

export const MATURITY_ORDER: Readonly<Record<DataMaturity, number>> = {
  IMMATURE: 0,
  PARTIAL: 1,
  MATURE: 2,
};

/** The least mature of a set — a rollup is only as mature as its weakest input. */
export function weakestMaturity(values: readonly DataMaturity[]): DataMaturity {
  if (values.length === 0) return 'IMMATURE';
  return values.reduce((weakest, current) =>
    MATURITY_ORDER[current] < MATURITY_ORDER[weakest] ? current : weakest,
  );
}
