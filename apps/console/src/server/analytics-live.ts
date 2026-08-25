import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  asId,
  experimentSchema,
  experimentArmSchema,
  learningCardSchema,
  rate,
  type ArmObservation,
  type ExperimentThresholds,
  type IsoDate,
  type IsoTimestamp,
  type LearningCard,
} from '@am/domain';
import type {
  AmDatabase,
  CampaignRow,
  CreativeVersionRow,
  EventRow,
  ExperimentArmRow,
  ExperimentRow,
  LearningCardRow,
  PerformanceRollupRow,
  Uuid,
} from '@am/db';
import {
  MATURITY_ORDER,
  analyzeFunnel,
  assessMaturity,
  computeAllMetrics,
  emptyCounters,
  evaluateExperiment,
  sumCounters,
  ROLLUP_DIMENSIONS,
  type FunnelAnalysisEvent,
  type MaturityAssessment,
  type MetricContext,
  type MetricCounters,
  type RollupDimension,
} from '@am/experiments';
import { FUNNEL_KIND_LABELS_DE } from '@/components/analytics/labels';
import { workspaceResolver } from './workspace';
import type {
  AnalyticsPort,
  Breakdown,
  BreakdownRow,
  CampaignRef,
  CrmDelayStatement,
  DailyPoint,
  DateRange,
  ExperimentDetail,
  ExperimentSummary,
  FunnelDropOff,
  FunnelQuery,
  FunnelVersionRef,
  MetricSnapshot,
  PerformanceOverview,
  PerformanceQuery,
} from './analytics-port';

/**
 * `AnalyticsPort` over the daily rollups.
 *
 * The contract's first rule is that a page request never reaches a provider, and
 * this implementation keeps it structurally: the only tables it reads are
 * `performance_rollups`, the experiment aggregate, the learning cards and — for
 * the step-level drop-off alone — a bounded window of `events`. There is no Meta
 * client in this module and no code path that could acquire one.
 *
 * Two aggregation properties are carried over from `computeRollups`, because the
 * screens are built on them:
 *
 *  * **Rates are recomputed, never summed.** Counters are summed and every
 *    metric is derived from the sum by `computeAllMetrics`.
 *  * **A period is as mature as its least mature day.** A 30-day window ending
 *    today contains three weeks of cohorts whose CRM outcomes have not arrived;
 *    badging the whole window MATURE because it starts 30 days ago is exactly the
 *    misreading the maturity model exists to prevent.
 */

export interface LiveAnalyticsPortOptions {
  db: AmDatabase;
  /** Fallback workspace id when no workspace carries the console's slug. */
  workspaceId: string;
  /** Evaluation instant used when a query does not carry one. */
  now?: IsoTimestamp;
  /** Overrides the workspace's configured CRM maturity window. */
  crmMaturityDays?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * How many `events` rows the drop-off analysis will read.
 *
 * `listEvents` pages at 200 rows and the step analysis needs raw events, so an
 * unbounded read would be a full table scan on a render. The window is narrowed
 * to whatever this budget actually covered and the view says so — the
 * `windowTruncated` / `noteDe` fields exist for precisely this.
 */
const EVENT_PAGE_LIMIT = 200;
const EVENT_PAGE_BUDGET = 25;
/** Longest window the step analysis will even ask for. */
const EVENT_WINDOW_DAYS = 31;

/* -------------------------------------------------------------------------- */
/* Days                                                                        */
/* -------------------------------------------------------------------------- */

function dayIndexOf(iso: string): number {
  return Math.floor(Date.parse(iso) / MS_PER_DAY);
}

function isoDateOfDay(index: number): IsoDate {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

function startOfDayIso(date: IsoDate): IsoTimestamp {
  return `${date}T00:00:00.000Z`;
}

/* -------------------------------------------------------------------------- */
/* Rollup rows                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which grain a stored rollup row is at.
 *
 * The table holds a campaign row, a creative row and an arm row for the same
 * day; summing all of them would count the same spend several times. The row's
 * grain is its most specific non-null dimension, in the order the job writes
 * them, so every row belongs to exactly one breakdown and only the campaign
 * rows are ever totalled.
 */
type RollupGrain = RollupDimension | 'CAMPAIGN_VERSION' | 'EXPERIMENT' | 'UNATTRIBUTED';

function grainOf(row: PerformanceRollupRow): RollupGrain {
  if (row.experiment_arm_id) return 'EXPERIMENT_ARM';
  if (row.creative_version_id) return 'CREATIVE';
  if (row.funnel_version_id) return 'FUNNEL';
  if (row.experiment_id) return 'EXPERIMENT';
  if (row.campaign_version_id) return 'CAMPAIGN_VERSION';
  if (row.campaign_id) return 'CAMPAIGN';
  return 'UNATTRIBUTED';
}

function dimensionKeyOf(row: PerformanceRollupRow, dimension: RollupDimension): string | null {
  switch (dimension) {
    case 'CAMPAIGN':
      return row.campaign_id;
    case 'CREATIVE':
      return row.creative_version_id;
    case 'FUNNEL':
      return row.funnel_version_id;
    case 'EXPERIMENT_ARM':
      return row.experiment_arm_id;
  }
}

/**
 * Column set → `MetricCounters`.
 *
 * `bigint` columns arrive as strings through some drivers, so every field goes
 * through `Number` rather than being trusted to be numeric already. The two
 * columns without a counter — `reach` and `submissions` — have no metric in the
 * catalogue that reads them; `leads` is the accepted-submission counter the
 * catalogue uses.
 */
function countersOf(row: PerformanceRollupRow): MetricCounters {
  return {
    impressions: Number(row.impressions),
    linkClicks: Number(row.link_clicks),
    spendMinor: Number(row.spend_minor),
    funnelSessions: Number(row.funnel_sessions),
    formStarts: Number(row.form_starts),
    formStepViews: Number(row.form_views),
    formStepCompletions: Number(row.step_completions),
    leads: Number(row.leads),
    vqScheduled: Number(row.vq_scheduled),
    vqAttended: Number(row.vq_attended),
    qualifiedVq: Number(row.qualified_vq),
    opportunities: Number(row.opportunities),
    closedWon: Number(row.closed_won),
    revenueMinor: Number(row.revenue_minor),
  };
}

function outcomesOf(counters: MetricCounters): number {
  return counters.qualifiedVq + counters.opportunities + counters.closedWon;
}

/**
 * Attribution coverage over several rows.
 *
 * The rollup row stores the share but not the number of records it was computed
 * from, so the aggregate is weighted by `leads` — the accepted submissions are
 * the CRM records the share describes. Rows without a stored coverage are left
 * out of both the weight and the numerator instead of being read as zero
 * coverage, which would be a measured claim rather than a missing one.
 */
function coverageOf(rows: readonly PerformanceRollupRow[]): {
  coverage: number | null;
  records: number;
} {
  let weighted = 0;
  let records = 0;
  for (const row of rows) {
    if (row.attribution_coverage === null) continue;
    const weight = Number(row.leads);
    if (weight <= 0) continue;
    weighted += Number(row.attribution_coverage) * weight;
    records += weight;
  }
  return records > 0 ? { coverage: weighted / records, records } : { coverage: null, records: 0 };
}

function currencyOf(rows: readonly PerformanceRollupRow[]): string {
  return rows.find((row) => row.currency)?.currency ?? 'EUR';
}

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

export function createLiveAnalyticsPort(options: LiveAnalyticsPortOptions): AnalyticsPort {
  const { db } = options;
  const workspace = workspaceResolver(db, options.workspaceId);
  const resolveNow = (candidate?: IsoTimestamp): IsoTimestamp =>
    candidate ?? options.now ?? new Date().toISOString();

  /** The workspace's configured maturity window, read once per port instance. */
  let thresholds: Promise<ExperimentThresholds> | null = null;
  const experimentThresholds = (): Promise<ExperimentThresholds> => {
    thresholds ??= workspace().then((id) => db.settings.experimentThresholds(id));
    return thresholds;
  };

  const crmMaturityDays = async (): Promise<number> =>
    options.crmMaturityDays ?? (await experimentThresholds()).crmMaturityDays;

  const maturityFor = (
    cohortDate: IsoDate,
    now: IsoTimestamp,
    observedOutcomes: number,
    windowDays: number,
  ): MaturityAssessment =>
    assessMaturity({
      cohortStartedAt: startOfDayIso(cohortDate),
      now,
      crmMaturityDays: windowDays,
      observedOutcomes,
    });

  const groupByDay = (
    rows: readonly PerformanceRollupRow[],
  ): Map<string, PerformanceRollupRow[]> => {
    const grouped = new Map<string, PerformanceRollupRow[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.day);
      if (bucket) bucket.push(row);
      else grouped.set(row.day, [row]);
    }
    return grouped;
  };

  const snapshotOf = (
    rows: readonly PerformanceRollupRow[],
    now: IsoTimestamp,
    windowDays: number,
  ): MetricSnapshot => {
    const counters = sumCounters(rows.map(countersOf));
    const { coverage, records } = coverageOf(rows);
    const currency = currencyOf(rows);

    const byDay = groupByDay(rows);
    const days = [...byDay.keys()].sort();
    const cohortStartedAt = days.length > 0 ? startOfDayIso(days[0]) : now;

    let weakest: MaturityAssessment | null = null;
    for (const day of days) {
      const assessment = maturityFor(
        day,
        now,
        outcomesOf(sumCounters((byDay.get(day) ?? []).map(countersOf))),
        windowDays,
      );
      if (!weakest || MATURITY_ORDER[assessment.maturity] < MATURITY_ORDER[weakest.maturity]) {
        weakest = assessment;
      }
    }
    const maturityAssessment =
      weakest ??
      assessMaturity({
        cohortStartedAt,
        now,
        crmMaturityDays: windowDays,
        observedOutcomes: 0,
      });

    // A row the rollup job stamped IMMATURE is never upgraded by re-deriving the
    // age here: the weaker of the two verdicts wins.
    const stored = rows.reduce<MaturityAssessment['maturity']>(
      (weakestSoFar, row) =>
        MATURITY_ORDER[row.data_maturity] < MATURITY_ORDER[weakestSoFar]
          ? row.data_maturity
          : weakestSoFar,
      maturityAssessment.maturity,
    );

    const ctx: MetricContext = {
      crmMaturity: stored,
      attributionCoverage: coverage,
      currency,
    };

    return {
      counters,
      metrics: computeAllMetrics(counters, ctx),
      attributionCoverage: coverage,
      attributedRecords: records,
      maturity: stored,
      maturityAssessment,
      cohortStartedAt,
      currency,
    };
  };

  const emptySnapshot = (
    now: IsoTimestamp,
    cohortDate: IsoDate,
    windowDays: number,
  ): MetricSnapshot => {
    const assessment = maturityFor(cohortDate, now, 0, windowDays);
    const counters = emptyCounters();
    const ctx: MetricContext = {
      crmMaturity: assessment.maturity,
      attributionCoverage: null,
      currency: 'EUR',
    };
    return {
      counters,
      metrics: computeAllMetrics(counters, ctx),
      attributionCoverage: null,
      attributedRecords: 0,
      maturity: assessment.maturity,
      maturityAssessment: assessment,
      cohortStartedAt: startOfDayIso(cohortDate),
      currency: 'EUR',
    };
  };

  /** Every rollup row in the range, filtered to one campaign when asked. */
  const rowsInRange = async (query: PerformanceQuery): Promise<PerformanceRollupRow[]> => {
    const rows = await db.rollups.query({
      workspaceId: await workspace(),
      since: query.range.from,
      until: query.range.to,
    });
    if (!query.campaignId) return rows;
    // A finer-grain row that carries no campaign id cannot be attributed to the
    // selected campaign, so it is left out rather than assumed to belong.
    return rows.filter((row) => row.campaign_id === query.campaignId);
  };

  /* ---- Labels ------------------------------------------------------------ */

  const campaignsById = async (): Promise<Map<string, CampaignRow>> => {
    const page = await db.campaigns.list({
      workspaceId: await workspace(),
      includeArchived: true,
      limit: 200,
    });
    return new Map(page.rows.map((row) => [row.id, row]));
  };

  /**
   * German label for a funnel version.
   *
   * The kind lives on `funnels`, the number on `funnel_versions`, and the
   * filter and the breakdown both name the pair — so both rows are loaded and
   * the label is built in one place.
   */
  const funnelLabelsById = async (ids: readonly string[]): Promise<Map<string, string>> => {
    const entries = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const version = await db.funnels.getFunnelVersion(asId<Uuid>(id));
        if (!version) return [id, id] as const;
        const funnel = await db.funnels.getFunnel(version.funnel_id);
        return [
          id,
          funnel
            ? `${funnel.name} · ${FUNNEL_KIND_LABELS_DE[funnel.kind]} · Version ${version.version}`
            : `Version ${version.version}`,
        ] as const;
      }),
    );
    return new Map(entries);
  };

  const creativeVersionsById = async (
    ids: readonly string[],
  ): Promise<Map<string, CreativeVersionRow>> => {
    const entries = await Promise.all(
      [...new Set(ids)].map(
        async (id) => [id, await db.creatives.getVersion(asId<Uuid>(id))] as const,
      ),
    );
    return new Map(
      entries.filter((entry): entry is [string, CreativeVersionRow] => entry[1] !== null),
    );
  };

  /* ---- Experiments ------------------------------------------------------- */

  /**
   * Per-arm observations.
   *
   * `experiments.observations()` counts sessions, exposures, conversions and the
   * VQ states from the event and submission tables; it reports spend, deals and
   * revenue as zero because it does not read them. Those come from the arm-grain
   * rollups instead, so the evaluation sees the same numbers the dashboards show
   * rather than a second, quieter definition of them.
   */
  const observationsFor = async (
    experiment: ExperimentRow,
    arms: readonly ExperimentArmRow[],
  ): Promise<ArmObservation[]> => {
    const [counts, rollups] = await Promise.all([
      db.experiments.observations(experiment.id),
      workspace().then((id) => db.rollups.query({ workspaceId: id, dimension: 'experiment_arm' })),
    ]);

    const byArm = new Map<string, PerformanceRollupRow[]>();
    for (const row of rollups) {
      if (!row.experiment_arm_id) continue;
      const bucket = byArm.get(row.experiment_arm_id);
      if (bucket) bucket.push(row);
      else byArm.set(row.experiment_arm_id, [row]);
    }

    return arms.map((arm) => {
      const observed = counts.find((candidate) => candidate.arm_id === arm.id);
      const armRows = byArm.get(arm.id) ?? [];
      const counters = sumCounters(armRows.map(countersOf));
      const { coverage } = coverageOf(armRows);

      return {
        arm_id: arm.id,
        arm_key: arm.key,
        label: arm.label,
        is_control: arm.is_control,
        sessions: observed?.sessions ?? 0,
        exposures: observed?.exposures ?? 0,
        conversions: observed?.conversions ?? 0,
        spend_minor: counters.spendMinor,
        vq_scheduled: observed?.vq_scheduled ?? counters.vqScheduled,
        vq_attended: observed?.vq_attended ?? counters.vqAttended,
        qualified_vq: observed?.qualified_vq ?? counters.qualifiedVq,
        opportunities: counters.opportunities,
        closed_won: counters.closedWon,
        revenue_minor: counters.revenueMinor,
        attribution_coverage: coverage,
      };
    });
  };

  const toDomainExperiment = (row: ExperimentRow) =>
    experimentSchema.parse({
      id: row.id,
      campaign_id: row.campaign_id,
      kind: row.kind,
      state: row.state,
      name: row.name,
      hypothesis: row.hypothesis,
      test_variable: row.test_variable,
      primary_metric: row.primary_metric,
      secondary_metrics: row.secondary_metrics,
      guardrail_metrics: row.guardrail_metrics,
      thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS, ...row.thresholds },
      assignment_salt: row.assignment_salt,
      bundled: row.bundled,
      eligibility_changing: row.eligibility_changing,
      started_at: row.started_at,
      concluded_at: row.concluded_at,
      created_at: row.created_at,
    });

  const summaryFor = async (
    row: ExperimentRow,
    arms: readonly ExperimentArmRow[],
    campaigns: Map<string, CampaignRow>,
    now: IsoTimestamp,
  ): Promise<ExperimentSummary> => {
    const experiment = toDomainExperiment(row);
    const observations = await observationsFor(row, arms);
    const evaluation = evaluateExperiment({ experiment, observations, now });
    const domainArms = arms.map((arm) =>
      experimentArmSchema.parse({
        id: arm.id,
        experiment_id: arm.experiment_id,
        key: arm.key,
        label: arm.label,
        is_control: arm.is_control,
        allocation: arm.allocation,
        creative_version_id: arm.creative_version_id,
        funnel_version_id: arm.funnel_version_id,
        form_version_id: arm.form_version_id,
        created_at: arm.created_at,
      }),
    );
    const winning = evaluation.result.winning_arm_id
      ? domainArms.find((arm) => arm.id === evaluation.result.winning_arm_id)
      : undefined;

    return {
      experiment,
      arms: domainArms,
      evaluation,
      observations,
      campaignId: row.campaign_id,
      campaignLabelDe: campaigns.get(row.campaign_id)?.name ?? row.campaign_id,
      winningArmLabelDe: winning?.label ?? null,
    };
  };

  /* ---- Learning cards ---------------------------------------------------- */

  const toLearningCard = (row: LearningCardRow): LearningCard =>
    learningCardSchema.parse({
      id: row.id,
      version: row.version,
      campaign_id: row.campaign_id,
      experiment_id: row.experiment_id,
      created_at: row.created_at,
      titleDe: row.title_de,
      whatWasTestedDe: row.what_was_tested_de,
      angleName: row.angle_name,
      angle_id: row.angle_id,
      offerName: row.offer_name,
      offer_id: row.offer_id,
      creativeConceptDe: row.creative_concept_de,
      funnelKind: row.funnel_kind,
      audienceDe: row.audience_de,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      spendMinor: row.spend_minor,
      currency: row.currency,
      outcomeDe: row.outcome_de,
      outcomeFacts: row.outcome_facts ?? [],
      dataMaturity: row.data_maturity,
      attributionLevel: row.attribution_level,
      attributionCoverage: row.attribution_coverage,
      possibleExplanationDe: row.possible_explanation_de,
      suggestedNextTestDe: row.suggested_next_test_de,
      confidence: row.confidence,
    });

  /* ---- The port ---------------------------------------------------------- */

  return {
    async listCampaigns(): Promise<CampaignRef[]> {
      const [rows, campaigns] = await Promise.all([
        workspace().then((id) => db.rollups.query({ workspaceId: id, dimension: 'campaign' })),
        campaignsById(),
      ]);

      const spans = new Map<string, { first: IsoDate; last: IsoDate }>();
      for (const row of rows) {
        if (!row.campaign_id) continue;
        const existing = spans.get(row.campaign_id);
        if (!existing) spans.set(row.campaign_id, { first: row.day, last: row.day });
        else {
          if (row.day < existing.first) existing.first = row.day;
          if (row.day > existing.last) existing.last = row.day;
        }
      }

      return [...spans.entries()]
        .map(([id, span]) => ({
          id,
          labelDe: campaigns.get(id)?.name ?? id,
          firstDay: span.first,
          lastDay: span.last,
        }))
        .sort((a, b) => b.lastDay.localeCompare(a.lastDay));
    },

    async listFunnelVersions(): Promise<FunnelVersionRef[]> {
      const rows = await db.rollups.query({
        workspaceId: await workspace(),
        dimension: 'funnel_version',
      });
      const ids = rows.map((row) => row.funnel_version_id).filter((id): id is Uuid => id !== null);
      const labels = await funnelLabelsById(ids);
      return [...new Set(ids)].map((id) => ({ id, labelDe: labels.get(id) ?? id }));
    },

    async getPerformanceOverview(query: PerformanceQuery): Promise<PerformanceOverview> {
      const now = resolveNow(query.now);
      const windowDays = await crmMaturityDays();
      const rows = (await rowsInRange({ ...query, now })).filter(
        (row) => grainOf(row) === 'CAMPAIGN',
      );

      const from = dayIndexOf(query.range.from);
      const to = dayIndexOf(query.range.to);
      const byDay = groupByDay(rows);
      const series: DailyPoint[] = [];
      let matureDays = 0;
      let partialDays = 0;
      let immatureDays = 0;
      let weakest: MaturityAssessment | null = null;

      for (let index = from; index <= to; index++) {
        const date = isoDateOfDay(index);
        const dayRows = byDay.get(date) ?? [];
        const snapshot =
          dayRows.length > 0
            ? snapshotOf(dayRows, now, windowDays)
            : emptySnapshot(now, date, windowDays);
        series.push({ date, ...snapshot });

        const assessment = maturityFor(
          date,
          now,
          outcomesOf(sumCounters(dayRows.map(countersOf))),
          windowDays,
        );
        if (assessment.maturity === 'MATURE') matureDays += 1;
        else if (assessment.maturity === 'PARTIAL') partialDays += 1;
        else immatureDays += 1;
        if (!weakest || MATURITY_ORDER[assessment.maturity] < MATURITY_ORDER[weakest.maturity]) {
          weakest = assessment;
        }
      }

      const cutoffIndex = dayIndexOf(now) - windowDays;
      const crmDelay: CrmDelayStatement = {
        crmMaturityDays: windowDays,
        maturityCutoff:
          cutoffIndex >= from && cutoffIndex <= to ? isoDateOfDay(cutoffIndex + 1) : null,
        matureDays,
        partialDays,
        immatureDays,
        notYetMature: rate(partialDays + immatureDays, Math.max(0, to - from + 1)),
        reasonsDe: weakest?.reasonsDe ?? [],
      };

      return {
        range: query.range,
        currency: rows.length > 0 ? currencyOf(rows) : 'EUR',
        total:
          rows.length > 0
            ? snapshotOf(rows, now, windowDays)
            : emptySnapshot(now, query.range.to, windowDays),
        series,
        crmDelay,
        /* `performance_rollups` holds PRODUCTION traffic only and keeps no
           tally of what was dropped on the way in — the rollup job counts it
           and does not persist it. Zero would claim nothing was excluded. */
        exclusions: null,
      };
    },

    async getBreakdowns(query: PerformanceQuery): Promise<Breakdown[]> {
      const now = resolveNow(query.now);
      const windowDays = await crmMaturityDays();
      const rows = await rowsInRange({ ...query, now });

      const campaigns = await campaignsById();
      const creativeIds = rows
        .filter((row) => grainOf(row) === 'CREATIVE')
        .map((row) => row.creative_version_id)
        .filter((id): id is Uuid => id !== null);
      const funnelIds = rows
        .filter((row) => grainOf(row) === 'FUNNEL')
        .map((row) => row.funnel_version_id)
        .filter((id): id is Uuid => id !== null);
      const [creatives, funnels, armRows] = await Promise.all([
        creativeVersionsById(creativeIds),
        funnelLabelsById(funnelIds),
        (async () => {
          const armIds = [
            ...new Set(
              rows
                .filter((row) => grainOf(row) === 'EXPERIMENT_ARM')
                .map((row) => row.experiment_arm_id)
                .filter((id): id is Uuid => id !== null),
            ),
          ];
          if (armIds.length === 0) return new Map<string, ExperimentArmRow>();
          const experimentIds = [
            ...new Set(
              rows
                .filter((row) => grainOf(row) === 'EXPERIMENT_ARM')
                .map((row) => row.experiment_id)
                .filter((id): id is Uuid => id !== null),
            ),
          ];
          const byExperiment = await db.experiments.loadArmsForExperiments(experimentIds);
          return new Map(
            [...byExperiment.values()].flat().map((arm) => [arm.id, arm] as const),
          );
        })(),
      ]);

      return ROLLUP_DIMENSIONS.map((dimension) => {
        const groups = new Map<string, PerformanceRollupRow[]>();
        for (const row of rows) {
          if (grainOf(row) !== dimension) continue;
          const key = dimensionKeyOf(row, dimension);
          if (!key) continue;
          const bucket = groups.get(key);
          if (bucket) bucket.push(row);
          else groups.set(key, [row]);
        }

        const breakdownRows: BreakdownRow[] = [...groups.entries()].map(([key, groupRows]) => {
          const campaignId = groupRows.find((row) => row.campaign_id)?.campaign_id ?? null;
          const campaignLabel = campaignId ? (campaigns.get(campaignId)?.name ?? null) : null;

          let labelDe = key;
          let contextDe: string | null = campaignLabel;
          let experimentId: string | null = null;

          if (dimension === 'CAMPAIGN') {
            labelDe = campaigns.get(key)?.name ?? key;
            contextDe = null;
          } else if (dimension === 'CREATIVE') {
            const version = creatives.get(key);
            labelDe = version ? `Creative-Version ${version.version}` : key;
          } else if (dimension === 'FUNNEL') {
            labelDe = funnels.get(key) ?? key;
          } else {
            const arm = armRows.get(key);
            labelDe = arm?.label ?? key;
            experimentId = groupRows.find((row) => row.experiment_id)?.experiment_id ?? null;
          }

          return {
            dimension,
            key,
            labelDe,
            contextDe,
            experimentId,
            ...snapshotOf(groupRows, now, windowDays),
          };
        });

        breakdownRows.sort(
          (a, b) =>
            b.counters.spendMinor - a.counters.spendMinor || a.labelDe.localeCompare(b.labelDe),
        );
        return { dimension, rows: breakdownRows };
      });
    },

    async getFunnelDropOff(query: FunnelQuery): Promise<FunnelDropOff> {
      const requestedFrom = dayIndexOf(query.range.from);
      const requestedTo = dayIndexOf(query.range.to);
      const askedFrom = Math.max(requestedFrom, requestedTo - (EVENT_WINDOW_DAYS - 1));

      const events: EventRow[] = [];
      let exhausted = true;
      for (let page = 0; page < EVENT_PAGE_BUDGET; page++) {
        const result = await db.tracking.listEvents({
          workspaceId: await workspace(),
          campaignId: query.campaignId ? asId<Uuid>(query.campaignId) : undefined,
          from: startOfDayIso(isoDateOfDay(askedFrom)),
          to: `${isoDateOfDay(requestedTo)}T23:59:59.999Z`,
          limit: EVENT_PAGE_LIMIT,
          offset: page * EVENT_PAGE_LIMIT,
        });
        events.push(...result.rows);
        if (!result.hasMore) break;
        if (page === EVENT_PAGE_BUDGET - 1) exhausted = false;
      }

      // Default to the funnel version that actually carried form traffic — a
      // landing page has no steps to analyse.
      let funnelVersionId = query.funnelVersionId ?? null;
      if (!funnelVersionId) {
        const starts = new Map<string, number>();
        for (const event of events) {
          if (event.event_type !== 'form_started' || !event.funnel_version_id) continue;
          starts.set(event.funnel_version_id, (starts.get(event.funnel_version_id) ?? 0) + 1);
        }
        funnelVersionId =
          [...starts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
          null;
      }

      const selected = funnelVersionId
        ? events.filter((event) => event.funnel_version_id === funnelVersionId)
        : [];

      // The window the rows actually cover: the budget may have stopped short of
      // the requested start, and the view has to say so rather than imply that
      // the whole period was analysed.
      // Over every row read, not only the selected funnel's: the truncation is a
      // property of how far back the read reached, not of one funnel's traffic.
      const earliest = events.reduce<string | null>(
        (min, event) => (min === null || event.occurred_at < min ? event.occurred_at : min),
        null,
      );
      const coveredFrom = exhausted
        ? askedFrom
        : earliest
          ? dayIndexOf(earliest)
          : requestedTo;
      const window: DateRange = {
        from: isoDateOfDay(coveredFrom),
        to: isoDateOfDay(requestedTo),
      };
      const windowTruncated = coveredFrom > requestedFrom;

      const analysis = analyzeFunnel({
        events: selected.map(
          (event): FunnelAnalysisEvent => ({
            event_type: event.event_type,
            occurred_at: event.occurred_at,
            traffic_kind: event.traffic_kind,
            session_id: event.session_id,
            step_id: event.step_id,
            field_id: event.field_id,
            error_code: event.error_code,
            submission_id: event.submission_id,
          }),
        ),
      });

      const funnelLabels = funnelVersionId ? await funnelLabelsById([funnelVersionId]) : null;

      const stepLabelsDe: Record<string, string> = {};
      for (const step of analysis.steps) stepLabelsDe[step.stepKey] = step.label;

      return {
        analysis,
        window,
        windowTruncated,
        noteDe: windowTruncated
          ? `Ereignis-Rohdaten werden für diese Auswertung nur bis zu einem festen Umfang gelesen. Die Schritt-Analyse zeigt daher den Zeitraum ${window.from} bis ${window.to}, nicht den vollen gewählten Zeitraum.`
          : null,
        funnelVersionId,
        funnelLabelDe:
          funnelVersionId && funnelLabels
            ? (funnelLabels.get(funnelVersionId) ?? funnelVersionId)
            : 'Kein Funnel mit Formularverkehr',
        stepLabelsDe,
      };
    },

    async listExperiments(now: IsoTimestamp): Promise<ExperimentSummary[]> {
      const instant = resolveNow(now);
      const [rows, campaigns] = await Promise.all([
        workspace().then((id) => db.experiments.listByWorkspace(id)),
        campaignsById(),
      ]);
      const armsByExperiment = await db.experiments.loadArmsForExperiments(
        rows.map((row) => row.id),
      );

      const summaries = await Promise.all(
        rows.map((row) =>
          summaryFor(row, armsByExperiment.get(row.id) ?? [], campaigns, instant),
        ),
      );
      return summaries.sort((a, b) =>
        (b.experiment.started_at ?? '').localeCompare(a.experiment.started_at ?? ''),
      );
    },

    async getExperiment(id: string, now: IsoTimestamp): Promise<ExperimentDetail | null> {
      const instant = resolveNow(now);
      const row = await db.experiments.getById(asId<Uuid>(id));
      if (!row || row.workspace_id !== (await workspace())) return null;

      const [arms, campaigns, windowDays] = await Promise.all([
        db.experiments.listArms(row.id),
        campaignsById(),
        crmMaturityDays(),
      ]);
      const summary = await summaryFor(row, arms, campaigns, instant);

      const armRollups = await db.rollups.query({
        workspaceId: await workspace(),
        dimension: 'experiment_arm',
      });
      const armMetrics: Record<string, MetricSnapshot> = {};
      for (const arm of arms) {
        const rows = armRollups.filter((candidate) => candidate.experiment_arm_id === arm.id);
        armMetrics[arm.id] =
          rows.length > 0
            ? snapshotOf(rows, instant, windowDays)
            : emptySnapshot(instant, instant.slice(0, 10), windowDays);
      }

      return { ...summary, armMetrics };
    },

    async listLearningCards(): Promise<LearningCard[]> {
      const page = await db.learningCards.list({ workspaceId: await workspace(), limit: 200 });
      return page.rows
        .map(toLearningCard)
        .sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''));
    },
  };
}
