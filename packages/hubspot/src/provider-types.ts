import type { ConnectionState, DryRunResult, IsoTimestamp } from '@am/domain';
import type { PropertyBag } from './types';

/**
 * Payload and result shapes of the HubSpot adapter.
 *
 * They live in their own leaf module so both implementations can depend on them
 * without importing `provider.ts`, which re-exports the implementations. The
 * classes satisfy `HubspotProvider` structurally; `factory.ts` is where that is
 * checked by the compiler.
 */

export interface ProviderConnectionProbe {
  reachable: boolean;
  state: ConnectionState;
  /** Scopes the provider actually reported. Never invented. */
  grantedScopes: string[];
  accountLabel: string | null;
  portalId: string | null;
  detailDe: string | null;
  checkedAt: IsoTimestamp;
}

export interface ObjectTypeDefinition {
  objectType: string;
  singularLabel: string;
  pluralLabel: string;
  custom: boolean;
}

export interface PropertyDefinition {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string | null;
  options: { label: string; value: string }[];
  hasUniqueValue: boolean;
  calculated: boolean;
  archived: boolean;
}

export interface PipelineStageDefinition {
  id: string;
  label: string;
  displayOrder: number;
  isClosed: boolean;
  probability: number | null;
}

export interface PipelineDefinition {
  id: string;
  label: string;
  objectType: string;
  displayOrder: number;
  stages: PipelineStageDefinition[];
}

export interface HubspotObjectRecord {
  id: string;
  objectType: string;
  properties: PropertyBag;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  archived: boolean;
}

export interface BatchReadInput {
  objectType: string;
  ids: readonly string[];
  properties: readonly string[];
  /** Resolve `ids` against a unique property instead of the record id. */
  idProperty?: string | null;
}

export interface SearchContactInput {
  objectType: string;
  /** Property the portal identifies a contact by — from the mapping, not fixed. */
  identifierProperty: string;
  identifierValue: string;
  properties: readonly string[];
}

export interface UpsertObjectInput {
  objectType: string;
  /** Existing record id when known; otherwise resolution goes via idProperty. */
  objectId?: string | null;
  idProperty?: string | null;
  idValue?: string | null;
  properties: Record<string, string | number | boolean>;
  /** Idempotency key echoed into the dry-run preview and the call log. */
  idempotencyKey: string;
}

export interface UpdateObjectInput {
  objectType: string;
  objectId: string;
  properties: Record<string, string | number | boolean>;
  idempotencyKey: string;
}

export interface CreateDealInput {
  objectType: string;
  properties: Record<string, string | number | boolean>;
  idempotencyKey: string;
}

export interface CreateAssociationInput {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  associationCategory: 'HUBSPOT_DEFINED' | 'USER_DEFINED';
  /** Null lets HubSpot apply its default label for the pair. */
  associationTypeId: number | null;
  idempotencyKey: string;
}

export interface AssociationRecord {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  associationCategory: 'HUBSPOT_DEFINED' | 'USER_DEFINED';
  associationTypeId: number | null;
}

export interface BatchReadAssociationsInput {
  fromObjectType: string;
  toObjectType: string;
  fromObjectIds: readonly string[];
}

export interface AssociationReadResult {
  fromObjectId: string;
  toObjectIds: string[];
}

export interface ChangeCursor {
  /** Watermark: last modification time we have already consumed. */
  since: IsoTimestamp;
  /** Provider paging token within that watermark, when one is in flight. */
  after: string | null;
  objectType: string;
}

export interface ObjectChange {
  objectType: string;
  objectId: string;
  occurredAt: IsoTimestamp;
  changedProperties: string[];
}

export interface RecentChangePage {
  changes: ObjectChange[];
  nextCursor: ChangeCursor | null;
  hasMore: boolean;
}

/**
 * Every write returns either a performed result or a `DryRunResult` describing
 * exactly what would have been sent. A dry run is never a success.
 */
export type WriteOutcome<T> = { dryRun: false; result: T } | DryRunResult;

export function isDryRunOutcome<T>(outcome: WriteOutcome<T>): outcome is DryRunResult {
  return (outcome as DryRunResult).dryRun === true;
}

export function performed<T>(result: T): WriteOutcome<T> {
  return { dryRun: false, result };
}

/** Narrows to the performed value, or `null` for a dry run. */
export function writtenValue<T>(outcome: WriteOutcome<T>): T | null {
  return isDryRunOutcome(outcome) ? null : outcome.result;
}

/** Scopes a private app needs for the operations in this adapter. */
export const REQUIRED_HUBSPOT_SCOPES: readonly string[] = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.schemas.deals.read',
];
