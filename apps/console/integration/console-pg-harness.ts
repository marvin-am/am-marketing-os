import { createSupabaseDatabase, type AmDatabase, type DbClient } from '@am/db';
import {
  DATABASE_URL,
  setupDatabase,
  type Harness,
  type PgClient,
} from '../../../supabase/tests/harness';
import { createPgDbClient } from './postgrest-over-pg';

/**
 * A scratch Postgres plus the real `AmDatabase` on top of it.
 *
 * `supabase/tests/harness.ts` provisions an isolated database per file and drops
 * it afterwards; this adds the console's half — the repositories the ports
 * actually call, bound to that scratch database rather than to the shared one
 * other work is using.
 */
export interface ConsoleHarness {
  harness: Harness;
  /** Direct SQL, for asserting a port's number against what the table holds. */
  sql: PgClient;
  db: AmDatabase;
  teardown(): Promise<void>;
}

/**
 * Deliberately not the seeded workspace's id. Passing it as the port's fallback
 * proves the port resolved the workspace from the database rather than from the
 * constant it was handed.
 */
export const UNSEEDED_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

export async function setupConsoleDatabase(
  label: string,
  options: { applySeed?: boolean } = {},
): Promise<ConsoleHarness> {
  const harness = await setupDatabase(label, options);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${harness.databaseName}`;

  const backed = await createPgDbClient(url.toString());
  const db = createSupabaseDatabase(backed.client as DbClient);

  return {
    harness,
    sql: harness.admin,
    db,
    async teardown() {
      await backed.close().catch(() => undefined);
      await harness.teardown();
    },
  };
}
