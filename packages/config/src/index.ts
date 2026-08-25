import type { AppEnvironment, FeatureFlags, Provider } from '@am/domain';
import { SAFE_DEFAULT_FLAGS } from '@am/domain';
import { getPublicEnv, getServerEnv, resetConfigCache } from './env';

export * from './env';

/* -------------------------------------------------------------------------- */
/* Feature flags                                                               */
/* -------------------------------------------------------------------------- */

export function getFeatureFlags(): FeatureFlags {
  if (typeof window !== 'undefined') {
    // The browser never decides whether an external write is allowed.
    return SAFE_DEFAULT_FLAGS;
  }
  const env = getServerEnv();
  return {
    demoMode: env.DEMO_MODE,
    externalWritesEnabled: env.EXTERNAL_WRITES_ENABLED,
    metaMutationsEnabled: env.META_MUTATIONS_ENABLED,
    metaCapiEnabled: env.META_CAPI_ENABLED,
    hubspotWritesEnabled: env.HUBSPOT_WRITES_ENABLED,
  };
}

/* -------------------------------------------------------------------------- */
/* Provider selection                                                          */
/* -------------------------------------------------------------------------- */

export type ProviderMode = 'FIXTURE' | 'LIVE';

/**
 * Single decision point for fixture vs. live. Demo mode always wins, and a
 * provider whose credentials are absent falls back to fixtures rather than
 * failing at call time with a confusing auth error.
 */
export function resolveProviderMode(provider: Provider): ProviderMode {
  if (typeof window !== 'undefined') return 'FIXTURE';
  const env = getServerEnv();
  if (env.DEMO_MODE) return 'FIXTURE';

  switch (provider) {
    case 'META':
      return env.META_ACCESS_TOKEN && env.META_AD_ACCOUNT_ID ? 'LIVE' : 'FIXTURE';
    case 'HUBSPOT':
      return env.HUBSPOT_PRIVATE_APP_TOKEN || env.HUBSPOT_CLIENT_ID ? 'LIVE' : 'FIXTURE';
    case 'OPENAI':
      return env.OPENAI_API_KEY ? 'LIVE' : 'FIXTURE';
    case 'SUPABASE':
      return env.SUPABASE_SERVICE_ROLE_KEY ? 'LIVE' : 'FIXTURE';
    default:
      return 'FIXTURE';
  }
}

export function isProviderConfigured(provider: Provider): boolean {
  if (typeof window !== 'undefined') return false;
  const env = getServerEnv();
  switch (provider) {
    case 'META':
      return Boolean(env.META_ACCESS_TOKEN && env.META_AD_ACCOUNT_ID);
    case 'HUBSPOT':
      return Boolean(env.HUBSPOT_PRIVATE_APP_TOKEN || env.HUBSPOT_CLIENT_ID);
    case 'OPENAI':
      return Boolean(env.OPENAI_API_KEY);
    case 'SUPABASE':
      return Boolean(env.SUPABASE_SERVICE_ROLE_KEY && env.DATABASE_URL);
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Model configuration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Capability-based model configuration (spec §5). Business logic asks for a
 * capability; only this record knows which model serves it.
 */
export interface ModelConfig {
  text: string;
  image: string;
  embedding: string;
  /** Vector width requested from the embedding model. */
  embeddingDimensions: number;
  baseUrl: string | null;
  apiKey: string | null;
}

export function getModelConfig(): ModelConfig {
  const env = getServerEnv();
  return {
    text: env.OPENAI_TEXT_MODEL,
    image: env.OPENAI_IMAGE_MODEL,
    embedding: env.OPENAI_EMBEDDING_MODEL,
    embeddingDimensions: env.OPENAI_EMBEDDING_DIMENSIONS,
    baseUrl: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
  };
}

/* -------------------------------------------------------------------------- */
/* Application configuration                                                   */
/* -------------------------------------------------------------------------- */

export interface AppConfig {
  environment: AppEnvironment;
  consoleUrl: string;
  funnelUrl: string;
  attributionWindowDays: number;
  formAbandonMinutes: number;
  historicalImportMonths: number;
}

export function getAppConfig(): AppConfig {
  const pub = getPublicEnv();
  if (typeof window !== 'undefined') {
    return {
      environment: pub.APP_ENVIRONMENT,
      consoleUrl: pub.NEXT_PUBLIC_CONSOLE_URL,
      funnelUrl: pub.NEXT_PUBLIC_FUNNEL_URL,
      attributionWindowDays: 30,
      formAbandonMinutes: 30,
      historicalImportMonths: 24,
    };
  }
  const env = getServerEnv();
  return {
    environment: pub.APP_ENVIRONMENT,
    consoleUrl: pub.NEXT_PUBLIC_CONSOLE_URL,
    funnelUrl: pub.NEXT_PUBLIC_FUNNEL_URL,
    attributionWindowDays: env.ATTRIBUTION_WINDOW_DAYS,
    formAbandonMinutes: env.FORM_ABANDON_MINUTES,
    historicalImportMonths: env.HISTORICAL_IMPORT_MONTHS,
  };
}

/* -------------------------------------------------------------------------- */
/* Access control                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Console sign-in allowlist. An entry starting with `@` matches a whole domain;
 * anything else must match the full address. An empty allowlist denies everyone
 * rather than allowing everyone — failing closed is the only safe default for an
 * internal tool.
 */
export function isEmailAllowed(email: string, allowlist?: readonly string[]): boolean {
  const list = allowlist ?? (typeof window === 'undefined' ? getServerEnv().AUTH_ALLOWLIST : []);
  if (list.length === 0) return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at < 0) return false;
  const domain = normalized.slice(at);
  return list.some((entry) => (entry.startsWith('@') ? entry === domain : entry === normalized));
}

/** Redirect targets must come from an allowlist (spec §15, §28). */
export function isRedirectAllowed(url: string, allowlist?: readonly string[]): boolean {
  const list =
    allowlist ?? (typeof window === 'undefined' ? getServerEnv().REDIRECT_ALLOWLIST : []);
  if (list.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return false;
  const host = parsed.hostname.toLowerCase();
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export { resetConfigCache };
