import { DomainError, isDomainError, newId as newUuid, nowIso } from '@am/domain';
import { logger } from '@am/observability';
import { hashUnknown } from '../hash';
import { getPromptForStep } from '../prompts/registry';
import { promptContentHash, type AnyPromptDefinition, type PipelineStep } from '../prompts/types';
import type { StructuredRequest } from '../provider/types';
import type { AiJob, PipelineDeps, StepRunResult } from './types';

/**
 * Runs one prompt as one persistable job.
 *
 * The contract that matters: an unparseable or schema-violating response is a
 * **failed job**, never a partially applied proposal. There is exactly one
 * repair turn — the invalid output and the concrete validation errors are fed
 * back — and if that turn also fails the job ends as
 * `DomainError('AI_OUTPUT_INVALID')` with the issues attached.
 *
 * One retry, not three, is a deliberate limit. A second failure is almost never
 * a formatting slip; it is a prompt or schema problem, and looping on it burns
 * budget while hiding the real defect from whoever has to fix it.
 */

export const MAX_REPAIR_ATTEMPTS = 1;

export interface RunPromptOptions<TOutput> {
  /**
   * Extra validation applied after the schema passes. Returning issues triggers
   * the same bounded repair turn as a schema failure — used by `explain` to
   * reject an answer containing a number that is not in the supplied facts.
   */
  postValidate?: (output: TOutput) => string[];
  /** Passed to the provider; also selects fixture variants (e.g. `funnelKey`). */
  metadata?: Record<string, string>;
  maxOutputTokens?: number;
}

function issuesToError(issues: string[]): DomainError {
  return new DomainError('AI_OUTPUT_INVALID', {
    details: { issues },
    retryable: false,
  });
}

/** Runs any registered prompt. `runStep` is the pipeline-facing wrapper. */
export async function runPrompt<TInput, TOutput>(
  prompt: AnyPromptDefinition,
  input: TInput,
  deps: PipelineDeps,
  options: RunPromptOptions<TOutput> = {},
): Promise<StepRunResult<TOutput>> {
  const now = deps.now ?? nowIso;
  const createId = deps.newId ?? (() => newUuid<string>());

  const userPrompt = prompt.buildUserPrompt(input);
  const job: AiJob = {
    id: createId(),
    step: prompt.step,
    status: 'RUNNING',
    model: deps.text.model,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptHash: promptContentHash(prompt),
    inputHash: hashUnknown({ promptId: prompt.id, version: prompt.version, input }),
    outputHash: null,
    startedAt: now(),
    finishedAt: null,
    repairAttempts: 0,
    error: null,
  };
  await deps.onJob?.({ ...job });

  const baseRequest: Omit<StructuredRequest<TOutput>, 'repair'> = {
    schema: prompt.outputSchema,
    schemaName: prompt.id,
    systemPrompt: prompt.systemPrompt,
    userPrompt,
    ...(prompt.temperature !== undefined ? { temperature: prompt.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  const fail = async (error: DomainError, issues: string[]): Promise<never> => {
    const failed: AiJob = {
      ...job,
      status: 'FAILED',
      finishedAt: now(),
      error: { code: error.code, messageDe: error.messageDe, issues },
    };
    await deps.onJob?.({ ...failed });
    logger.error('ai_job_failed', {
      job_id: failed.id,
      step: failed.step,
      prompt_id: failed.promptId,
      prompt_version: failed.promptVersion,
      repair_attempts: failed.repairAttempts,
      issue_count: issues.length,
    });
    throw error;
  };

  let lastIssues: string[] = [];
  let lastRaw = '';

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    job.repairAttempts = attempt;

    let result;
    try {
      result = await deps.text.generateStructured<TOutput>(
        attempt === 0
          ? baseRequest
          : { ...baseRequest, repair: { previousRaw: lastRaw, issues: lastIssues } },
      );
    } catch (error) {
      // Transport and configuration failures are not repairable by rewording;
      // they surface as-is so the integration health view can show the truth.
      const domainError = isDomainError(error)
        ? error
        : new DomainError('PROVIDER_ERROR', { cause: error });
      return fail(domainError, [domainError.messageDe]);
    }

    lastRaw = result.raw;

    if (result.data === null) {
      lastIssues = result.issues;
      if (result.finishReason === 'refusal') {
        // A refusal will not become valid by being asked again with the same
        // context — fail immediately rather than spending a repair turn.
        return fail(
          new DomainError('AI_OUTPUT_INVALID', {
            messageDe: 'Das Modell hat die Erzeugung abgelehnt.',
            details: { refusal: result.refusal },
          }),
          result.issues,
        );
      }
      logger.warn('ai_output_invalid', {
        job_id: job.id,
        step: job.step,
        prompt_id: job.promptId,
        attempt: attempt + 1,
        issue_count: result.issues.length,
      });
      continue;
    }

    const extraIssues = options.postValidate?.(result.data) ?? [];
    if (extraIssues.length > 0) {
      lastIssues = extraIssues;
      logger.warn('ai_output_rejected', {
        job_id: job.id,
        step: job.step,
        prompt_id: job.promptId,
        attempt: attempt + 1,
        issue_count: extraIssues.length,
      });
      continue;
    }

    const succeeded: AiJob = {
      ...job,
      status: 'SUCCEEDED',
      finishedAt: now(),
      outputHash: hashUnknown(result.data),
      error: null,
    };
    await deps.onJob?.({ ...succeeded });
    return { job: succeeded, output: result.data };
  }

  return fail(issuesToError(lastIssues), lastIssues);
}

/** Runs one pipeline step. Each step is re-runnable in isolation. */
export function runStep<TInput, TOutput>(
  step: PipelineStep,
  input: TInput,
  deps: PipelineDeps,
  options: RunPromptOptions<TOutput> = {},
): Promise<StepRunResult<TOutput>> {
  return runPrompt<TInput, TOutput>(getPromptForStep(step), input, deps, options);
}
