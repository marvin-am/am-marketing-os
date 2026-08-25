import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@am/config';
import type * as AmDb from '@am/db';

/**
 * The factories decide, and the decision is what is tested.
 *
 * A port that hands back its fixture no matter how the product is configured is
 * a defect no screen test can catch: the fixture answers every call correctly,
 * so the pages render and the numbers look plausible while the database is never
 * read. The observable difference is what these tests use — the fixture is
 * populated, and the live implementation over an empty store is empty.
 *
 * `resolveDatabase()` is stubbed rather than the environment: it is the single
 * decision point the factories consult, and stubbing it exercises both branches
 * without a Supabase project or a network call.
 */

const resolved = vi.hoisted(() => ({
  mode: 'memory' as 'memory' | 'supabase',
}));

vi.mock('@am/db', async (importOriginal) => {
  const actual = await importOriginal<typeof AmDb>();
  return {
    ...actual,
    resolveDatabase: () => ({ db: actual.createMemoryDatabase(), mode: resolved.mode }),
  };
});

const { getAnalyticsPort, setAnalyticsPort } = await import('./analytics-factory');
const { getOpsPort, resetOpsPort } = await import('./ops-fixtures');

beforeEach(() => {
  vi.stubEnv('DEMO_MODE', 'true');
  resetConfigCache();
  setAnalyticsPort(null);
  resetOpsPort();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigCache();
  resetOpsPort();
});

describe('analytics port factory', () => {
  it('serves the fixture when there is no database to read', async () => {
    resolved.mode = 'memory';
    const cards = await getAnalyticsPort({ now: '2026-08-25T09:00:00.000Z' }).listLearningCards();
    expect(cards.length).toBeGreaterThan(0);
  });

  it('reads the store — and nothing else — once one is configured', async () => {
    resolved.mode = 'supabase';
    const port = getAnalyticsPort({ now: '2026-08-25T09:00:00.000Z' });
    // An empty store yields empty screens. The fixture's learning cards must not
    // appear beside a real workspace's own data.
    expect(await port.listLearningCards()).toEqual([]);
    expect(await port.listCampaigns()).toEqual([]);
  });
});

describe('ops port factory', () => {
  it('serves the fixture when there is no database to read', async () => {
    resolved.mode = 'memory';
    const outbox = await getOpsPort().loadOutbox();
    expect(outbox.rows.length).toBeGreaterThan(0);
  });

  it('reads the store — and nothing else — once one is configured', async () => {
    resolved.mode = 'supabase';
    const outbox = await getOpsPort().loadOutbox();
    expect(outbox.rows).toEqual([]);
    expect(outbox.deadLetterCount).toBe(0);
  });
});
