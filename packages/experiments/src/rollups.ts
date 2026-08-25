import {
  attributionCoverage,
  type AttributionConfidence,
  type DataMaturity,
  type IsoDate,
  type IsoTimestamp,
  PRODUCTION_TRAFFIC_KINDS,
  type TrafficKind,
} from '@am/domain';
import {
  addCounters,
  computeAllMetrics,
  emptyCounters,
  type MetricContext,
  type MetricCounters,
  type MetricValueMap,
} from './metrics/compute';
import { assessMaturity, type MaturityAssessment } from './maturity';

/**
 * Pure aggregation of raw rows into daily and cumulative rollups.
 *
 * Three invariants, all of them load-bearing:
 *
 * 1. **Only PRODUCTION traffic is ever counted.** Preview renders, internal QA
 *    sessions, bot hits and test submissions are dropped before anything is
 *    summed, and the dropped volume is reported per traffic kind so a number
 *    that looks wrong can be traced.
 * 2. **Rates are recomputed, never summed.** A cumulative rollup sums counters
 *    and derives its metrics from that sum; averaging daily rates would weight
 *    a quiet Sunday like a busy Tuesday.
 * 3. **Every rollup carries `attributionCoverage` and a maturity.** A ROAS built
 *    on 30 % trustworthy attribution must never be presentable as the same kind
 *    of fact as one built on 95 %.
 *
 * No I/O, no clock: `now` is an input.
 */

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                  */
/* -------------------------------------------------------------------------- */

export const ROLLUP_DIMENSIONS = ['CAMPAIGN', 'CREATIVE', 'FUNNEL', 'EXPERIMENT_ARM'] as const;
export type RollupDimension = (typeof ROLLUP_DIMENSIONS)[number];

export const ROLLUP_DIMENSION_LABELS_DE: Readonly<Record<RollupDimension, string>> = {
  CAMPAIGN: 'Kampagne',
  CREATIVE: 'Creative',
  FUNNEL: 'Funnel',
  EXPERIMENT_ARM: 'Experimentarm',
};

/** Fields every row type exposes so a dimension key can be read from it. */
export interface RollupDimensionKeys {
  campaign_id?: string | null;
  creative_version_id?: string | null;
  funnel_version_id?: string | null;
  experiment_arm_id?: string | null;
}

function dimensionKey(row: RollupDimensionKeys, dimension: RollupDimension): string | null {
  switch (dimension) {
    case 'CAMPAIGN':
      return row.campaign_id ?? null;
    case 'CREATIVE':
      return row.creative_version_id ?? null;
    case 'FUNNEL':
      return row.funnel_version_id ?? null;
    case 'EXPERIMENT_ARM':
      return row.experiment_arm_id ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Subset of `TrackingEvent` used for rollups. A real `TrackingEvent` satisfies
 * this structurally.
 */
export interface RollupEvent extends RollupDimensionKeys {
  event_type: string;
  occurred_at: IsoTimestamp;
  traffic_kind: TrafficKind;
  session_id: string;
  submission_id?: string | null;
  step_id?: string | null;
}

/** One Meta insights row: delivery and cost for one entity on one day. */
export interface RollupInsightRow extends RollupDimensionKeys {
  date: IsoDate;
  impressions: number;
  link_clicks: number;
  spend_minor: number;
}

/**
 * One CRM outcome record, already attributed. Booleans rather than a stage enum
 * because the stages are not mutually exclusive over the record's lifetime —
 * a closed-won deal was also a scheduled VQ.
 */
export interface RollupCrmRecord extends RollupDimensionKeys {
  submission_id: string;
  /** Business time of the acquiring submission — the cohort date. */
  occurred_at: IsoTimestamp;
  traffic_kind: TrafficKind;
  attribution_confidence: AttributionConfidence;
  vq_scheduled: boolean;
  vq_attended: boolean;
  qualified_vq: boolean;
  opportunity: boolean;
  closed_won: boolean;
  revenue_minor: number;
}

export interface RollupInput {
  dimension: RollupDimension;
  events?: readonly RollupEvent[];
  insights?: readonly RollupInsightRow[];
  crmRecords?: readonly RollupCrmRecord[];
  now: IsoTimestamp;
  /** Defaults to the domain default of 21 days. */
  crmMaturityDays?: number;
  expectedLagDays?: number;
  currency?: string;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface Rollup {
  dimension: RollupDimension;
  /** The dimension's id — campaign id, creative version id, arm id, … */
  key: string;
  /** UTC day for a daily rollup; null for the cumulative one. */
  date: IsoDate | null;
  counters: MetricCounters;
  metrics: MetricValueMap;
  /** Share of the underlying CRM records with trustworthy attribution. */
  attributionCoverage: number | null;
  /** Number of CRM records the coverage is computed from. */
  attributedRecords: number;
  maturity: DataMaturity;
  maturityAssessment: MaturityAssessment;
  /** Earliest row observed in this group — the cohort start. */
  cohortStartedAt: IsoTimestamp;
  currency: string;
}

export interface RollupExclusions {
  events: number;
  crmRecords: number;
  byTrafficKind: Partial<Record<TrafficKind, number>>;
  /** Rows dropped because they carried no id for the requested dimension. */
  unattributedEvents: number;
  unattributedInsights: number;
  unattributedCrmRecords: number;
}

export interface RollupResult {
  dimension: RollupDimension;
  /** One entry per (key, day), sorted by key then date. */
  daily: Rollup[];
  /** One entry per key, over the whole period, sorted by key. */
  cumulative: Rollup[];
  exclusions: RollupExclusions;
}

export const DEFAULT_CRM_MATURITY_DAYS = 21;

/* -------------------------------------------------------------------------- */
/* Accumulator                                                                 */
/* -------------------------------------------------------------------------- */

interface Bucket {
  key: string;
  date: IsoDate | null;
  impressions: number;
  linkClicks: number;
  spendMinor: number;
  funnelSessions: Set<string>;
  formStarts: Set<string>;
  formStepViews: number;
  formStepCompletions: number;
  leads: Set<string>;
  vqScheduled: number;
  vqAttended: number;
  qualifiedVq: number;
  opportunities: number;
  closedWon: number;
  revenueMinor: number;
  confidences: AttributionConfidence[];
  earliestAt: number;
}

function newBucket(key: string, date: IsoDate | null): Bucket {
  return {
    key,
    date,
    impressions: 0,
    linkClicks: 0,
    spendMinor: 0,
    funnelSessions: new Set(),
    formStarts: new Set(),
    formStepViews: 0,
    formStepCompletions: 0,
    leads: new Set(),
    vqScheduled: 0,
    vqAttended: 0,
    qualifiedVq: 0,
    opportunities: 0,
    closedWon: 0,
    revenueMinor: 0,
    confidences: [],
    earliestAt: Number.MAX_SAFE_INTEGER,
  };
}

function bucketCounters(bucket: Bucket): MetricCounters {
  return {
    impressions: bucket.impressions,
    linkClicks: bucket.linkClicks,
    spendMinor: bucket.spendMinor,
    funnelSessions: bucket.funnelSessions.size,
    formStarts: bucket.formStarts.size,
    formStepViews: bucket.formStepViews,
    formStepCompletions: bucket.formStepCompletions,
    leads: bucket.leads.size,
    vqScheduled: bucket.vqScheduled,
    vqAttended: bucket.vqAttended,
    qualifiedVq: bucket.qualifiedVq,
    opportunities: bucket.opportunities,
    closedWon: bucket.closedWon,
    revenueMinor: bucket.revenueMinor,
  };
}

/** UTC day of an ISO timestamp. Rollup days are UTC, like every stored date. */
export function utcDay(timestamp: IsoTimestamp): IsoDate {
  return timestamp.slice(0, 10);
}

function isProduction(kind: TrafficKind): boolean {
  return PRODUCTION_TRAFFIC_KINDS.includes(kind);
}

function trackEarliest(bucket: Bucket, iso: string): void {
  const parsed = Date.parse(iso);
  if (!Number.isNaN(parsed) && parsed < bucket.earliestAt) bucket.earliestAt = parsed;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

export function computeRollups(input: RollupInput): RollupResult {
  const { dimension } = input;
  const crmMaturityDays = input.crmMaturityDays ?? DEFAULT_CRM_MATURITY_DAYS;
  const currency = input.currency ?? 'EUR';

  const daily = new Map<string, Bucket>();
  const cumulative = new Map<string, Bucket>();

  const exclusions: RollupExclusions = {
    events: 0,
    crmRecords: 0,
    byTrafficKind: {},
    unattributedEvents: 0,
    unattributedInsights: 0,
    unattributedCrmRecords: 0,
  };

  const exclude = (kind: TrafficKind): void => {
    exclusions.byTrafficKind[kind] = (exclusions.byTrafficKind[kind] ?? 0) + 1;
  };

  const bucketsFor = (key: string, date: IsoDate): [Bucket, Bucket] => {
    const dailyKey = `${key} ${date}`;
    let day = daily.get(dailyKey);
    if (!day) {
      day = newBucket(key, date);
      daily.set(dailyKey, day);
    }
    let total = cumulative.get(key);
    if (!total) {
      total = newBucket(key, null);
      cumulative.set(key, total);
    }
    return [day, total];
  };

  /* ---- Events ------------------------------------------------------------ */

  for (const event of input.events ?? []) {
    if (!isProduction(event.traffic_kind)) {
      exclusions.events += 1;
      exclude(event.traffic_kind);
      continue;
    }
    const key = dimensionKey(event, dimension);
    if (!key) {
      exclusions.unattributedEvents += 1;
      continue;
    }

    const date = utcDay(event.occurred_at);
    const [day, total] = bucketsFor(key, date);
    trackEarliest(day, event.occurred_at);
    trackEarliest(total, event.occurred_at);

    switch (event.event_type) {
      case 'funnel_viewed':
        day.funnelSessions.add(event.session_id);
        total.funnelSessions.add(event.session_id);
        break;
      case 'form_started':
        day.formStarts.add(event.session_id);
        total.formStarts.add(event.session_id);
        break;
      case 'form_step_viewed':
        day.formStepViews += 1;
        total.formStepViews += 1;
        break;
      case 'form_step_completed':
        day.formStepCompletions += 1;
        total.formStepCompletions += 1;
        break;
      case 'lead_submitted': {
        const leadKey = event.submission_id ?? event.session_id;
        day.leads.add(leadKey);
        total.leads.add(leadKey);
        break;
      }
      default:
        break;
    }
  }

  /* ---- Insights ---------------------------------------------------------- */

  for (const row of input.insights ?? []) {
    const key = dimensionKey(row, dimension);
    if (!key) {
      exclusions.unattributedInsights += 1;
      continue;
    }
    const [day, total] = bucketsFor(key, row.date);
    trackEarliest(day, `${row.date}T00:00:00.000Z`);
    trackEarliest(total, `${row.date}T00:00:00.000Z`);

    day.impressions += row.impressions;
    day.linkClicks += row.link_clicks;
    day.spendMinor += row.spend_minor;
    total.impressions += row.impressions;
    total.linkClicks += row.link_clicks;
    total.spendMinor += row.spend_minor;
  }

  /* ---- CRM --------------------------------------------------------------- */

  for (const record of input.crmRecords ?? []) {
    if (!isProduction(record.traffic_kind)) {
      exclusions.crmRecords += 1;
      exclude(record.traffic_kind);
      continue;
    }
    const key = dimensionKey(record, dimension);
    if (!key) {
      exclusions.unattributedCrmRecords += 1;
      continue;
    }

    const date = utcDay(record.occurred_at);
    const [day, total] = bucketsFor(key, date);
    trackEarliest(day, record.occurred_at);
    trackEarliest(total, record.occurred_at);

    for (const bucket of [day, total]) {
      if (record.vq_scheduled) bucket.vqScheduled += 1;
      if (record.vq_attended) bucket.vqAttended += 1;
      if (record.qualified_vq) bucket.qualifiedVq += 1;
      if (record.opportunity) bucket.opportunities += 1;
      if (record.closed_won) bucket.closedWon += 1;
      bucket.revenueMinor += record.revenue_minor;
      bucket.confidences.push(record.attribution_confidence);
    }
  }

  /* ---- Finalise ---------------------------------------------------------- */

  const finalise = (bucket: Bucket): Rollup => {
    const counters = bucketCounters(bucket);
    const coverage = attributionCoverage(bucket.confidences);
    const cohortStartedAt = new Date(
      bucket.earliestAt === Number.MAX_SAFE_INTEGER ? Date.parse(input.now) : bucket.earliestAt,
    ).toISOString();

    const maturityAssessment = assessMaturity({
      cohortStartedAt,
      now: input.now,
      crmMaturityDays,
      observedOutcomes: counters.qualifiedVq + counters.opportunities + counters.closedWon,
      expectedLagDays: input.expectedLagDays,
    });

    const ctx: MetricContext = {
      crmMaturity: maturityAssessment.maturity,
      attributionCoverage: coverage,
      currency,
    };

    return {
      dimension,
      key: bucket.key,
      date: bucket.date,
      counters,
      metrics: computeAllMetrics(counters, ctx),
      attributionCoverage: coverage,
      attributedRecords: bucket.confidences.length,
      maturity: maturityAssessment.maturity,
      maturityAssessment,
      cohortStartedAt,
      currency,
    };
  };

  const dailyRollups = [...daily.values()]
    .map(finalise)
    .sort((a, b) => a.key.localeCompare(b.key) || (a.date ?? '').localeCompare(b.date ?? ''));

  const cumulativeRollups = [...cumulative.values()]
    .map(finalise)
    .sort((a, b) => a.key.localeCompare(b.key));

  return { dimension, daily: dailyRollups, cumulative: cumulativeRollups, exclusions };
}

/**
 * Sum a set of rollups into one counter set — for "all creatives of a campaign"
 * views. Rates are deliberately not summed; recompute them from the result.
 */
export function totalCounters(rollups: readonly Rollup[]): MetricCounters {
  return rollups.reduce<MetricCounters>((acc, r) => addCounters(acc, r.counters), emptyCounters());
}
