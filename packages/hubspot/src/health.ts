import {
  canWriteHubspot,
  nowIso,
  rollUpHealth,
  type ConnectionState,
  type FeatureFlags,
  type HealthCheck,
  type HealthStatus,
  type IsoTimestamp,
  type ProviderHealth,
} from '@am/domain';
import {
  missingRequiredMappings,
  requiredMappingsComplete,
  type HubspotMappingDocument,
} from './mapping/schema';
import type { HubspotProvider } from './provider';
import { REQUIRED_HUBSPOT_SCOPES } from './provider-types';
import type { TestLeadStatus } from './test-lead';

/**
 * The HubSpot health panel.
 *
 * A missing credential or an unfinished mapping is `AWAITING_EXTERNAL_INPUT`,
 * never a fabricated `FAIL` and never a fabricated `PASS`: the product is
 * correct, it is simply waiting for something only the customer can supply
 * (spec §29).
 */

export const HUBSPOT_HEALTH_CHECK_KEYS = [
  'connection',
  'scopes',
  'mapping_complete',
  'last_successful_sync',
  'webhook_subscription',
  'test_lead',
  'write_flags',
] as const;
export type HubspotHealthCheckKey = (typeof HUBSPOT_HEALTH_CHECK_KEYS)[number];

export const HUBSPOT_HEALTH_LABELS_DE: Readonly<Record<HubspotHealthCheckKey, string>> = {
  connection: 'Verbindung zu HubSpot',
  scopes: 'Berechtigungen (Scopes)',
  mapping_complete: 'Pflichtmapping vollständig',
  last_successful_sync: 'Letzte erfolgreiche Synchronisation',
  webhook_subscription: 'Webhook-Abonnement',
  test_lead: 'Test-Lead',
  write_flags: 'Schreibzugriffe',
};

export interface HubspotHealthInput {
  mapping: HubspotMappingDocument | null;
  flags: FeatureFlags;
  lastSuccessfulSyncAt?: IsoTimestamp | null;
  webhookSubscription?: {
    active: boolean;
    subscribedTypes: readonly string[];
    secretConfigured: boolean;
  } | null;
  testLead?: { status: TestLeadStatus; at: IsoTimestamp | null } | null;
  requiredScopes?: readonly string[];
  /** After this many hours without a successful sync the check warns. */
  staleSyncHours?: number;
}

export interface HubspotHealthDeps {
  provider: HubspotProvider;
  now?: () => IsoTimestamp;
}

function check(
  key: HubspotHealthCheckKey,
  status: HealthStatus,
  checkedAt: IsoTimestamp,
  detailDe: string | null,
  remediationDe: string | null,
  blocksLiveOnly: boolean,
): HealthCheck {
  return {
    key,
    labelDe: HUBSPOT_HEALTH_LABELS_DE[key],
    status,
    detailDe,
    checkedAt,
    remediationDe,
    blocksLiveOnly,
  };
}

export async function checkHubspotHealth(
  input: HubspotHealthInput,
  deps: HubspotHealthDeps,
): Promise<ProviderHealth> {
  const now = deps.now ?? nowIso;
  const checkedAt = now();
  const checks: HealthCheck[] = [];

  /* --- connection --------------------------------------------------------- */
  const probe = await deps.provider.health();
  const connectionState: ConnectionState = probe.state;

  if (connectionState === 'NOT_CONFIGURED') {
    checks.push(
      check(
        'connection',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        probe.detailDe ?? 'Es sind keine HubSpot-Zugangsdaten hinterlegt.',
        'Bitte ein HubSpot-Token (Private App) hinterlegen und die Integration verbinden.',
        true,
      ),
    );
  } else if (connectionState === 'FIXTURE') {
    checks.push(
      check(
        'connection',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Fixture-Modus: es besteht keine Verbindung zu einem HubSpot-Portal.',
        'Für den Live-Betrieb DEMO_MODE deaktivieren und ein HubSpot-Token hinterlegen.',
        true,
      ),
    );
  } else if (!probe.reachable) {
    checks.push(
      check(
        'connection',
        'FAIL',
        checkedAt,
        probe.detailDe ?? 'HubSpot ist derzeit nicht erreichbar.',
        'Bitte Token und Netzwerkzugang prüfen.',
        false,
      ),
    );
  } else {
    checks.push(
      check(
        'connection',
        'PASS',
        checkedAt,
        probe.accountLabel
          ? `Verbunden mit ${probe.accountLabel}${probe.portalId ? ` (Portal ${probe.portalId})` : ''}.`
          : 'Verbindung besteht.',
        null,
        false,
      ),
    );
  }

  /* --- scopes ------------------------------------------------------------- */
  const required = input.requiredScopes ?? REQUIRED_HUBSPOT_SCOPES;
  if (connectionState !== 'CONNECTED') {
    checks.push(
      check(
        'scopes',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Die Berechtigungen können erst nach einer erfolgreichen Verbindung geprüft werden.',
        null,
        true,
      ),
    );
  } else if (probe.grantedScopes.length === 0) {
    // The provider could not read them; inventing a PASS here would be a lie.
    checks.push(
      check(
        'scopes',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Die Scope-Liste konnte für dieses Token nicht ausgelesen werden.',
        `Bitte manuell prüfen, dass folgende Scopes gesetzt sind: ${required.join(', ')}.`,
        true,
      ),
    );
  } else {
    const missing = required.filter((scope) => !probe.grantedScopes.includes(scope));
    checks.push(
      check(
        'scopes',
        missing.length === 0 ? 'PASS' : 'FAIL',
        checkedAt,
        missing.length === 0
          ? 'Alle erforderlichen Berechtigungen sind vorhanden.'
          : `Es fehlen folgende Berechtigungen: ${missing.join(', ')}.`,
        missing.length === 0 ? null : 'Bitte die fehlenden Scopes in der HubSpot-App ergänzen.',
        false,
      ),
    );
  }

  /* --- mapping ------------------------------------------------------------ */
  if (!input.mapping) {
    checks.push(
      check(
        'mapping_complete',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Es ist noch kein HubSpot-Mapping angelegt.',
        'Bitte den Mapping-Assistenten durchlaufen.',
        true,
      ),
    );
  } else if (requiredMappingsComplete(input.mapping)) {
    checks.push(
      check(
        'mapping_complete',
        'PASS',
        checkedAt,
        `Mapping-Version ${input.mapping.version} ist vollständig${
          input.mapping.source === 'FIXTURE' ? ' (Fixture-Mapping)' : ''
        }.`,
        null,
        false,
      ),
    );
  } else {
    const missing = missingRequiredMappings(input.mapping);
    checks.push(
      check(
        'mapping_complete',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        `Es fehlen ${missing.length} Pflichtangabe(n): ${missing
          .slice(0, 3)
          .map((i) => i.messageDe)
          .join(' ')}`,
        'Bitte die offenen Schritte im Mapping-Assistenten abschließen.',
        true,
      ),
    );
  }

  /* --- last successful sync ---------------------------------------------- */
  const staleHours = input.staleSyncHours ?? 24;
  if (!input.lastSuccessfulSyncAt) {
    checks.push(
      check(
        'last_successful_sync',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Es wurde noch kein Lead erfolgreich nach HubSpot übertragen.',
        'Der Wert füllt sich mit dem ersten erfolgreichen Sync.',
        true,
      ),
    );
  } else {
    const ageHours = (Date.parse(checkedAt) - Date.parse(input.lastSuccessfulSyncAt)) / 3_600_000;
    checks.push(
      check(
        'last_successful_sync',
        ageHours > staleHours ? 'WARN' : 'PASS',
        checkedAt,
        `Letzte erfolgreiche Synchronisation: ${input.lastSuccessfulSyncAt}.`,
        ageHours > staleHours
          ? `Seit mehr als ${staleHours} Stunden wurde nichts mehr übertragen. Bitte die Sync-Fehlerliste prüfen.`
          : null,
        false,
      ),
    );
  }

  /* --- webhook ------------------------------------------------------------ */
  const webhook = input.webhookSubscription;
  if (!webhook) {
    checks.push(
      check(
        'webhook_subscription',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Es ist kein Webhook-Abonnement eingerichtet.',
        'Bitte im HubSpot-App-Setup die Webhook-Abonnements und das Secret hinterlegen.',
        true,
      ),
    );
  } else if (!webhook.secretConfigured) {
    checks.push(
      check(
        'webhook_subscription',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Das Webhook-Secret fehlt; eingehende Webhooks werden abgelehnt.',
        'Bitte HUBSPOT_WEBHOOK_SECRET setzen.',
        true,
      ),
    );
  } else {
    checks.push(
      check(
        'webhook_subscription',
        webhook.active && webhook.subscribedTypes.length > 0 ? 'PASS' : 'WARN',
        checkedAt,
        webhook.active
          ? `Aktiv für: ${webhook.subscribedTypes.join(', ') || 'keine Objekttypen'}.`
          : 'Das Abonnement ist derzeit inaktiv.',
        webhook.active && webhook.subscribedTypes.length > 0
          ? null
          : 'Ohne Webhooks werden Änderungen nur stündlich über den Abgleich erkannt.',
        false,
      ),
    );
  }

  /* --- test lead ---------------------------------------------------------- */
  const testLead = input.testLead;
  if (!testLead || testLead.status === 'AWAITING_EXTERNAL_INPUT') {
    checks.push(
      check(
        'test_lead',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Es wurde noch kein erfolgreicher Test-Lead gesendet.',
        'Bitte im Mapping-Assistenten den Test-Lead ausführen.',
        true,
      ),
    );
  } else if (testLead.status === 'DRY_RUN') {
    checks.push(
      check(
        'test_lead',
        'AWAITING_EXTERNAL_INPUT',
        checkedAt,
        'Der Test-Lead lief als Dry-Run und zählt nicht als erfolgreich.',
        'Für den Live-Launch EXTERNAL_WRITES_ENABLED und HUBSPOT_WRITES_ENABLED aktivieren und den Test wiederholen.',
        true,
      ),
    );
  } else if (testLead.status === 'FAIL') {
    checks.push(
      check(
        'test_lead',
        'FAIL',
        checkedAt,
        `Der letzte Test-Lead ist fehlgeschlagen${testLead.at ? ` (${testLead.at})` : ''}.`,
        'Bitte Mapping und Berechtigungen prüfen und den Test wiederholen.',
        false,
      ),
    );
  } else {
    checks.push(
      check(
        'test_lead',
        'PASS',
        checkedAt,
        `Erfolgreicher Test-Lead${testLead.at ? ` am ${testLead.at}` : ''}.`,
        null,
        false,
      ),
    );
  }

  /* --- write flags -------------------------------------------------------- */
  const writesEnabled = canWriteHubspot(input.flags);
  checks.push(
    check(
      'write_flags',
      writesEnabled ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      checkedAt,
      writesEnabled
        ? 'Schreibzugriffe auf HubSpot sind freigegeben.'
        : 'Schreibzugriffe sind deaktiviert; jede Übertragung endet als Dry-Run.',
      writesEnabled
        ? null
        : 'Für den Live-Betrieb EXTERNAL_WRITES_ENABLED=true und HUBSPOT_WRITES_ENABLED=true setzen.',
      true,
    ),
  );

  return {
    provider: 'HUBSPOT',
    state: connectionState,
    overall: rollUpHealth(checks),
    checks,
    checkedAt,
  };
}
