/**
 * The single selection point for fixture vs. live.
 *
 * Feature code calls `getMetaProvider()` and never learns which implementation
 * it received. Demo mode always wins, and a provider whose credentials are
 * absent falls back to fixtures rather than failing later with a confusing auth
 * error — `resolveProviderMode` in `@am/config` owns that decision.
 */
import { type ProviderMode, getFeatureFlags, getServerEnv, resolveProviderMode } from '@am/config';
import type { FeatureFlags } from '@am/domain';
import { FixtureMetaProvider, type FixtureProviderOptions } from './fixture-provider';
import { LiveMetaProvider, type LiveProviderOptions } from './live-provider';
import type { MetaProvider } from './provider';
import type { MetaCredentials } from './health';

export function getMetaProviderMode(): ProviderMode {
  return resolveProviderMode('META');
}

export interface MetaProviderOverrides {
  mode?: ProviderMode;
  flags?: FeatureFlags;
  live?: Partial<LiveProviderOptions>;
  fixture?: Partial<FixtureProviderOptions>;
}

/**
 * Reads the Meta credentials from configuration. Never invents a value: an
 * absent variable stays `null` so the health checks can report
 * `AWAITING_EXTERNAL_INPUT` instead of a fabricated id.
 */
export function getMetaCredentials(): MetaCredentials {
  if (typeof window !== 'undefined') {
    return {
      appId: null,
      accessToken: null,
      businessId: null,
      adAccountId: null,
      pageId: null,
      instagramActorId: null,
      pixelId: null,
      datasetId: null,
      apiVersion: 'unbekannt',
    };
  }
  const env = getServerEnv();
  return {
    appId: env.META_APP_ID,
    accessToken: env.META_ACCESS_TOKEN,
    businessId: null,
    adAccountId: env.META_AD_ACCOUNT_ID,
    pageId: env.META_PAGE_ID,
    instagramActorId: env.META_INSTAGRAM_ACTOR_ID,
    pixelId: env.META_PIXEL_ID,
    datasetId: env.META_DATASET_ID,
    apiVersion: env.META_API_VERSION,
  };
}

/**
 * Builds the provider for the current environment. Constructed per call rather
 * than memoised so that a settings change takes effect without a restart, and
 * so tests never share mutable fixture state by accident.
 */
export function createMetaProvider(overrides: MetaProviderOverrides = {}): MetaProvider {
  const flags = overrides.flags ?? getFeatureFlags();
  const mode = overrides.mode ?? getMetaProviderMode();

  if (mode === 'FIXTURE') {
    return new FixtureMetaProvider({ flags, ...overrides.fixture });
  }

  const credentials = getMetaCredentials();
  return new LiveMetaProvider({
    apiVersion: credentials.apiVersion,
    accessToken: credentials.accessToken ?? '',
    adAccountId: credentials.adAccountId ?? '',
    appId: credentials.appId,
    appSecret: typeof window === 'undefined' ? getServerEnv().META_APP_SECRET : null,
    pageId: credentials.pageId,
    instagramActorId: credentials.instagramActorId,
    pixelId: credentials.pixelId,
    datasetId: credentials.datasetId,
    flags,
    ...overrides.live,
  });
}

/** Convenience for the console: provider plus the credentials it was built on. */
export function createMetaContext(overrides: MetaProviderOverrides = {}): {
  provider: MetaProvider;
  credentials: MetaCredentials;
  flags: FeatureFlags;
  mode: ProviderMode;
} {
  const flags = overrides.flags ?? getFeatureFlags();
  const mode = overrides.mode ?? getMetaProviderMode();
  return {
    provider: createMetaProvider({ ...overrides, flags, mode }),
    credentials: getMetaCredentials(),
    flags,
    mode,
  };
}
