import { z } from 'zod';

/**
 * Environment parsing.
 *
 * Two schemas on purpose: `publicEnvSchema` covers everything that may reach the
 * browser, `serverEnvSchema` covers secrets. `getServerConfig()` throws if
 * called in a browser context, which is what keeps the service role key from
 * ever being bundled into client code.
 */

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value));

const intFromEnv = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const csvList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: optionalString,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalString,
  NEXT_PUBLIC_CONSOLE_URL: z.string().default('http://localhost:3000'),
  NEXT_PUBLIC_FUNNEL_URL: z.string().default('http://localhost:3001'),
  APP_ENVIRONMENT: z
    .enum(['production', 'preview', 'development', 'test'])
    .default('development'),
});

export const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  DATABASE_URL: optionalString,

  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_TEXT_MODEL: z.string().default('gpt-5.6-sol'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),

  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_ACCESS_TOKEN: optionalString,
  META_VERIFY_TOKEN: optionalString,
  META_AD_ACCOUNT_ID: optionalString,
  META_PAGE_ID: optionalString,
  META_INSTAGRAM_ACTOR_ID: optionalString,
  META_PIXEL_ID: optionalString,
  META_DATASET_ID: optionalString,
  META_API_VERSION: z.string().default('v23.0'),

  HUBSPOT_CLIENT_ID: optionalString,
  HUBSPOT_CLIENT_SECRET: optionalString,
  HUBSPOT_REDIRECT_URI: optionalString,
  HUBSPOT_WEBHOOK_SECRET: optionalString,
  HUBSPOT_PRIVATE_APP_TOKEN: optionalString,

  APP_ENCRYPTION_KEY: optionalString,
  TRACKING_SIGNING_SECRET: optionalString,
  CRON_SECRET: optionalString,

  AUTH_ALLOWLIST: csvList,
  REDIRECT_ALLOWLIST: csvList,

  DEMO_MODE: boolFromEnv.default(true),
  EXTERNAL_WRITES_ENABLED: boolFromEnv.default(false),
  META_MUTATIONS_ENABLED: boolFromEnv.default(false),
  META_CAPI_ENABLED: boolFromEnv.default(false),
  HUBSPOT_WRITES_ENABLED: boolFromEnv.default(false),

  ATTRIBUTION_WINDOW_DAYS: intFromEnv(30),
  FORM_ABANDON_MINUTES: intFromEnv(30),
  HISTORICAL_IMPORT_MONTHS: intFromEnv(24),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * `process.env` access is deliberately funnelled through here. Next.js inlines
 * `process.env.NEXT_PUBLIC_*` at build time only for statically written member
 * expressions, so the public keys are read literally.
 */
function readPublicEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_CONSOLE_URL: process.env.NEXT_PUBLIC_CONSOLE_URL,
    NEXT_PUBLIC_FUNNEL_URL: process.env.NEXT_PUBLIC_FUNNEL_URL,
    APP_ENVIRONMENT: process.env.APP_ENVIRONMENT,
  };
}

let cachedPublic: PublicEnv | null = null;
let cachedServer: ServerEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cachedPublic) return cachedPublic;
  const parsed = publicEnvSchema.safeParse(readPublicEnv());
  if (!parsed.success) {
    throw new Error(
      `Ungültige öffentliche Umgebungskonfiguration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  cachedPublic = parsed.data;
  return cachedPublic;
}

export function getServerEnv(): ServerEnv {
  if (cachedServer) return cachedServer;
  if (typeof window !== 'undefined') {
    throw new Error('Serverkonfiguration darf nicht im Browser gelesen werden.');
  }
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Ungültige Server-Umgebungskonfiguration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  cachedServer = parsed.data;
  return cachedServer;
}

/** Test seam: forget memoised configuration. */
export function resetConfigCache(): void {
  cachedPublic = null;
  cachedServer = null;
}
