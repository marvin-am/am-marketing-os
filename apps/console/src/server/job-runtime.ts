import { getAppConfig, getFeatureFlags, resolveProviderMode } from '@am/config';
import {
  createMemoryPorts,
  createMemoryState,
  type JobPorts,
  type JobProviders,
  type MemoryPortsState,
} from '@am/jobs';
import { logger } from '@am/observability';
import { CONSOLE_WORKSPACE_ID, workspaceResolver } from './workspace';

/**
 * Composition root for background jobs.
 *
 * `@am/jobs` is deliberately free of database and provider imports, so this is
 * where its ports get real implementations. Nothing here pretends a provider is
 * connected: an unconfigured provider is `null`, and the job degrades to a
 * documented skip rather than failing the run.
 */

// Process-wide so repeated cron invocations in one runtime see the same queue.
let demoState: MemoryPortsState | null = null;

function getDemoState(): MemoryPortsState {
  if (!demoState) demoState = createMemoryState();
  return demoState;
}

export async function buildJobPorts(): Promise<JobPorts> {
  if (resolveProviderMode('SUPABASE') === 'LIVE') {
    const { createSupabaseJobPorts } = await import('./job-ports-supabase');
    return createSupabaseJobPorts();
  }
  return createMemoryPorts(getDemoState());
}

/**
 * Provider handles for jobs.
 *
 * "Not usable" includes the honest cases: no credentials, and — for HubSpot
 * reconciliation — no published mapping, because without a mapping there is
 * genuinely nothing to reconcile against.
 */
export async function buildJobProviders(): Promise<JobProviders> {
  const [meta, hubspot] = await Promise.all([buildMetaJobProvider(), buildHubspotJobProvider()]);
  return { meta, hubspot };
}

async function buildMetaJobProvider(): Promise<JobProviders['meta']> {
  try {
    const { createMetaProvider } = await import('@am/meta');
    const provider = createMetaProvider();

    return {
      fetchInsightsDaily: async ({ since, until }) => {
        // Ad level is the finest grain Meta reports; campaign and ad-set
        // figures are aggregated from it rather than fetched separately, so a
        // creative-level breakdown is always available.
        const page = await provider.fetchInsightsDaily({ level: 'ad', since, until });
        return { rows: page.items };
      },
      sendCapiEvents: async (batch) => {
        const outcome = await provider.sendCapiEvents(batch as never);
        return 'dryRun' in outcome ? { dryRun: true as const } : { accepted: 1, response: outcome };
      },
      health: () => provider.health(),
    };
  } catch (error) {
    logger.warn('meta_job_provider_unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function buildHubspotJobProvider(): Promise<JobProviders['hubspot']> {
  try {
    const hubspot = await import('@am/hubspot');
    const provider = hubspot.createHubspotProvider();
    const mapping = await loadPublishedMapping();

    if (!mapping) {
      // Not an error state. Reconciling without a published mapping would mean
      // guessing which pipeline stage means what — exactly what this product
      // refuses to do.
      return null;
    }

    const store = hubspot.createInMemorySyncStore();

    return {
      reconcile: async ({ deep, since }) => {
        const report = await hubspot.reconcile(
          {
            scope: deep ? 'DAILY' : 'HOURLY',
            mapping: mapping as never,
            cursor: since ? ({ since } as never) : null,
          },
          { provider, store },
        );
        return {
          checked: report.objectsRead,
          transitions: report.eventsEmitted.length,
          discrepancies: report.discrepancies.length,
        };
      },
      syncPending: async (batch) => {
        const outcome = await provider.upsertContact(batch as never);
        return 'dryRun' in (outcome as object)
          ? { dryRun: true as const }
          : { synced: 1, response: outcome };
      },
      health: () => provider.health(),
    };
  } catch (error) {
    logger.warn('hubspot_job_provider_unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The published HubSpot mapping, or `null` while one has not been supplied.
 * Reading it from the database is what lets a mapping change take effect
 * without a deploy.
 */
async function loadPublishedMapping(): Promise<unknown | null> {
  const { resolveDatabase } = await import('@am/db');
  const { db, mode } = resolveDatabase({ admin: true });

  if (mode === 'memory') {
    const { FIXTURE_MAPPING } = await import('@am/hubspot');
    return FIXTURE_MAPPING;
  }

  /*
   * `hubspot_mappings` stores `field_map`, `stage_map`, `pipeline_id` and the
   * version chain — not the wizard's mapping document, which additionally
   * describes deal creation, stage events, revenue, VQ, acquisition and
   * webhooks. There is no column for it, so the console's publish path refuses
   * rather than accepting a change that would vanish on reload, and this read
   * has nothing to return. It was reading `row.mapping`, a column that has
   * never existed, so it silently answered `null` for the wrong reason: not
   * "none published" but "cannot be loaded".
   *
   * Until the document has a home, a live database has no published mapping by
   * construction, and the launch gate stays closed — which is the correct
   * outcome, reached honestly.
   */
  const row = await db.hubspot.getActiveMapping(
    (await resolveJobWorkspaceId()) as never,
    'deal' as never,
  );
  if (!row) return null;
  logger.warn('hubspot.mapping_document_not_persisted', {
    reason: 'hubspot_mappings has no column for the wizard document',
  });
  return null;
}

export function jobEnvironment() {
  return {
    environment: getAppConfig().environment,
    flags: getFeatureFlags(),
    // Single-workspace product; the column exists so isolation is mechanical.
    workspaceId: CONSOLE_WORKSPACE_ID,
  };
}

/**
 * The workspace the jobs write into.
 *
 * A constant is wrong against a real database and fails in the quietest way
 * there is: every `performance_rollups` insert violates its foreign key, the
 * job reports the rows it tried to write, and the dashboards that read those
 * rollups stay empty with nothing anywhere saying why. Reproduced — the key
 * `00000000-…-0001` is not present in `workspaces`, which holds the seeded row
 * under the slug `am`.
 *
 * So the id is resolved from that slug, exactly as the console's ports resolve
 * it, and the constant survives only as the answer for a database with no
 * workspace at all — where reads legitimately return nothing.
 */
export async function resolveJobWorkspaceId(): Promise<string> {
  const { resolveDatabase } = await import('@am/db');
  const { db, mode } = resolveDatabase({ admin: true });
  if (mode === 'memory') return CONSOLE_WORKSPACE_ID;
  return workspaceResolver(db, CONSOLE_WORKSPACE_ID)();
}
