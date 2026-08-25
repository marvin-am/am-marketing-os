import { z } from 'zod';
import type { AppEnvironment, FeatureFlags, Provider } from '@am/domain';
import type { Logger } from '@am/observability';

/**
 * Background job contract.
 *
 * Jobs are plain async functions over an injected context. They do no I/O of
 * their own beyond the ports they are handed, which is what makes every one of
 * them testable without a database, a provider or a clock.
 */

export const JOB_NAMES = [
  'outbox-dispatch',
  'meta-insights',
  'meta-backfill',
  'hubspot-reconcile',
  'hubspot-reconcile-deep',
  'derive-abandoned-forms',
  'performance-rollups',
  'learning-cards',
  'recommendations',
  'integration-health',
] as const;
export const jobNameSchema = z.enum(JOB_NAMES);
export type JobName = z.infer<typeof jobNameSchema>;

export const JOB_LABELS_DE: Readonly<Record<JobName, string>> = {
  'outbox-dispatch': 'Outbox zustellen',
  'meta-insights': 'Meta-Insights synchronisieren',
  'meta-backfill': 'Meta-Backfill für verspätete Attribution',
  'hubspot-reconcile': 'HubSpot-Abgleich',
  'hubspot-reconcile-deep': 'Erweiterter HubSpot-Abgleich',
  'derive-abandoned-forms': 'Abgebrochene Formulare ableiten',
  'performance-rollups': 'Performance-Rollups berechnen',
  'learning-cards': 'Learning Cards erzeugen',
  recommendations: 'Empfehlungen aktualisieren',
  'integration-health': 'Integrations-Health prüfen',
};

/** Outcome of one job run. Always structured — a job never just logs and exits. */
export const jobResultSchema = z.object({
  job: jobNameSchema,
  runId: z.string(),
  ok: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  /** Domain counters, e.g. `{ dispatched: 12, deadLettered: 1 }`. */
  counts: z.record(z.string(), z.number()).default({}),
  /** German one-liner shown in the console's job history. */
  summaryDe: z.string(),
  /** Non-fatal problems worth surfacing without failing the run. */
  warningsDe: z.array(z.string()).default([]),
  errorDe: z.string().nullable().default(null),
  /** True when the run was skipped because another holder had the lock. */
  skippedLocked: z.boolean().default(false),
});
export type JobResult = z.infer<typeof jobResultSchema>;

export interface JobContext {
  readonly job: JobName;
  readonly runId: string;
  readonly now: Date;
  readonly workspaceId: string;
  readonly environment: AppEnvironment;
  readonly flags: FeatureFlags;
  readonly logger: Logger;
  /**
   * Cooperative cancellation. Serverless invocations have a wall-clock budget,
   * so long-running jobs check this between batches and finish cleanly with a
   * partial result rather than being killed mid-write.
   */
  readonly signal: AbortSignal;
  readonly ports: JobPorts;
  readonly providers: JobProviders;
}

/** What a job body returns; the runner supplies identity and timing. */
export type JobRunOutcome = Omit<
  JobResult,
  'job' | 'runId' | 'startedAt' | 'finishedAt' | 'durationMs' | 'skippedLocked'
>;

export interface JobDefinition {
  name: JobName;
  /** Cron expression as configured in `apps/console/vercel.json`. */
  schedule: string;
  descriptionDe: string;
  /** Providers that must be reachable; a missing one degrades, never crashes. */
  requires: Provider[];
  run(ctx: JobContext): Promise<JobRunOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

export interface JobPorts {
  outbox: OutboxPort;
  sync: SyncCursorPort;
  forms: FormInstancePort;
  rollups: RollupPort;
  learnings: LearningPort;
  recommendations: RecommendationPort;
  health: HealthPort;
  lock: LockPort;
  audit: JobAuditPort;
}

/**
 * A cooperative lock. Cron on a serverless platform can overlap invocations, and
 * two outbox pumps racing the same rows would double-dispatch — the unique
 * constraints would catch it, but only after the provider had already seen both.
 */
export interface LockPort {
  acquire(key: string, ttlMs: number, holder: string): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
}

export interface OutboxClaim {
  eventId: string;
  destination: string;
  eventName: string;
  eventTime: string;
  datasetId: string | null;
  payload: unknown;
  attemptCount: number;
  campaignId: string | null;
  submissionId: string | null;
  opportunityId: string | null;
}

export interface OutboxPort {
  /** Claims up to `limit` due events with `FOR UPDATE SKIP LOCKED` semantics. */
  claimDue(limit: number, now: Date, holder: string): Promise<OutboxClaim[]>;
  markAccepted(eventId: string, destination: string, responseRedacted: unknown): Promise<void>;
  markFailed(
    eventId: string,
    destination: string,
    error: string,
    nextAttemptAt: Date | null,
    deadLetter: boolean,
  ): Promise<void>;
  countByStatus(): Promise<Record<string, number>>;
}

export interface SyncCursorPort {
  get(provider: string, resource: string): Promise<{ cursor: string | null; watermark: string | null }>;
  set(provider: string, resource: string, value: { cursor?: string | null; watermark?: string | null }): Promise<void>;
}

export interface AbandonableFormInstance {
  formInstanceId: string;
  visitorId: string;
  sessionId: string;
  funnelVersionId: string | null;
  formVersionId: string | null;
  lastActivityAt: string;
  lastStepId: string | null;
  submitted: boolean;
  abandonedRecorded: boolean;
}

export interface FormInstancePort {
  listStaleOpen(inactiveSince: Date, limit: number): Promise<AbandonableFormInstance[]>;
  markAbandoned(formInstanceId: string, occurredAt: string): Promise<void>;
}

export interface RollupPort {
  /** Raw counters for a day, already filtered to production traffic. */
  loadDailyCounters(day: string): Promise<unknown[]>;
  writeRollups(day: string, rows: unknown[]): Promise<number>;
  listDaysNeedingRollup(since: Date, until: Date): Promise<string[]>;
}

export interface LearningPort {
  listExperimentsNeedingCards(now: Date): Promise<Array<{ experimentId: string; campaignId: string }>>;
  writeLearningCard(card: unknown): Promise<void>;
}

export interface RecommendationPort {
  listActiveCampaigns(): Promise<Array<{ campaignId: string }>>;
  loadContext(campaignId: string): Promise<unknown | null>;
  replaceOpenRecommendations(campaignId: string, recommendations: unknown[]): Promise<number>;
}

export interface HealthPort {
  record(provider: Provider, health: unknown): Promise<void>;
}

export interface JobAuditPort {
  recordRun(result: JobResult): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Provider handles are supplied as optional narrow shapes rather than the full
 * adapter interfaces, so `@am/jobs` does not have to import every provider type
 * and stay in lockstep with it. A missing provider makes its job degrade to a
 * skip with a German explanation — never a crash.
 */
export interface JobProviders {
  meta: MetaJobProvider | null;
  hubspot: HubspotJobProvider | null;
}

export interface MetaJobProvider {
  fetchInsightsDaily(input: { since: string; until: string }): Promise<{ rows: unknown[] }>;
  sendCapiEvents(batch: unknown): Promise<{ dryRun: true } | { accepted: number; response: unknown }>;
  health(): Promise<unknown>;
}

export interface HubspotJobProvider {
  reconcile(input: { deep: boolean; since: string | null }): Promise<{
    checked: number;
    transitions: number;
    discrepancies: number;
  }>;
  syncPending(batch: unknown): Promise<{ dryRun: true } | { synced: number; response: unknown }>;
  health(): Promise<unknown>;
}
