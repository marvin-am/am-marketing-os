import { getFeatureFlags } from '@am/config';
import { DomainError } from '@am/domain';
import { resolveDatabase } from '@am/db';
import { logger } from '@am/observability';
import { createDatabaseStore, type DatabaseFunnelStore } from './db-store';
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
 * The branch is `resolveDatabase()`'s, not this file's. It already decides
 * Postgres versus memory from `DEMO_MODE` and from whether Supabase is
 * configured at all, and reports which it chose — so there is exactly one answer
 * to "is anything actually persisted?" across the whole product. When it says
 * `memory` the fixture store serves, because a funnel that demonstrates itself
 * without a database is the point of DEMO_MODE; when it says `supabase` the
 * database store serves, and nothing anywhere reports `supabase` while serving
 * out of a process that a cold start will empty.
 *
 * Nothing else in the app imports either implementation.
 */

type ResolvedFunnelStore = FixtureFunnelStore | DatabaseFunnelStore;

let store: ResolvedFunnelStore | null = null;

function createStore(): ResolvedFunnelStore {
  /* Admin, because the write path runs entirely on the server under the service
     role: `0017_harden_privileges.sql` revoked EXECUTE on the runtime RPCs from
     the anon key, so an anonymous client would resolve to a store that cannot
     write. */
  const { db, mode } = resolveDatabase({ admin: true, demo: getFeatureFlags().demoMode });

  if (mode === 'memory') {
    logger.info('funnel.store.selected', { mode: 'memory', persisted: false });
    return createFixtureStore();
  }

  logger.info('funnel.store.selected', { mode: 'supabase', persisted: true });
  return createDatabaseStore(db);
}

export function getFunnelStore(): FunnelStore {
  store ??= createStore();
  return store;
}

/**
 * Which storage the runtime actually selected.
 *
 * `'memory'` means nothing survives the process. Exposed as its own function so
 * the answer comes from the store that is serving rather than from re-reading
 * the configuration, which is how a surface ends up claiming one thing while
 * another is true.
 */
export function getFunnelStoreMode(): ResolvedFunnelStore['mode'] {
  store ??= createStore();
  return store.mode;
}

/** Test seam. Also the honest answer to "is anything actually persisted?". */
export function getFixtureStore(): FixtureFunnelStore {
  const resolved = getFunnelStore() as ResolvedFunnelStore;
  if (resolved.mode !== 'memory') {
    /* Handing back a second, empty fixture store here would make a test pass
       against data the runtime never wrote. */
    throw new DomainError('INTERNAL', {
      messageDe:
        'Der Funnel-Store läuft gegen die Datenbank; ein Fixture-Store steht in diesem Modus nicht zur Verfügung.',
      details: { mode: resolved.mode },
    });
  }
  return resolved;
}

export function resetFunnelStore(): void {
  store = null;
}
