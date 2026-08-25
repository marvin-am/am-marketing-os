/**
 * Experiment aggregate.
 *
 * Assignment and exposure go through RPCs because both must be atomic against
 * their unique constraints: an arm survives reload and return visits
 * (criterion 11) and one render produces exactly one exposure (criterion 12).
 */
import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DomainError,
  type ExperimentState,
  type ExperimentVerdict,
} from '@am/domain';
import type { DbClient } from '../client';
import { groupBy, indexBy, SupabaseRepository, uniqueIds } from './base';
import { toDomainError } from '../errors';
import type {
  ExperimentArmInsert,
  ExperimentArmRow,
  ExperimentAssignmentRow,
  ExperimentExposureRow,
  ExperimentInsert,
  ExperimentResultInsert,
  ExperimentResultRow,
  ExperimentRow,
  Updatable,
  Uuid,
} from '../types';

/** Per-arm counts fed into the statistics engine. */
export interface ArmObservationRow {
  arm_id: Uuid;
  arm_key: string;
  label: string;
  is_control: boolean;
  sessions: number;
  exposures: number;
  conversions: number;
  vq_scheduled: number;
  vq_attended: number;
  qualified_vq: number;
  opportunities: number;
  closed_won: number;
  revenue_minor: number;
  spend_minor: number;
  attribution_coverage: number | null;
}

const LOCKED_STATES: readonly ExperimentState[] = ['RUNNING', 'PAUSED', 'CONCLUDED'];

const DAY_MS = 86_400_000;

/**
 * Whether an experiment's CRM cohort has aged past the maturity window it ran
 * with. Reads the persisted thresholds, not the current defaults: changing the
 * setting today must not retroactively mature a cohort that concluded last year.
 */
export function isCrmMature(
  experiment: Pick<ExperimentRow, 'concluded_at' | 'thresholds'>,
  now: string,
): boolean {
  if (!experiment.concluded_at) return false;
  const configured = (experiment.thresholds as { crmMaturityDays?: unknown }).crmMaturityDays;
  const days =
    typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_EXPERIMENT_THRESHOLDS.crmMaturityDays;
  return Date.parse(now) - Date.parse(experiment.concluded_at) >= days * DAY_MS;
}

export interface ExperimentRepository {
  listByCampaign(campaignId: Uuid): Promise<ExperimentRow[]>;
  listByWorkspace(workspaceId: Uuid, states?: ExperimentState[]): Promise<ExperimentRow[]>;
  getById(id: Uuid): Promise<ExperimentRow | null>;
  create(input: ExperimentInsert): Promise<ExperimentRow>;
  update(id: Uuid, patch: Updatable<ExperimentRow>): Promise<ExperimentRow>;
  start(id: Uuid, actorId: Uuid | null): Promise<ExperimentRow>;
  pause(id: Uuid, actorId: Uuid | null): Promise<ExperimentRow>;
  conclude(
    id: Uuid,
    verdict: ExperimentVerdict,
    winningArmId: Uuid | null,
    actorId: Uuid | null,
  ): Promise<ExperimentRow>;

  listArms(experimentId: Uuid): Promise<ExperimentArmRow[]>;
  createArms(inputs: readonly ExperimentArmInsert[]): Promise<ExperimentArmRow[]>;
  loadArmsForExperiments(experimentIds: readonly Uuid[]): Promise<Map<Uuid, ExperimentArmRow[]>>;

  /** Idempotent: returns the arm the visitor already has, if any. */
  assign(experimentId: Uuid, visitorId: Uuid, armId: Uuid, bucket: number): Promise<Uuid>;
  getAssignment(experimentId: Uuid, visitorId: Uuid): Promise<ExperimentAssignmentRow | null>;
  /** True when this render produced a new exposure row. */
  recordExposure(experimentId: Uuid, visitorId: Uuid, sessionId: Uuid, armId: Uuid): Promise<boolean>;
  listExposures(experimentId: Uuid): Promise<ExperimentExposureRow[]>;

  /**
   * Concluded experiments that still owe a learning card.
   *
   * "Still owe" means two things at once: no learning card references the
   * experiment, *and* its CRM cohort has aged past the maturity window from the
   * thresholds it actually ran with. Writing a card before the cohort matures
   * would freeze a conclusion drawn from half a funnel.
   */
  listConcludedWithoutCards(workspaceId: Uuid, now: string): Promise<ExperimentRow[]>;

  observations(experimentId: Uuid): Promise<ArmObservationRow[]>;
  saveResult(input: ExperimentResultInsert): Promise<ExperimentResultRow>;
  latestResult(experimentId: Uuid): Promise<ExperimentResultRow | null>;
  loadLatestResultsFor(experimentIds: readonly Uuid[]): Promise<Map<Uuid, ExperimentResultRow>>;
}

export class SupabaseExperimentRepository extends SupabaseRepository implements ExperimentRepository {
  listByCampaign(campaignId: Uuid): Promise<ExperimentRow[]> {
    return this.selectList<ExperimentRow>(
      this.client
        .from('experiments')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false }),
      'experiments.listByCampaign',
    );
  }

  listByWorkspace(workspaceId: Uuid, states?: ExperimentState[]): Promise<ExperimentRow[]> {
    let query = this.client.from('experiments').select('*').eq('workspace_id', workspaceId);
    if (states?.length) query = query.in('state', states);
    return this.selectList<ExperimentRow>(
      query.order('created_at', { ascending: false }),
      'experiments.listByWorkspace',
    );
  }

  getById(id: Uuid): Promise<ExperimentRow | null> {
    return this.selectMaybe<ExperimentRow>(
      this.client.from('experiments').select('*').eq('id', id).maybeSingle(),
      'experiments.getById',
    );
  }

  async create(input: ExperimentInsert): Promise<ExperimentRow> {
    const row = await this.selectMaybe<ExperimentRow>(
      this.client.from('experiments').insert(input).select('*').single(),
      'experiments.create',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'experiments.create' } });
    return row;
  }

  async update(id: Uuid, patch: Updatable<ExperimentRow>): Promise<ExperimentRow> {
    const row = await this.selectMaybe<ExperimentRow>(
      this.client.from('experiments').update(patch).eq('id', id).select('*').single(),
      'experiments.update',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'experiments.update', id } });
    return row;
  }

  async start(id: Uuid, actorId: Uuid | null): Promise<ExperimentRow> {
    const current = await this.getById(id);
    if (!current) throw new DomainError('NOT_FOUND', { details: { context: 'experiments.start', id } });
    if (current.state === 'RUNNING') return current;
    if (current.state !== 'DRAFT' && current.state !== 'READY' && current.state !== 'PAUSED') {
      throw new DomainError('CONFLICT', {
        messageDe: 'Nur Experimente im Status Entwurf, Bereit oder Pausiert können gestartet werden.',
        details: { state: current.state },
      });
    }
    const arms = await this.listArms(id);
    if (arms.length < 2) {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Ein Experiment benötigt mindestens zwei Arme (Kontrolle und Variante).',
        details: { armCount: arms.length },
      });
    }
    if (!arms.some((arm) => arm.is_control)) {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Ein Experiment benötigt genau einen Kontrollarm.',
        details: { experimentId: id },
      });
    }
    return this.update(id, {
      state: 'RUNNING',
      started_at: current.started_at ?? new Date().toISOString(),
      updated_by: actorId,
    });
  }

  pause(id: Uuid, actorId: Uuid | null): Promise<ExperimentRow> {
    return this.update(id, { state: 'PAUSED', paused_at: new Date().toISOString(), updated_by: actorId });
  }

  // `async` on purpose: a method typed `Promise<…>` must reject rather than
  // throw synchronously, or a caller's `.catch()` never runs.
  async conclude(
    id: Uuid,
    verdict: ExperimentVerdict,
    winningArmId: Uuid | null,
    actorId: Uuid | null,
  ): Promise<ExperimentRow> {
    if ((verdict === 'WINNER' || verdict === 'PROVISIONAL') && !winningArmId) {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Für die Verdikte „Gewinner“ und „Vorläufig führend“ muss ein Gewinnerarm benannt werden.',
        details: { verdict },
      });
    }
    return this.update(id, {
      state: 'CONCLUDED',
      verdict,
      winning_arm_id: winningArmId,
      concluded_at: new Date().toISOString(),
      updated_by: actorId,
    });
  }

  listArms(experimentId: Uuid): Promise<ExperimentArmRow[]> {
    return this.selectList<ExperimentArmRow>(
      this.client
        .from('experiment_arms')
        .select('*')
        .eq('experiment_id', experimentId)
        .order('is_control', { ascending: false })
        .order('sort_order'),
      'experiments.listArms',
    );
  }

  async createArms(inputs: readonly ExperimentArmInsert[]): Promise<ExperimentArmRow[]> {
    if (inputs.length === 0) return [];
    const experimentId = inputs[0].experiment_id;
    const experiment = await this.getById(experimentId);
    if (experiment && LOCKED_STATES.includes(experiment.state)) {
      throw new DomainError('IMMUTABLE_VERSION', {
        messageDe: 'Arme eines laufenden oder beendeten Experiments können nicht mehr geändert werden.',
        details: { experimentId, state: experiment.state },
      });
    }
    return this.selectList<ExperimentArmRow>(
      this.client.from('experiment_arms').insert(inputs as ExperimentArmInsert[]).select('*'),
      'experiments.createArms',
    );
  }

  async loadArmsForExperiments(experimentIds: readonly Uuid[]): Promise<Map<Uuid, ExperimentArmRow[]>> {
    const ids = uniqueIds(experimentIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<ExperimentArmRow>(
      this.client
        .from('experiment_arms')
        .select('*')
        .in('experiment_id', ids)
        .order('is_control', { ascending: false })
        .order('sort_order'),
      'experiments.loadArmsForExperiments',
    );
    return groupBy(rows, (row) => row.experiment_id);
  }

  async assign(experimentId: Uuid, visitorId: Uuid, armId: Uuid, bucket: number): Promise<Uuid> {
    const result = await this.client.rpc('assign_experiment_arm', {
      p_experiment_id: experimentId,
      p_visitor_id: visitorId,
      p_arm_id: armId,
      p_bucket: bucket,
    });
    if (result.error) throw toDomainError(result.error, 'experiments.assign');
    return result.data as Uuid;
  }

  getAssignment(experimentId: Uuid, visitorId: Uuid): Promise<ExperimentAssignmentRow | null> {
    return this.selectMaybe<ExperimentAssignmentRow>(
      this.client
        .from('experiment_assignments')
        .select('*')
        .eq('experiment_id', experimentId)
        .eq('visitor_id', visitorId)
        .maybeSingle(),
      'experiments.getAssignment',
    );
  }

  async recordExposure(
    experimentId: Uuid,
    visitorId: Uuid,
    sessionId: Uuid,
    armId: Uuid,
  ): Promise<boolean> {
    const result = await this.client.rpc('record_experiment_exposure', {
      p_experiment_id: experimentId,
      p_visitor_id: visitorId,
      p_session_id: sessionId,
      p_arm_id: armId,
    });
    if (result.error) throw toDomainError(result.error, 'experiments.recordExposure');
    return result.data === true;
  }

  listExposures(experimentId: Uuid): Promise<ExperimentExposureRow[]> {
    return this.selectList<ExperimentExposureRow>(
      this.client
        .from('experiment_exposures')
        .select('*')
        .eq('experiment_id', experimentId)
        .order('exposed_at'),
      'experiments.listExposures',
    );
  }

  async listConcludedWithoutCards(workspaceId: Uuid, now: string): Promise<ExperimentRow[]> {
    const [concluded, cards] = await Promise.all([
      this.selectList<ExperimentRow>(
        this.client
          .from('experiments')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('state', 'CONCLUDED')
          .not('concluded_at', 'is', null)
          .order('concluded_at', { ascending: true }),
        'experiments.listConcludedWithoutCards.experiments',
      ),
      this.selectList<{ experiment_id: Uuid | null }>(
        this.client
          .from('learning_cards')
          .select('experiment_id')
          .eq('workspace_id', workspaceId)
          .not('experiment_id', 'is', null),
        'experiments.listConcludedWithoutCards.cards',
      ),
    ]);

    const covered = new Set(cards.map((card) => card.experiment_id).filter(Boolean));
    return concluded.filter((experiment) => !covered.has(experiment.id) && isCrmMature(experiment, now));
  }

  /**
   * Counts per arm without an N+1: exposures and submissions are each fetched
   * once and folded in memory. The equivalent single-statement SQL is
   * `EXPERIMENT_ARM_OBSERVATIONS_SQL` in `../sql`, used by the `pg`-based jobs.
   */
  async observations(experimentId: Uuid): Promise<ArmObservationRow[]> {
    const [arms, exposures, submissions] = await Promise.all([
      this.listArms(experimentId),
      this.selectList<{ arm_id: Uuid; session_id: Uuid }>(
        this.client.from('experiment_exposures').select('arm_id,session_id').eq('experiment_id', experimentId),
        'experiments.observations.exposures',
      ),
      this.selectList<{
        experiment_arm_id: Uuid | null;
        state: string;
        leads: { vq_status: string; id: Uuid } | { vq_status: string; id: Uuid }[] | null;
      }>(
        this.client
          .from('form_submissions')
          .select('experiment_arm_id,state,leads(id,vq_status)')
          .eq('experiment_id', experimentId)
          .eq('traffic_kind', 'PRODUCTION'),
        'experiments.observations.submissions',
      ),
    ]);

    const exposuresByArm = groupBy(exposures, (row) => row.arm_id);
    const submissionsByArm = groupBy(submissions, (row) => row.experiment_arm_id);

    return arms.map((arm) => {
      const armExposures = exposuresByArm.get(arm.id) ?? [];
      const armSubmissions = submissionsByArm.get(arm.id) ?? [];
      const leadStatuses = armSubmissions
        .map((row) => (Array.isArray(row.leads) ? row.leads[0] : row.leads))
        .filter((lead): lead is { vq_status: string; id: Uuid } => Boolean(lead));

      return {
        arm_id: arm.id,
        arm_key: arm.key,
        label: arm.label,
        is_control: arm.is_control,
        sessions: new Set(armExposures.map((row) => row.session_id)).size,
        exposures: armExposures.length,
        conversions: armSubmissions.filter((row) => row.state.startsWith('ACCEPTED') || row.state.startsWith('HUBSPOT'))
          .length,
        vq_scheduled: leadStatuses.filter((lead) => lead.vq_status !== 'NOT_SCHEDULED').length,
        vq_attended: leadStatuses.filter((lead) =>
          ['ATTENDED', 'PASSED', 'REJECTED'].includes(lead.vq_status),
        ).length,
        qualified_vq: leadStatuses.filter((lead) => lead.vq_status === 'PASSED').length,
        opportunities: 0,
        closed_won: 0,
        revenue_minor: 0,
        spend_minor: 0,
        attribution_coverage: null,
      } satisfies ArmObservationRow;
    });
  }

  async saveResult(input: ExperimentResultInsert): Promise<ExperimentResultRow> {
    const row = await this.selectMaybe<ExperimentResultRow>(
      this.client
        .from('experiment_results')
        .upsert(input, { onConflict: 'experiment_id,computed_at' })
        .select('*')
        .single(),
      'experiments.saveResult',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'experiments.saveResult' } });
    return row;
  }

  async latestResult(experimentId: Uuid): Promise<ExperimentResultRow | null> {
    const rows = await this.selectList<ExperimentResultRow>(
      this.client
        .from('experiment_results')
        .select('*')
        .eq('experiment_id', experimentId)
        .order('computed_at', { ascending: false })
        .limit(1),
      'experiments.latestResult',
    );
    return rows[0] ?? null;
  }

  async loadLatestResultsFor(experimentIds: readonly Uuid[]): Promise<Map<Uuid, ExperimentResultRow>> {
    const ids = uniqueIds(experimentIds);
    if (ids.length === 0) return new Map();
    const rows = await this.selectList<ExperimentResultRow>(
      this.client
        .from('experiment_results')
        .select('*')
        .in('experiment_id', ids)
        .order('computed_at', { ascending: false }),
      'experiments.loadLatestResultsFor',
    );
    // Rows arrive newest first, so `indexBy` keeps the first occurrence per id.
    return indexBy(rows, (row) => row.experiment_id);
  }
}

export function createExperimentRepository(client: DbClient): ExperimentRepository {
  return new SupabaseExperimentRepository(client);
}
