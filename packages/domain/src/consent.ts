import { z } from 'zod';
import { consentPurposeSchema, consentStatusSchema } from './enums';
import { uuidSchema } from './ids';
import { isoTimestampSchema } from './primitives';

/**
 * Consent text is versioned. What was persisted is the exact legal text version
 * the visitor saw — not a pointer to whatever text is current today (spec §28).
 */
export const consentVersionSchema = z.object({
  id: uuidSchema,
  version: z.number().int().min(1),
  /** Rendered German legal text, stored verbatim. */
  textDe: z.string().min(20).max(5000),
  purposes: z.array(consentPurposeSchema).min(1),
  privacyPolicyUrl: z.string().max(500),
  effectiveFrom: isoTimestampSchema,
  effectiveUntil: isoTimestampSchema.nullable().default(null),
});
export type ConsentVersion = z.infer<typeof consentVersionSchema>;

export const consentRecordSchema = z.object({
  consent_version_id: uuidSchema,
  consent_version: z.number().int().min(1),
  status: consentStatusSchema,
  grantedPurposes: z.array(consentPurposeSchema).default([]),
  /** Business time the visitor ticked the box. */
  occurred_at: isoTimestampSchema,
  /** Where consent was collected, e.g. `funnel:<funnel_version_id>`. */
  contextDe: z.string().max(300),
});
export type ConsentRecord = z.infer<typeof consentRecordSchema>;

/** Consent is never pre-ticked; the spec for the form requires an opt-in. */
export const consentSpecSchema = z.object({
  fieldId: z.string().min(1).max(64),
  required: z.literal(true),
  /** Always false — a pre-checked consent box is not consent. */
  defaultChecked: z.literal(false),
  consentVersionId: uuidSchema,
  textDe: z.string().min(20).max(5000),
  purposes: z.array(consentPurposeSchema).min(1),
  privacyPolicyUrl: z.string().max(500),
});
export type ConsentSpec = z.infer<typeof consentSpecSchema>;

export function mayUseForAdMeasurement(consent: ConsentRecord | null): boolean {
  if (!consent) return false;
  return consent.status === 'GRANTED' && consent.grantedPurposes.includes('AD_MEASUREMENT');
}

export function mayUseForAnalytics(consent: ConsentRecord | null): boolean {
  if (!consent) return false;
  return consent.status === 'GRANTED' && consent.grantedPurposes.includes('ANALYTICS');
}

/**
 * Retention configuration. The concrete legal period is deliberately not
 * invented here — it is set in Settings by the responsible party (spec §28).
 */
export const retentionPolicySchema = z.object({
  /** Null means "no automatic deletion configured yet". */
  submissionPiiDays: z.number().int().min(1).nullable().default(null),
  rawProviderPayloadDays: z.number().int().min(1).nullable().default(null),
  analyticsEventDays: z.number().int().min(1).nullable().default(null),
  auditLogDays: z.number().int().min(1).nullable().default(null),
  configuredBy: uuidSchema.nullable().default(null),
  configuredAt: isoTimestampSchema.nullable().default(null),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const UNCONFIGURED_RETENTION_POLICY: RetentionPolicy = {
  submissionPiiDays: null,
  rawProviderPayloadDays: null,
  analyticsEventDays: null,
  auditLogDays: null,
  configuredBy: null,
  configuredAt: null,
};
