import { resolveProviderMode } from '@am/config';
import type { FeatureFlags, ProviderHealth } from '@am/domain';
import { checkOpenAiHealth } from '@am/ai';
import { checkSupabaseHealth } from '@am/db';
import {
  checkHubspotHealth,
  createFixtureCrmSeed,
  createHubspotProvider,
  type HubspotMappingDocument,
  type HubspotProvider,
  type TestLeadResult,
} from '@am/hubspot';
import {
  META_HEALTH_LABELS_DE,
  createMetaProvider,
  getMetaCredentials,
  runMetaHealthChecks,
} from '@am/meta';
import {
  META_WIZARD_STEP_KEYS,
  type CredentialSlot,
  type MetaSetupSnapshot,
  type MetaWizardStep,
  type MetaWizardStepKey,
} from './ops-port';

/**
 * Provider probes and the Meta wizard, shared by both `OpsPort` implementations.
 *
 * Which store the console reads is a separate question from whether Meta,
 * HubSpot, OpenAI and Supabase are reachable: the answer to the second one comes
 * from asking them, and it is the same answer whether the rows behind the rest
 * of the screen come from Postgres or from the fixture. Keeping these here means
 * neither path can drift into inferring a connection from an environment
 * variable while the other keeps asking.
 *
 * Nothing in this module reads the database. `now` is an argument so a fixture
 * snapshot stays pinned to its anchor while the live one moves with the clock.
 */

export function probeOpenAi(now: string): Promise<ProviderHealth> {
  return checkOpenAiHealth({ now });
}

export function probeSupabase(now: string): Promise<ProviderHealth> {
  return checkSupabaseHealth({ now });
}

export function probeMeta(flags: FeatureFlags, now: string): Promise<ProviderHealth> {
  return runMetaHealthChecks({
    provider: createMetaProvider({ flags }),
    credentials: getMetaCredentials(),
    flags,
    now,
  });
}

/**
 * The HubSpot provider handle.
 *
 * The fixture seed is only consulted in FIXTURE mode — `createHubspotProvider`
 * decides that from configuration — so passing it costs nothing on the live path
 * and keeps the fixture provider answering with a realistic portal.
 */
export function hubspotProviderFor(flags: FeatureFlags): HubspotProvider {
  return createHubspotProvider({ flags, seed: createFixtureCrmSeed() });
}

export interface HubspotProbeInput {
  mapping: HubspotMappingDocument;
  flags: FeatureFlags;
  /** Evidence of an end-to-end run, or null when none has been recorded. */
  testLead: TestLeadResult | null;
  now: string;
}

export function probeHubspot(input: HubspotProbeInput): Promise<ProviderHealth> {
  const { mapping, flags, testLead, now } = input;
  return checkHubspotHealth(
    {
      mapping,
      flags,
      lastSuccessfulSyncAt: testLead?.status === 'PASS' ? testLead.finishedAt : null,
      webhookSubscription: {
        active: mapping.webhook.subscribedObjectTypes.length > 0,
        subscribedTypes: mapping.webhook.subscribedObjectTypes,
        secretConfigured: false,
      },
      testLead: testLead ? { status: testLead.status, at: testLead.finishedAt } : null,
    },
    { provider: hubspotProviderFor(flags), now: () => now },
  );
}

/* -------------------------------------------------------------------------- */
/* Meta wizard                                                                 */
/* -------------------------------------------------------------------------- */

const META_STEP_DESCRIPTIONS_DE: Readonly<Record<MetaWizardStepKey, string>> = {
  'meta.app_connection':
    'Meta-App verbinden und Zugriffstoken hinterlegen. Ohne Token bleibt die Konsole im Fixture-Modus.',
  'meta.business': 'Business-Manager auswählen, aus dem Werbekonto, Seite und Dataset stammen.',
  'meta.ad_account': 'Werbekonto auswählen, in dem Entwürfe angelegt und Insights gelesen werden.',
  'meta.page_ig':
    'Facebook-Seite und optional das Instagram-Konto verknüpfen. Ohne Seite kann kein Creative angelegt werden.',
  'meta.pixel_dataset':
    'Pixel und optional ein separates Dataset für Down-Funnel-Ereignisse auswählen.',
  'meta.permissions': 'Die tatsächlich erteilten Berechtigungen prüfen — sie werden nie angenommen.',
  'meta.insights_read': 'Lesetest gegen die Insights-API über die letzten sieben Tage.',
  'meta.draft_test':
    'Entwurfsplan bauen und prüfen. Es wird nichts angelegt; alle Objekte wären pausiert.',
  'meta.capi_test':
    'Ein vollständig gehashtes Ereignispaar erzeugen und die Deduplizierung prüfen. Es wird nichts gesendet.',
  'meta.final_health':
    'Gesamtergebnis aller Prüfungen. Erst wenn hier nichts mehr offen ist, ist die Meta-Anbindung vollständig.',
};

const META_STEP_ENV_VARS: Readonly<Record<MetaWizardStepKey, string[]>> = {
  'meta.app_connection': ['META_APP_ID', 'META_APP_SECRET', 'META_ACCESS_TOKEN'],
  'meta.business': [],
  'meta.ad_account': ['META_AD_ACCOUNT_ID'],
  'meta.page_ig': ['META_PAGE_ID', 'META_INSTAGRAM_ACTOR_ID'],
  'meta.pixel_dataset': ['META_PIXEL_ID', 'META_DATASET_ID'],
  'meta.permissions': [],
  'meta.insights_read': [],
  'meta.draft_test': ['EXTERNAL_WRITES_ENABLED', 'META_MUTATIONS_ENABLED'],
  'meta.capi_test': ['EXTERNAL_WRITES_ENABLED', 'META_CAPI_ENABLED'],
  'meta.final_health': [],
};

export function metaCredentialSlots(mode: 'FIXTURE' | 'LIVE'): CredentialSlot[] {
  const credentials = getMetaCredentials();
  const slot = (
    labelDe: string,
    envVar: string,
    value: string | null,
    secret = false,
  ): CredentialSlot => ({
    labelDe,
    envVar,
    present: Boolean(value),
    // A secret is never rendered, and in fixture mode no id is presented as if
    // it came from Meta.
    displayValue: value && !secret && mode === 'LIVE' ? value : null,
    originDe: value
      ? secret
        ? `Hinterlegt über ${envVar} (wird nicht angezeigt).`
        : mode === 'LIVE'
          ? `Hinterlegt über ${envVar}.`
          : `Hinterlegt über ${envVar}; im Fixture-Modus nicht gegen Meta geprüft.`
      : `Nicht hinterlegt (${envVar}).`,
  });

  return [
    slot('App-ID', 'META_APP_ID', credentials.appId),
    slot('Zugriffstoken', 'META_ACCESS_TOKEN', credentials.accessToken, true),
    slot('Business-Manager-ID', 'META_BUSINESS_ID', credentials.businessId),
    slot('Werbekonto', 'META_AD_ACCOUNT_ID', credentials.adAccountId),
    slot('Facebook-Seite', 'META_PAGE_ID', credentials.pageId),
    slot('Instagram-Konto', 'META_INSTAGRAM_ACTOR_ID', credentials.instagramActorId),
    slot('Pixel', 'META_PIXEL_ID', credentials.pixelId),
    slot('Dataset', 'META_DATASET_ID', credentials.datasetId),
  ];
}

export function metaWizardSteps(health: ProviderHealth): MetaWizardStep[] {
  return META_WIZARD_STEP_KEYS.map((key, index) => {
    if (key === 'meta.final_health') {
      return {
        key,
        order: index + 1,
        labelDe: 'Abschließende Gesamtprüfung',
        descriptionDe: META_STEP_DESCRIPTIONS_DE[key],
        status: health.overall,
        check: null,
        requiredEnvVars: META_STEP_ENV_VARS[key],
      };
    }
    const check = health.checks.find((c) => c.key === key) ?? null;
    return {
      key,
      order: index + 1,
      labelDe: META_HEALTH_LABELS_DE[key],
      descriptionDe: META_STEP_DESCRIPTIONS_DE[key],
      status: check?.status ?? 'AWAITING_EXTERNAL_INPUT',
      check,
      requiredEnvVars: META_STEP_ENV_VARS[key],
    };
  });
}

/**
 * The whole Meta setup snapshot.
 *
 * It reads nothing but configuration and the probe result, which is why both
 * port implementations return the identical object: there is no Meta setup state
 * in the database to differ about.
 */
export async function buildMetaSetupSnapshot(
  flags: FeatureFlags,
  now: string,
): Promise<MetaSetupSnapshot> {
  const mode = resolveProviderMode('META');
  const health = await probeMeta(flags, now);
  return {
    generatedAt: now,
    mode,
    fixtureNoticeDe:
      mode === 'FIXTURE'
        ? 'Der Assistent läuft gegen den Meta-Fixture-Anbieter. Es besteht keine Verbindung zu Meta, alle angezeigten Strukturen und Zahlen stammen aus dem Testdatensatz. Sobald Zugangsdaten hinterlegt sind, laufen dieselben Prüfungen gegen das echte Konto.'
        : null,
    health,
    steps: metaWizardSteps(health),
    credentials: metaCredentialSlots(mode),
    flags,
  };
}
