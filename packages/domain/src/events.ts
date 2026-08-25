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

/**
 * Query parameter carrying the server-signed launch token on every ad
 * destination URL.
 *
 * It lives in `@am/domain` rather than in `@am/tracking` because two packages
 * that never import each other both depend on it: `@am/meta` writes it into the
 * Meta ad URL and `@am/tracking` reads it back in the funnel runtime. A private
 * constant in each would let them drift, and the failure mode is silent — the
 * runtime simply finds no token and every lead falls back to UNKNOWN
 * attribution, which looks like weak campaigns rather than a bug.
 */
export const LAUNCH_TOKEN_PARAM = 'am_t';

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

/**
 * Key fragments matched as a normalised **substring**.
 *
 * These are unambiguous: any key containing `email`, `phone` or `firstname`
 * carries that datum, whatever the surrounding naming convention.
 */
export const FORBIDDEN_EVENT_KEY_FRAGMENTS: readonly string[] = [
  'email',
  'phone',
  'telefon',
  'telephone',
  'vorname',
  'nachname',
  'firstname',
  'lastname',
  'fullname',
  'answers',
  'antworten',
];

/**
 * Keys matched **exactly** (after normalisation).
 *
 * `name` is the reason this second list exists: as a substring it also matches
 * `content_name`, `campaign_name` and `event_name`, all of which are legitimate
 * and none of which carry personal data. A guard that rejects valid events is a
 * guard someone switches off, so ambiguous words are matched whole.
 *
 * Note the asymmetry with `AUDIT_REDACT_KEYS`, which matches broadly on
 * purpose: over-redacting a log line costs a little debuggability, whereas
 * over-rejecting an event costs real data.
 */
export const FORBIDDEN_EVENT_KEYS_EXACT: readonly string[] = [
  'name',
  'mail',
  'ip',
  'ipaddress',
  'useragent',
  'message',
  'nachricht',
  'freitext',
  'address',
  'adresse',
  'street',
  'kontakt',
  'answer',
];

/** Every forbidden key, for callers that just want the list. */
export const FORBIDDEN_EVENT_KEYS: readonly string[] = [
  ...FORBIDDEN_EVENT_KEY_FRAGMENTS,
  ...FORBIDDEN_EVENT_KEYS_EXACT,
];

/**
 * Key matching is a normalised substring test, not equality: `phone_number`,
 * `emailAddress` and `contact_email` are the same personal data as `phone` and
 * `email`, and an exact-match list quietly lets every variant through.
 */
export function isForbiddenEventKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  if (FORBIDDEN_EVENT_KEYS_EXACT.includes(normalized)) return true;
  return FORBIDDEN_EVENT_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/**
 * International format: a leading `+` or `00`, then enough digits.
 */
const PHONE_INTERNATIONAL = /(?:\+|\b00)\d[\d\s\-()/.]{6,}\d/;

/**
 * German national format — `0151 23456789`, `030/12345678`, `01512345678`.
 *
 * This is the shape a German visitor actually types, so leaving it out made the
 * guard miss the common case while catching the rare one.
 */
const PHONE_NATIONAL_DE = /(?:^|[^\d+])0\d[\d\s\-()/.]{7,}\d/;

/**
 * Identifier shapes that are legitimately present in every event and must not
 * be mistaken for contact data. A UUID such as `00123456-7890-4abc-…` otherwise
 * trips the phone heuristic, which would make the guard reject valid events —
 * and a guard that fires on good input gets switched off.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_LIKE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A bare digit run with no `+`, no leading `0` and no separators is genuinely
 * ambiguous: a Meta object id, a spend figure in minor units and a phone number
 * all look the same. Rather than guess, this matches only a DACH country code
 * at a length a real number has — which catches `4915123456789` while leaving
 * six-figure amounts and fifteen-plus-digit provider ids alone.
 *
 * The primary defence against a phone number is the key check; this is the
 * backstop for the case where someone put one under an innocent key.
 */
const PHONE_BARE_DACH = /^(?:49|43|41)\d{9,11}$/;

/** A phone number has enough digits to be one. Ids and dates do not qualify. */
function looksLikePhoneNumber(value: string): boolean {
  const trimmed = value.trim();
  if (PHONE_BARE_DACH.test(trimmed)) return true;

  for (const pattern of [PHONE_INTERNATIONAL, PHONE_NATIONAL_DE]) {
    const match = pattern.exec(value);
    if (!match) continue;
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 16) return true;
  }
  return false;
}

/**
 * Percent-encoding is the one transformation worth undoing before scanning:
 * `max%40example.de` reaches us from a query string routinely and is the same
 * address. Deeper obfuscation (base64, "max (at) example.de") is deliberately
 * out of scope — the guard is a structural backstop against a mistake, not an
 * adversary, and chasing every encoding would trade false negatives for false
 * positives on legitimate ids.
 */
function decodeForScan(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Structural PII scan over an arbitrary payload. Returns the JSON paths that
 * look like personal data. Used by the collector to reject an event outright
 * and by tests to prove acceptance criterion 29.
 */
export function findPiiViolations(payload: unknown, path = '$'): string[] {
  const violations: string[] = [];

  const walk = (value: unknown, currentPath: string): void => {
    if (value === null || value === undefined) return;

    // Numbers are scanned too: a phone number arriving as `4915123456789`
    // rather than a string is the same personal datum.
    if (typeof value === 'string' || typeof value === 'number') {
      const raw = String(value);
      const trimmed = raw.trim();
      if (UUID_LIKE.test(trimmed) || ISO_TIMESTAMP_LIKE.test(trimmed)) return;
      const scanned = decodeForScan(raw);
      if (EMAIL_LIKE.test(scanned)) violations.push(`${currentPath} (E-Mail-Muster)`);
      else if (looksLikePhoneNumber(scanned)) violations.push(`${currentPath} (Telefonnummer-Muster)`);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }

    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (isForbiddenEventKey(key)) {
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
