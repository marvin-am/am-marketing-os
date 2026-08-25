import { z } from 'zod';
import {
  commandStateSchema,
  connectionStateSchema,
  healthStatusSchema,
  metaCommandKindSchema,
  providerSchema,
} from './enums';
import { uuidSchema } from './ids';
import { isoTimestampSchema } from './primitives';

/* -------------------------------------------------------------------------- */
/* Feature flags                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Runtime safety rails (spec §27). `externalWritesEnabled` is the master switch:
 * with it false, no adapter performs any external write regardless of the more
 * specific flags.
 */
export const featureFlagsSchema = z.object({
  demoMode: z.boolean().default(true),
  externalWritesEnabled: z.boolean().default(false),
  metaMutationsEnabled: z.boolean().default(false),
  metaCapiEnabled: z.boolean().default(false),
  hubspotWritesEnabled: z.boolean().default(false),
});
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

export const SAFE_DEFAULT_FLAGS: FeatureFlags = {
  demoMode: true,
  externalWritesEnabled: false,
  metaMutationsEnabled: false,
  metaCapiEnabled: false,
  hubspotWritesEnabled: false,
};

/** Effective permission for one kind of external write. */
export function canWriteMeta(flags: FeatureFlags): boolean {
  return flags.externalWritesEnabled && flags.metaMutationsEnabled;
}

export function canDispatchCapi(flags: FeatureFlags): boolean {
  return flags.externalWritesEnabled && flags.metaCapiEnabled;
}

export function canWriteHubspot(flags: FeatureFlags): boolean {
  return flags.externalWritesEnabled && flags.hubspotWritesEnabled;
}

/* -------------------------------------------------------------------------- */
/* Connections and health                                                      */
/* -------------------------------------------------------------------------- */

export const integrationConnectionSchema = z.object({
  id: uuidSchema,
  provider: providerSchema,
  state: connectionStateSchema,
  /** Non-secret display label, e.g. the ad account name. */
  accountLabel: z.string().max(200).nullable().default(null),
  externalAccountId: z.string().max(120).nullable().default(null),
  /** Scopes actually granted by the provider. Never invented. */
  grantedScopes: z.array(z.string().max(120)).default([]),
  connectedAt: isoTimestampSchema.nullable().default(null),
  expiresAt: isoTimestampSchema.nullable().default(null),
  lastCheckedAt: isoTimestampSchema.nullable().default(null),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

/**
 * One health probe. `AWAITING_EXTERNAL_INPUT` is a first-class status, not a
 * failure: it means the product is correct but a credential or mapping has not
 * been supplied yet (spec §29).
 */
export const healthCheckSchema = z.object({
  key: z.string().min(1).max(80),
  labelDe: z.string().min(1).max(200),
  status: healthStatusSchema,
  detailDe: z.string().max(1000).nullable().default(null),
  checkedAt: isoTimestampSchema,
  /** What the operator has to do next, in plain German. */
  remediationDe: z.string().max(600).nullable().default(null),
  /** Whether a FAIL here blocks the live step only, or the whole workflow. */
  blocksLiveOnly: z.boolean().default(false),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const providerHealthSchema = z.object({
  provider: providerSchema,
  state: connectionStateSchema,
  overall: healthStatusSchema,
  checks: z.array(healthCheckSchema),
  checkedAt: isoTimestampSchema,
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const HEALTH_STATUS_LABELS_DE: Readonly<
  Record<z.infer<typeof healthStatusSchema>, string>
> = {
  PASS: 'OK',
  WARN: 'Warnung',
  FAIL: 'Fehler',
  AWAITING_EXTERNAL_INPUT: 'Wartet auf externen Input',
};

export const CONNECTION_STATE_LABELS_DE: Readonly<
  Record<z.infer<typeof connectionStateSchema>, string>
> = {
  NOT_CONFIGURED: 'Nicht konfiguriert',
  FIXTURE: 'Fixture-Modus',
  CONNECTED: 'Verbunden',
  DEGRADED: 'Eingeschränkt',
  ERROR: 'Fehler',
};

/**
 * Aggregates individual probes. AWAITING_EXTERNAL_INPUT never masks a real
 * FAIL, and never gets upgraded to PASS.
 */
export function rollUpHealth(checks: readonly HealthCheck[]): z.infer<typeof healthStatusSchema> {
  if (checks.length === 0) return 'AWAITING_EXTERNAL_INPUT';
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'AWAITING_EXTERNAL_INPUT')) return 'AWAITING_EXTERNAL_INPUT';
  if (checks.some((c) => c.status === 'WARN')) return 'WARN';
  return 'PASS';
}

/* -------------------------------------------------------------------------- */
/* External commands                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every external mutation goes through a command record. A local click is never
 * reported as success — only `PROVIDER_CONFIRMED` is (acceptance criterion 23).
 */
export const externalCommandSchema = z.object({
  id: uuidSchema,
  provider: providerSchema,
  kind: metaCommandKindSchema,
  /** Stable key; a retry with the same key must not create a second object. */
  idempotencyKey: z.string().min(8).max(128),
  state: commandStateSchema,
  requestedBy: uuidSchema,
  requestedAt: isoTimestampSchema,
  confirmedAt: isoTimestampSchema.nullable().default(null),
  reconciledAt: isoTimestampSchema.nullable().default(null),
  /** Redacted request preview shown to the operator before confirmation. */
  requestPreview: z.record(z.string(), z.unknown()).default({}),
  providerResponseRedacted: z.unknown().nullable().default(null),
  error: z.string().max(2000).nullable().default(null),
  attemptCount: z.number().int().min(0).default(0),
  campaign_id: uuidSchema.nullable().default(null),
});
export type ExternalCommand = z.infer<typeof externalCommandSchema>;

export const COMMAND_STATE_LABELS_DE: Readonly<
  Record<z.infer<typeof commandStateSchema>, string>
> = {
  PENDING_CONFIRMATION: 'Wartet auf Bestätigung',
  QUEUED: 'In Warteschlange',
  IN_FLIGHT: 'Wird ausgeführt',
  PROVIDER_CONFIRMED: 'Vom Provider bestätigt',
  FAILED: 'Fehlgeschlagen',
  RECONCILED: 'Abgeglichen',
  BLOCKED_BY_FLAG: 'Durch Sicherheits-Flag blockiert',
};

/** Only this state may be rendered as a successful external change. */
export function isProviderConfirmed(command: ExternalCommand): boolean {
  return command.state === 'PROVIDER_CONFIRMED' || command.state === 'RECONCILED';
}

/* -------------------------------------------------------------------------- */
/* Dry-run envelope                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What an adapter returns when writes are disabled. It is explicitly *not* a
 * success: the console renders it as "Dry-Run – nicht ausgeführt" so nobody can
 * mistake it for a completed provider action (spec §2, §27).
 */
export const dryRunResultSchema = z.object({
  dryRun: z.literal(true),
  provider: providerSchema,
  operation: z.string().min(1).max(120),
  wouldSend: z.record(z.string(), z.unknown()),
  blockedByDe: z.string().min(1).max(300),
});
export type DryRunResult = z.infer<typeof dryRunResultSchema>;

export function dryRun(
  provider: z.infer<typeof providerSchema>,
  operation: string,
  wouldSend: Record<string, unknown>,
  blockedByDe = 'Externe Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED=false).',
): DryRunResult {
  return { dryRun: true, provider, operation, wouldSend, blockedByDe };
}
