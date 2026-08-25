/**
 * `@am/experiments` — deterministic statistics, data maturity, metric
 * computation and rollups for the A&M Marketing OS.
 *
 * Everything in this package is pure: no I/O, no database, no clock, no React.
 * `now` is always an input, never `Date.now()`. That is what makes a
 * recommendation reproducible during an audit months later, and it is what lets
 * every rule in `@am/recommendations` be tested as a pure function.
 *
 * The model may explain what these numbers mean. It never produces one.
 */

export {
  // Special functions
  logGamma,
  logBeta,
  betacf,
  betainc,
  betaLogPdf,
  betaPdf,
  invBetainc,
  haltonPoint,
  // Posteriors
  betaPosterior,
  posteriorMean,
  posteriorVariance,
  credibleInterval,
  relativeLift,
  // Comparison
  comparePosteriors,
  probabilityBest,
  expectedLoss,
  // Constants
  DEFAULT_BETA_PRIOR,
  DEFAULT_QMC_DRAWS,
  QMC_ERROR_BOUND,
  type BetaParameters,
  type BetaPrior,
  type BetaPosterior,
  type BinaryObservation,
  type PosteriorComparison,
  type PosteriorComparisonOptions,
  type ProbabilityBestMethod,
} from './stats/beta-binomial';

export {
  mulberry32,
  medianOf,
  trimmedMeanOf,
  bootstrapStatistic,
  bootstrapMeanDifference,
  estimateRevenue,
  compareRevenue,
  DEFAULT_REVENUE_CONFIG,
  type RevenueConfig,
  type RevenueSample,
  type RevenueEstimate,
  type RevenueInterval,
  type RevenueComparison,
  type RevenueVerdict,
} from './stats/revenue';

export {
  assessMaturity,
  isMatureForDecision,
  weakestMaturity,
  MATURITY_ORDER,
  MILLISECONDS_PER_DAY,
  DEFAULT_PARTIAL_THRESHOLD,
  type MaturityInput,
  type MaturityAssessment,
} from './maturity';

export {
  computeMetric,
  computeAllMetrics,
  metricMaturity,
  metricAttributionCoverage,
  metricNumber,
  addCounters,
  sumCounters,
  emptyCounters,
  EMPTY_METRIC_COUNTERS,
  DEFAULT_METRIC_CONTEXT,
  type MetricCounters,
  type MetricContext,
  type MetricValueMap,
} from './metrics/compute';

export {
  evaluateExperiment,
  evaluateGuardrails,
  isGuardrailBreached,
  guardrailWarningCode,
  shouldConclude,
  BINARY_RATE_METRICS,
  REVENUE_METRICS,
  EXPERIMENT_REASON_CODES,
  EXPERIMENT_WARNING_CODES,
  EXPERIMENT_REASON_LABELS_DE,
  EXPERIMENT_WARNING_LABELS_DE,
  DEFAULT_MIN_ATTRIBUTION_COVERAGE,
  DEFAULT_MAX_TRAFFIC_IMBALANCE,
  type EvaluateExperimentInput,
  type ExperimentEvaluation,
  type ExperimentReasonCode,
  type ExperimentWarningCode,
  type GuardrailReading,
  type GuardrailBreach,
} from './evaluate';

export {
  computeRollups,
  totalCounters,
  utcDay,
  ROLLUP_DIMENSIONS,
  ROLLUP_DIMENSION_LABELS_DE,
  DEFAULT_CRM_MATURITY_DAYS,
  type RollupDimension,
  type RollupDimensionKeys,
  type RollupEvent,
  type RollupInsightRow,
  type RollupCrmRecord,
  type RollupInput,
  type Rollup,
  type RollupResult,
  type RollupExclusions,
} from './rollups';

export {
  analyzeFunnel,
  type FunnelAnalysisEvent,
  type FunnelAnalysisInput,
  type FunnelStepDefinition,
  type FunnelStepAnalysis,
  type FunnelAnalysis,
  type ValidationFailureBreakdown,
} from './funnel-analysis';
