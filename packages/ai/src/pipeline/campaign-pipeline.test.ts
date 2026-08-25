import {
  campaignProposalSchema,
  GENERATION_DEFAULTS,
  isDomainError,
  validateFunnelMix,
} from '@am/domain';
import { describe, expect, it } from 'vitest';
import { fixtureContextBundle } from '../provider/fixture-bundle';
import { FixtureEmbeddingProvider } from '../provider/fixture-embedding';
import { FixtureTextProvider } from '../provider/fixture-text';
import { PIPELINE_STEPS } from '../prompts/types';
import { toLandingPageSpec, toMultiStepFormSpec } from './funnel-spec-adapter';
import { buildContext } from './context';
import {
  buildStepInput,
  regenerateStep,
  runCampaignPipeline,
  validateFunnelStrategy,
  type CampaignPipelineInput,
} from './campaign-pipeline';
import type { AiJob, PipelineDeps, PipelineProgress } from './types';

function makeDeps(provider = new FixtureTextProvider()) {
  const jobs: AiJob[] = [];
  const progress: PipelineProgress[] = [];
  let counter = 0;
  const deps: PipelineDeps = {
    text: provider,
    embeddings: new FixtureEmbeddingProvider(),
    now: () => '2026-08-25T12:00:00.000Z',
    newId: () => `job-${++counter}`,
    onJob: (job) => {
      jobs.push(job);
    },
    onProgress: (event) => {
      progress.push(event);
    },
  };
  return { deps, jobs, progress, provider };
}

const input: CampaignPipelineInput = {
  bundle: fixtureContextBundle(),
  briefDe:
    'Neue Kampagne für Elektro-, Sanitär- und Dachbetriebe im dritten Quartal. Ziel sind terminierte Vorqualifizierungsgespräche.',
  recentAngleNames: ['Fachkräftemangel im Handwerk', 'Arbeitgebermarke aufbauen'],
  budget: { dailyBudgetMinor: 6_000, testDays: 14, targetCplMinor: 4_500 },
  now: '2026-08-25T00:00:00+00:00',
};

describe('runCampaignPipeline', () => {
  it('produces a schema-valid CampaignProposal', async () => {
    const { deps } = makeDeps();
    const result = await runCampaignPipeline(input, deps);

    expect(() => campaignProposalSchema.parse(result.proposal)).not.toThrow();
    expect(result.proposal.campaignName.length).toBeGreaterThan(0);
    expect(result.proposal.coreMessage.length).toBeGreaterThan(20);
    expect(result.contextHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates exactly six creative concepts, one per principle, each with copy', async () => {
    const { deps } = makeDeps();
    const { proposal } = await runCampaignPipeline(input, deps);

    expect(proposal.creativeConcepts).toHaveLength(GENERATION_DEFAULTS.creativeConceptCount);
    expect(proposal.creativeConcepts.map((concept) => concept.key)).toEqual([
      'concept_1',
      'concept_2',
      'concept_3',
      'concept_4',
      'concept_5',
      'concept_6',
    ]);
    expect(new Set(proposal.creativeConcepts.map((concept) => concept.principle)).size).toBe(6);
    for (const concept of proposal.creativeConcepts) {
      expect(concept.copy.primaryText.length).toBeGreaterThanOrEqual(30);
      expect(concept.copy.headline.length).toBeLessThanOrEqual(60);
      expect(concept.aspectRatios).toContain('1:1');
    }
  });

  it('proposes a funnel mix with at least two multi-step forms', async () => {
    const { deps } = makeDeps();
    const { proposal } = await runCampaignPipeline(input, deps);

    expect(validateFunnelMix(proposal.funnelProposals)).toEqual([]);
    expect(
      proposal.funnelProposals.filter((funnel) => funnel.kind === 'MULTI_STEP_FORM'),
    ).toHaveLength(2);
    expect(proposal.funnelProposals).toHaveLength(GENERATION_DEFAULTS.funnelVariantCount);
  });

  it('clears the diversity bar with six distinct concepts', async () => {
    const { deps } = makeDeps();
    const { diversity } = await runCampaignPipeline(input, deps);

    expect(diversity.blocked).toBe(false);
    expect(diversity.distinctCount).toBe(6);
    expect(diversity.distinctCount).toBeGreaterThanOrEqual(GENERATION_DEFAULTS.minApprovedCreatives);
  });

  it('takes every number in the plan and budget from the deterministic settings', async () => {
    const { deps } = makeDeps();
    const { proposal } = await runCampaignPipeline(
      { ...input, experiment: { minRuntimeDays: 10, minConversionsPerArm: 35 } },
      deps,
    );

    expect(proposal.recommendedBudget).toMatchObject({
      dailyBudgetMinor: 6_000,
      testBudgetMinor: 84_000,
      currency: 'EUR',
      targetCplMinor: 4_500,
    });
    expect(proposal.experimentPlan.minRuntimeDays).toBe(10);
    expect(proposal.experimentPlan.minConversionsPerArm).toBe(35);
    expect(proposal.experimentPlan.controlKey).toBe('funnel_1');
    expect(proposal.experimentPlan.variantKeys).toEqual(['funnel_2', 'funnel_3']);
  });

  it('resolves metric keys through the catalogue rather than through the model', async () => {
    const { deps } = makeDeps();
    const { proposal } = await runCampaignPipeline(input, deps);

    expect(proposal.primaryMetric.key).toBe('cost_per_qualified_vq');
    expect(proposal.primaryMetric.label).toBe('Kosten je qualifiziertem VQ');
    expect(proposal.primaryMetric.direction).toBe('LOWER_IS_BETTER');
    expect(proposal.guardrailMetrics.map((metric) => metric.key)).toEqual([
      'show_rate',
      'qualified_vq_rate',
    ]);
  });

  it('records one job per model call and emits progress for all twelve steps', async () => {
    const { deps, jobs, progress } = makeDeps();
    const result = await runCampaignPipeline(input, deps);

    // Twelve steps, but step 10 runs once per funnel variant.
    expect(result.jobs).toHaveLength(PIPELINE_STEPS.length + 2);
    expect(result.jobs.every((job) => job.status === 'SUCCEEDED')).toBe(true);
    expect(new Set(result.jobs.map((job) => job.id)).size).toBe(result.jobs.length);

    const started = progress.filter((event) => event.status === 'STARTED');
    expect(new Set(started.map((event) => event.step))).toEqual(new Set(PIPELINE_STEPS));
    expect(progress.every((event) => event.total === 12)).toBe(true);
    expect(progress.find((event) => event.step === 'META_COPY')?.labelDe).toBe(
      'Meta-Texte schreiben',
    );

    // Persistence hook sees RUNNING and a terminal state for every job.
    expect(jobs.filter((job) => job.status === 'RUNNING')).toHaveLength(result.jobs.length);
  });

  it('carries only approved, non-hypothetical evidence into the proposal', async () => {
    const { deps } = makeDeps();
    const { proposal } = await runCampaignPipeline(input, deps);

    expect(proposal.historicalEvidence.length).toBeGreaterThan(0);
    expect(proposal.historicalEvidence.map((entry) => entry.kind)).toContain('APPROVED_FACT');
    // Every unsupported statement stays in `claims`, labelled, never in evidence.
    expect(proposal.claims.some((claim) => claim.confidence === 'HYPOTHESIS')).toBe(true);
    expect(
      proposal.claims.every(
        (claim) =>
          claim.evidence !== null || claim.requiresHypothesisLabel || claim.confidence === 'HYPOTHESIS',
      ),
    ).toBe(true);
  });

  it('recomputes the guardrail verdict instead of trusting the model', async () => {
    const { deps } = makeDeps();
    const { claimReview } = await runCampaignPipeline(input, deps);

    expect(claimReview.blocked).toBe(
      claimReview.violations.some((violation) => violation.severity === 'BLOCK'),
    );
  });

  it('generates one funnel specification per proposed variant', async () => {
    const { deps } = makeDeps();
    const { funnelSpecDrafts, proposal } = await runCampaignPipeline(input, deps);

    expect(funnelSpecDrafts).toHaveLength(proposal.funnelProposals.length);
    expect(funnelSpecDrafts.map((draft) => draft.funnelKey)).toEqual([
      'funnel_1',
      'funnel_2',
      'funnel_3',
    ]);
    for (const draft of funnelSpecDrafts) {
      expect(draft.consentTextDe).toContain('Einwilligung');
      expect(JSON.stringify(draft)).not.toMatch(/<[a-z/]/i);
    }
  });

  it('blocks the package when fewer than five concepts are conceptually distinct', async () => {
    expect.assertions(2);
    const { deps } = makeDeps();

    try {
      await runCampaignPipeline(
        // A pair threshold of 0 makes every pair collide, which is what a set of
        // six restatements would do in production.
        { ...input, generation: { maxDiversityRetries: 0, diversity: { pair: 0 } } },
        deps,
      );
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('DIVERSITY_INSUFFICIENT');
    }
  });

  it('aborts with a failed job and returns no partial proposal when a step fails', async () => {
    expect.assertions(4);
    const { deps, jobs } = makeDeps(new FixtureTextProvider({ invalidFor: ['funnel.strategy'] }));

    try {
      await runCampaignPipeline(input, deps);
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('AI_OUTPUT_INVALID');
    }

    const failed = jobs.filter((job) => job.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.promptId).toBe('funnel.strategy');
  });

  it('runs without an embedding provider and says the index was not consulted', async () => {
    const { deps } = makeDeps();
    const { embeddings: _embeddings, ...withoutEmbeddings } = deps;

    const result = await runCampaignPipeline(input, withoutEmbeddings);
    expect(result.angleDistinctness.verdict).toBe('DISTINCT');
    expect(result.angleDistinctness.explanationDe).toContain('nicht gegen den Index geprüft');
    expect(result.diversity.blocked).toBe(false);
  });

  it('contains no PII anywhere in the produced proposal', async () => {
    const { deps } = makeDeps();
    const { proposal } = await runCampaignPipeline(input, deps);
    const serialized = JSON.stringify(proposal);

    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w-]{2,}/);
    expect(serialized).not.toMatch(/(?:\+|\b00)\d[\d\s\-()]{7,}/);
  });
});

describe('regenerateStep', () => {
  it('re-runs a single step in isolation from stored outputs', async () => {
    const { deps } = makeDeps();
    const { outputs } = await runCampaignPipeline(input, deps);
    const context = buildContext(input);

    const { job, output } = await regenerateStep(
      { step: 'META_COPY', context, outputs },
      makeDeps().deps,
    );

    expect(job.status).toBe('SUCCEEDED');
    expect(job.promptId).toBe('creative.meta_copy');
    expect((output as { copies: unknown[] }).copies).toHaveLength(6);
  });

  it('regenerates a specific funnel specification', async () => {
    const { deps } = makeDeps();
    const { outputs } = await runCampaignPipeline(input, deps);
    const context = buildContext(input);

    const { output } = await regenerateStep(
      { step: 'FUNNEL_SPEC', context, outputs, funnelKey: 'funnel_3' },
      makeDeps().deps,
    );

    expect((output as { funnelKey: string }).funnelKey).toBe('funnel_3');
    expect((output as { kind: string }).kind).toBe('LANDING_PAGE');
  });

  it('refuses to run a step whose prerequisites are missing', () => {
    const context = buildContext(input);
    expect(() => buildStepInput({ step: 'CAMPAIGN_PACKAGE', context, outputs: {} })).toThrow(
      /vorhergehender Schritt/,
    );
  });
});

describe('generation rules', () => {
  it('rejects a funnel strategy that breaks the multi-step minimum', () => {
    const settings = {
      conceptCount: 6,
      funnelCount: 3,
      minMultiStepForms: 2,
      principles: [],
      maxDiversityRetries: 1,
    };
    const strategy = {
      rationaleDe: 'Begründung mit ausreichender Länge für das Schema.',
      funnels: [
        {
          key: 'funnel_1',
          kind: 'LANDING_PAGE' as const,
          name: 'Seite A',
          rationale: 'Begründung mit ausreichender Länge für das Schema.',
          hypothesis: 'Hypothese mit ausreichender Länge für das Schema.',
          promise: 'Ein Versprechen.',
          qualificationQuestionCount: 4,
          questionOutline: [],
          resultConcept: 'Ergebnisseite mit Terminvorschlag.',
        },
        {
          key: 'funnel_2',
          kind: 'LANDING_PAGE' as const,
          name: 'Seite B',
          rationale: 'Begründung mit ausreichender Länge für das Schema.',
          hypothesis: 'Hypothese mit ausreichender Länge für das Schema.',
          promise: 'Ein Versprechen.',
          qualificationQuestionCount: 4,
          questionOutline: [],
          resultConcept: 'Ergebnisseite mit Terminvorschlag.',
        },
      ],
    };

    const issues = validateFunnelStrategy(strategy, settings);
    expect(issues.some((entry) => entry.includes('MULTI_STEP_FORM'))).toBe(true);
    expect(issues.some((entry) => entry.includes('genau 3'))).toBe(true);
  });
});

describe('funnel spec adapter', () => {
  const ids = {
    formId: '10000000-0000-4000-8000-000000000001',
    formVersionId: '10000000-0000-4000-8000-000000000002',
    pageId: '10000000-0000-4000-8000-000000000003',
    pageVersionId: '10000000-0000-4000-8000-000000000004',
    offerId: '10000000-0000-4000-8000-000000000005',
    angleId: '10000000-0000-4000-8000-000000000006',
  };

  it('turns a multi-step draft into a real MultiStepFormSpec', async () => {
    const { deps } = makeDeps();
    const { funnelSpecDrafts } = await runCampaignPipeline(input, deps);
    const draft = funnelSpecDrafts.find((entry) => entry.kind === 'MULTI_STEP_FORM')!;

    const spec = toMultiStepFormSpec(draft, {
      ...ids,
      angleName: 'Erstkontakt als Nadelöhr',
      offerType: 'POTENTIAL_ANALYSIS',
      offerName: 'Potenzialanalyse',
      effortPromise: '2 Minuten',
      consentVersionId: 'consent-v1',
      privacyPolicyUrl: 'https://www.example.de/datenschutz',
    });

    expect(spec.kind).toBe('MULTI_STEP_FORM');
    expect(spec.steps.length).toBeGreaterThan(1);
    expect(Object.keys(spec.fields)).toContain('mitarbeiterzahl');
  });

  it('turns a landing-page draft into a real LandingPageSpec', async () => {
    const { deps } = makeDeps();
    const { funnelSpecDrafts } = await runCampaignPipeline(input, deps);
    const draft = funnelSpecDrafts.find((entry) => entry.kind === 'LANDING_PAGE')!;

    const spec = toLandingPageSpec(draft, {
      ...ids,
      slug: 'potenzialanalyse-handwerk',
      companyLine: 'A&M Beratung GmbH',
    });

    expect(spec.kind).toBe('LANDING_PAGE');
    expect(spec.blocks.length).toBeGreaterThanOrEqual(2);
    expect(spec.blocks[0]!.type).toBe('HERO');
    // A proof point carries no invented figure.
    const proof = spec.blocks.find((block) => block.type === 'PROOF');
    if (proof && proof.type === 'PROOF') {
      expect(proof.points.every((point) => point.confidence === 'HYPOTHESIS')).toBe(true);
      expect(proof.points.every((point) => point.evidenceItemId === null)).toBe(true);
    }
  });

  it('refuses to build a form from a landing-page draft', async () => {
    const { deps } = makeDeps();
    const { funnelSpecDrafts } = await runCampaignPipeline(input, deps);
    const draft = funnelSpecDrafts.find((entry) => entry.kind === 'LANDING_PAGE')!;

    expect(() =>
      toMultiStepFormSpec(draft, {
        ...ids,
        angleName: 'Erstkontakt als Nadelöhr',
        offerType: 'POTENTIAL_ANALYSIS',
        consentVersionId: 'consent-v1',
        privacyPolicyUrl: 'https://www.example.de/datenschutz',
      }),
    ).toThrow(/mehrstufiges Formular/);
  });
});
