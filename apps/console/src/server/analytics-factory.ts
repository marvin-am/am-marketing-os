import { getFeatureFlags } from '@am/config';
import type { IsoTimestamp } from '@am/domain';
import { resolveDatabase } from '@am/db';
import { createAnalyticsFixturePort } from './analytics-fixtures';
import { createLiveAnalyticsPort } from './analytics-live';
import type { AnalyticsPort } from './analytics-port';
import { CONSOLE_WORKSPACE_ID } from './workspace';

/**
 * The single place fixture and rollups are chosen for Performance, Experimente
 * and Learnings.
 *
 * Selection happens here, from configuration, and never inside a page —
 * a page that constructs its own implementation cannot be configured at all, and
 * the choice then silently differs from the one the rest of the product made.
 * `resolveDatabase()` has already made that choice: `memory` means demo mode or
 * an unconfigured project, where the fixture is the only honest answer because
 * there is no `performance_rollups` table to read; `supabase` means the rollup
 * job's rows exist and the dashboards must show those.
 *
 * `now` is resolved once per request by the caller and passed through, so every
 * figure on one page render is evaluated at the same instant.
 */

export interface AnalyticsPortOptions {
  /** Evaluation instant. Pinned per request so a page is internally consistent. */
  now?: IsoTimestamp;
}

let override: AnalyticsPort | null = null;

export function getAnalyticsPort(options: AnalyticsPortOptions = {}): AnalyticsPort {
  if (override) return override;

  const { db, mode } = resolveDatabase({ admin: true, demo: getFeatureFlags().demoMode });
  return mode === 'memory'
    ? createAnalyticsFixturePort(options)
    : createLiveAnalyticsPort({ db, workspaceId: CONSOLE_WORKSPACE_ID, now: options.now });
}

/** Test seam: replaces the port for the duration of a test. */
export function setAnalyticsPort(next: AnalyticsPort | null): void {
  override = next;
}
