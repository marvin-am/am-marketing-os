import { z } from 'zod';

/**
 * Branded identifier types.
 *
 * Every internal identifier is a UUID. Branding keeps a `CampaignId` from being
 * silently passed where a `CreativeId` is expected — a real class of bug in a
 * system that threads a dozen different ids through attribution snapshots.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Uuid = string;

export type WorkspaceId = Brand<Uuid, 'WorkspaceId'>;
export type ProfileId = Brand<Uuid, 'ProfileId'>;

export type BrandProfileId = Brand<Uuid, 'BrandProfileId'>;
export type AudienceSegmentId = Brand<Uuid, 'AudienceSegmentId'>;
export type ServiceId = Brand<Uuid, 'ServiceId'>;
export type EvidenceItemId = Brand<Uuid, 'EvidenceItemId'>;
export type ClaimId = Brand<Uuid, 'ClaimId'>;
export type CaseStudyId = Brand<Uuid, 'CaseStudyId'>;
export type TestimonialId = Brand<Uuid, 'TestimonialId'>;
export type FaqId = Brand<Uuid, 'FaqId'>;
export type GuardrailId = Brand<Uuid, 'GuardrailId'>;
export type KnowledgeDocumentId = Brand<Uuid, 'KnowledgeDocumentId'>;

export type CampaignId = Brand<Uuid, 'CampaignId'>;
export type CampaignVersionId = Brand<Uuid, 'CampaignVersionId'>;
export type CampaignProposalId = Brand<Uuid, 'CampaignProposalId'>;
export type AngleId = Brand<Uuid, 'AngleId'>;
export type AngleVersionId = Brand<Uuid, 'AngleVersionId'>;
export type OfferId = Brand<Uuid, 'OfferId'>;
export type OfferVersionId = Brand<Uuid, 'OfferVersionId'>;
export type ApprovalId = Brand<Uuid, 'ApprovalId'>;

export type CreativeConceptId = Brand<Uuid, 'CreativeConceptId'>;
export type CreativeAssetId = Brand<Uuid, 'CreativeAssetId'>;
export type CreativeVersionId = Brand<Uuid, 'CreativeVersionId'>;
export type CreativeRenditionId = Brand<Uuid, 'CreativeRenditionId'>;

export type FunnelId = Brand<Uuid, 'FunnelId'>;
export type FunnelVersionId = Brand<Uuid, 'FunnelVersionId'>;
export type FormDefinitionId = Brand<Uuid, 'FormDefinitionId'>;
export type FormVersionId = Brand<Uuid, 'FormVersionId'>;
export type PublishedFunnelId = Brand<Uuid, 'PublishedFunnelId'>;

export type ExperimentId = Brand<Uuid, 'ExperimentId'>;
export type ExperimentArmId = Brand<Uuid, 'ExperimentArmId'>;

export type VisitorId = Brand<Uuid, 'VisitorId'>;
export type SessionId = Brand<Uuid, 'SessionId'>;
export type TouchpointId = Brand<Uuid, 'TouchpointId'>;
export type EventId = Brand<Uuid, 'EventId'>;
export type FormInstanceId = Brand<Uuid, 'FormInstanceId'>;
export type SubmissionId = Brand<Uuid, 'SubmissionId'>;
export type SubmissionAttemptId = Brand<Uuid, 'SubmissionAttemptId'>;
export type LeadId = Brand<Uuid, 'LeadId'>;
export type PersonId = Brand<Uuid, 'PersonId'>;
export type OpportunityId = Brand<Uuid, 'OpportunityId'>;
export type AttributionSnapshotId = Brand<Uuid, 'AttributionSnapshotId'>;

export type MetaAccountId = Brand<Uuid, 'MetaAccountId'>;
export type HubspotMappingId = Brand<Uuid, 'HubspotMappingId'>;
export type IntegrationConnectionId = Brand<Uuid, 'IntegrationConnectionId'>;

export type AiJobId = Brand<Uuid, 'AiJobId'>;
export type PromptVersionId = Brand<Uuid, 'PromptVersionId'>;
export type RecommendationId = Brand<Uuid, 'RecommendationId'>;
export type LearningCardId = Brand<Uuid, 'LearningCardId'>;
export type OutboxEventId = Brand<Uuid, 'OutboxEventId'>;
export type AuditLogId = Brand<Uuid, 'AuditLogId'>;
export type SyncJobId = Brand<Uuid, 'SyncJobId'>;

/**
 * Stable, human-authored identifiers inside a spec document (field keys, step
 * keys, option keys). These are *not* UUIDs — they are slugs that stay readable
 * in the builder UI and stable across versions so that historical answers keep
 * their meaning.
 */
export type SpecKey = Brand<string, 'SpecKey'>;

export const uuidSchema = z.uuid();

/** Slug used for field / step / option keys. Lowercase, stable, url-safe. */
export const specKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Muss mit einem Kleinbuchstaben beginnen und darf nur a-z, 0-9 und _ enthalten');

/** Typed uuid schema factory — validates shape and brands the result. */
export function brandedUuid<B extends string>(): z.ZodType<Brand<Uuid, B>> {
  return uuidSchema as unknown as z.ZodType<Brand<Uuid, B>>;
}

export function brandedKey<B extends string>(): z.ZodType<Brand<string, B>> {
  return specKeySchema as unknown as z.ZodType<Brand<string, B>>;
}

/** Cast helper for boundaries where a raw string is known to be a valid id. */
export function asId<T extends string>(value: string): T {
  return value as T;
}

/** Generates a v4 UUID using the platform crypto implementation. */
export function newId<T extends string = Uuid>(): T {
  return globalThis.crypto.randomUUID() as T;
}
