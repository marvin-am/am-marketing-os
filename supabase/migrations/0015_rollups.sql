-- =============================================================================
-- 0015_rollups.sql — daily performance rollups
-- =============================================================================
-- Spec §33: a dashboard never calls a provider API during a request. It reads
-- mirrored data and these rollups. Spec §24 schedules the daily job that fills
-- them.
--
-- One row per (day × dimension combination). Every dimension column is nullable,
-- so the same table holds a campaign-level row, a creative-level row and an
-- experiment-arm-level row for the same day. `dimension_key` is a generated
-- column over the six dimensions: without it the UNIQUE constraint would treat
-- two NULL dimensions as distinct and the job would duplicate on every run.
--
-- Only PRODUCTION traffic ever reaches a rollup (spec §35). That is enforced
-- where the counters are derived — in @am/jobs and in the memory database — and
-- restated in `traffic_scope` so a row can never quietly claim otherwise.
-- =============================================================================

create table public.performance_rollups (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  day                   date        not null,

  -- Dimensions. Any combination may be null; the generated key makes the
  -- combination itself the unique thing.
  campaign_id           uuid        references public.campaigns (id) on delete cascade,
  campaign_version_id   uuid        references public.campaign_versions (id) on delete cascade,
  creative_version_id   uuid        references public.creative_versions (id) on delete cascade,
  funnel_version_id     uuid        references public.funnel_versions (id) on delete cascade,
  experiment_id         uuid        references public.experiments (id) on delete cascade,
  experiment_arm_id     uuid        references public.experiment_arms (id) on delete cascade,

  dimension_key         text        generated always as (
                          coalesce(campaign_id::text, '-') || '|' ||
                          coalesce(campaign_version_id::text, '-') || '|' ||
                          coalesce(creative_version_id::text, '-') || '|' ||
                          coalesce(funnel_version_id::text, '-') || '|' ||
                          coalesce(experiment_id::text, '-') || '|' ||
                          coalesce(experiment_arm_id::text, '-')
                        ) stored,

  -- Delivery (Meta insights).
  impressions           bigint      not null default 0 check (impressions >= 0),
  reach                 bigint      not null default 0 check (reach >= 0),
  link_clicks           bigint      not null default 0 check (link_clicks >= 0),
  spend_minor           bigint      not null default 0 check (spend_minor >= 0),
  currency              text        not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),

  -- Funnel (first-party events).
  funnel_sessions       bigint      not null default 0 check (funnel_sessions >= 0),
  form_views            bigint      not null default 0 check (form_views >= 0),
  form_starts           bigint      not null default 0 check (form_starts >= 0),
  step_completions      bigint      not null default 0 check (step_completions >= 0),
  validation_failures   bigint      not null default 0 check (validation_failures >= 0),
  submissions           bigint      not null default 0 check (submissions >= 0),

  -- CRM. Lags the delivery counters by the sales cycle; `data_maturity` says so.
  leads                 bigint      not null default 0 check (leads >= 0),
  vq_scheduled          bigint      not null default 0 check (vq_scheduled >= 0),
  vq_attended           bigint      not null default 0 check (vq_attended >= 0),
  vq_no_show            bigint      not null default 0 check (vq_no_show >= 0),
  qualified_vq          bigint      not null default 0 check (qualified_vq >= 0),
  opportunities         bigint      not null default 0 check (opportunities >= 0),
  closed_won            bigint      not null default 0 check (closed_won >= 0),
  closed_lost           bigint      not null default 0 check (closed_lost >= 0),
  revenue_minor         bigint      not null default 0,

  -- Quality. Rendered next to every number so a ROAS built on weak matching
  -- cannot be mistaken for a measured fact.
  attribution_coverage  numeric(6,5) check (attribution_coverage between 0 and 1),
  data_maturity         text        not null default 'IMMATURE' check (data_maturity in (
                          'IMMATURE', 'PARTIAL', 'MATURE')),

  -- PRODUCTION only. The column exists so the restriction is visible in a dump.
  traffic_scope         text        not null default 'PRODUCTION' check (traffic_scope = 'PRODUCTION'),

  /** Newest source timestamp folded into this row; drives recompute detection. */
  source_max_at         timestamptz,
  computed_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint performance_rollups_unique unique (workspace_id, day, dimension_key)
);

comment on table public.performance_rollups is
  'Daily pre-aggregated performance. Dashboards read this, never a provider API (spec §33).';
comment on column public.performance_rollups.dimension_key is
  'Generated from the six dimension columns so the UNIQUE constraint is not defeated by NULLs.';

create index performance_rollups_day_idx on public.performance_rollups (workspace_id, day desc);
create index performance_rollups_campaign_idx on public.performance_rollups (campaign_id, day desc) where campaign_id is not null;
create index performance_rollups_campaign_version_idx on public.performance_rollups (campaign_version_id, day desc) where campaign_version_id is not null;
create index performance_rollups_creative_idx on public.performance_rollups (creative_version_id, day desc) where creative_version_id is not null;
create index performance_rollups_funnel_idx on public.performance_rollups (funnel_version_id, day desc) where funnel_version_id is not null;
create index performance_rollups_experiment_idx on public.performance_rollups (experiment_id, day desc) where experiment_id is not null;
create index performance_rollups_arm_idx on public.performance_rollups (experiment_arm_id, day desc) where experiment_arm_id is not null;

create trigger performance_rollups_touch
  before update on public.performance_rollups
  for each row execute function app.touch_updated_at();

-- RLS. 0012 enabled it for every table that existed then; a later table wires
-- itself up, using the same predicate.
alter table public.performance_rollups enable row level security;
alter table public.performance_rollups force row level security;

create policy performance_rollups_member on public.performance_rollups
  for all to authenticated
  using (app.is_member(workspace_id))
  with check (app.is_member(workspace_id));

-- `alter default privileges` (Supabase's, and the local shim's) grants `anon`
-- SELECT on new public tables. 0012 revoked that for every table that existed
-- then; a table created afterwards has to re-assert it or it is quietly public.
revoke all on public.performance_rollups from anon;
grant select, insert, update, delete on public.performance_rollups to authenticated;
grant all on public.performance_rollups to service_role;

-- -----------------------------------------------------------------------------
-- Which days the rollup job still owes
-- -----------------------------------------------------------------------------
-- A day needs recomputing when it has production source activity and either no
-- rollup exists for it, or the oldest rollup for that day was computed before
-- the newest source row landed. One query rather than a scan per day.

create or replace function public.rollup_days_needing_recompute(
  p_workspace_id uuid,
  p_since        date,
  p_until        date
)
returns setof date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with source as (
    select (e.occurred_at at time zone 'UTC')::date as day, max(e.received_at) as latest
    from public.events e
    where e.workspace_id = p_workspace_id
      and e.traffic_kind = 'PRODUCTION'
      and e.occurred_at >= p_since::timestamptz
      and e.occurred_at < (p_until + 1)::timestamptz
    group by 1

    union all
    select i.date_start, max(i.imported_at)
    from public.meta_insights_daily i
    where i.workspace_id = p_workspace_id and i.date_start between p_since and p_until
    group by 1

    union all
    select (fs.submitted_at at time zone 'UTC')::date, max(fs.updated_at)
    from public.form_submissions fs
    where fs.workspace_id = p_workspace_id
      and fs.traffic_kind = 'PRODUCTION'
      and fs.submitted_at >= p_since::timestamptz
      and fs.submitted_at < (p_until + 1)::timestamptz
    group by 1

    union all
    select (lse.occurred_at at time zone 'UTC')::date, max(lse.recorded_at)
    from public.lead_stage_events lse
    where lse.workspace_id = p_workspace_id
      and lse.occurred_at >= p_since::timestamptz
      and lse.occurred_at < (p_until + 1)::timestamptz
    group by 1
  ),
  latest_source as (
    select day, max(latest) as latest from source group by day
  ),
  oldest_rollup as (
    select day, min(computed_at) as computed_at
    from public.performance_rollups
    where workspace_id = p_workspace_id and day between p_since and p_until
    group by day
  )
  select s.day
  from latest_source s
  left join oldest_rollup r on r.day = s.day
  where r.computed_at is null or r.computed_at < s.latest
  order by s.day;
$$;

comment on function public.rollup_days_needing_recompute(uuid, date, date) is
  'Days with production source activity whose rollups are missing or stale.';

grant execute on function public.rollup_days_needing_recompute(uuid, date, date) to authenticated, service_role;
