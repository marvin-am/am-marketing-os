/**
 * `@am/jobs` — scheduled and background work.
 *
 * Jobs are pure functions over injected ports: no direct database access, no
 * provider imports, no clock. That is what makes every one of them testable
 * without infrastructure, and it is why the composition happens in the console's
 * cron route handlers rather than here.
 */
export * from './types';
export * from './runner';
export * from './registry';
export { outboxDispatchJob } from './jobs/outbox-dispatch';
export {
  metaInsightsJob,
  metaBackfillJob,
  hubspotReconcileHourlyJob,
  hubspotReconcileDeepJob,
  integrationHealthJob,
} from './jobs/sync-jobs';
export {
  deriveAbandonedFormsJob,
  performanceRollupsJob,
  learningCardsJob,
  recommendationsJob,
} from './jobs/analysis-jobs';
export * from './testing';
