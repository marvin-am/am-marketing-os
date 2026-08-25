-- =============================================================================
-- 0011_system.sql — integrations, sync plumbing, AI jobs, outbox, audit, settings
-- =============================================================================

create table public.integration_connections (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid        not null references public.workspaces (id) on delete cascade,
  provider                text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  state                   text        not null default 'NOT_CONFIGURED' check (state in (
                            'NOT_CONFIGURED','FIXTURE','CONNECTED','DEGRADED','ERROR')),
  account_label           text,
  external_account_id     text,
  -- Only scopes the provider actually granted. Never invented (AGENTS rule 1).
  granted_scopes          text[]      not null default '{}',
  -- AES-256-GCM, same envelope as submission PII. Tokens never sit in plaintext.
  credentials_ciphertext  bytea,
  credentials_iv          bytea,
  credentials_auth_tag    bytea,
  key_version             integer     check (key_version >= 1),
  connected_at            timestamptz,
  expires_at              timestamptz,
  last_checked_at         timestamptz,
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid,
  updated_by              uuid,
  constraint integration_connections_unique unique (workspace_id, provider),
  constraint integration_connections_envelope_complete check (
    credentials_ciphertext is null
    or (credentials_iv is not null and credentials_auth_tag is not null and key_version is not null)
  )
);
create index integration_connections_workspace_idx on public.integration_connections (workspace_id);

alter table public.meta_accounts
  add constraint meta_accounts_connection_fkey
  foreign key (connection_id) references public.integration_connections (id) on delete set null;

create table public.integration_health_checks (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  provider          text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  key               text        not null,
  label_de          text        not null,
  status            text        not null check (status in ('PASS','WARN','FAIL','AWAITING_EXTERNAL_INPUT')),
  detail_de         text,
  remediation_de    text,
  blocks_live_only  boolean     not null default false,
  checked_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index integration_health_checks_latest_idx
  on public.integration_health_checks (workspace_id, provider, checked_at desc);

create table public.sync_cursors (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  provider          text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  resource          text        not null,
  cursor_value      text,
  cursor_time       timestamptz,
  last_run_at       timestamptz,
  last_success_at   timestamptz,
  last_error        text,
  consecutive_failures integer  not null default 0 check (consecutive_failures >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint sync_cursors_unique unique (workspace_id, provider, resource)
);

create table public.sync_jobs (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  provider          text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  kind              text        not null,
  state             text        not null default 'QUEUED' check (state in (
                      'QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  scheduled_for     timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  attempt_count     integer     not null default 0 check (attempt_count >= 0),
  records_processed integer     not null default 0 check (records_processed >= 0),
  records_failed    integer     not null default 0 check (records_failed >= 0),
  params            jsonb       not null default '{}'::jsonb,
  result            jsonb,
  error             text,
  idempotency_key   text        not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint sync_jobs_idempotency_unique unique (idempotency_key)
);
create index sync_jobs_queue_idx on public.sync_jobs (state, scheduled_for) where state in ('QUEUED', 'RUNNING');
create index sync_jobs_workspace_idx on public.sync_jobs (workspace_id, created_at desc);

-- Raw provider payloads, kept for replay and reconciliation. One row per
-- external object; payload_hash tells us whether the last fetch changed anything.
create table public.raw_external_objects (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  provider      text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  object_type   text        not null,
  external_id   text        not null,
  payload       jsonb       not null,
  payload_hash  char(64)    not null,
  fetched_at    timestamptz not null default now(),
  version_count integer     not null default 1 check (version_count >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint raw_external_objects_unique unique (provider, object_type, external_id)
);
create index raw_external_objects_workspace_idx on public.raw_external_objects (workspace_id, provider, fetched_at desc);

create table public.prompt_versions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  key           text        not null,
  version       integer     not null check (version >= 1),
  state         text        not null default 'DRAFT' check (state in ('DRAFT','PUBLISHED','ARCHIVED')),
  template      text        not null,
  system_prompt text,
  model         text        not null,
  -- The JSON schema the model output is validated against before it is stored.
  output_schema jsonb       not null default '{}'::jsonb,
  temperature   numeric(4,3),
  max_tokens    integer,
  notes         text,
  content_hash  char(64)    not null,
  published_at  timestamptz,
  published_by  uuid,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid,
  constraint prompt_versions_unique unique (workspace_id, key, version)
);
create index prompt_versions_key_idx on public.prompt_versions (workspace_id, key, version desc);
create unique index prompt_versions_active_key
  on public.prompt_versions (workspace_id, key) where state = 'PUBLISHED';

create table public.ai_jobs (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id        uuid        references public.campaigns (id) on delete cascade,
  kind               text        not null,
  state              text        not null default 'QUEUED' check (state in (
                       'QUEUED','RUNNING','SUCCEEDED','FAILED','REJECTED')),
  prompt_version_id  uuid        references public.prompt_versions (id) on delete set null,
  model              text        not null default '',
  input_hash         char(64),
  -- Redacted context digest, never the raw prompt with customer data.
  input_redacted     jsonb       not null default '{}'::jsonb,
  output             jsonb,
  output_valid       boolean,
  validation_errors  jsonb,
  token_input        integer     check (token_input >= 0),
  token_output       integer     check (token_output >= 0),
  cost_minor         bigint      check (cost_minor >= 0),
  latency_ms         integer     check (latency_ms >= 0),
  attempt_count      integer     not null default 0 check (attempt_count >= 0),
  started_at         timestamptz,
  finished_at        timestamptz,
  error              text,
  idempotency_key    text        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  constraint ai_jobs_idempotency_unique unique (idempotency_key)
);
create index ai_jobs_campaign_idx on public.ai_jobs (campaign_id, created_at desc);
create index ai_jobs_workspace_state_idx on public.ai_jobs (workspace_id, state, created_at desc);

alter table public.campaign_proposals
  add constraint campaign_proposals_ai_job_fkey foreign key (ai_job_id) references public.ai_jobs (id) on delete set null,
  add constraint campaign_proposals_prompt_fkey foreign key (prompt_version_id) references public.prompt_versions (id) on delete set null;

-- Every external mutation goes through a command record. Only PROVIDER_CONFIRMED
-- and RECONCILED may ever be rendered as success (AGENTS rule 3).
create table public.external_commands (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid        not null references public.workspaces (id) on delete cascade,
  provider                  text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  kind                      text        not null check (kind in (
                              'CREATE_DRAFT_CAMPAIGN','PAUSE_ENTITY','RESUME_ENTITY',
                              'INCREASE_BUDGET','DECREASE_BUDGET','PAUSE_CREATIVE')),
  idempotency_key           text        not null,
  state                     text        not null default 'PENDING_CONFIRMATION' check (state in (
                              'PENDING_CONFIRMATION','QUEUED','IN_FLIGHT','PROVIDER_CONFIRMED',
                              'FAILED','RECONCILED','BLOCKED_BY_FLAG')),
  campaign_id               uuid        references public.campaigns (id) on delete set null,
  recommendation_id         uuid,
  target_level              text        check (target_level in ('CAMPAIGN','ADSET','AD')),
  target_external_id        text,
  request_preview           jsonb       not null default '{}'::jsonb,
  provider_response_redacted jsonb,
  error                     text,
  attempt_count             integer     not null default 0 check (attempt_count >= 0),
  requested_by              uuid,
  requested_at              timestamptz not null default now(),
  confirmed_at              timestamptz,
  reconciled_at             timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint external_commands_idempotency_unique unique (idempotency_key),
  constraint external_commands_confirmed_has_time check (
    state <> 'PROVIDER_CONFIRMED' or confirmed_at is not null
  )
);
create index external_commands_workspace_idx on public.external_commands (workspace_id, requested_at desc);
create index external_commands_campaign_idx on public.external_commands (campaign_id, state);

create table public.recommendations (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid        not null references public.workspaces (id) on delete cascade,
  campaign_id                 uuid        not null references public.campaigns (id) on delete cascade,
  experiment_id               uuid        references public.experiments (id) on delete set null,
  action                      text        not null check (action in (
                                'CONTINUE','PAUSE_CREATIVE','PAUSE_FUNNEL_ARM','INCREASE_BUDGET',
                                'DECREASE_BUDGET','CONCLUDE_EXPERIMENT','NEW_CREATIVE_ITERATION',
                                'TEST_NEW_ANGLE','KEEP_OFFER_CHANGE_MESSAGING','COLLECT_MORE_DATA')),
  state                       text        not null default 'OPEN' check (state in (
                                'OPEN','ACCEPTED','DISMISSED','EXECUTING','EXECUTED',
                                'EXECUTION_FAILED','SUPERSEDED')),
  rule_id                     text        not null,
  -- Stable key for "the same finding": lets a re-run update instead of piling up.
  dedup_key                   text        not null,
  title_de                    text        not null,
  summary_de                  text        not null,
  -- Optional model prose. Never the source of a number (AGENTS rule 4).
  explanation_de              text,
  next_hypothesis_de          text,
  facts                       jsonb       not null default '[]'::jsonb,
  comparison_basis_de         text        not null,
  maturity                    text        not null check (maturity in ('IMMATURE','PARTIAL','MATURE')),
  attribution_coverage        numeric(6,5) check (attribution_coverage between 0 and 1),
  uncertainty_de              text        not null,
  risk                        text        not null check (risk in ('LOW','MEDIUM','HIGH')),
  risk_note_de                text,
  affected_meta_objects       jsonb       not null default '[]'::jsonb,
  proposed_budget_change_pct  numeric(8,5),
  superseded_by               uuid        references public.recommendations (id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid,
  updated_by                  uuid,
  constraint recommendations_facts_present check (jsonb_array_length(facts) >= 1)
);
create unique index recommendations_open_dedup_key
  on public.recommendations (campaign_id, rule_id, dedup_key)
  where state = 'OPEN';
create index recommendations_workspace_idx on public.recommendations (workspace_id, state, created_at desc);
create index recommendations_campaign_idx on public.recommendations (campaign_id, created_at desc);

alter table public.external_commands
  add constraint external_commands_recommendation_fkey
  foreign key (recommendation_id) references public.recommendations (id) on delete set null;

create table public.recommendation_actions (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid        not null references public.workspaces (id) on delete cascade,
  recommendation_id      uuid        not null references public.recommendations (id) on delete cascade,
  action                 text        not null check (action in (
                           'ACCEPTED','DISMISSED','EXECUTION_STARTED','EXECUTED',
                           'EXECUTION_FAILED','SUPERSEDED')),
  external_command_id    uuid        references public.external_commands (id) on delete set null,
  command_state          text        check (command_state in (
                           'PENDING_CONFIRMATION','QUEUED','IN_FLIGHT','PROVIDER_CONFIRMED',
                           'FAILED','RECONCILED','BLOCKED_BY_FLAG')),
  actor_id               uuid,
  actor_label            text        not null default 'system',
  note_de                text,
  executed_at            timestamptz,
  provider_confirmed_at  timestamptz,
  error                  text,
  created_at             timestamptz not null default now()
);
create index recommendation_actions_idx on public.recommendation_actions (recommendation_id, created_at);
create index recommendation_actions_workspace_idx on public.recommendation_actions (workspace_id, created_at desc);

create table public.learning_cards (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid        not null references public.workspaces (id) on delete cascade,
  version                   integer     not null default 1 check (version >= 1),
  campaign_id               uuid        references public.campaigns (id) on delete cascade,
  experiment_id             uuid        references public.experiments (id) on delete cascade,
  title_de                  text        not null,
  what_was_tested_de        text        not null,
  angle_id                  uuid        references public.angles (id) on delete set null,
  angle_name                text,
  offer_id                  uuid        references public.offers (id) on delete set null,
  offer_name                text,
  creative_concept_de       text,
  funnel_kind               text        check (funnel_kind in ('LANDING_PAGE','MULTI_STEP_FORM','HYBRID')),
  audience_de               text,
  period_start              timestamptz,
  period_end                timestamptz,
  spend_minor               bigint      not null default 0 check (spend_minor >= 0),
  currency                  text        not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  outcome_de                text        not null,
  -- Numerator/denominator carried alongside every value (acceptance criterion 19).
  outcome_facts             jsonb       not null default '[]'::jsonb,
  data_maturity             text        not null check (data_maturity in ('IMMATURE','PARTIAL','MATURE')),
  attribution_level         text        not null check (attribution_level in (
                              'CREATIVE_ONLY','TRAFFIC_LINKED','LEAD_LINKED','REVENUE_LINKED')),
  attribution_coverage      numeric(6,5) check (attribution_coverage between 0 and 1),
  possible_explanation_de   text,
  suggested_next_test_de    text,
  -- Derived by deriveConfidence(); the model may not upgrade it.
  confidence                text        not null check (confidence in ('FACT','INDICATION','HYPOTHESIS')),
  superseded_by             uuid        references public.learning_cards (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid,
  updated_by                uuid,
  constraint learning_cards_anchored check (campaign_id is not null or experiment_id is not null)
);
create unique index learning_cards_version_key on public.learning_cards (
  workspace_id,
  coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(experiment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  version
);
create index learning_cards_workspace_idx on public.learning_cards (workspace_id, created_at desc);
create index learning_cards_campaign_idx on public.learning_cards (campaign_id) where campaign_id is not null;

-- Transactional outbox (spec §24). The business write and this row land in the
-- same transaction — that is what makes "a HubSpot outage never loses a lead" true.
create table public.outbox_events (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid        not null references public.workspaces (id) on delete cascade,
  destination                text        not null check (destination in (
                               'META_CAPI','HUBSPOT','META_MARKETING_API')),
  -- Deterministic dispatch id. sha256(form_instance:event_type:transition_version)
  -- for down-funnel CAPI, `lead:<submission_id>` for the initial website lead.
  event_id                   text        not null,
  -- NOT NULL with an empty-string default on purpose: a nullable column would
  -- make the dedup constraint silently permissive for HubSpot rows.
  dataset_id                 text        not null default '',
  event_name                 text        not null,
  -- Business time of the event, never the retry time (spec §23).
  event_time                 timestamptz not null,
  payload                    jsonb       not null default '{}'::jsonb,
  payload_hash               char(64)    not null,
  status                     text        not null default 'PENDING' check (status in (
                               'PENDING','PROCESSING','SENT','ACCEPTED','FAILED_RETRYING',
                               'DEAD_LETTER','EXPIRED')),
  attempt_count              integer     not null default 0 check (attempt_count >= 0),
  next_attempt_at            timestamptz,
  last_error                 text,
  provider_response_redacted jsonb,
  sent_at                    timestamptz,
  locked_at                  timestamptz,
  locked_by                  text,
  campaign_id                uuid        references public.campaigns (id) on delete set null,
  submission_id              uuid        references public.form_submissions (id) on delete set null,
  lead_id                    uuid        references public.leads (id) on delete set null,
  opportunity_id             uuid        references public.opportunities (id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint outbox_events_dedup_unique unique (destination, dataset_id, event_id)
);
create index outbox_events_claim_idx
  on public.outbox_events (destination, next_attempt_at)
  where status in ('PENDING', 'FAILED_RETRYING');
create index outbox_events_workspace_idx on public.outbox_events (workspace_id, created_at desc);
create index outbox_events_status_idx on public.outbox_events (workspace_id, status);
create index outbox_events_submission_idx on public.outbox_events (submission_id) where submission_id is not null;

alter table public.capi_dispatches
  add constraint capi_dispatches_outbox_fkey foreign key (outbox_event_id) references public.outbox_events (id) on delete set null;
alter table public.hubspot_sync_attempts
  add constraint hubspot_sync_attempts_outbox_fkey foreign key (outbox_event_id) references public.outbox_events (id) on delete set null;

create table public.webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid        not null references public.workspaces (id) on delete cascade,
  provider           text        not null check (provider in ('META','HUBSPOT','OPENAI','SUPABASE')),
  event_kind         text        not null,
  external_event_id  text        not null,
  signature_valid    boolean     not null default false,
  status             text        not null default 'RECEIVED' check (status in (
                       'RECEIVED','PROCESSED','IGNORED','FAILED')),
  payload            jsonb       not null,
  payload_hash       char(64)    not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  error              text,
  retry_count        integer     not null default 0 check (retry_count >= 0),
  created_at         timestamptz not null default now(),
  constraint webhook_events_external_unique unique (provider, external_event_id)
);
create index webhook_events_workspace_idx on public.webhook_events (workspace_id, received_at desc);
create index webhook_events_pending_idx on public.webhook_events (status, received_at) where status = 'RECEIVED';

create table public.audit_logs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  action          text        not null check (action in (
                    'campaign.created','campaign.state_changed','campaign.version_published',
                    'proposal.generated','proposal.regenerated','angle.approved','offer.approved',
                    'claim.changed','approval.granted','approval.rejected','approval.invalidated',
                    'creative.generated','creative.edited','creative.approved',
                    'funnel.version_created','funnel.published','form.version_created','form.published',
                    'experiment.started','experiment.concluded','launch_qa.evaluated',
                    'meta.command_requested','meta.command_confirmed','meta.command_failed',
                    'meta.import_completed','hubspot.mapping_published','hubspot.test_lead_sent',
                    'hubspot.sync_failed','hubspot.sync_retried','capi.dispatched','capi.dead_lettered',
                    'recommendation.generated','recommendation.accepted','recommendation.dismissed',
                    'recommendation.executed','settings.changed','integration.connected',
                    'integration.disconnected','user.role_changed','retention.purge_executed')),
  occurred_at     timestamptz not null default now(),
  actor_id        uuid,
  actor_label     text        not null,
  entity_type     text        not null,
  entity_id       text        not null,
  campaign_id     uuid        references public.campaigns (id) on delete set null,
  summary_de      text        not null,
  -- Already passed through redact(); never PII, never a secret.
  before          jsonb,
  after           jsonb,
  correlation_id  text,
  created_at      timestamptz not null default now()
);
create index audit_logs_workspace_time_idx on public.audit_logs (workspace_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_campaign_idx on public.audit_logs (campaign_id, occurred_at desc) where campaign_id is not null;
create index audit_logs_action_idx on public.audit_logs (workspace_id, action, occurred_at desc);

create table public.workspace_settings (
  workspace_id             uuid primary key references public.workspaces (id) on delete cascade,
  experiment_thresholds    jsonb       not null default '{}'::jsonb,
  recommendation_config    jsonb       not null default '{}'::jsonb,
  retention_policy         jsonb       not null default '{}'::jsonb,
  attribution_window_days  integer     not null default 30 check (attribution_window_days >= 1),
  form_abandon_minutes     integer     not null default 30 check (form_abandon_minutes >= 1),
  historical_import_months integer     not null default 24 check (historical_import_months >= 1),
  active_consent_version_id uuid       references public.consent_versions (id) on delete set null,
  vq_model_version         text        not null default 'vq-1',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               uuid
);

create trigger integration_connections_touch before update on public.integration_connections for each row execute function app.touch_updated_at();
create trigger sync_cursors_touch            before update on public.sync_cursors            for each row execute function app.touch_updated_at();
create trigger sync_jobs_touch               before update on public.sync_jobs               for each row execute function app.touch_updated_at();
create trigger raw_external_objects_touch    before update on public.raw_external_objects    for each row execute function app.touch_updated_at();
create trigger prompt_versions_touch         before update on public.prompt_versions         for each row execute function app.touch_updated_at();
create trigger ai_jobs_touch                 before update on public.ai_jobs                 for each row execute function app.touch_updated_at();
create trigger external_commands_touch       before update on public.external_commands       for each row execute function app.touch_updated_at();
create trigger recommendations_touch         before update on public.recommendations         for each row execute function app.touch_updated_at();
create trigger learning_cards_touch          before update on public.learning_cards          for each row execute function app.touch_updated_at();
create trigger outbox_events_touch           before update on public.outbox_events           for each row execute function app.touch_updated_at();
create trigger workspace_settings_touch      before update on public.workspace_settings      for each row execute function app.touch_updated_at();

-- A published prompt version is what actually produced the stored output; freeze it.
create trigger prompt_versions_immutable
  before update or delete on public.prompt_versions
  for each row execute function app.enforce_version_immutability('state', '{PUBLISHED}');
