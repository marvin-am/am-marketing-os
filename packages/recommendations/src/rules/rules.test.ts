import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  recommendationSchema,
  type Recommendation,
} from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  armObservation,
  CONTROL_ARM_ID,
  counters,
  creativeSlice,
  healthyCounters,
  makeContext,
  makeEvaluation,
  makeExperiment,
  makeExperimentEntry,
  maturity,
  NOW,
  VARIANT_ARM_ID,
} from '../context.fixtures';
import { type RecommendationContext, resolveContext } from '../context';
import {
  COLLECT_MORE_DATA,
  CONCLUDE_EXPERIMENT,
  DECREASE_BUDGET_ON_GUARDRAIL_BREACH,
  KEEP_OFFER_CHANGE_MESSAGING,
  NEW_CREATIVE_ITERATION,
  PAUSE_CREATIVE_UNDERPERFORMING,
  PAUSE_FUNNEL_ARM_UNDERPERFORMING,
  PAUSE_NO_LEAD_ABOVE_TARGET_CPL,
  PAUSE_NO_QUALIFIED_VQ,
  RECOMMENDATION_RULES,
  SCALE_BUDGET,
  TEST_NEW_ANGLE,
  type RecommendationRule,
} from './index';

function run(rule: RecommendationRule, overrides: Partial<RecommendationContext> = {}) {
  return rule.evaluate(resolveContext(makeContext(overrides)));
}

/* -------------------------------------------------------------------------- */
/* Shared invariants                                                           */
/* -------------------------------------------------------------------------- */

function assertEvidenceInvariants(recommendation: Recommendation): void {
  // Schema contract.
  expect(() => recommendationSchema.parse(recommendation)).not.toThrow();
  // At least one fact with a real numerator AND denominator.
  expect(
    recommendation.facts.some((f) => f.numerator !== null && f.denominator !== null),
  ).toBe(true);
  // Comparison basis, maturity, uncertainty, risk — all mandatory, all present.
  expect(recommendation.comparisonBasisDe.length).toBeGreaterThan(10);
  expect(recommendation.uncertaintyDe.length).toBeGreaterThan(10);
  expect(['IMMATURE', 'PARTIAL', 'MATURE']).toContain(recommendation.maturity);
  expect(['LOW', 'MEDIUM', 'HIGH']).toContain(recommendation.risk);
  // The proposed action is stated explicitly, in German.
  expect(recommendation.summaryDe).toContain('Vorgeschlagene Aktion');
  // Nothing executes on its own.
  expect(recommendation.state).toBe('OPEN');
  expect(recommendation.execution).toBeNull();
  // The model has not contributed anything at generation time.
  expect(recommendation.explanationDe).toBeNull();
  expect(recommendation.nextHypothesisDe).toBeNull();
}

describe('every rule that fires satisfies the evidence invariants', () => {
  const firing: [string, Recommendation | null][] = [
    [
      'PAUSE_NO_LEAD_ABOVE_TARGET_CPL',
      run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, {
        campaign: { key: 'c', label: 'Kampagne', counters: counters({ spendMinor: 20_000, funnelSessions: 300, impressions: 40_000, linkClicks: 400 }) },
      }),
    ],
    [
      'PAUSE_NO_QUALIFIED_VQ',
      run(PAUSE_NO_QUALIFIED_VQ, {
        campaign: { key: 'c', label: 'Kampagne', counters: healthyCounters({ qualifiedVq: 0, spendMinor: 50_000 }) },
      }),
    ],
    ['SCALE_BUDGET', run(SCALE_BUDGET)],
    [
      'DECREASE_BUDGET_ON_GUARDRAIL_BREACH',
      run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH, {
        guardrails: [{ metric: 'cpl', value: 9_000, limit: 2_000, arm_id: null }],
      }),
    ],
    ['CONCLUDE_EXPERIMENT', run(CONCLUDE_EXPERIMENT, { experiments: [makeExperimentEntry()] })],
    [
      'KEEP_OFFER_CHANGE_MESSAGING',
      run(KEEP_OFFER_CHANGE_MESSAGING, {
        campaign: { key: 'c', label: 'Kampagne', counters: healthyCounters({ leads: 60 }) },
      }),
    ],
    ['COLLECT_MORE_DATA', run(COLLECT_MORE_DATA)],
  ];

  for (const [name, recommendation] of firing) {
    it(`${name} produces a complete proposal`, () => {
      expect(recommendation, `${name} was expected to fire`).not.toBeNull();
      assertEvidenceInvariants(recommendation as Recommendation);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* PAUSE_NO_LEAD_ABOVE_TARGET_CPL                                              */
/* -------------------------------------------------------------------------- */

describe('PAUSE_NO_LEAD_ABOVE_TARGET_CPL', () => {
  const noLeadCampaign = {
    key: 'c',
    label: 'Kampagne',
    counters: counters({ spendMinor: 20_000, funnelSessions: 300, impressions: 40_000, linkClicks: 400 }),
  };

  it('fires when spend passes 1,5 × the target CPL with zero leads', () => {
    const result = run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, { campaign: noLeadCampaign });
    expect(result?.action).toBe('PAUSE_CREATIVE');
    expect(result?.ruleId).toBe('PAUSE_NO_LEAD_ABOVE_TARGET_CPL');
    // Target CPL 20,00 € → threshold 30,00 €; spend is 200,00 €.
    expect(result?.summaryDe).toContain('200,00');
  });

  it('does not fire below the spend threshold', () => {
    expect(
      run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, {
        campaign: { ...noLeadCampaign, counters: counters({ spendMinor: 2_500, funnelSessions: 40 }) },
      }),
    ).toBeNull();
  });

  it('does not fire once a single lead exists', () => {
    expect(
      run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, {
        campaign: { ...noLeadCampaign, counters: counters({ spendMinor: 20_000, leads: 1, funnelSessions: 300 }) },
      }),
    ).toBeNull();
  });

  it('does not fire without a target CPL to compare against', () => {
    expect(
      run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, {
        campaign: noLeadCampaign,
        targets: {
          targetCplMinor: null,
          targetCostPerQualifiedVqMinor: 8_000,
          primaryMetric: 'cost_per_qualified_vq',
          primaryMetricTarget: 8_000,
        },
      }),
    ).toBeNull();
  });

  it('names only the offending creatives when a breakdown exists', () => {
    const result = run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, {
      creatives: [
        { ...creativeSlice('c1', 'Konzept 1', 0.02), counters: counters({ spendMinor: 20_000, impressions: 20_000, linkClicks: 400 }) },
        { ...creativeSlice('c2', 'Konzept 2', 0.02), counters: counters({ spendMinor: 20_000, impressions: 20_000, linkClicks: 400, leads: 12 }) },
      ],
    });
    expect(result?.summaryDe).toContain('Konzept 1');
    expect(result?.summaryDe).not.toContain('Konzept 2');
    expect(result?.affectedMetaObjects.map((o) => o.external_id)).toEqual(['ad-c1']);
  });

  it('reports the undefined CPL as null rather than a number', () => {
    const result = run(PAUSE_NO_LEAD_ABOVE_TARGET_CPL, { campaign: noLeadCampaign });
    const cplFact = result?.facts.find((f) => f.metric === 'cpl');
    expect(cplFact?.numerator).toBe(20_000);
    expect(cplFact?.denominator).toBe(0);
    expect(cplFact?.value).toBeNull();
    expect(cplFact?.comparisonValue).toBe(2_000);
  });
});

/* -------------------------------------------------------------------------- */
/* PAUSE_NO_QUALIFIED_VQ                                                       */
/* -------------------------------------------------------------------------- */

describe('PAUSE_NO_QUALIFIED_VQ', () => {
  const burning = {
    key: 'c',
    label: 'Kampagne',
    counters: healthyCounters({ qualifiedVq: 0, spendMinor: 50_000 }),
  };

  it('fires past the maturity window with no qualified VQ and 2 × the target spend', () => {
    const result = run(PAUSE_NO_QUALIFIED_VQ, { campaign: burning });
    expect(result?.ruleId).toBe('PAUSE_NO_QUALIFIED_VQ');
    expect(result?.summaryDe).toContain('kein einziger qualifizierter VQ');
  });

  it('does not fire while the CRM cohort is immature', () => {
    expect(run(PAUSE_NO_QUALIFIED_VQ, { campaign: burning, maturity: maturity('IMMATURE') })).toBeNull();
  });

  it('does not fire on a partially matured cohort', () => {
    expect(run(PAUSE_NO_QUALIFIED_VQ, { campaign: burning, maturity: maturity('PARTIAL') })).toBeNull();
  });

  it('does not fire once a qualified VQ exists', () => {
    expect(
      run(PAUSE_NO_QUALIFIED_VQ, {
        campaign: { ...burning, counters: healthyCounters({ qualifiedVq: 1, spendMinor: 50_000 }) },
      }),
    ).toBeNull();
  });

  it('does not fire below the spend threshold', () => {
    expect(
      run(PAUSE_NO_QUALIFIED_VQ, {
        campaign: { ...burning, counters: healthyCounters({ qualifiedVq: 0, spendMinor: 15_000 }) },
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* SCALE_BUDGET — the hard invariant                                           */
/* -------------------------------------------------------------------------- */

describe('SCALE_BUDGET', () => {
  it('fires on a healthy, matured campaign and proposes +20 %', () => {
    const result = run(SCALE_BUDGET);
    expect(result?.action).toBe('INCREASE_BUDGET');
    expect(result?.proposedBudgetChangePct).toBeCloseTo(0.2, 10);
    expect(result?.affectedMetaObjects[0].proposedDailyBudgetMinor).toBe(12_000);
    expect(result?.affectedMetaObjects[0].currentDailyBudgetMinor).toBe(10_000);
  });

  it('NEVER fires while CRM outcomes are immature', () => {
    expect(run(SCALE_BUDGET, { maturity: maturity('IMMATURE') })).toBeNull();
  });

  it('NEVER fires while CRM outcomes are only partially matured', () => {
    expect(run(SCALE_BUDGET, { maturity: maturity('PARTIAL') })).toBeNull();
  });

  it('fires on immature data only when the maturity requirement is explicitly disabled', () => {
    const relaxed = run(SCALE_BUDGET, {
      maturity: maturity('IMMATURE'),
      config: {
        noLeadSpendMultiple: 1.5,
        noQualifiedVqSpendMultiple: 2,
        scaleStepPct: 0.2,
        scaleCooldownHours: 24,
        requireMatureCrmForScale: false,
        minLeadsForLeadingSignals: 5,
      },
    });
    expect(relaxed).not.toBeNull();
    expect(relaxed?.maturity).toBe('IMMATURE');
  });

  it('does not fire while a guardrail is breached', () => {
    expect(
      run(SCALE_BUDGET, { guardrails: [{ metric: 'cpl', value: 9_000, limit: 2_000, arm_id: null }] }),
    ).toBeNull();
  });

  it('does not fire below the minimum lead count', () => {
    expect(
      run(SCALE_BUDGET, {
        campaign: { key: 'c', label: 'Kampagne', counters: healthyCounters({ leads: 2 }) },
      }),
    ).toBeNull();
  });

  it('does not fire without a single qualified VQ', () => {
    expect(
      run(SCALE_BUDGET, {
        campaign: { key: 'c', label: 'Kampagne', counters: healthyCounters({ qualifiedVq: 0 }) },
      }),
    ).toBeNull();
  });

  it('does not fire when the target metric is missed', () => {
    expect(
      run(SCALE_BUDGET, {
        targets: {
          targetCplMinor: 2_000,
          targetCostPerQualifiedVqMinor: 1_000,
          primaryMetric: 'cost_per_qualified_vq',
          primaryMetricTarget: 1_000, // actual is 500 000 / 150 ≈ 3 333
        },
      }),
    ).toBeNull();
  });

  it('does not fire without any target to judge against', () => {
    expect(
      run(SCALE_BUDGET, {
        targets: {
          targetCplMinor: null,
          targetCostPerQualifiedVqMinor: null,
          primaryMetric: 'cost_per_qualified_vq',
          primaryMetricTarget: null,
        },
      }),
    ).toBeNull();
  });

  it('respects the 24 h cooldown', () => {
    expect(
      run(SCALE_BUDGET, {
        budget: {
          role: 'MARKETING_LEAD',
          currentDailyMinor: 10_000,
          recentScales: [{ at: '2026-03-31T22:00:00.000Z' }],
        },
      }),
    ).toBeNull();
  });

  it('fires again once the cooldown has elapsed', () => {
    expect(
      run(SCALE_BUDGET, {
        budget: {
          role: 'MARKETING_LEAD',
          currentDailyMinor: 10_000,
          recentScales: [{ at: '2026-03-29T22:00:00.000Z' }],
        },
      }),
    ).not.toBeNull();
  });

  it('never proposes past the role ceiling and says that it capped the step', () => {
    const result = run(SCALE_BUDGET, {
      budget: { role: 'MARKETING_LEAD', currentDailyMinor: 1_900_000, recentScales: [] },
    });
    // +20 % would be 2 280 000; the MARKETING_LEAD ceiling is 2 000 000.
    expect(result?.affectedMetaObjects[0].proposedDailyBudgetMinor).toBe(2_000_000);
    expect(result?.summaryDe).toContain('begrenzt');
    expect(result?.risk).toBe('HIGH');
  });

  it('does not fire when there is no budget headroom at all', () => {
    expect(
      run(SCALE_BUDGET, {
        budget: { role: 'MARKETING_LEAD', currentDailyMinor: 2_000_000, recentScales: [] },
      }),
    ).toBeNull();
  });

  it('does not fire for a role without scale authority', () => {
    expect(
      run(SCALE_BUDGET, {
        budget: { role: 'MARKETING_OPERATOR', currentDailyMinor: 10_000, recentScales: [] },
      }),
    ).toBeNull();
  });

  it('states the maturity date it relied on', () => {
    const result = run(SCALE_BUDGET);
    expect(result?.summaryDe).toContain('ausgereift');
    expect(result?.maturity).toBe('MATURE');
  });
});

/* -------------------------------------------------------------------------- */
/* DECREASE_BUDGET_ON_GUARDRAIL_BREACH                                         */
/* -------------------------------------------------------------------------- */

describe('DECREASE_BUDGET_ON_GUARDRAIL_BREACH', () => {
  it('fires on a breached guardrail with sufficient data', () => {
    const result = run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH, {
      guardrails: [{ metric: 'cpl', value: 9_000, limit: 2_000, arm_id: null }],
    });
    expect(result?.action).toBe('DECREASE_BUDGET');
    expect(result?.proposedBudgetChangePct).toBeCloseTo(-0.2, 10);
    expect(result?.affectedMetaObjects[0].proposedDailyBudgetMinor).toBe(8_000);
  });

  it('does not fire without a breach', () => {
    expect(
      run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH, {
        guardrails: [{ metric: 'cpl', value: 900, limit: 2_000, arm_id: null }],
      }),
    ).toBeNull();
  });

  it('does not fire with no guardrails configured', () => {
    expect(run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH)).toBeNull();
  });

  it('does not act on a CRM-delayed guardrail while the cohort is immature', () => {
    expect(
      run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH, {
        maturity: maturity('IMMATURE'),
        guardrails: [{ metric: 'cost_per_qualified_vq', value: 90_000, limit: 8_000, arm_id: null }],
      }),
    ).toBeNull();
  });

  it('does act on the same guardrail once the cohort has matured', () => {
    expect(
      run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH, {
        maturity: maturity('MATURE'),
        guardrails: [{ metric: 'cost_per_qualified_vq', value: 90_000, limit: 8_000, arm_id: null }],
      }),
    ).not.toBeNull();
  });

  it('does not fire below the minimum lead count', () => {
    expect(
      run(DECREASE_BUDGET_ON_GUARDRAIL_BREACH, {
        campaign: { key: 'c', label: 'Kampagne', counters: healthyCounters({ leads: 1 }) },
        guardrails: [{ metric: 'cpl', value: 9_000, limit: 2_000, arm_id: null }],
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Experiment rules                                                            */
/* -------------------------------------------------------------------------- */

describe('CONCLUDE_EXPERIMENT', () => {
  it('fires on a decided winner', () => {
    const result = run(CONCLUDE_EXPERIMENT, { experiments: [makeExperimentEntry()] });
    expect(result?.action).toBe('CONCLUDE_EXPERIMENT');
    expect(result?.experiment_id).toBe(makeExperimentEntry().experimentId);
    expect(result?.titleDe).toContain('Gewinner');
  });

  it('fires once the maximum runtime is reached without a winner', () => {
    const evaluation = makeEvaluation({
      experiment: makeExperiment({
        thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS, maxRuntimeDays: 21 },
      }),
      observations: [
        armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 200 }),
        armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 210 }),
      ],
    });
    expect(evaluation.result.verdict).toBe('INCONCLUSIVE');
    const result = run(CONCLUDE_EXPERIMENT, { experiments: [makeExperimentEntry({ evaluation })] });
    expect(result).not.toBeNull();
    expect(result?.summaryDe).toContain('maximale Laufzeit');
  });

  it('does not fire on a healthy running test', () => {
    const evaluation = makeEvaluation({
      observations: [
        armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, conversions: 200 }),
        armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', conversions: 210 }),
      ],
    });
    expect(evaluation.result.verdict).toBe('INCONCLUSIVE');
    expect(run(CONCLUDE_EXPERIMENT, { experiments: [makeExperimentEntry({ evaluation })] })).toBeNull();
  });

  it('does not fire on a PROVISIONAL verdict — an immature winner is not concluded', () => {
    const evaluation = makeEvaluation({ now: '2026-03-15T00:00:00.000Z' });
    expect(evaluation.result.verdict).toBe('PROVISIONAL');
    expect(run(CONCLUDE_EXPERIMENT, { experiments: [makeExperimentEntry({ evaluation })] })).toBeNull();
  });

  it('does not fire without an experiment', () => {
    expect(run(CONCLUDE_EXPERIMENT)).toBeNull();
  });

  it('carries the interpretation warnings of a bundled test into the summary', () => {
    const evaluation = makeEvaluation({
      experiment: makeExperiment({ kind: 'BUNDLED_FUNNEL_TEST', bundled: true }),
    });
    const result = run(CONCLUDE_EXPERIMENT, {
      experiments: [makeExperimentEntry({ evaluation, kind: 'BUNDLED_FUNNEL_TEST' })],
    });
    expect(result?.summaryDe).toContain('Creative- und Funnel-Effekte');
  });
});

describe('PAUSE_FUNNEL_ARM_UNDERPERFORMING', () => {
  const losingEvaluation = makeEvaluation({
    observations: [
      armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', label: 'Langes Formular', is_control: true, conversions: 400 }),
      armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', label: 'Kurzes Formular', conversions: 200 }),
    ],
  });

  it('fires when an arm is both materially and significantly worse than control', () => {
    const result = run(PAUSE_FUNNEL_ARM_UNDERPERFORMING, {
      experiments: [makeExperimentEntry({ evaluation: losingEvaluation })],
    });
    expect(result?.action).toBe('PAUSE_FUNNEL_ARM');
    expect(result?.affectedMetaObjects.map((o) => o.external_id)).toEqual(['ad-variant-a']);
    expect(result?.titleDe).toContain('unter der Kontrolle');
  });

  it('does not fire on a small shortfall, however certain', () => {
    const evaluation = makeEvaluation({
      observations: [
        armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 60_000, exposures: 60_000, conversions: 6_000 }),
        armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', sessions: 60_000, exposures: 60_000, conversions: 5_700 }),
      ],
    });
    expect(run(PAUSE_FUNNEL_ARM_UNDERPERFORMING, { experiments: [makeExperimentEntry({ evaluation })] })).toBeNull();
  });

  it('does not fire on a large but uncertain shortfall', () => {
    const evaluation = makeEvaluation({
      observations: [
        armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 300, exposures: 300, conversions: 30 }),
        armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', sessions: 300, exposures: 300, conversions: 20 }),
      ],
    });
    expect(evaluation.result.verdict).not.toBe('WINNER');
    expect(run(PAUSE_FUNNEL_ARM_UNDERPERFORMING, { experiments: [makeExperimentEntry({ evaluation })] })).toBeNull();
  });

  it('does not fire while the experiment is still gated on volume', () => {
    const evaluation = makeEvaluation({
      observations: [
        armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', is_control: true, sessions: 100, exposures: 100, conversions: 40 }),
        armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', sessions: 100, exposures: 100, conversions: 5 }),
      ],
    });
    expect(evaluation.result.verdict).toBe('INSUFFICIENT_DATA');
    expect(run(PAUSE_FUNNEL_ARM_UNDERPERFORMING, { experiments: [makeExperimentEntry({ evaluation })] })).toBeNull();
  });

  it('does not fire for a creative exploration — that is the creative rule', () => {
    expect(
      run(PAUSE_FUNNEL_ARM_UNDERPERFORMING, {
        experiments: [makeExperimentEntry({ evaluation: losingEvaluation, kind: 'CREATIVE_EXPLORATION' })],
      }),
    ).toBeNull();
  });
});

describe('PAUSE_CREATIVE_UNDERPERFORMING', () => {
  const losingEvaluation = makeEvaluation({
    experiment: makeExperiment({ kind: 'CREATIVE_EXPLORATION' }),
    observations: [
      armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', label: 'Konzept A', is_control: true, conversions: 400 }),
      armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', label: 'Konzept B', conversions: 200 }),
    ],
  });

  it('fires for a creative exploration', () => {
    const result = run(PAUSE_CREATIVE_UNDERPERFORMING, {
      experiments: [makeExperimentEntry({ evaluation: losingEvaluation, kind: 'CREATIVE_EXPLORATION' })],
    });
    expect(result?.action).toBe('PAUSE_CREATIVE');
    expect(result?.summaryDe).toContain('Konzept B');
  });

  it('does not fire for a funnel experiment', () => {
    expect(
      run(PAUSE_CREATIVE_UNDERPERFORMING, {
        experiments: [makeExperimentEntry({ evaluation: losingEvaluation, kind: 'FUNNEL_EXPERIMENT' })],
      }),
    ).toBeNull();
  });

  it('warns that Meta-optimised delivery is not a randomised comparison', () => {
    const result = run(PAUSE_CREATIVE_UNDERPERFORMING, {
      experiments: [makeExperimentEntry({ evaluation: losingEvaluation, kind: 'CREATIVE_EXPLORATION' })],
    });
    expect(result?.summaryDe).toContain('kein randomisierter A/B-Test');
  });
});

/* -------------------------------------------------------------------------- */
/* Pattern rules                                                               */
/* -------------------------------------------------------------------------- */

describe('KEEP_OFFER_CHANGE_MESSAGING', () => {
  // CTR 2 %, submission rate 2 % — the click works, the funnel does not.
  const goodCtrPoorFunnel = {
    key: 'c',
    label: 'Kampagne',
    counters: healthyCounters({ leads: 60 }),
  };

  it('fires on good CTR with a poor submission rate', () => {
    const result = run(KEEP_OFFER_CHANGE_MESSAGING, { campaign: goodCtrPoorFunnel });
    expect(result?.action).toBe('KEEP_OFFER_CHANGE_MESSAGING');
    expect(result?.summaryDe).toContain('nach dem Klick');
  });

  it('does not fire when the submission rate is healthy', () => {
    expect(run(KEEP_OFFER_CHANGE_MESSAGING, { campaign: { key: 'c', label: 'K', counters: healthyCounters() } })).toBeNull();
  });

  it('does not fire when the CTR is below the benchmark', () => {
    expect(
      run(KEEP_OFFER_CHANGE_MESSAGING, {
        campaign: { key: 'c', label: 'K', counters: healthyCounters({ leads: 60, linkClicks: 400 }) },
      }),
    ).toBeNull();
  });

  it('does not fire below the minimum funnel volume', () => {
    expect(
      run(KEEP_OFFER_CHANGE_MESSAGING, {
        campaign: { key: 'c', label: 'K', counters: healthyCounters({ leads: 2, funnelSessions: 100 }) },
      }),
    ).toBeNull();
  });
});

describe('TEST_NEW_ANGLE', () => {
  const sixWeakConcepts = Array.from({ length: 6 }, (_, i) =>
    creativeSlice(`c${i + 1}`, `Konzept ${i + 1}`, 0.004),
  );

  it('fires when every concept sits below the CTR benchmark', () => {
    const result = run(TEST_NEW_ANGLE, { creatives: sixWeakConcepts });
    expect(result?.action).toBe('TEST_NEW_ANGLE');
    expect(result?.summaryDe).toContain('Perspektive');
  });

  it('does not fire when one concept clears the benchmark', () => {
    const mixed = [...sixWeakConcepts.slice(0, 5), creativeSlice('c6', 'Konzept 6', 0.02)];
    expect(run(TEST_NEW_ANGLE, { creatives: mixed })).toBeNull();
  });

  it('does not fire on too few concepts to blame the angle', () => {
    expect(run(TEST_NEW_ANGLE, { creatives: sixWeakConcepts.slice(0, 4) })).toBeNull();
  });

  it('ignores concepts without enough impressions to read', () => {
    const thin = sixWeakConcepts.map((slice, i) =>
      i < 3 ? creativeSlice(slice.key, slice.label, 0.004, 100) : slice,
    );
    expect(run(TEST_NEW_ANGLE, { creatives: thin })).toBeNull();
  });

  it('does not fire without any creative breakdown', () => {
    expect(run(TEST_NEW_ANGLE)).toBeNull();
  });
});

describe('NEW_CREATIVE_ITERATION', () => {
  const mixedConcepts = [
    creativeSlice('c1', 'Konzept 1', 0.025),
    creativeSlice('c2', 'Konzept 2', 0.004),
    creativeSlice('c3', 'Konzept 3', 0.003),
  ];

  it('fires on mixed CTR with a healthy funnel', () => {
    const result = run(NEW_CREATIVE_ITERATION, { creatives: mixedConcepts });
    expect(result?.action).toBe('NEW_CREATIVE_ITERATION');
    expect(result?.summaryDe).toContain('Konzept 1');
  });

  it('does not fire when every concept clears the benchmark', () => {
    expect(
      run(NEW_CREATIVE_ITERATION, {
        creatives: [creativeSlice('c1', 'K1', 0.02), creativeSlice('c2', 'K2', 0.03)],
      }),
    ).toBeNull();
  });

  it('does not fire when every concept fails — that is the angle rule', () => {
    expect(
      run(NEW_CREATIVE_ITERATION, {
        creatives: [creativeSlice('c1', 'K1', 0.002), creativeSlice('c2', 'K2', 0.003)],
      }),
    ).toBeNull();
  });

  it('does not fire when the funnel is the actual problem', () => {
    expect(
      run(NEW_CREATIVE_ITERATION, {
        creatives: mixedConcepts,
        campaign: { key: 'c', label: 'K', counters: healthyCounters({ leads: 60 }) },
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* COLLECT_MORE_DATA                                                           */
/* -------------------------------------------------------------------------- */

describe('COLLECT_MORE_DATA', () => {
  it('names exactly what is still missing', () => {
    const result = run(COLLECT_MORE_DATA, {
      campaign: { key: 'c', label: 'K', counters: counters({ leads: 2, funnelSessions: 40, impressions: 500 }) },
      maturity: maturity('IMMATURE'),
    });
    expect(result?.summaryDe).toContain('2 von 5 Leads');
    expect(result?.summaryDe).toContain('40 von 200 Funnel-Sessions');
    expect(result?.summaryDe).toContain('CRM-Ergebnisse');
  });

  it('is honest when everything is in place but nothing is wrong', () => {
    const result = run(COLLECT_MORE_DATA);
    expect(result?.summaryDe).toContain('erwarteten Rahmen');
  });

  it('shows the undefined CPL as 0 / 0 rather than as a zero rate', () => {
    const result = run(COLLECT_MORE_DATA, {
      campaign: { key: 'c', label: 'K', counters: counters() },
      maturity: maturity('IMMATURE'),
    });
    const submission = result?.facts.find((f) => f.metric === 'submission_rate');
    expect(submission?.numerator).toBe(0);
    expect(submission?.denominator).toBe(0);
    expect(submission?.value).toBeNull();
  });

  it('is marked as a fallback so the engine only uses it as a last resort', () => {
    expect(COLLECT_MORE_DATA.fallback).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule set integrity                                                          */
/* -------------------------------------------------------------------------- */

describe('rule set', () => {
  it('has unique ids and unique ranks', () => {
    const ids = RECOMMENDATION_RULES.map((rule) => rule.id);
    const ranks = RECOMMENDATION_RULES.map((rule) => rule.rank);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('is listed in rank order', () => {
    const ranks = RECOMMENDATION_RULES.map((rule) => rule.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('has exactly one fallback', () => {
    expect(RECOMMENDATION_RULES.filter((rule) => rule.fallback)).toHaveLength(1);
  });

  it('produces stable ids across runs for the same proposal', () => {
    const first = run(SCALE_BUDGET);
    const second = run(SCALE_BUDGET);
    expect(second?.id).toBe(first?.id);
    expect(second).toEqual(first);
  });

  it('stamps created_at from the context, never from the clock', () => {
    expect(run(SCALE_BUDGET)?.created_at).toBe(NOW);
  });
});
