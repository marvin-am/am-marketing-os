-- =============================================================================
-- 0006_funnels.sql — funnels, forms, consent versions, published runtime rows
-- =============================================================================
-- `published_funnels` is the only table the public funnel runtime reads directly
-- (through a narrow anon policy). Everything else it needs comes back from the
-- SECURITY DEFINER function `public.get_published_funnel()` in 0013.
-- =============================================================================

create table public.consent_versions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  version              integer     not null check (version >= 1),
  -- Stored verbatim: what the visitor actually saw, not today's text (spec §28).
  text_de              text        not null,
  purposes             text[]      not null check (purposes <@ array[
                         'CONTACT','MARKETING_EMAIL','ANALYTICS','AD_MEASUREMENT']::text[]
                         and array_length(purposes, 1) >= 1),
  privacy_policy_url   text        not null,
  effective_from       timestamptz not null default now(),
  effective_until      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  constraint consent_versions_unique unique (workspace_id, version)
);
create index consent_versions_active_idx on public.consent_versions (workspace_id, effective_from desc);

create table public.funnels (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id         uuid        not null references public.campaigns (id) on delete cascade,
  funnel_key          text        not null check (funnel_key ~ '^funnel_[1-9]$'),
  kind                text        not null check (kind in ('LANDING_PAGE','MULTI_STEP_FORM','HYBRID')),
  name                text        not null,
  promise             text,
  hypothesis          text,
  rationale           text,
  current_version_id  uuid,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  constraint funnels_key_unique unique (campaign_id, funnel_key)
);
create index funnels_workspace_idx on public.funnels (workspace_id);
create index funnels_campaign_idx on public.funnels (campaign_id) where is_active;

create table public.form_definitions (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  funnel_id           uuid        not null references public.funnels (id) on delete cascade,
  form_key            text        not null check (form_key ~ '^[a-z][a-z0-9_]*$'),
  name                text        not null,
  current_version_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  constraint form_definitions_key_unique unique (funnel_id, form_key)
);
create index form_definitions_workspace_idx on public.form_definitions (workspace_id);

create table public.form_versions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  form_definition_id   uuid        not null references public.form_definitions (id) on delete cascade,
  version              integer     not null check (version >= 1),
  state                text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  -- MultiStepFormSpec / LandingPageSpec, validated by @am/funnel-schema.
  spec                 jsonb       not null,
  -- Flat lookup: field_key -> { type, pii_class, qualification_class, step_key }.
  -- Lets the submission writer classify an answer without re-walking the spec.
  field_index          jsonb       not null default '{}'::jsonb,
  question_count       integer     not null default 0 check (question_count >= 0),
  content_hash         char(64)    not null,
  consent_version_id   uuid        references public.consent_versions (id) on delete restrict,
  published_at         timestamptz,
  published_by         uuid,
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  constraint form_versions_unique unique (form_definition_id, version),
  constraint form_versions_published_has_consent check (
    state <> 'PUBLISHED' or (published_at is not null and consent_version_id is not null)
  )
);
create index form_versions_definition_idx on public.form_versions (form_definition_id, version desc);
create index form_versions_workspace_idx on public.form_versions (workspace_id, state);

alter table public.form_definitions
  add constraint form_definitions_current_version_fkey
  foreign key (current_version_id) references public.form_versions (id) on delete set null;

create table public.funnel_versions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid        not null references public.workspaces (id) on delete cascade,
  funnel_id        uuid        not null references public.funnels (id) on delete cascade,
  campaign_id      uuid        not null references public.campaigns (id) on delete cascade,
  version          integer     not null check (version >= 1),
  state            text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  spec             jsonb       not null,
  content_hash     char(64)    not null,
  form_version_id  uuid        references public.form_versions (id) on delete restrict,
  published_at     timestamptz,
  published_by     uuid,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  constraint funnel_versions_unique unique (funnel_id, version),
  constraint funnel_versions_published_has_time check (state <> 'PUBLISHED' or published_at is not null)
);
create index funnel_versions_funnel_idx on public.funnel_versions (funnel_id, version desc);
create index funnel_versions_workspace_idx on public.funnel_versions (workspace_id, state);
create index funnel_versions_campaign_idx on public.funnel_versions (campaign_id);

alter table public.funnels
  add constraint funnels_current_version_fkey
  foreign key (current_version_id) references public.funnel_versions (id) on delete set null;

create table public.published_funnels (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id         uuid        not null references public.campaigns (id) on delete cascade,
  funnel_id           uuid        not null references public.funnels (id) on delete cascade,
  funnel_version_id   uuid        not null references public.funnel_versions (id) on delete restrict,
  form_version_id     uuid        references public.form_versions (id) on delete restrict,
  experiment_id       uuid,
  -- Public URL segment; the funnel runtime looks a visitor up by this alone.
  public_slug         text        not null,
  path                text        not null default '/',
  is_live             boolean     not null default false,
  environment         text        not null default 'production' check (environment in (
                        'production','preview','development','test')),
  meta_pixel_id       text,
  meta_dataset_id     text,
  consent_version_id  uuid        references public.consent_versions (id) on delete restrict,
  redirect_url        text,
  published_at        timestamptz not null default now(),
  unpublished_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  constraint published_funnels_slug_unique unique (public_slug)
);
create index published_funnels_live_idx on public.published_funnels (public_slug) where is_live;
create index published_funnels_campaign_idx on public.published_funnels (campaign_id);
create index published_funnels_workspace_idx on public.published_funnels (workspace_id);

create trigger consent_versions_touch  before update on public.consent_versions  for each row execute function app.touch_updated_at();
create trigger funnels_touch           before update on public.funnels           for each row execute function app.touch_updated_at();
create trigger form_definitions_touch  before update on public.form_definitions  for each row execute function app.touch_updated_at();
create trigger form_versions_touch     before update on public.form_versions     for each row execute function app.touch_updated_at();
create trigger funnel_versions_touch   before update on public.funnel_versions   for each row execute function app.touch_updated_at();
create trigger published_funnels_touch before update on public.published_funnels for each row execute function app.touch_updated_at();

create trigger funnel_versions_immutable
  before update or delete on public.funnel_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');

create trigger form_versions_immutable
  before update or delete on public.form_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');
