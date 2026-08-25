import {
  type ArmObservation,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  type Experiment,
  type ExperimentKind,
  type ExperimentThresholds,
  experimentResultSchema,
  type MetricKey,
} from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  evaluateExperiment,
  evaluateGuardrails,
  guardrailWarningCode,
  isGuardrailBreached,
  shouldConclude,
  type EvaluateExperimentInput,
  type GuardrailReading,
} from './evaluate';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const EXPERIMENT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
const CONTROL_ARM_ID = '33333333-3333-4333-8333-333333333333';
const VARIANT_ARM_ID = '44444444-4444-4444-8444-444444444444';
const THIRD_ARM_ID = '55555555-5555-4555-8555-555555555555';

const START = '2026-03-01T00:00:00.000Z';

function daysAfterStart(days: number): string {
  return new Date(Date.parse(START) + days * 86_400_000).toISOString();
}

function makeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: EXPERIMENT_ID,
    campaign_id: CAMPAIGN_ID,
    kind: 'FUNNEL_EXPERIMENT' as ExperimentKind,
    state: 'RUNNING',
    name: 'Funnel A/B',
    hypothesis: 'Ein kürzeres Formular erhöht die Submission-Rate.',
    test_variable: 'Formularlänge',
    primary_metric: 'submission_rate' as MetricKey,
    secondary_metrics: [],
    guardrail_metrics: [],
    thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS, maxRuntimeDays: 45 },
    assignment_salt: 'salt-1234',
    bundled: false,
    eligibility_changing: false,
    started_at: START,
    concluded_at: null,
    created_at: START,
    ...overrides,
  };
}

function makeArm(overrides: Partial<ArmObservation> & Pick<ArmObservation, 'arm_id' | 'arm_key'>): ArmObservation {
  return {
    label: overrides.arm_key,
    is_control: false,
    sessions: 1000,
    exposures: 1000,
    conversions: 40,
    spend_minor: 100_000,
    vq_scheduled: 0,
    vq_attended: 0,
    qualified_vq: 0,
    opportunities: 0,
    closed_won: 0,
    revenue_minor: 0,
    attribution_coverage: null,
    ...overrides,
  };
}

/** A clean two-arm winner: 4 % control vs. 8 % variant on 1 000 sessions each. */
function decisiveObservations(): ArmObservation[] {
  return [
    makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 40 }),
    makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 80 }),
  ];
}

function evaluate(overrides: Partial<EvaluateExperimentInput> = {}) {
  return evaluateExperiment({
    experiment: makeExperiment(),
    observations: decisiveObservations(),
    now: daysAfterStart(30),
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Volume gates                                                                */
/* -------------------------------------------------------------------------- */

describe('evaluateExperiment — volume gates', () => {
  it('returns INSUFFICIENT_DATA and names no winner below the minimum runtime', () => {
    const { result } = evaluate({ now: daysAfterStart(3) });
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.winning_arm_id).toBeNull();
    expect(result.reasons).toContain('MIN_RUNTIME_NOT_REACHED');
  });

  it('returns INSUFFICIENT_DATA and names no winner below the minimum sessions per arm', () => {
    const { result } = evaluate({
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 150, exposures: 150, conversions: 40 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', sessions: 150, exposures: 150, conversions: 80 }),
      ],
    });
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.winning_arm_id).toBeNull();
    expect(result.reasons).toContain('MIN_SESSIONS_NOT_REACHED');
  });

  it('returns INSUFFICIENT_DATA and names no winner below the minimum conversions per arm', () => {
    const { result } = evaluate({
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 5 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 19 }),
      ],
    });
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.winning_arm_id).toBeNull();
    expect(result.reasons).toContain('MIN_CONVERSIONS_NOT_REACHED');
  });

  it('returns INSUFFICIENT_DATA for an experiment that never started', () => {
    const { result } = evaluate({ experiment: makeExperiment({ started_at: null }) });
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.reasons).toContain('NOT_STARTED');
    expect(result.runtimeDays).toBe(0);
  });

  it('handles an empty observation set without throwing', () => {
    const { result } = evaluate({ observations: [] });
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.reasons).toContain('NO_ARMS');
    expect(result.arms).toEqual([]);
  });

  it('still reports per-arm statistics while gated', () => {
    const { result } = evaluate({ now: daysAfterStart(3) });
    expect(result.arms).toHaveLength(2);
    expect(result.arms[0].conversionRate).toEqual({ numerator: 40, denominator: 1000, value: 0.04 });
    expect(result.arms[0].meetsMinSessions).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Maturity gate — the central invariant                                       */
/* -------------------------------------------------------------------------- */

describe('evaluateExperiment — maturity gate', () => {
  it('yields WINNER on identical statistics once the CRM cohort is mature', () => {
    const { result, maturity } = evaluate({ now: daysAfterStart(30) });
    expect(maturity.maturity).toBe('MATURE');
    expect(result.verdict).toBe('WINNER');
    expect(result.winning_arm_id).toBe(VARIANT_ARM_ID);
    expect(result.reasons).toContain('CRM_DATA_MATURE');
  });

  it('yields PROVISIONAL on the identical statistics while the CRM cohort is immature', () => {
    const { result, maturity } = evaluate({ now: daysAfterStart(10) });
    expect(maturity.maturity).toBe('IMMATURE');
    expect(result.verdict).toBe('PROVISIONAL');
    expect(result.winning_arm_id).toBe(VARIANT_ARM_ID);
    expect(result.reasons).toContain('CRM_DATA_IMMATURE');
  });

  it('produces the same arm statistics in both cases — only the verdict differs', () => {
    const mature = evaluate({ now: daysAfterStart(30) }).result;
    const immature = evaluate({ now: daysAfterStart(10) }).result;
    expect(immature.arms.map((a) => a.probabilityBest)).toEqual(
      mature.arms.map((a) => a.probabilityBest),
    );
    expect(immature.arms.map((a) => a.relativeLiftVsControl)).toEqual(
      mature.arms.map((a) => a.relativeLiftVsControl),
    );
    expect(mature.verdict).toBe('WINNER');
    expect(immature.verdict).toBe('PROVISIONAL');
  });

  it('never returns WINNER while the cohort is only PARTIAL', () => {
    const { result, maturity } = evaluate({
      now: daysAfterStart(15),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 40, qualified_vq: 2 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 80, qualified_vq: 5 }),
      ],
    });
    expect(maturity.maturity).toBe('PARTIAL');
    expect(result.verdict).toBe('PROVISIONAL');
  });
});

/* -------------------------------------------------------------------------- */
/* Statistical thresholds                                                      */
/* -------------------------------------------------------------------------- */

describe('evaluateExperiment — statistical thresholds', () => {
  it('requires both the win probability and the relative lift for a WINNER', () => {
    const { result } = evaluate({ now: daysAfterStart(30) });
    expect(result.reasons).toContain('WIN_PROBABILITY_MET');
    expect(result.reasons).toContain('RELATIVE_LIFT_MET');
  });

  it('returns NO_DIFFERENCE when the difference is significant but not practically relevant', () => {
    // 5 000 sessions per arm, 500 vs. 520 conversions: separated but ~4 % lift.
    const { result } = evaluate({
      now: daysAfterStart(30),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 40000, exposures: 40000, conversions: 4000 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', sessions: 40000, exposures: 40000, conversions: 4200 }),
      ],
    });
    expect(result.reasons).toContain('WIN_PROBABILITY_MET');
    expect(result.reasons).toContain('RELATIVE_LIFT_BELOW_THRESHOLD');
    expect(result.verdict).toBe('NO_DIFFERENCE');
    expect(result.winning_arm_id).toBeNull();
  });

  it('returns INCONCLUSIVE when the win probability is not reached', () => {
    const { result } = evaluate({
      now: daysAfterStart(30),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 40 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 47 }),
      ],
    });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reasons).toContain('WIN_PROBABILITY_BELOW_THRESHOLD');
    expect(result.winning_arm_id).toBeNull();
  });

  it('returns NO_DIFFERENCE with CONTROL_REMAINS_BEST when the control wins', () => {
    const { result } = evaluate({
      now: daysAfterStart(30),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 80 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 40 }),
      ],
    });
    expect(result.verdict).toBe('NO_DIFFERENCE');
    expect(result.reasons).toContain('CONTROL_REMAINS_BEST');
    expect(result.winning_arm_id).toBeNull();
  });

  it('honours overridden thresholds', () => {
    const strict: ExperimentThresholds = {
      ...DEFAULT_EXPERIMENT_THRESHOLDS,
      maxRuntimeDays: 45,
      minRelativeLift: 2.0,
    };
    const { result } = evaluate({ now: daysAfterStart(30), thresholds: strict });
    expect(result.reasons).toContain('RELATIVE_LIFT_BELOW_THRESHOLD');
    expect(result.verdict).toBe('NO_DIFFERENCE');
    expect(result.thresholds.minRelativeLift).toBe(2.0);
  });

  it('records the credible interval and expected loss for every arm', () => {
    const { result, expectedLossByArm } = evaluate({ now: daysAfterStart(30) });
    for (const arm of result.arms) {
      expect(arm.credibleInterval[0]).toBeLessThan(arm.posteriorMean);
      expect(arm.credibleInterval[1]).toBeGreaterThan(arm.posteriorMean);
      expect(expectedLossByArm[arm.arm_id]).toBeGreaterThanOrEqual(0);
    }
    expect(expectedLossByArm[VARIANT_ARM_ID]).toBeLessThan(expectedLossByArm[CONTROL_ARM_ID]);
  });

  it('evaluates three arms deterministically', () => {
    const observations = [
      makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 40 }),
      makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 80 }),
      makeArm({ arm_id: THIRD_ARM_ID, arm_key: 'variant_b', conversions: 55 }),
    ];
    const first = evaluate({ now: daysAfterStart(30), observations }).result;
    const second = evaluate({ now: daysAfterStart(30), observations }).result;
    expect(second).toEqual(first);
    expect(first.arms.reduce((s, a) => s + a.probabilityBest, 0)).toBeCloseTo(1, 10);
  });
});

/* -------------------------------------------------------------------------- */
/* Interpretation warnings                                                     */
/* -------------------------------------------------------------------------- */

describe('evaluateExperiment — interpretation warnings', () => {
  it('warns that a bundled test cannot separate creative from funnel effects', () => {
    const { result } = evaluate({ experiment: makeExperiment({ bundled: true }) });
    expect(result.interpretationWarnings).toContain('BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED');
  });

  it('warns for the BUNDLED_FUNNEL_TEST kind even without the flag', () => {
    const { result } = evaluate({ experiment: makeExperiment({ kind: 'BUNDLED_FUNNEL_TEST' }) });
    expect(result.interpretationWarnings).toContain('BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED');
  });

  it('warns that an eligibility-changing test is not a pure conversion test', () => {
    const { result } = evaluate({ experiment: makeExperiment({ eligibility_changing: true }) });
    expect(result.interpretationWarnings).toContain('ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST');
  });

  it('warns that CREATIVE_EXPLORATION is not a randomised A/B test', () => {
    const { result } = evaluate({ experiment: makeExperiment({ kind: 'CREATIVE_EXPLORATION' }) });
    expect(result.interpretationWarnings).toContain('META_OPTIMISED_DELIVERY_NOT_RANDOMISED');
  });

  it('warns when Meta-optimised delivery is declared explicitly', () => {
    const { result } = evaluate({ metaOptimisedDelivery: true });
    expect(result.interpretationWarnings).toContain('META_OPTIMISED_DELIVERY_NOT_RANDOMISED');
  });

  it('emits no design warnings for a clean randomised funnel test', () => {
    const { result } = evaluate({ now: daysAfterStart(30) });
    expect(result.interpretationWarnings).not.toContain('BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED');
    expect(result.interpretationWarnings).not.toContain('ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST');
    expect(result.interpretationWarnings).not.toContain('META_OPTIMISED_DELIVERY_NOT_RANDOMISED');
  });

  it('warns that a revenue primary metric needs a separate, more conservative evaluation', () => {
    const { result } = evaluate({ experiment: makeExperiment({ primary_metric: 'roas' }) });
    expect(result.interpretationWarnings).toContain('REVENUE_METRIC_NEEDS_SEPARATE_EVALUATION');
  });

  it('warns about low attribution coverage', () => {
    const { result } = evaluate({
      observations: decisiveObservations().map((o) => ({ ...o, attribution_coverage: 0.4 })),
    });
    expect(result.interpretationWarnings).toContain('LOW_ATTRIBUTION_COVERAGE');
  });

  it('warns about an unequal traffic split', () => {
    const { result } = evaluate({
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 3000, exposures: 3000, conversions: 120 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', sessions: 1000, exposures: 1000, conversions: 80 }),
      ],
    });
    expect(result.interpretationWarnings).toContain('UNEQUAL_TRAFFIC_SPLIT');
  });

  it('warns when conversions exceed the denominator instead of producing a broken posterior', () => {
    const { result } = evaluate({
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 1000, exposures: 30, conversions: 40 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 80 }),
      ],
    });
    expect(result.interpretationWarnings).toContain('CONVERSIONS_EXCEED_DENOMINATOR');
    for (const arm of result.arms) {
      expect(Number.isFinite(arm.posteriorMean)).toBe(true);
    }
  });

  it('warns when a CRM-delayed primary metric is judged on immature data', () => {
    const { result } = evaluate({
      experiment: makeExperiment({ primary_metric: 'qualified_vq_rate' }),
      now: daysAfterStart(10),
    });
    expect(result.interpretationWarnings).toContain('CRM_PRIMARY_METRIC_WITH_IMMATURE_DATA');
  });
});

/* -------------------------------------------------------------------------- */
/* Guardrails                                                                  */
/* -------------------------------------------------------------------------- */

describe('guardrails', () => {
  it('reads the breach direction from the metric catalogue', () => {
    // CPL is LOWER_IS_BETTER — above the limit is a breach.
    expect(isGuardrailBreached('cpl', 9_000, 6_000)).toBe(true);
    expect(isGuardrailBreached('cpl', 4_000, 6_000)).toBe(false);
    // Show rate is HIGHER_IS_BETTER — below the limit is a breach.
    expect(isGuardrailBreached('show_rate', 0.3, 0.5)).toBe(true);
    expect(isGuardrailBreached('show_rate', 0.7, 0.5)).toBe(false);
  });

  it('never treats a missing measurement as a breach', () => {
    expect(isGuardrailBreached('cpl', null, 6_000)).toBe(false);
  });

  it('orders breaches deterministically', () => {
    const readings: GuardrailReading[] = [
      { metric: 'show_rate', value: 0.2, limit: 0.5, arm_id: 'b' },
      { metric: 'cpl', value: 9_000, limit: 6_000, arm_id: null },
      { metric: 'show_rate', value: 0.1, limit: 0.5, arm_id: 'a' },
    ];
    const breaches = evaluateGuardrails(readings);
    expect(breaches.map((b) => `${b.metric}:${b.arm_id ?? '-'}`)).toEqual([
      'cpl:-',
      'show_rate:a',
      'show_rate:b',
    ]);
  });

  it('surfaces guardrail breaches as interpretation warnings', () => {
    const { result, guardrailBreaches } = evaluate({
      now: daysAfterStart(30),
      guardrails: [{ metric: 'cpl', value: 9_000, limit: 6_000, arm_id: null }],
    });
    expect(guardrailBreaches).toHaveLength(1);
    expect(result.interpretationWarnings).toContain(guardrailWarningCode('cpl'));
    expect(guardrailBreaches[0].messageDe).toContain('Guardrail verletzt');
  });

  it('does not warn when guardrails hold', () => {
    const { result, guardrailBreaches } = evaluate({
      now: daysAfterStart(30),
      guardrails: [{ metric: 'cpl', value: 4_000, limit: 6_000, arm_id: null }],
    });
    expect(guardrailBreaches).toEqual([]);
    expect(result.interpretationWarnings).not.toContain(guardrailWarningCode('cpl'));
  });
});

/* -------------------------------------------------------------------------- */
/* Contract + determinism                                                      */
/* -------------------------------------------------------------------------- */

describe('evaluateExperiment — contract', () => {
  it('produces a result that satisfies experimentResultSchema', () => {
    const { result } = evaluate({ now: daysAfterStart(30) });
    expect(() => experimentResultSchema.parse(result)).not.toThrow();
  });

  it('is deterministic: same input, identical output', () => {
    const input: Partial<EvaluateExperimentInput> = { now: daysAfterStart(30) };
    expect(evaluate(input).result).toEqual(evaluate(input).result);
  });

  it('is independent of the order the observations arrive in', () => {
    const forward = evaluate({ now: daysAfterStart(30), observations: decisiveObservations() }).result;
    const reversed = evaluate({
      now: daysAfterStart(30),
      observations: [...decisiveObservations()].reverse(),
    }).result;
    expect(reversed).toEqual(forward);
    expect(forward.arms[0].is_control).toBe(true);
  });

  it('reports the runtime, totals and the denominator it used', () => {
    const { result } = evaluate({ now: daysAfterStart(30) });
    expect(result.runtimeDays).toBeCloseTo(30, 6);
    expect(result.totalSessions).toBe(2000);
    expect(result.totalConversions).toBe(120);
    expect(result.reasons).toContain('DENOMINATOR_EXPOSURES');
  });

  it('falls back to sessions when an arm reports no exposures', () => {
    const { result } = evaluate({
      now: daysAfterStart(30),
      observations: decisiveObservations().map((o) => ({ ...o, exposures: 0 })),
    });
    expect(result.reasons).toContain('DENOMINATOR_SESSIONS');
    expect(result.arms[0].conversionRate.denominator).toBe(1000);
  });

  it('resolves CRM-stage primary metrics onto their own numerator and denominator', () => {
    const { result } = evaluate({
      experiment: makeExperiment({ primary_metric: 'show_rate' }),
      now: daysAfterStart(30),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 400, vq_scheduled: 200, vq_attended: 100 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 400, vq_scheduled: 200, vq_attended: 160 }),
      ],
    });
    expect(result.arms[0].conversionRate).toEqual({ numerator: 100, denominator: 200, value: 0.5 });
    expect(result.arms[1].conversionRate).toEqual({ numerator: 160, denominator: 200, value: 0.8 });
  });
});

describe('shouldConclude', () => {
  it('proposes concluding a decided winner', () => {
    const { result } = evaluate({ now: daysAfterStart(30) });
    expect(shouldConclude(result)).toEqual({ conclude: true, reasons: ['WINNER_DECIDED'] });
  });

  it('proposes concluding once the maximum runtime is reached', () => {
    const { result } = evaluate({
      experiment: makeExperiment({ thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS, maxRuntimeDays: 21 } }),
      now: daysAfterStart(25),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 40 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 44 }),
      ],
    });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(shouldConclude(result)).toEqual({ conclude: true, reasons: ['MAX_RUNTIME_REACHED'] });
  });

  it('does not propose concluding a healthy running test', () => {
    const { result } = evaluate({
      now: daysAfterStart(10),
      observations: [
        makeArm({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 40 }),
        makeArm({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 44 }),
      ],
    });
    expect(shouldConclude(result).conclude).toBe(false);
  });
});
