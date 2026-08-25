-- =============================================================================
-- 0003_brand_knowledge.sql — the only context the AI layer is ever allowed to read
-- =============================================================================
-- Mirrors packages/domain/src/knowledge.ts. There is deliberately no path from
-- leads, submissions or CRM data into this schema (spec §12).
-- =============================================================================

create table public.brand_profiles (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  name              text        not null,
  positioning       text        not null,
  tone_of_voice     text        not null,
  avoid_terms       text[]      not null default '{}',
  preferred_terms   text[]      not null default '{}',
  -- { primary, foreground, background, accent } — validated by brandProfileSchema.
  colors            jsonb       not null default
                      '{"primary":"#D7182A","foreground":"#111111","background":"#FFFFFF","accent":"#000000"}'::jsonb,
  logo_asset_path   text,
  is_default        boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid
);

create unique index brand_profiles_default_idx on public.brand_profiles (workspace_id) where is_default;
create index brand_profiles_workspace_idx on public.brand_profiles (workspace_id);

create table public.audience_segments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid        not null references public.workspaces (id) on delete cascade,
  name             text        not null,
  description      text        not null,
  company_size     text,
  industries       text[]      not null default '{}',
  roles            text[]      not null default '{}',
  pain_points      text[]      not null default '{}',
  buying_triggers  text[]      not null default '{}',
  objections       text[]      not null default '{}',
  is_active        boolean     not null default true,
  sort_order       integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid
);
create index audience_segments_workspace_idx on public.audience_segments (workspace_id) where is_active;

create table public.services (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  name          text        not null,
  description   text        not null,
  category      text,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid
);
create index services_workspace_idx on public.services (workspace_id) where is_active;

create table public.offers (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  service_id          uuid        references public.services (id) on delete set null,
  name                text        not null,
  -- Mirrors OFFER_TYPES in packages/domain/src/campaign.ts.
  offer_type          text        not null check (offer_type in (
                        'POTENTIAL_ANALYSIS','BENCHMARK','AUDIT','STRATEGY_CALL',
                        'CALCULATOR','CHECKLIST','LEAD_MAGNET')),
  current_version_id  uuid,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid
);
create index offers_workspace_idx on public.offers (workspace_id) where is_active;

create table public.offer_versions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  offer_id      uuid        not null references public.offers (id) on delete cascade,
  version       integer     not null check (version >= 1),
  state         text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  -- offerSpecSchema
  spec          jsonb       not null,
  content_hash  char(64)    not null,
  published_at  timestamptz,
  published_by  uuid,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid,
  constraint offer_versions_unique unique (offer_id, version),
  constraint offer_versions_published_has_time check (state <> 'PUBLISHED' or published_at is not null)
);
create index offer_versions_offer_idx on public.offer_versions (offer_id, version desc);
create index offer_versions_workspace_idx on public.offer_versions (workspace_id);

alter table public.offers
  add constraint offers_current_version_fkey
  foreign key (current_version_id) references public.offer_versions (id) on delete set null;

create table public.evidence_items (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  kind           text        not null check (kind in (
                   'HISTORICAL_PERFORMANCE','CUSTOMER_PROOF','CASE_STUDY',
                   'APPROVED_FACT','APPROVED_STATISTIC','TESTIMONIAL')),
  statement      text        not null,
  source         text        not null default '',
  approved       boolean     not null default false,
  approved_at    timestamptz,
  approved_by    uuid,
  valid_until    timestamptz,
  numeric_value  numeric,
  numeric_unit   text,
  campaign_id    uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid,
  constraint evidence_items_approved_has_time check (approved = false or approved_at is not null)
);
create index evidence_items_workspace_idx on public.evidence_items (workspace_id, kind) where approved;

create table public.claims (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id                 uuid,
  text                        text        not null,
  evidence_item_id            uuid        references public.evidence_items (id) on delete set null,
  confidence                  text        not null check (confidence in ('FACT','INDICATION','HYPOTHESIS')),
  requires_hypothesis_label   boolean     not null default false,
  approved                    boolean     not null default false,
  approved_at                 timestamptz,
  approved_by                 uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid,
  updated_by                  uuid,
  -- claimSpecStrictSchema, enforced in the database as well as in Zod (spec §9).
  constraint claims_backed_or_hypothesis check (
    evidence_item_id is not null or requires_hypothesis_label or confidence = 'HYPOTHESIS'
  )
);
create index claims_workspace_idx on public.claims (workspace_id);
create index claims_campaign_idx on public.claims (campaign_id) where campaign_id is not null;

create table public.case_studies (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  client         text        not null,
  industry       text,
  challenge      text        not null,
  approach       text        not null,
  outcome        text        not null,
  metrics        jsonb       not null default '[]'::jsonb,
  approved       boolean     not null default false,
  usable_in_ads  boolean     not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid
);
create index case_studies_workspace_idx on public.case_studies (workspace_id) where approved;

create table public.testimonials (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  quote          text        not null,
  author_name    text        not null,
  author_role    text,
  company        text,
  approved       boolean     not null default false,
  usable_in_ads  boolean     not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid
);
create index testimonials_workspace_idx on public.testimonials (workspace_id) where approved;

create table public.faqs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  question      text        not null,
  answer        text        not null,
  approved      boolean     not null default false,
  sort_order    integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid
);
create index faqs_workspace_idx on public.faqs (workspace_id) where approved;

create table public.guardrails (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  kind          text        not null check (kind in (
                  'FORBIDDEN_CLAIM','FORBIDDEN_TERM','REQUIRED_DISCLAIMER','STYLE_RULE')),
  pattern       text        not null,
  match_mode    text        not null default 'SUBSTRING' check (match_mode in ('SUBSTRING','WORD')),
  reason_de     text        not null,
  severity      text        not null default 'BLOCK' check (severity in ('BLOCK','WARN')),
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid
);
create index guardrails_workspace_idx on public.guardrails (workspace_id) where is_active;

create table public.knowledge_documents (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  title         text        not null,
  source_kind   text        not null default 'UPLOAD' check (source_kind in (
                  'UPLOAD','URL','CAMPAIGN_EXPORT','MANUAL','HISTORICAL_IMPORT')),
  storage_bucket text,
  storage_path  text,
  mime_type     text,
  byte_size     bigint,
  content_text  text,
  checksum      char(64),
  language      text        not null default 'de',
  -- External provenance. Re-importing the same document never duplicates it.
  provider      text        not null default 'INTERNAL',
  external_id   text        not null default gen_random_uuid()::text,
  ingested_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid,
  constraint knowledge_documents_external_unique unique (provider, external_id)
);
create index knowledge_documents_workspace_idx on public.knowledge_documents (workspace_id);
create index knowledge_documents_title_trgm on public.knowledge_documents using gin (title gin_trgm_ops);

-- Embeddings for documents *and* for angles / campaigns / learning cards, so the
-- angle-distinctness check and the historical-similarity search share one index.
create table public.knowledge_embeddings (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  source_kind   text        not null check (source_kind in ('DOCUMENT','ANGLE','CAMPAIGN','LEARNING_CARD','CREATIVE')),
  document_id   uuid        references public.knowledge_documents (id) on delete cascade,
  entity_id     uuid,
  chunk_index   integer     not null default 0 check (chunk_index >= 0),
  chunk_text    text        not null,
  -- `text-embedding-3-large` at its native 3072 dimensions cannot be indexed:
  -- pgvector's hnsw and ivfflat opclasses stop at 2000. The model supports
  -- native dimension reduction through the `dimensions` request parameter, so we
  -- ask for 1536 — indexable, and a documented capability of the model rather
  -- than a truncation we invented.
  model         text        not null default 'text-embedding-3-large',
  dimensions    integer     not null default 1536 check (dimensions = 1536),
  token_count   integer,
  content_hash  char(64)    not null,
  created_at    timestamptz not null default now(),
  constraint knowledge_embeddings_source_ref check (
    (source_kind = 'DOCUMENT' and document_id is not null)
    or (source_kind <> 'DOCUMENT' and entity_id is not null)
  )
);

-- The embedding column type depends on what this instance can actually do.
-- With pgvector: vector(1536). Without it: real[], and similarity search is off.
do $emb$
begin
  if app.capability('pgvector') then
    execute 'alter table public.knowledge_embeddings add column embedding vector(1536)';
  else
    execute 'alter table public.knowledge_embeddings add column embedding real[]';
  end if;
end
$emb$;

create unique index knowledge_embeddings_document_chunk_key
  on public.knowledge_embeddings (document_id, chunk_index)
  where document_id is not null;

create unique index knowledge_embeddings_entity_chunk_key
  on public.knowledge_embeddings (source_kind, entity_id, chunk_index)
  where entity_id is not null;

create index knowledge_embeddings_workspace_idx on public.knowledge_embeddings (workspace_id, source_kind);

-- Approximate-nearest-neighbour index: HNSW over cosine distance.
--
-- 1536 dimensions sit inside pgvector's 2000-dimension opclass limit, so this is
-- a plain `vector_cosine_ops` index — no halfvec, no expression index, and it
-- works on pgvector 0.5 upward. Without pgvector at all there is no index and
-- similarity search is off; `app.schema_capabilities` records which it is, so
-- `@am/db` degrades honestly instead of returning wrong neighbours.
do $ann$
begin
  if not app.capability('pgvector') then
    insert into app.schema_capabilities (key, available, detail)
    values ('embedding_ann_index', false, 'pgvector fehlt — kein ANN-Index, keine Ähnlichkeitssuche.')
    on conflict (key) do update set available = false, detail = excluded.detail, recorded_at = now();
    return;
  end if;

  execute $ix$
    create index knowledge_embeddings_hnsw
      on public.knowledge_embeddings
      using hnsw (embedding vector_cosine_ops)
  $ix$;

  insert into app.schema_capabilities (key, available, detail)
  values (
    'embedding_ann_index',
    true,
    'HNSW über vector(1536), Cosine-Distanz. text-embedding-3-large wird mit dimensions=1536 abgefragt.'
  )
  on conflict (key) do update set available = true, detail = excluded.detail, recorded_at = now();
end
$ann$;

create trigger brand_profiles_touch      before update on public.brand_profiles      for each row execute function app.touch_updated_at();
create trigger audience_segments_touch   before update on public.audience_segments   for each row execute function app.touch_updated_at();
create trigger services_touch            before update on public.services            for each row execute function app.touch_updated_at();
create trigger offers_touch              before update on public.offers              for each row execute function app.touch_updated_at();
create trigger offer_versions_touch      before update on public.offer_versions      for each row execute function app.touch_updated_at();
create trigger evidence_items_touch      before update on public.evidence_items      for each row execute function app.touch_updated_at();
create trigger claims_touch              before update on public.claims              for each row execute function app.touch_updated_at();
create trigger case_studies_touch        before update on public.case_studies        for each row execute function app.touch_updated_at();
create trigger testimonials_touch        before update on public.testimonials        for each row execute function app.touch_updated_at();
create trigger faqs_touch                before update on public.faqs                for each row execute function app.touch_updated_at();
create trigger guardrails_touch          before update on public.guardrails          for each row execute function app.touch_updated_at();
create trigger knowledge_documents_touch before update on public.knowledge_documents for each row execute function app.touch_updated_at();

-- Published offer versions are frozen (AGENTS rule 6).
create trigger offer_versions_immutable
  before update or delete on public.offer_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');
