import type {
  AttributionConfidence,
  Channel,
  Currency,
  IsoTimestamp,
  MarketingParams,
  SalesEventType,
  SyncStatus,
  TrackingContext,
  Uuid,
  VqEvaluation,
} from '@am/domain';

/**
 * Data shapes shared across the adapter, the mapping layer and the sync engine.
 *
 * This package deliberately owns *no* persistence. Everything it needs from the
 * database arrives through these plain structures or through the `SyncStore`
 * port, so `@am/hubspot` never imports `@am/db`.
 */

/** A raw property bag as it arrives from, or goes to, HubSpot. */
export type PropertyBag = Record<string, string | null>;

/** What we are willing to send: HubSpot coerces everything to strings anyway. */
export type WritablePropertyBag = Record<string, string | number | boolean>;

/**
 * One observation of a CRM object. `toCanonicalEvents` diffs two of these; a
 * repeated sync that produces an identical snapshot emits nothing.
 */
export interface ObjectSnapshot {
  objectType: string;
  objectId: string;
  properties: PropertyBag;
  /** When we observed it — the fallback business time if the CRM has none. */
  observedAt: IsoTimestamp;
}

/** The acquisition context bound to a lead, mirroring `AttributionSnapshot`. */
export interface AcquisitionSnapshotInput extends Partial<TrackingContext>, Partial<MarketingParams> {
  snapshotId: Uuid;
  submissionId: Uuid;
  channel?: Channel;
  confidence?: AttributionConfidence;
  landing_url?: string | null;
  referrer?: string | null;
}

/** A validated, accepted form submission ready for the CRM. */
export interface LeadSubmission {
  submissionId: Uuid;
  personId: Uuid;
  /** Raw as typed; the sync normalises it before any identity decision. */
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  companyName?: string | null;
  /** Answers keyed by the form's stable spec keys. */
  answers: Record<string, string | number | boolean | readonly string[] | null>;
  submittedAt: IsoTimestamp;
  /** Marks the wizard's end-to-end probe so it never pollutes reporting. */
  isTestLead?: boolean;
}

/**
 * A canonical event as produced by the mapping layer, before ids and persistence
 * are attached. `ruleId` names the mapping rule that fired, which is what makes
 * a historical event explainable after the mapping changes.
 */
export interface CanonicalEventDraft {
  type: SalesEventType;
  occurredAt: IsoTimestamp;
  sourceObject: 'CONTACT' | 'DEAL' | 'INTERNAL' | 'WEBHOOK';
  hubspotObjectId: string | null;
  previousState: string | null;
  newState: string;
  mappingVersion: number;
  amountMinor: number | null;
  currency: Currency | null;
  ruleId: string;
  /** Stable key; the store must treat a repeat as a no-op. */
  dedupeKey: string;
  sourceEventId: string | null;
}

/** Retry bookkeeping surfaced alongside every sync status. */
export interface RetryMetadata {
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: IsoTimestamp | null;
  lastErrorCode: string | null;
  lastErrorDe: string | null;
}

/** Our mirror of a lead, owned by Supabase and passed in by the caller. */
export interface LeadRecord {
  id: Uuid;
  amPersonId: Uuid;
  submissionId: Uuid;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  hubspotContactId: string | null;
  hubspotCompanyId: string | null;
  syncStatus: SyncStatus;
  retry: RetryMetadata;
  vq: VqEvaluation | null;
  /** Normalised e-mail; the identity key for every CRM lookup. */
  normalizedEmail: string;
  isTestLead: boolean;
}

/** Our mirror of an opportunity. The acquisition binding is immutable. */
export interface OpportunityRecord {
  id: Uuid;
  amOpportunityId: Uuid;
  amPersonId: Uuid;
  acquisitionSubmissionId: Uuid;
  acquisitionSnapshotId: Uuid;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  hubspotDealId: string | null;
  pipeline: string | null;
  stage: string | null;
  amountMinor: number | null;
  currency: Currency | null;
  closedWonAt: IsoTimestamp | null;
  closedLostAt: IsoTimestamp | null;
  syncStatus: SyncStatus;
  retry: RetryMetadata;
  /** Frozen copy of the acquisition properties written at creation time. */
  acquisitionProperties: Record<string, string>;
}

export const RECONCILIATION_DISCREPANCY_KINDS = [
  'REVENUE_CHANGED_AFTER_CONVERSION',
  'STAGE_DRIFT',
  'CURRENCY_CHANGED',
  'OBJECT_MISSING_IN_CRM',
  'MIRROR_MISSING',
  'ASSOCIATION_MISSING',
] as const;
export type ReconciliationDiscrepancyKind = (typeof RECONCILIATION_DISCREPANCY_KINDS)[number];

/**
 * A drift finding. A discrepancy is explicitly *not* a second sales event: once
 * CONVERTED has been dispatched, a later value change is recorded here and
 * adjusted through a revenue delta (spec §22/§23).
 */
export interface ReconciliationDiscrepancy {
  id: Uuid;
  kind: ReconciliationDiscrepancyKind;
  detectedAt: IsoTimestamp;
  objectType: string;
  hubspotObjectId: string | null;
  opportunityId: Uuid | null;
  leadId: Uuid | null;
  mirroredValue: string | null;
  crmValue: string | null;
  deltaMinor: number | null;
  currency: Currency | null;
  /** What we did about it, in German. Never "nothing" without a reason. */
  resolutionDe: string;
  messageDe: string;
}

export function emptyRetry(maxAttempts: number): RetryMetadata {
  return {
    attempt: 0,
    maxAttempts,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorDe: null,
  };
}
