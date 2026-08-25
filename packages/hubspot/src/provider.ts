import type {
  AssociationReadResult,
  AssociationRecord,
  BatchReadAssociationsInput,
  BatchReadInput,
  ChangeCursor,
  CreateAssociationInput,
  CreateDealInput,
  HubspotObjectRecord,
  ObjectTypeDefinition,
  PipelineDefinition,
  PropertyDefinition,
  ProviderConnectionProbe,
  RecentChangePage,
  SearchContactInput,
  UpdateObjectInput,
  UpsertObjectInput,
  WriteOutcome,
} from './provider-types';

export * from './provider-types';
export { LiveHubspotProvider, type LiveProviderOptions } from './provider-live';
export {
  FixtureHubspotProvider,
  type FixtureProviderOptions,
  type FixtureFailureInjection,
} from './provider-fixture';

/**
 * The HubSpot adapter contract.
 *
 * Two implementations exist — `LiveHubspotProvider` and
 * `FixtureHubspotProvider` — and selection happens exactly once, in
 * `factory.ts`, never inline in feature code (AGENTS.md, "Fixtures and demo
 * mode").
 *
 * Batch reads and associations are separate, explicit operations. HubSpot's
 * association API is its own call and an association is never inferred from a
 * property value: silently linking the wrong records is the single most damaging
 * failure mode of a CRM adapter.
 */
export interface HubspotProvider {
  /** Connection probe. Never fabricates a "connected" answer. */
  health(): Promise<ProviderConnectionProbe>;

  listObjectTypes(): Promise<ObjectTypeDefinition[]>;
  listProperties(objectType: string): Promise<PropertyDefinition[]>;
  listPipelines(objectType?: string): Promise<PipelineDefinition[]>;

  /** Explicit batch read. Returns only the properties that were requested. */
  batchReadObjects(input: BatchReadInput): Promise<HubspotObjectRecord[]>;
  searchContactByEmail(input: SearchContactInput): Promise<HubspotObjectRecord | null>;

  upsertContact(input: UpsertObjectInput): Promise<WriteOutcome<HubspotObjectRecord>>;
  upsertCompany(input: UpsertObjectInput): Promise<WriteOutcome<HubspotObjectRecord>>;
  createDeal(input: CreateDealInput): Promise<WriteOutcome<HubspotObjectRecord>>;
  updateDeal(input: UpdateObjectInput): Promise<WriteOutcome<HubspotObjectRecord>>;

  /** Explicit association write — its own API call, never a side effect. */
  createAssociation(input: CreateAssociationInput): Promise<WriteOutcome<AssociationRecord>>;
  /** Explicit association read — likewise its own call. */
  batchReadAssociations(input: BatchReadAssociationsInput): Promise<AssociationReadResult[]>;

  /** Incremental change feed driving reconciliation. */
  listRecentChanges(cursor: ChangeCursor | null): Promise<RecentChangePage>;
}
