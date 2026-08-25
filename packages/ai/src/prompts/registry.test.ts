import { isDomainError } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  ALL_PROMPTS,
  getPromptById,
  getPromptForStep,
  listPrompts,
  PIPELINE_PROMPTS,
} from './registry';
import { PIPELINE_STEPS, promptContentHash, promptFingerprint } from './types';

describe('prompt registry', () => {
  it('covers all twelve pipeline steps plus the explanation helper', () => {
    expect(Object.keys(PIPELINE_PROMPTS).sort()).toEqual([...PIPELINE_STEPS].sort());
    expect(ALL_PROMPTS).toHaveLength(13);
  });

  it('exposes the expected prompt ids at version 1.0.0', () => {
    expect(ALL_PROMPTS.map((prompt) => `${prompt.id}@${prompt.version}`)).toEqual([
      'context.summarize@1.0.0',
      'history.similarity_framing@1.0.0',
      'angle.ideation@1.0.0',
      'angle.distinctness_review@1.0.0',
      'offer.development@1.0.0',
      'message.core@1.0.0',
      'creative.conception@1.0.0',
      'creative.meta_copy@1.0.0',
      'funnel.strategy@1.0.0',
      'funnel.spec_draft@1.0.0',
      'guardrails.claim_check@1.0.0',
      'campaign.package@1.0.0',
      'analytics.explain@1.0.0',
    ]);
  });

  it('maps every step to a prompt that declares that step', () => {
    for (const step of PIPELINE_STEPS) {
      expect(getPromptForStep(step).step).toBe(step);
    }
  });

  it('resolves by id and reports an unknown id as NOT_FOUND', () => {
    expect(getPromptById('creative.conception').step).toBe('CREATIVE_CONCEPTION');
    expect.assertions(3);
    try {
      getPromptById('does.not.exist');
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('NOT_FOUND');
    }
  });

  it('content-hashes each prompt stably and distinctly', () => {
    const hashes = ALL_PROMPTS.map(promptContentHash);
    expect(hashes.every((hash) => /^[0-9a-f]{16}$/.test(hash))).toBe(true);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(promptContentHash(ALL_PROMPTS[0]!)).toBe(hashes[0]);
  });

  it('produces a fingerprint an ai_jobs row can store verbatim', () => {
    expect(promptFingerprint(PIPELINE_PROMPTS.CONTEXT_SUMMARY)).toMatch(
      /^context\.summarize@1\.0\.0#[0-9a-f]{16}$/,
    );
  });

  it('lists the registry for the console', () => {
    const entries = listPrompts();
    expect(entries).toHaveLength(13);
    expect(entries[0]).toMatchObject({
      id: 'context.summarize',
      version: '1.0.0',
      step: 'CONTEXT_SUMMARY',
      capability: 'TEXT',
    });
    expect(entries.every((entry) => entry.purposeDe.length > 10)).toBe(true);
  });
});

describe('prompt content rules', () => {
  it('states every non-negotiable rule in every system prompt', () => {
    const required = [
      'APPROVED CONTEXT ONLY',
      'NEVER PRODUCE NUMBERS',
      'LABEL EVERY CLAIM',
      'NO MARKUP',
      'MOTIFS CARRY NO TYPOGRAPHY',
      'NO PERSONAL DATA',
      'GERMAN OUTPUT',
      'JSON ONLY',
    ];
    for (const prompt of ALL_PROMPTS) {
      for (const rule of required) {
        expect(prompt.systemPrompt, `${prompt.id} is missing "${rule}"`).toContain(rule);
      }
    }
  });

  it('spells out the FACT / INDICATION / HYPOTHESIS labels', () => {
    for (const prompt of ALL_PROMPTS) {
      expect(prompt.systemPrompt).toMatch(/FACT/);
      expect(prompt.systemPrompt).toMatch(/INDICATION/);
      expect(prompt.systemPrompt).toMatch(/HYPOTHESIS/);
    }
  });

  it('forbids typography in motifs where images are conceived', () => {
    const conception = PIPELINE_PROMPTS.CREATIVE_CONCEPTION.systemPrompt;
    expect(conception).toContain('never request text, letters, numerals');
    expect(conception).toContain('logos');
    expect(conception).toContain('composed deterministically afterwards');
  });

  it('forbids markup where the funnel specification is drafted', () => {
    const spec = PIPELINE_PROMPTS.FUNNEL_SPEC.systemPrompt;
    expect(spec).toContain('no HTML tags, no CSS, no JavaScript');
    expect(spec).toContain('controlled component library');
  });

  it('builds a German user prompt that carries context, brief and guardrails', () => {
    const context = {
      contextBlock: '### Marke\nA&M Beratung',
      brandName: 'A&M Beratung',
      guardrailsDe: ['[BLOCK] FORBIDDEN_TERM — Preisargumente sind ausgeschlossen.'],
      briefDe: 'Neue Kampagne für Elektrobetriebe.',
      contextHash: 'abc',
    };
    const userPrompt = PIPELINE_PROMPTS.CONTEXT_SUMMARY.buildUserPrompt({ context });

    expect(userPrompt).toContain('## Freigegebener Kontext');
    expect(userPrompt).toContain('## Auftrag für diese Kampagne');
    expect(userPrompt).toContain('## Guardrails');
    expect(userPrompt).toContain('[BLOCK] FORBIDDEN_TERM');
    expect(userPrompt).toContain('## Aufgabe');
  });
});
