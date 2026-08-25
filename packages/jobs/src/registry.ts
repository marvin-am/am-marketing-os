import { outboxDispatchJob } from './jobs/outbox-dispatch';
import {
  hubspotReconcileDeepJob,
  hubspotReconcileHourlyJob,
  integrationHealthJob,
  metaBackfillJob,
  metaInsightsJob,
} from './jobs/sync-jobs';
import {
  deriveAbandonedFormsJob,
  learningCardsJob,
  performanceRollupsJob,
  recommendationsJob,
} from './jobs/analysis-jobs';
import { JOB_NAMES, type JobDefinition, type JobName } from './types';

/**
 * The single registry of scheduled work. The cron route handlers resolve a job
 * by name from here, so `vercel.json` and the code cannot drift into naming
 * different things — a test asserts every registered job has a schedule and
 * every declared name is registered.
 */
export const JOB_REGISTRY: Readonly<Record<JobName, JobDefinition>> = {
  'outbox-dispatch': outboxDispatchJob,
  'meta-insights': metaInsightsJob,
  'meta-backfill': metaBackfillJob,
  'hubspot-reconcile': hubspotReconcileHourlyJob,
  'hubspot-reconcile-deep': hubspotReconcileDeepJob,
  'derive-abandoned-forms': deriveAbandonedFormsJob,
  'performance-rollups': performanceRollupsJob,
  'learning-cards': learningCardsJob,
  recommendations: recommendationsJob,
  'integration-health': integrationHealthJob,
};

export function getJob(name: JobName): JobDefinition {
  return JOB_REGISTRY[name];
}

export function listJobs(): JobDefinition[] {
  return JOB_NAMES.map((name) => JOB_REGISTRY[name]);
}

/** Cron path → job name, matching `apps/console/vercel.json`. */
export function jobForCronPath(path: string): JobDefinition | null {
  const match = /^\/api\/cron\/([a-z-]+)$/.exec(path);
  if (!match?.[1]) return null;
  const name = match[1] as JobName;
  return JOB_NAMES.includes(name) ? JOB_REGISTRY[name] : null;
}
