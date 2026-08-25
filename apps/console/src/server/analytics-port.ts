import type {
  ArmObservation,
  DataMaturity,
  Experiment,
  ExperimentArm,
  IsoDate,
  IsoTimestamp,
  LearningCard,
  Rate,
} from '@am/domain';
import type {
  ExperimentEvaluation,
  FunnelAnalysis,
  MaturityAssessment,
  MetricCounters,
  MetricValueMap,
  RollupDimension,
  RollupExclusions,
} from '@am/experiments';

/**
 * The read port behind Performance, Experimente and Learnings.
 *
 * Three properties are contractual, not conventions — every implementation must
 * uphold them and every screen in these three areas relies on them:
 *
 * 1. **Rollups only, never a provider call.** A page request reads pre-aggregated
 *    rows. Nothing here may reach out to Meta or HubSpot: an insights call on a
 *    page render turns a dashboard into a rate-limit incident and makes the
 *    numbers depend on when somebody hit reload.
 * 2. **Every number arrives as a `MetricValue`, never as a bare number.** The
 *    envelope carries numerator, denominator, maturity and attribution coverage,
 *    which is what lets the console render "3,5 % · 12 / 340" and never "3,5 %"
 *    on its own. A zero denominator arrives as `value: null` — never `0`.
 * 3. **Maturity and coverage travel with the counters they qualify.** A ROAS is
 *    only ever rendered together with how mature its cohort is and how much of
 *    its revenue could actually be attributed.
 *
 * The console never computes a statistic itself. Implementations derive metrics
 * with `computeAllMetrics`, maturity with `assessMaturity`, coverage with
 * `attributionCoverage`, funnel steps with `analyzeFunnel` and verdicts with
 * `evaluateExperiment` — all from `@am/experiments` / `@am/domain`. The intended
 * production implementation aggregates `tracking_events`, Meta insights rows and
 * attributed CRM outcomes through `computeRollups` and caches the result; the
 * fixture in `analytics-fixtures.ts` produces the same shapes from a
 * deterministic simulation.
 */

/* -------------------------------------------------------------------------- */
/* Query shapes                                                                */
/* -------------------------------------------------------------------------- */

/** An inclusive range of UTC days. `from` and `to` are `YYYY-MM-DD`. */
export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export interface PerformanceQuery {
  range: DateRange;
  /** Restrict every figure to one campaign. `null` means the whole account. */
  campaignId?: string | null;
  /** Evaluation instant. Drives maturity; never read from a clock downstream. */
  now: IsoTimestamp;
}

export interface FunnelQuery extends PerformanceQuery {
  /** Restrict the step analysis to one funnel version. `null` means all. */
  funnelVersionId?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Result shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One set of counters plus everything needed to qualify them. Structurally a
 * superset-compatible view of `Rollup` from `@am/experiments`, so an
 * implementation backed by `computeRollups` can return its rollups unchanged.
 */
export interface MetricSnapshot {
  counters: MetricCounters;
  metrics: MetricValueMap;
  /** Share of the underlying CRM records with EXACT/HIGH_CONFIDENCE matching. */
  attributionCoverage: number | null;
  /** How many CRM records that share was computed from. */
  attributedRecords: number;
  maturity: DataMaturity;
  maturityAssessment: MaturityAssessment;
  cohortStartedAt: IsoTimestamp;
  currency: string;
}

/** One point of a daily time series. Rates are recomputed per day, never summed. */
export interface DailyPoint extends MetricSnapshot {
  date: IsoDate;
}

/** One row of a breakdown by campaign, creative, funnel version or arm. */
export interface BreakdownRow extends MetricSnapshot {
  dimension: RollupDimension;
  /** The dimension's id — campaign id, creative version id, arm id, … */
  key: string;
  labelDe: string;
  /** German context line: the campaign of a creative, the experiment of an arm. */
  contextDe: string | null;
  /** Set for EXPERIMENT_ARM rows so the console can link to the experiment. */
  experimentId?: string | null;
}

export interface Breakdown {
  dimension: RollupDimension;
  /** Sorted by spend, descending. */
  rows: BreakdownRow[];
}

/**
 * Which part of the selected period cannot be mature yet.
 *
 * Rendered verbatim above the CRM-delayed tiles. Without it, a period whose last
 * three weeks have not produced their qualified VQs yet reads as a collapse in
 * performance rather than as data that has not arrived.
 */
export interface CrmDelayStatement {
  /** Configured maturity window in days. */
  crmMaturityDays: number;
  /**
   * Cohorts acquired on or after this day cannot be mature yet. Null when the
   * whole selected period already lies outside the window.
   */
  maturityCutoff: IsoDate | null;
  matureDays: number;
  partialDays: number;
  immatureDays: number;
  /** Days of the period whose CRM outcomes are not fully in, over all days. */
  notYetMature: Rate;
  /** German sentences from `assessMaturity`, rendered as written. */
  reasonsDe: string[];
}

export interface PerformanceOverview {
  range: DateRange;
  currency: string;
  /** Counters and metrics for the whole selection. */
  total: MetricSnapshot;
  /** One point per UTC day in the range, including days with no activity. */
  series: DailyPoint[];
  crmDelay: CrmDelayStatement;
  /** Rows excluded before anything was counted — preview, bot, internal, test. */
  exclusions: RollupExclusions;
}

export interface FunnelDropOff {
  analysis: FunnelAnalysis;
  /**
   * The window the raw events actually cover. Event-level data has a shorter
   * retention than the aggregated rollups, so this can be narrower than the
   * selected range — the console says so rather than implying full coverage.
   */
  window: DateRange;
  windowTruncated: boolean;
  /** German explanation of the truncation. Null when the range is fully covered. */
  noteDe: string | null;
  funnelVersionId: string | null;
  funnelLabelDe: string;
  /** German step labels in declared order, for the analysis' step keys. */
  stepLabelsDe: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExperimentSummary {
  experiment: Experiment;
  arms: ExperimentArm[];
  /** The full evaluation from `evaluateExperiment` — verdict, reasons, warnings. */
  evaluation: ExperimentEvaluation;
  /**
   * The raw per-arm observations the evaluation was computed from. Carried on
   * the summary too, because "what is still missing and by how much" cannot be
   * stated without the arms' session counts.
   */
  observations: ArmObservation[];
  campaignId: string;
  campaignLabelDe: string;
  /** German label of the winning arm, or null when there is no winner. */
  winningArmLabelDe: string | null;
}

export interface ExperimentDetail extends ExperimentSummary {
  /** Per-arm metric envelopes, keyed by arm id. Same catalogue as everywhere. */
  armMetrics: Record<string, MetricSnapshot>;
}

/* -------------------------------------------------------------------------- */
/* References                                                                  */
/* -------------------------------------------------------------------------- */

export interface CampaignRef {
  id: string;
  labelDe: string;
  /** First and last day the campaign delivered, for the range hint. */
  firstDay: IsoDate;
  lastDay: IsoDate;
}

export interface FunnelVersionRef {
  id: string;
  labelDe: string;
}

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

export interface AnalyticsPort {
  /** Campaigns that produced at least one delivery row, newest first. */
  listCampaigns(): Promise<CampaignRef[]>;
  /** Published funnel versions that received traffic. */
  listFunnelVersions(): Promise<FunnelVersionRef[]>;

  getPerformanceOverview(query: PerformanceQuery): Promise<PerformanceOverview>;
  /**
   * All four breakdowns in one call — campaign, creative, funnel version and
   * experiment arm. One call rather than four so an implementation can read them
   * from a single scan.
   */
  getBreakdowns(query: PerformanceQuery): Promise<Breakdown[]>;
  getFunnelDropOff(query: FunnelQuery): Promise<FunnelDropOff>;

  listExperiments(now: IsoTimestamp): Promise<ExperimentSummary[]>;
  getExperiment(id: string, now: IsoTimestamp): Promise<ExperimentDetail | null>;

  listLearningCards(): Promise<LearningCard[]>;
}
