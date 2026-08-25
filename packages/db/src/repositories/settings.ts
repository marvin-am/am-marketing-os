/**
 * Workspace settings, role budget limits, members and the brand knowledge the
 * AI context bundle is assembled from.
 *
 * Every threshold the product steers by is persisted here; the constants in
 * `@am/domain` are only the seed values (spec §20, §25).
 */
import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DEFAULT_RECOMMENDATION_CONFIG,
  DEFAULT_ROLE_BUDGET_LIMITS,
  DomainError,
  UNCONFIGURED_RETENTION_POLICY,
  type ExperimentThresholds,
  type RecommendationConfig,
  type RetentionPolicy,
  type Role,
} from '@am/domain';
import type { DbClient } from '../client';
import { SupabaseRepository } from './base';
import type {
  AudienceSegmentRow,
  BrandProfileRow,
  CaseStudyRow,
  EvidenceItemRow,
  FaqRow,
  GuardrailRow,
  OfferRow,
  RoleLimitRow,
  ServiceRow,
  TestimonialRow,
  Updatable,
  Uuid,
  WorkspaceMemberRow,
  WorkspaceRow,
  WorkspaceSettingsRow,
} from '../types';

/** The approved knowledge the AI layer is allowed to read. Nothing else. */
export interface BrandKnowledgeBundle {
  brand: BrandProfileRow | null;
  audiences: AudienceSegmentRow[];
  services: ServiceRow[];
  offers: OfferRow[];
  evidence: EvidenceItemRow[];
  caseStudies: CaseStudyRow[];
  testimonials: TestimonialRow[];
  faqs: FaqRow[];
  guardrails: GuardrailRow[];
}

export interface SettingsRepository {
  getWorkspace(id: Uuid): Promise<WorkspaceRow | null>;
  getWorkspaceBySlug(slug: string): Promise<WorkspaceRow | null>;
  listMembers(workspaceId: Uuid): Promise<WorkspaceMemberRow[]>;
  setMemberRoles(workspaceId: Uuid, profileId: Uuid, roles: Role[]): Promise<WorkspaceMemberRow>;

  getSettings(workspaceId: Uuid): Promise<WorkspaceSettingsRow>;
  updateSettings(workspaceId: Uuid, patch: Updatable<WorkspaceSettingsRow>): Promise<WorkspaceSettingsRow>;
  experimentThresholds(workspaceId: Uuid): Promise<ExperimentThresholds>;
  recommendationConfig(workspaceId: Uuid): Promise<RecommendationConfig>;
  retentionPolicy(workspaceId: Uuid): Promise<RetentionPolicy>;

  listRoleLimits(workspaceId: Uuid): Promise<RoleLimitRow[]>;
  upsertRoleLimit(input: Omit<RoleLimitRow, 'id' | 'created_at' | 'updated_at'>): Promise<RoleLimitRow>;
  /** Falls back to `DEFAULT_ROLE_BUDGET_LIMITS` when nothing is configured. */
  budgetLimitFor(workspaceId: Uuid, role: Role): Promise<RoleLimitRow>;

  /** Single batched read; the AI pipeline must never issue nine queries. */
  brandKnowledge(workspaceId: Uuid, options?: { approvedOnly?: boolean }): Promise<BrandKnowledgeBundle>;
}

const EMPTY_SETTINGS = (workspaceId: Uuid): WorkspaceSettingsRow => ({
  workspace_id: workspaceId,
  experiment_thresholds: {},
  recommendation_config: {},
  retention_policy: {},
  attribution_window_days: 30,
  form_abandon_minutes: 30,
  historical_import_months: 24,
  active_consent_version_id: null,
  vq_model_version: 'vq-1',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  updated_by: null,
});

export class SupabaseSettingsRepository extends SupabaseRepository implements SettingsRepository {
  getWorkspace(id: Uuid): Promise<WorkspaceRow | null> {
    return this.selectMaybe<WorkspaceRow>(
      this.client.from('workspaces').select('*').eq('id', id).maybeSingle(),
      'settings.getWorkspace',
    );
  }

  getWorkspaceBySlug(slug: string): Promise<WorkspaceRow | null> {
    return this.selectMaybe<WorkspaceRow>(
      this.client.from('workspaces').select('*').eq('slug', slug).maybeSingle(),
      'settings.getWorkspaceBySlug',
    );
  }

  listMembers(workspaceId: Uuid): Promise<WorkspaceMemberRow[]> {
    return this.selectList<WorkspaceMemberRow>(
      this.client.from('workspace_members').select('*').eq('workspace_id', workspaceId).order('joined_at'),
      'settings.listMembers',
    );
  }

  async setMemberRoles(workspaceId: Uuid, profileId: Uuid, roles: Role[]): Promise<WorkspaceMemberRow> {
    if (roles.length === 0) {
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Ein Mitglied benötigt mindestens eine Rolle.',
        details: { workspaceId, profileId },
      });
    }
    const row = await this.selectMaybe<WorkspaceMemberRow>(
      this.client
        .from('workspace_members')
        .update({ roles })
        .eq('workspace_id', workspaceId)
        .eq('profile_id', profileId)
        .select('*')
        .single(),
      'settings.setMemberRoles',
    );
    if (!row) throw new DomainError('NOT_FOUND', { details: { context: 'settings.setMemberRoles' } });
    return row;
  }

  async getSettings(workspaceId: Uuid): Promise<WorkspaceSettingsRow> {
    const row = await this.selectMaybe<WorkspaceSettingsRow>(
      this.client.from('workspace_settings').select('*').eq('workspace_id', workspaceId).maybeSingle(),
      'settings.getSettings',
    );
    return row ?? EMPTY_SETTINGS(workspaceId);
  }

  async updateSettings(
    workspaceId: Uuid,
    patch: Updatable<WorkspaceSettingsRow>,
  ): Promise<WorkspaceSettingsRow> {
    const row = await this.selectMaybe<WorkspaceSettingsRow>(
      this.client
        .from('workspace_settings')
        .upsert({ workspace_id: workspaceId, ...patch }, { onConflict: 'workspace_id' })
        .select('*')
        .single(),
      'settings.updateSettings',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'settings.updateSettings' } });
    return row;
  }

  async experimentThresholds(workspaceId: Uuid): Promise<ExperimentThresholds> {
    const settings = await this.getSettings(workspaceId);
    return { ...DEFAULT_EXPERIMENT_THRESHOLDS, ...(settings.experiment_thresholds as Partial<ExperimentThresholds>) };
  }

  async recommendationConfig(workspaceId: Uuid): Promise<RecommendationConfig> {
    const settings = await this.getSettings(workspaceId);
    return {
      ...DEFAULT_RECOMMENDATION_CONFIG,
      ...(settings.recommendation_config as Partial<RecommendationConfig>),
    };
  }

  async retentionPolicy(workspaceId: Uuid): Promise<RetentionPolicy> {
    const settings = await this.getSettings(workspaceId);
    return { ...UNCONFIGURED_RETENTION_POLICY, ...(settings.retention_policy as Partial<RetentionPolicy>) };
  }

  listRoleLimits(workspaceId: Uuid): Promise<RoleLimitRow[]> {
    return this.selectList<RoleLimitRow>(
      this.client.from('role_limits').select('*').eq('workspace_id', workspaceId).order('role'),
      'settings.listRoleLimits',
    );
  }

  async upsertRoleLimit(
    input: Omit<RoleLimitRow, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<RoleLimitRow> {
    const row = await this.selectMaybe<RoleLimitRow>(
      this.client.from('role_limits').upsert(input, { onConflict: 'workspace_id,role' }).select('*').single(),
      'settings.upsertRoleLimit',
    );
    if (!row) throw new DomainError('INTERNAL', { details: { context: 'settings.upsertRoleLimit' } });
    return row;
  }

  async budgetLimitFor(workspaceId: Uuid, role: Role): Promise<RoleLimitRow> {
    const limits = await this.listRoleLimits(workspaceId);
    const configured = limits.find((limit) => limit.role === role);
    if (configured) return configured;

    const fallback = DEFAULT_ROLE_BUDGET_LIMITS[role];
    return {
      id: `${workspaceId}:${role}`,
      workspace_id: workspaceId,
      role,
      max_single_increase_pct: fallback.maxSingleIncreasePct,
      max_daily_budget_minor: fallback.maxDailyBudgetMinor,
      max_scales_per_24h: fallback.maxScalesPer24h,
      may_pause: fallback.mayPause,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      created_by: null,
      updated_by: null,
    };
  }

  async brandKnowledge(
    workspaceId: Uuid,
    options: { approvedOnly?: boolean } = {},
  ): Promise<BrandKnowledgeBundle> {
    const approvedOnly = options.approvedOnly ?? true;
    const approved = <T extends { eq: (column: string, value: unknown) => T }>(builder: T): T =>
      approvedOnly ? builder.eq('approved', true) : builder;

    const [brand, audiences, services, offers, evidence, caseStudies, testimonials, faqs, guardrails] =
      await Promise.all([
        this.selectMaybe<BrandProfileRow>(
          this.client
            .from('brand_profiles')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('is_default', true)
            .maybeSingle(),
          'settings.brandKnowledge.brand',
        ),
        this.selectList<AudienceSegmentRow>(
          this.client
            .from('audience_segments')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('is_active', true)
            .order('sort_order'),
          'settings.brandKnowledge.audiences',
        ),
        this.selectList<ServiceRow>(
          this.client.from('services').select('*').eq('workspace_id', workspaceId).eq('is_active', true),
          'settings.brandKnowledge.services',
        ),
        this.selectList<OfferRow>(
          this.client.from('offers').select('*').eq('workspace_id', workspaceId).eq('is_active', true),
          'settings.brandKnowledge.offers',
        ),
        this.selectList<EvidenceItemRow>(
          approved(this.client.from('evidence_items').select('*').eq('workspace_id', workspaceId)),
          'settings.brandKnowledge.evidence',
        ),
        this.selectList<CaseStudyRow>(
          approved(this.client.from('case_studies').select('*').eq('workspace_id', workspaceId)),
          'settings.brandKnowledge.caseStudies',
        ),
        this.selectList<TestimonialRow>(
          approved(this.client.from('testimonials').select('*').eq('workspace_id', workspaceId)),
          'settings.brandKnowledge.testimonials',
        ),
        this.selectList<FaqRow>(
          approved(this.client.from('faqs').select('*').eq('workspace_id', workspaceId).order('sort_order')),
          'settings.brandKnowledge.faqs',
        ),
        this.selectList<GuardrailRow>(
          this.client.from('guardrails').select('*').eq('workspace_id', workspaceId).eq('is_active', true),
          'settings.brandKnowledge.guardrails',
        ),
      ]);

    return { brand, audiences, services, offers, evidence, caseStudies, testimonials, faqs, guardrails };
  }
}

export function createSettingsRepository(client: DbClient): SettingsRepository {
  return new SupabaseSettingsRepository(client);
}
