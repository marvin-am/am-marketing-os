/**
 * `@am/db` — schema access for the A&M Marketing OS.
 *
 * Two implementations behind one interface:
 *
 *   createSupabaseDatabase(client)  → real Postgres, RLS applies
 *   createMemoryDatabase()          → DEMO_MODE and unit tests, no database
 *
 * Pick one at the edge (`resolveDatabase()`), never inline in feature code.
 */
export * from './types';
export * from './client';
export * from './errors';
export * from './crypto';
export * from './outbox';
export * from './sql';
export * from './repositories';
export * from './memory-db';

import { createAdminDbClient, createAnonServerDbClient, createServerDbClient, isDatabaseConfigured, type CookieAdapter } from './client';
import { createMemoryDatabase, type MemoryDatabase } from './memory-db';
import { createSupabaseDatabase, type AmDatabase } from './repositories';

/**
 * The DEMO_MODE store.
 *
 * A module-level singleton on purpose: a Next.js server action and the route
 * handler next to it must see the same demo data, and a fresh store per request
 * would make the demo forget every lead the moment the page navigated.
 */
let demoDatabase: MemoryDatabase | null = null;

export function getDemoDatabase(): MemoryDatabase {
  demoDatabase ??= createMemoryDatabase();
  return demoDatabase;
}

/** Test seam: forget the demo store. */
export function resetDemoDatabase(): void {
  demoDatabase = null;
}

export interface ResolveDatabaseOptions {
  /** Request cookies, when the caller wants the signed-in user's RLS context. */
  cookies?: CookieAdapter;
  /** Bypass RLS. Server only, and only for jobs and imports. */
  admin?: boolean;
  /** Force the in-memory store regardless of configuration (DEMO_MODE). */
  demo?: boolean;
}

export interface ResolvedDatabase {
  db: AmDatabase;
  /** `'memory'` means nothing is persisted — the console must say so. */
  mode: 'supabase' | 'memory';
}

/**
 * The single decision point for which storage a caller talks to.
 *
 * Falls back to the in-memory store when Supabase is not configured rather than
 * throwing, so `DEMO_MODE=true` genuinely runs the whole product with no
 * database — and reports `mode: 'memory'` so no surface can pretend otherwise.
 */
export function resolveDatabase(options: ResolveDatabaseOptions = {}): ResolvedDatabase {
  if (options.demo || !isDatabaseConfigured()) {
    return { db: getDemoDatabase(), mode: 'memory' };
  }

  const client = options.admin
    ? createAdminDbClient()
    : options.cookies
      ? createServerDbClient(options.cookies)
      : createAnonServerDbClient();

  if (!client) return { db: getDemoDatabase(), mode: 'memory' };
  return { db: createSupabaseDatabase(client), mode: 'supabase' };
}
