-- =============================================================================
-- 0008_tracking_leads.sql — visitors, sessions, events, submissions, leads, revenue
-- =============================================================================
-- PII boundary (AGENTS rule 7):
--   * events, touchpoints, sessions, submission_answers_non_pii hold NO personal
--     data — no name, e-mail, phone, free text, IP or user agent.
--   * The only place personal data exists is submission_pii_encrypted, as
--     AES-256-GCM ciphertext plus a key_version.
--   * Identity resolution uses salted SHA-256 hashes, never plaintext.
-- =============================================================================

create table public.visitors (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  traffic_kind    text        not null default 'PRODUCTION' check (traffic_kind in (
                    'PRODUCTION','PREVIEW','INTERNAL','BOT','TEST')),
  consent_status  text        not null default 'UNKNOWN' check (consent_status in ('GRANTED','DENIED','UNKNOWN')),
  session_count   integer     not null default 0 check (session_count >= 0),
  created_at      timestamptz not null default now()
);
create index visitors_workspace_idx on public.visitors (workspace_id, last_seen_at desc);

create table public.sessions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  visitor_id           uuid        not null references public.visitors (id) on delete cascade,
  started_at           timestamptz not null default now(),
  last_activity_at     timestamptz not null default now(),
  ended_at             timestamptz,
  environment          text        not null default 'production' check (environment in (
                         'production','preview','development','test')),
  traffic_kind         text        not null default 'PRODUCTION' check (traffic_kind in (
                         'PRODUCTION','PREVIEW','INTERNAL','BOT','TEST')),
  consent_status       text        not null default 'UNKNOWN' check (consent_status in ('GRANTED','DENIED','UNKNOWN')),
  channel              text        not null default 'UNKNOWN' check (channel in (
                         'META_PAID','GOOGLE_PAID','ORGANIC_SEARCH','ORGANIC_SOCIAL',
                         'REFERRAL','EMAIL','DIRECT','UNKNOWN')),
  landing_url          text,
  referrer             text,
  utm_source           text,
  utm_medium           text,
  utm_campaign         text,
  utm_content          text,
  utm_term             text,
  fbclid               text,
  fbc                  text,
  fbp                  text,
  meta_campaign_id     text,
  meta_adset_id        text,
  meta_ad_id           text,
  published_funnel_id  uuid        references public.published_funnels (id) on delete set null,
  funnel_version_id    uuid        references public.funnel_versions (id) on delete set null,
  campaign_id          uuid        references public.campaigns (id) on delete set null,
  experiment_id        uuid        references public.experiments (id) on delete set null,
  experiment_arm_id    uuid        references public.experiment_arms (id) on delete set null,
  -- Non-PII coarse buckets only. No user agent, no IP.
  device_bucket        text        check (device_bucket in ('MOBILE','TABLET','DESKTOP','UNKNOWN')),
  event_count          integer     not null default 0 check (event_count >= 0),
  created_at           timestamptz not null default now()
);
create index sessions_visitor_idx on public.sessions (visitor_id, started_at desc);
create index sessions_workspace_time_idx on public.sessions (workspace_id, started_at desc);
create index sessions_campaign_idx on public.sessions (campaign_id, started_at desc) where campaign_id is not null;
create index sessions_experiment_idx on public.sessions (experiment_id, experiment_arm_id) where experiment_id is not null;

-- Appended, never mutated: a later visit adds an INFLUENCED touch but can never
-- rewrite an existing ACQUISITION touch (spec §19).
create table public.touchpoints (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  visitor_id           uuid        not null references public.visitors (id) on delete cascade,
  session_id           uuid        not null references public.sessions (id) on delete cascade,
  occurred_at          timestamptz not null default now(),
  channel              text        not null check (channel in (
                         'META_PAID','GOOGLE_PAID','ORGANIC_SEARCH','ORGANIC_SOCIAL',
                         'REFERRAL','EMAIL','DIRECT','UNKNOWN')),
  role                 text        not null check (role in ('FIRST','LAST','ACQUISITION','INFLUENCED')),
  confidence           text        not null check (confidence in (
                         'EXACT','HIGH_CONFIDENCE','MEDIUM_CONFIDENCE','LOW_CONFIDENCE','UNKNOWN')),
  from_signed_token    boolean     not null default false,
  campaign_id          uuid,
  campaign_version_id  uuid,
  angle_id             uuid,
  angle_version_id     uuid,
  offer_id             uuid,
  offer_version_id     uuid,
  creative_id          uuid,
  creative_version_id  uuid,
  funnel_id            uuid,
  funnel_version_id    uuid,
  form_id              uuid,
  form_version_id      uuid,
  experiment_id        uuid,
  experiment_arm_id    uuid,
  utm_source           text,
  utm_medium           text,
  utm_campaign         text,
  utm_content          text,
  utm_term             text,
  fbclid               text,
  fbc                  text,
  fbp                  text,
  meta_campaign_id     text,
  meta_adset_id        text,
  meta_ad_id           text,
  referrer             text,
  landing_url          text,
  created_at           timestamptz not null default now()
);
create index touchpoints_visitor_idx on public.touchpoints (visitor_id, occurred_at);
create index touchpoints_session_idx on public.touchpoints (session_id);
create index touchpoints_workspace_time_idx on public.touchpoints (workspace_id, occurred_at desc);
create index touchpoints_campaign_idx on public.touchpoints (campaign_id, occurred_at) where campaign_id is not null;

-- The first-party event log. `id` is the client-generated event uuid, which makes
-- a retried beacon a no-op instead of a double count.
create table public.events (
  id                    uuid primary key,
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  event_type            text        not null check (event_type in (
                          'funnel_viewed','experiment_exposed','form_viewed','form_started',
                          'form_step_viewed','form_step_completed','form_validation_failed',
                          'lead_submit_attempted','lead_submitted','lead_submit_failed',
                          'thank_you_viewed','booking_started','form_abandoned','vq_scheduled')),
  event_schema_version  integer     not null default 1,
  occurred_at           timestamptz not null,
  received_at           timestamptz not null default now(),
  environment           text        not null default 'production' check (environment in (
                          'production','preview','development','test')),
  traffic_kind          text        not null default 'PRODUCTION' check (traffic_kind in (
                          'PRODUCTION','PREVIEW','INTERNAL','BOT','TEST')),
  visitor_id            uuid        not null,
  session_id            uuid        not null,
  campaign_id           uuid,
  campaign_version_id   uuid,
  angle_id              uuid,
  angle_version_id      uuid,
  offer_id              uuid,
  offer_version_id      uuid,
  creative_id           uuid,
  creative_version_id   uuid,
  funnel_id             uuid,
  funnel_version_id     uuid,
  form_id               uuid,
  form_version_id       uuid,
  experiment_id         uuid,
  experiment_arm_id     uuid,
  form_instance_id      uuid,
  submission_id         uuid,
  step_id               text        check (step_id ~ '^[a-z][a-z0-9_]*$'),
  field_id              text        check (field_id ~ '^[a-z][a-z0-9_]*$'),
  error_code            text        check (error_code in (
                          'REQUIRED','INVALID_FORMAT','TOO_SHORT','TOO_LONG','OUT_OF_RANGE',
                          'INVALID_POSTCODE','INVALID_EMAIL','INVALID_PHONE','CONSENT_REQUIRED',
                          'UNKNOWN_OPTION','SERVER_REJECTED')),
  consent_status        text        not null default 'UNKNOWN' check (consent_status in ('GRANTED','DENIED','UNKNOWN')),
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text,
  utm_term              text,
  fbclid                text,
  fbc                   text,
  fbp                   text,
  meta_campaign_id      text,
  meta_adset_id         text,
  meta_ad_id            text,
  referrer              text,
  landing_url           text,
  -- Strictly non-PII scalars only; the collector runs assertNoPii() first.
  metadata              jsonb       not null default '{}'::jsonb
);
create index events_workspace_time_idx on public.events (workspace_id, occurred_at desc);
create index events_type_time_idx on public.events (workspace_id, event_type, occurred_at desc);
create index events_session_idx on public.events (session_id, occurred_at);
create index events_campaign_time_idx on public.events (campaign_id, occurred_at desc) where campaign_id is not null;
create index events_experiment_idx on public.events (experiment_id, experiment_arm_id, occurred_at) where experiment_id is not null;
create index events_form_instance_idx on public.events (form_instance_id) where form_instance_id is not null;

create table public.form_instances (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  published_funnel_id  uuid        references public.published_funnels (id) on delete set null,
  funnel_version_id    uuid        references public.funnel_versions (id) on delete set null,
  form_version_id      uuid        references public.form_versions (id) on delete set null,
  visitor_id           uuid        not null references public.visitors (id) on delete cascade,
  session_id           uuid        not null references public.sessions (id) on delete cascade,
  campaign_id          uuid        references public.campaigns (id) on delete set null,
  experiment_id        uuid        references public.experiments (id) on delete set null,
  experiment_arm_id    uuid        references public.experiment_arms (id) on delete set null,
  started_at           timestamptz not null default now(),
  last_activity_at     timestamptz not null default now(),
  completed_at         timestamptz,
  -- Derived server-side after an inactivity window, never from `beforeunload`.
  abandoned_at         timestamptz,
  current_step_key     text,
  steps_completed      integer     not null default 0 check (steps_completed >= 0),
  step_count           integer     not null default 0 check (step_count >= 0),
  environment          text        not null default 'production' check (environment in (
                         'production','preview','development','test')),
  traffic_kind         text        not null default 'PRODUCTION' check (traffic_kind in (
                         'PRODUCTION','PREVIEW','INTERNAL','BOT','TEST')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index form_instances_session_idx on public.form_instances (session_id);
create index form_instances_workspace_time_idx on public.form_instances (workspace_id, started_at desc);
create index form_instances_open_idx on public.form_instances (last_activity_at)
  where completed_at is null and abandoned_at is null;

create table public.form_submissions (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  -- Client-generated per submit intent. THE idempotency key: a double submit,
  -- a retried fetch and a replayed beacon all collapse onto one row.
  submission_attempt_id    uuid        not null,
  form_instance_id         uuid        references public.form_instances (id) on delete set null,
  form_version_id          uuid        references public.form_versions (id) on delete set null,
  funnel_version_id        uuid        references public.funnel_versions (id) on delete set null,
  published_funnel_id      uuid        references public.published_funnels (id) on delete set null,
  campaign_id              uuid        references public.campaigns (id) on delete set null,
  experiment_id            uuid        references public.experiments (id) on delete set null,
  experiment_arm_id        uuid        references public.experiment_arms (id) on delete set null,
  visitor_id               uuid        references public.visitors (id) on delete set null,
  session_id               uuid        references public.sessions (id) on delete set null,
  state                    text        not null default 'CREATED' check (state in (
                             'CREATED','VALIDATED','ACCEPTED','HUBSPOT_PENDING','HUBSPOT_SYNCED',
                             'REJECTED_VALIDATION','REJECTED_SPAM','SYNC_FAILED_RETRYING','DEAD_LETTER')),
  submitted_at             timestamptz not null default now(),
  accepted_at              timestamptz,
  environment              text        not null default 'production' check (environment in (
                             'production','preview','development','test')),
  traffic_kind             text        not null default 'PRODUCTION' check (traffic_kind in (
                             'PRODUCTION','PREVIEW','INTERNAL','BOT','TEST')),
  consent_version_id       uuid        references public.consent_versions (id) on delete restrict,
  consent_status           text        not null default 'UNKNOWN' check (consent_status in ('GRANTED','DENIED','UNKNOWN')),
  consent_purposes         text[]      not null default '{}',
  consent_text_hash        char(64),
  spam_score               numeric(5,4) check (spam_score between 0 and 1),
  spam_reason              text,
  validation_error_codes   text[]      not null default '{}',
  -- Hash of the canonicalised answer set; lets us detect a re-post without
  -- storing the answers twice.
  answers_hash             char(64),
  attribution_snapshot_id  uuid,
  lead_id                  uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Acceptance criterion: ten identical submits produce exactly one row.
  constraint form_submissions_attempt_unique unique (submission_attempt_id)
);
create index form_submissions_workspace_time_idx on public.form_submissions (workspace_id, submitted_at desc);
create index form_submissions_campaign_idx on public.form_submissions (campaign_id, submitted_at desc) where campaign_id is not null;
create index form_submissions_state_idx on public.form_submissions (workspace_id, state);
create index form_submissions_experiment_idx on public.form_submissions (experiment_id, experiment_arm_id) where experiment_id is not null;
create index form_submissions_instance_idx on public.form_submissions (form_instance_id) where form_instance_id is not null;

-- Qualification and operational answers only. A field whose type is inherently
-- personal (EMAIL, PHONE, FIRST_NAME, LAST_NAME) may never land here.
create table public.submission_answers_non_pii (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  submission_id         uuid        not null references public.form_submissions (id) on delete cascade,
  field_key             text        not null check (field_key ~ '^[a-z][a-z0-9_]*$'),
  step_key              text,
  field_type            text        not null check (field_type in (
                          'SINGLE_SELECT','MULTI_SELECT','BOOLEAN','NUMBER','RANGE',
                          'SHORT_TEXT','LONG_TEXT','POSTCODE','CONSENT')),
  pii_class             text        not null default 'QUALIFICATION' check (pii_class in ('QUALIFICATION','OPERATIONAL')),
  qualification_class   text        not null default 'NONE' check (qualification_class in (
                          'NONE','SCORING','DISQUALIFYING','ROUTING_ONLY')),
  value_text            text,
  value_number          numeric,
  value_bool            boolean,
  value_options         text[],
  score_contribution    numeric,
  created_at            timestamptz not null default now(),
  constraint submission_answers_unique unique (submission_id, field_key)
);
create index submission_answers_workspace_idx on public.submission_answers_non_pii (workspace_id);
create index submission_answers_field_idx on public.submission_answers_non_pii (field_key, value_text);

comment on table public.submission_answers_non_pii is
  'No PII, ever. The CHECK on field_type structurally excludes EMAIL/PHONE/FIRST_NAME/LAST_NAME.';

-- The single home of personal data. Ciphertext only.
create table public.submission_pii_encrypted (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  submission_id  uuid        not null references public.form_submissions (id) on delete cascade,
  algorithm      text        not null default 'AES-256-GCM' check (algorithm = 'AES-256-GCM'),
  key_version    integer     not null default 1 check (key_version >= 1),
  iv             bytea       not null,
  auth_tag       bytea       not null,
  ciphertext     bytea       not null,
  -- Salted SHA-256 for identity resolution and CAPI hashing. Not reversible.
  email_hash     char(64),
  phone_hash     char(64),
  email_domain   text,
  purged_at      timestamptz,
  created_at     timestamptz not null default now(),
  constraint submission_pii_unique unique (submission_id)
);
create index submission_pii_email_hash_idx on public.submission_pii_encrypted (email_hash) where email_hash is not null;
create index submission_pii_workspace_idx on public.submission_pii_encrypted (workspace_id);

comment on table public.submission_pii_encrypted is
  'AES-256-GCM ciphertext plus key_version. Never joined into analytics, never logged.';

create table public.submission_status_history (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  submission_id   uuid        not null references public.form_submissions (id) on delete cascade,
  from_state      text        check (from_state in (
                    'CREATED','VALIDATED','ACCEPTED','HUBSPOT_PENDING','HUBSPOT_SYNCED',
                    'REJECTED_VALIDATION','REJECTED_SPAM','SYNC_FAILED_RETRYING','DEAD_LETTER')),
  to_state        text        not null check (to_state in (
                    'CREATED','VALIDATED','ACCEPTED','HUBSPOT_PENDING','HUBSPOT_SYNCED',
                    'REJECTED_VALIDATION','REJECTED_SPAM','SYNC_FAILED_RETRYING','DEAD_LETTER')),
  occurred_at     timestamptz not null default now(),
  reason_de       text,
  actor_label     text        not null default 'system',
  correlation_id  text,
  created_at      timestamptz not null default now()
);
create index submission_status_history_idx on public.submission_status_history (submission_id, occurred_at);
create index submission_status_history_workspace_idx on public.submission_status_history (workspace_id, occurred_at desc);

-- Immutable snapshot written at final submit. Everything downstream reads this,
-- never a live re-derivation (spec §19).
create table public.attribution_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  submission_id         uuid        not null references public.form_submissions (id) on delete cascade,
  -- Guard column for the shared immutability trigger. Always true.
  frozen                boolean     not null default true check (frozen),
  campaign_id           uuid,
  campaign_version_id   uuid,
  angle_id              uuid,
  angle_version_id      uuid,
  offer_id              uuid,
  offer_version_id      uuid,
  creative_id           uuid,
  creative_version_id   uuid,
  funnel_id             uuid,
  funnel_version_id     uuid,
  form_id               uuid,
  form_version_id       uuid,
  experiment_id         uuid,
  experiment_arm_id     uuid,
  first_touch           jsonb,
  last_touch            jsonb,
  acquisition_touch     jsonb,
  influenced_touch_ids  uuid[]      not null default '{}',
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text,
  utm_term              text,
  fbclid                text,
  fbc                   text,
  fbp                   text,
  meta_campaign_id      text,
  meta_adset_id         text,
  meta_ad_id            text,
  referrer              text,
  landing_url           text,
  channel               text        not null check (channel in (
                          'META_PAID','GOOGLE_PAID','ORGANIC_SEARCH','ORGANIC_SOCIAL',
                          'REFERRAL','EMAIL','DIRECT','UNKNOWN')),
  level                 text        not null check (level in (
                          'CREATIVE_ONLY','TRAFFIC_LINKED','LEAD_LINKED','REVENUE_LINKED')),
  confidence            text        not null check (confidence in (
                          'EXACT','HIGH_CONFIDENCE','MEDIUM_CONFIDENCE','LOW_CONFIDENCE','UNKNOWN')),
  consent_status        text        not null default 'UNKNOWN' check (consent_status in ('GRANTED','DENIED','UNKNOWN')),
  days_to_conversion    numeric(8,3),
  window_days           integer     not null default 30 check (window_days >= 1),
  created_at            timestamptz not null default now(),
  constraint attribution_snapshots_submission_unique unique (submission_id)
);
create index attribution_snapshots_campaign_idx on public.attribution_snapshots (campaign_id, created_at desc);
create index attribution_snapshots_workspace_idx on public.attribution_snapshots (workspace_id, created_at desc);
create index attribution_snapshots_experiment_idx on public.attribution_snapshots (experiment_id, experiment_arm_id)
  where experiment_id is not null;

alter table public.form_submissions
  add constraint form_submissions_snapshot_fkey
  foreign key (attribution_snapshot_id) references public.attribution_snapshots (id) on delete set null;

create table public.leads (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid        not null references public.workspaces (id) on delete cascade,
  -- Stable internal person identity, independent of any CRM id.
  am_person_id        uuid        not null,
  submission_id       uuid        not null references public.form_submissions (id) on delete cascade,
  campaign_id         uuid        references public.campaigns (id) on delete set null,
  hubspot_contact_id  text,
  hubspot_company_id  text,
  sync_status         text        not null default 'PENDING' check (sync_status in (
                        'PENDING','SYNCED','FAILED_RETRYING','DEAD_LETTER')),
  vq_status           text        not null default 'NOT_SCHEDULED' check (vq_status in (
                        'NOT_SCHEDULED','SCHEDULED','ATTENDED','NO_SHOW','PASSED','REJECTED')),
  vq_score            numeric(6,2) check (vq_score between 0 and 100),
  vq_reason_codes     text[]      not null default '{}',
  vq_model_version    text,
  vq_evaluated_at     timestamptz,
  vq_scheduled_at     timestamptz,
  vq_occurred_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint leads_submission_unique unique (submission_id)
);
create index leads_workspace_time_idx on public.leads (workspace_id, created_at desc);
create index leads_person_idx on public.leads (am_person_id);
create index leads_campaign_idx on public.leads (campaign_id, created_at desc) where campaign_id is not null;
create unique index leads_hubspot_contact_key on public.leads (hubspot_contact_id) where hubspot_contact_id is not null;

alter table public.form_submissions
  add constraint form_submissions_lead_fkey
  foreign key (lead_id) references public.leads (id) on delete set null;

create table public.opportunities (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid        not null references public.workspaces (id) on delete cascade,
  am_opportunity_id         uuid        not null,
  am_person_id              uuid        not null,
  lead_id                   uuid        references public.leads (id) on delete set null,
  -- Immutable: the submission that acquired this opportunity (spec §22).
  acquisition_submission_id uuid        not null references public.form_submissions (id) on delete restrict,
  acquisition_snapshot_id   uuid        not null references public.attribution_snapshots (id) on delete restrict,
  campaign_id               uuid        references public.campaigns (id) on delete set null,
  hubspot_deal_id           text,
  pipeline                  text,
  stage                     text,
  amount_minor              bigint,
  currency                  text        check (currency ~ '^[A-Z]{3}$'),
  closed_won_at             timestamptz,
  closed_lost_at            timestamptz,
  closed_lost_reason        text,
  sync_status               text        not null default 'PENDING' check (sync_status in (
                              'PENDING','SYNCED','FAILED_RETRYING','DEAD_LETTER')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint opportunities_am_id_unique unique (am_opportunity_id),
  constraint opportunities_not_both_closed check (closed_won_at is null or closed_lost_at is null)
);
create index opportunities_workspace_idx on public.opportunities (workspace_id, created_at desc);
create index opportunities_campaign_idx on public.opportunities (campaign_id, created_at desc) where campaign_id is not null;
create unique index opportunities_hubspot_deal_key on public.opportunities (hubspot_deal_id) where hubspot_deal_id is not null;

-- Canonical, provider-independent sales events. Written only on a *real* state
-- transition — a repeated sync that observes the same stage produces nothing.
create table public.lead_stage_events (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  lead_id                  uuid        references public.leads (id) on delete cascade,
  opportunity_id           uuid        references public.opportunities (id) on delete cascade,
  submission_id            uuid        references public.form_submissions (id) on delete cascade,
  campaign_id              uuid        references public.campaigns (id) on delete set null,
  type                     text        not null check (type in (
                             'FORM_COMPLETED','VQ_SCHEDULED','VQ_ATTENDED','VQ_NO_SHOW','VQ_PASSED',
                             'VQ_REJECTED','SALES_ACCEPTED','OPPORTUNITY_CREATED','CLOSED_WON',
                             'CLOSED_LOST','REVENUE_RECOGNIZED')),
  occurred_at              timestamptz not null,
  recorded_at              timestamptz not null default now(),
  source_object            text        not null check (source_object in ('CONTACT','DEAL','INTERNAL','WEBHOOK')),
  hubspot_object_id        text,
  previous_state           text,
  new_state                text        not null,
  mapping_version          integer,
  source_event_id          text,
  attribution_snapshot_id  uuid        references public.attribution_snapshots (id) on delete set null,
  amount_minor             bigint,
  currency                 text        check (currency ~ '^[A-Z]{3}$'),
  created_at               timestamptz not null default now(),
  constraint lead_stage_events_anchored check (lead_id is not null or opportunity_id is not null)
);
create unique index lead_stage_events_source_key
  on public.lead_stage_events (source_event_id, type)
  where source_event_id is not null;
create unique index lead_stage_events_lead_transition_key
  on public.lead_stage_events (lead_id, type, new_state, occurred_at)
  where lead_id is not null;
create index lead_stage_events_workspace_time_idx on public.lead_stage_events (workspace_id, occurred_at desc);
create index lead_stage_events_campaign_idx on public.lead_stage_events (campaign_id, type, occurred_at desc);
create index lead_stage_events_opportunity_idx on public.lead_stage_events (opportunity_id, occurred_at);

create table public.revenue_events (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid        not null references public.workspaces (id) on delete cascade,
  opportunity_id              uuid        not null references public.opportunities (id) on delete cascade,
  campaign_id                 uuid        references public.campaigns (id) on delete set null,
  occurred_at                 timestamptz not null,
  amount_minor                bigint      not null,
  currency                    text        not null check (currency ~ '^[A-Z]{3}$'),
  kind                        text        not null check (kind in ('BOOKED','RECOGNIZED','ADJUSTMENT')),
  -- Set when a later value change contradicts an already-dispatched CONVERTED.
  reconciliation_delta_minor  bigint,
  source_event_id             text        not null default gen_random_uuid()::text,
  created_at                  timestamptz not null default now(),
  constraint revenue_events_source_unique unique (opportunity_id, kind, source_event_id)
);
create index revenue_events_workspace_time_idx on public.revenue_events (workspace_id, occurred_at desc);
create index revenue_events_campaign_idx on public.revenue_events (campaign_id, occurred_at desc) where campaign_id is not null;

create trigger form_instances_touch   before update on public.form_instances   for each row execute function app.touch_updated_at();
create trigger form_submissions_touch before update on public.form_submissions for each row execute function app.touch_updated_at();
create trigger leads_touch            before update on public.leads            for each row execute function app.touch_updated_at();
create trigger opportunities_touch    before update on public.opportunities    for each row execute function app.touch_updated_at();

-- An attribution snapshot is frozen the moment it exists.
create trigger attribution_snapshots_immutable
  before update or delete on public.attribution_snapshots
  for each row execute function app.enforce_version_immutability('frozen', '{true}', '{}');
