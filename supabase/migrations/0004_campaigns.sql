-- =============================================================================
-- 0004_campaigns.sql — campaigns, versions, proposals, angles, approvals
-- =============================================================================
-- `state` and `error_state` are separate columns on purpose (spec §10): a failed
-- Meta sync must never destroy the fact that a campaign is STRATEGY_APPROVED.
-- =============================================================================

create table public.campaigns (
  id                                 uuid primary key default gen_random_uuid(),
  workspace_id                       uuid        not null references public.workspaces (id) on delete cascade,
  name                               text        not null,
  slug                               text        not null,
  -- Mirrors CAMPAIGN_STATES.
  state                              text        not null default 'IDEA' check (state in (
                                       'IDEA','PROPOSED','STRATEGY_REVIEW','STRATEGY_APPROVED',
                                       'ASSET_GENERATION','ASSET_REVIEW','TEST_PLAN_REVIEW',
                                       'READY_FOR_LAUNCH_QA','READY_FOR_META_DRAFT','META_DRAFT_CREATED',
                                       'SCHEDULED','LIVE','PAUSED','COMPLETED','ARCHIVED')),
  -- Mirrors CAMPAIGN_ERROR_STATES. Independent of `state`.
  error_state                        text        check (error_state in (
                                       'GENERATION_FAILED','PUBLISH_FAILED','META_SYNC_FAILED',
                                       'TRACKING_FAILED','HUBSPOT_SYNC_FAILED')),
  error_detail_de                    text,
  brand_profile_id                   uuid        references public.brand_profiles (id) on delete set null,
  audience_segment_id                uuid        references public.audience_segments (id) on delete set null,
  service_id                         uuid        references public.services (id) on delete set null,
  offer_id                           uuid        references public.offers (id) on delete set null,
  offer_version_id                   uuid        references public.offer_versions (id) on delete set null,
  angle_id                           uuid,
  angle_version_id                   uuid,
  current_version_id                 uuid,
  core_message                       text,
  hypothesis                         text,
  currency                           text        not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  daily_budget_minor                 bigint      not null default 0 check (daily_budget_minor >= 0),
  test_budget_minor                  bigint      not null default 0 check (test_budget_minor >= 0),
  target_cpl_minor                   bigint      check (target_cpl_minor >= 0),
  target_cost_per_qualified_vq_minor bigint      check (target_cost_per_qualified_vq_minor >= 0),
  -- Mirrors METRIC_KEYS.
  primary_metric                     text        check (primary_metric in (
                                       'impressions','link_clicks','ctr','cpc','cpm','spend','funnel_sessions',
                                       'form_start_rate','step_dropoff','submission_rate','leads','cpl',
                                       'vq_scheduled','vq_scheduled_rate','show_rate','qualified_vq',
                                       'qualified_vq_rate','cost_per_qualified_vq','opportunities',
                                       'opportunity_rate','closed_won','close_rate','cac','revenue','roas')),
  secondary_metrics                  text[]      not null default '{}',
  guardrail_metrics                  text[]      not null default '{}',
  attribution_level                  text        not null default 'CREATIVE_ONLY' check (attribution_level in (
                                       'CREATIVE_ONLY','TRAFFIC_LINKED','LEAD_LINKED','REVENUE_LINKED')),
  tags                               text[]      not null default '{}',
  planned_start_at                   timestamptz,
  planned_end_at                     timestamptz,
  launched_at                        timestamptz,
  paused_at                          timestamptz,
  completed_at                       timestamptz,
  archived_at                        timestamptz,
  -- Historical import provenance; NULL for campaigns created in the console.
  imported_from_provider             text,
  imported_external_id               text,
  created_at                         timestamptz not null default now(),
  updated_at                         timestamptz not null default now(),
  created_by                         uuid,
  updated_by                         uuid,
  constraint campaigns_slug_unique unique (workspace_id, slug)
);

create unique index campaigns_imported_external_key
  on public.campaigns (imported_from_provider, imported_external_id)
  where imported_external_id is not null;

create index campaigns_workspace_state_idx on public.campaigns (workspace_id, state);
create index campaigns_workspace_updated_idx on public.campaigns (workspace_id, updated_at desc);
create index campaigns_name_trgm on public.campaigns using gin (name gin_trgm_ops);

create table public.campaign_versions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid        not null references public.campaigns (id) on delete cascade,
  version       integer     not null check (version >= 1),
  state         text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  -- The complete delivered specification: audience, angle, offer, claims, budget.
  spec          jsonb       not null,
  content_hash  char(64)    not null,
  notes         text,
  published_at  timestamptz,
  published_by  uuid,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid,
  constraint campaign_versions_unique unique (campaign_id, version),
  constraint campaign_versions_published_has_time check (state <> 'PUBLISHED' or published_at is not null)
);
create index campaign_versions_campaign_idx on public.campaign_versions (campaign_id, version desc);
create index campaign_versions_workspace_idx on public.campaign_versions (workspace_id);

alter table public.campaigns
  add constraint campaigns_current_version_fkey
  foreign key (current_version_id) references public.campaign_versions (id) on delete set null;

create table public.angles (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  name                     text        not null,
  perspective              text        not null,
  rationale                text        not null default '',
  keywords                 text[]      not null default '{}',
  current_version_id       uuid,
  first_used_campaign_id   uuid        references public.campaigns (id) on delete set null,
  last_used_at             timestamptz,
  use_count                integer     not null default 0 check (use_count >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid,
  updated_by               uuid
);
create index angles_workspace_idx on public.angles (workspace_id, last_used_at desc nulls last);
create index angles_name_trgm on public.angles using gin (name gin_trgm_ops);

create table public.angle_versions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  angle_id      uuid        not null references public.angles (id) on delete cascade,
  version       integer     not null check (version >= 1),
  state         text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  -- angleSpecSchema
  spec          jsonb       not null,
  content_hash  char(64)    not null,
  -- classifyAngleSimilarity() result at the time this version was created.
  distinctness_verdict text check (distinctness_verdict in ('DISTINCT','ITERATION','TOO_SIMILAR')),
  max_similarity numeric(6,5) check (max_similarity between 0 and 1),
  published_at  timestamptz,
  published_by  uuid,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid,
  constraint angle_versions_unique unique (angle_id, version)
);
create index angle_versions_angle_idx on public.angle_versions (angle_id, version desc);
create index angle_versions_workspace_idx on public.angle_versions (workspace_id);

alter table public.angles
  add constraint angles_current_version_fkey
  foreign key (current_version_id) references public.angle_versions (id) on delete set null;

alter table public.campaigns
  add constraint campaigns_angle_fkey foreign key (angle_id) references public.angles (id) on delete set null,
  add constraint campaigns_angle_version_fkey foreign key (angle_version_id) references public.angle_versions (id) on delete set null;

create table public.campaign_angles (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id       uuid        not null references public.campaigns (id) on delete cascade,
  angle_id          uuid        not null references public.angles (id) on delete cascade,
  angle_version_id  uuid        not null references public.angle_versions (id) on delete cascade,
  role              text        not null default 'PRIMARY' check (role in ('PRIMARY','SECONDARY')),
  created_at        timestamptz not null default now(),
  created_by        uuid,
  constraint campaign_angles_unique unique (campaign_id, angle_version_id)
);
create unique index campaign_angles_primary_key
  on public.campaign_angles (campaign_id) where role = 'PRIMARY';
create index campaign_angles_angle_idx on public.campaign_angles (angle_id);

create table public.campaign_proposals (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id        uuid        not null references public.campaigns (id) on delete cascade,
  ai_job_id          uuid,
  prompt_version_id  uuid,
  model              text        not null default '',
  generation_index   integer     not null default 1 check (generation_index >= 1),
  -- campaignProposalSchema — validated before it is written, never partially applied.
  proposal           jsonb       not null,
  content_hash       char(64)    not null,
  diversity_score    numeric(6,5) check (diversity_score between 0 and 1),
  angle_verdict      text        check (angle_verdict in ('DISTINCT','ITERATION','TOO_SIMILAR')),
  max_similarity     numeric(6,5) check (max_similarity between 0 and 1),
  similar_campaigns  jsonb       not null default '[]'::jsonb,
  accepted           boolean     not null default false,
  accepted_at        timestamptz,
  accepted_by        uuid,
  rejected_reason_de text,
  superseded_by      uuid        references public.campaign_proposals (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  constraint campaign_proposals_generation_unique unique (campaign_id, generation_index)
);
create index campaign_proposals_campaign_idx on public.campaign_proposals (campaign_id, created_at desc);
create unique index campaign_proposals_accepted_key on public.campaign_proposals (campaign_id) where accepted;

create table public.approvals (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id              uuid        not null references public.campaigns (id) on delete cascade,
  kind                     text        not null check (kind in (
                             'STRATEGY','ASSETS','TEST_PLAN','PUBLISH','BUDGET_SCALE','MAJOR_CHANGE')),
  state                    text        not null default 'PENDING' check (state in (
                             'PENDING','APPROVED','REJECTED','INVALIDATED')),
  -- The hash of exactly the content that was approved (spec §4.1).
  approved_content_hash    char(64),
  approved_by              uuid,
  approved_at              timestamptz,
  rejected_reason_de       text,
  invalidated_at           timestamptz,
  invalidated_reason_de    text,
  requested_by             uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid,
  updated_by               uuid,
  constraint approvals_approved_has_hash check (state <> 'APPROVED' or approved_content_hash is not null)
);
create index approvals_campaign_idx on public.approvals (campaign_id, kind, created_at desc);
create unique index approvals_active_key
  on public.approvals (campaign_id, kind)
  where state in ('PENDING', 'APPROVED');

create trigger campaigns_touch          before update on public.campaigns          for each row execute function app.touch_updated_at();
create trigger campaign_versions_touch  before update on public.campaign_versions  for each row execute function app.touch_updated_at();
create trigger angles_touch             before update on public.angles             for each row execute function app.touch_updated_at();
create trigger angle_versions_touch     before update on public.angle_versions     for each row execute function app.touch_updated_at();
create trigger campaign_proposals_touch before update on public.campaign_proposals for each row execute function app.touch_updated_at();
create trigger approvals_touch          before update on public.approvals          for each row execute function app.touch_updated_at();

create trigger campaign_versions_immutable
  before update or delete on public.campaign_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');

create trigger angle_versions_immutable
  before update or delete on public.angle_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');
