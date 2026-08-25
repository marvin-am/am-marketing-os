import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announceSkip, HAS_DATABASE } from '../../../supabase/tests/harness';
import { workspaceResolver } from '../src/server/workspace';
import {
  setupConsoleDatabase,
  UNSEEDED_WORKSPACE_ID,
  type ConsoleHarness,
} from './console-pg-harness';

/**
 * The workspace the scheduled jobs write into.
 *
 * A hard-coded id was wrong against a real database, and it failed in the
 * quietest way available: `performance_rollups.workspace_id` carries a foreign
 * key, every insert violated it, the job still reported the rows it had tried
 * to write, and the dashboards that read those rollups stayed empty with
 * nothing anywhere saying why. Nobody would have looked at the job — they would
 * have looked at the dashboard and concluded there was no data yet.
 *
 * These tests hold both halves of the fix: the constant really is rejected, so
 * the failure mode is genuine and not hypothetical, and resolving by slug
 * really does find the seeded workspace.
 */

if (!HAS_DATABASE) announceSkip('apps/console/integration/job-workspace-postgres.test.ts');

describe.skipIf(!HAS_DATABASE)('the job runtime addresses a workspace that exists', () => {
  let ctx: ConsoleHarness;

  beforeAll(async () => {
    ctx = await setupConsoleDatabase('jobws', { applySeed: true });
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('rejects a rollup written against the hard-coded id', async () => {
    await expect(
      ctx.sql.query(`insert into public.performance_rollups (workspace_id, day) values ($1, $2)`, [
        UNSEEDED_WORKSPACE_ID,
        '2026-08-01',
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('resolves the seeded workspace from its slug instead', async () => {
    const resolved = await workspaceResolver(ctx.db, UNSEEDED_WORKSPACE_ID)();

    const { rows } = await ctx.sql.query<{ id: string }>(
      `select id from public.workspaces where slug = 'am'`,
    );
    expect(resolved).toBe(rows[0]?.id);
    expect(resolved).not.toBe(UNSEEDED_WORKSPACE_ID);
  });

  it('writes a rollup that the foreign key accepts', async () => {
    const workspaceId = await workspaceResolver(ctx.db, UNSEEDED_WORKSPACE_ID)();

    await ctx.sql.query(
      `insert into public.performance_rollups (workspace_id, day) values ($1, $2)
       on conflict do nothing`,
      [workspaceId, '2026-08-02'],
    );

    const { rows } = await ctx.sql.query<{ count: string }>(
      `select count(*)::text as count from public.performance_rollups
        where workspace_id = $1 and day = '2026-08-02'`,
      [workspaceId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('keeps the constant as the answer for a database with no workspace', async () => {
    // An unseeded database has nothing to resolve, and reads against the
    // fallback correctly return nothing rather than throwing on startup.
    const empty = await setupConsoleDatabase('jobws_empty');
    try {
      const resolved = await workspaceResolver(empty.db, UNSEEDED_WORKSPACE_ID)();
      expect(resolved).toBe(UNSEEDED_WORKSPACE_ID);
    } finally {
      await empty.teardown();
    }
  }, 180_000);
});
