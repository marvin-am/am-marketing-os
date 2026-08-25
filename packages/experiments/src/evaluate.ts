import {
  type ArmObservation,
  type ArmResult,
  type DataMaturity,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  type Experiment,
  type ExperimentResult,
  type ExperimentThresholds,
  type ExperimentVerdict,
  type IsoTimestamp,
  METRIC_CATALOG,
  type MetricKey,
  rate,
} from '@am/domain';
import {
  type BetaPrior,
  comparePosteriors,
  betaPosterior,
  credibleInterval,
  DEFAULT_BETA_PRIOR,
  posteriorMean,
  relativeLift,
} from './stats/beta-binomial';
import { assessMaturity, isMatureForDecision, MILLISECONDS_PER_DAY, type MaturityAssessment } from './maturity';

/**
 * Experiment evaluation — the single place a verdict is produced.
 *
 * The order of operations is deliberate and is the whole point of the module:
 *
 *   1. **Volume gates first.** Below the configured runtime, sessions or
 *      conversions the verdict is `INSUFFICIENT_DATA` and `winning_arm_id` stays
 *      null. No statistic is quoted as a finding, because none of them mean
 *      anything yet.
 *   2. **Statistics second.** P(best) and relative lift against the control.
 *   3. **Maturity last, and it can only ever downgrade.** The identical
 *      statistical picture yields `WINNER` on a matured CRM cohort and
 *      `PROVISIONAL` on an immature one. A verdict is never upgraded by waiting
 *      less.
 *
 * Interpretation warnings are emitted separately from the verdict: a bundled
 * test can produce a perfectly clean statistical winner and still be unable to
 * say *what* won, and the console has to show both facts at once.
 */

/* -------------------------------------------------------------------------- */
/* Reason and warning codes                                                    */
/* -------------------------------------------------------------------------- */

export const EXPERIMENT_REASON_CODES = [
  'NOT_STARTED',
  'NO_ARMS',
  'NO_CONTROL_ARM',
  'MIN_RUNTIME_NOT_REACHED',
  'MIN_RUNTIME_REACHED',
  'MAX_RUNTIME_REACHED',
  'MIN_SESSIONS_NOT_REACHED',
  'MIN_CONVERSIONS_NOT_REACHED',
  'DENOMINATOR_EXPOSURES',
  'DENOMINATOR_SESSIONS',
  'WIN_PROBABILITY_MET',
  'WIN_PROBABILITY_BELOW_THRESHOLD',
  'RELATIVE_LIFT_MET',
  'RELATIVE_LIFT_BELOW_THRESHOLD',
  'CRM_DATA_MATURE',
  'CRM_DATA_PARTIAL',
  'CRM_DATA_IMMATURE',
  'CONTROL_REMAINS_BEST',
] as const;
export type ExperimentReasonCode = (typeof EXPERIMENT_REASON_CODES)[number];

export const EXPERIMENT_WARNING_CODES = [
  /** Creative and funnel vary together — no single cause can be isolated. */
  'BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED',
  /** Qualification logic differs between arms — the populations differ. */
  'ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST',
  /** Meta chose the split; this is exploration, not a randomised A/B test. */
  'META_OPTIMISED_DELIVERY_NOT_RANDOMISED',
  'CONVERSIONS_EXCEED_DENOMINATOR',
  'LOW_ATTRIBUTION_COVERAGE',
  'CRM_PRIMARY_METRIC_WITH_IMMATURE_DATA',
  'REVENUE_METRIC_NEEDS_SEPARATE_EVALUATION',
  'PRIMARY_METRIC_NOT_A_CONVERSION_RATE',
  'WIN_PROBABILITY_WITHIN_NUMERICAL_TOLERANCE',
  'UNEQUAL_TRAFFIC_SPLIT',
] as const;
export type ExperimentWarningCode = (typeof EXPERIMENT_WARNING_CODES)[number];

/** Guardrail breaches are per metric, so their code carries the metric key. */
export function guardrailWarningCode(metric: MetricKey): string {
  return `GUARDRAIL_BREACH:${metric}`;
}

export const EXPERIMENT_REASON_LABELS_DE: Readonly<Record<ExperimentReasonCode, string>> = {
  NOT_STARTED: 'Das Experiment wurde noch nicht gestartet.',
  NO_ARMS: 'Es liegen keine Arm-Beobachtungen vor.',
  NO_CONTROL_ARM: 'Es ist kein Kontrollarm definiert — ein relativer Uplift ist nicht berechenbar.',
  MIN_RUNTIME_NOT_REACHED: 'Die Mindestlaufzeit ist noch nicht erreicht.',
  MIN_RUNTIME_REACHED: 'Die Mindestlaufzeit ist erreicht.',
  MAX_RUNTIME_REACHED: 'Die maximale Laufzeit ist erreicht.',
  MIN_SESSIONS_NOT_REACHED: 'Mindestens ein Arm liegt unter der Mindestanzahl an Sessions.',
  MIN_CONVERSIONS_NOT_REACHED: 'Mindestens ein Arm liegt unter der Mindestanzahl an Conversions.',
  DENOMINATOR_EXPOSURES: 'Bezugsgröße der Conversion-Rate: tatsächliche Ausspielungen (Exposures).',
  DENOMINATOR_SESSIONS: 'Bezugsgröße der Conversion-Rate: Sessions.',
  WIN_PROBABILITY_MET: 'Die geforderte Gewinnwahrscheinlichkeit ist erreicht.',
  WIN_PROBABILITY_BELOW_THRESHOLD: 'Die Gewinnwahrscheinlichkeit liegt unter dem Schwellenwert.',
  RELATIVE_LIFT_MET: 'Der relative Uplift überschreitet die Relevanzschwelle.',
  RELATIVE_LIFT_BELOW_THRESHOLD:
    'Der Unterschied ist statistisch belegt, aber praktisch nicht relevant.',
  CRM_DATA_MATURE: 'Die CRM-Daten der Kohorte sind ausgereift.',
  CRM_DATA_PARTIAL: 'Die CRM-Daten der Kohorte sind erst teilweise ausgereift.',
  CRM_DATA_IMMATURE: 'Die CRM-Daten der Kohorte sind noch unreif.',
  CONTROL_REMAINS_BEST: 'Keine Variante schlägt die Kontrolle — die Kontrolle bleibt bestehen.',
};

export const EXPERIMENT_WARNING_LABELS_DE: Readonly<Record<ExperimentWarningCode, string>> = {
  BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED:
    'Gebündelter Test: Creative und Funnel variieren gleichzeitig. Creative- und Funnel-Effekte lassen sich nicht voneinander trennen — das Ergebnis gilt für die Kombination, nicht für eine einzelne Komponente.',
  ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST:
    'Die Qualifizierungslogik unterscheidet sich zwischen den Armen. Die Arme messen unterschiedliche Grundgesamtheiten; die Ergebnisse sind nicht als reiner Conversion-Test vergleichbar.',
  META_OPTIMISED_DELIVERY_NOT_RANDOMISED:
    'Die Auslieferung wurde von Meta optimiert. CREATIVE_EXPLORATION ist damit kein randomisierter A/B-Test — Unterschiede können auf der Auslieferung statt auf dem Creative beruhen.',
  CONVERSIONS_EXCEED_DENOMINATOR:
    'Mindestens ein Arm weist mehr Conversions als Bezugsereignisse aus. Die Rohdaten sind inkonsistent und wurden für die Berechnung begrenzt.',
  LOW_ATTRIBUTION_COVERAGE:
    'Die Attributionsabdeckung ist niedrig. Ein Teil der CRM-Ergebnisse ist der Kampagne nur unsicher zugeordnet.',
  CRM_PRIMARY_METRIC_WITH_IMMATURE_DATA:
    'Die Primärmetrik hängt an CRM-Ergebnissen, die noch nicht vollständig eingetroffen sind.',
  REVENUE_METRIC_NEEDS_SEPARATE_EVALUATION:
    'Umsatzmetriken werden nicht über das Conversion-Modell entschieden. Umsatz ist gesondert und konservativer zu bewerten (siehe Umsatzauswertung).',
  PRIMARY_METRIC_NOT_A_CONVERSION_RATE:
    'Die Primärmetrik ist keine binäre Conversion-Rate. Das Urteil basiert ersatzweise auf der Conversion-Rate des Experiments.',
  WIN_PROBABILITY_WITHIN_NUMERICAL_TOLERANCE:
    'Die Gewinnwahrscheinlichkeit liegt innerhalb der numerischen Toleranz des Schätzverfahrens — zu knapp für eine Entscheidung.',
  UNEQUAL_TRAFFIC_SPLIT:
    'Die Arme haben deutlich unterschiedlich viel Traffic erhalten. Die Auslieferung war nicht gleichverteilt.',
};

/* -------------------------------------------------------------------------- */
/* Guardrails                                                                  */
/* -------------------------------------------------------------------------- */

export interface GuardrailReading {
  metric: MetricKey;
  /** Null for a campaign-wide guardrail. */
  arm_id?: string | null;
  value: number | null;
  /** The configured limit. Interpreted through the metric's direction. */
  limit: number;
  label?: string;
}

/**
 * A guardrail is breached when the metric moved in its bad direction past the
 * limit. The direction comes from `METRIC_CATALOG`, never from the caller, so a
 * guardrail can never be configured "backwards".
 */
export function isGuardrailBreached(metric: MetricKey, value: number | null, limit: number): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  return METRIC_CATALOG[metric].direction === 'LOWER_IS_BETTER' ? value > limit : value < limit;
}

export interface GuardrailBreach {
  metric: MetricKey;
  arm_id: string | null;
  value: number;
  limit: number;
  direction: 'LOWER_IS_BETTER' | 'HIGHER_IS_BETTER';
  messageDe: string;
}

export function evaluateGuardrails(readings: readonly GuardrailReading[]): GuardrailBreach[] {
  const breaches: GuardrailBreach[] = [];
  for (const reading of readings) {
    if (!isGuardrailBreached(reading.metric, reading.value, reading.limit)) continue;
    const definition = METRIC_CATALOG[reading.metric];
    breaches.push({
      metric: reading.metric,
      arm_id: reading.arm_id ?? null,
      value: reading.value as number,
      limit: reading.limit,
      direction: definition.direction,
      messageDe:
        definition.direction === 'LOWER_IS_BETTER'
          ? `Guardrail verletzt: ${definition.label} liegt bei ${reading.value} und damit über dem Limit von ${reading.limit}.`
          : `Guardrail verletzt: ${definition.label} liegt bei ${reading.value} und damit unter dem Limit von ${reading.limit}.`,
    });
  }
  // Deterministic order regardless of the caller's reading order.
  return breaches.sort(
    (a, b) => a.metric.localeCompare(b.metric) || (a.arm_id ?? '').localeCompare(b.arm_id ?? ''),
  );
}

/* -------------------------------------------------------------------------- */
/* Primary metric → success/trial resolution                                   */
/* -------------------------------------------------------------------------- */

/** Catalogue metrics that are genuine binary rates and can be evaluated here. */
export const BINARY_RATE_METRICS: readonly MetricKey[] = [
  'ctr',
  'form_start_rate',
  'step_dropoff',
  'submission_rate',
  'vq_scheduled_rate',
  'show_rate',
  'qualified_vq_rate',
  'opportunity_rate',
  'close_rate',
];

/** Metrics that must not be decided by the Beta-Binomial model at all. */
export const REVENUE_METRICS: readonly MetricKey[] = ['revenue', 'roas', 'cac'];

interface ResolvedTrial {
  successes: number;
  trials: number;
  /** True when the denominator came from the arm's traffic, not a CRM stage. */
  usesTrafficDenominator: boolean;
}

/**
 * Map the primary metric onto the (successes, trials) pair its rate is built
 * from — e.g. a `show_rate` experiment is decided on attended / scheduled, not
 * on submissions. Anything without a natural CRM pair falls back to the
 * experiment's own conversion count.
 */
function resolveTrial(
  observation: ArmObservation,
  metric: MetricKey,
  trafficDenominator: number,
): ResolvedTrial {
  switch (metric) {
    case 'vq_scheduled_rate':
      return { successes: observation.vq_scheduled, trials: observation.conversions, usesTrafficDenominator: false };
    case 'show_rate':
      return { successes: observation.vq_attended, trials: observation.vq_scheduled, usesTrafficDenominator: false };
    case 'qualified_vq_rate':
      return { successes: observation.qualified_vq, trials: observation.vq_attended, usesTrafficDenominator: false };
    case 'opportunity_rate':
      return { successes: observation.opportunities, trials: observation.conversions, usesTrafficDenominator: false };
    case 'close_rate':
      return { successes: observation.closed_won, trials: observation.opportunities, usesTrafficDenominator: false };
    default:
      return { successes: observation.conversions, trials: trafficDenominator, usesTrafficDenominator: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Input / output                                                              */
/* -------------------------------------------------------------------------- */

export interface EvaluateExperimentInput {
  experiment: Experiment;
  observations: readonly ArmObservation[];
  /** Overrides `experiment.thresholds`; falls back to the domain defaults. */
  thresholds?: ExperimentThresholds;
  now: IsoTimestamp;
  prior?: BetaPrior;
  /** Defaults to `experiment.started_at`. */
  cohortStartedAt?: IsoTimestamp;
  /** Typical conversion → CRM-outcome lag, if longer than the maturity window. */
  expectedLagDays?: number;
  guardrails?: readonly GuardrailReading[];
  /**
   * True when Meta, not the product, decided how traffic was split. Always true
   * in effect for CREATIVE_EXPLORATION, which is why that kind sets it itself.
   */
  metaOptimisedDelivery?: boolean;
  /** Coverage below this fraction raises `LOW_ATTRIBUTION_COVERAGE`. */
  minAttributionCoverage?: number;
  /** Traffic imbalance above this share raises `UNEQUAL_TRAFFIC_SPLIT`. */
  maxTrafficImbalance?: number;
}

export interface ExperimentEvaluation {
  result: ExperimentResult;
  maturity: MaturityAssessment;
  guardrailBreaches: GuardrailBreach[];
  /** Numerical error bound of the win probabilities in this evaluation. */
  probabilityErrorBound: number;
  /** Arm that leads on P(best); null when there is nothing to compare. */
  leadingArmId: string | null;
  /** Expected loss of committing to each arm, keyed by arm id. */
  expectedLossByArm: Record<string, number>;
}

export const DEFAULT_MIN_ATTRIBUTION_COVERAGE = 0.7;
export const DEFAULT_MAX_TRAFFIC_IMBALANCE = 0.35;

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate an experiment into an `ExperimentResult`.
 *
 * Deterministic: the observation order is normalised (control first, then arm
 * key), the statistics are deterministic by construction, and no clock is read —
 * `now` is an input.
 */
export function evaluateExperiment(input: EvaluateExperimentInput): ExperimentEvaluation {
  const thresholds = input.thresholds ?? input.experiment.thresholds ?? DEFAULT_EXPERIMENT_THRESHOLDS;
  const prior = input.prior ?? DEFAULT_BETA_PRIOR;
  const primaryMetric = input.experiment.primary_metric;

  const reasons: string[] = [];
  const warnings: string[] = [];

  // Canonical arm order: control first, then arm key. Keeps the output stable
  // no matter how the caller assembled its rows.
  const observations = [...input.observations].sort(
    (a, b) => Number(b.is_control) - Number(a.is_control) || a.arm_key.localeCompare(b.arm_key),
  );

  const runtimeDays = input.experiment.started_at
    ? Math.max(0, (Date.parse(input.now) - Date.parse(input.experiment.started_at)) / MILLISECONDS_PER_DAY)
    : 0;

  const totalSessions = observations.reduce((sum, o) => sum + o.sessions, 0);
  const totalConversions = observations.reduce((sum, o) => sum + o.conversions, 0);

  /* ---- Maturity ---------------------------------------------------------- */

  const observedOutcomes = observations.reduce(
    (sum, o) => sum + o.qualified_vq + o.opportunities + o.closed_won,
    0,
  );
  const maturity = assessMaturity({
    cohortStartedAt: input.cohortStartedAt ?? input.experiment.started_at ?? input.now,
    now: input.now,
    crmMaturityDays: thresholds.crmMaturityDays,
    observedOutcomes,
    expectedLagDays: input.expectedLagDays,
  });

  /* ---- Design-level interpretation warnings ------------------------------ */

  if (input.experiment.bundled || input.experiment.kind === 'BUNDLED_FUNNEL_TEST') {
    warnings.push('BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED');
  }
  if (input.experiment.eligibility_changing) {
    warnings.push('ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST');
  }
  if (input.metaOptimisedDelivery || input.experiment.kind === 'CREATIVE_EXPLORATION') {
    warnings.push('META_OPTIMISED_DELIVERY_NOT_RANDOMISED');
  }
  if (REVENUE_METRICS.includes(primaryMetric)) {
    warnings.push('REVENUE_METRIC_NEEDS_SEPARATE_EVALUATION');
  } else if (!BINARY_RATE_METRICS.includes(primaryMetric)) {
    warnings.push('PRIMARY_METRIC_NOT_A_CONVERSION_RATE');
  }
  if (METRIC_CATALOG[primaryMetric].latency === 'CRM_DELAYED' && !isMatureForDecision(maturity.maturity)) {
    warnings.push('CRM_PRIMARY_METRIC_WITH_IMMATURE_DATA');
  }

  const coverages = observations
    .map((o) => o.attribution_coverage)
    .filter((c): c is number => c !== null && c !== undefined);
  const attributionCoverage =
    coverages.length > 0 ? coverages.reduce((s, c) => s + c, 0) / coverages.length : null;
  const minCoverage = input.minAttributionCoverage ?? DEFAULT_MIN_ATTRIBUTION_COVERAGE;
  if (attributionCoverage !== null && attributionCoverage < minCoverage) {
    warnings.push('LOW_ATTRIBUTION_COVERAGE');
  }

  const guardrailBreaches = evaluateGuardrails(input.guardrails ?? []);
  for (const breach of guardrailBreaches) {
    warnings.push(guardrailWarningCode(breach.metric));
  }

  /* ---- No arms ----------------------------------------------------------- */

  if (observations.length === 0) {
    reasons.push('NO_ARMS');
    return {
      result: buildResult({
        input,
        thresholds,
        arms: [],
        verdict: 'INSUFFICIENT_DATA',
        winningArmId: null,
        maturity: maturity.maturity,
        reasons,
        warnings,
        runtimeDays,
        totalSessions,
        totalConversions,
      }),
      maturity,
      guardrailBreaches,
      probabilityErrorBound: 0,
      leadingArmId: null,
      expectedLossByArm: {},
    };
  }

  /* ---- Denominator choice ------------------------------------------------ */

  const allHaveExposures = observations.every((o) => o.exposures > 0);
  const trafficDenominators = observations.map((o) => (allHaveExposures ? o.exposures : o.sessions));

  const resolved = observations.map((o, index) => {
    const trial = resolveTrial(o, primaryMetric, trafficDenominators[index]);
    if (trial.successes > trial.trials && !warnings.includes('CONVERSIONS_EXCEED_DENOMINATOR')) {
      warnings.push('CONVERSIONS_EXCEED_DENOMINATOR');
    }
    return trial;
  });

  if (resolved.some((r) => r.usesTrafficDenominator)) {
    reasons.push(allHaveExposures ? 'DENOMINATOR_EXPOSURES' : 'DENOMINATOR_SESSIONS');
  }

  const maxSessions = Math.max(...observations.map((o) => o.sessions));
  const minSessions = Math.min(...observations.map((o) => o.sessions));
  const imbalance = maxSessions > 0 ? (maxSessions - minSessions) / maxSessions : 0;
  if (observations.length > 1 && imbalance > (input.maxTrafficImbalance ?? DEFAULT_MAX_TRAFFIC_IMBALANCE)) {
    warnings.push('UNEQUAL_TRAFFIC_SPLIT');
  }

  /* ---- Posteriors -------------------------------------------------------- */

  const posteriors = resolved.map((r) => betaPosterior({ successes: r.successes, trials: r.trials }, prior));
  const comparison = comparePosteriors(posteriors);

  const controlIndex = observations.findIndex((o) => o.is_control);
  const controlPosterior = controlIndex >= 0 ? posteriors[controlIndex] : null;
  if (controlIndex < 0) reasons.push('NO_CONTROL_ARM');

  const arms: ArmResult[] = observations.map((observation, index) => {
    const trial = resolved[index];
    const posterior = posteriors[index];
    const [lower, upper] = credibleInterval(posterior.alpha, posterior.beta, 0.95);
    return {
      arm_id: observation.arm_id,
      arm_key: observation.arm_key,
      label: observation.label,
      is_control: observation.is_control,
      conversionRate: rate(trial.successes, trial.trials),
      posteriorMean: posteriorMean(posterior),
      credibleInterval: [lower, upper] as [number, number],
      probabilityBest: comparison.probabilityBest[index],
      relativeLiftVsControl:
        controlPosterior === null || observation.is_control
          ? null
          : relativeLift(posterior, controlPosterior),
      meetsMinSessions: observation.sessions >= thresholds.minSessionsPerArm,
      meetsMinConversions: trial.successes >= thresholds.minConversionsPerArm,
    };
  });

  const expectedLossByArm: Record<string, number> = {};
  observations.forEach((observation, index) => {
    expectedLossByArm[observation.arm_id] = comparison.expectedLoss[index];
  });

  /* ---- Gates ------------------------------------------------------------- */

  let insufficient = false;

  if (!input.experiment.started_at) {
    reasons.push('NOT_STARTED');
    insufficient = true;
  }
  if (runtimeDays < thresholds.minRuntimeDays) {
    reasons.push('MIN_RUNTIME_NOT_REACHED');
    insufficient = true;
  } else {
    reasons.push('MIN_RUNTIME_REACHED');
  }
  if (runtimeDays >= thresholds.maxRuntimeDays) {
    reasons.push('MAX_RUNTIME_REACHED');
  }
  if (arms.some((arm) => !arm.meetsMinSessions)) {
    reasons.push('MIN_SESSIONS_NOT_REACHED');
    insufficient = true;
  }
  if (arms.some((arm) => !arm.meetsMinConversions)) {
    reasons.push('MIN_CONVERSIONS_NOT_REACHED');
    insufficient = true;
  }

  reasons.push(
    maturity.maturity === 'MATURE'
      ? 'CRM_DATA_MATURE'
      : maturity.maturity === 'PARTIAL'
        ? 'CRM_DATA_PARTIAL'
        : 'CRM_DATA_IMMATURE',
  );

  if (insufficient) {
    return {
      result: buildResult({
        input,
        thresholds,
        arms,
        verdict: 'INSUFFICIENT_DATA',
        winningArmId: null,
        maturity: maturity.maturity,
        reasons,
        warnings,
        runtimeDays,
        totalSessions,
        totalConversions,
      }),
      maturity,
      guardrailBreaches,
      probabilityErrorBound: comparison.errorBound,
      leadingArmId: null,
      expectedLossByArm,
    };
  }

  /* ---- Leader ------------------------------------------------------------ */

  // Arms are already in canonical order, so a strict `>` breaks ties towards the
  // control and then towards the lower arm key.
  let leaderIndex = 0;
  for (let i = 1; i < arms.length; i++) {
    if (arms[i].probabilityBest > arms[leaderIndex].probabilityBest) leaderIndex = i;
  }
  const leader = arms[leaderIndex];

  const winThreshold = thresholds.minWinProbability;
  // Conservative: a probability inside the estimator's own numerical tolerance
  // is not a decision. With two arms the bound is ~1e-9 and this is a no-op.
  const probabilityMet = leader.probabilityBest >= winThreshold + comparison.errorBound;
  if (
    !probabilityMet &&
    leader.probabilityBest >= winThreshold &&
    leader.probabilityBest < winThreshold + comparison.errorBound
  ) {
    warnings.push('WIN_PROBABILITY_WITHIN_NUMERICAL_TOLERANCE');
  }

  let verdict: ExperimentVerdict;
  let winningArmId: string | null = null;

  if (leader.is_control || controlPosterior === null) {
    if (probabilityMet) {
      reasons.push('WIN_PROBABILITY_MET', 'CONTROL_REMAINS_BEST');
      verdict = 'NO_DIFFERENCE';
    } else {
      reasons.push('WIN_PROBABILITY_BELOW_THRESHOLD');
      verdict = 'INCONCLUSIVE';
    }
  } else {
    const lift = leader.relativeLiftVsControl ?? 0;
    const liftMet = lift >= thresholds.minRelativeLift;

    reasons.push(probabilityMet ? 'WIN_PROBABILITY_MET' : 'WIN_PROBABILITY_BELOW_THRESHOLD');
    reasons.push(liftMet ? 'RELATIVE_LIFT_MET' : 'RELATIVE_LIFT_BELOW_THRESHOLD');

    if (probabilityMet && liftMet) {
      // The only place a WINNER is produced — and only on a matured cohort.
      if (isMatureForDecision(maturity.maturity)) {
        verdict = 'WINNER';
      } else {
        verdict = 'PROVISIONAL';
      }
      winningArmId = leader.arm_id;
    } else if (probabilityMet && !liftMet) {
      verdict = 'NO_DIFFERENCE';
    } else {
      verdict = 'INCONCLUSIVE';
    }
  }

  return {
    result: buildResult({
      input,
      thresholds,
      arms,
      verdict,
      winningArmId,
      maturity: maturity.maturity,
      reasons,
      warnings,
      runtimeDays,
      totalSessions,
      totalConversions,
    }),
    maturity,
    guardrailBreaches,
    probabilityErrorBound: comparison.errorBound,
    leadingArmId: leader.arm_id,
    expectedLossByArm,
  };
}

/* -------------------------------------------------------------------------- */
/* Result assembly                                                             */
/* -------------------------------------------------------------------------- */

interface BuildResultInput {
  input: EvaluateExperimentInput;
  thresholds: ExperimentThresholds;
  arms: ArmResult[];
  verdict: ExperimentVerdict;
  winningArmId: string | null;
  maturity: DataMaturity;
  reasons: string[];
  warnings: string[];
  runtimeDays: number;
  totalSessions: number;
  totalConversions: number;
}

/** De-duplicates while preserving first-seen order — reasons stay stable. */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildResult(args: BuildResultInput): ExperimentResult {
  return {
    experiment_id: args.input.experiment.id,
    computed_at: args.input.now,
    primary_metric: args.input.experiment.primary_metric,
    arms: args.arms,
    verdict: args.verdict,
    winning_arm_id: args.winningArmId,
    maturity: args.maturity,
    reasons: unique(args.reasons),
    runtimeDays: args.runtimeDays,
    totalSessions: args.totalSessions,
    totalConversions: args.totalConversions,
    interpretationWarnings: unique(args.warnings),
    thresholds: args.thresholds,
  };
}

/**
 * Should this experiment be concluded now? Two independent grounds: a decided
 * winner, or the configured maximum runtime. Both are surfaced to the operator
 * as a proposal — nothing concludes itself.
 */
export function shouldConclude(
  result: ExperimentResult,
): { conclude: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.verdict === 'WINNER') reasons.push('WINNER_DECIDED');
  if (result.reasons.includes('MAX_RUNTIME_REACHED')) reasons.push('MAX_RUNTIME_REACHED');
  return { conclude: reasons.length > 0, reasons };
}
