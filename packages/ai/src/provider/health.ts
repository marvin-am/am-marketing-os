import { getModelConfig, resolveProviderMode, type ProviderMode } from '@am/config';
import {
  DomainError,
  nowIso,
  rollUpHealth,
  type ConnectionState,
  type HealthCheck,
  type HealthStatus,
  type ProviderHealth,
} from '@am/domain';
import { instrumented } from '@am/observability';
import { getOpenAiClient } from './openai-client';
import { toDomainError } from './retry';

/**
 * OpenAI health probe.
 *
 * A key in the environment is not a connection. This module answers the only
 * question the integrations screen may answer with `CONNECTED`: did OpenAI
 * respond to a request made with the key we hold? The probe is a models
 * listing — a read, free of charge and free of side effects — and everything
 * reported here follows from its outcome. Nothing is inferred from the mere
 * presence of `OPENAI_API_KEY` (AGENTS.md rule 1).
 *
 * The probe runs while the integrations page renders, so it carries its own
 * deadline and never propagates a failure: a provider being unreachable is a
 * reported state, not an exception that blanks the screen.
 */

export const OPENAI_HEALTH_KEYS = [
  'openai.api_key',
  'openai.model_access',
  'openai.budget',
] as const;
export type OpenAiHealthKey = (typeof OPENAI_HEALTH_KEYS)[number];

export const OPENAI_HEALTH_LABELS_DE: Readonly<Record<OpenAiHealthKey, string>> = {
  'openai.api_key': 'Zugang bestätigt',
  'openai.model_access': 'Konfiguriertes Textmodell verfügbar',
  'openai.budget': 'Kostenbegrenzung',
};

/** Default deadline for the probe. It runs on a page render, so it is short. */
export const OPENAI_PROBE_TIMEOUT_MS = 5_000;

/** How many model ids a detail line names before it truncates. */
const MAX_NAMED_MODELS = 3;

/** `HealthCheck.detailDe` is capped at 1000 characters; a provider message is not. */
const MAX_REASON_CHARS = 240;

export interface OpenAiModelListing {
  data: ReadonlyArray<{ id: string }>;
}

/**
 * The slice of the OpenAI client the probe needs. Declared structurally so a
 * test can supply a client that fails deterministically instead of depending on
 * whether the machine running the suite can reach `api.openai.com`.
 */
export interface OpenAiHealthClient {
  models: {
    list(options?: { timeout?: number; signal?: AbortSignal }): Promise<OpenAiModelListing>;
  };
}

export interface OpenAiHealthOptions {
  /** Defaults to the shared client from `getOpenAiClient()`. */
  client?: OpenAiHealthClient;
  /** Overrides the fixture/live decision from `@am/config`. */
  mode?: ProviderMode;
  /** Model id whose availability is asserted. Defaults to the configured text model. */
  modelId?: string;
  timeoutMs?: number;
  now?: string;
}

function check(
  key: OpenAiHealthKey,
  status: HealthStatus,
  detailDe: string,
  remediationDe: string | null,
  checkedAt: string,
  blocksLiveOnly = false,
): HealthCheck {
  return {
    key,
    labelDe: OPENAI_HEALTH_LABELS_DE[key],
    status,
    detailDe,
    checkedAt,
    remediationDe,
    blocksLiveOnly,
  };
}

/**
 * Races `work` against a deadline. The SDK enforces its own per-request timeout,
 * but an injected client need not, and a hung client must not be able to hold a
 * server render open.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DomainError('PROVIDER_ERROR', {
            messageDe: `Zeitüberschreitung: OpenAI hat innerhalb von ${Math.round(timeoutMs / 1000)} Sekunden nicht geantwortet.`,
            details: { operation, timeout_ms: timeoutMs },
            retryable: true,
          }),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fixtureChecks(checkedAt: string): HealthCheck[] {
  return [
    check(
      'openai.api_key',
      'AWAITING_EXTERNAL_INPUT',
      'Es besteht keine Verbindung zu OpenAI. Die Generierung läuft gegen den Fixture-Anbieter.',
      'OPENAI_API_KEY hinterlegen und DEMO_MODE deaktivieren.',
      checkedAt,
      true,
    ),
    check(
      'openai.model_access',
      'AWAITING_EXTERNAL_INPUT',
      'Ohne Verbindung ist unbekannt, welche Modelle für diesen Zugang freigeschaltet sind.',
      'OPENAI_API_KEY hinterlegen; die Modell-Liste wird danach hier geprüft.',
      checkedAt,
      true,
    ),
    check(
      'openai.budget',
      'AWAITING_EXTERNAL_INPUT',
      'Ohne Verbindung entstehen keine Kosten.',
      null,
      checkedAt,
    ),
  ];
}

function budgetCheck(checkedAt: string): HealthCheck {
  // There is no monthly cap in the product yet, so this check never passes on a
  // live connection — it states that fact rather than implying a limit exists.
  return check(
    'openai.budget',
    'WARN',
    'Es ist kein Monatslimit für Generierungskosten hinterlegt.',
    'Monatslimit in den Einstellungen festlegen.',
    checkedAt,
  );
}

/**
 * The concrete reason behind a `DomainError`.
 *
 * `toDomainError` keeps the German summary in `messageDe` and files the
 * transport detail under `details` — but "Der externe Anbieter hat einen Fehler
 * zurückgegeben" tells an operator nothing they can act on, so the status code
 * and the underlying message are carried into the report as well.
 */
function technicalReason(failure: DomainError): string | null {
  const status = failure.details.status;
  const message = failure.details.message;
  const parts: string[] = [];
  if (typeof status === 'number') parts.push(`HTTP ${status}`);
  if (typeof message === 'string' && message.length > 0) parts.push(message);
  else if (failure.cause instanceof Error && failure.cause.message.length > 0) {
    parts.push(failure.cause.message);
  }
  if (parts.length === 0) return null;
  return parts.join(': ').slice(0, MAX_REASON_CHARS);
}

function unreachableChecks(failure: DomainError, checkedAt: string): HealthCheck[] {
  // A rejected key is external input the product cannot supply for itself; a
  // transport failure is a genuine defect. Neither is ever a PASS.
  const rejected = failure.code === 'PROVIDER_NOT_CONFIGURED';
  const reason = technicalReason(failure);
  return [
    check(
      'openai.api_key',
      rejected ? 'AWAITING_EXTERNAL_INPUT' : 'FAIL',
      `Der hinterlegte Schlüssel konnte nicht bestätigt werden: ${failure.messageDe}${reason ? ` (${reason})` : ''}`,
      rejected
        ? 'OPENAI_API_KEY prüfen und gegebenenfalls einen gültigen Schlüssel hinterlegen.'
        : 'Netzwerkzugang zur OpenAI-API prüfen (Proxy, Firewall, OPENAI_BASE_URL) und die Prüfung wiederholen.',
      checkedAt,
      true,
    ),
    check(
      'openai.model_access',
      'AWAITING_EXTERNAL_INPUT',
      'Nicht geprüft: Die Modell-Liste konnte nicht gelesen werden, solange die Verbindung fehlschlägt.',
      'Zuerst die Verbindung herstellen; die Modell-Liste wird dann automatisch mitgeprüft.',
      checkedAt,
      true,
    ),
    budgetCheck(checkedAt),
  ];
}

function modelAccessCheck(
  listing: OpenAiModelListing,
  modelId: string,
  checkedAt: string,
): HealthCheck {
  const ids = listing.data.map((model) => model.id);
  const available = ids.includes(modelId);
  const sample = ids.slice(0, MAX_NAMED_MODELS).join(', ');

  return check(
    'openai.model_access',
    available ? 'PASS' : 'WARN',
    available
      ? `Das konfigurierte Textmodell „${modelId}" ist für diesen Zugang freigeschaltet (${ids.length} Modelle sichtbar). Alle Prompts laufen über validierte JSON-Schemata.`
      : `Das konfigurierte Textmodell „${modelId}" ist in der Modell-Liste dieses Zugangs nicht enthalten (${ids.length} Modelle sichtbar${sample ? `, u. a. ${sample}` : ''}).`,
    available
      ? null
      : 'OPENAI_TEXT_MODEL auf ein für diesen Zugang freigeschaltetes Modell setzen oder das Modell im OpenAI-Konto freischalten.',
    checkedAt,
    true,
  );
}

/**
 * Runs the probe and reports what it found.
 *
 * `state` is deliberately not derived from the roll-up: `overall` describes the
 * health of the integration as a whole (including the missing cost cap, which
 * has nothing to do with reachability), while `state` answers the narrower
 * question of whether a connection exists. `CONNECTED` therefore requires a
 * successful probe and nothing less.
 */
export async function checkOpenAiHealth(
  options: OpenAiHealthOptions = {},
): Promise<ProviderHealth> {
  const checkedAt = options.now ?? nowIso();
  const mode = options.mode ?? resolveProviderMode('OPENAI');

  const report = (state: ConnectionState, checks: HealthCheck[]): ProviderHealth => ({
    provider: 'OPENAI',
    state,
    overall: rollUpHealth(checks),
    checks,
    checkedAt,
  });

  if (mode === 'FIXTURE') {
    return report('FIXTURE', fixtureChecks(checkedAt));
  }

  const timeoutMs = options.timeoutMs ?? OPENAI_PROBE_TIMEOUT_MS;
  let modelId: string;
  let listing: OpenAiModelListing;
  try {
    modelId = options.modelId ?? getModelConfig().text;
    const client = options.client ?? getOpenAiClient();
    listing = await instrumented(
      'OPENAI',
      'openai.health.models_list',
      () =>
        withDeadline(
          Promise.resolve(client.models.list({ timeout: timeoutMs })),
          timeoutMs,
          'openai.health.models_list',
        ),
      (value) => ({ models: value.data.length }),
    );
  } catch (error) {
    return report(
      'ERROR',
      unreachableChecks(toDomainError(error, 'openai.health.models_list'), checkedAt),
    );
  }

  const modelAccess = modelAccessCheck(listing, modelId, checkedAt);
  const checks: HealthCheck[] = [
    check(
      'openai.api_key',
      'PASS',
      `Der hinterlegte Schlüssel wurde von OpenAI akzeptiert; ${listing.data.length} Modell(e) sind für diesen Zugang sichtbar.`,
      null,
      checkedAt,
      true,
    ),
    modelAccess,
    budgetCheck(checkedAt),
  ];

  return report(modelAccess.status === 'PASS' ? 'CONNECTED' : 'DEGRADED', checks);
}
