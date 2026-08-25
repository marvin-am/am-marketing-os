/**
 * Setup-wizard probes.
 *
 * The whole point of this module is that a missing credential is not a failure.
 * `AWAITING_EXTERNAL_INPUT` is a first-class status: the product is correct, a
 * human has simply not supplied a token or an id yet, and the console keeps
 * working against fixtures in the meantime (AGENTS.md rule 1, spec §29).
 *
 * Every probe returns a `HealthCheck` with a German label, a German detail and
 * a German remediation sentence. `blocksLiveOnly` distinguishes "you cannot go
 * live" from "the product is broken".
 */
import {
  type FeatureFlags,
  type HealthCheck,
  type HealthStatus,
  type ProviderHealth,
  DomainError,
  canDispatchCapi,
  canWriteMeta,
  nowIso,
  rollUpHealth,
} from '@am/domain';
import { buildInitialLeadEvent, redactCapiPayload } from './capi';
import { buildDraftPlan, draftPlanPreview } from './draft';
import type { MetaProvider } from './provider';

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

export interface MetaCredentials {
  appId: string | null;
  accessToken: string | null;
  /**
   * The Conversions API token, when it differs from the Marketing API one.
   * Null means "use `accessToken`" — not "CAPI is unconfigured".
   */
  capiAccessToken: string | null;
  businessId: string | null;
  adAccountId: string | null;
  pageId: string | null;
  instagramActorId: string | null;
  pixelId: string | null;
  datasetId: string | null;
  apiVersion: string;
}

export const META_HEALTH_KEYS = [
  'meta.app_connection',
  'meta.business',
  'meta.ad_account',
  'meta.page_ig',
  'meta.pixel_dataset',
  'meta.permissions',
  'meta.insights_read',
  'meta.draft_test',
  'meta.capi_test',
] as const;
export type MetaHealthKey = (typeof META_HEALTH_KEYS)[number];

export const META_HEALTH_LABELS_DE: Readonly<Record<MetaHealthKey, string>> = {
  'meta.app_connection': 'Meta-App verbunden',
  'meta.business': 'Business-Manager erreichbar',
  'meta.ad_account': 'Werbekonto erreichbar',
  'meta.page_ig': 'Seite und Instagram-Konto',
  'meta.pixel_dataset': 'Pixel / Dataset',
  'meta.permissions': 'Berechtigungen',
  'meta.insights_read': 'Insights-Lesetest',
  'meta.draft_test': 'Testentwurf (pausiert)',
  'meta.capi_test': 'Conversions-API-Test',
};

/** Scopes the product needs. Reported, never assumed to have been granted. */
export const REQUIRED_META_SCOPES: readonly string[] = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
];

/* -------------------------------------------------------------------------- */
/* Probe helpers                                                               */
/* -------------------------------------------------------------------------- */

function check(
  key: MetaHealthKey,
  status: HealthStatus,
  detailDe: string | null,
  remediationDe: string | null,
  checkedAt: string,
  blocksLiveOnly = false,
): HealthCheck {
  return {
    key,
    labelDe: META_HEALTH_LABELS_DE[key],
    status,
    detailDe,
    checkedAt,
    remediationDe,
    blocksLiveOnly,
  };
}

function awaiting(
  key: MetaHealthKey,
  detailDe: string,
  remediationDe: string,
  checkedAt: string,
  blocksLiveOnly = true,
): HealthCheck {
  return check(key, 'AWAITING_EXTERNAL_INPUT', detailDe, remediationDe, checkedAt, blocksLiveOnly);
}

function failureFrom(
  key: MetaHealthKey,
  error: unknown,
  remediationDe: string,
  checkedAt: string,
  blocksLiveOnly = false,
): HealthCheck {
  if (error instanceof DomainError) {
    // A missing or revoked credential is external input, not a product defect.
    const status: HealthStatus =
      error.code === 'PROVIDER_NOT_CONFIGURED' ? 'AWAITING_EXTERNAL_INPUT' : 'FAIL';
    return check(key, status, error.messageDe, remediationDe, checkedAt, blocksLiveOnly);
  }
  return check(key, 'FAIL', 'Unbekannter Fehler bei der Meta-Prüfung.', remediationDe, checkedAt, blocksLiveOnly);
}

/* -------------------------------------------------------------------------- */
/* Individual probes                                                           */
/* -------------------------------------------------------------------------- */

export async function probeAppConnection(
  credentials: MetaCredentials,
  provider: MetaProvider,
  checkedAt: string,
): Promise<HealthCheck> {
  if (provider.mode === 'FIXTURE') {
    return awaiting(
      'meta.app_connection',
      'Fixture-Modus: Es besteht keine Verbindung zu Meta. Alle Daten stammen aus dem Testdatensatz.',
      'DEMO_MODE deaktivieren und META_ACCESS_TOKEN hinterlegen.',
      checkedAt,
    );
  }
  if (!credentials.accessToken || !credentials.appId) {
    return awaiting(
      'meta.app_connection',
      'Es ist kein Meta-Zugriffstoken hinterlegt.',
      'Meta-App verbinden und META_APP_ID sowie META_ACCESS_TOKEN hinterlegen.',
      checkedAt,
    );
  }
  try {
    const accounts = await provider.listAdAccounts();
    return check(
      'meta.app_connection',
      'PASS',
      `Verbindung aktiv (API ${credentials.apiVersion}); ${accounts.length} Werbekonto/-konten sichtbar.`,
      null,
      checkedAt,
    );
  } catch (error) {
    return failureFrom(
      'meta.app_connection',
      error,
      'Token prüfen und die Meta-Verbindung in den Einstellungen neu autorisieren.',
      checkedAt,
    );
  }
}

export async function probeBusiness(
  credentials: MetaCredentials,
  checkedAt: string,
): Promise<HealthCheck> {
  if (!credentials.businessId) {
    return awaiting(
      'meta.business',
      'Es ist keine Business-Manager-ID hinterlegt. Datasets und seitenübergreifende Prüfungen bleiben eingeschränkt.',
      'Business-Manager-ID in den Einstellungen hinterlegen.',
      checkedAt,
    );
  }
  return check(
    'meta.business',
    'PASS',
    `Business-Manager ${credentials.businessId} konfiguriert.`,
    null,
    checkedAt,
  );
}

export async function probeAdAccount(
  credentials: MetaCredentials,
  provider: MetaProvider,
  checkedAt: string,
): Promise<HealthCheck> {
  const adAccountId = credentials.adAccountId;
  if (!adAccountId) {
    return awaiting(
      'meta.ad_account',
      'Es ist kein Werbekonto ausgewählt.',
      'META_AD_ACCOUNT_ID hinterlegen bzw. im Assistenten ein Werbekonto auswählen.',
      checkedAt,
    );
  }
  try {
    const accounts = await provider.listAdAccounts();
    const match = accounts.find(
      (account) =>
        account.externalId === adAccountId ||
        account.accountId === adAccountId.replace('act_', ''),
    );
    if (!match) {
      return check(
        'meta.ad_account',
        'FAIL',
        `Das konfigurierte Werbekonto ${adAccountId} ist mit diesem Zugang nicht sichtbar.`,
        'Zugriff auf das Werbekonto im Business-Manager erteilen oder ein anderes Konto auswählen.',
        checkedAt,
      );
    }
    return check(
      'meta.ad_account',
      'PASS',
      `Werbekonto „${match.name}" (${match.currency}, ${match.timezone ?? 'Zeitzone unbekannt'}).`,
      null,
      checkedAt,
    );
  } catch (error) {
    return failureFrom(
      'meta.ad_account',
      error,
      'Berechtigungen für das Werbekonto prüfen.',
      checkedAt,
    );
  }
}

export async function probePageAndInstagram(
  credentials: MetaCredentials,
  provider: MetaProvider,
  checkedAt: string,
): Promise<HealthCheck> {
  if (!credentials.pageId) {
    return awaiting(
      'meta.page_ig',
      'Es ist keine Facebook-Seite ausgewählt. Ohne Seite kann kein Creative angelegt werden.',
      'META_PAGE_ID hinterlegen bzw. im Assistenten eine Seite auswählen.',
      checkedAt,
    );
  }
  try {
    const [pages, actors] = await Promise.all([
      provider.listPages(),
      provider.listInstagramActors(),
    ]);
    const page = pages.find((entry) => entry.externalId === credentials.pageId);
    if (!page) {
      return check(
        'meta.page_ig',
        'FAIL',
        `Die konfigurierte Seite ${credentials.pageId} ist mit diesem Zugang nicht sichtbar.`,
        'Seitenrolle im Business-Manager prüfen.',
        checkedAt,
      );
    }
    if (!credentials.instagramActorId) {
      return check(
        'meta.page_ig',
        'WARN',
        `Seite „${page.name}" verbunden; es ist kein Instagram-Konto ausgewählt. Instagram-Platzierungen sind dann nicht verfügbar.`,
        'Instagram-Konto im Assistenten auswählen, falls Instagram-Platzierungen genutzt werden sollen.',
        checkedAt,
        true,
      );
    }
    const actor = actors.find((entry) => entry.externalId === credentials.instagramActorId);
    return check(
      'meta.page_ig',
      actor ? 'PASS' : 'WARN',
      actor
        ? `Seite „${page.name}" und Instagram-Konto „${actor.username ?? actor.externalId}".`
        : `Seite „${page.name}" verbunden; das konfigurierte Instagram-Konto ist nicht sichtbar.`,
      actor ? null : 'Instagram-Konto erneut mit dem Werbekonto verknüpfen.',
      checkedAt,
      true,
    );
  } catch (error) {
    return failureFrom('meta.page_ig', error, 'Seitenberechtigungen prüfen.', checkedAt, true);
  }
}

export async function probePixelAndDataset(
  credentials: MetaCredentials,
  provider: MetaProvider,
  checkedAt: string,
): Promise<HealthCheck> {
  if (!credentials.pixelId) {
    return awaiting(
      'meta.pixel_dataset',
      'Es ist kein Pixel ausgewählt. Ohne Pixel gibt es keine Conversion-Optimierung und keinen CAPI-Versand.',
      'META_PIXEL_ID hinterlegen bzw. im Assistenten ein Pixel auswählen.',
      checkedAt,
    );
  }
  try {
    const pixels = await provider.listPixels();
    const pixel = pixels.find((entry) => entry.externalId === credentials.pixelId);
    if (!pixel) {
      return check(
        'meta.pixel_dataset',
        'FAIL',
        `Das konfigurierte Pixel ${credentials.pixelId} gehört nicht zu diesem Werbekonto.`,
        'Pixel dem Werbekonto zuordnen oder ein anderes Pixel auswählen.',
        checkedAt,
        true,
      );
    }
    const datasetNote = credentials.datasetId
      ? ` Dataset ${credentials.datasetId} für Down-Funnel-Ereignisse konfiguriert.`
      : ' Es ist kein separates Dataset konfiguriert; Down-Funnel-Ereignisse laufen über das Pixel.';
    return check(
      'meta.pixel_dataset',
      'PASS',
      `Pixel „${pixel.name}"${pixel.lastFiredAt ? `, zuletzt ausgelöst am ${pixel.lastFiredAt.slice(0, 10)}` : ''}.${datasetNote}`,
      null,
      checkedAt,
      true,
    );
  } catch (error) {
    return failureFrom('meta.pixel_dataset', error, 'Pixel-Berechtigungen prüfen.', checkedAt, true);
  }
}

export async function probePermissions(
  credentials: MetaCredentials,
  provider: MetaProvider,
  checkedAt: string,
): Promise<HealthCheck> {
  if (provider.mode === 'FIXTURE' || !credentials.accessToken) {
    return awaiting(
      'meta.permissions',
      `Die tatsächlich erteilten Berechtigungen sind unbekannt. Benötigt werden: ${REQUIRED_META_SCOPES.join(', ')}.`,
      'Meta-App verbinden; die erteilten Berechtigungen werden danach hier angezeigt.',
      checkedAt,
    );
  }
  try {
    // A write-capable read: listing ad sets requires `ads_read`/`ads_management`.
    await provider.importAdSets({ limit: 1 });
    return check(
      'meta.permissions',
      'PASS',
      `Lesezugriff auf Kampagnenstrukturen bestätigt. Benötigte Berechtigungen: ${REQUIRED_META_SCOPES.join(', ')}.`,
      null,
      checkedAt,
    );
  } catch (error) {
    return failureFrom(
      'meta.permissions',
      error,
      `Fehlende Berechtigungen im Business-Manager ergänzen: ${REQUIRED_META_SCOPES.join(', ')}.`,
      checkedAt,
    );
  }
}

export async function probeInsightsRead(
  provider: MetaProvider,
  checkedAt: string,
  now: string,
): Promise<HealthCheck> {
  try {
    const until = now.slice(0, 10);
    const sinceDate = new Date(now);
    sinceDate.setUTCDate(sinceDate.getUTCDate() - 7);
    const page = await provider.fetchInsightsDaily({
      level: 'campaign',
      since: sinceDate.toISOString().slice(0, 10),
      until,
      limit: 5,
    });
    return check(
      'meta.insights_read',
      'PASS',
      `Insights lesbar: ${page.items.length} Zeile(n) für die letzten sieben Tage.`,
      null,
      checkedAt,
    );
  } catch (error) {
    return failureFrom(
      'meta.insights_read',
      error,
      'Berechtigung ads_read prüfen und den Zeitraum eingrenzen.',
      checkedAt,
    );
  }
}

/**
 * The draft test never creates anything. It builds a real plan and reports the
 * dry-run preview, so the operator can see the exact payload before enabling
 * writes; with writes enabled it reports that a real draft *would* be created,
 * still without creating one.
 */
export function probeDraftTest(
  credentials: MetaCredentials,
  flags: FeatureFlags,
  checkedAt: string,
  now: string,
): HealthCheck {
  if (!credentials.adAccountId || !credentials.pageId || !credentials.pixelId) {
    return awaiting(
      'meta.draft_test',
      'Für den Testentwurf fehlen Werbekonto, Seite oder Pixel.',
      'Werbekonto, Seite und Pixel im Assistenten auswählen.',
      checkedAt,
    );
  }

  try {
    const plan = buildDraftPlan({
      idempotencyKey: `healthcheck-${now.slice(0, 10)}`,
      apiVersion: credentials.apiVersion,
      adAccountId: credentials.adAccountId,
      currency: 'EUR',
      now,
      campaign: { name: 'Health-Check Entwurf', objective: 'OUTCOME_LEADS', dailyBudgetMinor: null },
      adSets: [
        {
          key: 'as_1',
          name: 'Health-Check Ad-Set',
          dailyBudgetMinor: 1_000,
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          targeting: { countries: ['DE'] },
          startTime: now,
        },
      ],
      creatives: [
        {
          key: 'cr_1',
          name: 'Health-Check Creative',
          primaryText: 'Prüfung der Meta-Anbindung – dieser Entwurf wird nicht ausgeliefert.',
          headline: 'Health-Check',
          callToAction: 'LEARN_MORE',
          imageHash: 'healthcheck',
        },
      ],
      ads: [{ key: 'ad_1', name: 'Health-Check Ad', adSetKey: 'as_1', creativeKey: 'cr_1' }],
      tracking: {
        pixelId: credentials.pixelId,
        pageId: credentials.pageId,
        instagramActorId: credentials.instagramActorId,
        destinationBaseUrl: 'https://example.de/health-check',
        launchToken: 'healthcheck-token',
        utm: { campaign: 'health-check' },
      },
    });

    const requestCount = (draftPlanPreview(plan).requests as unknown[]).length;
    return check(
      'meta.draft_test',
      canWriteMeta(flags) ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      canWriteMeta(flags)
        ? `Entwurfsplan gültig (${requestCount} Anfragen, alle Objekte pausiert). Es wurde nichts angelegt.`
        : `Entwurfsplan gültig (${requestCount} Anfragen, alle Objekte pausiert). Meta-Schreibzugriffe sind deaktiviert – es wurde nichts angelegt.`,
      canWriteMeta(flags)
        ? null
        : 'EXTERNAL_WRITES_ENABLED und META_MUTATIONS_ENABLED aktivieren, um Entwürfe tatsächlich anzulegen.',
      checkedAt,
      true,
    );
  } catch (error) {
    return failureFrom(
      'meta.draft_test',
      error,
      'Kampagnen-, Ad-Set- und Creative-Angaben im Assistenten prüfen.',
      checkedAt,
      true,
    );
  }
}

/**
 * The CAPI test builds a real, fully hashed event pair and reports its redacted
 * shape. Nothing is dispatched — that stays gated behind the CAPI flag.
 */
export async function probeCapiTest(
  credentials: MetaCredentials,
  flags: FeatureFlags,
  checkedAt: string,
  now: string,
): Promise<HealthCheck> {
  const destination = credentials.datasetId ?? credentials.pixelId;
  if (!destination) {
    return awaiting(
      'meta.capi_test',
      'Für den Conversions-API-Test fehlt Pixel oder Dataset.',
      'META_PIXEL_ID bzw. META_DATASET_ID hinterlegen.',
      checkedAt,
    );
  }

  try {
    const pair = await buildInitialLeadEvent({
      submissionId: '00000000-0000-4000-8000-000000000000',
      pixelId: destination,
      occurredAt: now,
      eventSourceUrl: 'https://example.de/health-check',
      identity: { email: 'health.check@example.de', country: 'de' },
      consent: { adMeasurement: false },
    });

    const dedupOk = pair.pixel.eventID === pair.server.event_id;
    return check(
      'meta.capi_test',
      canDispatchCapi(flags) ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      `Ereignis „${pair.eventName}" erzeugt, Pixel und Server teilen dieselbe event_id (${dedupOk ? 'Deduplizierung möglich' : 'Abweichung!'}). Redigierte Vorschau: ${JSON.stringify(redactCapiPayload(pair.server))}. ${
        canDispatchCapi(flags)
          ? 'Der Versand ist aktiviert.'
          : 'Der Versand ist deaktiviert – es wurde nichts gesendet.'
      }`,
      canDispatchCapi(flags)
        ? null
        : 'EXTERNAL_WRITES_ENABLED und META_CAPI_ENABLED aktivieren, um Ereignisse tatsächlich zu senden.',
      checkedAt,
      true,
    );
  } catch (error) {
    return failureFrom(
      'meta.capi_test',
      error,
      'Pixel-/Dataset-Konfiguration und Einwilligungseinstellungen prüfen.',
      checkedAt,
      true,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Composite                                                                   */
/* -------------------------------------------------------------------------- */

export interface MetaHealthInput {
  provider: MetaProvider;
  credentials: MetaCredentials;
  flags: FeatureFlags;
  now?: string;
}

/**
 * Runs every probe and aggregates. `rollUpHealth` guarantees that
 * `AWAITING_EXTERNAL_INPUT` never masks a real `FAIL` and never gets upgraded
 * to `PASS`.
 */
export async function runMetaHealthChecks(input: MetaHealthInput): Promise<ProviderHealth> {
  const now = input.now ?? nowIso();
  const checkedAt = now;
  const { provider, credentials, flags } = input;

  const checks: HealthCheck[] = [
    await probeAppConnection(credentials, provider, checkedAt),
    await probeBusiness(credentials, checkedAt),
    await probeAdAccount(credentials, provider, checkedAt),
    await probePageAndInstagram(credentials, provider, checkedAt),
    await probePixelAndDataset(credentials, provider, checkedAt),
    await probePermissions(credentials, provider, checkedAt),
    await probeInsightsRead(provider, checkedAt, now),
    probeDraftTest(credentials, flags, checkedAt, now),
    await probeCapiTest(credentials, flags, checkedAt, now),
  ];

  const overall = rollUpHealth(checks);

  return {
    provider: 'META',
    // A fixture provider is never reported as connected, whatever the probes say.
    state:
      provider.mode === 'FIXTURE'
        ? 'FIXTURE'
        : overall === 'PASS'
          ? 'CONNECTED'
          : overall === 'FAIL'
            ? 'ERROR'
            : 'DEGRADED',
    overall,
    checks,
    checkedAt,
  };
}
