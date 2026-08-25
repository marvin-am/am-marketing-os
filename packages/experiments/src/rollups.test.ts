import { type TrafficKind } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  computeRollups,
  totalCounters,
  utcDay,
  type RollupCrmRecord,
  type RollupEvent,
  type RollupInsightRow,
} from './rollups';

const CAMPAIGN_A = 'campaign-a';
const CAMPAIGN_B = 'campaign-b';
const CREATIVE_1 = 'creative-1';
const CREATIVE_2 = 'creative-2';
const ARM_CONTROL = 'arm-control';
const NOW = '2026-04-01T00:00:00.000Z';

function event(overrides: Partial<RollupEvent> & Pick<RollupEvent, 'event_type' | 'session_id'>): RollupEvent {
  return {
    occurred_at: '2026-03-01T10:00:00.000Z',
    traffic_kind: 'PRODUCTION',
    campaign_id: CAMPAIGN_A,
    creative_version_id: CREATIVE_1,
    funnel_version_id: 'funnel-1',
    experiment_arm_id: ARM_CONTROL,
    ...overrides,
  };
}

function crm(overrides: Partial<RollupCrmRecord> & Pick<RollupCrmRecord, 'submission_id'>): RollupCrmRecord {
  return {
    occurred_at: '2026-03-01T12:00:00.000Z',
    traffic_kind: 'PRODUCTION',
    campaign_id: CAMPAIGN_A,
    creative_version_id: CREATIVE_1,
    funnel_version_id: 'funnel-1',
    experiment_arm_id: ARM_CONTROL,
    attribution_confidence: 'EXACT',
    vq_scheduled: false,
    vq_attended: false,
    qualified_vq: false,
    opportunity: false,
    closed_won: false,
    revenue_minor: 0,
    ...overrides,
  };
}

function insight(overrides: Partial<RollupInsightRow> = {}): RollupInsightRow {
  return {
    date: '2026-03-01',
    campaign_id: CAMPAIGN_A,
    creative_version_id: CREATIVE_1,
    funnel_version_id: 'funnel-1',
    experiment_arm_id: ARM_CONTROL,
    impressions: 10_000,
    link_clicks: 200,
    spend_minor: 20_000,
    ...overrides,
  };
}

describe('computeRollups — traffic filtering', () => {
  const nonProduction: TrafficKind[] = ['BOT', 'PREVIEW', 'INTERNAL', 'TEST'];

  it('excludes BOT, PREVIEW, INTERNAL and TEST events from every counter', () => {
    const events: RollupEvent[] = [
      event({ event_type: 'funnel_viewed', session_id: 's-real' }),
      event({ event_type: 'lead_submitted', session_id: 's-real', submission_id: 'sub-real' }),
      ...nonProduction.flatMap((kind) => [
        event({ event_type: 'funnel_viewed', session_id: `s-${kind}`, traffic_kind: kind }),
        event({
          event_type: 'lead_submitted',
          session_id: `s-${kind}`,
          submission_id: `sub-${kind}`,
          traffic_kind: kind,
        }),
      ]),
    ];

    const result = computeRollups({ dimension: 'CAMPAIGN', events, now: NOW });
    expect(result.cumulative).toHaveLength(1);
    expect(result.cumulative[0].counters.funnelSessions).toBe(1);
    expect(result.cumulative[0].counters.leads).toBe(1);
    expect(result.exclusions.events).toBe(8);
    expect(result.exclusions.byTrafficKind).toEqual({ BOT: 2, PREVIEW: 2, INTERNAL: 2, TEST: 2 });
  });

  it('excludes non-production CRM records too', () => {
    const crmRecords: RollupCrmRecord[] = [
      crm({ submission_id: 'sub-1', qualified_vq: true, revenue_minor: 500_000 }),
      ...nonProduction.map((kind) =>
        crm({ submission_id: `sub-${kind}`, traffic_kind: kind, qualified_vq: true, revenue_minor: 900_000 }),
      ),
    ];
    const result = computeRollups({ dimension: 'CAMPAIGN', crmRecords, now: NOW });
    expect(result.cumulative[0].counters.qualifiedVq).toBe(1);
    expect(result.cumulative[0].counters.revenueMinor).toBe(500_000);
    expect(result.exclusions.crmRecords).toBe(4);
  });

  it('never lets excluded traffic reach a metric', () => {
    const result = computeRollups({
      dimension: 'CAMPAIGN',
      events: [
        event({ event_type: 'funnel_viewed', session_id: 's1' }),
        event({ event_type: 'funnel_viewed', session_id: 's2', traffic_kind: 'BOT' }),
        event({ event_type: 'lead_submitted', session_id: 's2', submission_id: 'sub-bot', traffic_kind: 'BOT' }),
      ],
      now: NOW,
    });
    expect(result.cumulative[0].metrics.submission_rate).toMatchObject({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
  });

  it('counts rows without an id for the requested dimension as unattributed', () => {
    const result = computeRollups({
      dimension: 'CREATIVE',
      events: [event({ event_type: 'funnel_viewed', session_id: 's1', creative_version_id: null })],
      insights: [insight({ creative_version_id: null })],
      crmRecords: [crm({ submission_id: 'sub-1', creative_version_id: null })],
      now: NOW,
    });
    expect(result.exclusions.unattributedEvents).toBe(1);
    expect(result.exclusions.unattributedInsights).toBe(1);
    expect(result.exclusions.unattributedCrmRecords).toBe(1);
    expect(result.cumulative).toEqual([]);
  });
});

describe('computeRollups — aggregation', () => {
  const events: RollupEvent[] = [
    event({ event_type: 'funnel_viewed', session_id: 's1' }),
    event({ event_type: 'funnel_viewed', session_id: 's1' }), // repeat visit, one session
    event({ event_type: 'funnel_viewed', session_id: 's2' }),
    event({ event_type: 'form_started', session_id: 's1' }),
    event({ event_type: 'form_step_viewed', session_id: 's1', step_id: 'step_one' }),
    event({ event_type: 'form_step_completed', session_id: 's1', step_id: 'step_one' }),
    event({ event_type: 'lead_submitted', session_id: 's1', submission_id: 'sub-1' }),
    event({ event_type: 'funnel_viewed', session_id: 's3', occurred_at: '2026-03-02T09:00:00.000Z' }),
    event({
      event_type: 'lead_submitted',
      session_id: 's3',
      submission_id: 'sub-2',
      occurred_at: '2026-03-02T09:30:00.000Z',
    }),
  ];

  const insights: RollupInsightRow[] = [insight(), insight({ date: '2026-03-02', impressions: 5_000, link_clicks: 90, spend_minor: 10_000 })];

  const crmRecords: RollupCrmRecord[] = [
    crm({ submission_id: 'sub-1', vq_scheduled: true, vq_attended: true, qualified_vq: true, opportunity: true, closed_won: true, revenue_minor: 1_200_000 }),
    crm({
      submission_id: 'sub-2',
      occurred_at: '2026-03-02T14:00:00.000Z',
      vq_scheduled: true,
      attribution_confidence: 'LOW_CONFIDENCE',
    }),
  ];

  it('counts distinct sessions, not events', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, now: NOW });
    expect(result.cumulative[0].counters.funnelSessions).toBe(3);
  });

  it('produces one daily rollup per day and one cumulative rollup per key', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, insights, crmRecords, now: NOW });
    expect(result.daily.map((r) => r.date)).toEqual(['2026-03-01', '2026-03-02']);
    expect(result.cumulative).toHaveLength(1);
    expect(result.cumulative[0].date).toBeNull();
  });

  it('sums daily counters into the cumulative rollup', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, insights, crmRecords, now: NOW });
    const [day1, day2] = result.daily;
    const total = result.cumulative[0];
    expect(day1.counters.impressions + day2.counters.impressions).toBe(total.counters.impressions);
    expect(total.counters.spendMinor).toBe(30_000);
    expect(total.counters.leads).toBe(2);
    expect(total.counters.closedWon).toBe(1);
    expect(total.counters.revenueMinor).toBe(1_200_000);
  });

  it('recomputes metrics from the summed counters', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, insights, crmRecords, now: NOW });
    const total = result.cumulative[0];
    expect(total.metrics.ctr).toMatchObject({ numerator: 290, denominator: 15_000 });
    expect(total.metrics.cpl).toMatchObject({ numerator: 30_000, denominator: 2, value: 15_000 });
    expect(total.metrics.roas.value).toBeCloseTo(1_200_000 / 30_000, 12);
  });

  it('includes attribution coverage on every rollup', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, insights, crmRecords, now: NOW });
    for (const rollup of [...result.daily, ...result.cumulative]) {
      expect(rollup).toHaveProperty('attributionCoverage');
    }
    // One EXACT of two records → 0.5 on the cumulative rollup.
    expect(result.cumulative[0].attributionCoverage).toBe(0.5);
    expect(result.cumulative[0].attributedRecords).toBe(2);
  });

  it('reports null coverage rather than 0 when there are no CRM records', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, now: NOW });
    expect(result.cumulative[0].attributionCoverage).toBeNull();
    expect(result.cumulative[0].attributedRecords).toBe(0);
  });

  it('assesses maturity from the earliest row in the group', () => {
    const result = computeRollups({
      dimension: 'CAMPAIGN',
      events,
      insights,
      crmRecords,
      now: NOW,
      crmMaturityDays: 21,
    });
    const total = result.cumulative[0];
    expect(total.cohortStartedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(total.maturity).toBe('MATURE');
    expect(total.metrics.roas.maturity).toBe('MATURE');
  });

  it('marks a fresh cohort immature and propagates that into CRM metrics', () => {
    const result = computeRollups({
      dimension: 'CAMPAIGN',
      events,
      insights,
      crmRecords,
      now: '2026-03-03T00:00:00.000Z',
      crmMaturityDays: 21,
    });
    const total = result.cumulative[0];
    expect(total.maturity).toBe('IMMATURE');
    expect(total.metrics.cost_per_qualified_vq.maturity).toBe('IMMATURE');
    expect(total.metrics.ctr.maturity).toBe('MATURE');
  });
});

describe('computeRollups — dimensions', () => {
  const events: RollupEvent[] = [
    event({ event_type: 'funnel_viewed', session_id: 's1', creative_version_id: CREATIVE_1 }),
    event({ event_type: 'funnel_viewed', session_id: 's2', creative_version_id: CREATIVE_2 }),
    event({ event_type: 'funnel_viewed', session_id: 's3', creative_version_id: CREATIVE_2, campaign_id: CAMPAIGN_B }),
  ];

  it('groups by campaign', () => {
    const result = computeRollups({ dimension: 'CAMPAIGN', events, now: NOW });
    expect(result.cumulative.map((r) => r.key)).toEqual([CAMPAIGN_A, CAMPAIGN_B]);
  });

  it('groups by creative version', () => {
    const result = computeRollups({ dimension: 'CREATIVE', events, now: NOW });
    expect(result.cumulative.map((r) => r.key)).toEqual([CREATIVE_1, CREATIVE_2]);
    expect(result.cumulative[1].counters.funnelSessions).toBe(2);
  });

  it('groups by funnel version', () => {
    const result = computeRollups({ dimension: 'FUNNEL', events, now: NOW });
    expect(result.cumulative.map((r) => r.key)).toEqual(['funnel-1']);
  });

  it('groups by experiment arm', () => {
    const result = computeRollups({ dimension: 'EXPERIMENT_ARM', events, now: NOW });
    expect(result.cumulative.map((r) => r.key)).toEqual([ARM_CONTROL]);
  });
});

describe('computeRollups — determinism', () => {
  it('produces identical output for identical input', () => {
    const input = {
      dimension: 'CAMPAIGN' as const,
      events: [event({ event_type: 'funnel_viewed', session_id: 's1' })],
      insights: [insight()],
      crmRecords: [crm({ submission_id: 'sub-1' })],
      now: NOW,
    };
    expect(computeRollups(input)).toEqual(computeRollups(input));
  });

  it('is independent of the row order', () => {
    const rows: RollupEvent[] = [
      event({ event_type: 'funnel_viewed', session_id: 's1', campaign_id: CAMPAIGN_B }),
      event({ event_type: 'funnel_viewed', session_id: 's2', campaign_id: CAMPAIGN_A }),
      event({ event_type: 'funnel_viewed', session_id: 's3', campaign_id: CAMPAIGN_B }),
    ];
    const forward = computeRollups({ dimension: 'CAMPAIGN', events: rows, now: NOW });
    const reversed = computeRollups({ dimension: 'CAMPAIGN', events: [...rows].reverse(), now: NOW });
    expect(reversed.cumulative.map((r) => r.key)).toEqual(forward.cumulative.map((r) => r.key));
    expect(reversed.cumulative.map((r) => r.counters)).toEqual(forward.cumulative.map((r) => r.counters));
  });

  it('sorts daily rollups by key and then date', () => {
    const result = computeRollups({
      dimension: 'CAMPAIGN',
      events: [
        event({ event_type: 'funnel_viewed', session_id: 's1', campaign_id: CAMPAIGN_B, occurred_at: '2026-03-05T00:00:00.000Z' }),
        event({ event_type: 'funnel_viewed', session_id: 's2', campaign_id: CAMPAIGN_A, occurred_at: '2026-03-04T00:00:00.000Z' }),
        event({ event_type: 'funnel_viewed', session_id: 's3', campaign_id: CAMPAIGN_A, occurred_at: '2026-03-02T00:00:00.000Z' }),
      ],
      now: NOW,
    });
    expect(result.daily.map((r) => `${r.key}@${r.date}`)).toEqual([
      `${CAMPAIGN_A}@2026-03-02`,
      `${CAMPAIGN_A}@2026-03-04`,
      `${CAMPAIGN_B}@2026-03-05`,
    ]);
  });
});

describe('helpers', () => {
  it('utcDay takes the UTC calendar day', () => {
    expect(utcDay('2026-03-01T23:59:59.000Z')).toBe('2026-03-01');
  });

  it('totalCounters sums across rollups', () => {
    const result = computeRollups({
      dimension: 'CREATIVE',
      insights: [insight({ creative_version_id: CREATIVE_1 }), insight({ creative_version_id: CREATIVE_2 })],
      now: NOW,
    });
    expect(totalCounters(result.cumulative).spendMinor).toBe(40_000);
  });
});
