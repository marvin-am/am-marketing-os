import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_STATES,
  CAMPAIGN_STATE_LABELS_DE,
  CAMPAIGN_TRANSITIONS,
  GENERATION_DEFAULTS,
  campaignProposalSchema,
  canTransition,
  claimSpecStrictSchema,
  nextStates,
  validateFunnelMix,
} from './index';

describe('campaign state machine', () => {
  it('covers every state in the transition table', () => {
    for (const state of CAMPAIGN_STATES) {
      expect(CAMPAIGN_TRANSITIONS[state]).toBeDefined();
      expect(CAMPAIGN_STATE_LABELS_DE[state]).toBeTruthy();
    }
  });

  it('only allows declared transitions', () => {
    expect(canTransition('IDEA', 'PROPOSED')).toBe(true);
    expect(canTransition('PROPOSED', 'STRATEGY_REVIEW')).toBe(true);
    expect(canTransition('IDEA', 'LIVE')).toBe(false);
    expect(canTransition('STRATEGY_REVIEW', 'LIVE')).toBe(false);
  });

  it('treats ARCHIVED as terminal', () => {
    expect(nextStates('ARCHIVED')).toHaveLength(0);
  });

  it('does not allow returning to LIVE from COMPLETED', () => {
    expect(canTransition('COMPLETED', 'LIVE')).toBe(false);
    expect(canTransition('COMPLETED', 'ARCHIVED')).toBe(true);
  });

  it('reaches LIVE only through the launch sequence', () => {
    const path = [
      'IDEA',
      'PROPOSED',
      'STRATEGY_REVIEW',
      'STRATEGY_APPROVED',
      'ASSET_GENERATION',
      'ASSET_REVIEW',
      'TEST_PLAN_REVIEW',
      'READY_FOR_LAUNCH_QA',
      'READY_FOR_META_DRAFT',
      'META_DRAFT_CREATED',
      'LIVE',
    ] as const;

    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('never lists a state as its own successor', () => {
    for (const state of CAMPAIGN_STATES) {
      expect(CAMPAIGN_TRANSITIONS[state]).not.toContain(state);
    }
  });
});

describe('claim evidence rule', () => {
  const base = {
    text: 'Wir senken die Kosten unqualifizierter Leads um 40 %.',
    evidence: null,
    confidence: 'FACT' as const,
    requiresHypothesisLabel: false,
  };

  it('rejects an unsupported claim that is not labelled a hypothesis', () => {
    const result = claimSpecStrictSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('accepts an unsupported claim that is labelled a hypothesis', () => {
    const result = claimSpecStrictSchema.safeParse({
      ...base,
      confidence: 'HYPOTHESIS',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a claim backed by evidence', () => {
    const result = claimSpecStrictSchema.safeParse({
      ...base,
      evidence: {
        evidenceItemId: null,
        kind: 'CASE_STUDY',
        summary: 'Fallstudie Muster GmbH, Q3',
        sourceRef: 'case-study-42',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('funnel mix rules', () => {
  const multiStep = (key: string) => ({
    key,
    kind: 'MULTI_STEP_FORM' as const,
    name: 'Potenzialanalyse',
    rationale: 'Schneller Funnel mit Qualifizierung vor der Kontaktaufnahme.',
    hypothesis: 'Ein kurzer Fragenpfad qualifiziert besser als eine Landingpage.',
    promise: 'In 2 Minuten zur Potenzialanalyse',
    qualificationQuestionCount: 5,
    questionOutline: [],
    resultConcept: 'Individuelle Einschätzung mit Terminvorschlag.',
  });

  it('requires at least two MULTI_STEP_FORM variants', () => {
    const problems = validateFunnelMix([
      multiStep('funnel_1'),
      { ...multiStep('funnel_2'), kind: 'LANDING_PAGE' },
    ]);
    expect(problems.join(' ')).toContain('MULTI_STEP_FORM');
  });

  it('accepts a compliant mix', () => {
    expect(
      validateFunnelMix([
        multiStep('funnel_1'),
        multiStep('funnel_2'),
        { ...multiStep('funnel_3'), kind: 'LANDING_PAGE' },
      ]),
    ).toEqual([]);
  });

  it('rejects duplicate funnel keys', () => {
    const problems = validateFunnelMix([multiStep('funnel_1'), multiStep('funnel_1')]);
    expect(problems.join(' ')).toContain('eindeutig');
  });

  it('rejects a single proposal', () => {
    expect(validateFunnelMix([multiStep('funnel_1')]).length).toBeGreaterThan(0);
  });
});

describe('generation defaults', () => {
  it('matches the specified counts', () => {
    expect(GENERATION_DEFAULTS.creativeConceptCount).toBe(6);
    expect(GENERATION_DEFAULTS.minApprovedCreatives).toBe(5);
    expect(GENERATION_DEFAULTS.minMultiStepFormVariants).toBe(2);
    expect(GENERATION_DEFAULTS.defaultQualificationQuestions).toBe(5);
  });

  it('constrains a proposal to at least five creative concepts', () => {
    const shape = campaignProposalSchema.shape.creativeConcepts;
    const result = shape.safeParse([]);
    expect(result.success).toBe(false);
  });
});
