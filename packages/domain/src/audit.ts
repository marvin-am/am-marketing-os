import { z } from 'zod';
import { uuidSchema } from './ids';
import { isoTimestampSchema } from './primitives';

/**
 * Everything the product does that a human might later have to answer for is
 * recorded here (spec §28, acceptance criterion 26): generations, approvals,
 * publications and provider actions.
 */
export const AUDIT_ACTIONS = [
  'campaign.created',
  'campaign.state_changed',
  'campaign.version_published',
  'proposal.generated',
  'proposal.regenerated',
  'angle.approved',
  'offer.approved',
  'claim.changed',
  'approval.granted',
  'approval.rejected',
  'approval.invalidated',
  'creative.generated',
  'creative.edited',
  'creative.approved',
  'funnel.version_created',
  'funnel.published',
  'form.version_created',
  'form.published',
  'experiment.started',
  'experiment.concluded',
  'launch_qa.evaluated',
  'meta.command_requested',
  'meta.command_confirmed',
  'meta.command_failed',
  'meta.import_completed',
  'hubspot.mapping_published',
  'hubspot.test_lead_sent',
  'hubspot.sync_failed',
  'hubspot.sync_retried',
  'capi.dispatched',
  'capi.dead_lettered',
  'recommendation.generated',
  'recommendation.accepted',
  'recommendation.dismissed',
  'recommendation.executed',
  'settings.changed',
  'integration.connected',
  'integration.disconnected',
  'user.role_changed',
  'retention.purge_executed',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditLogSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  action: auditActionSchema,
  occurred_at: isoTimestampSchema,
  /** Null for system/cron actors; `actor_label` then names the job. */
  actor_id: uuidSchema.nullable().default(null),
  actor_label: z.string().max(160),
  entity_type: z.string().max(80),
  entity_id: z.string().max(80),
  campaign_id: uuidSchema.nullable().default(null),
  summaryDe: z.string().min(1).max(600),
  /** Redacted before write — never contains PII or secrets. */
  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),
  /** Correlates an audit entry with the command / job that produced it. */
  correlation_id: z.string().max(128).nullable().default(null),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

/**
 * Key fragments stripped from audit and log payloads.
 *
 * Matched as normalised substrings, not exact keys: `phone_number`,
 * `emailAddress` and `contact_email` carry the same personal data as `phone`
 * and `email`, and an exact-match list quietly lets every variant through —
 * which matters here more than anywhere, because `@am/observability` routes
 * every log line through `redact()`.
 */
export const AUDIT_REDACT_KEYS: readonly string[] = [
  'email',
  'mail',
  'phone',
  'telefon',
  'mobile',
  'firstname',
  'lastname',
  'vorname',
  'nachname',
  'fullname',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'apikey',
  'authorization',
  'password',
  'secret',
  'servicerolekey',
  'answers',
  'antworten',
  'pii',
];

const REDACTED = '[redacted]';

/** Patterns redacted out of a *value*, even when its key looks innocent. */
const VALUE_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /(?:\+|\b00)\d[\d\s\-()/.]{7,}\d/g,
  /(?:^|[^\d+])(0\d[\d\s\-()/.]{8,}\d)/g,
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

function isRedactedKey(key: string, keys: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  return keys.some((candidate) => normalized.includes(normalizeKey(candidate)));
}

/**
 * Replaces contact data found inside a string, leaving the rest intact.
 *
 * A landing URL with an address in a query parameter still has debugging value
 * once the address is gone, so the pattern is replaced rather than the whole
 * value — redacting everything teaches people to stop reading the logs.
 */
function redactValue(value: string): string {
  let result = value;
  for (const pattern of VALUE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const leading = /^[^\d+]/.test(match) ? match[0] : '';
      return `${leading}${REDACTED}`;
    });
  }
  return result;
}

/**
 * Deep-redacts audit and log payloads. Values are replaced with a marker rather
 * than dropped so the shape of a change stays reviewable.
 */
export function redact<T>(value: T, keys: readonly string[] = AUDIT_REDACT_KEYS): T {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return input;
    if (Array.isArray(input)) return input.map(walk);
    if (typeof input === 'string') return redactValue(input);
    if (typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        result[key] = isRedactedKey(key, keys) ? REDACTED : walk(child);
      }
      return result;
    }
    return input;
  };
  return walk(value) as T;
}

export const AUDIT_ACTION_LABELS_DE: Partial<Record<AuditAction, string>> = {
  'campaign.created': 'Kampagne erstellt',
  'campaign.state_changed': 'Kampagnenstatus geändert',
  'campaign.version_published': 'Kampagnenversion veröffentlicht',
  'proposal.generated': 'Kampagnenvorschlag erzeugt',
  'proposal.regenerated': 'Kampagnenvorschlag neu erzeugt',
  'approval.granted': 'Freigabe erteilt',
  'approval.rejected': 'Freigabe abgelehnt',
  'approval.invalidated': 'Freigabe durch Änderung ungültig geworden',
  'creative.generated': 'Creative erzeugt',
  'creative.approved': 'Creative freigegeben',
  'funnel.published': 'Funnel veröffentlicht',
  'form.published': 'Formular veröffentlicht',
  'experiment.started': 'Experiment gestartet',
  'experiment.concluded': 'Experiment beendet',
  'launch_qa.evaluated': 'Launch-QA geprüft',
  'meta.command_requested': 'Meta-Aktion angefordert',
  'meta.command_confirmed': 'Meta-Aktion bestätigt',
  'meta.command_failed': 'Meta-Aktion fehlgeschlagen',
  'hubspot.mapping_published': 'HubSpot-Mapping veröffentlicht',
  'hubspot.test_lead_sent': 'HubSpot-Test-Lead gesendet',
  'capi.dispatched': 'CAPI-Ereignis gesendet',
  'recommendation.executed': 'Empfehlung ausgeführt',
  'settings.changed': 'Einstellungen geändert',
};
