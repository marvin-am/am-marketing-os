import { isDomainError } from '@am/domain';
import { describe, expect, it } from 'vitest';
import { fixtureContextBundle } from '../provider/fixture-bundle';
import { FixtureTextProvider } from '../provider/fixture-text';
import type { StructuredRequest } from '../provider/types';
import { buildContext } from './context';
import { MAX_REPAIR_ATTEMPTS, runStep } from './run-step';
import type { AiJob, PipelineDeps } from './types';

const context = buildContext({
  bundle: fixtureContextBundle(),
  briefDe: 'Neue Kampagne für Elektro- und Sanitärbetriebe im dritten Quartal.',
});

function makeDeps(provider: FixtureTextProvider) {
  const jobs: AiJob[] = [];
  let counter = 0;
  const deps: PipelineDeps = {
    text: provider,
    now: () => `2026-08-25T12:00:0${counter}.000Z`,
    newId: () => `job-${++counter}`,
    onJob: (job) => {
      jobs.push(job);
    },
  };
  return { deps, jobs };
}

describe('runStep', () => {
  it('produces a succeeded job with full provenance', async () => {
    const provider = new FixtureTextProvider();
    const { deps, jobs } = makeDeps(provider);

    const { job, output } = await runStep('CONTEXT_SUMMARY', { context }, deps);

    expect(job.status).toBe('SUCCEEDED');
    expect(job.step).toBe('CONTEXT_SUMMARY');
    expect(job.promptId).toBe('context.summarize');
    expect(job.promptVersion).toBe('1.0.0');
    expect(job.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(job.inputHash).toMatch(/^[0-9a-f]{32}$/);
    expect(job.outputHash).toMatch(/^[0-9a-f]{32}$/);
    expect(job.model).toBe('fixture-text-v1');
    expect(job.repairAttempts).toBe(0);
    expect(job.error).toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect((output as { brandSummaryDe: string }).brandSummaryDe).toContain('A&M');

    // Persisted twice: once as RUNNING, once as the terminal state.
    expect(jobs.map((entry) => entry.status)).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(jobs[0]!.id).toBe(jobs[1]!.id);
  });

  it('is deterministic: identical input yields an identical output hash', async () => {
    const first = await runStep('CONTEXT_SUMMARY', { context }, makeDeps(new FixtureTextProvider()).deps);
    const second = await runStep('CONTEXT_SUMMARY', { context }, makeDeps(new FixtureTextProvider()).deps);
    expect(second.job.outputHash).toBe(first.job.outputHash);
    expect(second.job.inputHash).toBe(first.job.inputHash);
  });

  it('runs exactly one repair retry and then fails with AI_OUTPUT_INVALID', async () => {
    expect.assertions(9);
    const provider = new FixtureTextProvider({ invalidFor: ['context.summarize'] });
    const { deps, jobs } = makeDeps(provider);

    try {
      await runStep('CONTEXT_SUMMARY', { context }, deps);
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('AI_OUTPUT_INVALID');
        expect(error.retryable).toBe(false);
        expect((error.details.issues as string[]).length).toBeGreaterThan(0);
      }
    }

    expect(MAX_REPAIR_ATTEMPTS).toBe(1);
    expect(provider.calls).toHaveLength(2);
    // The first turn is plain; the second carries the previous output and the
    // concrete validation errors.
    expect(provider.calls[0]!.repair).toBeUndefined();
    const repair = (provider.calls[1] as StructuredRequest<unknown>).repair!;
    expect(repair.issues.length).toBeGreaterThan(0);

    const terminal = jobs[jobs.length - 1]!;
    expect({ status: terminal.status, repairAttempts: terminal.repairAttempts, code: terminal.error?.code }).toEqual({
      status: 'FAILED',
      repairAttempts: 1,
      code: 'AI_OUTPUT_INVALID',
    });
  });

  it('succeeds on the repair turn when the second answer validates', async () => {
    const provider = new FixtureTextProvider({ invalidUntilRepairFor: ['context.summarize'] });
    const { deps } = makeDeps(provider);

    const { job } = await runStep('CONTEXT_SUMMARY', { context }, deps);

    expect(job.status).toBe('SUCCEEDED');
    expect(job.repairAttempts).toBe(1);
    expect(provider.calls).toHaveLength(2);
  });

  it('never spends the repair turn on a refusal', async () => {
    expect.assertions(3);
    const provider = new FixtureTextProvider({ refuseFor: ['context.summarize'] });
    const { deps } = makeDeps(provider);

    try {
      await runStep('CONTEXT_SUMMARY', { context }, deps);
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('AI_OUTPUT_INVALID');
    }
    expect(provider.calls).toHaveLength(1);
  });

  it('surfaces a provider failure without rewriting it as invalid output', async () => {
    expect.assertions(3);
    const { deps } = makeDeps(new FixtureTextProvider());
    const failing: PipelineDeps = {
      ...deps,
      text: {
        kind: 'fixture',
        model: 'stub',
        generateStructured: () =>
          Promise.reject(
            Object.assign(new Error('rate limited'), { status: 429, name: 'RateLimitError' }),
          ),
      },
    };

    try {
      await runStep('CONTEXT_SUMMARY', { context }, failing);
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('PROVIDER_ERROR');
        expect(error.messageDe).toContain('externe Anbieter');
      }
    }
  });

  it('applies a post-validation hook through the same repair turn', async () => {
    expect.assertions(2);
    const provider = new FixtureTextProvider();
    const { deps } = makeDeps(provider);

    try {
      await runStep('CONTEXT_SUMMARY', { context }, deps, {
        postValidate: () => ['brandSummaryDe: erfundene Regel verletzt'],
      });
    } catch (error) {
      if (isDomainError(error)) expect(error.code).toBe('AI_OUTPUT_INVALID');
    }
    expect(provider.calls).toHaveLength(2);
  });
});
