-- =============================================================================
-- 0009_meta.sql — Meta ad objects, daily insights, CAPI dispatch log
-- =============================================================================
-- Every table here carries UNIQUE (provider, external_id) so re-running the
-- 18/24-month historical import is an upsert, never a duplication.
-- =============================================================================

create table public.meta_accounts (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid        not null references public.workspaces (id) on delete cascade,
  provider               text        not null default 'META' check (provider = 'META'),
  external_id            text        not null,
  name                   text        not null,
  currency               text        not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  timezone               text        not null default 'Europe/Berlin',
  business_id            text,
  page_id                text,
  instagram_actor_id     text,
  pixel_id               text,
  dataset_id             text,
  account_status         text,
  is_primary             boolean     not null default false,
  connection_id          uuid,
  last_imported_at       timestamptz,
  raw                    jsonb       not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid,
  updated_by             uuid,
  constraint meta_accounts_external_unique unique (provider, external_id)
);
create index meta_accounts_workspace_idx on public.meta_accounts (workspace_id);
create unique index meta_accounts_primary_key on public.meta_accounts (workspace_id) where is_primary;

create table public.meta_campaigns (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  meta_account_id       uuid        not null references public.meta_accounts (id) on delete cascade,
  provider              text        not null default 'META' check (provider = 'META'),
  external_id           text        not null,
  -- Link back to the internal campaign once it is matched. NULL for pure history.
  campaign_id           uuid        references public.campaigns (id) on delete set null,
  name                  text        not null,
  objective             text,
  status                text        not null default 'PAUSED' check (status in ('ACTIVE','PAUSED','DELETED','ARCHIVED')),
  effective_status      text,
  buying_type           text,
  daily_budget_minor    bigint      check (daily_budget_minor >= 0),
  lifetime_budget_minor bigint      check (lifetime_budget_minor >= 0),
  currency              text        not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  start_time            timestamptz,
  stop_time             timestamptz,
  provider_created_time timestamptz,
  provider_updated_time timestamptz,
  raw                   jsonb       not null default '{}'::jsonb,
  imported_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint meta_campaigns_external_unique unique (provider, external_id)
);
create index meta_campaigns_account_idx on public.meta_campaigns (meta_account_id, status);
create index meta_campaigns_workspace_idx on public.meta_campaigns (workspace_id);
create index meta_campaigns_internal_idx on public.meta_campaigns (campaign_id) where campaign_id is not null;

create table public.meta_adsets (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  meta_campaign_id      uuid        not null references public.meta_campaigns (id) on delete cascade,
  provider              text        not null default 'META' check (provider = 'META'),
  external_id           text        not null,
  name                  text        not null,
  status                text        not null default 'PAUSED' check (status in ('ACTIVE','PAUSED','DELETED','ARCHIVED')),
  effective_status      text,
  optimization_goal     text,
  billing_event         text,
  bid_strategy          text,
  daily_budget_minor    bigint      check (daily_budget_minor >= 0),
  lifetime_budget_minor bigint      check (lifetime_budget_minor >= 0),
  targeting             jsonb       not null default '{}'::jsonb,
  start_time            timestamptz,
  end_time              timestamptz,
  experiment_arm_id     uuid        references public.experiment_arms (id) on delete set null,
  raw                   jsonb       not null default '{}'::jsonb,
  imported_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint meta_adsets_external_unique unique (provider, external_id)
);
create index meta_adsets_campaign_idx on public.meta_adsets (meta_campaign_id, status);
create index meta_adsets_workspace_idx on public.meta_adsets (workspace_id);

create table public.meta_creatives (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  meta_account_id      uuid        not null references public.meta_accounts (id) on delete cascade,
  provider             text        not null default 'META' check (provider = 'META'),
  external_id          text        not null,
  name                 text,
  -- Internal creative this Meta object was built from, when known.
  creative_version_id  uuid        references public.creative_versions (id) on delete set null,
  creative_rendition_id uuid       references public.creative_renditions (id) on delete set null,
  object_story_spec    jsonb       not null default '{}'::jsonb,
  image_hash           text,
  video_id             text,
  thumbnail_url        text,
  title                text,
  body                 text,
  call_to_action_type  text,
  link_url             text,
  raw                  jsonb       not null default '{}'::jsonb,
  imported_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint meta_creatives_external_unique unique (provider, external_id)
);
create index meta_creatives_account_idx on public.meta_creatives (meta_account_id);
create index meta_creatives_workspace_idx on public.meta_creatives (workspace_id);

create table public.meta_ads (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  meta_adset_id        uuid        not null references public.meta_adsets (id) on delete cascade,
  meta_creative_id     uuid        references public.meta_creatives (id) on delete set null,
  provider             text        not null default 'META' check (provider = 'META'),
  external_id          text        not null,
  name                 text        not null,
  status               text        not null default 'PAUSED' check (status in ('ACTIVE','PAUSED','DELETED','ARCHIVED')),
  effective_status     text,
  creative_version_id  uuid        references public.creative_versions (id) on delete set null,
  tracking_specs       jsonb       not null default '[]'::jsonb,
  raw                  jsonb       not null default '{}'::jsonb,
  imported_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint meta_ads_external_unique unique (provider, external_id)
);
create index meta_ads_adset_idx on public.meta_ads (meta_adset_id, status);
create index meta_ads_workspace_idx on public.meta_ads (workspace_id);
create index meta_ads_creative_version_idx on public.meta_ads (creative_version_id) where creative_version_id is not null;

-- One row per (level, entity, day). The unique constraint is the whole point:
-- re-importing an overlapping window updates in place.
create table public.meta_insights_daily (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  provider            text        not null default 'META' check (provider = 'META'),
  level               text        not null check (level in ('ACCOUNT','CAMPAIGN','ADSET','AD')),
  entity_external_id  text        not null,
  meta_account_id     uuid        references public.meta_accounts (id) on delete cascade,
  meta_campaign_id    uuid        references public.meta_campaigns (id) on delete cascade,
  meta_adset_id       uuid        references public.meta_adsets (id) on delete cascade,
  meta_ad_id          uuid        references public.meta_ads (id) on delete cascade,
  campaign_id         uuid        references public.campaigns (id) on delete set null,
  date_start          date        not null,
  impressions         bigint      not null default 0 check (impressions >= 0),
  reach               bigint      not null default 0 check (reach >= 0),
  clicks              bigint      not null default 0 check (clicks >= 0),
  link_clicks         bigint      not null default 0 check (link_clicks >= 0),
  -- Money in integer minor units. Never a float euro (AGENTS conventions).
  spend_minor         bigint      not null default 0 check (spend_minor >= 0),
  currency            text        not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  frequency           numeric(10,4),
  cpm_minor           bigint,
  cpc_minor           bigint,
  ctr                 numeric(10,6),
  video_views         bigint      not null default 0 check (video_views >= 0),
  actions             jsonb       not null default '[]'::jsonb,
  action_values       jsonb       not null default '[]'::jsonb,
  raw                 jsonb       not null default '{}'::jsonb,
  imported_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint meta_insights_daily_unique unique (provider, level, entity_external_id, date_start)
);
create index meta_insights_daily_workspace_date_idx on public.meta_insights_daily (workspace_id, date_start desc);
create index meta_insights_daily_campaign_date_idx on public.meta_insights_daily (campaign_id, date_start desc) where campaign_id is not null;
create index meta_insights_daily_meta_campaign_idx on public.meta_insights_daily (meta_campaign_id, date_start desc);
create index meta_insights_daily_ad_idx on public.meta_insights_daily (meta_ad_id, date_start desc) where meta_ad_id is not null;
create index meta_insights_daily_range_idx on public.meta_insights_daily (workspace_id, level, date_start);

-- One row per attempted Conversions-API event. Deduplicated on
-- (dataset_id, event_id) so a retry, a replay and a re-sync collapse into one.
create table public.capi_dispatches (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  outbox_event_id       uuid,
  dataset_id            text        not null,
  event_name            text        not null,
  event_id              text        not null,
  capi_stage            text        not null check (capi_stage in (
                          'INITIAL_LEAD','MARKETING_QUALIFIED_LEAD','SALES_OPPORTUNITY','CONVERTED')),
  event_time            timestamptz not null,
  action_source         text        not null default 'website',
  submission_id         uuid        references public.form_submissions (id) on delete set null,
  lead_id               uuid        references public.leads (id) on delete set null,
  opportunity_id        uuid        references public.opportunities (id) on delete set null,
  campaign_id           uuid        references public.campaigns (id) on delete set null,
  test_event_code       text,
  -- Hash of the (hashed-PII) request body. The body itself is never stored.
  request_hash          char(64)    not null,
  state                 text        not null default 'PENDING' check (state in (
                          'PENDING','PROCESSING','SENT','ACCEPTED','FAILED_RETRYING','DEAD_LETTER','EXPIRED')),
  events_received       integer,
  fbtrace_id            text,
  response_redacted     jsonb,
  error                 text,
  dispatched_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint capi_dispatches_unique unique (dataset_id, event_id)
);
create index capi_dispatches_workspace_idx on public.capi_dispatches (workspace_id, created_at desc);
create index capi_dispatches_stage_idx on public.capi_dispatches (capi_stage, state);
create index capi_dispatches_opportunity_idx on public.capi_dispatches (opportunity_id) where opportunity_id is not null;

create trigger meta_accounts_touch       before update on public.meta_accounts       for each row execute function app.touch_updated_at();
create trigger meta_campaigns_touch      before update on public.meta_campaigns      for each row execute function app.touch_updated_at();
create trigger meta_adsets_touch         before update on public.meta_adsets         for each row execute function app.touch_updated_at();
create trigger meta_creatives_touch      before update on public.meta_creatives      for each row execute function app.touch_updated_at();
create trigger meta_ads_touch            before update on public.meta_ads            for each row execute function app.touch_updated_at();
create trigger meta_insights_daily_touch before update on public.meta_insights_daily for each row execute function app.touch_updated_at();
create trigger capi_dispatches_touch     before update on public.capi_dispatches     for each row execute function app.touch_updated_at();
