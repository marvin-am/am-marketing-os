import { z } from 'zod';
import {
  attributionConfidenceSchema,
  attributionLevelSchema,
  channelSchema,
  consentStatusSchema,
  touchRoleSchema,
} from './enums';
import { uuidSchema } from './ids';
import { marketingParamsSchema, trackingContextSchema } from './events';
import { isoTimestampSchema } from './primitives';

export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 30;

/**
 * A single observed touch. Touches are appended, never mutated — a later visit
 * can add an INFLUENCED touch but can never rewrite an existing ACQUISITION
 * touch (spec §19).
 */
export const touchpointSchema = z.object({
  id: uuidSchema,
  visitor_id: uuidSchema,
  session_id: uuidSchema,
  occurred_at: isoTimestampSchema,
  channel: channelSchema,
  role: touchRoleSchema,
  confidence: attributionConfidenceSchema,
  /** True when the internal ids came from a server-signed launch token. */
  from_signed_token: z.boolean().default(false),
  ...trackingContextSchema.shape,
  ...marketingParamsSchema.shape,
  referrer: z.string().max(2000).nullable().default(null),
  landing_url: z.string().max(2000).nullable().default(null),
});
export type Touchpoint = z.infer<typeof touchpointSchema>;

/**
 * Immutable snapshot written at final submit. Everything downstream — CRM sync,
 * CAPI dispatch, revenue reporting — reads this, never a live re-derivation, so
 * that a campaign's numbers cannot silently change months later.
 */
export const attributionSnapshotSchema = z.object({
  id: uuidSchema,
  submission_id: uuidSchema,
  created_at: isoTimestampSchema,

  /** Internal, trusted identifiers of the version actually delivered. */
  ...trackingContextSchema.shape,

  first_touch: touchpointSchema.nullable().default(null),
  last_touch: touchpointSchema.nullable().default(null),
  acquisition_touch: touchpointSchema.nullable().default(null),
  influenced_touch_ids: z.array(uuidSchema).default([]),

  /**
   * Meta identifiers and marketing parameters as observed on the acquisition
   * touch. Stored for reporting; they never override the trusted internal ids
   * above.
   */
  ...marketingParamsSchema.shape,
  referrer: z.string().max(2000).nullable().default(null),
  landing_url: z.string().max(2000).nullable().default(null),

  channel: channelSchema,
  level: attributionLevelSchema,
  confidence: attributionConfidenceSchema,
  consent_status: consentStatusSchema,

  /** Days between the acquisition touch and the submission. */
  days_to_conversion: z.number().nullable().default(null),
  /** Window that was in force when this snapshot was taken. */
  window_days: z.number().int().min(1).default(DEFAULT_ATTRIBUTION_WINDOW_DAYS),
});
export type AttributionSnapshot = z.infer<typeof attributionSnapshotSchema>;

/**
 * Confidence ladder (spec §11/§19).
 *
 * Only an internal id or a click id counts as EXACT. Temporal proximity alone
 * is explicitly *not* exact — that rule exists because "the lead came in while
 * campaign X was running" is the single most common source of fabricated
 * attribution in ad reporting.
 */
export interface AttributionSignals {
  /** Internal ids recovered from a server-signed launch token. */
  hasSignedToken: boolean;
  /** Meta click id present on the landing URL. */
  hasClickId: boolean;
  /** Unique campaign parameter that maps 1:1 onto one internal campaign. */
  hasUniqueCampaignParam: boolean;
  /** Generic UTMs that identify a channel but not a specific campaign version. */
  hasGenericUtm: boolean;
  /** Referrer indicates a Meta property. */
  hasMetaReferrer: boolean;
  /** Only temporal overlap with a running campaign. Never sufficient alone. */
  hasTemporalProximityOnly: boolean;
}

export function resolveConfidence(
  signals: AttributionSignals,
): z.infer<typeof attributionConfidenceSchema> {
  if (signals.hasSignedToken || signals.hasClickId || signals.hasUniqueCampaignParam) {
    return 'EXACT';
  }
  if (signals.hasGenericUtm && signals.hasMetaReferrer) return 'HIGH_CONFIDENCE';
  if (signals.hasGenericUtm) return 'MEDIUM_CONFIDENCE';
  if (signals.hasMetaReferrer) return 'LOW_CONFIDENCE';
  if (signals.hasTemporalProximityOnly) return 'LOW_CONFIDENCE';
  return 'UNKNOWN';
}

/** Confidences that may back a revenue claim in a report without a warning. */
export const TRUSTWORTHY_CONFIDENCES: readonly z.infer<typeof attributionConfidenceSchema>[] = [
  'EXACT',
  'HIGH_CONFIDENCE',
];

export function isTrustworthy(confidence: z.infer<typeof attributionConfidenceSchema>): boolean {
  return TRUSTWORTHY_CONFIDENCES.includes(confidence);
}

/**
 * Share of records whose attribution is trustworthy. Rendered next to every
 * campaign-level metric so a 4× ROAS built on LOW_CONFIDENCE matches cannot be
 * mistaken for a measured fact.
 */
export function attributionCoverage(
  confidences: readonly z.infer<typeof attributionConfidenceSchema>[],
): number | null {
  if (confidences.length === 0) return null;
  const trusted = confidences.filter(isTrustworthy).length;
  return trusted / confidences.length;
}

export const ATTRIBUTION_CONFIDENCE_LABELS_DE: Readonly<
  Record<z.infer<typeof attributionConfidenceSchema>, string>
> = {
  EXACT: 'Exakt',
  HIGH_CONFIDENCE: 'Hohe Konfidenz',
  MEDIUM_CONFIDENCE: 'Mittlere Konfidenz',
  LOW_CONFIDENCE: 'Geringe Konfidenz',
  UNKNOWN: 'Unbekannt',
};

export const ATTRIBUTION_LEVEL_LABELS_DE: Readonly<
  Record<z.infer<typeof attributionLevelSchema>, string>
> = {
  CREATIVE_ONLY: 'Nur Creative',
  TRAFFIC_LINKED: 'Traffic zugeordnet',
  LEAD_LINKED: 'Leads zugeordnet',
  REVENUE_LINKED: 'Umsatz zugeordnet',
};
