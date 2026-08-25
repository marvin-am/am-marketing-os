/**
 * Recommendations and the audit trail of what an operator did with them.
 *
 * A recommendation is produced by the deterministic rules engine; the state
 * machine here never fabricates an execution result — `EXECUTED` requires a
 * command that reached `PROVIDER_CONFIRMED` (AGENTS rule 3).
 */
import { DomainError, isProviderConfirmed, type CommandState, type RecommendationState } from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, SupabaseRepository, uniqueIds } from './base';
import type {
  ExternalCommandRow,
  RecommendationActionInsert,
  RecommendationActionRow,
  RecommendationInsert,
  RecommendationRow,
  Updatable,
  Uuid,
} from '../types';

export interface RecommendationRepository {
  listOpen(workspaceId: Uuid): Promise<RecommendationRow[]>;
  listByCampaign(campaignId: Uuid, states?: RecommendationState[]): Promise<RecommendationRow[]>;
  getById(id: Uuid): Promise<RecommendationRow | null>;
  /** Idempotent per `(campaign_id, rule_id, dedup_key)` while still OPEN. */
  upsert(input: RecommendationInsert): Promise<RecommendationRow>;
  update(id: Uuid, patch: Updatable<RecommendationRow>): Promise<RecommendationRow>;
  accept(id: Uuid, actorId: Uuid | null): Promise<RecommendationRow>;
  dismiss(id: Uuid, actorId: Uuid | null, noteDe?: string): Promise<RecommendationRow>;
  markExecuting(id: Uuid, commandId: Uuid, actorId: Uuid | null): Promise<RecommendationRow>;
  /** Only a provider-confirmed command may complete a recommendation. */
  completeFromCommand(id: Uuid, command: Pick<ExternalCommandRow, 'id' | 'state' | 'error'>): Promise<RecommendationRow>;
  supersede(id: Uuid, supersededBy: Uuid): Promise<RecommendationRow>;
  recordAction(input: RecommendationActionInsert): Promise<RecommendationActionRow>;
  listActions(recommendationId: Uuid): Promise<RecommendationActionRow[]>;
  loadActionsFor(recommendationIds: readonly Uuid[]): Promise<Map<Uuid, RecommendationActionRow[]>>;
}

export class SupabaseRecommendationRepository
  extends SupabaseRepository
  implements RecommendationRepository
{
  listOpen(workspaceId: Uuid): Promise<RecommendationRow[]> {
    return this.selectList<RecommendationRow>(
      this.client
        .from('recommendations')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('state', 'OPEN')
        .order('created_at', { ascending: false }),
      'recommendations.listOpen',
    );
  }

  listByCampaign(campaignId: Uuid, states?: RecommendationState[]): Promise<RecommendationRow[]> {
    let query = this.client.from('recommendations').select('*').eq('campaign_id', campaignId);
    if (states?.length) query = query.in('state', states);
    return this.selectList<RecommendationRow>(
      query.order('created_at', { ascending: false }),
      'recommendations.listByCampaign',
    );
  }

  getById(id: Uuid): Promise<RecommendationRow | null> {
    return this.selectMaybe<RecommendationRow>(
      this.client.from('recommendations').select('*').eq('id', id).maybeSingle(),
      'recommendations.getById',
    );
  }

  async upsert(input: RecommendationInsert): Promise<RecommendationRow> {
    const existing = await this.selectMaybe<RecommendationRow>(
      this.client
        .from('recommendations')
        .select('*')
        .eq('campaign_id', input.campaign_id)
        .eq('rule_id', input.rule_id)
        .eq('dedup_key', input.dedup_key)
        .eq('state', 'OPEN')
        .maybeSingle(),
      'recommendations.upsert.lookup',
    );

    if (existing) return this.update(existing.id, { ...input, id: undefined } as Updatable<RecommendationRow>);

    const row = await this.selectMaybe<RecommendationRow>(
      this.client.from('recommendations').insert(input).select('*').single(),
      'recommendations.upsert.insert',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'recommendations.upsert' } });
    return row;
  }

  async update(id: Uuid, patch: Updatable<RecommendationRow>): Promise<RecommendationRow> {
    const row = await this.selectMaybe<RecommendationRow>(
      this.client.from('recommendations').update(patch).eq('id', id).select('*').single(),
      'recommendations.update',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'recommendations.update', id } });
    return row;
  }

  async accept(id: Uuid, actorId: Uuid | null): Promise<RecommendationRow> {
    const row = await this.update(id, { state: 'ACCEPTED', updated_by: actorId });
    await this.recordAction({
      workspace_id: row.workspace_id,
      recommendation_id: id,
      action: 'ACCEPTED',
      actor_id: actorId,
      actor_label: actorId ?? 'system',
    });
    return row;
  }

  async dismiss(id: Uuid, actorId: Uuid | null, noteDe?: string): Promise<RecommendationRow> {
    const row = await this.update(id, { state: 'DISMISSED', updated_by: actorId });
    await this.recordAction({
      workspace_id: row.workspace_id,
      recommendation_id: id,
      action: 'DISMISSED',
      actor_id: actorId,
      actor_label: actorId ?? 'system',
      note_de: noteDe ?? null,
    });
    return row;
  }

  async markExecuting(id: Uuid, commandId: Uuid, actorId: Uuid | null): Promise<RecommendationRow> {
    const row = await this.update(id, { state: 'EXECUTING', updated_by: actorId });
    await this.recordAction({
      workspace_id: row.workspace_id,
      recommendation_id: id,
      action: 'EXECUTION_STARTED',
      external_command_id: commandId,
      command_state: 'QUEUED',
      actor_id: actorId,
      actor_label: actorId ?? 'system',
    });
    return row;
  }

  async completeFromCommand(
    id: Uuid,
    command: Pick<ExternalCommandRow, 'id' | 'state' | 'error'>,
  ): Promise<RecommendationRow> {
    const confirmed = isProviderConfirmed({
      state: command.state as CommandState,
    } as Parameters<typeof isProviderConfirmed>[0]);

    const row = await this.update(id, { state: confirmed ? 'EXECUTED' : 'EXECUTION_FAILED' });
    await this.recordAction({
      workspace_id: row.workspace_id,
      recommendation_id: id,
      action: confirmed ? 'EXECUTED' : 'EXECUTION_FAILED',
      external_command_id: command.id,
      command_state: command.state,
      actor_label: 'system',
      executed_at: new Date().toISOString(),
      provider_confirmed_at: confirmed ? new Date().toISOString() : null,
      error: confirmed ? null : (command.error ?? 'Der Provider hat die Aktion nicht bestätigt.'),
    });
    return row;
  }

  supersede(id: Uuid, supersededBy: Uuid): Promise<RecommendationRow> {
    return this.update(id, { state: 'SUPERSEDED', superseded_by: supersededBy });
  }

  async recordAction(input: RecommendationActionInsert): Promise<RecommendationActionRow> {
    const row = await this.selectMaybe<RecommendationActionRow>(
      this.client.from('recommendation_actions').insert(input).select('*').single(),
      'recommendations.recordAction',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'recommendations.recordAction' } });
    return row;
  }

  listActions(recommendationId: Uuid): Promise<RecommendationActionRow[]> {
    return this.selectList<RecommendationActionRow>(
      this.client
        .from('recommendation_actions')
        .select('*')
        .eq('recommendation_id', recommendationId)
        .order('created_at'),
      'recommendations.listActions',
    );
  }

  async loadActionsFor(recommendationIds: readonly Uuid[]): Promise<Map<Uuid, RecommendationActionRow[]>> {
    const ids = uniqueIds(recommendationIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<RecommendationActionRow>(
      this.client.from('recommendation_actions').select('*').in('recommendation_id', ids).order('created_at'),
      'recommendations.loadActionsFor',
    );
    return groupBy(rows, (row) => row.recommendation_id);
  }
}

export function createRecommendationRepository(client: DbClient): RecommendationRepository {
  return new SupabaseRecommendationRepository(client);
}
