import { resetConfigCache } from '@am/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_STORAGE_BUCKETS,
  checkSupabaseHealth,
  type SqlProbeConnection,
  type SqlProbeConnector,
} from './health';

/**
 * The claims this probe replaced were the worst kind of fiction: "RLS ist für
 * alle Tabellen aktiv" and "Creative-Bucket vorhanden", both derived from an
 * environment variable being non-empty. So the assertions here are about what
 * the database said — including the cases where it said something bad, and the
 * case where it said nothing at all.
 *
 * The connection is injected throughout. A test that needs a reachable or an
 * unreachable Postgres to make its point must not get that answer from whichever
 * machine happens to run it; `integration/supabase-health.test.ts` covers the
 * real driver against a real schema.
 */

const LIVE = { mode: 'LIVE' as const, connectionString: 'postgresql://probe@localhost:5432/db' };

interface FakeDatabase {
  tables?: Array<{ name: string; rls: boolean }>;
  /** `null` models an instance without a `storage` schema. */
  buckets?: string[] | null;
}

function fakeConnector(
  database: FakeDatabase = {},
  spy?: { closed: number; statements: string[] },
): SqlProbeConnector {
  const tables = database.tables ?? [{ name: 'campaigns', rls: true }];
  const buckets = database.buckets === undefined ? [...REQUIRED_STORAGE_BUCKETS] : database.buckets;

  return () => {
    const connection: SqlProbeConnection = {
      query: async (text: string) => {
        spy?.statements.push(text);
        if (text.includes('current_database')) {
          return {
            rows: [
              {
                database_name: 'am_probe',
                user_name: 'postgres',
                server_version: 'PostgreSQL 16.13 (Ubuntu) on x86_64-pc-linux-gnu',
              },
            ],
          } as never;
        }
        if (text.includes('relrowsecurity')) {
          return {
            rows: tables.map((table) => ({ table_name: table.name, rls_enabled: table.rls })),
          } as never;
        }
        if (text.includes('to_regclass')) {
          return { rows: [{ present: buckets !== null }] } as never;
        }
        if (text.includes('storage.buckets')) {
          return { rows: (buckets ?? []).map((id) => ({ id })) } as never;
        }
        throw new Error(`unexpected statement: ${text}`);
      },
      close: async () => {
        if (spy) spy.closed += 1;
      },
    };
    return Promise.resolve(connection);
  };
}

function statuses(health: { checks: { key: string; status: string }[] }): Record<string, string> {
  return Object.fromEntries(health.checks.map((check) => [check.key, check.status]));
}

function detail(
  health: { checks: { key: string; detailDe: string | null }[] },
  key: string,
): string {
  return health.checks.find((check) => check.key === key)?.detailDe ?? '';
}

describe('checkSupabaseHealth', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.stubEnv('DATABASE_URL', '');
    resetConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it('reports fixtures, not a connection, when no project is configured', async () => {
    const health = await checkSupabaseHealth();

    expect(health.state).toBe('FIXTURE');
    expect(health.overall).toBe('AWAITING_EXTERNAL_INPUT');
    expect(health.checks.map((check) => check.key)).toEqual([
      'supabase.project',
      'supabase.rls',
      'supabase.storage',
    ]);
    expect(health.checks.every((check) => check.status === 'AWAITING_EXTERNAL_INPUT')).toBe(true);
  });

  it('says so rather than passing when it is live but has nothing to connect to', async () => {
    const health = await checkSupabaseHealth({ mode: 'LIVE', connectionString: null });

    expect(health.state).toBe('DEGRADED');
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
    expect(detail(health, 'supabase.rls')).toContain('Nicht geprüft');
  });

  it('never reports CONNECTED when the connection cannot be opened', async () => {
    const health = await checkSupabaseHealth({
      ...LIVE,
      connect: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
    });

    expect(health.state).toBe('ERROR');
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
    expect(statuses(health)['supabase.project']).toBe('FAIL');
    expect(detail(health, 'supabase.project')).toContain('ECONNREFUSED');
    // Neither RLS nor the buckets were established, and neither claims otherwise.
    expect(statuses(health)['supabase.rls']).toBe('AWAITING_EXTERNAL_INPUT');
    expect(statuses(health)['supabase.storage']).toBe('AWAITING_EXTERNAL_INPUT');
    expect(detail(health, 'supabase.storage')).toContain('Nicht geprüft');
  });

  it('reports CONNECTED once the database has answered every question', async () => {
    const health = await checkSupabaseHealth({ ...LIVE, connect: fakeConnector() });

    expect(health.state).toBe('CONNECTED');
    expect(health.overall).toBe('PASS');
    expect(detail(health, 'supabase.project')).toContain('PostgreSQL 16.13');
    expect(detail(health, 'supabase.rls')).toContain('1 Tabellen');
    expect(detail(health, 'supabase.storage')).toContain('brand-assets');
  });

  it('names the tables the database says have no RLS', async () => {
    const health = await checkSupabaseHealth({
      ...LIVE,
      connect: fakeConnector({
        tables: [
          { name: 'campaigns', rls: true },
          { name: 'leads', rls: false },
          { name: 'submission_pii_encrypted', rls: false },
        ],
      }),
    });

    expect(statuses(health)['supabase.rls']).toBe('FAIL');
    expect(detail(health, 'supabase.rls')).toContain('leads');
    expect(detail(health, 'supabase.rls')).toContain('submission_pii_encrypted');
    expect(detail(health, 'supabase.rls')).toContain('2 von 3');
    expect(health.state).toBe('ERROR');
  });

  it('names the buckets the database does not have', async () => {
    const health = await checkSupabaseHealth({
      ...LIVE,
      connect: fakeConnector({ buckets: ['brand-assets'] }),
    });

    expect(statuses(health)['supabase.storage']).toBe('FAIL');
    expect(detail(health, 'supabase.storage')).toContain('creative-source');
    expect(health.state).toBe('ERROR');
  });

  it('does not judge buckets on an instance that has no storage schema', async () => {
    const health = await checkSupabaseHealth({
      ...LIVE,
      connect: fakeConnector({ buckets: null }),
    });

    expect(statuses(health)['supabase.storage']).toBe('WARN');
    expect(statuses(health)['supabase.project']).toBe('PASS');
    expect(health.state).toBe('DEGRADED');
  });

  it('reports an empty schema as broken rather than as fully covered', async () => {
    const health = await checkSupabaseHealth({ ...LIVE, connect: fakeConnector({ tables: [] }) });

    expect(statuses(health)['supabase.rls']).toBe('FAIL');
    expect(detail(health, 'supabase.rls')).toContain('keine einzige Tabelle');
  });

  it('does not propagate a probe that throws, and closes what it opened', async () => {
    const spy = { closed: 0, statements: [] as string[] };
    const exploding: SqlProbeConnector = async (input) => {
      const connection = await fakeConnector({}, spy)(input);
      return {
        query: () => {
          throw new Error('the server closed the connection unexpectedly');
        },
        close: connection.close,
      };
    };

    const health = await checkSupabaseHealth({ ...LIVE, connect: exploding });

    expect(health.state).toBe('ERROR');
    expect(health.checks).toHaveLength(3);
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
    expect(spy.closed).toBe(1);
  });

  it('gives up on a database that never answers instead of holding the render open', async () => {
    const health = await checkSupabaseHealth({
      ...LIVE,
      connect: () => new Promise(() => {}),
      timeoutMs: 20,
    });

    expect(health.state).toBe('ERROR');
    expect(detail(health, 'supabase.project')).toContain('Zeitüberschreitung');
  });

  it('reports a missing Postgres driver as unchecked rather than as a broken project', async () => {
    vi.resetModules();
    vi.doMock('node:module', () => ({
      createRequire: () => () => {
        throw new Error("Cannot find module 'pg'");
      },
    }));

    try {
      const { checkSupabaseHealth: probe } = await import('./health');
      const health = await probe({ ...LIVE });

      // Nothing was learned about the database, so nothing is asserted about it.
      expect(health.state).toBe('DEGRADED');
      expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
      expect(detail(health, 'supabase.project')).toContain('Postgres-Treiber');
      expect(
        health.checks.find((check) => check.key === 'supabase.project')?.remediationDe,
      ).toContain('pg');
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });

  it('closes the connection on the happy path too', async () => {
    const spy = { closed: 0, statements: [] as string[] };
    await checkSupabaseHealth({ ...LIVE, connect: fakeConnector({}, spy) });

    expect(spy.closed).toBe(1);
    // The catalogue, not information_schema: privileges must not shape the answer.
    expect(spy.statements.some((text) => text.includes('pg_class'))).toBe(true);
  });
});
