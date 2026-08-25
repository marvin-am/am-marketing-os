import { z } from 'zod';
import {
  dataMaturitySchema,
  experimentKindSchema,
  experimentStateSchema,
  experimentVerdictSchema,
} from './enums';
import { specKeySchema, uuidSchema } from './ids';
import { metricKeySchema, rateSchema } from './metrics';
import { isoTimestampSchema } from './primitives';

/**
 * Decision thresholds (spec §20). Every one of these is editable in Settings —
 * the constants here are only the initial values, and the statistics engine
 * always reads the persisted configuration.
 */
export const experimentThresholdsSchema = z.object({
  minRuntimeDays: z.number().int().min(1).default(7),
  maxRuntimeDays: z.number().int().min(1).default(21),
  minSessionsPerArm: z.number().int().min(1).default(200),
  minConversionsPerArm: z.number().int().min(1).default(20),
  /** Posterior probability required to call a winner. */
  minWinProbability: z.number().min(0.5).max(0.9999).default(0.95),
  /** Minimum relative lift that is considered practically relevant. */
  minRelativeLift: z.number().min(0).max(10).default(0.1),
  /** Days a CRM cohort must age before its outcomes count as mature. */
  crmMaturityDays: z.number().int().min(0).max(365).default(21),
});
export type ExperimentThresholds = z.infer<typeof experimentThresholdsSchema>;

export const DEFAULT_EXPERIMENT_THRESHOLDS: ExperimentThresholds = {
  minRuntimeDays: 7,
  maxRuntimeDays: 21,
  minSessionsPerArm: 200,
  minConversionsPerArm: 20,
  minWinProbability: 0.95,
  minRelativeLift: 0.1,
  crmMaturityDays: 21,
};

export const experimentArmSchema = z.object({
  id: uuidSchema,
  experiment_id: uuidSchema,
  key: specKeySchema,
  label: z.string().min(1).max(120),
  is_control: z.boolean().default(false),
  /** Allocation weight. Frozen once the experiment is RUNNING. */
  allocation: z.number().min(0).max(1),
  creative_version_id: uuidSchema.nullable().default(null),
  funnel_version_id: uuidSchema.nullable().default(null),
  form_version_id: uuidSchema.nullable().default(null),
  created_at: isoTimestampSchema,
});
export type ExperimentArm = z.infer<typeof experimentArmSchema>;

export const experimentSchema = z.object({
  id: uuidSchema,
  campaign_id: uuidSchema,
  kind: experimentKindSchema,
  state: experimentStateSchema,
  name: z.string().min(1).max(200),
  hypothesis: z.string().min(10).max(1000),
  test_variable: z.string().min(1).max(200),
  primary_metric: metricKeySchema,
  secondary_metrics: z.array(metricKeySchema).default([]),
  guardrail_metrics: z.array(metricKeySchema).default([]),
  thresholds: experimentThresholdsSchema,
  /** Salt for deterministic assignment. Never changes once RUNNING. */
  assignment_salt: z.string().min(8).max(64),
  /** True when creative and funnel vary at the same time (spec §20). */
  bundled: z.boolean().default(false),
  /** True when qualification/eligibility logic changed between arms. */
  eligibility_changing: z.boolean().default(false),
  started_at: isoTimestampSchema.nullable().default(null),
  concluded_at: isoTimestampSchema.nullable().default(null),
  created_at: isoTimestampSchema,
});
export type Experiment = z.infer<typeof experimentSchema>;

/** Per-arm observation set fed into the statistics engine. */
export const armObservationSchema = z.object({
  arm_id: uuidSchema,
  arm_key: specKeySchema,
  label: z.string(),
  is_control: z.boolean(),
  sessions: z.number().int().min(0),
  exposures: z.number().int().min(0),
  conversions: z.number().int().min(0),
  spend_minor: z.number().int().min(0),
  /** CRM outcomes; may lag far behind conversions. */
  vq_scheduled: z.number().int().min(0).default(0),
  vq_attended: z.number().int().min(0).default(0),
  qualified_vq: z.number().int().min(0).default(0),
  opportunities: z.number().int().min(0).default(0),
  closed_won: z.number().int().min(0).default(0),
  revenue_minor: z.number().int().min(0).default(0),
  /** Share of the arm's records with EXACT/HIGH_CONFIDENCE attribution. */
  attribution_coverage: z.number().min(0).max(1).nullable().default(null),
});
export type ArmObservation = z.infer<typeof armObservationSchema>;

/** Result for one arm after Bayesian evaluation. */
export const armResultSchema = z.object({
  arm_id: uuidSchema,
  arm_key: specKeySchema,
  label: z.string(),
  is_control: z.boolean(),
  conversionRate: rateSchema,
  /** Posterior mean of the conversion rate. */
  posteriorMean: z.number(),
  credibleInterval: z.tuple([z.number(), z.number()]),
  /** P(this arm is the best of all arms). */
  probabilityBest: z.number().min(0).max(1),
  /** Relative lift vs. control; null for the control arm itself. */
  relativeLiftVsControl: z.number().nullable(),
  meetsMinSessions: z.boolean(),
  meetsMinConversions: z.boolean(),
});
export type ArmResult = z.infer<typeof armResultSchema>;

export const experimentResultSchema = z.object({
  experiment_id: uuidSchema,
  computed_at: isoTimestampSchema,
  primary_metric: metricKeySchema,
  arms: z.array(armResultSchema),
  verdict: experimentVerdictSchema,
  /** Only set when verdict is WINNER or PROVISIONAL. */
  winning_arm_id: uuidSchema.nullable().default(null),
  maturity: dataMaturitySchema,
  /** Machine-readable reasons behind the verdict, rendered in German by the UI. */
  reasons: z.array(z.string()).default([]),
  runtimeDays: z.number().min(0),
  totalSessions: z.number().int().min(0),
  totalConversions: z.number().int().min(0),
  /** Set when the design limits interpretability. */
  interpretationWarnings: z.array(z.string()).default([]),
  thresholds: experimentThresholdsSchema,
});
export type ExperimentResult = z.infer<typeof experimentResultSchema>;

export const EXPERIMENT_VERDICT_LABELS_DE: Readonly<
  Record<z.infer<typeof experimentVerdictSchema>, string>
> = {
  WINNER: 'Gewinner',
  PROVISIONAL: 'Vorläufig führend',
  NO_DIFFERENCE: 'Kein Unterschied',
  INCONCLUSIVE: 'Nicht eindeutig',
  INSUFFICIENT_DATA: 'Datenbasis zu klein',
};

export const DATA_MATURITY_LABELS_DE: Readonly<
  Record<z.infer<typeof dataMaturitySchema>, string>
> = {
  IMMATURE: 'Unreif',
  PARTIAL: 'Teilweise reif',
  MATURE: 'Reif',
};

export const EXPERIMENT_KIND_LABELS_DE: Readonly<
  Record<z.infer<typeof experimentKindSchema>, string>
> = {
  CREATIVE_EXPLORATION: 'Creative Exploration',
  FUNNEL_EXPERIMENT: 'Funnel-Experiment',
  BUNDLED_FUNNEL_TEST: 'Gebündelter Funnel-Test',
};

/**
 * Assignment record. Written server-side on first exposure so an arm survives
 * reload and return visits (acceptance criterion 11).
 */
export const experimentAssignmentSchema = z.object({
  experiment_id: uuidSchema,
  visitor_id: uuidSchema,
  arm_id: uuidSchema,
  assigned_at: isoTimestampSchema,
  /** Bucket value in [0,1) that produced this assignment — kept for audits. */
  bucket: z.number().min(0).max(1),
});
export type ExperimentAssignment = z.infer<typeof experimentAssignmentSchema>;

/**
 * Exposure record. Exactly one per actual render (acceptance criterion 12) —
 * assignment alone never produces an exposure.
 */
export const experimentExposureSchema = z.object({
  experiment_id: uuidSchema,
  visitor_id: uuidSchema,
  session_id: uuidSchema,
  arm_id: uuidSchema,
  exposed_at: isoTimestampSchema,
});
export type ExperimentExposure = z.infer<typeof experimentExposureSchema>;
