import { afterEach, describe, expect, it } from 'vitest';
import { DomainError, SAFE_DEFAULT_FLAGS } from '@am/domain';
import { FixtureMetaProvider } from './fixture-provider';
import {
  DEFAULT_HISTORICAL_IMPORT_MONTHS,
  IMPORT_SCOPES,
  assertNoDuplicateInserts,
  createInMemoryImportSink,
  entityKey,
  importWindow,
  insightsKey,
  runHistoricalImport,
} from './import';
import {
  assertOutboundAllowed,
  isImportModeActive,
  resetImportMode,
  runInImportMode,
} from './import-mode';

const NOW = '2026-06-30T00:00:00.000Z';

afterEach(() => {
  resetImportMode();
});

/* -------------------------------------------------------------------------- */

describe('upsert keys', () => {
  it('keys entities on (provider, external_id)', () => {
    expect(entityKey('23851000000000001')).toBe('META:23851000000000001');
  });

  it('keys insights on level, object and day', () => {
    const key = insightsKey({ externalId: '23853', date: '2026-06-01', level: 'ad' });
    expect(key).toBe('META:ad:23853:2026-06-01');
    // The same object on a different day is a different row.
    expect(key).not.toBe(insightsKey({ externalId: '23853', date: '2026-06-02', level: 'ad' }));
    // The same day at a different level is also a different row.
    expect(key).not.toBe(
      insightsKey({ externalId: '23853', date: '2026-06-01', level: 'campaign' }),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('import window', () => {
  it('defaults to the configured number of months', () => {
    const window = importWindow(DEFAULT_HISTORICAL_IMPORT_MONTHS, NOW);
    expect(window.until).toBe('2026-06-30');
    expect(window.since).toBe('2024-06-30');
  });

  it('extends to an arbitrary range', () => {
    expect(importWindow(37, NOW).since).toBe('2023-05-30');
  });
});

/* -------------------------------------------------------------------------- */

describe('import mode', () => {
  it('is inactive by default', () => {
    expect(isImportModeActive()).toBe(false);
    expect(() => assertOutboundAllowed('meta.capi_dispatch')).not.toThrow();
  });

  it('suppresses outbound dispatch while active', async () => {
    await runInImportMode(async () => {
      expect(isImportModeActive()).toBe(true);
      let thrown: unknown;
      try {
        assertOutboundAllowed('meta.capi_dispatch');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).code).toBe('FORBIDDEN');
      expect((thrown as DomainError).messageDe).toContain('historischen Imports');
    });
    expect(isImportModeActive()).toBe(false);
  });

  it('restores the previous state even when the body throws', async () => {
    await expect(
      runInImportMode(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(isImportModeActive()).toBe(false);
  });

  it('nests without unlocking early', async () => {
    await runInImportMode(async () => {
      await runInImportMode(async () => {
        expect(isImportModeActive()).toBe(true);
      });
      expect(isImportModeActive()).toBe(true);
    });
    expect(isImportModeActive()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('runHistoricalImport', () => {
  it('walks every scope and reports a German summary', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS, pageSize: 10 });
    const sink = createInMemoryImportSink();
    const progress: string[] = [];

    const summary = await runHistoricalImport(provider, sink, {
      months: 24,
      now: NOW,
      onProgress: (event) => progress.push(`${event.scope}:${event.page}`),
    });

    expect(summary.scopes.map((scope) => scope.scope)).toEqual([...IMPORT_SCOPES]);
    expect(summary.totals.inserted).toBeGreaterThan(0);
    expect(summary.totals.updated).toBe(0);
    expect(summary.summaryDe).toContain('Meta-Import abgeschlossen');
    expect(progress.length).toBeGreaterThan(0);
    expect(sink.campaigns.size).toBe(6);
    expect(sink.adSets.size).toBe(12);
    expect(sink.ads.size).toBe(36);
    expect(sink.creatives.size).toBe(36);
  });

  it('runs with outbound dispatch suppressed', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS, pageSize: 1000 });
    const sink = createInMemoryImportSink();
    let observedInside = false;

    await runHistoricalImport(provider, sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
      onProgress: () => {
        observedInside = isImportModeActive();
      },
    });

    expect(observedInside).toBe(true);
    expect(isImportModeActive()).toBe(false);
  });

  it('stores raw payloads tagged for the private schema', async () => {
    const provider = new FixtureMetaProvider({ flags: SAFE_DEFAULT_FLAGS, pageSize: 1000 });
    const sink = createInMemoryImportSink();

    await runHistoricalImport(provider, sink, {
      months: 24,
      now: NOW,
      scopes: ['CAMPAIGNS'],
    });

    expect(sink.rawPayloads).toHaveLength(6);
    for (const raw of sink.rawPayloads) {
      expect(raw.provider).toBe('META');
      expect(raw.kind).toBe('CAMPAIGN');
      expect(raw.externalId).toMatch(/^\d+$/);
      expect(raw.payload).toBeTruthy();
    }
  });

  it('flags a re-run that inserted rows as a broken upsert key', async () => {
    expect(() =>
      assertNoDuplicateInserts({
        provider: 'META',
        startedAt: NOW,
        completedAt: NOW,
        durationMs: 1,
        window: { since: '2024-06-30', until: '2026-06-30', months: 24, fullHistory: false },
        scopes: [],
        totals: { itemsSeen: 3, inserted: 3, updated: 0, rawPayloads: 0 },
        summaryDe: '',
      }),
    ).toThrowError(/greift nicht/);
  });
});
