import { getFeatureFlags, getServerEnv, resolveProviderMode, type ProviderMode } from '@am/config';
import { DomainError, type FeatureFlags, type IsoTimestamp } from '@am/domain';
import { FixtureHubspotProvider, type FixtureSeed } from './provider-fixture';
import { LiveHubspotProvider } from './provider-live';
import type { HubspotProvider } from './provider';

/**
 * The single point where fixture and live are chosen (AGENTS.md, "Fixtures and
 * demo mode"). Feature code asks the factory for a provider and never inspects
 * `DEMO_MODE` or a credential itself.
 */

export interface CreateHubspotProviderOptions {
  /** Overrides the resolved mode. Used by tests and the demo seed. */
  mode?: ProviderMode;
  flags?: FeatureFlags;
  token?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  clock?: () => IsoTimestamp;
  seed?: FixtureSeed;
}

export function resolveHubspotProviderMode(): ProviderMode {
  return resolveProviderMode('HUBSPOT');
}

/** Reads the token without ever logging it. Returns `null` when unset. */
export function getHubspotToken(): string | null {
  if (typeof window !== 'undefined') return null;
  return getServerEnv().HUBSPOT_PRIVATE_APP_TOKEN;
}

export function createHubspotProvider(
  options: CreateHubspotProviderOptions = {},
): HubspotProvider {
  const flags = options.flags ?? getFeatureFlags();
  const mode = options.mode ?? resolveHubspotProviderMode();

  if (mode === 'FIXTURE') {
    return new FixtureHubspotProvider({
      flags,
      clock: options.clock,
      seed: options.seed,
    });
  }

  const token = options.token ?? getHubspotToken();
  if (!token) {
    throw new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe:
        'HubSpot ist als Live-Integration ausgewählt, es ist aber kein Token hinterlegt. Bitte HUBSPOT_PRIVATE_APP_TOKEN setzen.',
      details: { provider: 'HUBSPOT' },
    });
  }

  return new LiveHubspotProvider({
    token,
    flags,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
    clock: options.clock,
  });
}
