-- =============================================================================
-- 0010_hubspot.sql — CRM mapping, mirrored objects, sync attempts, stage history
-- =============================================================================
-- No HubSpot id, pipeline id or property name is ever invented (AGENTS rule 1).
-- A mapping that is not filled in stays MAPPING_INCOMPLETE and the launch-QA
-- check reports AWAITING_EXTERNAL_INPUT.
-- =============================================================================

create table public.hubspot_mappings (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  object_type         text        not null check (object_type in ('CONTACT','COMPANY','DEAL')),
  version             integer     not null check (version >= 1),
  state               text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  -- { am_field_key -> { hubspot_property, transform, required } }
  field_map           jsonb       not null default '{}'::jsonb,
  -- { hubspot_stage_id -> canonical SALES_EVENT_TYPES value }
  stage_map           jsonb       not null default '{}'::jsonb,
  pipeline_id         text,
  pipeline_label      text,
  required_fields     text[]      not null default '{}',
  -- Which required mappings are still missing. Non-empty ⇒ MAPPING_INCOMPLETE.
  missing_fields      text[]      not null default '{}',
  content_hash        char(64)    not null,
  published_at        timestamptz,
  published_by        uuid,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  constraint hubspot_mappings_unique unique (workspace_id, object_type, version),
  constraint hubspot_mappings_published_complete check (
    state <> 'PUBLISHED' or (published_at is not null and coalesce(array_length(missing_fields, 1), 0) = 0)
  )
);
create index hubspot_mappings_workspace_idx on public.hubspot_mappings (workspace_id, object_type, version desc);
create unique index hubspot_mappings_active_key
  on public.hubspot_mappings (workspace_id, object_type) where state = 'PUBLISHED';

-- Local mirror of the HubSpot objects we touch. Properties are stored redacted:
-- the CRM is the system of record for personal data, not this database.
create table public.hubspot_objects (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  provider             text        not null default 'HUBSPOT' check (provider = 'HUBSPOT'),
  external_id          text        not null,
  object_type          text        not null check (object_type in ('CONTACT','COMPANY','DEAL')),
  am_person_id         uuid,
  lead_id              uuid        references public.leads (id) on delete set null,
  opportunity_id       uuid        references public.opportunities (id) on delete set null,
  properties_redacted  jsonb       not null default '{}'::jsonb,
  pipeline             text,
  stage                text,
  amount_minor         bigint,
  currency             text        check (currency ~ '^[A-Z]{3}$'),
  archived             boolean     not null default false,
  last_synced_at       timestamptz,
  provider_updated_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint hubspot_objects_external_unique unique (provider, external_id)
);
create index hubspot_objects_workspace_idx on public.hubspot_objects (workspace_id, object_type);
create index hubspot_objects_lead_idx on public.hubspot_objects (lead_id) where lead_id is not null;
create index hubspot_objects_opportunity_idx on public.hubspot_objects (opportunity_id) where opportunity_id is not null;
create index hubspot_objects_person_idx on public.hubspot_objects (am_person_id) where am_person_id is not null;

create table public.hubspot_sync_attempts (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid        not null references public.workspaces (id) on delete cascade,
  outbox_event_id  uuid,
  submission_id    uuid        references public.form_submissions (id) on delete cascade,
  lead_id          uuid        references public.leads (id) on delete cascade,
  opportunity_id   uuid        references public.opportunities (id) on delete cascade,
  object_type      text        not null check (object_type in ('CONTACT','COMPANY','DEAL')),
  operation        text        not null check (operation in ('CREATE','UPDATE','ASSOCIATE','SEARCH','TEST_LEAD')),
  attempt_number   integer     not null default 1 check (attempt_number >= 1),
  status           text        not null check (status in ('PENDING','SYNCED','FAILED_RETRYING','DEAD_LETTER')),
  mapping_version  integer,
  request_hash     char(64),
  http_status      integer,
  error_code       text,
  error_message    text,
  -- Provider response with all PII stripped by redact() before it lands here.
  response_redacted jsonb,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  duration_ms      integer     check (duration_ms >= 0),
  next_attempt_at  timestamptz,
  created_at       timestamptz not null default now()
);
create index hubspot_sync_attempts_workspace_idx on public.hubspot_sync_attempts (workspace_id, started_at desc);
create index hubspot_sync_attempts_submission_idx on public.hubspot_sync_attempts (submission_id, attempt_number);
create index hubspot_sync_attempts_failed_idx on public.hubspot_sync_attempts (workspace_id, status)
  where status in ('FAILED_RETRYING', 'DEAD_LETTER');

-- Observed stage transitions. A repeated sync that sees the same stage inserts
-- nothing thanks to the unique index (spec §22, acceptance criterion 32).
create table public.hubspot_stage_history (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  hubspot_object_id   uuid        references public.hubspot_objects (id) on delete cascade,
  external_id         text        not null,
  object_type         text        not null check (object_type in ('CONTACT','COMPANY','DEAL')),
  pipeline            text,
  from_stage          text,
  to_stage            text        not null,
  occurred_at         timestamptz not null,
  observed_at         timestamptz not null default now(),
  source              text        not null default 'POLL' check (source in ('POLL','WEBHOOK','MANUAL')),
  source_event_id     text,
  mapping_version     integer,
  lead_stage_event_id uuid        references public.lead_stage_events (id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint hubspot_stage_history_unique unique (external_id, to_stage, occurred_at)
);
create index hubspot_stage_history_workspace_idx on public.hubspot_stage_history (workspace_id, occurred_at desc);
create index hubspot_stage_history_object_idx on public.hubspot_stage_history (hubspot_object_id, occurred_at);

create trigger hubspot_mappings_touch before update on public.hubspot_mappings for each row execute function app.touch_updated_at();
create trigger hubspot_objects_touch  before update on public.hubspot_objects  for each row execute function app.touch_updated_at();

-- A published mapping is what the sync actually ran against; freeze it.
create trigger hubspot_mappings_immutable
  before update or delete on public.hubspot_mappings
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');
