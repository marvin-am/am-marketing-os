-- =============================================================================
-- 0007_experiments.sql — experiments, arms, assignments, exposures, results
-- =============================================================================
-- Assignment is stable per (experiment, visitor); exposure is one row per actual
-- render per session. The two unique constraints below are what make acceptance
-- criteria 11 and 12 mechanical rather than a matter of client discipline.
-- =============================================================================

create table public.experiments (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id           uuid        not null references public.campaigns (id) on delete cascade,
  kind                  text        not null check (kind in (
                          'CREATIVE_EXPLORATION','FUNNEL_EXPERIMENT','BUNDLED_FUNNEL_TEST')),
  state                 text        not null default 'DRAFT' check (state in (
                          'DRAFT','READY','RUNNING','PAUSED','CONCLUDED','ABANDONED')),
  name                  text        not null,
  hypothesis            text        not null,
  test_variable         text        not null,
  primary_metric        text        not null check (primary_metric in (
                          'impressions','link_clicks','ctr','cpc','cpm','spend','funnel_sessions',
                          'form_start_rate','step_dropoff','submission_rate','leads','cpl',
                          'vq_scheduled','vq_scheduled_rate','show_rate','qualified_vq',
                          'qualified_vq_rate','cost_per_qualified_vq','opportunities',
                          'opportunity_rate','closed_won','close_rate','cac','revenue','roas')),
  secondary_metrics     text[]      not null default '{}',
  guardrail_metrics     text[]      not null default '{}',
  -- experimentThresholdsSchema; every value is editable in Settings.
  thresholds            jsonb       not null,
  -- Frozen once RUNNING: changing it would silently re-bucket returning visitors.
  assignment_salt       text        not null check (length(assignment_salt) between 8 and 64),
  bundled               boolean     not null default false,
  eligibility_changing  boolean     not null default false,
  verdict               text        check (verdict in (
                          'WINNER','PROVISIONAL','NO_DIFFERENCE','INCONCLUSIVE','INSUFFICIENT_DATA')),
  winning_arm_id        uuid,
  started_at            timestamptz,
  paused_at             timestamptz,
  concluded_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  constraint experiments_running_has_start check (state <> 'RUNNING' or started_at is not null),
  constraint experiments_concluded_has_end check (state <> 'CONCLUDED' or concluded_at is not null)
);
create index experiments_campaign_idx on public.experiments (campaign_id, state);
create index experiments_workspace_idx on public.experiments (workspace_id, state);

create table public.experiment_arms (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  experiment_id        uuid        not null references public.experiments (id) on delete cascade,
  key                  text        not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label                text        not null,
  is_control           boolean     not null default false,
  allocation           numeric(6,5) not null check (allocation >= 0 and allocation <= 1),
  creative_version_id  uuid        references public.creative_versions (id) on delete restrict,
  funnel_version_id    uuid        references public.funnel_versions (id) on delete restrict,
  form_version_id      uuid        references public.form_versions (id) on delete restrict,
  published_funnel_id  uuid        references public.published_funnels (id) on delete set null,
  sort_order           integer     not null default 0,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  constraint experiment_arms_key_unique unique (experiment_id, key)
);
create unique index experiment_arms_control_key
  on public.experiment_arms (experiment_id) where is_control;
create index experiment_arms_workspace_idx on public.experiment_arms (workspace_id);

alter table public.experiments
  add constraint experiments_winning_arm_fkey
  foreign key (winning_arm_id) references public.experiment_arms (id) on delete set null;

alter table public.published_funnels
  add constraint published_funnels_experiment_fkey
  foreign key (experiment_id) references public.experiments (id) on delete set null;

create table public.experiment_assignments (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  experiment_id  uuid        not null references public.experiments (id) on delete cascade,
  visitor_id     uuid        not null,
  arm_id         uuid        not null references public.experiment_arms (id) on delete cascade,
  -- Bucket in [0,1) that produced this assignment. Kept for audits.
  bucket         numeric(9,8) not null check (bucket >= 0 and bucket < 1),
  assigned_at    timestamptz not null default now(),
  -- Acceptance criterion 11: one arm per visitor per experiment, forever.
  constraint experiment_assignments_unique unique (experiment_id, visitor_id)
);
create index experiment_assignments_arm_idx on public.experiment_assignments (experiment_id, arm_id);
create index experiment_assignments_workspace_idx on public.experiment_assignments (workspace_id);

create table public.experiment_exposures (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  experiment_id  uuid        not null references public.experiments (id) on delete cascade,
  visitor_id     uuid        not null,
  session_id     uuid        not null,
  arm_id         uuid        not null references public.experiment_arms (id) on delete cascade,
  exposed_at     timestamptz not null default now(),
  -- Acceptance criterion 12: exactly one exposure per render session.
  constraint experiment_exposures_unique unique (experiment_id, visitor_id, session_id)
);
create index experiment_exposures_arm_idx on public.experiment_exposures (experiment_id, arm_id, exposed_at);
create index experiment_exposures_workspace_idx on public.experiment_exposures (workspace_id);

create table public.experiment_results (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  experiment_id            uuid        not null references public.experiments (id) on delete cascade,
  computed_at              timestamptz not null default now(),
  primary_metric           text        not null,
  verdict                  text        not null check (verdict in (
                             'WINNER','PROVISIONAL','NO_DIFFERENCE','INCONCLUSIVE','INSUFFICIENT_DATA')),
  winning_arm_id           uuid        references public.experiment_arms (id) on delete set null,
  maturity                 text        not null check (maturity in ('IMMATURE','PARTIAL','MATURE')),
  -- armResultSchema[] — posterior means, credible intervals, probabilityBest.
  arms                     jsonb       not null default '[]'::jsonb,
  reasons                  text[]      not null default '{}',
  interpretation_warnings  text[]      not null default '{}',
  runtime_days             numeric(8,3) not null default 0,
  total_sessions           bigint      not null default 0,
  total_conversions        bigint      not null default 0,
  thresholds               jsonb       not null,
  created_at               timestamptz not null default now(),
  constraint experiment_results_snapshot_unique unique (experiment_id, computed_at)
);
create index experiment_results_latest_idx on public.experiment_results (experiment_id, computed_at desc);
create index experiment_results_workspace_idx on public.experiment_results (workspace_id);

create trigger experiments_touch before update on public.experiments for each row execute function app.touch_updated_at();

-- Arms freeze as soon as the experiment leaves the planning stage (spec §20).
create trigger experiment_arms_immutable
  before update or delete on public.experiment_arms
  for each row execute function app.enforce_experiment_arm_immutability();
