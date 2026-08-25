/**
 * Integration connections, health probes, sync cursors and sync jobs.
 *
 * Provider credentials are stored as an AES-256-GCM envelope, never in plaintext,
 * and `NOT_CONFIGURED` / `FIXTURE` are real persisted states — nothing here ever
 * reports a connection that does not exist (AGENTS rule 1).
 */
import { DomainError, rollUpHealth, type ConnectionState, type HealthStatus, type Provider } from '@am/domain';
import type { DbClient } from '../client';
import { indexBy, SupabaseRepository } from './base';
import { decrypt, encrypt, type EncryptedEnvelope } from '../crypto';
import type {
  IntegrationConnectionInsert,
  IntegrationConnectionRow,
  IntegrationHealthCheckInsert,
  IntegrationHealthCheckRow,
  SyncCursorRow,
  SyncJobInsert,
  SyncJobRow,
  Updatable,
  Uuid,
} from '../types';

export interface IntegrationRepository {
  list(workspaceId: Uuid): Promise<IntegrationConnectionRow[]>;
  get(workspaceId: Uuid, provider: Provider): Promise<IntegrationConnectionRow | null>;
  upsert(input: IntegrationConnectionInsert): Promise<IntegrationConnectionRow>;
  setState(workspaceId: Uuid, provider: Provider, state: ConnectionState, error?: string | null): Promise<IntegrationConnectionRow>;
  /** Encrypts before writing. The plaintext never reaches a column. */
  storeCredentials(workspaceId: Uuid, provider: Provider, credentials: Record<string, unknown>): Promise<IntegrationConnectionRow>;
  readCredentials(workspaceId: Uuid, provider: Provider): Promise<Record<string, unknown> | null>;

  recordHealthChecks(checks: readonly IntegrationHealthCheckInsert[]): Promise<IntegrationHealthCheckRow[]>;
  latestHealth(workspaceId: Uuid, provider?: Provider): Promise<IntegrationHealthCheckRow[]>;
  overallHealth(workspaceId: Uuid, provider: Provider): Promise<HealthStatus>;

  getCursor(workspaceId: Uuid, provider: Provider, resource: string): Promise<SyncCursorRow | null>;
  setCursor(
    workspaceId: Uuid,
    provider: Provider,
    resource: string,
    patch: { cursor_value?: string | null; cursor_time?: string | null; success: boolean; error?: string | null },
  ): Promise<SyncCursorRow>;

  enqueueJob(input: SyncJobInsert): Promise<SyncJobRow>;
  listDueJobs(workspaceId: Uuid, limit?: number): Promise<SyncJobRow[]>;
  startJob(id: Uuid): Promise<SyncJobRow>;
  finishJob(id: Uuid, result: { processed: number; failed: number; error?: string | null; payload?: unknown }): Promise<SyncJobRow>;
}

export class SupabaseIntegrationRepository extends SupabaseRepository implements IntegrationRepository {
  list(workspaceId: Uuid): Promise<IntegrationConnectionRow[]> {
    return this.selectList<IntegrationConnectionRow>(
      this.client.from('integration_connections').select('*').eq('workspace_id', workspaceId).order('provider'),
      'integrations.list',
    );
  }

  get(workspaceId: Uuid, provider: Provider): Promise<IntegrationConnectionRow | null> {
    return this.selectMaybe<IntegrationConnectionRow>(
      this.client
        .from('integration_connections')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('provider', provider)
        .maybeSingle(),
      'integrations.get',
    );
  }

  async upsert(input: IntegrationConnectionInsert): Promise<IntegrationConnectionRow> {
    const row = await this.selectMaybe<IntegrationConnectionRow>(
      this.client
        .from('integration_connections')
        .upsert(input, { onConflict: 'workspace_id,provider' })
        .select('*')
        .single(),
      'integrations.upsert',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'integrations.upsert' } });
    return row;
  }

  async setState(
    workspaceId: Uuid,
    provider: Provider,
    state: ConnectionState,
    error: string | null = null,
  ): Promise<IntegrationConnectionRow> {
    const patch: Updatable<IntegrationConnectionRow> = {
      state,
      last_error: error,
      last_checked_at: new Date().toISOString(),
      connected_at: state === 'CONNECTED' ? new Date().toISOString() : undefined,
    };
    const row = await this.selectMaybe<IntegrationConnectionRow>(
      this.client
        .from('integration_connections')
        .update(patch)
        .eq('workspace_id', workspaceId)
        .eq('provider', provider)
        .select('*')
        .single(),
      'integrations.setState',
    );
    if (!row) {
      return this.upsert({ workspace_id: workspaceId, provider, state, last_error: error });
    }
    return row;
  }

  async storeCredentials(
    workspaceId: Uuid,
    provider: Provider,
    credentials: Record<string, unknown>,
  ): Promise<IntegrationConnectionRow> {
    const envelope = encrypt(JSON.stringify(credentials), { aad: `${workspaceId}:${provider}` });
    return this.upsert({
      workspace_id: workspaceId,
      provider,
      state: 'CONNECTED',
      credentials_ciphertext: envelope.ciphertext,
      credentials_iv: envelope.iv,
      credentials_auth_tag: envelope.auth_tag,
      key_version: envelope.key_version,
      connected_at: new Date().toISOString(),
    });
  }

  async readCredentials(workspaceId: Uuid, provider: Provider): Promise<Record<string, unknown> | null> {
    const row = await this.get(workspaceId, provider);
    if (!row?.credentials_ciphertext || !row.credentials_iv || !row.credentials_auth_tag || !row.key_version) {
      return null;
    }
    const envelope: EncryptedEnvelope = {
      algorithm: 'AES-256-GCM',
      key_version: row.key_version,
      iv: row.credentials_iv,
      auth_tag: row.credentials_auth_tag,
      ciphertext: row.credentials_ciphertext,
    };
    return JSON.parse(decrypt(envelope, { aad: `${workspaceId}:${provider}` })) as Record<string, unknown>;
  }

  async recordHealthChecks(
    checks: readonly IntegrationHealthCheckInsert[],
  ): Promise<IntegrationHealthCheckRow[]> {
    if (checks.length === 0) return [];
    return this.selectList<IntegrationHealthCheckRow>(
      this.client.from('integration_health_checks').insert(checks as IntegrationHealthCheckInsert[]).select('*'),
      'integrations.recordHealthChecks',
    );
  }

  async latestHealth(workspaceId: Uuid, provider?: Provider): Promise<IntegrationHealthCheckRow[]> {
    let query = this.client
      .from('integration_health_checks')
      .select('*')
      .eq('workspace_id', workspaceId);
    if (provider) query = query.eq('provider', provider);
    const rows = await this.selectList<IntegrationHealthCheckRow>(
      query.order('checked_at', { ascending: false }).limit(200),
      'integrations.latestHealth',
    );
    // Newest first, so keeping the first occurrence per (provider,key) is "latest".
    return [...indexBy(rows, (row) => `${row.provider}:${row.key}`).values()];
  }

  async overallHealth(workspaceId: Uuid, provider: Provider): Promise<HealthStatus> {
    const checks = await this.latestHealth(workspaceId, provider);
    return rollUpHealth(
      checks.map((check) => ({
        key: check.key,
        labelDe: check.label_de,
        status: check.status,
        detailDe: check.detail_de,
        checkedAt: check.checked_at,
        remediationDe: check.remediation_de,
        blocksLiveOnly: check.blocks_live_only,
      })),
    );
  }

  getCursor(workspaceId: Uuid, provider: Provider, resource: string): Promise<SyncCursorRow | null> {
    return this.selectMaybe<SyncCursorRow>(
      this.client
        .from('sync_cursors')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('provider', provider)
        .eq('resource', resource)
        .maybeSingle(),
      'integrations.getCursor',
    );
  }

  async setCursor(
    workspaceId: Uuid,
    provider: Provider,
    resource: string,
    patch: { cursor_value?: string | null; cursor_time?: string | null; success: boolean; error?: string | null },
  ): Promise<SyncCursorRow> {
    const now = new Date().toISOString();
    const existing = await this.getCursor(workspaceId, provider, resource);
    const payload = {
      workspace_id: workspaceId,
      provider,
      resource,
      cursor_value: patch.cursor_value ?? existing?.cursor_value ?? null,
      cursor_time: patch.cursor_time ?? existing?.cursor_time ?? null,
      last_run_at: now,
      last_success_at: patch.success ? now : (existing?.last_success_at ?? null),
      last_error: patch.success ? null : (patch.error ?? 'Unbekannter Fehler'),
      consecutive_failures: patch.success ? 0 : (existing?.consecutive_failures ?? 0) + 1,
    };
    const row = await this.selectMaybe<SyncCursorRow>(
      this.client
        .from('sync_cursors')
        .upsert(payload, { onConflict: 'workspace_id,provider,resource' })
        .select('*')
        .single(),
      'integrations.setCursor',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'integrations.setCursor' } });
    return row;
  }

  async enqueueJob(input: SyncJobInsert): Promise<SyncJobRow> {
    const row = await this.selectMaybe<SyncJobRow>(
      this.client.from('sync_jobs').upsert(input, { onConflict: 'idempotency_key' }).select('*').single(),
      'integrations.enqueueJob',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'integrations.enqueueJob' } });
    return row;
  }

  listDueJobs(workspaceId: Uuid, limit = 20): Promise<SyncJobRow[]> {
    return this.selectList<SyncJobRow>(
      this.client
        .from('sync_jobs')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('state', 'QUEUED')
        .lte('scheduled_for', new Date().toISOString())
        .order('scheduled_for')
        .limit(limit),
      'integrations.listDueJobs',
    );
  }

  async startJob(id: Uuid): Promise<SyncJobRow> {
    const current = await this.selectMaybe<SyncJobRow>(
      this.client.from('sync_jobs').select('*').eq('id', id).maybeSingle(),
      'integrations.startJob.read',
    );
    if (!current) throw new DomainError('NOT_FOUND', { details: { context: 'integrations.startJob', id } });

    const row = await this.selectMaybe<SyncJobRow>(
      this.client
        .from('sync_jobs')
        .update({
          state: 'RUNNING',
          started_at: new Date().toISOString(),
          attempt_count: current.attempt_count + 1,
        })
        .eq('id', id)
        .eq('state', 'QUEUED')
        .select('*')
        .maybeSingle(),
      'integrations.startJob',
    );
    if (!row) {
      throw new DomainError('CONFLICT', {
        messageDe: 'Dieser Sync-Auftrag wurde bereits von einem anderen Worker übernommen.',
        details: { id },
      });
    }
    return row;
  }

  async finishJob(
    id: Uuid,
    result: { processed: number; failed: number; error?: string | null; payload?: unknown },
  ): Promise<SyncJobRow> {
    const row = await this.selectMaybe<SyncJobRow>(
      this.client
        .from('sync_jobs')
        .update({
          state: result.error ? 'FAILED' : 'SUCCEEDED',
          finished_at: new Date().toISOString(),
          records_processed: result.processed,
          records_failed: result.failed,
          error: result.error ?? null,
          result: (result.payload ?? null) as SyncJobRow['result'],
        })
        .eq('id', id)
        .select('*')
        .single(),
      'integrations.finishJob',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'integrations.finishJob', id } });
    return row;
  }
}

export function createIntegrationRepository(client: DbClient): IntegrationRepository {
  return new SupabaseIntegrationRepository(client);
}
