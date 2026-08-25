import { createFixtureStore, type FixtureFunnelStore } from './fixture-store';
import type { FunnelStore } from './ports';

/**
 * The one place the funnel runtime decides which storage it talks to.
 *
 * A module-level singleton on purpose: a page render, the collector and the
 * submit handler must see the same data within a process, and a fresh store per
 * request would make the form instance created during render invisible to the
 * submission that follows.
 *
 * When `@am/db` is wired in, this function grows a single branch —
 * `resolveDatabase()` for Postgres, the fixture store for `DEMO_MODE` — and
 * nothing else in the app changes, because nothing else imports the store
 * implementation.
 */

let store: FixtureFunnelStore | null = null;

export function getFunnelStore(): FunnelStore {
  store ??= createFixtureStore();
  return store;
}

/** Test seam. Also the honest answer to "is anything actually persisted?". */
export function getFixtureStore(): FixtureFunnelStore {
  store ??= createFixtureStore();
  return store;
}

export function resetFunnelStore(): void {
  store = null;
}
