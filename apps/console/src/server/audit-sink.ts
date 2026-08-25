import { getFeatureFlags } from '@am/config';
import { redact, type AuditLog } from '@am/domain';
import { logger } from '@am/observability';
import type { AmDatabase, AuditLogRow, Json } from '@am/db';
import type { AuditSink } from '@/lib/action';

/**
 * Composition root for the audit trail.
 *
 * `defineAction` calls `ctx.audit(...)` on every mutating action but owns no
 * storage; this module is the single place that decides where those rows go,
 * from configuration and never inline in a feature (AGENTS.md, "Fixtures and
 * demo mode"). `resolveDatabase()` already makes that choice for the whole
 * product: the in-memory store when `DEMO_MODE` is on or Postgres is not
 * configured, Supabase otherwise. Both retain what they are given, which is the
 * point — a demo-mode sink that dropped rows would leave the Versionen tab
 * claiming to list every change while recording none of them.
 *
 * Admin credentials on purpose: `audit_logs` is append-only by policy (0012
 * grants SELECT and INSERT and nothing else) and the row is written on behalf of
 * an actor whose permission `defineAction` has already checked, so the write
 * must not additionally depend on that actor's RLS context.
 *
 * `@am/db` is imported dynamically because `@/lib/action` — and through it every
 * server component that guards a route — statically imports this module, and the
 * whole schema layer has no business in that graph until a row is actually
 * written.
 */

let database: Promise<AmDatabase> | null = null;

function auditDatabase(): Promise<AmDatabase> {
  database ??= (async () => {
    const { resolveDatabase } = await import('@am/db');
    // Demo mode wins over a configured project: a fixture run must not write its
    // audit rows into a real workspace's trail.
    const { db, mode } = resolveDatabase({ admin: true, demo: getFeatureFlags().demoMode });
    logger.info('audit_sink_ready', { store: mode });
    return db;
  })();
  return database;
}

/**
 * Redacts a payload and narrows it to the column's JSON type.
 *
 * Redaction runs here and not only in `defineAction` because the in-memory
 * store — the audit trail in demo mode — has no sanitising layer of its own,
 * unlike `SupabaseAuditRepository`. `redact()` is idempotent, so the two passes
 * cost nothing and neither one is load-bearing alone.
 */
function auditPayload(value: unknown): Json {
  return (redact(value) ?? null) as Json;
}

export function createAuditSink(): AuditSink {
  return async (entry) => {
    const db = await auditDatabase();
    await db.audit.append({
      workspace_id: entry.workspaceId,
      action: entry.action,
      occurred_at: entry.occurredAt,
      actor_id: entry.actorId,
      actor_label: entry.actorLabel,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      campaign_id: entry.campaignId ?? null,
      summary_de: entry.summaryDe,
      before: auditPayload(entry.before),
      after: auditPayload(entry.after),
      correlation_id: entry.correlationId,
    });
  };
}

/**
 * Audit rows recorded for one campaign, newest first.
 *
 * The read side lives beside the write side so the Versionen tab reads back the
 * same store the sink writes to. Anything else is how a screen ends up showing
 * only the rows someone seeded.
 */
export async function readCampaignAuditLog(
  workspaceId: string,
  campaignId: string,
): Promise<AuditLog[]> {
  const db = await auditDatabase();
  const page = await db.audit.list({ workspaceId, campaignId, limit: 200 });
  return page.rows.map(toAuditLog);
}

/** Row shape to domain shape; the column is `summary_de`, the type `summaryDe`. */
function toAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    action: row.action,
    occurred_at: row.occurred_at,
    actor_id: row.actor_id,
    actor_label: row.actor_label,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    campaign_id: row.campaign_id,
    summaryDe: row.summary_de,
    before: row.before,
    after: row.after,
    correlation_id: row.correlation_id,
  };
}

/** Test seam: forgets the resolved store so the next call re-reads configuration. */
export function resetAuditStore(): void {
  database = null;
}
