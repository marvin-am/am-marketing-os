import type { DomainErrorCode } from '@am/domain';
import type { EmbeddingProvider, ImageProvider, TextProvider } from '../provider/types';
import type { PipelineStep } from '../prompts/types';

/**
 * Job model for the AI pipeline.
 *
 * Every step is an independently persistable, re-runnable unit of work. The row
 * records enough to answer "what produced this text?" without keeping the text:
 * model, prompt id, prompt version, prompt content hash and the input/output
 * hashes. A step that fails validation is a FAILED job — never a partially
 * applied proposal.
 */

export const AI_JOB_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

export interface AiJobError {
  code: DomainErrorCode;
  messageDe: string;
  /** Validation issues fed back to the model on the repair turn. */
  issues: string[];
}

export interface AiJob {
  id: string;
  /** `null` for standalone prompts such as the explanation helper. */
  step: PipelineStep | null;
  status: AiJobStatus;
  model: string;
  promptId: string;
  promptVersion: string;
  /** Content hash of the prompt — catches edits without a version bump. */
  promptHash: string;
  inputHash: string;
  outputHash: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 0 or 1 — the repair turn is bounded on purpose. */
  repairAttempts: number;
  error: AiJobError | null;
}

export interface StepRunResult<TOutput> {
  job: AiJob;
  output: TOutput;
}

export type ProgressStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

export interface PipelineProgress {
  step: PipelineStep;
  /** 1-based position in the twelve-step sequence. */
  index: number;
  total: number;
  status: ProgressStatus;
  labelDe: string;
  jobId: string | null;
  messageDe: string | null;
}

export interface PipelineDeps {
  text: TextProvider;
  /** Required for angle distinctness and the embedding half of diversity. */
  embeddings?: EmbeddingProvider;
  /** Reserved for asset generation; the pipeline itself never calls it. */
  images?: ImageProvider;
  now?: () => string;
  newId?: () => string;
  /** Persistence hook — called on every job transition, including failures. */
  onJob?: (job: AiJob) => void | Promise<void>;
  onProgress?: (event: PipelineProgress) => void | Promise<void>;
}
