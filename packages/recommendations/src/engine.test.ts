import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  recommendationSchema,
  type Recommendation,
} from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  armObservation,
  CAMPAIGN_ID,
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
} from './context.fixtures';
import { generateRecommendations } from './engine';

describe('generateRecommendations — happy path', () => {
  it('produces exactly the scale proposal for a healthy, matured campaign', () => {
    const result = generateRecommendations(makeContext());
    expect(result.firedRuleIds).toEqual(['SCALE_BUDGET']);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].action).toBe('INCREASE_BUDGET');
  });

  it('evaluates every rule, in rank order', () => {
    const result = generateRecommendations(makeContext());
    expect(result.evaluatedRuleIds).toEqual([
      'PAUSE_NO_LEAD_ABOVE_TARGET_CPL',
      'PAUSE_NO_QUALIFIED_VQ',
      'DECREASE_BUDGET_ON_GUARDRAIL_BREACH',
      'PAUSE_CREATIVE',
      'PAUSE_FUNNEL_ARM',
      'CONCLUDE_EXPERIMENT',
      'SCALE_BUDGET',
      'KEEP_OFFER_CHANGE_MESSAGING',
      'NEW_CREATIVE_ITERATION',
      'TEST_NEW_ANGLE',
      'COLLECT_MORE_DATA',
    ]);
  });

  it('emits only proposals — nothing is executed or pre-accepted', () => {
    const result = generateRecommendations(makeContext());
    for (const recommendation of result.recommendations) {
      expect(recommendation.state).toBe('OPEN');
      expect(recommendation.execution).toBeNull();
      expect(() => recommendationSchema.parse(recommendation)).not.toThrow();
    }
  });
});

describe('generateRecommendations — the scale invariant', () => {
  it('never proposes a scale while CRM outcomes are immature', () => {
    for (const kind of ['IMMATURE', 'PARTIAL'] as const) {
      const result = generateRecommendations(makeContext({ maturity: maturity(kind) }));
      const actions = result.recommendations.map((r) => r.action);
      expect(actions, `maturity ${kind} must not yield a scale`).not.toContain('INCREASE_BUDGET');
      expect(result.firedRuleIds).not.toContain('SCALE_BUDGET');
    }
  });

  it('falls back to collecting more data instead of scaling on immature outcomes', () => {
    const result = generateRecommendations(makeContext({ maturity: maturity('IMMATURE') }));
    expect(result.firedRuleIds).toEqual(['COLLECT_MORE_DATA']);
    expect(result.recommendations[0].summaryDe).toContain('CRM-Ergebnisse');
  });
});

describe('generateRecommendations — the honest default', () => {
  it('emits COLLECT_MORE_DATA when no other rule fires', () => {
    const result = generateRecommendations(
      makeContext({
        campaign: { key: 'c', label: 'Kampagne', counters: counters({ spendMinor: 1_000, impressions: 400, funnelSessions: 20 }) },
        maturity: maturity('IMMATURE'),
      }),
    );
    expect(result.firedRuleIds).toEqual(['COLLECT_MORE_DATA']);
  });

  it('does not emit COLLECT_MORE_DATA alongside a real recommendation', () => {
    const result = generateRecommendations(makeContext());
    expect(result.firedRuleIds).not.toContain('COLLECT_MORE_DATA');
  });
});

describe('generateRecommendations — ranking and deduplication', () => {
  it('ranks stop-loss above everything else', () => {
    const result = generateRecommendations(
      makeContext({
        campaign: {
          key: 'c',
          label: 'Kampagne',
          counters: counters({ spendMinor: 50_000, impressions: 40_000, linkClicks: 800, funnelSessions: 600 }),
          metaObjects: [
            { level: 'CAMPAIGN', external_id: 'camp-1', name: 'Kampagne', currentStatus: 'ACTIVE', currentDailyBudgetMinor: 10_000, proposedDailyBudgetMinor: null },
          ],
        },
      }),
    );
    expect(result.recommendations[0].ruleId).toBe('PAUSE_NO_LEAD_ABOVE_TARGET_CPL');
  });

  it('drops a lower-ranked proposal that targets the same object with the same action', () => {
    // Zero leads AND zero qualified VQs on a matured cohort: both pause rules
    // fire, and both would pause the same campaign object.
    const result = generateRecommendations(
      makeContext({
        campaign: {
          key: 'c',
          label: 'Kampagne',
          counters: counters({ spendMinor: 50_000, impressions: 40_000, linkClicks: 800, funnelSessions: 600 }),
          metaObjects: [
            { level: 'CAMPAIGN', external_id: 'camp-1', name: 'Kampagne', currentStatus: 'ACTIVE', currentDailyBudgetMinor: 10_000, proposedDailyBudgetMinor: null },
          ],
        },
      }),
    );
    expect(result.firedRuleIds).toContain('PAUSE_NO_LEAD_ABOVE_TARGET_CPL');
    expect(result.firedRuleIds).not.toContain('PAUSE_NO_QUALIFIED_VQ');
    expect(result.deduplicatedRuleIds).toContain('PAUSE_NO_QUALIFIED_VQ');
    // Exactly one pause proposal reaches the operator, not two for one object.
    expect(result.recommendations.filter((r) => r.action === 'PAUSE_CREATIVE')).toHaveLength(1);
  });

  it('keeps proposals that touch different objects', () => {
    const result = generateRecommendations(
      makeContext({
        campaign: { key: 'c', label: 'Kampagne', counters: healthyCounters({ leads: 60 }) },
        creatives: [
          creativeSlice('c1', 'Konzept 1', 0.025),
          creativeSlice('c2', 'Konzept 2', 0.004),
          creativeSlice('c3', 'Konzept 3', 0.003),
        ],
      }),
    );
    // Poor funnel plus mixed creatives: the funnel diagnosis wins the ordering,
    // and the creative iteration is a separate proposal on separate ads.
    expect(result.firedRuleIds).toContain('KEEP_OFFER_CHANGE_MESSAGING');
    expect(result.recommendations.length).toBeGreaterThan(1);
  });
});

describe('generateRecommendations — experiments', () => {
  const secondExperimentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  it('fans out over every experiment', () => {
    const result = generateRecommendations(
      makeContext({
        experiments: [
          makeExperimentEntry(),
          makeExperimentEntry({
            experimentId: secondExperimentId,
            name: 'Zweites Experiment',
            armMetaObjects: {
              [CONTROL_ARM_ID]: [
                { level: 'AD', external_id: 'ad-2-control', name: 'Kontrolle 2', currentStatus: 'ACTIVE', currentDailyBudgetMinor: null, proposedDailyBudgetMinor: null },
              ],
              [VARIANT_ARM_ID]: [
                { level: 'AD', external_id: 'ad-2-variant', name: 'Variante 2', currentStatus: 'ACTIVE', currentDailyBudgetMinor: null, proposedDailyBudgetMinor: null },
              ],
            },
          }),
        ],
      }),
    );
    const concluded = result.recommendations.filter((r) => r.action === 'CONCLUDE_EXPERIMENT');
    expect(concluded).toHaveLength(2);
    expect(concluded.map((r) => r.experiment_id).sort()).toEqual(
      [makeExperimentEntry().experimentId, secondExperimentId].sort(),
    );
  });

  it('orders experiment proposals by experiment id, whatever order they arrive in', () => {
    const entries = [
      makeExperimentEntry({ experimentId: secondExperimentId, name: 'Zweites Experiment' }),
      makeExperimentEntry(),
    ];
    const forward = generateRecommendations(makeContext({ experiments: entries }));
    const reversed = generateRecommendations(makeContext({ experiments: [...entries].reverse() }));
    expect(reversed.recommendations.map((r) => r.id)).toEqual(
      forward.recommendations.map((r) => r.id),
    );
  });

  const losingArmObservations = [
    armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', label: 'Langes Formular', is_control: true, conversions: 400 }),
    armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', label: 'Kurzes Formular', conversions: 200 }),
  ];

  it('pauses a losing arm without concluding the whole experiment', () => {
    const evaluation = makeEvaluation({ observations: losingArmObservations });
    // The control leads, so there is no winner to conclude on — the right move
    // is to drop the losing arm and let the rest keep running.
    expect(evaluation.result.verdict).toBe('NO_DIFFERENCE');
    const result = generateRecommendations(
      makeContext({ experiments: [makeExperimentEntry({ evaluation })] }),
    );
    expect(result.firedRuleIds).toContain('PAUSE_FUNNEL_ARM');
    expect(result.firedRuleIds).not.toContain('CONCLUDE_EXPERIMENT');
  });

  it('ranks the arm pause ahead of the conclusion when both apply', () => {
    const evaluation = makeEvaluation({
      experiment: makeExperiment({
        thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS, maxRuntimeDays: 21 },
      }),
      observations: losingArmObservations,
    });
    const result = generateRecommendations(
      makeContext({ experiments: [makeExperimentEntry({ evaluation })] }),
    );
    expect(result.firedRuleIds).toContain('PAUSE_FUNNEL_ARM');
    expect(result.firedRuleIds).toContain('CONCLUDE_EXPERIMENT');
    expect(result.firedRuleIds.indexOf('PAUSE_FUNNEL_ARM')).toBeLessThan(
      result.firedRuleIds.indexOf('CONCLUDE_EXPERIMENT'),
    );
  });
});

describe('generateRecommendations — superseding', () => {
  const stale: Recommendation = recommendationSchema.parse({
    id: '99999999-9999-4999-8999-999999999999',
    campaign_id: CAMPAIGN_ID,
    experiment_id: null,
    created_at: '2026-03-20T00:00:00.000Z',
    action: 'PAUSE_CREATIVE',
    state: 'OPEN',
    ruleId: 'PAUSE_NO_LEAD_ABOVE_TARGET_CPL',
    titleDe: 'Alter Vorschlag',
    summaryDe: 'Vorgeschlagene Aktion: veraltet.',
    facts: [
      { metric: 'cpl', label: 'CPL', numerator: 10_000, denominator: 0, value: null, currency: 'EUR', comparisonLabel: null, comparisonValue: null },
    ],
    comparisonBasisDe: 'Alter Vergleich.',
    maturity: 'MATURE',
    attributionCoverage: 0.9,
    uncertaintyDe: 'Alt.',
    risk: 'LOW',
  });

  it('marks a still-open proposal that no rule reproduced as SUPERSEDED', () => {
    const result = generateRecommendations(makeContext({ openRecommendations: [stale] }));
    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0].id).toBe(stale.id);
    expect(result.superseded[0].state).toBe('SUPERSEDED');
  });

  it('refreshes a proposal in place instead of superseding it', () => {
    const first = generateRecommendations(makeContext());
    const second = generateRecommendations(
      makeContext({ openRecommendations: first.recommendations }),
    );
    expect(second.superseded).toEqual([]);
    expect(second.recommendations[0].id).toBe(first.recommendations[0].id);
  });

  it('leaves proposals from another campaign alone', () => {
    const otherCampaign = { ...stale, campaign_id: '77777777-7777-4777-8777-777777777777' };
    const result = generateRecommendations(makeContext({ openRecommendations: [otherCampaign] }));
    expect(result.superseded).toEqual([]);
  });

  it('does not re-supersede an already dismissed proposal', () => {
    const dismissed = { ...stale, state: 'DISMISSED' as const };
    const result = generateRecommendations(makeContext({ openRecommendations: [dismissed] }));
    expect(result.superseded).toEqual([]);
  });
});

describe('generateRecommendations — determinism', () => {
  it('produces byte-identical output for identical input', () => {
    const context = makeContext({
      creatives: [creativeSlice('c1', 'Konzept 1', 0.025), creativeSlice('c2', 'Konzept 2', 0.004)],
      experiments: [makeExperimentEntry()],
    });
    expect(generateRecommendations(context)).toEqual(generateRecommendations(context));
  });

  it('is independent of the order creatives arrive in', () => {
    const slices = [
      creativeSlice('c1', 'Konzept 1', 0.025),
      creativeSlice('c2', 'Konzept 2', 0.004),
      creativeSlice('c3', 'Konzept 3', 0.003),
    ];
    const forward = generateRecommendations(makeContext({ creatives: slices }));
    const reversed = generateRecommendations(makeContext({ creatives: [...slices].reverse() }));
    expect(reversed.recommendations).toEqual(forward.recommendations);
  });

  it('derives created_at from the context, never from the clock', () => {
    for (const recommendation of generateRecommendations(makeContext()).recommendations) {
      expect(recommendation.created_at).toBe(NOW);
    }
  });

  it('produces stable ids across runs', () => {
    const ids = () => generateRecommendations(makeContext()).recommendations.map((r) => r.id);
    expect(ids()).toEqual(ids());
  });

  it('changes the id when the proposal itself changes scope', () => {
    const oneOffender = generateRecommendations(
      makeContext({
        creatives: [
          { ...creativeSlice('c1', 'K1', 0.02), counters: counters({ spendMinor: 20_000, impressions: 20_000 }) },
        ],
      }),
    );
    const twoOffenders = generateRecommendations(
      makeContext({
        creatives: [
          { ...creativeSlice('c1', 'K1', 0.02), counters: counters({ spendMinor: 20_000, impressions: 20_000 }) },
          { ...creativeSlice('c2', 'K2', 0.02), counters: counters({ spendMinor: 20_000, impressions: 20_000 }) },
        ],
      }),
    );
    expect(twoOffenders.recommendations[0].id).not.toBe(oneOffender.recommendations[0].id);
  });
});
