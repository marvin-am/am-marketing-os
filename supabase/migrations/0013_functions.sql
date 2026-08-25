-- =============================================================================
-- 0013_functions.sql — the runtime RPC surface
-- =============================================================================
-- Everything the *public* funnel runtime does happens through these functions.
-- They are SECURITY DEFINER, so the anon key needs no table privileges at all.
--
-- Rule followed throughout: a caller never supplies its own workspace_id. The
-- workspace is derived from the published funnel / session / experiment that the
-- caller already had to name, so a forged id cannot reach another workspace.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Public funnel read
-- -----------------------------------------------------------------------------

create or replace function public.get_published_funnel(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'published_funnel_id', pf.id,
    'workspace_id',        pf.workspace_id,
    'campaign_id',         pf.campaign_id,
    'funnel_id',           pf.funnel_id,
    'funnel_version_id',   fv.id,
    'funnel_kind',         f.kind,
    'funnel_spec',         fv.spec,
    'form_version_id',     frv.id,
    'form_spec',           frv.spec,
    'field_index',         coalesce(frv.field_index, '{}'::jsonb),
    'public_slug',         pf.public_slug,
    'path',                pf.path,
    'environment',         pf.environment,
    'meta_pixel_id',       pf.meta_pixel_id,
    'meta_dataset_id',     pf.meta_dataset_id,
    'redirect_url',        pf.redirect_url,
    'experiment_id',       pf.experiment_id,
    'consent', case when cv.id is null then null else jsonb_build_object(
      'consent_version_id',  cv.id,
      'version',             cv.version,
      'text_de',             cv.text_de,
      'purposes',            cv.purposes,
      'privacy_policy_url',  cv.privacy_policy_url
    ) end,
    'experiment', case when e.id is null then null else jsonb_build_object(
      'experiment_id',    e.id,
      'state',            e.state,
      'assignment_salt',  e.assignment_salt,
      'arms', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'arm_id',              a.id,
                 'key',                 a.key,
                 'label',               a.label,
                 'is_control',          a.is_control,
                 'allocation',          a.allocation,
                 'funnel_version_id',   a.funnel_version_id,
                 'form_version_id',     a.form_version_id,
                 'creative_version_id', a.creative_version_id
               ) order by a.sort_order, a.key), '[]'::jsonb)
        from public.experiment_arms a
        where a.experiment_id = e.id
      )
    ) end
  )
  into v_result
  from public.published_funnels pf
  join public.funnels f          on f.id = pf.funnel_id
  join public.funnel_versions fv on fv.id = pf.funnel_version_id
  left join public.form_versions frv    on frv.id = pf.form_version_id
  left join public.consent_versions cv  on cv.id = coalesce(pf.consent_version_id, frv.consent_version_id)
  left join public.experiments e        on e.id = pf.experiment_id
  where pf.public_slug = p_slug
    and pf.is_live
    and pf.unpublished_at is null;

  return v_result;
end;
$$;

comment on function public.get_published_funnel(text) is
  'The public funnel runtime read path. Returns the published specs only — never leads, submissions or PII.';

-- -----------------------------------------------------------------------------
-- Visitor / session bootstrap
-- -----------------------------------------------------------------------------

create or replace function public.ensure_visitor_session(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_funnel        public.published_funnels%rowtype;
  v_visitor_id    uuid := nullif(p_payload ->> 'visitor_id', '')::uuid;
  v_session_id    uuid := nullif(p_payload ->> 'session_id', '')::uuid;
  v_traffic_kind  text := coalesce(p_payload ->> 'traffic_kind', 'PRODUCTION');
  v_environment   text := coalesce(p_payload ->> 'environment', 'production');
  v_consent       text := coalesce(p_payload ->> 'consent_status', 'UNKNOWN');
begin
  select * into v_funnel
  from public.published_funnels
  where public_slug = p_payload ->> 'public_slug' and is_live and unpublished_at is null;

  if v_funnel.id is null then
    raise exception 'Unbekannter oder nicht veröffentlichter Funnel: %', p_payload ->> 'public_slug'
      using errcode = 'AM004';
  end if;

  if v_visitor_id is null then
    v_visitor_id := gen_random_uuid();
  end if;

  insert into public.visitors (id, workspace_id, traffic_kind, consent_status)
  values (v_visitor_id, v_funnel.workspace_id, v_traffic_kind, v_consent)
  on conflict (id) do update
    set last_seen_at   = now(),
        session_count  = public.visitors.session_count + 1,
        consent_status = case when excluded.consent_status = 'UNKNOWN'
                              then public.visitors.consent_status
                              else excluded.consent_status end;

  if v_session_id is null then
    v_session_id := gen_random_uuid();
  end if;

  insert into public.sessions (
    id, workspace_id, visitor_id, environment, traffic_kind, consent_status, channel,
    landing_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, fbc, fbp, meta_campaign_id, meta_adset_id, meta_ad_id,
    published_funnel_id, funnel_version_id, campaign_id, experiment_id, device_bucket
  )
  values (
    v_session_id, v_funnel.workspace_id, v_visitor_id, v_environment, v_traffic_kind, v_consent,
    coalesce(p_payload ->> 'channel', 'UNKNOWN'),
    p_payload ->> 'landing_url', p_payload ->> 'referrer',
    p_payload ->> 'utm_source', p_payload ->> 'utm_medium', p_payload ->> 'utm_campaign',
    p_payload ->> 'utm_content', p_payload ->> 'utm_term',
    p_payload ->> 'fbclid', p_payload ->> 'fbc', p_payload ->> 'fbp',
    p_payload ->> 'meta_campaign_id', p_payload ->> 'meta_adset_id', p_payload ->> 'meta_ad_id',
    v_funnel.id, v_funnel.funnel_version_id, v_funnel.campaign_id, v_funnel.experiment_id,
    p_payload ->> 'device_bucket'
  )
  on conflict (id) do update set last_activity_at = now();

  return jsonb_build_object(
    'visitor_id',          v_visitor_id,
    'session_id',          v_session_id,
    'workspace_id',        v_funnel.workspace_id,
    'published_funnel_id', v_funnel.id,
    'campaign_id',         v_funnel.campaign_id
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Event collection
-- -----------------------------------------------------------------------------
-- `id` is the client-generated event uuid, so a retried beacon is a no-op rather
-- than a double count. Returns how many rows were genuinely new.

create or replace function public.record_tracking_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'record_tracking_events erwartet ein JSON-Array.' using errcode = 'AM005';
  end if;

  with incoming as (
    select
      coalesce(nullif(e ->> 'event_id', '')::uuid, gen_random_uuid()) as id,
      nullif(e ->> 'session_id', '')::uuid                            as session_id,
      e                                                                as raw
    from jsonb_array_elements(p_events) as e
  ),
  resolved as (
    select i.*, s.workspace_id, s.visitor_id
    from incoming i
    join public.sessions s on s.id = i.session_id
  ),
  written as (
    insert into public.events (
      id, workspace_id, event_type, event_schema_version, occurred_at, environment, traffic_kind,
      visitor_id, session_id,
      campaign_id, campaign_version_id, angle_id, angle_version_id, offer_id, offer_version_id,
      creative_id, creative_version_id, funnel_id, funnel_version_id, form_id, form_version_id,
      experiment_id, experiment_arm_id, form_instance_id, submission_id,
      step_id, field_id, error_code, consent_status,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      fbclid, fbc, fbp, meta_campaign_id, meta_adset_id, meta_ad_id,
      referrer, landing_url, metadata
    )
    select
      r.id, r.workspace_id,
      r.raw ->> 'event_type',
      coalesce((r.raw ->> 'event_schema_version')::int, 1),
      coalesce((r.raw ->> 'occurred_at')::timestamptz, now()),
      coalesce(r.raw ->> 'environment', 'production'),
      coalesce(r.raw ->> 'traffic_kind', 'PRODUCTION'),
      coalesce(nullif(r.raw ->> 'visitor_id', '')::uuid, r.visitor_id),
      r.session_id,
      nullif(r.raw ->> 'campaign_id', '')::uuid,
      nullif(r.raw ->> 'campaign_version_id', '')::uuid,
      nullif(r.raw ->> 'angle_id', '')::uuid,
      nullif(r.raw ->> 'angle_version_id', '')::uuid,
      nullif(r.raw ->> 'offer_id', '')::uuid,
      nullif(r.raw ->> 'offer_version_id', '')::uuid,
      nullif(r.raw ->> 'creative_id', '')::uuid,
      nullif(r.raw ->> 'creative_version_id', '')::uuid,
      nullif(r.raw ->> 'funnel_id', '')::uuid,
      nullif(r.raw ->> 'funnel_version_id', '')::uuid,
      nullif(r.raw ->> 'form_id', '')::uuid,
      nullif(r.raw ->> 'form_version_id', '')::uuid,
      nullif(r.raw ->> 'experiment_id', '')::uuid,
      nullif(r.raw ->> 'experiment_arm_id', '')::uuid,
      nullif(r.raw ->> 'form_instance_id', '')::uuid,
      nullif(r.raw ->> 'submission_id', '')::uuid,
      nullif(r.raw ->> 'step_id', ''),
      nullif(r.raw ->> 'field_id', ''),
      nullif(r.raw ->> 'error_code', ''),
      coalesce(r.raw ->> 'consent_status', 'UNKNOWN'),
      r.raw ->> 'utm_source', r.raw ->> 'utm_medium', r.raw ->> 'utm_campaign',
      r.raw ->> 'utm_content', r.raw ->> 'utm_term',
      r.raw ->> 'fbclid', r.raw ->> 'fbc', r.raw ->> 'fbp',
      r.raw ->> 'meta_campaign_id', r.raw ->> 'meta_adset_id', r.raw ->> 'meta_ad_id',
      r.raw ->> 'referrer', r.raw ->> 'landing_url',
      coalesce(r.raw -> 'metadata', '{}'::jsonb)
    from resolved r
    on conflict (id) do nothing
    returning 1
  )
  select count(*)::int into v_inserted from written;

  update public.sessions s
     set last_activity_at = now(),
         event_count = s.event_count + sub.n
    from (
      select nullif(e ->> 'session_id', '')::uuid as session_id, count(*)::int as n
      from jsonb_array_elements(p_events) as e
      group by 1
    ) sub
   where s.id = sub.session_id;

  return v_inserted;
end;
$$;

-- -----------------------------------------------------------------------------
-- Experiment assignment and exposure
-- -----------------------------------------------------------------------------
-- Assignment is written once and never re-bucketed, which is what makes an arm
-- survive a reload and a return visit (acceptance criterion 11).

create or replace function public.assign_experiment_arm(
  p_experiment_id uuid,
  p_visitor_id    uuid,
  p_arm_id        uuid,
  p_bucket        numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
  v_state        text;
  v_arm_id       uuid;
begin
  select workspace_id, state into v_workspace_id, v_state
  from public.experiments where id = p_experiment_id;

  if v_workspace_id is null then
    raise exception 'Unbekanntes Experiment: %', p_experiment_id using errcode = 'AM004';
  end if;

  insert into public.experiment_assignments (workspace_id, experiment_id, visitor_id, arm_id, bucket)
  values (v_workspace_id, p_experiment_id, p_visitor_id, p_arm_id, p_bucket)
  on conflict (experiment_id, visitor_id) do nothing;

  select arm_id into v_arm_id
  from public.experiment_assignments
  where experiment_id = p_experiment_id and visitor_id = p_visitor_id;

  return v_arm_id;
end;
$$;

create or replace function public.record_experiment_exposure(
  p_experiment_id uuid,
  p_visitor_id    uuid,
  p_session_id    uuid,
  p_arm_id        uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
  v_new          boolean := false;
begin
  select workspace_id into v_workspace_id from public.experiments where id = p_experiment_id;
  if v_workspace_id is null then
    raise exception 'Unbekanntes Experiment: %', p_experiment_id using errcode = 'AM004';
  end if;

  insert into public.experiment_exposures (workspace_id, experiment_id, visitor_id, session_id, arm_id)
  values (v_workspace_id, p_experiment_id, p_visitor_id, p_session_id, p_arm_id)
  on conflict (experiment_id, visitor_id, session_id) do nothing;

  get diagnostics v_new = row_count;
  return v_new;
end;
$$;

-- -----------------------------------------------------------------------------
-- The transactional lead submit
-- -----------------------------------------------------------------------------
-- Submission + non-PII answers + encrypted PII + status history + attribution
-- snapshot + outbox row, all in ONE transaction (spec §24). If the outbox insert
-- fails, the lead is not recorded; if the lead is recorded, the outbox row exists.
--
-- Idempotent on submission_attempt_id: ten identical concurrent submits produce
-- exactly one submission and exactly one outbox row.

create or replace function public.submit_lead_transactional(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_funnel        public.published_funnels%rowtype;
  v_attempt_id    uuid := (p_payload ->> 'submission_attempt_id')::uuid;
  v_submission_id uuid;
  v_created       boolean := false;
  v_snapshot_id   uuid;
  v_outbox_id     uuid;
  v_state         text;
  v_pii           jsonb := p_payload -> 'pii';
  v_attr          jsonb := coalesce(p_payload -> 'attribution', '{}'::jsonb);
  v_outbox        jsonb := p_payload -> 'outbox';
begin
  if v_attempt_id is null then
    raise exception 'submission_attempt_id fehlt.' using errcode = 'AM005';
  end if;

  select * into v_funnel
  from public.published_funnels
  where id = (p_payload ->> 'published_funnel_id')::uuid;

  if v_funnel.id is null then
    raise exception 'Unbekannter Funnel: %', p_payload ->> 'published_funnel_id' using errcode = 'AM004';
  end if;

  v_state := coalesce(p_payload ->> 'state', 'ACCEPTED');

  insert into public.form_submissions (
    workspace_id, submission_attempt_id, form_instance_id, form_version_id, funnel_version_id,
    published_funnel_id, campaign_id, experiment_id, experiment_arm_id, visitor_id, session_id,
    state, submitted_at, accepted_at, environment, traffic_kind,
    consent_version_id, consent_status, consent_purposes, consent_text_hash,
    spam_score, spam_reason, validation_error_codes, answers_hash
  )
  values (
    v_funnel.workspace_id,
    v_attempt_id,
    nullif(p_payload ->> 'form_instance_id', '')::uuid,
    coalesce(nullif(p_payload ->> 'form_version_id', '')::uuid, v_funnel.form_version_id),
    v_funnel.funnel_version_id,
    v_funnel.id,
    v_funnel.campaign_id,
    coalesce(nullif(p_payload ->> 'experiment_id', '')::uuid, v_funnel.experiment_id),
    nullif(p_payload ->> 'experiment_arm_id', '')::uuid,
    nullif(p_payload ->> 'visitor_id', '')::uuid,
    nullif(p_payload ->> 'session_id', '')::uuid,
    v_state,
    coalesce((p_payload ->> 'submitted_at')::timestamptz, now()),
    case when v_state = 'ACCEPTED' then coalesce((p_payload ->> 'submitted_at')::timestamptz, now()) end,
    coalesce(p_payload ->> 'environment', v_funnel.environment),
    coalesce(p_payload ->> 'traffic_kind', 'PRODUCTION'),
    coalesce(nullif(p_payload ->> 'consent_version_id', '')::uuid, v_funnel.consent_version_id),
    coalesce(p_payload ->> 'consent_status', 'UNKNOWN'),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p_payload -> 'consent_purposes', '[]'::jsonb)) as value),
      '{}'::text[]
    ),
    nullif(p_payload ->> 'consent_text_hash', ''),
    (p_payload ->> 'spam_score')::numeric,
    nullif(p_payload ->> 'spam_reason', ''),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p_payload -> 'validation_error_codes', '[]'::jsonb)) as value),
      '{}'::text[]
    ),
    nullif(p_payload ->> 'answers_hash', '')
  )
  on conflict (submission_attempt_id) do nothing
  returning id into v_submission_id;

  if v_submission_id is null then
    -- A concurrent (or earlier) identical submit already won. Return that one.
    select id into v_submission_id from public.form_submissions where submission_attempt_id = v_attempt_id;
    if v_submission_id is null then
      raise exception 'Übermittlung konnte nicht gespeichert werden.' using errcode = 'AM005';
    end if;
    select fs.state, fs.attribution_snapshot_id into v_state, v_snapshot_id
    from public.form_submissions fs where fs.id = v_submission_id;

    select id into v_outbox_id from public.outbox_events
    where destination = coalesce(v_outbox ->> 'destination', 'HUBSPOT')
      and dataset_id  = coalesce(v_outbox ->> 'dataset_id', '')
      and event_id    = coalesce(v_outbox ->> 'event_id', '');

    return jsonb_build_object(
      'submission_id', v_submission_id,
      'created', false,
      'state', v_state,
      'attribution_snapshot_id', v_snapshot_id,
      'outbox_event_id', v_outbox_id
    );
  end if;

  v_created := true;

  -- Qualification / operational answers. PII field types are rejected by the
  -- table's CHECK constraint, not by convention.
  insert into public.submission_answers_non_pii (
    workspace_id, submission_id, field_key, step_key, field_type, pii_class,
    qualification_class, value_text, value_number, value_bool, value_options, score_contribution
  )
  select
    v_funnel.workspace_id,
    v_submission_id,
    a ->> 'field_key',
    nullif(a ->> 'step_key', ''),
    a ->> 'field_type',
    coalesce(a ->> 'pii_class', 'QUALIFICATION'),
    coalesce(a ->> 'qualification_class', 'NONE'),
    nullif(a ->> 'value_text', ''),
    (a ->> 'value_number')::numeric,
    (a ->> 'value_bool')::boolean,
    case when jsonb_typeof(a -> 'value_options') = 'array'
         then (select array_agg(value::text) from jsonb_array_elements_text(a -> 'value_options') as value) end,
    (a ->> 'score_contribution')::numeric
  from jsonb_array_elements(coalesce(p_payload -> 'answers', '[]'::jsonb)) as a
  on conflict (submission_id, field_key) do nothing;

  -- Personal data, ciphertext only.
  if v_pii is not null and jsonb_typeof(v_pii) = 'object' then
    insert into public.submission_pii_encrypted (
      workspace_id, submission_id, key_version, iv, auth_tag, ciphertext,
      email_hash, phone_hash, email_domain
    )
    values (
      v_funnel.workspace_id,
      v_submission_id,
      coalesce((v_pii ->> 'key_version')::int, 1),
      decode(v_pii ->> 'iv', 'base64'),
      decode(v_pii ->> 'auth_tag', 'base64'),
      decode(v_pii ->> 'ciphertext', 'base64'),
      nullif(v_pii ->> 'email_hash', ''),
      nullif(v_pii ->> 'phone_hash', ''),
      nullif(v_pii ->> 'email_domain', '')
    )
    on conflict (submission_id) do nothing;
  end if;

  insert into public.submission_status_history (
    workspace_id, submission_id, from_state, to_state, reason_de, actor_label, correlation_id
  )
  values (
    v_funnel.workspace_id, v_submission_id, null, v_state,
    nullif(p_payload ->> 'status_reason_de', ''),
    coalesce(p_payload ->> 'actor_label', 'funnel-runtime'),
    nullif(p_payload ->> 'correlation_id', '')
  );

  -- Immutable attribution snapshot.
  insert into public.attribution_snapshots (
    workspace_id, submission_id,
    campaign_id, campaign_version_id, angle_id, angle_version_id, offer_id, offer_version_id,
    creative_id, creative_version_id, funnel_id, funnel_version_id, form_id, form_version_id,
    experiment_id, experiment_arm_id,
    first_touch, last_touch, acquisition_touch, influenced_touch_ids,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, fbc, fbp, meta_campaign_id, meta_adset_id, meta_ad_id,
    referrer, landing_url, channel, level, confidence, consent_status,
    days_to_conversion, window_days
  )
  values (
    v_funnel.workspace_id, v_submission_id,
    v_funnel.campaign_id,
    nullif(v_attr ->> 'campaign_version_id', '')::uuid,
    nullif(v_attr ->> 'angle_id', '')::uuid,
    nullif(v_attr ->> 'angle_version_id', '')::uuid,
    nullif(v_attr ->> 'offer_id', '')::uuid,
    nullif(v_attr ->> 'offer_version_id', '')::uuid,
    nullif(v_attr ->> 'creative_id', '')::uuid,
    nullif(v_attr ->> 'creative_version_id', '')::uuid,
    v_funnel.funnel_id,
    v_funnel.funnel_version_id,
    nullif(v_attr ->> 'form_id', '')::uuid,
    coalesce(nullif(v_attr ->> 'form_version_id', '')::uuid, v_funnel.form_version_id),
    coalesce(nullif(v_attr ->> 'experiment_id', '')::uuid, v_funnel.experiment_id),
    nullif(v_attr ->> 'experiment_arm_id', '')::uuid,
    v_attr -> 'first_touch', v_attr -> 'last_touch', v_attr -> 'acquisition_touch',
    coalesce(
      (select array_agg(value::uuid) from jsonb_array_elements_text(coalesce(v_attr -> 'influenced_touch_ids', '[]'::jsonb)) as value),
      '{}'::uuid[]
    ),
    v_attr ->> 'utm_source', v_attr ->> 'utm_medium', v_attr ->> 'utm_campaign',
    v_attr ->> 'utm_content', v_attr ->> 'utm_term',
    v_attr ->> 'fbclid', v_attr ->> 'fbc', v_attr ->> 'fbp',
    v_attr ->> 'meta_campaign_id', v_attr ->> 'meta_adset_id', v_attr ->> 'meta_ad_id',
    v_attr ->> 'referrer', v_attr ->> 'landing_url',
    coalesce(v_attr ->> 'channel', 'UNKNOWN'),
    coalesce(v_attr ->> 'level', 'LEAD_LINKED'),
    coalesce(v_attr ->> 'confidence', 'UNKNOWN'),
    coalesce(p_payload ->> 'consent_status', 'UNKNOWN'),
    (v_attr ->> 'days_to_conversion')::numeric,
    coalesce((v_attr ->> 'window_days')::int, 30)
  )
  on conflict (submission_id) do nothing
  returning id into v_snapshot_id;

  update public.form_submissions
     set attribution_snapshot_id = v_snapshot_id
   where id = v_submission_id;

  if p_payload ? 'form_instance_id' and nullif(p_payload ->> 'form_instance_id', '') is not null then
    update public.form_instances
       set completed_at = coalesce(completed_at, now()), last_activity_at = now()
     where id = (p_payload ->> 'form_instance_id')::uuid;
  end if;

  -- The outbox row, in this same transaction. This is the whole point.
  if v_outbox is not null and jsonb_typeof(v_outbox) = 'object' then
    insert into public.outbox_events (
      workspace_id, destination, event_id, dataset_id, event_name, event_time,
      payload, payload_hash, status, next_attempt_at,
      campaign_id, submission_id
    )
    values (
      v_funnel.workspace_id,
      coalesce(v_outbox ->> 'destination', 'HUBSPOT'),
      v_outbox ->> 'event_id',
      coalesce(v_outbox ->> 'dataset_id', ''),
      coalesce(v_outbox ->> 'event_name', 'lead'),
      coalesce((v_outbox ->> 'event_time')::timestamptz, now()),
      coalesce(v_outbox -> 'payload', '{}'::jsonb),
      v_outbox ->> 'payload_hash',
      'PENDING',
      now(),
      v_funnel.campaign_id,
      v_submission_id
    )
    on conflict (destination, dataset_id, event_id) do nothing
    returning id into v_outbox_id;

    if v_outbox_id is null then
      select id into v_outbox_id from public.outbox_events
      where destination = coalesce(v_outbox ->> 'destination', 'HUBSPOT')
        and dataset_id  = coalesce(v_outbox ->> 'dataset_id', '')
        and event_id    = v_outbox ->> 'event_id';
    end if;
  end if;

  return jsonb_build_object(
    'submission_id', v_submission_id,
    'created', v_created,
    'state', v_state,
    'attribution_snapshot_id', v_snapshot_id,
    'outbox_event_id', v_outbox_id
  );
end;
$$;

comment on function public.submit_lead_transactional(jsonb) is
  'One transaction: submission + answers + encrypted PII + status history + attribution snapshot + outbox row.';

-- -----------------------------------------------------------------------------
-- Outbox claim
-- -----------------------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED: several workers can drain the same destination without
-- ever handing the same event to two of them.

create or replace function public.claim_outbox_events(
  p_destination text,
  p_limit       integer default 25,
  p_worker      text    default 'worker'
)
returns setof public.outbox_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with claimed as (
    select o.id
    from public.outbox_events o
    where o.destination = p_destination
      and o.status in ('PENDING', 'FAILED_RETRYING')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
    order by coalesce(o.next_attempt_at, o.created_at)
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update public.outbox_events o
     set status        = 'PROCESSING',
         locked_at     = now(),
         locked_by     = p_worker,
         attempt_count = o.attempt_count + 1,
         updated_at    = now()
    from claimed c
   where o.id = c.id
  returning o.*;
end;
$$;

comment on function public.claim_outbox_events(text, integer, text) is
  'Atomically claims due outbox rows with FOR UPDATE SKIP LOCKED and marks them PROCESSING.';

-- Release rows a crashed worker left PROCESSING. Called by the scheduler.
create or replace function public.reclaim_stale_outbox_events(p_older_than interval default interval '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.outbox_events
     set status = 'FAILED_RETRYING',
         locked_at = null,
         locked_by = null,
         last_error = coalesce(last_error, 'Worker hat den Auftrag nicht abgeschlossen (Timeout).'),
         updated_at = now()
   where status = 'PROCESSING'
     and locked_at is not null
     and locked_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Historical import upsert
-- -----------------------------------------------------------------------------
-- Idempotent by construction: running the import twice over the same window
-- updates in place and creates no duplicates.

create or replace function public.upsert_meta_insights_daily(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with incoming as (
    select
      (r ->> 'workspace_id')::uuid            as workspace_id,
      r ->> 'level'                           as level,
      r ->> 'entity_external_id'              as entity_external_id,
      nullif(r ->> 'meta_account_id', '')::uuid  as meta_account_id,
      nullif(r ->> 'meta_campaign_id', '')::uuid as meta_campaign_id,
      nullif(r ->> 'meta_adset_id', '')::uuid    as meta_adset_id,
      nullif(r ->> 'meta_ad_id', '')::uuid       as meta_ad_id,
      nullif(r ->> 'campaign_id', '')::uuid      as campaign_id,
      (r ->> 'date_start')::date              as date_start,
      coalesce((r ->> 'impressions')::bigint, 0) as impressions,
      coalesce((r ->> 'reach')::bigint, 0)       as reach,
      coalesce((r ->> 'clicks')::bigint, 0)      as clicks,
      coalesce((r ->> 'link_clicks')::bigint, 0) as link_clicks,
      coalesce((r ->> 'spend_minor')::bigint, 0) as spend_minor,
      coalesce(r ->> 'currency', 'EUR')          as currency,
      (r ->> 'frequency')::numeric               as frequency,
      (r ->> 'cpm_minor')::bigint                as cpm_minor,
      (r ->> 'cpc_minor')::bigint                as cpc_minor,
      (r ->> 'ctr')::numeric                     as ctr,
      coalesce((r ->> 'video_views')::bigint, 0) as video_views,
      coalesce(r -> 'actions', '[]'::jsonb)      as actions,
      coalesce(r -> 'action_values', '[]'::jsonb) as action_values,
      coalesce(r -> 'raw', '{}'::jsonb)          as raw
    from jsonb_array_elements(p_rows) as r
  ),
  written as (
    insert into public.meta_insights_daily (
      workspace_id, level, entity_external_id, meta_account_id, meta_campaign_id, meta_adset_id,
      meta_ad_id, campaign_id, date_start, impressions, reach, clicks, link_clicks, spend_minor,
      currency, frequency, cpm_minor, cpc_minor, ctr, video_views, actions, action_values, raw,
      imported_at
    )
    select
      workspace_id, level, entity_external_id, meta_account_id, meta_campaign_id, meta_adset_id,
      meta_ad_id, campaign_id, date_start, impressions, reach, clicks, link_clicks, spend_minor,
      currency, frequency, cpm_minor, cpc_minor, ctr, video_views, actions, action_values, raw,
      now()
    from incoming
    on conflict (provider, level, entity_external_id, date_start) do update
      set impressions     = excluded.impressions,
          reach           = excluded.reach,
          clicks          = excluded.clicks,
          link_clicks     = excluded.link_clicks,
          spend_minor     = excluded.spend_minor,
          currency        = excluded.currency,
          frequency       = excluded.frequency,
          cpm_minor       = excluded.cpm_minor,
          cpc_minor       = excluded.cpc_minor,
          ctr             = excluded.ctr,
          video_views     = excluded.video_views,
          actions         = excluded.actions,
          action_values   = excluded.action_values,
          raw             = excluded.raw,
          campaign_id     = coalesce(excluded.campaign_id, public.meta_insights_daily.campaign_id),
          imported_at     = now(),
          updated_at      = now()
    returning 1
  )
  select count(*)::int into v_count from written;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sales transitions
-- -----------------------------------------------------------------------------
-- Writes a canonical event only on a *real* transition. A repeated sync that
-- observes the same stage returns false and inserts nothing (criterion 32).

create or replace function public.record_lead_stage_event(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      uuid;
  v_created boolean;
begin
  insert into public.lead_stage_events (
    workspace_id, lead_id, opportunity_id, submission_id, campaign_id, type, occurred_at,
    source_object, hubspot_object_id, previous_state, new_state, mapping_version,
    source_event_id, attribution_snapshot_id, amount_minor, currency
  )
  values (
    (p_payload ->> 'workspace_id')::uuid,
    nullif(p_payload ->> 'lead_id', '')::uuid,
    nullif(p_payload ->> 'opportunity_id', '')::uuid,
    nullif(p_payload ->> 'submission_id', '')::uuid,
    nullif(p_payload ->> 'campaign_id', '')::uuid,
    p_payload ->> 'type',
    coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
    coalesce(p_payload ->> 'source_object', 'INTERNAL'),
    nullif(p_payload ->> 'hubspot_object_id', ''),
    nullif(p_payload ->> 'previous_state', ''),
    coalesce(p_payload ->> 'new_state', p_payload ->> 'type'),
    (p_payload ->> 'mapping_version')::int,
    nullif(p_payload ->> 'source_event_id', ''),
    nullif(p_payload ->> 'attribution_snapshot_id', '')::uuid,
    (p_payload ->> 'amount_minor')::bigint,
    nullif(p_payload ->> 'currency', '')
  )
  on conflict do nothing
  returning id into v_id;

  v_created := v_id is not null;
  return jsonb_build_object('lead_stage_event_id', v_id, 'created', v_created);
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- The anon key may call exactly the six funnel-runtime functions. Nothing else.

grant execute on function public.get_published_funnel(text)                            to anon, authenticated, service_role;
grant execute on function public.ensure_visitor_session(jsonb)                         to anon, authenticated, service_role;
grant execute on function public.record_tracking_events(jsonb)                         to anon, authenticated, service_role;
grant execute on function public.assign_experiment_arm(uuid, uuid, uuid, numeric)      to anon, authenticated, service_role;
grant execute on function public.record_experiment_exposure(uuid, uuid, uuid, uuid)    to anon, authenticated, service_role;
grant execute on function public.submit_lead_transactional(jsonb)                      to anon, authenticated, service_role;

grant execute on function public.claim_outbox_events(text, integer, text)              to authenticated, service_role;
grant execute on function public.reclaim_stale_outbox_events(interval)                 to authenticated, service_role;
grant execute on function public.upsert_meta_insights_daily(jsonb)                     to authenticated, service_role;
grant execute on function public.record_lead_stage_event(jsonb)                        to authenticated, service_role;
