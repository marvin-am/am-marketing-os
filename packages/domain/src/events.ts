import { z } from 'zod';
import { appEnvironmentSchema, consentStatusSchema, trafficKindSchema } from './enums';
import { specKeySchema, uuidSchema } from './ids';
import { isoTimestampSchema } from './primitives';

/* -------------------------------------------------------------------------- */
/* Event catalogue                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The complete first-party event contract (spec §18).
 *
 * `form_abandoned` is intentionally absent from the client-emittable set: it is
 * derived server-side after an inactivity window, never sent from `beforeunload`
 * which is unreliable on mobile Safari.
 */
export const CLIENT_EVENT_TYPES = [
  'funnel_viewed',
  'experiment_exposed',
  'form_viewed',
  'form_started',
  'form_step_viewed',
  'form_step_completed',
  'form_validation_failed',
  'lead_submit_attempted',
  'lead_submitted',
  'lead_submit_failed',
  'thank_you_viewed',
  'booking_started',
] as const;

export const SERVER_EVENT_TYPES = ['form_abandoned', 'vq_scheduled'] as const;

export const EVENT_TYPES = [...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES] as const;

export const clientEventTypeSchema = z.enum(CLIENT_EVENT_TYPES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;
export type ClientEventType = z.infer<typeof clientEventTypeSchema>;

export const EVENT_SCHEMA_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/* Standardised validation error codes                                         */
/* -------------------------------------------------------------------------- */

/**
 * `form_validation_failed` carries only a `field_id` and one of these codes —
 * never the value the visitor typed (spec §18).
 */
export const VALIDATION_ERROR_CODES = [
  'REQUIRED',
  'INVALID_FORMAT',
  'TOO_SHORT',
  'TOO_LONG',
  'OUT_OF_RANGE',
  'INVALID_POSTCODE',
  'INVALID_EMAIL',
  'INVALID_PHONE',
  'CONSENT_REQUIRED',
  'UNKNOWN_OPTION',
  'SERVER_REJECTED',
] as const;
export const validationErrorCodeSchema = z.enum(VALIDATION_ERROR_CODES);
export type ValidationErrorCode = z.infer<typeof validationErrorCodeSchema>;

export const VALIDATION_MESSAGES_DE: Readonly<Record<ValidationErrorCode, string>> = {
  REQUIRED: 'Bitte füllen Sie dieses Feld aus.',
  INVALID_FORMAT: 'Bitte prüfen Sie das Format Ihrer Eingabe.',
  TOO_SHORT: 'Ihre Eingabe ist zu kurz.',
  TOO_LONG: 'Ihre Eingabe ist zu lang.',
  OUT_OF_RANGE: 'Bitte geben Sie einen Wert im zulässigen Bereich an.',
  INVALID_POSTCODE: 'Bitte geben Sie eine gültige fünfstellige Postleitzahl ein.',
  INVALID_EMAIL: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
  INVALID_PHONE: 'Bitte geben Sie eine gültige Telefonnummer ein.',
  CONSENT_REQUIRED: 'Bitte stimmen Sie der Verarbeitung zu, um fortzufahren.',
  UNKNOWN_OPTION: 'Diese Auswahl ist nicht verfügbar.',
  SERVER_REJECTED: 'Ihre Eingabe konnte nicht verarbeitet werden.',
};

/* -------------------------------------------------------------------------- */
/* Event envelope                                                              */
/* -------------------------------------------------------------------------- */

const nullableUuid = uuidSchema.nullable().default(null);
const nullableString = (max: number) => z.string().max(max).nullable().default(null);

/**
 * Marketing parameters observed on the landing URL. These are *untrusted*: they
 * are stored for reporting but may never overwrite internal ids resolved from a
 * signed launch token (spec §19).
 */
export const marketingParamsSchema = z.object({
  utm_source: nullableString(200),
  utm_medium: nullableString(200),
  utm_campaign: nullableString(300),
  utm_content: nullableString(300),
  utm_term: nullableString(300),
  fbclid: nullableString(500),
  fbc: nullableString(500),
  fbp: nullableString(500),
  meta_campaign_id: nullableString(64),
  meta_adset_id: nullableString(64),
  meta_ad_id: nullableString(64),
});
export type MarketingParams = z.infer<typeof marketingParamsSchema>;

/**
 * Internal identifiers resolved from the signed launch token. Trusted.
 */
export const trackingContextSchema = z.object({
  campaign_id: nullableUuid,
  campaign_version_id: nullableUuid,
  angle_id: nullableUuid,
  angle_version_id: nullableUuid,
  offer_id: nullableUuid,
  offer_version_id: nullableUuid,
  creative_id: nullableUuid,
  creative_version_id: nullableUuid,
  funnel_id: nullableUuid,
  funnel_version_id: nullableUuid,
  form_id: nullableUuid,
  form_version_id: nullableUuid,
  experiment_id: nullableUuid,
  experiment_arm_id: nullableUuid,
});
export type TrackingContext = z.infer<typeof trackingContextSchema>;

/**
 * The wire format of a first-party analytics event.
 *
 * Hard rule: no name, e-mail, phone number, free-text answer or full answer set
 * may appear anywhere in this envelope. `@am/tracking` enforces it with a
 * runtime PII guard in addition to this schema.
 */
export const trackingEventSchema = z.object({
  event_id: uuidSchema,
  event_type: eventTypeSchema,
  event_schema_version: z.literal(EVENT_SCHEMA_VERSION),
  occurred_at: isoTimestampSchema,
  received_at: isoTimestampSchema.nullable().default(null),
  environment: appEnvironmentSchema,
  traffic_kind: trafficKindSchema.default('PRODUCTION'),

  visitor_id: uuidSchema,
  session_id: uuidSchema,

  ...trackingContextSchema.shape,

  form_instance_id: nullableUuid,
  submission_id: nullableUuid,

  /** Step / field keys are spec keys, not free text. */
  step_id: specKeySchema.nullable().default(null),
  field_id: specKeySchema.nullable().default(null),
  error_code: validationErrorCodeSchema.nullable().default(null),

  consent_status: consentStatusSchema.default('UNKNOWN'),

  ...marketingParamsSchema.shape,

  referrer: nullableString(2000),
  landing_url: nullableString(2000),

  /**
   * Small, strictly non-PII numeric/boolean/enum extras (e.g. step index,
   * viewport bucket). Validated by `nonPiiMetadataSchema`.
   */
  metadata: z
    .record(z.string().max(64), z.union([z.string().max(120), z.number(), z.boolean()]))
    .default({}),
});
export type TrackingEvent = z.infer<typeof trackingEventSchema>;

/** Client-side payload: the collector stamps `received_at` and `environment`. */
export const trackingEventInputSchema = trackingEventSchema
  .omit({ received_at: true, traffic_kind: true })
  .partial({ event_id: true });
export type TrackingEventInput = z.infer<typeof trackingEventInputSchema>;

/* -------------------------------------------------------------------------- */
/* PII guard                                                                   */
/* -------------------------------------------------------------------------- */

/** Keys that must never appear anywhere in an analytics payload. */
export const FORBIDDEN_EVENT_KEYS: readonly string[] = [
  'email',
  'e_mail',
  'mail',
  'phone',
  'telefon',
  'telephone',
  'first_name',
  'firstname',
  'vorname',
  'last_name',
  'lastname',
  'nachname',
  'name',
  'full_name',
  'answers',
  'answer',
  'antworten',
  'message',
  'nachricht',
  'freitext',
  'address',
  'adresse',
  'street',
  'ip',
  'ip_address',
  'user_agent',
];

const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_LIKE = /(?:\+|00)\d[\d\s\-()]{7,}/;

/**
 * Structural PII scan over an arbitrary payload. Returns the JSON paths that
 * look like personal data. Used by the collector to reject an event outright
 * and by tests to prove acceptance criterion 29.
 */
export function findPiiViolations(payload: unknown, path = '$'): string[] {
  const violations: string[] = [];

  const walk = (value: unknown, currentPath: string): void => {
    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      if (EMAIL_LIKE.test(value)) violations.push(`${currentPath} (E-Mail-Muster)`);
      else if (PHONE_LIKE.test(value)) violations.push(`${currentPath} (Telefonnummer-Muster)`);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }

    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalizedKey = key.toLowerCase();
        if (FORBIDDEN_EVENT_KEYS.includes(normalizedKey)) {
          violations.push(`${currentPath}.${key} (verbotener Schlüssel)`);
          continue;
        }
        walk(child, `${currentPath}.${key}`);
      }
    }
  };

  walk(payload, path);
  return violations;
}

export function assertNoPii(payload: unknown): void {
  const violations = findPiiViolations(payload);
  if (violations.length > 0) {
    throw new Error(`Analytics-Payload enthält personenbezogene Daten: ${violations.join(', ')}`);
  }
}
