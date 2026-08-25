import {
  type ArmObservation,
  attributionCoverage,
  type AttributionConfidence,
  type ConfidenceLabel,
  type DataMaturity,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  deriveConfidence,
  type Experiment,
  type ExperimentArm,
  type ExperimentThresholds,
  type FunnelKind,
  type IsoDate,
  type IsoTimestamp,
  type LearningCard,
  type TrafficKind,
  type ValidationErrorCode,
  rate,
} from '@am/domain';
import {
  analyzeFunnel,
  assessMaturity,
  computeAllMetrics,
  computeRollups,
  emptyCounters,
  evaluateExperiment,
  type ExperimentEvaluation,
  type FunnelAnalysisEvent,
  type FunnelStepDefinition,
  MATURITY_ORDER,
  type MaturityAssessment,
  type MaturityInput,
  type MetricContext,
  type MetricCounters,
  mulberry32,
  ROLLUP_DIMENSIONS,
  type RollupCrmRecord,
  type RollupDimension,
  type RollupEvent,
  type RollupExclusions,
  type RollupInsightRow,
  sumCounters,
} from '@am/experiments';
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
 * Deterministic fixture implementation of {@link AnalyticsPort}.
 *
 * `DEMO_MODE` routes every provider through fixtures (AGENTS.md), and until the
 * rollup tables exist this is the only implementation. Two commitments make it
 * usable as a stand-in rather than as decoration:
 *
 * - **It is deterministic given `now`.** Every figure comes out of a seeded
 *   generator keyed by day, campaign, creative, funnel version and arm. The same
 *   `now` produces byte-identical output, which is what makes the screens
 *   testable.
 * - **It never invents a statistic.** The simulation produces raw counters — the
 *   things a database actually stores. Every rate, cost-per-unit, maturity
 *   assessment, funnel step and experiment verdict on top of them is computed by
 *   `@am/experiments` and `@am/domain`, exactly as the production implementation
 *   will compute them.
 *
 * The simulation is aggregated to daily cells rather than to raw events: 18
 * months of per-session events would be hundreds of thousands of rows per page
 * request. Cells are the shape a rollup table holds anyway. The one place raw
 * events are genuinely needed — step-level drop-off and validation failures — is
 * generated for a bounded window and fed through `analyzeFunnel` and
 * `computeRollups`, which is also why that view states its own shorter window.
 */

/* -------------------------------------------------------------------------- */
/* Time helpers                                                                */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;

/** Whole UTC days since the epoch. Rollup days are UTC everywhere. */
function dayIndexOf(iso: string): number {
  return Math.floor(Date.parse(iso) / MS_PER_DAY);
}

function isoDateOfDay(index: number): IsoDate {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

function startOfDayIso(date: IsoDate): IsoTimestamp {
  return `${date}T00:00:00.000Z`;
}

function addDays(date: IsoDate, days: number): IsoDate {
  return isoDateOfDay(dayIndexOf(date) + days);
}

/* -------------------------------------------------------------------------- */
/* Seeded generation                                                           */
/* -------------------------------------------------------------------------- */

/** FNV-1a over UTF-16 code units. Used only to seed the generator. */
function seedFrom(parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  const input = parts.join('|');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function between(random: () => number, low: number, high: number): number {
  return low + random() * (high - low);
}

/**
 * Share of a cohort's eventual CRM outcomes that has arrived after `ageDays`.
 * Saturating and slightly front-loaded — most VQs are booked in the first days,
 * the tail is deals.
 */
/**
 * Rounds without a systematic bias.
 *
 * Per-cell CRM expectations are fractions — a single day of one creative on one
 * funnel expects 0.07 closed deals. `Math.round` turns every one of them into
 * zero, and eighteen months of a real business then shows no revenue at all.
 * Rounding up or down in proportion to the fraction keeps the expectation and
 * stays deterministic, because the generator is seeded.
 */
function roundStochastic(value: number, random: () => number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const floor = Math.floor(value);
  return floor + (random() < value - floor ? 1 : 0);
}

function realisedShare(ageDays: number, spanDays: number): number {
  if (ageDays <= 0) return 0;
  if (ageDays >= spanDays) return 1;
  return Math.min(1, Math.pow(ageDays / spanDays, 0.72));
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

interface FixtureCreative {
  id: string;
  labelDe: string;
  /** Relative share of the campaign's daily spend. */
  weight: number;
  /** Multiplier on the campaign's baseline CTR. */
  ctrFactor: number;
  /** Multiplier on the campaign's baseline submission rate. */
  conversionFactor: number;
}

interface FixtureFunnelVersion {
  id: string;
  labelDe: string;
  kind: FunnelKind;
  steps: FunnelStepDefinition[];
  /** Multiplier on the campaign's baseline form-start rate. */
  formStartFactor: number;
  /** Multiplier on the campaign's baseline submission rate. */
  submissionFactor: number;
}

interface FixtureCampaign {
  id: string;
  labelDe: string;
  /** Day offsets relative to `now`; both inclusive, `0` is today. */
  startOffset: number;
  endOffset: number;
  dailySpendMinor: [number, number];
  cpmMinor: [number, number];
  ctr: [number, number];
  landingRate: number;
  formStartRate: number;
  submissionRate: number;
  vqScheduledRate: number;
  showRate: number;
  qualifiedRate: number;
  opportunityRate: number;
  closeRate: number;
  dealValueMinor: number;
  /** Weights over EXACT, HIGH, MEDIUM, LOW, UNKNOWN attribution. */
  confidenceMix: [number, number, number, number, number];
  creativeIds: string[];
  /** Funnel versions rotated through when no experiment is running. */
  funnelVersionIds: string[];
}

const FORM_STEPS_SHORT: FunnelStepDefinition[] = [
  { key: 'unternehmensgroesse', label: 'Unternehmensgröße' },
  { key: 'herausforderung', label: 'Größte Herausforderung' },
  { key: 'zeitraum', label: 'Zeitraum' },
  { key: 'kontakt', label: 'Kontaktdaten' },
];

const FORM_STEPS_LONG: FunnelStepDefinition[] = [
  { key: 'branche', label: 'Branche' },
  { key: 'unternehmensgroesse', label: 'Unternehmensgröße' },
  { key: 'herausforderung', label: 'Größte Herausforderung' },
  { key: 'budget', label: 'Budgetrahmen' },
  { key: 'zeitraum', label: 'Zeitraum' },
  { key: 'kontakt', label: 'Kontaktdaten' },
];

const FORM_STEPS_GATE: FunnelStepDefinition[] = [
  { key: 'qualifikation', label: 'Qualifizierungsfrage' },
  ...FORM_STEPS_SHORT,
];

const FUNNEL_VERSIONS: FixtureFunnelVersion[] = [
  {
    id: 'fv-landingpage-kurz-v3',
    labelDe: 'Landingpage kurz (v3)',
    kind: 'LANDING_PAGE',
    steps: [{ key: 'kontakt', label: 'Kontaktdaten' }],
    formStartFactor: 1.18,
    submissionFactor: 0.86,
  },
  {
    id: 'fv-formular-4-schritte-v5',
    labelDe: 'Multi-Step-Formular, 4 Schritte (v5)',
    kind: 'MULTI_STEP_FORM',
    steps: FORM_STEPS_SHORT,
    formStartFactor: 1.0,
    submissionFactor: 1.0,
  },
  {
    id: 'fv-formular-6-schritte-v2',
    labelDe: 'Multi-Step-Formular, 6 Schritte (v2)',
    kind: 'MULTI_STEP_FORM',
    steps: FORM_STEPS_LONG,
    formStartFactor: 0.94,
    submissionFactor: 0.7,
  },
  {
    id: 'fv-hybrid-v4',
    labelDe: 'Hybrid: Landingpage + Formular (v4)',
    kind: 'HYBRID',
    steps: FORM_STEPS_SHORT,
    formStartFactor: 1.06,
    submissionFactor: 1.46,
  },
  {
    id: 'fv-formular-gate-v1',
    labelDe: 'Multi-Step mit Qualifizierungs-Gate (v1)',
    kind: 'MULTI_STEP_FORM',
    steps: FORM_STEPS_GATE,
    formStartFactor: 0.88,
    submissionFactor: 0.86,
  },
];

/**
 * Per-step retention derived from the funnel's overall form-completion rate.
 *
 * The weights rise with the step index — later steps ask for more and lose more —
 * and the exponents sum to one, so the chain multiplies out to exactly the
 * overall completion rate. That is what keeps the step analysis consistent with
 * the lead count above it instead of telling two different stories.
 */
function stepKeepRates(stepCount: number, overall: number): number[] {
  if (stepCount <= 0) return [];
  if (overall <= 0) return new Array<number>(stepCount).fill(0);
  const weights = Array.from({ length: stepCount }, (_, index) => 1 + 0.25 * index);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => Math.pow(Math.min(1, overall), weight / total));
}

interface StepChainEntry {
  viewed: number;
  completed: number;
}

function buildStepChain(
  formStarts: number,
  stepCount: number,
  targetLeads: number,
): StepChainEntry[] {
  const overall = formStarts > 0 ? Math.min(1, targetLeads / formStarts) : 0;
  const keeps = stepKeepRates(stepCount, overall);
  const chain: StepChainEntry[] = [];
  let reaching = formStarts;
  for (let index = 0; index < stepCount; index++) {
    const completed = Math.min(reaching, Math.round(reaching * keeps[index]));
    chain.push({ viewed: reaching, completed });
    reaching = completed;
  }
  return chain;
}

const CREATIVES: FixtureCreative[] = [
  {
    id: 'cv-problem-statisch-45',
    labelDe: 'Problem/Pain – statisch 4:5',
    weight: 0.34,
    ctrFactor: 1.0,
    conversionFactor: 0.96,
  },
  {
    id: 'cv-ergebnis-video-916',
    labelDe: 'Konkretes Ergebnis – Video 9:16',
    weight: 0.38,
    ctrFactor: 1.22,
    conversionFactor: 1.12,
  },
  {
    id: 'cv-kundenstimme-11',
    labelDe: 'Kundenstimme – statisch 1:1',
    weight: 0.28,
    ctrFactor: 0.87,
    conversionFactor: 1.04,
  },
  {
    id: 'cv-vergleich-karussell',
    labelDe: 'Vergleich Alternative – Karussell',
    weight: 0.31,
    ctrFactor: 0.94,
    conversionFactor: 0.9,
  },
  {
    id: 'cv-einwand-video-45',
    labelDe: 'Einwandbehandlung – Video 4:5',
    weight: 0.33,
    ctrFactor: 1.08,
    conversionFactor: 1.06,
  },
  {
    id: 'cv-kontraintuitiv-statisch',
    labelDe: 'Kontraintuitive These – statisch 4:5',
    weight: 0.36,
    ctrFactor: 1.15,
    conversionFactor: 0.94,
  },
  {
    id: 'cv-zahlenbeleg-11',
    labelDe: 'Datenpunkt/Beleg – statisch 1:1',
    weight: 0.3,
    ctrFactor: 0.92,
    conversionFactor: 1.09,
  },
  {
    id: 'cv-kurzumfrage-video',
    labelDe: 'Kurzumfrage – Video 9:16',
    weight: 0.5,
    ctrFactor: 1.05,
    conversionFactor: 0.98,
  },
  {
    id: 'cv-kurzumfrage-statisch',
    labelDe: 'Kurzumfrage – statisch 4:5',
    weight: 0.5,
    ctrFactor: 0.95,
    conversionFactor: 1.02,
  },
];

const CREATIVE_BY_ID = new Map(CREATIVES.map((c) => [c.id, c]));
const FUNNEL_BY_ID = new Map(FUNNEL_VERSIONS.map((f) => [f.id, f]));

const CAMPAIGNS: FixtureCampaign[] = [
  {
    id: 'cmp-erstgespraech-2025',
    labelDe: 'Erstgespräch Prozesskosten 2025',
    startOffset: -540,
    endOffset: -404,
    dailySpendMinor: [18_000, 34_000],
    cpmMinor: [1_780, 2_680],
    ctr: [0.0098, 0.0172],
    landingRate: 0.83,
    formStartRate: 0.126,
    submissionRate: 0.0248,
    vqScheduledRate: 0.52,
    showRate: 0.68,
    qualifiedRate: 0.55,
    opportunityRate: 0.46,
    closeRate: 0.24,
    dealValueMinor: 1_180_000,
    confidenceMix: [0.38, 0.14, 0.24, 0.18, 0.06],
    creativeIds: ['cv-problem-statisch-45', 'cv-ergebnis-video-916', 'cv-kundenstimme-11'],
    funnelVersionIds: ['fv-formular-6-schritte-v2', 'fv-landingpage-kurz-v3'],
  },
  {
    id: 'cmp-prozesskosten-analyse',
    labelDe: 'Prozesskosten-Analyse Mittelstand',
    startOffset: -455,
    endOffset: -286,
    dailySpendMinor: [24_000, 46_000],
    cpmMinor: [1_860, 2_820],
    ctr: [0.0104, 0.0188],
    landingRate: 0.85,
    formStartRate: 0.138,
    submissionRate: 0.0286,
    vqScheduledRate: 0.57,
    showRate: 0.71,
    qualifiedRate: 0.58,
    opportunityRate: 0.49,
    closeRate: 0.26,
    dealValueMinor: 1_340_000,
    confidenceMix: [0.51, 0.16, 0.18, 0.11, 0.04],
    creativeIds: ['cv-ergebnis-video-916', 'cv-vergleich-karussell', 'cv-kontraintuitiv-statisch'],
    funnelVersionIds: ['fv-formular-4-schritte-v5', 'fv-formular-6-schritte-v2'],
  },
  {
    id: 'cmp-nachfolge-beratung',
    labelDe: 'Nachfolgeberatung Mittelstand',
    startOffset: -320,
    endOffset: -104,
    dailySpendMinor: [26_000, 52_000],
    cpmMinor: [1_940, 2_960],
    ctr: [0.0112, 0.0196],
    landingRate: 0.86,
    formStartRate: 0.145,
    submissionRate: 0.0304,
    vqScheduledRate: 0.6,
    showRate: 0.73,
    qualifiedRate: 0.61,
    opportunityRate: 0.51,
    closeRate: 0.28,
    dealValueMinor: 1_560_000,
    confidenceMix: [0.63, 0.17, 0.12, 0.06, 0.02],
    creativeIds: ['cv-kontraintuitiv-statisch', 'cv-einwand-video-45', 'cv-zahlenbeleg-11'],
    funnelVersionIds: ['fv-formular-4-schritte-v5', 'fv-formular-6-schritte-v2'],
  },
  {
    id: 'cmp-foerdermittel-check',
    labelDe: 'Fördermittel-Check 2026',
    startOffset: -165,
    endOffset: 0,
    dailySpendMinor: [32_000, 58_000],
    cpmMinor: [2_060, 3_180],
    ctr: [0.0118, 0.0212],
    landingRate: 0.88,
    formStartRate: 0.152,
    submissionRate: 0.0322,
    vqScheduledRate: 0.63,
    showRate: 0.75,
    qualifiedRate: 0.63,
    opportunityRate: 0.53,
    closeRate: 0.29,
    dealValueMinor: 1_720_000,
    confidenceMix: [0.79, 0.11, 0.06, 0.03, 0.01],
    creativeIds: ['cv-einwand-video-45', 'cv-zahlenbeleg-11', 'cv-ergebnis-video-916'],
    funnelVersionIds: ['fv-formular-4-schritte-v5', 'fv-hybrid-v4'],
  },
  {
    id: 'cmp-kurzumfrage-kostenstruktur',
    labelDe: 'Kurzumfrage Kostenstruktur (Test)',
    startOffset: -6,
    endOffset: 0,
    dailySpendMinor: [14_000, 19_000],
    cpmMinor: [2_020, 3_040],
    ctr: [0.0106, 0.0178],
    landingRate: 0.86,
    formStartRate: 0.144,
    submissionRate: 0.0298,
    vqScheduledRate: 0.58,
    showRate: 0.72,
    qualifiedRate: 0.6,
    opportunityRate: 0.5,
    closeRate: 0.27,
    dealValueMinor: 1_640_000,
    confidenceMix: [0.8, 0.1, 0.06, 0.03, 0.01],
    creativeIds: ['cv-kurzumfrage-video', 'cv-kurzumfrage-statisch'],
    funnelVersionIds: ['fv-formular-4-schritte-v5'],
  },
];

const CAMPAIGN_BY_ID = new Map(CAMPAIGNS.map((c) => [c.id, c]));

const CONFIDENCE_ORDER: readonly AttributionConfidence[] = [
  'EXACT',
  'HIGH_CONFIDENCE',
  'MEDIUM_CONFIDENCE',
  'LOW_CONFIDENCE',
  'UNKNOWN',
];

/* -------------------------------------------------------------------------- */
/* Experiment catalogue                                                        */
/* -------------------------------------------------------------------------- */

interface FixtureArm {
  id: string;
  key: string;
  labelDe: string;
  isControl: boolean;
  allocation: number;
  funnelVersionId: string;
  /** Pins the lane to one creative — used by CREATIVE_EXPLORATION. */
  creativeVersionId: string | null;
  /** Multiplier on the campaign's baseline submission rate for this lane. */
  conversionFactor: number;
}

interface FixtureExperiment {
  id: string;
  campaignId: string;
  kind: Experiment['kind'];
  state: Experiment['state'];
  nameDe: string;
  hypothesisDe: string;
  testVariableDe: string;
  primaryMetric: Experiment['primary_metric'];
  secondaryMetrics: Experiment['secondary_metrics'];
  guardrailMetrics: Experiment['guardrail_metrics'];
  bundled: boolean;
  eligibilityChanging: boolean;
  /** Day offsets of the exposure window, both inclusive. */
  startOffset: number;
  endOffset: number;
  /** Day offset at which the verdict was computed. `null` means "as of now". */
  concludedOffset: number | null;
  thresholds: ExperimentThresholds;
}

const LONG_RUNNING_THRESHOLDS: ExperimentThresholds = {
  ...DEFAULT_EXPERIMENT_THRESHOLDS,
  maxRuntimeDays: 35,
};

const EXPERIMENTS: FixtureExperiment[] = [
  {
    id: 'exp-formular-kurz-vs-lang',
    campaignId: 'cmp-nachfolge-beratung',
    kind: 'FUNNEL_EXPERIMENT',
    state: 'CONCLUDED',
    nameDe: 'Kurzes vs. langes Formular',
    hypothesisDe:
      'Ein Formular mit vier statt sechs Schritten erhöht die Submission-Rate, ohne die Qualifizierungsquote der Leads zu senken.',
    testVariableDe: 'Anzahl der Formularschritte',
    primaryMetric: 'submission_rate',
    secondaryMetrics: ['form_start_rate', 'cpl'],
    guardrailMetrics: ['qualified_vq_rate'],
    bundled: false,
    eligibilityChanging: false,
    startOffset: -250,
    endOffset: -226,
    concludedOffset: -220,
    thresholds: LONG_RUNNING_THRESHOLDS,
  },
  {
    id: 'exp-qualifizierungs-gate',
    campaignId: 'cmp-nachfolge-beratung',
    kind: 'FUNNEL_EXPERIMENT',
    state: 'CONCLUDED',
    nameDe: 'Qualifizierungs-Gate vor dem Formular',
    hypothesisDe:
      'Eine vorgeschaltete Qualifizierungsfrage senkt die Zahl der Leads, hebt aber die Qualifizierungsquote so weit an, dass die Kosten je qualifiziertem VQ sinken.',
    testVariableDe: 'Vorgeschaltetes Qualifizierungs-Gate',
    primaryMetric: 'submission_rate',
    secondaryMetrics: ['qualified_vq_rate', 'cost_per_qualified_vq'],
    guardrailMetrics: ['cpl'],
    bundled: false,
    eligibilityChanging: true,
    startOffset: -140,
    endOffset: -120,
    concludedOffset: -112,
    thresholds: LONG_RUNNING_THRESHOLDS,
  },
  {
    id: 'exp-bundle-angebot-hybrid',
    campaignId: 'cmp-foerdermittel-check',
    kind: 'BUNDLED_FUNNEL_TEST',
    state: 'RUNNING',
    nameDe: 'Neues Angebot im Hybrid-Funnel',
    hypothesisDe:
      'Das neue Angebot im Hybrid-Funnel erhöht die Submission-Rate gegenüber dem bestehenden Angebot im Standardformular.',
    testVariableDe: 'Angebot und Funnel-Typ gemeinsam',
    primaryMetric: 'submission_rate',
    secondaryMetrics: ['cpl', 'vq_scheduled_rate'],
    guardrailMetrics: ['qualified_vq_rate'],
    bundled: true,
    eligibilityChanging: false,
    startOffset: -12,
    endOffset: 0,
    concludedOffset: null,
    thresholds: DEFAULT_EXPERIMENT_THRESHOLDS,
  },
  {
    id: 'exp-creative-exploration-kurzumfrage',
    campaignId: 'cmp-kurzumfrage-kostenstruktur',
    kind: 'CREATIVE_EXPLORATION',
    state: 'RUNNING',
    nameDe: 'Creative-Exploration Kurzumfrage',
    hypothesisDe:
      'Das Video-Creative zur Kurzumfrage erzielt eine höhere Submission-Rate als die statische Variante.',
    testVariableDe: 'Creative-Format (Video vs. statisch)',
    primaryMetric: 'submission_rate',
    secondaryMetrics: ['ctr', 'cpl'],
    guardrailMetrics: ['cpl'],
    bundled: false,
    eligibilityChanging: false,
    startOffset: -4,
    endOffset: 0,
    concludedOffset: null,
    thresholds: DEFAULT_EXPERIMENT_THRESHOLDS,
  },
];

const EXPERIMENT_ARMS: Readonly<Record<string, FixtureArm[]>> = {
  'exp-formular-kurz-vs-lang': [
    {
      id: 'arm-formular-lang',
      key: 'formular_lang',
      labelDe: 'Kontrolle: 6 Schritte',
      isControl: true,
      allocation: 0.5,
      funnelVersionId: 'fv-formular-6-schritte-v2',
      creativeVersionId: null,
      conversionFactor: 1.0,
    },
    {
      id: 'arm-formular-kurz',
      key: 'formular_kurz',
      labelDe: 'Variante: 4 Schritte',
      isControl: false,
      allocation: 0.5,
      funnelVersionId: 'fv-formular-4-schritte-v5',
      creativeVersionId: null,
      conversionFactor: 1.0,
    },
  ],
  'exp-qualifizierungs-gate': [
    {
      id: 'arm-ohne-gate',
      key: 'ohne_gate',
      labelDe: 'Kontrolle: ohne Gate',
      isControl: true,
      allocation: 0.5,
      funnelVersionId: 'fv-formular-4-schritte-v5',
      creativeVersionId: null,
      conversionFactor: 1.0,
    },
    {
      id: 'arm-mit-gate',
      key: 'mit_gate',
      labelDe: 'Variante: mit Gate',
      isControl: false,
      allocation: 0.5,
      funnelVersionId: 'fv-formular-gate-v1',
      creativeVersionId: null,
      conversionFactor: 1.0,
    },
  ],
  'exp-bundle-angebot-hybrid': [
    {
      id: 'arm-bestandsangebot',
      key: 'bestandsangebot',
      labelDe: 'Kontrolle: Bestandsangebot, Standardformular',
      isControl: true,
      allocation: 0.5,
      funnelVersionId: 'fv-formular-4-schritte-v5',
      creativeVersionId: null,
      conversionFactor: 1.0,
    },
    {
      id: 'arm-neues-angebot-hybrid',
      key: 'neues_angebot_hybrid',
      labelDe: 'Variante: neues Angebot, Hybrid-Funnel',
      isControl: false,
      allocation: 0.5,
      funnelVersionId: 'fv-hybrid-v4',
      creativeVersionId: null,
      conversionFactor: 1.0,
    },
  ],
  'exp-creative-exploration-kurzumfrage': [
    {
      id: 'arm-kurzumfrage-statisch',
      key: 'kurzumfrage_statisch',
      labelDe: 'Kontrolle: statisch 4:5',
      isControl: true,
      allocation: 0.38,
      funnelVersionId: 'fv-formular-4-schritte-v5',
      creativeVersionId: 'cv-kurzumfrage-statisch',
      conversionFactor: 1.0,
    },
    {
      id: 'arm-kurzumfrage-video',
      key: 'kurzumfrage_video',
      labelDe: 'Variante: Video 9:16',
      isControl: false,
      allocation: 0.62,
      funnelVersionId: 'fv-formular-4-schritte-v5',
      creativeVersionId: 'cv-kurzumfrage-video',
      conversionFactor: 1.0,
    },
  ],
};

const ARM_BY_ID = new Map<string, { arm: FixtureArm; experiment: FixtureExperiment }>();
for (const experiment of EXPERIMENTS) {
  for (const arm of EXPERIMENT_ARMS[experiment.id]) {
    ARM_BY_ID.set(arm.id, { arm, experiment });
  }
}

/* -------------------------------------------------------------------------- */
/* Daily cells — the shape a rollup table holds                                */
/* -------------------------------------------------------------------------- */

interface DailyCell {
  date: IsoDate;
  dayIndex: number;
  campaignId: string;
  creativeVersionId: string;
  funnelVersionId: string;
  experimentArmId: string | null;
  experimentId: string | null;
  counters: MetricCounters;
  /** Per-step viewers and completers, in the funnel version's declared order. */
  stepChain: StepChainEntry[];
  /** One entry per attributed CRM record behind these counters. */
  confidences: AttributionConfidence[];
  /** Non-production rows filtered out before anything was counted. */
  excludedByTrafficKind: Partial<Record<TrafficKind, number>>;
  excludedEvents: number;
  excludedCrmRecords: number;
}

interface Lane {
  funnelVersionId: string;
  creativeIds: string[];
  experimentArmId: string | null;
  experimentId: string | null;
  share: number;
  conversionFactor: number;
}

function activeExperimentFor(campaignId: string, offset: number): FixtureExperiment | null {
  for (const experiment of EXPERIMENTS) {
    if (experiment.campaignId !== campaignId) continue;
    if (offset >= experiment.startOffset && offset <= experiment.endOffset) return experiment;
  }
  return null;
}

function lanesFor(campaign: FixtureCampaign, offset: number): Lane[] {
  const experiment = activeExperimentFor(campaign.id, offset);
  if (!experiment) {
    const rotation = campaign.funnelVersionIds;
    const funnelVersionId = rotation[Math.abs(offset) % rotation.length];
    return [
      {
        funnelVersionId,
        creativeIds: campaign.creativeIds,
        experimentArmId: null,
        experimentId: null,
        share: 1,
        conversionFactor: 1,
      },
    ];
  }
  return EXPERIMENT_ARMS[experiment.id].map((arm) => ({
    funnelVersionId: arm.funnelVersionId,
    creativeIds: arm.creativeVersionId ? [arm.creativeVersionId] : campaign.creativeIds,
    experimentArmId: arm.id,
    experimentId: experiment.id,
    share: arm.allocation,
    conversionFactor: arm.conversionFactor,
  }));
}

/** Draws one attribution confidence from the campaign's mix. */
function drawConfidence(
  random: () => number,
  mix: FixtureCampaign['confidenceMix'],
): AttributionConfidence {
  const draw = random();
  let cumulative = 0;
  for (let i = 0; i < mix.length; i++) {
    cumulative += mix[i];
    if (draw <= cumulative) return CONFIDENCE_ORDER[i];
  }
  return 'UNKNOWN';
}

/**
 * Build one day of counters for one (campaign, lane, creative) cell.
 *
 * CRM stages are generated as *eventual* outcomes and then multiplied by the
 * share that has arrived by `nowIndex`. That is the whole reason a cohort from
 * last week shows almost no qualified VQs: the outcomes have not happened yet,
 * which is a very different statement from "the campaign produced none".
 */
function buildCell(
  campaign: FixtureCampaign,
  lane: Lane,
  creative: FixtureCreative,
  creativeShare: number,
  dayIndex: number,
  nowIndex: number,
): DailyCell {
  const date = isoDateOfDay(dayIndex);
  const random = mulberry32(
    seedFrom([campaign.id, lane.funnelVersionId, lane.experimentArmId ?? '-', creative.id, date]),
  );
  const funnel = FUNNEL_BY_ID.get(lane.funnelVersionId);
  if (!funnel) throw new Error(`Unknown funnel version ${lane.funnelVersionId}`);

  // Weekly seasonality: German B2B delivery is quiet at the weekend.
  const weekday = ((dayIndex % 7) + 7) % 7; // 0 = Thursday (epoch), irrelevant beyond shape
  const seasonality = weekday === 2 || weekday === 3 ? 0.62 : 1.0;

  const spendMinor = Math.round(
    between(random, campaign.dailySpendMinor[0], campaign.dailySpendMinor[1]) *
      lane.share *
      creativeShare *
      seasonality,
  );
  const cpmMinor = between(random, campaign.cpmMinor[0], campaign.cpmMinor[1]);
  const impressions = cpmMinor > 0 ? Math.round((spendMinor / cpmMinor) * 1000) : 0;
  const ctr = between(random, campaign.ctr[0], campaign.ctr[1]) * creative.ctrFactor;
  const linkClicks = Math.round(impressions * ctr);
  const funnelSessions = Math.round(
    linkClicks * campaign.landingRate * between(random, 0.96, 1.04),
  );
  const formStarts = Math.round(
    funnelSessions * campaign.formStartRate * funnel.formStartFactor * between(random, 0.94, 1.06),
  );

  // A lead is a session that completed the last step, so the step chain and the
  // lead count are the same number seen from two sides — never two estimates.
  const targetLeads = Math.min(
    formStarts,
    roundStochastic(
      funnelSessions *
        campaign.submissionRate *
        funnel.submissionFactor *
        creative.conversionFactor *
        lane.conversionFactor *
        between(random, 0.9, 1.1),
      random,
    ),
  );
  const stepChain = buildStepChain(formStarts, funnel.steps.length, targetLeads);
  const stepViews = stepChain.reduce((sum, entry) => sum + entry.viewed, 0);
  const stepCompletions = stepChain.reduce((sum, entry) => sum + entry.completed, 0);
  const leads = stepChain.length > 0 ? stepChain[stepChain.length - 1].completed : targetLeads;

  const ageDays = nowIndex - dayIndex;
  const eventualScheduled = leads * campaign.vqScheduledRate;
  const eventualAttended = eventualScheduled * campaign.showRate;
  const eventualQualified = eventualAttended * campaign.qualifiedRate;
  const eventualOpportunities = eventualQualified * campaign.opportunityRate;
  const eventualWon = eventualOpportunities * campaign.closeRate;

  const vqScheduled = roundStochastic(eventualScheduled * realisedShare(ageDays, 8), random);
  const vqAttended = Math.min(
    vqScheduled,
    roundStochastic(eventualAttended * realisedShare(ageDays, 15), random),
  );
  const qualifiedVq = Math.min(
    vqAttended,
    roundStochastic(eventualQualified * realisedShare(ageDays, 20), random),
  );
  const opportunities = Math.min(
    qualifiedVq,
    roundStochastic(eventualOpportunities * realisedShare(ageDays, 28), random),
  );
  const closedWon = Math.min(
    opportunities,
    roundStochastic(eventualWon * realisedShare(ageDays, 52), random),
  );
  const revenueMinor = Math.round(
    closedWon * campaign.dealValueMinor * between(random, 0.82, 1.28),
  );

  const confidences: AttributionConfidence[] = [];
  for (let i = 0; i < leads; i++) confidences.push(drawConfidence(random, campaign.confidenceMix));

  // Non-production traffic that never reaches a metric (spec §35).
  const excludedBot = Math.round(funnelSessions * between(random, 0.02, 0.06));
  const excludedPreview = Math.round(funnelSessions * between(random, 0.002, 0.01));
  const excludedInternal = Math.round(funnelSessions * between(random, 0.003, 0.012));
  const excludedTestSubmissions = random() < 0.08 ? 1 : 0;

  return {
    date,
    dayIndex,
    campaignId: campaign.id,
    creativeVersionId: creative.id,
    funnelVersionId: lane.funnelVersionId,
    experimentArmId: lane.experimentArmId,
    experimentId: lane.experimentId,
    counters: {
      impressions,
      linkClicks,
      spendMinor,
      funnelSessions,
      formStarts,
      formStepViews: stepViews,
      formStepCompletions: stepCompletions,
      leads,
      vqScheduled,
      vqAttended,
      qualifiedVq,
      opportunities,
      closedWon,
      revenueMinor,
    },
    stepChain,
    confidences,
    excludedByTrafficKind: {
      BOT: excludedBot,
      PREVIEW: excludedPreview,
      INTERNAL: excludedInternal,
      TEST: excludedTestSubmissions,
    },
    excludedEvents: excludedBot + excludedPreview + excludedInternal,
    excludedCrmRecords: excludedTestSubmissions,
  };
}

/* -------------------------------------------------------------------------- */
/* Dataset                                                                     */
/* -------------------------------------------------------------------------- */

const HISTORY_DAYS = 548;

interface FixtureDataset {
  nowIso: IsoTimestamp;
  nowIndex: number;
  cells: DailyCell[];
}

const datasetCache = new Map<string, FixtureDataset>();

function buildDataset(now: IsoTimestamp): FixtureDataset {
  const nowIndex = dayIndexOf(now);
  const cells: DailyCell[] = [];

  for (let offset = -HISTORY_DAYS; offset <= 0; offset++) {
    const dayIndex = nowIndex + offset;
    for (const campaign of CAMPAIGNS) {
      if (offset < campaign.startOffset || offset > campaign.endOffset) continue;
      for (const lane of lanesFor(campaign, offset)) {
        const laneCreatives = lane.creativeIds
          .map((id) => CREATIVE_BY_ID.get(id))
          .filter((c): c is FixtureCreative => c !== undefined);
        const weightSum = laneCreatives.reduce((sum, c) => sum + c.weight, 0);
        for (const creative of laneCreatives) {
          cells.push(
            buildCell(
              campaign,
              lane,
              creative,
              weightSum > 0 ? creative.weight / weightSum : 0,
              dayIndex,
              nowIndex,
            ),
          );
        }
      }
    }
  }

  return { nowIso: now, nowIndex, cells };
}

function dataset(now: IsoTimestamp): FixtureDataset {
  const key = now.slice(0, 13); // hourly granularity is plenty and keeps the cache small
  const cached = datasetCache.get(key);
  if (cached) return cached;
  const built = buildDataset(now);
  datasetCache.set(key, built);
  if (datasetCache.size > 4) {
    const oldest = datasetCache.keys().next().value;
    if (oldest !== undefined) datasetCache.delete(oldest);
  }
  return built;
}

/* -------------------------------------------------------------------------- */
/* Aggregation — every derived figure comes from @am/experiments               */
/* -------------------------------------------------------------------------- */

const CRM_MATURITY_DAYS = DEFAULT_EXPERIMENT_THRESHOLDS.crmMaturityDays;
const CURRENCY = 'EUR';

function maturityFor(
  cohortDate: IsoDate,
  now: IsoTimestamp,
  observedOutcomes: number,
): MaturityAssessment {
  const input: MaturityInput = {
    cohortStartedAt: startOfDayIso(cohortDate),
    now,
    crmMaturityDays: CRM_MATURITY_DAYS,
    observedOutcomes,
  };
  return assessMaturity(input);
}

function outcomesOf(counters: MetricCounters): number {
  return counters.qualifiedVq + counters.opportunities + counters.closedWon;
}

/** Groups cells by their UTC day in one pass. */
function groupByDay(cells: readonly DailyCell[]): Map<string, DailyCell[]> {
  const grouped = new Map<string, DailyCell[]>();
  for (const cell of cells) {
    const existing = grouped.get(cell.date);
    if (existing) existing.push(cell);
    else grouped.set(cell.date, [cell]);
  }
  return grouped;
}

/**
 * Snapshot for a set of cells.
 *
 * The maturity of a *period* is the maturity of its least mature day, not of its
 * first day. A 30-day window ending today contains three weeks of cohorts whose
 * CRM outcomes have not arrived; badging the whole window MATURE because it
 * starts 30 days ago would be exactly the misreading this product exists to
 * prevent.
 */
function snapshotOf(cells: readonly DailyCell[], now: IsoTimestamp): MetricSnapshot {
  const counters = sumCounters(cells.map((cell) => cell.counters));
  const confidences = cells.flatMap((cell) => cell.confidences);
  const coverage = attributionCoverage(confidences);

  const byDay = groupByDay(cells);
  const days = [...byDay.keys()].sort();
  const cohortStartedAt = days.length > 0 ? startOfDayIso(days[0]) : now;

  let weakest: MaturityAssessment | null = null;
  for (const day of days) {
    const dayCells = byDay.get(day) ?? [];
    const assessment = maturityFor(
      day,
      now,
      outcomesOf(sumCounters(dayCells.map((c) => c.counters))),
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
      crmMaturityDays: CRM_MATURITY_DAYS,
      observedOutcomes: 0,
    });

  const ctx: MetricContext = {
    crmMaturity: maturityAssessment.maturity,
    attributionCoverage: coverage,
    currency: CURRENCY,
  };

  return {
    counters,
    metrics: computeAllMetrics(counters, ctx),
    attributionCoverage: coverage,
    attributedRecords: confidences.length,
    maturity: maturityAssessment.maturity,
    maturityAssessment,
    cohortStartedAt,
    currency: CURRENCY,
  };
}

function emptySnapshot(now: IsoTimestamp, cohortDate: IsoDate): MetricSnapshot {
  const assessment = maturityFor(cohortDate, now, 0);
  const ctx: MetricContext = {
    crmMaturity: assessment.maturity,
    attributionCoverage: null,
    currency: CURRENCY,
  };
  const counters = emptyCounters();
  return {
    counters,
    metrics: computeAllMetrics(counters, ctx),
    attributionCoverage: null,
    attributedRecords: 0,
    maturity: assessment.maturity,
    maturityAssessment: assessment,
    cohortStartedAt: startOfDayIso(cohortDate),
    currency: CURRENCY,
  };
}

function cellsInRange(data: FixtureDataset, query: PerformanceQuery): DailyCell[] {
  const from = dayIndexOf(query.range.from);
  const to = dayIndexOf(query.range.to);
  return data.cells.filter(
    (cell) =>
      cell.dayIndex >= from &&
      cell.dayIndex <= to &&
      (!query.campaignId || cell.campaignId === query.campaignId),
  );
}

/* -------------------------------------------------------------------------- */
/* Breakdown labels                                                            */
/* -------------------------------------------------------------------------- */

export const FUNNEL_KIND_LABELS_DE: Readonly<Record<FunnelKind, string>> = {
  LANDING_PAGE: 'Landingpage',
  MULTI_STEP_FORM: 'Multi-Step-Formular',
  HYBRID: 'Hybrid',
};

function labelForDimension(
  dimension: RollupDimension,
  key: string,
): { labelDe: string; contextDe: string | null; experimentId: string | null } {
  switch (dimension) {
    case 'CAMPAIGN': {
      const campaign = CAMPAIGN_BY_ID.get(key);
      return { labelDe: campaign?.labelDe ?? key, contextDe: null, experimentId: null };
    }
    case 'CREATIVE': {
      const creative = CREATIVE_BY_ID.get(key);
      return { labelDe: creative?.labelDe ?? key, contextDe: null, experimentId: null };
    }
    case 'FUNNEL': {
      const funnel = FUNNEL_BY_ID.get(key);
      return {
        labelDe: funnel?.labelDe ?? key,
        contextDe: funnel ? FUNNEL_KIND_LABELS_DE[funnel.kind] : null,
        experimentId: null,
      };
    }
    case 'EXPERIMENT_ARM': {
      const entry = ARM_BY_ID.get(key);
      return {
        labelDe: entry?.arm.labelDe ?? key,
        contextDe: entry?.experiment.nameDe ?? null,
        experimentId: entry?.experiment.id ?? null,
      };
    }
  }
}

function dimensionKeyOf(cell: DailyCell, dimension: RollupDimension): string | null {
  switch (dimension) {
    case 'CAMPAIGN':
      return cell.campaignId;
    case 'CREATIVE':
      return cell.creativeVersionId;
    case 'FUNNEL':
      return cell.funnelVersionId;
    case 'EXPERIMENT_ARM':
      return cell.experimentArmId;
  }
}

/* -------------------------------------------------------------------------- */
/* Funnel events for the bounded window                                        */
/* -------------------------------------------------------------------------- */

/** Raw event retention. Beyond this the step analysis has nothing to read. */
export const EVENT_WINDOW_DAYS = 31;

const VALIDATION_PROFILE: Readonly<
  Record<string, Array<{ fieldId: string; errorCode: ValidationErrorCode; weight: number }>>
> = {
  kontakt: [
    { fieldId: 'email', errorCode: 'INVALID_EMAIL', weight: 0.34 },
    { fieldId: 'telefon', errorCode: 'INVALID_PHONE', weight: 0.27 },
    { fieldId: 'einwilligung', errorCode: 'CONSENT_REQUIRED', weight: 0.21 },
    { fieldId: 'nachname', errorCode: 'REQUIRED', weight: 0.18 },
  ],
  unternehmensgroesse: [{ fieldId: 'mitarbeitende', errorCode: 'REQUIRED', weight: 1 }],
  herausforderung: [{ fieldId: 'herausforderung', errorCode: 'TOO_SHORT', weight: 1 }],
  zeitraum: [{ fieldId: 'zeitraum', errorCode: 'REQUIRED', weight: 1 }],
  branche: [{ fieldId: 'branche', errorCode: 'UNKNOWN_OPTION', weight: 1 }],
  budget: [{ fieldId: 'budget', errorCode: 'OUT_OF_RANGE', weight: 1 }],
  qualifikation: [{ fieldId: 'qualifikation', errorCode: 'REQUIRED', weight: 1 }],
  plz: [{ fieldId: 'plz', errorCode: 'INVALID_POSTCODE', weight: 1 }],
};

function pickValidationFailure(
  stepKey: string,
  random: () => number,
): { fieldId: string; errorCode: ValidationErrorCode } {
  const profile = VALIDATION_PROFILE[stepKey] ?? [
    { fieldId: stepKey, errorCode: 'REQUIRED' as const, weight: 1 },
  ];
  const total = profile.reduce((sum, entry) => sum + entry.weight, 0);
  let draw = random() * total;
  for (const entry of profile) {
    draw -= entry.weight;
    if (draw <= 0) return { fieldId: entry.fieldId, errorCode: entry.errorCode };
  }
  const last = profile[profile.length - 1];
  return { fieldId: last.fieldId, errorCode: last.errorCode };
}

interface GeneratedEvents {
  funnelEvents: FunnelAnalysisEvent[];
  rollupEvents: RollupEvent[];
  insights: RollupInsightRow[];
  crmRecords: RollupCrmRecord[];
}

/**
 * Expand a set of daily cells into the raw events they were aggregated from.
 *
 * Only ever called for a window bounded by {@link EVENT_WINDOW_DAYS}, because a
 * session-level expansion of 18 months is hundreds of thousands of rows. The
 * generated volumes match the cells exactly, so the step analysis and the
 * rollups agree with the tiles above them.
 */
function expandEvents(cells: readonly DailyCell[]): GeneratedEvents {
  const funnelEvents: FunnelAnalysisEvent[] = [];
  const rollupEvents: RollupEvent[] = [];
  const insights: RollupInsightRow[] = [];
  const crmRecords: RollupCrmRecord[] = [];

  for (const cell of cells) {
    const funnel = FUNNEL_BY_ID.get(cell.funnelVersionId);
    if (!funnel) continue;
    const random = mulberry32(
      seedFrom([
        'events',
        cell.date,
        cell.campaignId,
        cell.creativeVersionId,
        cell.funnelVersionId,
      ]),
    );
    const occurredAt = `${cell.date}T09:00:00.000Z`;
    const keys = {
      campaign_id: cell.campaignId,
      creative_version_id: cell.creativeVersionId,
      funnel_version_id: cell.funnelVersionId,
      experiment_arm_id: cell.experimentArmId,
    };

    insights.push({
      ...keys,
      date: cell.date,
      impressions: cell.counters.impressions,
      link_clicks: cell.counters.linkClicks,
      spend_minor: cell.counters.spendMinor,
    });

    // Session ids must be unique across cells: two campaigns can run the same
    // creative on the same funnel on the same day, and a collision would make
    // `computeRollups` count one session twice.
    const prefix = `${cell.date}-${cell.campaignId}-${cell.creativeVersionId}-${cell.funnelVersionId}-${cell.experimentArmId ?? 'none'}`;
    for (let i = 0; i < cell.counters.funnelSessions; i++) {
      const sessionId = `${prefix}-s${i}`;
      funnelEvents.push({
        event_type: 'funnel_viewed',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
      });
      rollupEvents.push({
        ...keys,
        event_type: 'funnel_viewed',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
      });
      funnelEvents.push({
        event_type: 'form_viewed',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
      });
    }

    // Non-production sessions, so the exclusion report is not an empty object.
    const excluded: Array<[TrafficKind, number]> = [
      ['BOT', cell.excludedByTrafficKind.BOT ?? 0],
      ['PREVIEW', cell.excludedByTrafficKind.PREVIEW ?? 0],
      ['INTERNAL', cell.excludedByTrafficKind.INTERNAL ?? 0],
    ];
    for (const [kind, count] of excluded) {
      for (let i = 0; i < count; i++) {
        const sessionId = `${prefix}-${kind.toLowerCase()}${i}`;
        funnelEvents.push({
          event_type: 'funnel_viewed',
          occurred_at: occurredAt,
          traffic_kind: kind,
          session_id: sessionId,
        });
        rollupEvents.push({
          ...keys,
          event_type: 'funnel_viewed',
          occurred_at: occurredAt,
          traffic_kind: kind,
          session_id: sessionId,
        });
      }
    }

    for (let i = 0; i < cell.counters.formStarts; i++) {
      const sessionId = `${prefix}-s${i}`;
      funnelEvents.push({
        event_type: 'form_started',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
      });
      rollupEvents.push({
        ...keys,
        event_type: 'form_started',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
      });
    }

    funnel.steps.forEach((step, index) => {
      const entry = cell.stepChain[index];
      if (!entry) return;
      const { viewed: reaching, completed } = entry;
      const stepTime = `${cell.date}T09:${String(5 + index).padStart(2, '0')}:00.000Z`;
      for (let i = 0; i < reaching; i++) {
        const sessionId = `${prefix}-s${i}`;
        funnelEvents.push({
          event_type: 'form_step_viewed',
          occurred_at: stepTime,
          traffic_kind: 'PRODUCTION',
          session_id: sessionId,
          step_id: step.key,
        });
        rollupEvents.push({
          ...keys,
          event_type: 'form_step_viewed',
          occurred_at: stepTime,
          traffic_kind: 'PRODUCTION',
          session_id: sessionId,
          step_id: step.key,
        });
        if (i < completed) {
          funnelEvents.push({
            event_type: 'form_step_completed',
            occurred_at: stepTime,
            traffic_kind: 'PRODUCTION',
            session_id: sessionId,
            step_id: step.key,
          });
          rollupEvents.push({
            ...keys,
            event_type: 'form_step_completed',
            occurred_at: stepTime,
            traffic_kind: 'PRODUCTION',
            session_id: sessionId,
            step_id: step.key,
          });
        } else if (random() < 0.55) {
          // People who leave a step usually leave it on a validation error.
          const failure = pickValidationFailure(step.key, random);
          funnelEvents.push({
            event_type: 'form_validation_failed',
            occurred_at: stepTime,
            traffic_kind: 'PRODUCTION',
            session_id: sessionId,
            step_id: step.key,
            field_id: failure.fieldId,
            error_code: failure.errorCode,
          });
        }
      }
    });

    for (let i = 0; i < cell.counters.leads; i++) {
      const submissionId = `${prefix}-l${i}`;
      const sessionId = `${prefix}-s${i}`;
      funnelEvents.push({
        event_type: 'lead_submitted',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
        submission_id: submissionId,
      });
      rollupEvents.push({
        ...keys,
        event_type: 'lead_submitted',
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        session_id: sessionId,
        submission_id: submissionId,
      });
      crmRecords.push({
        ...keys,
        submission_id: submissionId,
        occurred_at: occurredAt,
        traffic_kind: 'PRODUCTION',
        attribution_confidence: cell.confidences[i] ?? 'UNKNOWN',
        vq_scheduled: i < cell.counters.vqScheduled,
        vq_attended: i < cell.counters.vqAttended,
        qualified_vq: i < cell.counters.qualifiedVq,
        opportunity: i < cell.counters.opportunities,
        closed_won: i < cell.counters.closedWon,
        revenue_minor:
          i < cell.counters.closedWon && cell.counters.closedWon > 0
            ? Math.round(cell.counters.revenueMinor / cell.counters.closedWon)
            : 0,
      });
    }
  }

  return { funnelEvents, rollupEvents, insights, crmRecords };
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

function experimentEvaluationInstant(
  experiment: FixtureExperiment,
  data: FixtureDataset,
): IsoTimestamp {
  if (experiment.concludedOffset === null) return data.nowIso;
  return startOfDayIso(isoDateOfDay(data.nowIndex + experiment.concludedOffset));
}

/**
 * Arm observations as of the evaluation instant.
 *
 * A concluded experiment is re-evaluated at the moment it was concluded, not
 * today: that reproduces the decision that was actually taken, and it keeps the
 * CRM outcomes consistent with the maturity the verdict was based on.
 */
function observationsFor(
  experiment: FixtureExperiment,
  data: FixtureDataset,
  asOf: IsoTimestamp,
): ArmObservation[] {
  const asOfIndex = dayIndexOf(asOf);
  const campaign = CAMPAIGN_BY_ID.get(experiment.campaignId);
  if (!campaign) return [];

  return EXPERIMENT_ARMS[experiment.id].map((arm) => {
    const cells: DailyCell[] = [];
    for (let offset = experiment.startOffset; offset <= experiment.endOffset; offset++) {
      const dayIndex = data.nowIndex + offset;
      if (dayIndex > asOfIndex) continue;
      const lane = lanesFor(campaign, offset).find(
        (candidate) => candidate.experimentArmId === arm.id,
      );
      if (!lane) continue;
      const laneCreatives = lane.creativeIds
        .map((id) => CREATIVE_BY_ID.get(id))
        .filter((c): c is FixtureCreative => c !== undefined);
      const weightSum = laneCreatives.reduce((sum, c) => sum + c.weight, 0);
      for (const creative of laneCreatives) {
        cells.push(
          buildCell(
            campaign,
            lane,
            creative,
            weightSum > 0 ? creative.weight / weightSum : 0,
            dayIndex,
            asOfIndex,
          ),
        );
      }
    }

    const counters = sumCounters(cells.map((cell) => cell.counters));
    const coverage = attributionCoverage(cells.flatMap((cell) => cell.confidences));

    return {
      arm_id: arm.id,
      arm_key: arm.key,
      label: arm.labelDe,
      is_control: arm.isControl,
      sessions: counters.funnelSessions,
      exposures: counters.funnelSessions,
      conversions: counters.leads,
      spend_minor: counters.spendMinor,
      vq_scheduled: counters.vqScheduled,
      vq_attended: counters.vqAttended,
      qualified_vq: counters.qualifiedVq,
      opportunities: counters.opportunities,
      closed_won: counters.closedWon,
      revenue_minor: counters.revenueMinor,
      attribution_coverage: coverage,
    };
  });
}

function toDomainExperiment(fixture: FixtureExperiment, data: FixtureDataset): Experiment {
  return {
    id: fixture.id,
    campaign_id: fixture.campaignId,
    kind: fixture.kind,
    state: fixture.state,
    name: fixture.nameDe,
    hypothesis: fixture.hypothesisDe,
    test_variable: fixture.testVariableDe,
    primary_metric: fixture.primaryMetric,
    secondary_metrics: fixture.secondaryMetrics,
    guardrail_metrics: fixture.guardrailMetrics,
    thresholds: fixture.thresholds,
    assignment_salt: `salt-${fixture.id}`,
    bundled: fixture.bundled,
    eligibility_changing: fixture.eligibilityChanging,
    started_at: startOfDayIso(isoDateOfDay(data.nowIndex + fixture.startOffset)),
    concluded_at:
      fixture.concludedOffset === null
        ? null
        : startOfDayIso(isoDateOfDay(data.nowIndex + fixture.concludedOffset)),
    created_at: startOfDayIso(isoDateOfDay(data.nowIndex + fixture.startOffset - 6)),
  };
}

function toDomainArms(fixture: FixtureExperiment, data: FixtureDataset): ExperimentArm[] {
  return EXPERIMENT_ARMS[fixture.id].map((arm) => ({
    id: arm.id,
    experiment_id: fixture.id,
    key: arm.key,
    label: arm.labelDe,
    is_control: arm.isControl,
    allocation: arm.allocation,
    creative_version_id: arm.creativeVersionId,
    funnel_version_id: arm.funnelVersionId,
    form_version_id: null,
    created_at: startOfDayIso(isoDateOfDay(data.nowIndex + fixture.startOffset - 6)),
  }));
}

function evaluateFixtureExperiment(
  fixture: FixtureExperiment,
  data: FixtureDataset,
): {
  experiment: Experiment;
  arms: ExperimentArm[];
  observations: ArmObservation[];
  evaluation: ExperimentEvaluation;
  asOf: IsoTimestamp;
} {
  const asOf = experimentEvaluationInstant(fixture, data);
  const experiment = toDomainExperiment(fixture, data);
  const observations = observationsFor(fixture, data, asOf);
  const evaluation = evaluateExperiment({
    experiment,
    observations,
    thresholds: fixture.thresholds,
    now: asOf,
    metaOptimisedDelivery: fixture.kind === 'CREATIVE_EXPLORATION',
  });
  return { experiment, arms: toDomainArms(fixture, data), observations, evaluation, asOf };
}

/* -------------------------------------------------------------------------- */
/* Learning cards                                                              */
/* -------------------------------------------------------------------------- */

interface LearningSeed {
  id: string;
  campaignId: string | null;
  experimentId: string | null;
  titleDe: string;
  whatWasTestedDe: string;
  angleName: string;
  offerName: string;
  creativeConceptDe: string;
  funnelKind: FunnelKind;
  audienceDe: string;
  periodStartOffset: number;
  periodEndOffset: number;
  spendMinor: number;
  outcomeDe: string;
  outcomeFacts: LearningCard['outcomeFacts'];
  dataMaturity: DataMaturity;
  attributionLevel: LearningCard['attributionLevel'];
  attributionCoverage: number | null;
  sampleSize: number;
  possibleExplanationDe: string;
  suggestedNextTestDe: string;
}

const LEARNING_SEEDS: LearningSeed[] = [
  {
    id: 'lc-formular-kurz',
    campaignId: 'cmp-nachfolge-beratung',
    experimentId: 'exp-formular-kurz-vs-lang',
    titleDe: 'Vier Formularschritte schlagen sechs deutlich',
    whatWasTestedDe:
      'Ein vierstufiges Formular gegen das bestehende sechsstufige Formular, bei identischem Creative, identischem Angebot und identischer Zielgruppe.',
    angleName: 'Nachfolge ohne Wertverlust',
    offerName: 'Kostenlose Nachfolge-Analyse',
    creativeConceptDe: 'Kontraintuitive These – statisch 4:5',
    funnelKind: 'MULTI_STEP_FORM',
    audienceDe: 'Inhabergeführte Unternehmen, 20–200 Mitarbeitende, DACH',
    periodStartOffset: -250,
    periodEndOffset: -226,
    spendMinor: 986_400,
    outcomeDe:
      'Die kurze Variante hob die Submission-Rate um rund ein Drittel, ohne die Qualifizierungsquote der Leads zu senken. Die Kosten je qualifiziertem VQ sanken entsprechend.',
    outcomeFacts: [
      {
        label: 'Submission-Rate Variante',
        numerator: 89,
        denominator: 2_471,
        value: 0.036,
        unit: '%',
      },
      {
        label: 'Submission-Rate Kontrolle',
        numerator: 63,
        denominator: 2_412,
        value: 0.0261,
        unit: '%',
      },
      {
        label: 'Qualifizierte VQs Variante',
        numerator: 31,
        denominator: 54,
        value: 0.5741,
        unit: '%',
      },
    ],
    dataMaturity: 'MATURE',
    attributionLevel: 'REVENUE_LINKED',
    attributionCoverage: 0.81,
    sampleSize: 421,
    possibleExplanationDe:
      'Die beiden entfallenen Schritte (Branche, Budgetrahmen) fragten Informationen ab, die das Vertriebsteam ohnehin im VQ erhebt. Der Abbruch lag messbar auf genau diesen Schritten.',
    suggestedNextTestDe:
      'Drei statt vier Schritte testen: Zeitraum in das Kontaktformular integrieren und prüfen, ob die Qualifizierungsquote stabil bleibt.',
  },
  {
    id: 'lc-qualifizierungs-gate',
    campaignId: 'cmp-nachfolge-beratung',
    experimentId: 'exp-qualifizierungs-gate',
    titleDe: 'Qualifizierungs-Gate zeigt keinen belastbaren Effekt',
    whatWasTestedDe:
      'Eine vorgeschaltete Qualifizierungsfrage vor dem Formular gegen den Standardeinstieg, bei sonst identischem Setup.',
    angleName: 'Nachfolge ohne Wertverlust',
    offerName: 'Kostenlose Nachfolge-Analyse',
    creativeConceptDe: 'Einwandbehandlung – Video 4:5',
    funnelKind: 'MULTI_STEP_FORM',
    audienceDe: 'Inhabergeführte Unternehmen, 20–200 Mitarbeitende, DACH',
    periodStartOffset: -140,
    periodEndOffset: -120,
    spendMinor: 742_800,
    outcomeDe:
      'Die Variante mit Gate lag unter der Kontrolle, verfehlte die geforderte Gewinnwahrscheinlichkeit aber deutlich — das Ergebnis ist nicht eindeutig. Die Arme messen zudem unterschiedliche Grundgesamtheiten, weil das Gate die Zulassung verändert.',
    outcomeFacts: [
      {
        label: 'Submission-Rate mit Gate',
        numerator: 60,
        denominator: 2_249,
        value: 0.0267,
        unit: '%',
      },
      {
        label: 'Submission-Rate ohne Gate',
        numerator: 78,
        denominator: 2_302,
        value: 0.0339,
        unit: '%',
      },
    ],
    dataMaturity: 'MATURE',
    attributionLevel: 'LEAD_LINKED',
    attributionCoverage: 0.74,
    sampleSize: 268,
    possibleExplanationDe:
      'Das Gate filterte vor allem Personen heraus, die auch im Formular abgebrochen wären. Der Nettoeffekt auf qualifizierte VQs war daher klein.',
    suggestedNextTestDe:
      'Statt eines Gates die Qualifizierungsfrage als letzten Schritt testen — der Abbruch verschiebt sich dann hinter die Kontaktdaten.',
  },
  {
    id: 'lc-hybrid-angebot',
    campaignId: 'cmp-foerdermittel-check',
    experimentId: 'exp-bundle-angebot-hybrid',
    titleDe: 'Hybrid-Funnel mit neuem Angebot liegt vorne — vorläufig',
    whatWasTestedDe:
      'Neues Angebot im Hybrid-Funnel gegen das Bestandsangebot im Standardformular. Angebot und Funnel-Typ wurden gemeinsam verändert.',
    angleName: 'Fördermittel ohne Antragschaos',
    offerName: 'Fördermittel-Check in 20 Minuten',
    creativeConceptDe: 'Datenpunkt/Beleg – statisch 1:1',
    funnelKind: 'HYBRID',
    audienceDe: 'Geschäftsführung produzierendes Gewerbe, 50–500 Mitarbeitende',
    periodStartOffset: -12,
    periodEndOffset: 0,
    spendMinor: 512_000,
    outcomeDe:
      'Die Variante führt bei der Submission-Rate. Die CRM-Ergebnisse der Kohorte sind noch nicht reif, und weil Angebot und Funnel gemeinsam variieren, lässt sich der Effekt keiner der beiden Komponenten zuordnen.',
    outcomeFacts: [
      {
        label: 'Submission-Rate Variante',
        numerator: 76,
        denominator: 1_531,
        value: 0.0496,
        unit: '%',
      },
      {
        label: 'Submission-Rate Kontrolle',
        numerator: 54,
        denominator: 1_503,
        value: 0.0359,
        unit: '%',
      },
      {
        label: 'Qualifizierte VQs (bisher)',
        numerator: 11,
        denominator: 34,
        value: 0.3235,
        unit: '%',
      },
    ],
    dataMaturity: 'PARTIAL',
    attributionLevel: 'LEAD_LINKED',
    attributionCoverage: 0.9,
    sampleSize: 11,
    possibleExplanationDe:
      'Der Hybrid-Funnel liefert vor dem Formular mehr Kontext zum Angebot. Ob der Effekt vom Angebot oder vom Funnel-Typ stammt, ist mit diesem Design nicht entscheidbar.',
    suggestedNextTestDe:
      'Das neue Angebot im Standardformular gegen das Bestandsangebot testen — ein Faktor, damit die Ursache zuordenbar wird.',
  },
  {
    id: 'lc-video-hook',
    campaignId: 'cmp-foerdermittel-check',
    experimentId: null,
    titleDe: 'Video-Hook mit konkretem Ergebnis führt bei der CTR',
    whatWasTestedDe:
      'Drei Creative-Konzepte im laufenden Betrieb: konkretes Ergebnis als Video 9:16, Einwandbehandlung als Video 4:5 und ein Datenpunkt als statisches 1:1.',
    angleName: 'Fördermittel ohne Antragschaos',
    offerName: 'Fördermittel-Check in 20 Minuten',
    creativeConceptDe: 'Konkretes Ergebnis – Video 9:16',
    funnelKind: 'MULTI_STEP_FORM',
    audienceDe: 'Geschäftsführung produzierendes Gewerbe, 50–500 Mitarbeitende',
    periodStartOffset: -90,
    periodEndOffset: -14,
    spendMinor: 2_940_000,
    outcomeDe:
      'Das Video mit konkretem Ergebnis erzielte die höchste CTR und den niedrigsten CPC. Die Auslieferung wurde von Meta optimiert, es handelt sich nicht um einen randomisierten Test.',
    outcomeFacts: [
      {
        label: 'CTR Video „Konkretes Ergebnis“',
        numerator: 6_842,
        denominator: 412_390,
        value: 0.0166,
        unit: '%',
      },
      {
        label: 'CTR statisch „Datenpunkt“',
        numerator: 3_918,
        denominator: 318_204,
        value: 0.0123,
        unit: '%',
      },
    ],
    dataMaturity: 'MATURE',
    attributionLevel: 'TRAFFIC_LINKED',
    attributionCoverage: 0.42,
    sampleSize: 6_842,
    possibleExplanationDe:
      'Meta hat dem Video früh mehr Budget zugewiesen. Der CTR-Vorsprung kann daher ebenso auf der Auslieferung wie auf dem Creative beruhen.',
    suggestedNextTestDe:
      'Die Hook-Aussage des Videos als statisches Motiv nachbauen und beide bei gleicher Auslieferung im Funnel-Experiment gegeneinander stellen.',
  },
  {
    id: 'lc-wochenende',
    campaignId: 'cmp-prozesskosten-analyse',
    experimentId: null,
    titleDe: 'Wochenend-Leads terminieren seltener einen VQ',
    whatWasTestedDe:
      'Auswertung der Terminierungsquote nach Wochentag des Lead-Eingangs über zwei Kampagnenlaufzeiten.',
    angleName: 'Prozesskosten sichtbar machen',
    offerName: 'Prozesskosten-Analyse',
    creativeConceptDe: 'Vergleich Alternative – Karussell',
    funnelKind: 'MULTI_STEP_FORM',
    audienceDe: 'Kaufmännische Leitung, 100–1.000 Mitarbeitende',
    periodStartOffset: -455,
    periodEndOffset: -286,
    spendMinor: 5_120_000,
    outcomeDe:
      'Leads vom Samstag und Sonntag terminierten seltener einen VQ als Leads von Montag bis Donnerstag. Der Unterschied ist über beide Laufzeiten stabil.',
    outcomeFacts: [
      {
        label: 'VQ-Terminierungsrate Mo–Do',
        numerator: 612,
        denominator: 1_042,
        value: 0.5873,
        unit: '%',
      },
      {
        label: 'VQ-Terminierungsrate Sa–So',
        numerator: 118,
        denominator: 286,
        value: 0.4126,
        unit: '%',
      },
    ],
    dataMaturity: 'MATURE',
    attributionLevel: 'LEAD_LINKED',
    attributionCoverage: 0.67,
    sampleSize: 118,
    possibleExplanationDe:
      'Die Erstkontaktaufnahme erfolgt erst am Montag. Bis dahin ist die Kaufabsicht abgekühlt — die Zeit bis zum Erstkontakt, nicht der Wochentag selbst, ist die plausible Ursache.',
    suggestedNextTestDe:
      'Automatische Terminbuchung direkt nach dem Absenden anbieten und die Terminierungsquote am Wochenende erneut messen.',
  },
  {
    id: 'lc-preis-frage',
    campaignId: null,
    experimentId: null,
    titleDe: 'Preisfrage im Formular schreckt vermutlich ab',
    whatWasTestedDe:
      'Beobachtung aus dem Abbruchverhalten: der Schritt „Budgetrahmen“ verliert im sechsstufigen Formular überdurchschnittlich viele Sessions.',
    angleName: 'Prozesskosten sichtbar machen',
    offerName: 'Prozesskosten-Analyse',
    creativeConceptDe: 'Problem/Pain – statisch 4:5',
    funnelKind: 'MULTI_STEP_FORM',
    audienceDe: 'Kaufmännische Leitung, 100–1.000 Mitarbeitende',
    periodStartOffset: -60,
    periodEndOffset: -8,
    spendMinor: 268_000,
    outcomeDe:
      'Der Schritt „Budgetrahmen“ weist die höchste Abbruchrate aller Schritte auf. Ein kontrollierter Test dazu läuft nicht — dies ist eine Beobachtung, keine gemessene Wirkung.',
    outcomeFacts: [
      {
        label: 'Abbruchrate Schritt „Budgetrahmen“',
        numerator: 214,
        denominator: 618,
        value: 0.3463,
        unit: '%',
      },
      {
        label: 'Abbruchrate Schritt „Branche“',
        numerator: 71,
        denominator: 812,
        value: 0.0874,
        unit: '%',
      },
    ],
    dataMaturity: 'IMMATURE',
    attributionLevel: 'TRAFFIC_LINKED',
    attributionCoverage: 0.38,
    sampleSize: 214,
    possibleExplanationDe:
      'Die Frage nach dem Budget vor einem Erstgespräch wirkt als Kaufsignal-Abfrage. Ebenso plausibel ist, dass die Antwortoptionen zu grob sind.',
    suggestedNextTestDe:
      'Den Schritt ersatzlos streichen und die Qualifizierungsquote der Leads über vier Wochen gegen die Vorperiode halten.',
  },
];

function toLearningCard(seed: LearningSeed, data: FixtureDataset): LearningCard {
  const confidence: ConfidenceLabel = deriveConfidence({
    maturity: seed.dataMaturity,
    attributionCoverage: seed.attributionCoverage,
    sampleSize: seed.sampleSize,
  });

  return {
    id: seed.id,
    version: 1,
    campaign_id: seed.campaignId,
    experiment_id: seed.experimentId,
    created_at: startOfDayIso(isoDateOfDay(data.nowIndex + seed.periodEndOffset + 3)),
    titleDe: seed.titleDe,
    whatWasTestedDe: seed.whatWasTestedDe,
    angleName: seed.angleName,
    angle_id: null,
    offerName: seed.offerName,
    offer_id: null,
    creativeConceptDe: seed.creativeConceptDe,
    funnelKind: seed.funnelKind,
    audienceDe: seed.audienceDe,
    periodStart: startOfDayIso(isoDateOfDay(data.nowIndex + seed.periodStartOffset)),
    periodEnd: startOfDayIso(isoDateOfDay(data.nowIndex + seed.periodEndOffset)),
    spendMinor: seed.spendMinor,
    currency: CURRENCY,
    outcomeDe: seed.outcomeDe,
    outcomeFacts: seed.outcomeFacts,
    dataMaturity: seed.dataMaturity,
    attributionLevel: seed.attributionLevel,
    attributionCoverage: seed.attributionCoverage,
    possibleExplanationDe: seed.possibleExplanationDe,
    suggestedNextTestDe: seed.suggestedNextTestDe,
    confidence,
  };
}

/* -------------------------------------------------------------------------- */
/* The port implementation                                                     */
/* -------------------------------------------------------------------------- */

function crmDelayFor(
  range: DateRange,
  cells: readonly DailyCell[],
  now: IsoTimestamp,
): CrmDelayStatement {
  const from = dayIndexOf(range.from);
  const to = dayIndexOf(range.to);
  const nowIndex = dayIndexOf(now);
  const byDay = groupByDay(cells);

  let mature = 0;
  let partial = 0;
  let immature = 0;
  let weakest: MaturityAssessment | null = null;

  for (let index = from; index <= to; index++) {
    const date = isoDateOfDay(index);
    const dayCells = byDay.get(date) ?? [];
    const assessment = maturityFor(
      date,
      now,
      outcomesOf(sumCounters(dayCells.map((c) => c.counters))),
    );
    if (assessment.maturity === 'MATURE') mature += 1;
    else if (assessment.maturity === 'PARTIAL') partial += 1;
    else immature += 1;
    if (!weakest || MATURITY_ORDER[assessment.maturity] < MATURITY_ORDER[weakest.maturity])
      weakest = assessment;
  }

  const totalDays = Math.max(0, to - from + 1);
  const cutoffIndex = nowIndex - CRM_MATURITY_DAYS;
  const maturityCutoff =
    cutoffIndex >= from && cutoffIndex <= to ? isoDateOfDay(cutoffIndex + 1) : null;

  return {
    crmMaturityDays: CRM_MATURITY_DAYS,
    maturityCutoff,
    matureDays: mature,
    partialDays: partial,
    immatureDays: immature,
    notYetMature: rate(partial + immature, totalDays),
    reasonsDe: weakest?.reasonsDe ?? [],
  };
}

function exclusionsFor(cells: readonly DailyCell[]): RollupExclusions {
  const byTrafficKind: Partial<Record<TrafficKind, number>> = {};
  let events = 0;
  let crmRecords = 0;
  for (const cell of cells) {
    events += cell.excludedEvents;
    crmRecords += cell.excludedCrmRecords;
    for (const [kind, count] of Object.entries(cell.excludedByTrafficKind)) {
      const key = kind as TrafficKind;
      byTrafficKind[key] = (byTrafficKind[key] ?? 0) + (count ?? 0);
    }
  }
  return {
    events,
    crmRecords,
    byTrafficKind,
    unattributedEvents: 0,
    unattributedInsights: 0,
    unattributedCrmRecords: 0,
  };
}

export interface AnalyticsFixtureOptions {
  /** Overrides the evaluation instant. Tests pass a fixed value. */
  now?: IsoTimestamp;
}

/**
 * Creates the fixture port. `now` is resolved once per call so a request renders
 * one consistent instant across every figure on the page.
 */
export function createAnalyticsFixturePort(options: AnalyticsFixtureOptions = {}): AnalyticsPort {
  const resolveNow = (candidate?: IsoTimestamp): IsoTimestamp =>
    candidate ?? options.now ?? new Date().toISOString();

  return {
    async listCampaigns(): Promise<CampaignRef[]> {
      const data = dataset(resolveNow());
      return CAMPAIGNS.map((campaign) => ({
        id: campaign.id,
        labelDe: campaign.labelDe,
        firstDay: isoDateOfDay(data.nowIndex + campaign.startOffset),
        lastDay: isoDateOfDay(data.nowIndex + campaign.endOffset),
      })).sort((a, b) => b.lastDay.localeCompare(a.lastDay));
    },

    async listFunnelVersions(): Promise<FunnelVersionRef[]> {
      return FUNNEL_VERSIONS.map((funnel) => ({
        id: funnel.id,
        labelDe: `${funnel.labelDe} · ${FUNNEL_KIND_LABELS_DE[funnel.kind]}`,
      }));
    },

    async getPerformanceOverview(query: PerformanceQuery): Promise<PerformanceOverview> {
      const now = resolveNow(query.now);
      const data = dataset(now);
      const cells = cellsInRange(data, { ...query, now });

      const from = dayIndexOf(query.range.from);
      const to = dayIndexOf(query.range.to);
      const byDay = groupByDay(cells);
      const series: DailyPoint[] = [];
      for (let index = from; index <= to; index++) {
        const date = isoDateOfDay(index);
        const dayCells = byDay.get(date) ?? [];
        const snapshot = dayCells.length > 0 ? snapshotOf(dayCells, now) : emptySnapshot(now, date);
        series.push({ date, ...snapshot });
      }

      return {
        range: query.range,
        currency: CURRENCY,
        total: cells.length > 0 ? snapshotOf(cells, now) : emptySnapshot(now, query.range.to),
        series,
        crmDelay: crmDelayFor(query.range, cells, now),
        exclusions: exclusionsFor(cells),
      };
    },

    async getBreakdowns(query: PerformanceQuery): Promise<Breakdown[]> {
      const now = resolveNow(query.now);
      const data = dataset(now);
      const cells = cellsInRange(data, { ...query, now });

      return ROLLUP_DIMENSIONS.map((dimension) => {
        const groups = new Map<string, DailyCell[]>();
        for (const cell of cells) {
          const key = dimensionKeyOf(cell, dimension);
          if (!key) continue;
          const existing = groups.get(key);
          if (existing) existing.push(cell);
          else groups.set(key, [cell]);
        }

        const rows: BreakdownRow[] = [...groups.entries()].map(([key, groupCells]) => {
          const label = labelForDimension(dimension, key);
          return {
            dimension,
            key,
            labelDe: label.labelDe,
            contextDe: label.contextDe,
            experimentId: label.experimentId,
            ...snapshotOf(groupCells, now),
          };
        });

        rows.sort(
          (a, b) =>
            b.counters.spendMinor - a.counters.spendMinor || a.labelDe.localeCompare(b.labelDe),
        );
        return { dimension, rows };
      });
    },

    async getFunnelDropOff(query: FunnelQuery): Promise<FunnelDropOff> {
      const now = resolveNow(query.now);
      const data = dataset(now);

      const requestedFrom = dayIndexOf(query.range.from);
      const requestedTo = dayIndexOf(query.range.to);
      const windowFrom = Math.max(requestedFrom, requestedTo - (EVENT_WINDOW_DAYS - 1));
      const windowTruncated = windowFrom > requestedFrom;
      const window: DateRange = { from: isoDateOfDay(windowFrom), to: isoDateOfDay(requestedTo) };

      const windowCells = data.cells.filter(
        (cell) =>
          cell.dayIndex >= windowFrom &&
          cell.dayIndex <= requestedTo &&
          (!query.campaignId || cell.campaignId === query.campaignId),
      );

      // Default to the funnel version that actually carried the form traffic —
      // a landing page has no steps to analyse.
      let funnelVersionId = query.funnelVersionId ?? null;
      if (!funnelVersionId) {
        const byFunnel = new Map<string, number>();
        for (const cell of windowCells) {
          byFunnel.set(
            cell.funnelVersionId,
            (byFunnel.get(cell.funnelVersionId) ?? 0) + cell.counters.formStarts,
          );
        }
        funnelVersionId =
          [...byFunnel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
          null;
      }

      const selected = funnelVersionId
        ? windowCells.filter((cell) => cell.funnelVersionId === funnelVersionId)
        : [];
      const funnel = funnelVersionId ? FUNNEL_BY_ID.get(funnelVersionId) : undefined;
      const { funnelEvents } = expandEvents(selected);

      const analysis = analyzeFunnel({ events: funnelEvents, steps: funnel?.steps });
      const stepLabelsDe: Record<string, string> = {};
      for (const step of funnel?.steps ?? []) stepLabelsDe[step.key] = step.label ?? step.key;

      return {
        analysis,
        window,
        windowTruncated,
        noteDe: windowTruncated
          ? `Ereignis-Rohdaten stehen für maximal ${EVENT_WINDOW_DAYS} Tage zur Verfügung. Die Schritt-Analyse zeigt daher den Zeitraum ${window.from} bis ${window.to}, nicht den vollen gewählten Zeitraum.`
          : null,
        funnelVersionId,
        funnelLabelDe: funnel
          ? `${funnel.labelDe} · ${FUNNEL_KIND_LABELS_DE[funnel.kind]}`
          : 'Kein Funnel mit Formularverkehr',
        stepLabelsDe,
      };
    },

    async listExperiments(now: IsoTimestamp): Promise<ExperimentSummary[]> {
      const resolved = resolveNow(now);
      const data = dataset(resolved);
      return EXPERIMENTS.map((fixture) => {
        const { experiment, arms, observations, evaluation } = evaluateFixtureExperiment(
          fixture,
          data,
        );
        const campaign = CAMPAIGN_BY_ID.get(fixture.campaignId);
        const winningArm = evaluation.result.winning_arm_id
          ? arms.find((arm) => arm.id === evaluation.result.winning_arm_id)
          : undefined;
        return {
          experiment,
          arms,
          evaluation,
          observations,
          campaignId: fixture.campaignId,
          campaignLabelDe: campaign?.labelDe ?? fixture.campaignId,
          winningArmLabelDe: winningArm?.label ?? null,
        };
      }).sort((a, b) =>
        (b.experiment.started_at ?? '').localeCompare(a.experiment.started_at ?? ''),
      );
    },

    async getExperiment(id: string, now: IsoTimestamp): Promise<ExperimentDetail | null> {
      const resolved = resolveNow(now);
      const data = dataset(resolved);
      const fixture = EXPERIMENTS.find((candidate) => candidate.id === id);
      if (!fixture) return null;

      const { experiment, arms, observations, evaluation, asOf } = evaluateFixtureExperiment(
        fixture,
        data,
      );
      const campaign = CAMPAIGN_BY_ID.get(fixture.campaignId);
      const winningArm = evaluation.result.winning_arm_id
        ? arms.find((arm) => arm.id === evaluation.result.winning_arm_id)
        : undefined;

      const armMetrics: Record<string, MetricSnapshot> = {};
      const asOfIndex = dayIndexOf(asOf);
      for (const arm of arms) {
        const cells: DailyCell[] = [];
        for (let offset = fixture.startOffset; offset <= fixture.endOffset; offset++) {
          const dayIndex = data.nowIndex + offset;
          if (dayIndex > asOfIndex) continue;
          const lane = campaign
            ? lanesFor(campaign, offset).find((candidate) => candidate.experimentArmId === arm.id)
            : undefined;
          if (!lane || !campaign) continue;
          const laneCreatives = lane.creativeIds
            .map((creativeId) => CREATIVE_BY_ID.get(creativeId))
            .filter((c): c is FixtureCreative => c !== undefined);
          const weightSum = laneCreatives.reduce((sum, c) => sum + c.weight, 0);
          for (const creative of laneCreatives) {
            cells.push(
              buildCell(
                campaign,
                lane,
                creative,
                weightSum > 0 ? creative.weight / weightSum : 0,
                dayIndex,
                asOfIndex,
              ),
            );
          }
        }
        armMetrics[arm.id] =
          cells.length > 0 ? snapshotOf(cells, asOf) : emptySnapshot(asOf, isoDateOfDay(asOfIndex));
      }

      return {
        experiment,
        arms,
        evaluation,
        observations,
        armMetrics,
        campaignId: fixture.campaignId,
        campaignLabelDe: campaign?.labelDe ?? fixture.campaignId,
        winningArmLabelDe: winningArm?.label ?? null,
      };
    },

    async listLearningCards(): Promise<LearningCard[]> {
      const data = dataset(resolveNow());
      return LEARNING_SEEDS.map((seed) => toLearningCard(seed, data)).sort((a, b) =>
        (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''),
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rollup verification helper                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Runs the generated raw rows of a bounded window through `computeRollups`.
 *
 * Not used by the screens — the aggregated cells already carry the same
 * counters — but it is the bridge the production implementation will keep: the
 * same rows, the same function, the same output shape. Tests use it to prove the
 * fixture's aggregation matches what `computeRollups` derives from its events.
 */
export function rollupsFromFixture(
  dimension: RollupDimension,
  range: DateRange,
  now: IsoTimestamp,
): ReturnType<typeof computeRollups> {
  const data = dataset(now);
  const from = dayIndexOf(range.from);
  const to = dayIndexOf(range.to);
  const cells = data.cells.filter((cell) => cell.dayIndex >= from && cell.dayIndex <= to);
  const { rollupEvents, insights, crmRecords } = expandEvents(cells);
  return computeRollups({
    dimension,
    events: rollupEvents,
    insights,
    crmRecords,
    now,
    crmMaturityDays: CRM_MATURITY_DAYS,
    currency: CURRENCY,
  });
}

/** Preset-independent helper the routes use to clamp a requested range. */
export function clampRangeToHistory(range: DateRange, now: IsoTimestamp): DateRange {
  const nowIndex = dayIndexOf(now);
  const earliest = isoDateOfDay(nowIndex - HISTORY_DAYS);
  const latest = isoDateOfDay(nowIndex);
  const from = range.from < earliest ? earliest : range.from;
  const to = range.to > latest ? latest : range.to;
  return { from, to: to < from ? from : to };
}

export { addDays as addDaysIso, isoDateOfDay, dayIndexOf };
