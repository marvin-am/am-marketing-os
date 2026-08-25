import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUIRED_STORAGE_BUCKETS, checkSupabaseHealth } from '../src/health';
import {
  DATABASE_URL,
  HAS_DATABASE,
  announceSkip,
  setupDatabase,
  type Harness,
} from '../../../supabase/tests/harness';

/**
 * The Supabase probe against a real schema, through the real driver.
 *
 * The unit tests pin the probe's reporting with an injected connection; this one
 * pins that `connectWithPg` opens a connection at all and that the statements it
 * sends answer the questions the console asks, on a database with every
 * migration applied. Both halves are needed: a hand-written fake proves the
 * reporting, and only Postgres proves that `pg_class.relrowsecurity` and
 * `storage.buckets` mean what the probe says they mean.
 *
 * The interesting case is the second one. The implementation this replaced
 * asserted "RLS ist für alle Tabellen aktiv" from an environment variable, so it
 * would have gone on asserting it after RLS was switched off. The probe has to
 * notice.
 *
 * Skips cleanly without `DATABASE_URL` (AGENTS.md). The harness provisions its
 * own scratch database and drops it afterwards, and the probe is pointed at that
 * scratch database — the instance the URL points at is never read or modified.
 */

const UNPROTECTED_TABLE = 'leads';
const REMOVED_BUCKET = 'creative-source';

if (!HAS_DATABASE) announceSkip('packages/db/integration/supabase-health.test.ts');

describe.skipIf(!HAS_DATABASE)('checkSupabaseHealth against Postgres', () => {
  let harness: Harness;
  let scratchUrl: string;

  beforeAll(async () => {
    harness = await setupDatabase('supabase_health');
    const url = new URL(DATABASE_URL);
    url.pathname = `/${harness.databaseName}`;
    scratchUrl = url.toString();
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  it('reports a fully migrated database as connected, with the counts it read', async () => {
    const health = await checkSupabaseHealth({ mode: 'LIVE', connectionString: scratchUrl });

    const { rows } = await harness.admin.query<{ total: string }>(
      `select count(*)::text as total from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );

    expect(health.state).toBe('CONNECTED');
    expect(health.overall).toBe('PASS');

    const project = health.checks.find((check) => check.key === 'supabase.project');
    expect(project?.status).toBe('PASS');
    expect(project?.detailDe).toContain(harness.databaseName);

    const rls = health.checks.find((check) => check.key === 'supabase.rls');
    expect(rls?.status).toBe('PASS');
    // The number in the sentence is the number the catalogue holds, not a constant.
    expect(rls?.detailDe).toContain(`${rows[0]!.total} Tabellen`);

    const storage = health.checks.find((check) => check.key === 'supabase.storage');
    expect(storage?.status).toBe('PASS');
    for (const bucket of REQUIRED_STORAGE_BUCKETS) {
      expect(storage?.detailDe).toContain(bucket);
    }
  });

  it('stops passing the moment RLS is switched off or a bucket disappears', async () => {
    await harness.admin.query(`alter table public.${UNPROTECTED_TABLE} disable row level security`);
    await harness.admin.query(`delete from storage.buckets where id = $1`, [REMOVED_BUCKET]);

    const health = await checkSupabaseHealth({ mode: 'LIVE', connectionString: scratchUrl });

    const rls = health.checks.find((check) => check.key === 'supabase.rls');
    expect(rls?.status).toBe('FAIL');
    expect(rls?.detailDe).toContain(UNPROTECTED_TABLE);

    const storage = health.checks.find((check) => check.key === 'supabase.storage');
    expect(storage?.status).toBe('FAIL');
    expect(storage?.detailDe).toContain(REMOVED_BUCKET);

    // The connection is still fine; the schema is not, and the report says both.
    expect(health.checks.find((check) => check.key === 'supabase.project')?.status).toBe('PASS');
    expect(health.state).toBe('ERROR');
  });

  it('reports an unreachable database as an error rather than as a connection', async () => {
    const unreachable = new URL(scratchUrl);
    unreachable.port = '1';

    const health = await checkSupabaseHealth({
      mode: 'LIVE',
      connectionString: unreachable.toString(),
      timeoutMs: 2_000,
    });

    expect(health.state).toBe('ERROR');
    expect(health.checks.some((check) => check.status === 'PASS')).toBe(false);
  });
});
