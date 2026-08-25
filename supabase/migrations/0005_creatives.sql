-- =============================================================================
-- 0005_creatives.sql — concepts, source assets, versions, rendered placements
-- =============================================================================
-- The model produces a *spec* (concept + copy + prompt). Rendering happens
-- deterministically afterwards, which is why render_spec lives on the version and
-- the finished files live in creative_renditions (spec §13, AGENTS rule 5).
-- =============================================================================

create table public.creative_concepts (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id           uuid        not null references public.campaigns (id) on delete cascade,
  campaign_version_id   uuid        references public.campaign_versions (id) on delete set null,
  -- Stable key from the proposal (`concept_1` … `concept_8`).
  concept_key           text        not null check (concept_key ~ '^concept_[1-9][0-9]?$'),
  name                  text        not null,
  -- Mirrors CREATIVE_PRINCIPLES.
  principle             text        not null check (principle in (
                          'PROBLEM_PAIN','CONCRETE_RESULT','COMPARISON_ALTERNATIVE',
                          'PROOF_CASE_DATAPOINT','OBJECTION_HANDLING','CONTRARIAN_INSIGHT')),
  visual_idea           text        not null,
  image_prompt          text        not null,
  -- metaCopySchema: primaryText / headline / description / callToAction.
  copy                  jsonb       not null,
  hypothesis            text        not null,
  rationale             text        not null,
  proof_used            text,
  funnel_promise        text        not null,
  alt_text              text        not null,
  aspect_ratios         text[]      not null default array['1:1','4:5']::text[],
  claims                jsonb       not null default '[]'::jsonb,
  review_state          text        not null default 'DRAFT' check (review_state in (
                          'DRAFT','IN_REVIEW','APPROVED','REJECTED')),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  rejection_reason_de   text,
  current_version_id    uuid,
  -- Normalised hook/copy/visual fingerprint used by the diversity check.
  diversity_hash        char(64),
  sort_order            integer     not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  constraint creative_concepts_key_unique unique (campaign_id, concept_key),
  constraint creative_concepts_ratios_known check (aspect_ratios <@ array['1:1','4:5','9:16']::text[])
);
create index creative_concepts_campaign_idx on public.creative_concepts (campaign_id, sort_order);
create index creative_concepts_workspace_idx on public.creative_concepts (workspace_id, review_state);

create table public.creative_assets (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid        not null references public.workspaces (id) on delete cascade,
  concept_id         uuid        references public.creative_concepts (id) on delete cascade,
  campaign_id        uuid        references public.campaigns (id) on delete cascade,
  media_kind         text        not null default 'IMAGE' check (media_kind in ('IMAGE','VIDEO')),
  source             text        not null default 'AI_GENERATED' check (source in (
                       'AI_GENERATED','UPLOADED','IMPORTED')),
  storage_bucket     text        not null,
  storage_path       text        not null,
  mime_type          text        not null default 'image/png',
  width              integer     check (width > 0),
  height             integer     check (height > 0),
  byte_size          bigint      check (byte_size >= 0),
  checksum           char(64),
  duration_ms        integer     check (duration_ms >= 0),
  generation_job_id  uuid,
  generation_prompt  text,
  -- Provenance for historical Meta creatives pulled during the import.
  provider           text        not null default 'INTERNAL',
  external_id        text        not null default gen_random_uuid()::text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  constraint creative_assets_external_unique unique (provider, external_id),
  constraint creative_assets_path_unique unique (storage_bucket, storage_path)
);
create index creative_assets_concept_idx on public.creative_assets (concept_id);
create index creative_assets_workspace_idx on public.creative_assets (workspace_id);

create table public.creative_versions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  concept_id     uuid        not null references public.creative_concepts (id) on delete cascade,
  campaign_id    uuid        not null references public.campaigns (id) on delete cascade,
  version        integer     not null check (version >= 1),
  state          text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  base_asset_id  uuid        references public.creative_assets (id) on delete set null,
  -- Validated layout spec consumed by @am/creative-renderer. Never model HTML.
  render_spec    jsonb       not null,
  copy           jsonb       not null,
  content_hash   char(64)    not null,
  review_state   text        not null default 'DRAFT' check (review_state in (
                   'DRAFT','IN_REVIEW','APPROVED','REJECTED')),
  approved_by    uuid,
  approved_at    timestamptz,
  published_at   timestamptz,
  published_by   uuid,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid,
  constraint creative_versions_unique unique (concept_id, version)
);
create index creative_versions_concept_idx on public.creative_versions (concept_id, version desc);
create index creative_versions_campaign_idx on public.creative_versions (campaign_id, state);
create index creative_versions_workspace_idx on public.creative_versions (workspace_id);

alter table public.creative_concepts
  add constraint creative_concepts_current_version_fkey
  foreign key (current_version_id) references public.creative_versions (id) on delete set null;

create table public.creative_renditions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  creative_version_id  uuid        not null references public.creative_versions (id) on delete cascade,
  aspect_ratio         text        not null check (aspect_ratio in ('1:1','4:5','9:16')),
  storage_bucket       text        not null default 'creative-renditions',
  storage_path         text        not null,
  mime_type            text        not null default 'image/png',
  width                integer     not null check (width > 0),
  height               integer     not null check (height > 0),
  byte_size            bigint      check (byte_size >= 0),
  checksum             char(64),
  render_duration_ms   integer     check (render_duration_ms >= 0),
  renderer_version     text        not null default '1',
  -- Meta upload result; NULL until an actual provider confirmation arrives.
  meta_image_hash      text,
  meta_video_id        text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  constraint creative_renditions_unique unique (creative_version_id, aspect_ratio),
  constraint creative_renditions_path_unique unique (storage_bucket, storage_path)
);
create index creative_renditions_workspace_idx on public.creative_renditions (workspace_id);

create trigger creative_concepts_touch   before update on public.creative_concepts   for each row execute function app.touch_updated_at();
create trigger creative_assets_touch     before update on public.creative_assets     for each row execute function app.touch_updated_at();
create trigger creative_versions_touch   before update on public.creative_versions   for each row execute function app.touch_updated_at();
create trigger creative_renditions_touch before update on public.creative_renditions for each row execute function app.touch_updated_at();

create trigger creative_versions_immutable
  before update or delete on public.creative_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');
