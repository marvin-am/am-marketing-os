import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@am/config';
import { DatabaseCampaignPort } from './campaign-db-port';
import { getCampaignPort, setCampaignPort } from './campaign-fixtures';

/**
 * The factory reads configuration, and this is what holds it to that.
 *
 * A factory that ignored its configuration would be invisible to every other
 * test in the console: each of them exercises one implementation and would pass
 * whichever one it was handed. These cases are about the decision itself rather
 * than about either implementation, which is why they assert on the constructor
 * and on nothing else.
 */

const KEYS = ['DEMO_MODE', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  setCampaignPort(null);
}

describe('getCampaignPort', () => {
  const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;

  afterEach(() => {
    setEnv(original);
  });

  it('returns the fixture while nothing is persisted', () => {
    setEnv({ DEMO_MODE: 'true' });
    expect(getCampaignPort()).not.toBeInstanceOf(DatabaseCampaignPort);
  });

  it('returns the fixture when Supabase is configured but demo mode is on', () => {
    setEnv({
      DEMO_MODE: 'true',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-the-factory-test',
    });
    // A demo run must not read or write a real workspace, so demo wins over a
    // configured project rather than the other way round.
    expect(getCampaignPort()).not.toBeInstanceOf(DatabaseCampaignPort);
  });

  it('returns the repository-backed port once a project is configured', () => {
    setEnv({
      DEMO_MODE: 'false',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-the-factory-test',
    });
    expect(getCampaignPort()).toBeInstanceOf(DatabaseCampaignPort);
  });

  it('falls back to the fixture when demo mode is off and no project is configured', () => {
    setEnv({ DEMO_MODE: 'false' });
    expect(getCampaignPort()).not.toBeInstanceOf(DatabaseCampaignPort);
  });
});
