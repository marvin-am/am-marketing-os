import {
  ANGLE_VERDICT_LABELS_DE,
  CREATIVE_PRINCIPLES,
  DomainError,
  GENERATION_DEFAULTS,
  METRIC_CATALOG,
  campaignProposalSchema,
  validateFunnelMix,
  type AiContextBundle,
  type AngleSpec,
  type CampaignProposal,
  type CreativeConcept,
  type CreativePrinciple,
  type EvidenceReference,
  type FunnelProposal,
  type MetricKey,
  type OfferSpec,
  type SimilarCampaignReference,
} from '@am/domain';
import {
  assertDiversityReport,
  checkCreativeDiversity,
  type DiversityReport,
  type DiversityThresholds,
} from '../diversity';
import { FUNNEL_STRATEGY_DEFAULTS } from '../prompts/definitions';
import type {
  AngleDistinctnessReview,
  AngleIdeation,
  CampaignPackage,
  ClaimReview,
  ContextSummary,
  CoreMessage,
  CreativeConception,
  FunnelSpecDraft,
  FunnelStrategy,
  HistoryFraming,
  MetaCopySet,
  OfferDevelopment,
} from '../prompts/schemas';
import { PIPELINE_STEPS, PIPELINE_STEP_LABELS_DE, type PipelineStep } from '../prompts/types';
import { checkAngleDistinctness, type AngleDistinctnessResult, type StoredEmbedding } from '../similarity';
import { assertContextFree, buildContext, type BuildContextInput } from './context';
import { runStep } from './run-step';
import type { AiJob, PipelineDeps, PipelineProgress } from './types';
import type { PromptContext } from '../prompts/inputs';

/**
 * The twelve-step campaign pipeline.
 *
 * Every step is an independently persistable job (`runStep`) and every step is
 * re-runnable on its own (`regenerateStep`). Between the model calls sit the
 * deterministic parts that the model is not allowed to decide:
 *
 * - angle distinctness is measured against the embedding index, not judged;
 * - creative diversity is measured and, if it fails, drives one regeneration
 *   with the concrete German reasons fed back — then the package is blocked;
 * - the funnel mix is checked with `validateFunnelMix` from `@am/domain`;
 * - every figure in the experiment plan and the budget is computed here from
 *   the caller's deterministic settings, not generated.
 */

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface GenerationSettings {
  conceptCount: number;
  funnelCount: number;
  minMultiStepForms: number;
  principles: readonly CreativePrinciple[];
  /** Regenerations allowed when the diversity check blocks. */
  maxDiversityRetries: number;
  diversity?: Partial<DiversityThresholds>;
}

export const GENERATION_SETTINGS_DEFAULTS: GenerationSettings = {
  conceptCount: GENERATION_DEFAULTS.creativeConceptCount,
  funnelCount: FUNNEL_STRATEGY_DEFAULTS.funnelCount,
  minMultiStepForms: FUNNEL_STRATEGY_DEFAULTS.minMultiStepForms,
  principles: CREATIVE_PRINCIPLES,
  maxDiversityRetries: 1,
};

/** Deterministic experiment thresholds — never produced by a model. */
export interface ExperimentSettings {
  minRuntimeDays: number;
  maxRuntimeDays: number;
  minSessionsPerArm: number;
  minConversionsPerArm: number;
  crmMaturityDays: number;
}

export const EXPERIMENT_SETTINGS_DEFAULTS: ExperimentSettings = {
  minRuntimeDays: 7,
  maxRuntimeDays: 21,
  minSessionsPerArm: 200,
  minConversionsPerArm: 20,
  crmMaturityDays: 21,
};

/** Deterministic budget plan — the model only writes the rationale. */
export interface BudgetSettings {
  dailyBudgetMinor: number;
  /** Days the test is funded for; `testBudgetMinor` is derived from it. */
  testDays: number;
  currency?: string;
  targetCplMinor?: number | null;
  targetCostPerQualifiedVqMinor?: number | null;
}

export interface CampaignPipelineInput extends BuildContextInput {
  bundle: AiContextBundle;
  briefDe: string;
  /** Historical angle embeddings for the distinctness check. */
  history?: readonly StoredEmbedding[];
  /** Angle names used recently — computed by the caller from the database. */
  recentAngleNames?: readonly string[];
  budget: BudgetSettings;
  experiment?: Partial<ExperimentSettings>;
  generation?: Partial<GenerationSettings>;
  /** ISO timestamp used as "now" for recency filtering. */
  now?: string;
}

/* -------------------------------------------------------------------------- */
/* Step outputs                                                                */
/* -------------------------------------------------------------------------- */

export interface PipelineStepOutputs {
  CONTEXT_SUMMARY?: ContextSummary;
  HISTORY_FRAMING?: HistoryFraming;
  ANGLE_IDEATION?: AngleIdeation;
  ANGLE_DISTINCTNESS?: AngleDistinctnessReview;
  OFFER_DEVELOPMENT?: OfferDevelopment;
  CORE_MESSAGE?: CoreMessage;
  CREATIVE_CONCEPTION?: CreativeConception;
  META_COPY?: MetaCopySet;
  FUNNEL_STRATEGY?: FunnelStrategy;
  FUNNEL_SPEC?: FunnelSpecDraft[];
  CLAIM_GUARDRAIL_CHECK?: ClaimReview;
  CAMPAIGN_PACKAGE?: CampaignPackage;
}

export interface CampaignPipelineResult {
  proposal: CampaignProposal;
  jobs: AiJob[];
  outputs: PipelineStepOutputs;
  diversity: DiversityReport;
  angleDistinctness: AngleDistinctnessResult;
  funnelSpecDrafts: FunnelSpecDraft[];
  claimReview: ClaimReview;
  contextHash: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function issue(path: string, messageDe: string): string {
  return `${path}: ${messageDe}`;
}

function expectedConceptKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `concept_${index + 1}`);
}

function mergeConcepts(conception: CreativeConception, copies: MetaCopySet): CreativeConcept[] {
  const byKey = new Map(copies.copies.map((entry) => [entry.conceptKey, entry.copy]));
  return conception.concepts.map((concept) => {
    const copy = byKey.get(concept.key);
    if (!copy) {
      throw new DomainError('AI_OUTPUT_INVALID', {
        messageDe: 'Für mindestens ein Creative-Konzept fehlt der Anzeigentext.',
        details: { conceptKey: concept.key },
      });
    }
    return { ...concept, copy, claims: [] };
  });
}

function toEvidenceReferences(summary: ContextSummary): EvidenceReference[] {
  return summary.approvedFacts
    // A hypothesis is not evidence. Carrying it here would let an unsupported
    // statement appear in the proposal's evidence list.
    .filter((fact) => fact.confidence !== 'HYPOTHESIS')
    .slice(0, 20)
    .map((fact) => ({
      evidenceItemId: null,
      kind: fact.confidence === 'FACT' ? ('APPROVED_FACT' as const) : ('HISTORICAL_PERFORMANCE' as const),
      summary: fact.statementDe,
      sourceRef: fact.sourceRef,
    }));
}

function uniqueCapped(values: readonly string[], cap: number): string[] {
  return [...new Set(values)].slice(0, cap);
}

async function emit(deps: PipelineDeps, event: PipelineProgress): Promise<void> {
  await deps.onProgress?.(event);
}

function progress(
  step: PipelineStep,
  status: PipelineProgress['status'],
  jobId: string | null,
  messageDe: string | null = null,
): PipelineProgress {
  return {
    step,
    index: PIPELINE_STEPS.indexOf(step) + 1,
    total: PIPELINE_STEPS.length,
    status,
    labelDe: PIPELINE_STEP_LABELS_DE[step],
    jobId,
    messageDe,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-step validation beyond the schema                                       */
/* -------------------------------------------------------------------------- */

export function validateConception(
  conception: CreativeConception,
  settings: GenerationSettings,
): string[] {
  const issues: string[] = [];
  const expected = expectedConceptKeys(settings.conceptCount);

  if (conception.concepts.length !== settings.conceptCount) {
    issues.push(
      issue(
        'concepts',
        `Es werden genau ${settings.conceptCount} Konzepte benötigt, geliefert wurden ${conception.concepts.length}.`,
      ),
    );
  }
  conception.concepts.forEach((concept, index) => {
    if (concept.key !== expected[index]) {
      issues.push(
        issue(
          `concepts.${index}.key`,
          `Der Schlüssel muss ${expected[index] ?? `concept_${index + 1}`} lauten.`,
        ),
      );
    }
  });

  const principles = conception.concepts.map((concept) => concept.principle);
  const duplicates = principles.filter((principle, index) => principles.indexOf(principle) !== index);
  for (const principle of new Set(duplicates)) {
    issues.push(
      issue('concepts', `Das Prinzip ${principle} wird mehrfach verwendet; vorgesehen ist je einmal.`),
    );
  }

  return issues;
}

export function validateCopySet(copies: MetaCopySet, conception: CreativeConception): string[] {
  const conceptKeys = conception.concepts.map((concept) => concept.key);
  const copyKeys = copies.copies.map((entry) => entry.conceptKey);
  const issues: string[] = [];

  for (const key of conceptKeys) {
    if (!copyKeys.includes(key)) {
      issues.push(issue('copies', `Für ${key} fehlt ein Anzeigentext.`));
    }
  }
  for (const key of copyKeys) {
    if (!conceptKeys.includes(key)) {
      issues.push(issue('copies', `${key} gehört zu keinem der gelieferten Konzepte.`));
    }
  }
  return issues;
}

export function validateFunnelStrategy(
  strategy: FunnelStrategy,
  settings: GenerationSettings,
): string[] {
  const issues = validateFunnelMix(strategy.funnels).map((problem) => issue('funnels', problem));
  if (strategy.funnels.length !== settings.funnelCount) {
    issues.push(
      issue(
        'funnels',
        `Es werden genau ${settings.funnelCount} Funnel-Varianten benötigt, geliefert wurden ${strategy.funnels.length}.`,
      ),
    );
  }
  strategy.funnels.forEach((funnel, index) => {
    const expected = `funnel_${index + 1}`;
    if (funnel.key !== expected) {
      issues.push(issue(`funnels.${index}.key`, `Der Schlüssel muss ${expected} lauten.`));
    }
    if (funnel.kind === 'MULTI_STEP_FORM' && funnel.questionOutline.length === 0) {
      issues.push(
        issue(`funnels.${index}.questionOutline`, 'Ein mehrstufiges Formular braucht eine Fragen-Outline.'),
      );
    }
  });
  return issues;
}

export function validateClaimReview(review: ClaimReview): string[] {
  return review.claims.flatMap((claim, index) =>
    claim.evidence === null && !claim.requiresHypothesisLabel && claim.confidence !== 'HYPOTHESIS'
      ? [
          issue(
            `claims.${index}`,
            'Ein Claim ohne Evidenz muss als Hypothese gekennzeichnet werden (requiresHypothesisLabel = true oder confidence = HYPOTHESIS).',
          ),
        ]
      : [],
  );
}

/* -------------------------------------------------------------------------- */
/* Single-step regeneration                                                    */
/* -------------------------------------------------------------------------- */

export interface RegenerateStepInput {
  step: PipelineStep;
  context: PromptContext;
  outputs: PipelineStepOutputs;
  settings?: Partial<GenerationSettings>;
  recentAngleNames?: readonly string[];
  angleDistinctness?: AngleDistinctnessResult;
  /** Which funnel to regenerate the spec draft for (step 10). */
  funnelKey?: string;
  diversityFeedbackDe?: readonly string[];
}

function requireOutput<K extends keyof PipelineStepOutputs>(
  outputs: PipelineStepOutputs,
  key: K,
): NonNullable<PipelineStepOutputs[K]> {
  const value = outputs[key];
  if (value === undefined) {
    throw new DomainError('CONFLICT', {
      messageDe:
        'Dieser Schritt kann nicht einzeln neu erzeugt werden, weil ein vorhergehender Schritt noch fehlt.',
      details: { missingStep: key },
    });
  }
  return value as NonNullable<PipelineStepOutputs[K]>;
}

function chosenAngle(outputs: PipelineStepOutputs): AngleSpec {
  const ideation = requireOutput(outputs, 'ANGLE_IDEATION');
  const sharpened = outputs.ANGLE_DISTINCTNESS?.sharpenedAngle ?? null;
  if (sharpened) return sharpened;
  return (
    ideation.angles.find((angle) => angle.name === ideation.recommendedAngleName) ??
    ideation.angles[0]!
  );
}

function chosenOffer(outputs: PipelineStepOutputs): OfferSpec {
  return requireOutput(outputs, 'OFFER_DEVELOPMENT').offer;
}

/**
 * Builds the input for a single step from whatever earlier outputs exist.
 * Exported so the console can show exactly what a re-run would be given.
 */
export function buildStepInput(input: RegenerateStepInput): unknown {
  const settings = { ...GENERATION_SETTINGS_DEFAULTS, ...input.settings };
  const { context, outputs } = input;

  switch (input.step) {
    case 'CONTEXT_SUMMARY':
      return { context };
    case 'HISTORY_FRAMING':
      return { context, summary: requireOutput(outputs, 'CONTEXT_SUMMARY') };
    case 'ANGLE_IDEATION':
      return {
        context,
        summary: requireOutput(outputs, 'CONTEXT_SUMMARY'),
        framing: requireOutput(outputs, 'HISTORY_FRAMING'),
        recentAngleNames: input.recentAngleNames ?? [],
      };
    case 'ANGLE_DISTINCTNESS': {
      const distinctness = input.angleDistinctness;
      if (!distinctness) {
        throw new DomainError('CONFLICT', {
          messageDe:
            'Die Angle-Prüfung benötigt das berechnete Ähnlichkeitsergebnis; es wird nicht vom Modell erzeugt.',
        });
      }
      return {
        context,
        candidate: chosenAngle(outputs),
        verdict: distinctness.verdict,
        verdictLabelDe: distinctness.verdictLabelDe,
        similarCampaignNames: distinctness.similarCampaigns.map((entry) => entry.campaignName),
      };
    }
    case 'OFFER_DEVELOPMENT':
      return {
        context,
        summary: requireOutput(outputs, 'CONTEXT_SUMMARY'),
        angle: chosenAngle(outputs),
      };
    case 'CORE_MESSAGE':
      return { context, angle: chosenAngle(outputs), offer: chosenOffer(outputs) };
    case 'CREATIVE_CONCEPTION':
      return {
        context,
        angle: chosenAngle(outputs),
        offer: chosenOffer(outputs),
        coreMessage: requireOutput(outputs, 'CORE_MESSAGE'),
        conceptCount: settings.conceptCount,
        principles: settings.principles.slice(0, settings.conceptCount),
        ...(input.diversityFeedbackDe && input.diversityFeedbackDe.length > 0
          ? { diversityFeedbackDe: input.diversityFeedbackDe }
          : {}),
      };
    case 'META_COPY':
      return {
        context,
        angle: chosenAngle(outputs),
        offer: chosenOffer(outputs),
        coreMessage: requireOutput(outputs, 'CORE_MESSAGE'),
        concepts: requireOutput(outputs, 'CREATIVE_CONCEPTION').concepts,
      };
    case 'FUNNEL_STRATEGY':
      return {
        context,
        angle: chosenAngle(outputs),
        offer: chosenOffer(outputs),
        coreMessage: requireOutput(outputs, 'CORE_MESSAGE'),
        funnelCount: settings.funnelCount,
        minMultiStepForms: settings.minMultiStepForms,
        minQuestions: FUNNEL_STRATEGY_DEFAULTS.minQuestions,
        maxQuestions: FUNNEL_STRATEGY_DEFAULTS.maxQuestions,
      };
    case 'FUNNEL_SPEC': {
      const strategy = requireOutput(outputs, 'FUNNEL_STRATEGY');
      const funnel =
        strategy.funnels.find((entry) => entry.key === input.funnelKey) ?? strategy.funnels[0]!;
      const concepts = outputs.CREATIVE_CONCEPTION?.concepts ?? [];
      const copies = outputs.META_COPY?.copies ?? [];
      const leadCopy = copies[0];
      const leadDraft = concepts[0];
      return {
        context,
        funnel,
        offer: chosenOffer(outputs),
        coreMessage: requireOutput(outputs, 'CORE_MESSAGE'),
        leadConcept:
          leadDraft && leadCopy ? { ...leadDraft, copy: leadCopy.copy, claims: [] } : null,
      };
    }
    case 'CLAIM_GUARDRAIL_CHECK':
      return {
        context,
        concepts: mergeConcepts(
          requireOutput(outputs, 'CREATIVE_CONCEPTION'),
          requireOutput(outputs, 'META_COPY'),
        ),
        coreMessage: requireOutput(outputs, 'CORE_MESSAGE'),
        offer: chosenOffer(outputs),
      };
    case 'CAMPAIGN_PACKAGE':
      return {
        context,
        angle: chosenAngle(outputs),
        offer: chosenOffer(outputs),
        coreMessage: requireOutput(outputs, 'CORE_MESSAGE'),
        concepts: mergeConcepts(
          requireOutput(outputs, 'CREATIVE_CONCEPTION'),
          requireOutput(outputs, 'META_COPY'),
        ),
        funnels: requireOutput(outputs, 'FUNNEL_STRATEGY').funnels,
        similarPastCampaigns: input.angleDistinctness?.similarCampaigns ?? [],
        metricOptions: Object.keys(METRIC_CATALOG) as MetricKey[],
      };
    default:
      throw new DomainError('NOT_FOUND', {
        messageDe: 'Unbekannter Pipeline-Schritt.',
        details: { step: input.step },
      });
  }
}

/** Re-runs a single step in isolation, producing a fresh `ai_jobs` row. */
export function regenerateStep(
  input: RegenerateStepInput,
  deps: PipelineDeps,
): Promise<{ job: AiJob; output: unknown }> {
  const promptInput = buildStepInput(input);
  return runStep<unknown, unknown>(input.step, promptInput, deps, {
    ...(input.step === 'FUNNEL_SPEC' && input.funnelKey
      ? { metadata: { funnelKey: input.funnelKey } }
      : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Full pipeline                                                               */
/* -------------------------------------------------------------------------- */

function unavailableDistinctness(reasonDe: string): AngleDistinctnessResult {
  return {
    verdict: 'DISTINCT',
    verdictLabelDe: ANGLE_VERDICT_LABELS_DE.DISTINCT,
    maxSimilarity: 0,
    similarCampaigns: [],
    explanationDe: reasonDe,
  };
}

/**
 * Runs steps 1 → 12 and returns a validated `CampaignProposal`.
 *
 * Progress is emitted per step. Any step that fails leaves a FAILED job behind
 * and aborts the run — a half-applied proposal is never returned.
 */
export async function runCampaignPipeline(
  input: CampaignPipelineInput,
  deps: PipelineDeps,
): Promise<CampaignPipelineResult> {
  const settings = { ...GENERATION_SETTINGS_DEFAULTS, ...input.generation };
  const experiment = { ...EXPERIMENT_SETTINGS_DEFAULTS, ...input.experiment };
  const context = buildContext(input);
  const outputs: PipelineStepOutputs = {};
  const jobs: AiJob[] = [];

  const record = async <T>(
    step: PipelineStep,
    run: () => Promise<{ job: AiJob; output: T }>,
  ): Promise<T> => {
    await emit(deps, progress(step, 'STARTED', null));
    try {
      const result = await run();
      jobs.push(result.job);
      await emit(deps, progress(step, 'SUCCEEDED', result.job.id));
      return result.output;
    } catch (error) {
      await emit(
        deps,
        progress(
          step,
          'FAILED',
          null,
          error instanceof DomainError ? error.messageDe : 'Unerwarteter Fehler.',
        ),
      );
      throw error;
    }
  };

  /* 1 — context summary */
  outputs.CONTEXT_SUMMARY = await record('CONTEXT_SUMMARY', () =>
    runStep<unknown, ContextSummary>(
      'CONTEXT_SUMMARY',
      buildStepInput({ step: 'CONTEXT_SUMMARY', context, outputs }),
      deps,
    ),
  );

  /* 2 — historical similarity framing */
  outputs.HISTORY_FRAMING = await record('HISTORY_FRAMING', () =>
    runStep<unknown, HistoryFraming>(
      'HISTORY_FRAMING',
      buildStepInput({ step: 'HISTORY_FRAMING', context, outputs }),
      deps,
    ),
  );

  /* 3 — angle ideation */
  outputs.ANGLE_IDEATION = await record('ANGLE_IDEATION', () =>
    runStep<unknown, AngleIdeation>(
      'ANGLE_IDEATION',
      buildStepInput({
        step: 'ANGLE_IDEATION',
        context,
        outputs,
        recentAngleNames: input.recentAngleNames ?? [],
      }),
      deps,
    ),
  );

  /* Deterministic: measure the angle against the historical index. */
  const history = input.history ?? [];
  const angleDistinctness =
    deps.embeddings && history.length > 0
      ? await checkAngleDistinctness(chosenAngle(outputs), history, {
          embeddings: deps.embeddings,
          ...(input.now ? { now: input.now } : {}),
        })
      : unavailableDistinctness(
          deps.embeddings
            ? 'Im gewählten Zeitraum liegen keine historischen Kampagnen-Embeddings vor. Die Abgrenzung konnte nicht gegen den Index geprüft werden.'
            : 'Es steht kein Embedding-Anbieter zur Verfügung. Die Abgrenzung konnte nicht gegen den Index geprüft werden.',
        );

  /* 4 — angle distinctness review */
  outputs.ANGLE_DISTINCTNESS = await record('ANGLE_DISTINCTNESS', () =>
    runStep<unknown, AngleDistinctnessReview>(
      'ANGLE_DISTINCTNESS',
      buildStepInput({ step: 'ANGLE_DISTINCTNESS', context, outputs, angleDistinctness }),
      deps,
    ),
  );

  /* 5 — offer */
  outputs.OFFER_DEVELOPMENT = await record('OFFER_DEVELOPMENT', () =>
    runStep<unknown, OfferDevelopment>(
      'OFFER_DEVELOPMENT',
      buildStepInput({ step: 'OFFER_DEVELOPMENT', context, outputs }),
      deps,
    ),
  );

  /* 6 — core message */
  outputs.CORE_MESSAGE = await record('CORE_MESSAGE', () =>
    runStep<unknown, CoreMessage>(
      'CORE_MESSAGE',
      buildStepInput({ step: 'CORE_MESSAGE', context, outputs }),
      deps,
    ),
  );

  /* 7 + 8 — concepts and copy, retried once if the diversity check blocks. */
  let diversity: DiversityReport | null = null;
  let concepts: CreativeConcept[] = [];
  let diversityFeedbackDe: readonly string[] = [];

  for (let attempt = 0; attempt <= settings.maxDiversityRetries; attempt++) {
    outputs.CREATIVE_CONCEPTION = await record('CREATIVE_CONCEPTION', () =>
      runStep<unknown, CreativeConception>(
        'CREATIVE_CONCEPTION',
        buildStepInput({
          step: 'CREATIVE_CONCEPTION',
          context,
          outputs,
          settings,
          diversityFeedbackDe,
        }),
        deps,
        { postValidate: (value) => validateConception(value, settings) },
      ),
    );

    outputs.META_COPY = await record('META_COPY', () =>
      runStep<unknown, MetaCopySet>(
        'META_COPY',
        buildStepInput({ step: 'META_COPY', context, outputs }),
        deps,
        {
          postValidate: (value) => validateCopySet(value, outputs.CREATIVE_CONCEPTION!),
        },
      ),
    );

    concepts = mergeConcepts(outputs.CREATIVE_CONCEPTION, outputs.META_COPY);
    diversity = await checkCreativeDiversity(concepts, {
      ...(deps.embeddings ? { embeddings: deps.embeddings } : {}),
      ...(settings.diversity ? { thresholds: settings.diversity } : {}),
    });

    if (!diversity.blocked) break;
    diversityFeedbackDe = diversity.reasonsDe;
  }

  // Fewer than five conceptually distinct creatives blocks the package.
  assertDiversityReport(diversity!);

  /* 9 — funnel strategy */
  outputs.FUNNEL_STRATEGY = await record('FUNNEL_STRATEGY', () =>
    runStep<unknown, FunnelStrategy>(
      'FUNNEL_STRATEGY',
      buildStepInput({ step: 'FUNNEL_STRATEGY', context, outputs, settings }),
      deps,
      { postValidate: (value) => validateFunnelStrategy(value, settings) },
    ),
  );

  /* 10 — one funnel specification per proposed variant */
  const funnelSpecDrafts: FunnelSpecDraft[] = [];
  await emit(deps, progress('FUNNEL_SPEC', 'STARTED', null));
  try {
    for (const funnel of outputs.FUNNEL_STRATEGY.funnels) {
      const result = await runStep<unknown, FunnelSpecDraft>(
        'FUNNEL_SPEC',
        buildStepInput({ step: 'FUNNEL_SPEC', context, outputs, funnelKey: funnel.key }),
        deps,
        { metadata: { funnelKey: funnel.key } },
      );
      jobs.push(result.job);
      funnelSpecDrafts.push(result.output);
    }
    outputs.FUNNEL_SPEC = funnelSpecDrafts;
    await emit(
      deps,
      progress('FUNNEL_SPEC', 'SUCCEEDED', jobs[jobs.length - 1]?.id ?? null),
    );
  } catch (error) {
    await emit(
      deps,
      progress(
        'FUNNEL_SPEC',
        'FAILED',
        null,
        error instanceof DomainError ? error.messageDe : 'Unerwarteter Fehler.',
      ),
    );
    throw error;
  }

  /* 11 — claims and guardrails */
  const claimReviewRaw = await record('CLAIM_GUARDRAIL_CHECK', () =>
    runStep<unknown, ClaimReview>(
      'CLAIM_GUARDRAIL_CHECK',
      buildStepInput({ step: 'CLAIM_GUARDRAIL_CHECK', context, outputs }),
      deps,
      { postValidate: validateClaimReview },
    ),
  );
  // `blocked` is recomputed rather than trusted: the model reports what it
  // found, the system decides what that means.
  const claimReview: ClaimReview = {
    ...claimReviewRaw,
    blocked: claimReviewRaw.violations.some((violation) => violation.severity === 'BLOCK'),
  };
  outputs.CLAIM_GUARDRAIL_CHECK = claimReview;

  /* 12 — package */
  const pkg = await record('CAMPAIGN_PACKAGE', () =>
    runStep<unknown, CampaignPackage>(
      'CAMPAIGN_PACKAGE',
      buildStepInput({ step: 'CAMPAIGN_PACKAGE', context, outputs, angleDistinctness }),
      deps,
    ),
  );
  outputs.CAMPAIGN_PACKAGE = pkg;

  const proposal = assembleProposal({
    pkg,
    angle: chosenAngle(outputs),
    offer: chosenOffer(outputs),
    coreMessage: outputs.CORE_MESSAGE,
    summary: outputs.CONTEXT_SUMMARY,
    concepts,
    funnels: outputs.FUNNEL_STRATEGY.funnels,
    claimReview,
    similarPastCampaigns: angleDistinctness.similarCampaigns,
    differentiationFallbackDe: outputs.ANGLE_DISTINCTNESS.differentiationDe,
    budget: input.budget,
    experiment,
  });

  return {
    proposal,
    jobs,
    outputs,
    diversity: diversity!,
    angleDistinctness,
    funnelSpecDrafts,
    claimReview,
    contextHash: context.contextHash,
  };
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

export interface AssembleProposalInput {
  pkg: CampaignPackage;
  angle: AngleSpec;
  offer: OfferSpec;
  coreMessage: CoreMessage;
  summary: ContextSummary;
  concepts: readonly CreativeConcept[];
  funnels: readonly FunnelProposal[];
  claimReview: ClaimReview;
  similarPastCampaigns: readonly SimilarCampaignReference[];
  differentiationFallbackDe: string;
  budget: BudgetSettings;
  experiment: ExperimentSettings;
}

/**
 * Merges the step outputs into a `CampaignProposal` and validates it.
 *
 * Every number here comes from `input.budget` / `input.experiment` — the
 * deterministic settings the caller supplied — or from `METRIC_CATALOG`. None
 * of them passes through a model.
 */
export function assembleProposal(input: AssembleProposalInput): CampaignProposal {
  const { pkg, budget, experiment } = input;
  const controlKey = input.funnels[0]?.key ?? 'funnel_1';
  const variantKeys = input.funnels.slice(1).map((funnel) => funnel.key);

  const candidate = {
    campaignName: pkg.campaignName,
    audience: pkg.audience,
    angle: input.angle,
    offer: input.offer,
    coreMessage: input.coreMessage.coreMessageDe,
    hypothesis: input.coreMessage.hypothesisDe,
    historicalEvidence: toEvidenceReferences(input.summary),
    similarPastCampaigns: [...input.similarPastCampaigns],
    differentiationFromPast: pkg.differentiationFromPast || input.differentiationFallbackDe,
    claims: input.claimReview.claims,
    risks: uniqueCapped([...pkg.risks, ...input.claimReview.risksDe], 15),
    creativeConcepts: [...input.concepts],
    funnelProposals: [...input.funnels],
    experimentPlan: {
      kind: pkg.experimentKind,
      hypothesis: pkg.experimentHypothesisDe,
      testVariable: pkg.testVariableDe,
      controlKey,
      variantKeys: variantKeys.length > 0 ? variantKeys : [controlKey],
      primaryMetric: pkg.primaryMetric,
      secondaryMetrics: pkg.secondaryMetrics,
      guardrailMetrics: pkg.guardrailMetrics,
      minRuntimeDays: experiment.minRuntimeDays,
      maxRuntimeDays: experiment.maxRuntimeDays,
      minSessionsPerArm: experiment.minSessionsPerArm,
      minConversionsPerArm: experiment.minConversionsPerArm,
      crmMaturityDays: experiment.crmMaturityDays,
      stopRules: pkg.stopRulesDe,
      scaleRules: pkg.scaleRulesDe,
      eligibilityChanging: false,
    },
    primaryMetric: METRIC_CATALOG[pkg.primaryMetric],
    secondaryMetrics: pkg.secondaryMetrics.map((key) => METRIC_CATALOG[key]),
    guardrailMetrics: pkg.guardrailMetrics.map((key) => METRIC_CATALOG[key]),
    recommendedBudget: {
      dailyBudgetMinor: budget.dailyBudgetMinor,
      currency: budget.currency ?? 'EUR',
      testBudgetMinor: budget.dailyBudgetMinor * budget.testDays,
      rationale: pkg.budgetRationaleDe,
      targetCplMinor: budget.targetCplMinor ?? null,
      targetCostPerQualifiedVqMinor: budget.targetCostPerQualifiedVqMinor ?? null,
    },
  };

  const parsed = campaignProposalSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DomainError('AI_OUTPUT_INVALID', {
      messageDe: 'Das zusammengesetzte Kampagnenpaket entspricht nicht dem erwarteten Schema.',
      details: {
        issues: parsed.error.issues.map(
          (entry) => `${entry.path.join('.') || '(root)'}: ${entry.message}`,
        ),
      },
    });
  }

  // Last line of defence: nothing PII-shaped may reach a stored proposal.
  assertContextFree(parsed.data, '$.proposal');
  return parsed.data;
}
