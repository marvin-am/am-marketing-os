/**
 * Postgres harness for the schema integration tests.
 *
 * These tests are opt-in: with `DATABASE_URL` unset they skip cleanly and say
 * so, so `pnpm test` stays green on a machine with no database (AGENTS.md).
 *
 * With `DATABASE_URL` set, each test file provisions its own scratch database,
 * applies every migration into it and drops it again afterwards. Nothing is
 * written to the database the URL points at, so pointing this at a local
 * Supabase instance is safe.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `pg` is a devDependency of @am/db, not of the repo root; resolve it from there
// rather than adding a root dependency for a test-only driver.
const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config: { connectionString: string }) => PgClient;
}

const pg = require('pg') as PgModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
export const SEED_FILE = join(HERE, '..', 'seed', 'seed.sql');

/**
 * Supabase compatibility shim.
 *
 * A scratch Postgres has no `auth` schema, no `auth.uid()`, no `storage.buckets`
 * and none of the API roles, so the migrations would fail and `set local role
 * authenticated` would be meaningless. The shim also hands `anon` and
 * `authenticated` the table privileges Supabase grants them — which matters:
 * without it an RLS test would pass because of a missing GRANT rather than
 * because of the policy, and that is the one way an RLS test must not pass.
 */
const BOOTSTRAP_FILE = join(HERE, '..', '..', 'scripts', 'local-pg-bootstrap.sql');

export const DATABASE_URL = process.env.DATABASE_URL ?? '';

/**
 * These suites do not merely read: `setupDatabase` issues `create database` and
 * `drop database` on the server the URL points at. That is harmless against a
 * throwaway Postgres and emphatically not harmless against the project in a
 * developer's `.env.local`, which — once real credentials exist — is the
 * production Supabase instance. Running `pnpm test` should never be able to
 * create databases in production, so a remote host has to be opted into
 * deliberately rather than inherited from whatever happens to be in the
 * environment.
 */
function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

const ALLOW_REMOTE = process.env.ALLOW_REMOTE_TEST_DATABASE === 'true';
const REMOTE_REFUSED = DATABASE_URL.length > 0 && !isLocalHost(DATABASE_URL) && !ALLOW_REMOTE;

export const HAS_DATABASE = DATABASE_URL.length > 0 && !REMOTE_REFUSED;

/** Printed once per skipped file so a green run is not mistaken for coverage. */
export function announceSkip(fileLabel: string): void {
  if (REMOTE_REFUSED) {
    console.warn(
      `[skip] ${fileLabel}: DATABASE_URL zeigt auf einen entfernten Host. Diese Tests legen ` +
        `Datenbanken an und löschen sie wieder — gegen ein produktives Projekt wäre das ein Schaden. ` +
        `Setzen Sie DATABASE_URL auf eine lokale Instanz, oder ALLOW_REMOTE_TEST_DATABASE=true, ` +
        `wenn der Host wirklich eine Wegwerf-Instanz ist.`,
    );
    return;
  }
  console.warn(
    `[skip] ${fileLabel}: DATABASE_URL ist nicht gesetzt — die Postgres-Integrationstests werden übersprungen. ` +
      `Setzen Sie DATABASE_URL auf eine erreichbare Postgres-Instanz, um sie auszuführen.`,
  );
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(MIGRATIONS_DIR, name));
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface Harness {
  /** A connection to the scratch database, as the owner (bypasses RLS). */
  admin: PgClient;
  /** Opens another connection — needed to observe real concurrency. */
  open(): Promise<PgClient>;
  /** Runs `fn` with the session acting as `authenticated` for one profile. */
  asUser<T>(profileId: string, fn: (client: PgClient) => Promise<T>): Promise<T>;
  /** Runs `fn` with the session acting as the public `anon` role. */
  asAnon<T>(fn: (client: PgClient) => Promise<T>): Promise<T>;
  databaseName: string;
  teardown(): Promise<void>;
}

/**
 * Creates a scratch database, applies every migration, and returns handles.
 * `applySeed` additionally loads `supabase/seed/seed.sql` (about 5 MB, so only
 * the tests that need it ask for it).
 */
export async function setupDatabase(label: string, options: { applySeed?: boolean } = {}): Promise<Harness> {
  const databaseName = `am_it_${label}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  const maintenance = new pg.Client({ connectionString: DATABASE_URL });
  await maintenance.connect();
  await maintenance.query(`create database ${databaseName}`);
  await maintenance.end();

  const url = withDatabase(DATABASE_URL, databaseName);
  const open = async (): Promise<PgClient> => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  };

  const admin = await open();
  await admin.query(readFileSync(BOOTSTRAP_FILE, 'utf8'));
  for (const file of migrationFiles()) {
    await admin.query(readFileSync(file, 'utf8'));
  }
  if (options.applySeed) {
    await admin.query(readFileSync(SEED_FILE, 'utf8'));
  }

  const asRole = async <T>(
    role: string,
    profileId: string | null,
    fn: (client: PgClient) => Promise<T>,
  ): Promise<T> => {
    const client = await open();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      if (profileId) await client.query(`set local request.jwt.claim.sub = '${profileId}'`);
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  };

  return {
    admin,
    open,
    databaseName,
    asUser: (profileId, fn) => asRole('authenticated', profileId, fn),
    asAnon: (fn) => asRole('anon', null, fn),
    async teardown() {
      await admin.end().catch(() => undefined);
      const cleanup = new pg.Client({ connectionString: DATABASE_URL });
      await cleanup.connect();
      await cleanup.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [databaseName],
      );
      await cleanup.query(`drop database if exists ${databaseName}`);
      await cleanup.end();
    },
  };
}

/**
 * Seeds `auth.users` rows so `public.profiles` can reference them.
 *
 * `0002_core.sql` only adds the foreign key when `auth.users` exists, so this is
 * a no-op on an instance without the Supabase shim — the test then exercises the
 * same schema minus a constraint that is not there to exercise.
 */
export async function seedAuthUsers(
  client: PgClient,
  users: readonly { id: string; email: string }[],
): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regclass('auth.users') is not null as present`,
  );
  if (!rows[0]?.present) return;
  for (const user of users) {
    await client.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [user.id, user.email],
    );
  }
}

/** Asserts that `fn` fails with the given SQLSTATE. */
export async function expectSqlState(
  fn: () => Promise<unknown>,
  code: string,
): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err.code !== code) {
      throw new Error(`Expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    }
    return { code: err.code, message: err.message ?? '' };
  }
  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded.`);
}
