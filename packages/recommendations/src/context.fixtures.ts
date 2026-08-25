import {
  type ArmObservation,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  type Experiment,
  type ExperimentKind,
} from '@am/domain';
import {
  assessMaturity,
  emptyCounters,
  evaluateExperiment,
  type ExperimentEvaluation,
  type MaturityAssessment,
  type MetricCounters,
} from '@am/experiments';
import { type ExperimentContextEntry, type RecommendationContext } from './context';

/**
 * Shared fixtures for the rule and engine tests.
 *
 * Deliberately built from the real `@am/experiments` functions rather than
 * hand-written result objects: a rule test that passes against a fabricated
 * `ExperimentEvaluation` proves nothing about the rule's behaviour on real
 * output.
 */

export const CAMPAIGN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const EXPERIMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CONTROL_ARM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const VARIANT_ARM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const NOW = '2026-04-01T00:00:00.000Z';

export function daysBeforeNow(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

export function counters(overrides: Partial<MetricCounters> = {}): MetricCounters {
  return { ...emptyCounters(), ...overrides };
}

/** A campaign that is performing well on every axis. */
export function healthyCounters(overrides: Partial<MetricCounters> = {}): MetricCounters {
  return counters({
    impressions: 200_000,
    linkClicks: 4_000,
    spendMinor: 500_000,
    funnelSessions: 3_000,
    formStarts: 1_800,
    formStepViews: 6_000,
    formStepCompletions: 5_000,
    leads: 600,
    vqScheduled: 300,
    vqAttended: 220,
    qualifiedVq: 150,
    opportunities: 60,
    closedWon: 12,
    revenueMinor: 6_000_000,
    ...overrides,
  });
}

export function maturity(kind: 'MATURE' | 'PARTIAL' | 'IMMATURE'): MaturityAssessment {
  if (kind === 'MATURE') {
    return assessMaturity({
      cohortStartedAt: daysBeforeNow(35),
      now: NOW,
      crmMaturityDays: 21,
      observedOutcomes: 150,
    });
  }
  if (kind === 'PARTIAL') {
    return assessMaturity({
      cohortStartedAt: daysBeforeNow(14),
      now: NOW,
      crmMaturityDays: 21,
      observedOutcomes: 12,
    });
  }
  return assessMaturity({
    cohortStartedAt: daysBeforeNow(3),
    now: NOW,
    crmMaturityDays: 21,
    observedOutcomes: 0,
  });
}

export function makeContext(overrides: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    now: NOW,
    campaignId: CAMPAIGN_ID,
    campaignName: 'Potenzialanalyse Handwerk',
    currency: 'EUR',
    campaign: {
      key: CAMPAIGN_ID,
      label: 'Potenzialanalyse Handwerk',
      counters: healthyCounters(),
      metaObjects: [
        {
          level: 'CAMPAIGN',
          external_id: '120200000000001',
          name: 'AM | Potenzialanalyse Handwerk',
          currentStatus: 'ACTIVE',
          currentDailyBudgetMinor: 10_000,
          proposedDailyBudgetMinor: null,
        },
      ],
    },
    creatives: [],
    funnelArms: [],
    targets: {
      targetCplMinor: 2_000,
      targetCostPerQualifiedVqMinor: 8_000,
      primaryMetric: 'cost_per_qualified_vq',
      primaryMetricTarget: 8_000,
    },
    guardrails: [],
    maturity: maturity('MATURE'),
    attributionCoverage: 0.92,
    budget: {
      role: 'MARKETING_LEAD',
      currentDailyMinor: 10_000,
      recentScales: [],
    },
    experiments: [],
    openRecommendations: [],
    ...overrides,
  };
}

/** A creative slice with a chosen CTR at a chosen impression volume. */
export function creativeSlice(
  key: string,
  label: string,
  ctr: number,
  impressions = 20_000,
  extra: Partial<MetricCounters> = {},
) {
  return {
    key,
    label,
    counters: counters({
      impressions,
      linkClicks: Math.round(impressions * ctr),
      spendMinor: Math.round(impressions / 10),
      ...extra,
    }),
    metaObjects: [
      {
        level: 'AD' as const,
        external_id: `ad-${key}`,
        name: label,
        currentStatus: 'ACTIVE',
        currentDailyBudgetMinor: null,
        proposedDailyBudgetMinor: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

const EXPERIMENT_START = daysBeforeNow(30);

export function makeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: EXPERIMENT_ID,
    campaign_id: CAMPAIGN_ID,
    kind: 'FUNNEL_EXPERIMENT' as ExperimentKind,
    state: 'RUNNING',
    name: 'Kurzes gegen langes Formular',
    hypothesis: 'Ein kürzeres Formular erhöht die Submission-Rate.',
    test_variable: 'Formularlänge',
    primary_metric: 'submission_rate',
    secondary_metrics: [],
    guardrail_metrics: [],
    thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS, maxRuntimeDays: 45 },
    assignment_salt: 'salt-1234',
    bundled: false,
    eligibility_changing: false,
    started_at: EXPERIMENT_START,
    concluded_at: null,
    created_at: EXPERIMENT_START,
    ...overrides,
  };
}

export function armObservation(
  overrides: Partial<ArmObservation> & Pick<ArmObservation, 'arm_id' | 'arm_key'>,
): ArmObservation {
  return {
    label: overrides.arm_key,
    is_control: false,
    sessions: 2_000,
    exposures: 2_000,
    conversions: 200,
    spend_minor: 200_000,
    vq_scheduled: 0,
    vq_attended: 0,
    qualified_vq: 0,
    opportunities: 0,
    closed_won: 0,
    revenue_minor: 0,
    attribution_coverage: 0.9,
    ...overrides,
  };
}

export interface EvaluationOptions {
  experiment?: Experiment;
  observations?: readonly ArmObservation[];
  now?: string;
}

export function makeEvaluation(options: EvaluationOptions = {}): ExperimentEvaluation {
  return evaluateExperiment({
    experiment: options.experiment ?? makeExperiment(),
    observations:
      options.observations ?? [
        armObservation({ arm_id: CONTROL_ARM_ID, arm_key: 'control', label: 'Langes Formular', is_control: true, conversions: 200 }),
        armObservation({ arm_id: VARIANT_ARM_ID, arm_key: 'variant_a', label: 'Kurzes Formular', conversions: 400 }),
      ],
    now: options.now ?? NOW,
  });
}

export function makeExperimentEntry(
  overrides: Partial<ExperimentContextEntry> = {},
): ExperimentContextEntry {
  return {
    experimentId: EXPERIMENT_ID,
    name: 'Kurzes gegen langes Formular',
    kind: 'FUNNEL_EXPERIMENT',
    evaluation: makeEvaluation(),
    armMetaObjects: {
      [CONTROL_ARM_ID]: [
        {
          level: 'AD',
          external_id: 'ad-control',
          name: 'Langes Formular',
          currentStatus: 'ACTIVE',
          currentDailyBudgetMinor: null,
          proposedDailyBudgetMinor: null,
        },
      ],
      [VARIANT_ARM_ID]: [
        {
          level: 'AD',
          external_id: 'ad-variant-a',
          name: 'Kurzes Formular',
          currentStatus: 'ACTIVE',
          currentDailyBudgetMinor: null,
          proposedDailyBudgetMinor: null,
        },
      ],
    },
    ...overrides,
  };
}
