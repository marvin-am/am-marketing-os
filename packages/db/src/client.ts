/**
 * Supabase client factories.
 *
 * Three clients, three trust levels:
 *
 *   `createBrowserDbClient()`  anon key, runs in the browser, sees exactly one
 *                              table (`published_funnels`) plus the six funnel
 *                              runtime RPCs.
 *   `createServerDbClient()`   anon key + the signed-in user's cookies. RLS
 *                              applies, so the console can only ever read what
 *                              the operator is a member of.
 *   `createAdminDbClient()`    service role. Bypasses RLS, therefore refuses to
 *                              exist in a browser.
 *
 * Every factory returns `null` when Supabase is not configured, so DEMO_MODE
 * runs the whole product against `createMemoryDatabase()` without a database.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { getPublicEnv, getServerEnv } from '@am/config';
import { DomainError } from '@am/domain';

/**
 * The client type used across the package. The schema generic is left at its
 * default: there are no generated types in this repo, the row shapes are
 * hand-written in `types.ts` and applied at each repository boundary.
 */
export type DbClient = SupabaseClient;

export interface CookieRecord {
  name: string;
  value: string;
}

export interface CookieWriteRecord extends CookieRecord {
  options?: Record<string, unknown>;
}

/** Cookie access supplied by the host framework (Next.js `cookies()`). */
export interface CookieAdapter {
  getAll(): CookieRecord[] | Promise<CookieRecord[]>;
  /**
   * Optional: server components cannot set cookies. Omitting it is supported and
   * expected in read-only render paths.
   */
  setAll?(cookies: CookieWriteRecord[]): void | Promise<void>;
}

export interface SupabaseCredentials {
  url: string;
  anonKey: string;
  serviceRoleKey: string | null;
}

/** Reads the public Supabase credentials. Returns `null` when unset. */
export function readSupabaseCredentials(): SupabaseCredentials | null {
  const pub = getPublicEnv();
  if (!pub.NEXT_PUBLIC_SUPABASE_URL || !pub.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;

  const serviceRoleKey =
    typeof window === 'undefined' ? (getServerEnv().SUPABASE_SERVICE_ROLE_KEY ?? null) : null;

  return {
    url: pub.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: pub.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey,
  };
}

/** True when a browser/server client can be built at all. */
export function isDatabaseConfigured(): boolean {
  return readSupabaseCredentials() !== null;
}

/** True when the service role client can be built (server only). */
export function isAdminDatabaseConfigured(): boolean {
  if (typeof window !== 'undefined') return false;
  const credentials = readSupabaseCredentials();
  return credentials !== null && credentials.serviceRoleKey !== null;
}

const NO_OP_COOKIES = {
  getAll: () => [],
};

/* -------------------------------------------------------------------------- */
/* Browser                                                                     */
/* -------------------------------------------------------------------------- */

let browserClient: DbClient | null = null;

/**
 * Browser client. Memoised: `@supabase/ssr` keeps auth state on the instance and
 * a second instance produces duplicate token refreshes.
 */
export function createBrowserDbClient(): DbClient | null {
  const credentials = readSupabaseCredentials();
  if (!credentials) return null;
  if (browserClient) return browserClient;

  browserClient = createBrowserClient(credentials.url, credentials.anonKey);
  return browserClient;
}

/** Test seam: drop the memoised browser client. */
export function resetBrowserDbClient(): void {
  browserClient = null;
}

/* -------------------------------------------------------------------------- */
/* Server component / route handler                                            */
/* -------------------------------------------------------------------------- */

/**
 * Server client bound to the request's cookies, so RLS sees the signed-in user.
 * Never memoised — one client per request, or two users share a session.
 */
export function createServerDbClient(cookies: CookieAdapter): DbClient | null {
  if (typeof window !== 'undefined') {
    throw new DomainError('FORBIDDEN', {
      messageDe: 'Der Server-Client darf nicht im Browser erzeugt werden.',
      details: { factory: 'createServerDbClient' },
    });
  }

  const credentials = readSupabaseCredentials();
  if (!credentials) return null;

  return createServerClient(credentials.url, credentials.anonKey, {
    cookies: {
      getAll: () => cookies.getAll(),
      setAll: cookies.setAll
        ? (list) =>
            cookies.setAll?.(
              list.map((entry) => ({
                name: entry.name,
                value: entry.value,
                options: entry.options as Record<string, unknown>,
              })),
            )
        : undefined,
    },
  });
}

/**
 * Anonymous server client — no user session. Used by the public funnel runtime's
 * route handlers, which call the SECURITY DEFINER RPCs and nothing else.
 */
export function createAnonServerDbClient(): DbClient | null {
  const credentials = readSupabaseCredentials();
  if (!credentials) return null;

  return createServerClient(credentials.url, credentials.anonKey, {
    cookies: NO_OP_COOKIES,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* -------------------------------------------------------------------------- */
/* Service role                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Service-role client. Bypasses RLS entirely, which is why it throws rather than
 * returns `null` when reached from a browser: a `null` would be a silent
 * fallback where the only correct outcome is a loud failure.
 */
export function createAdminDbClient(): DbClient | null {
  if (typeof window !== 'undefined') {
    throw new DomainError('FORBIDDEN', {
      messageDe:
        'Der Service-Role-Client darf niemals im Browser verwendet werden. ' +
        'Verschieben Sie den Aufruf in eine Server Action oder einen Route Handler.',
      details: { factory: 'createAdminDbClient' },
    });
  }

  const credentials = readSupabaseCredentials();
  if (!credentials || !credentials.serviceRoleKey) return null;

  return createClient(credentials.url, credentials.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'X-Client-Info': 'am-marketing-os/db' } },
  });
}

/** Same, but throws with a German message instead of returning `null`. */
export function requireAdminDbClient(): DbClient {
  const client = createAdminDbClient();
  if (!client) {
    throw new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe:
        'SUPABASE_SERVICE_ROLE_KEY und NEXT_PUBLIC_SUPABASE_URL sind nicht gesetzt. ' +
        'Ohne sie ist kein administrativer Datenbankzugriff möglich.',
      details: { provider: 'SUPABASE' },
    });
  }
  return client;
}
