/**
 * The repository bundle.
 *
 * `createSupabaseDatabase(client)` and `createMemoryDatabase()` both return an
 * `AmDatabase`, so DEMO_MODE, the unit tests and production run the same call
 * sites against different storage.
 */
import type { DbClient } from '../client';

export * from './base';
export * from './campaigns';
export * from './proposals';
export * from './creatives';
export * from './funnels';
export * from './experiments';
export * from './tracking';
export * from './submissions';
export * from './attribution';
export * from './outbox';
export * from './meta';
export * from './hubspot';
export * from './recommendations';
export * from './learning-cards';
export * from './audit';
export * from './integrations';
export * from './settings';
export * from './rollups';
export * from './jobs';

import { createAttributionRepository, type AttributionRepository } from './attribution';
import { createAuditRepository, type AuditRepository } from './audit';
import { createCampaignRepository, type CampaignRepository } from './campaigns';
import { createCreativeRepository, type CreativeRepository } from './creatives';
import { createExperimentRepository, type ExperimentRepository } from './experiments';
import { createFunnelRepository, type FunnelRepository } from './funnels';
import { createHubspotRepository, type HubspotRepository } from './hubspot';
import { createIntegrationRepository, type IntegrationRepository } from './integrations';
import { createJobsRepository, type JobsRepository } from './jobs';
import { createLearningCardRepository, type LearningCardRepository } from './learning-cards';
import { createMetaRepository, type MetaRepository } from './meta';
import { createOutboxRepository, type OutboxRepository } from './outbox';
import { createProposalRepository, type ProposalRepository } from './proposals';
import { createRecommendationRepository, type RecommendationRepository } from './recommendations';
import { createRollupRepository, type RollupRepository } from './rollups';
import { createSettingsRepository, type SettingsRepository } from './settings';
import { createSubmissionRepository, type SubmissionRepository } from './submissions';
import { createTrackingRepository, type TrackingRepository } from './tracking';

export interface AmDatabase {
  campaigns: CampaignRepository;
  proposals: ProposalRepository;
  creatives: CreativeRepository;
  funnels: FunnelRepository;
  experiments: ExperimentRepository;
  tracking: TrackingRepository;
  submissions: SubmissionRepository;
  attribution: AttributionRepository;
  outbox: OutboxRepository;
  meta: MetaRepository;
  hubspot: HubspotRepository;
  recommendations: RecommendationRepository;
  /** Daily pre-aggregates the dashboards read instead of a provider API. */
  rollups: RollupRepository;
  learningCards: LearningCardRepository;
  audit: AuditRepository;
  integrations: IntegrationRepository;
  settings: SettingsRepository;
  /** Cooperative locks so two cron invocations cannot double-dispatch. */
  jobs: JobsRepository;
}

export function createSupabaseDatabase(client: DbClient): AmDatabase {
  return {
    campaigns: createCampaignRepository(client),
    proposals: createProposalRepository(client),
    creatives: createCreativeRepository(client),
    funnels: createFunnelRepository(client),
    experiments: createExperimentRepository(client),
    tracking: createTrackingRepository(client),
    submissions: createSubmissionRepository(client),
    attribution: createAttributionRepository(client),
    outbox: createOutboxRepository(client),
    meta: createMetaRepository(client),
    hubspot: createHubspotRepository(client),
    recommendations: createRecommendationRepository(client),
    rollups: createRollupRepository(client),
    learningCards: createLearningCardRepository(client),
    audit: createAuditRepository(client),
    integrations: createIntegrationRepository(client),
    settings: createSettingsRepository(client),
    jobs: createJobsRepository(client),
  };
}
