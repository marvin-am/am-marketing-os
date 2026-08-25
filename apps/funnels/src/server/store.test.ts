import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@am/config';
import { resetDemoDatabase } from '@am/db';
import { isDomainError } from '@am/domain';
import { getFixtureStore, getFunnelStore, getFunnelStoreMode, resetFunnelStore } from './store';

/**
 * Which storage the funnel runtime picked, and whether it says so truthfully.
 *
 * The danger is not that the fixture store exists — it is what makes the funnel
 * demonstrable without a database. The danger is a deployment serving leads out
 * of a process that every cold start empties while nothing anywhere reports it.
 * So the assertion worth writing is not "the store works" but "the store cannot
 * be wrong about itself".
 */

const SUPABASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-selection-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-selection-test',
} as const;

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  resetFunnelStore();
  resetDemoDatabase();

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    resetFunnelStore();
    resetDemoDatabase();
  };
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe('funnel store selection', () => {
  it('serves from memory when Supabase is not configured', () => {
    restore = withEnv({
      DEMO_MODE: 'false',
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });

    expect(getFunnelStoreMode()).toBe('memory');
    expect(getFixtureStore().mode).toBe('memory');
  });

  it('serves from memory in DEMO_MODE even with Supabase configured', () => {
    restore = withEnv({ DEMO_MODE: 'true', ...SUPABASE_ENV });

    expect(getFunnelStoreMode()).toBe('memory');
  });

  it('serves from the database once Supabase is configured and DEMO_MODE is off', () => {
    restore = withEnv({ DEMO_MODE: 'false', ...SUPABASE_ENV });

    /* The whole point: nothing may report `supabase` while serving from memory,
       and nothing may quietly serve from memory while a database is configured. */
    expect(getFunnelStoreMode()).toBe('supabase');
  });

  it('refuses to hand a test a fixture store the runtime is not using', () => {
    restore = withEnv({ DEMO_MODE: 'false', ...SUPABASE_ENV });

    /* A second, empty fixture store here would let a test pass against data the
       runtime never wrote. */
    try {
      getFixtureStore();
      throw new Error('expected getFixtureStore() to refuse');
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
    }
  });

  it('hands out the same instance for the life of the process', () => {
    restore = withEnv({ DEMO_MODE: 'true' });

    /* A fresh store per request would make the form instance created during
       render invisible to the submission that follows. */
    const first = getFunnelStore();
    expect(getFunnelStore()).toBe(first);

    resetFunnelStore();
    expect(getFunnelStore()).not.toBe(first);
  });
});
