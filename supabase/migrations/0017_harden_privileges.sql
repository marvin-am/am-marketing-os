-- =============================================================================
-- 0017_harden_privileges.sql — close the anon key's route into the database
-- =============================================================================
-- 0012 stripped `anon` of table privileges and 0013 granted it exactly six
-- functions. Both statements were true and neither was sufficient, because of
-- one PostgreSQL default that neither accounted for:
--
--     EXECUTE on a newly created function is granted to PUBLIC.
--
-- `revoke all on all functions in schema public from anon` (0012:24) removes the
-- grant held *by anon*. It cannot remove PUBLIC's, and `anon` is a member of
-- PUBLIC like every other role. 0013, 0015 and 0016 then create their functions
-- after that line anyway. The net effect was that every function in `public` —
-- including the SECURITY DEFINER ones deliberately restricted to
-- `authenticated, service_role` — was callable with the anon key, which is
-- published to the browser by construction and which Supabase exposes as
-- `POST /rest/v1/rpc/<name>`.
--
-- What that made reachable from the open internet, all of it verified against a
-- real database rather than reasoned about:
--
--   * `claim_outbox_events`      — read every pending lead's HubSpot payload,
--                                  including e-mail and phone, and flip the rows
--                                  to PROCESSING so they never get delivered.
--   * `record_lead_stage_event`  — book a fabricated CLOSED_WON of any amount.
--   * `upsert_meta_insights_daily` — invent spend and delivery.
--   * `try_acquire_job_lock`     — hold the outbox pump's lock for 24 hours.
--
-- This migration therefore does three things:
--
--   1. Revokes EXECUTE from PUBLIC (not just from `anon`) on every function in
--      `public`, sets the default privilege so a future migration cannot
--      reintroduce the hole, and re-grants each function explicitly to the roles
--      that actually call it.
--   2. Puts the two funnel-runtime write functions behind a guard: the event
--      collector refuses personal data and derives traffic classification from
--      the session, and the lead submit refuses an unpublished funnel and an
--      attribution confidence it cannot see evidence for.
--   3. Adds the immutability trigger `published_funnels` was documented to have
--      and did not, and stops an experiment arm being self-assigned across
--      experiments.
--
-- The guard functions live in `app`, which PostgREST does not expose, and the
-- original bodies from 0013 are moved there unchanged rather than copied — one
-- implementation, one place to fix.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The PII guard, mirrored from `@am/domain`
-- -----------------------------------------------------------------------------
-- `packages/domain/src/events.ts` is the authority; this is the backstop for the
-- case where something reaches the RPC without passing through the collector.
-- The two must not drift, so `packages/db/integration/pii-guard-parity.test.ts`
-- pins these lists against the exported constants.

create or replace function app.normalize_event_key(p_key text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(p_key, '')), '[^a-z]', '', 'g');
$$;

comment on function app.normalize_event_key(text) is
  'Case- and separator-insensitive key form. Mirrors normalizeKey in @am/domain.';

/*
 * Two lists, because one would be wrong in both directions.
 *
 * Fragments are matched as substrings: `phone_number`, `emailAddress` and
 * `contact_email` carry exactly the personal data that `phone` and `email` do,
 * and an equality test lets every variant through.
 *
 * The exact list exists for `name`: as a substring it also matches
 * `content_name`, `campaign_name` and `event_name`, which are legitimate and
 * carry nothing personal. A guard that rejects valid events is a guard someone
 * switches off, so ambiguous words are matched whole.
 */
create or replace function app.event_key_is_forbidden(p_key text)
returns boolean
language sql
immutable
as $$
  select case
    when app.normalize_event_key(p_key) = any (array[
      'name', 'mail', 'ip', 'ipaddress', 'useragent', 'message', 'nachricht',
      'freitext', 'address', 'adresse', 'street', 'kontakt', 'answer'
    ]) then true
    else exists (
      select 1
      from unnest(array[
        'email', 'phone', 'telefon', 'telephone', 'vorname', 'nachname',
        'firstname', 'lastname', 'fullname', 'answers', 'antworten'
      ]) as fragment
      where app.normalize_event_key(p_key) like '%' || fragment || '%'
    )
  end;
$$;

comment on function app.event_key_is_forbidden(text) is
  'Mirrors isForbiddenEventKey in @am/domain: fragments by substring, ambiguous words whole.';

/*
 * Contact data hiding in a value under an innocent key.
 *
 * The identifier short-circuits are load bearing. A UUID such as
 * `00123456-7890-4abc-…` and a Meta object id such as `120210000000000000` both
 * contain digit runs a naive phone pattern flags, and every event carries
 * several of them — a guard that fires on valid input is worse than no guard,
 * because it gets disabled.
 */
create or replace function app.text_looks_like_pii(p_value text)
returns boolean
language sql
immutable
as $$
  with raw as (
    select coalesce(p_value, '') as v
  ),
  scanned as (
    /* Percent-encoding is the one transformation worth undoing: `max%40example.de`
       arrives from a query string routinely and is the same address. Deeper
       obfuscation is out of scope — this is a structural backstop against a
       mistake, not against an adversary. */
    select v, btrim(v) as trimmed, regexp_replace(v, '%40', '@', 'gi') as decoded
    from raw
  )
  select case
    when trimmed ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then false                                                   -- uuid
    when trimmed ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$'
      then false                                                   -- iso timestamp
    when decoded ~ '[\w.+-]+@[\w-]+\.[\w.-]+'
      then true                                                    -- e-mail
    when trimmed ~ '^(49|43|41)[0-9]{9,11}$'
      then true                                                    -- bare DACH number
    when (select bool_or(length(regexp_replace(m[1], '[^0-9]', '', 'g')) between 9 and 16)
            from regexp_matches(decoded, '((?:\+|\y00)[0-9][-0-9 ()/.]{6,}[0-9])', 'g') as m)
      then true                                                    -- +49 …, 0049 …
    when (select bool_or(length(regexp_replace(m[1], '[^0-9]', '', 'g')) between 9 and 16)
            from regexp_matches(decoded, '((?:^|[^0-9+])0[0-9][-0-9 ()/.]{7,}[0-9])', 'g') as m)
      then true                                                    -- 0151 …, 030/…
    else false
  end
  from scanned;
$$;

comment on function app.text_looks_like_pii(text) is
  'Mirrors EMAIL_LIKE and looksLikePhoneNumber in @am/domain, identifier exclusions included.';

/*
 * Structural scan over an arbitrary payload, returning the JSON paths that look
 * like personal data. Numbers are scanned as well as strings: a phone number
 * that arrived as `4915123456789` rather than `'4915123456789'` is the same
 * personal datum.
 */
create or replace function app.jsonb_pii_violations(p_payload jsonb, p_path text default '$')
returns text[]
language plpgsql
immutable
as $$
declare
  v_result text[] := '{}';
  v_key    text;
  v_child  jsonb;
  v_index  integer := 0;
begin
  if p_payload is null then
    return v_result;
  end if;

  case jsonb_typeof(p_payload)
    when 'object' then
      for v_key, v_child in select * from jsonb_each(p_payload) loop
        if app.event_key_is_forbidden(v_key) then
          v_result := v_result || format('%s.%s (verbotener Schlüssel)', p_path, v_key);
        else
          v_result := v_result || app.jsonb_pii_violations(v_child, format('%s.%s', p_path, v_key));
        end if;
      end loop;

    when 'array' then
      for v_child in select value from jsonb_array_elements(p_payload) loop
        v_result := v_result || app.jsonb_pii_violations(v_child, format('%s[%s]', p_path, v_index));
        v_index := v_index + 1;
      end loop;

    when 'string', 'number' then
      if app.text_looks_like_pii(p_payload #>> '{}') then
        v_result := v_result || format('%s (Kontaktdaten-Muster)', p_path);
      end if;

    else
      null;
  end case;

  return v_result;
end;
$$;

comment on function app.jsonb_pii_violations(jsonb, text) is
  'Mirrors findPiiViolations in @am/domain. Returns the offending JSON paths, never the values.';

-- -----------------------------------------------------------------------------
-- Move the two unguarded runtime bodies out of `public`
-- -----------------------------------------------------------------------------
-- Relocated rather than reimplemented: 0013 stays the single description of what
-- these functions do, and the wrappers below stay short enough to audit. Both
-- keep `security definer` and their pinned `search_path`, so behaviour is
-- unchanged; only reachability moves.

do $relocate$
begin
  if to_regprocedure('app.record_tracking_events_unchecked(jsonb)') is null then
    alter function public.record_tracking_events(jsonb) set schema app;
    alter function app.record_tracking_events(jsonb) rename to record_tracking_events_unchecked;
  end if;

  if to_regprocedure('app.submit_lead_unchecked(jsonb)') is null then
    alter function public.submit_lead_transactional(jsonb) set schema app;
    alter function app.submit_lead_transactional(jsonb) rename to submit_lead_unchecked;
  end if;
end
$relocate$;

comment on function app.record_tracking_events_unchecked(jsonb) is
  'Unguarded insert path. Only public.record_tracking_events may call it.';
comment on function app.submit_lead_unchecked(jsonb) is
  'Unguarded submit path. Only public.submit_lead_transactional may call it.';

-- -----------------------------------------------------------------------------
-- Event collection, guarded
-- -----------------------------------------------------------------------------
-- `docs/data-model.md` claims "`events` and `touchpoints` have no PII columns at
-- all. The guard is the absence of a place to put it." That was never true:
-- `events.metadata`, `events.referrer` and `events.landing_url` are three such
-- places, and the only scan stood in the Next.js route, which this RPC bypasses.
--
-- The batch is refused as a unit rather than sanitised. A "cleaned" event teaches
-- the emitting code that sending personal data is survivable, and the next
-- mistake is a lead's address in a log drain.

create or replace function public.record_tracking_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_violations text[];
  v_events     jsonb;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'record_tracking_events erwartet ein JSON-Array.' using errcode = 'AM005';
  end if;

  v_violations := app.jsonb_pii_violations(p_events);
  if coalesce(array_length(v_violations, 1), 0) > 0 then
    raise exception 'Das Ereignis wurde abgelehnt: Es enthält personenbezogene Daten.'
      using errcode = 'AM006',
            detail  = format('Betroffene Felder: %s', array_to_string(v_violations, ', ')),
            hint    = 'Ereignisse transportieren niemals Kontaktdaten.';
  end if;

  /* Classification is the server's, not the caller's. A request cannot declare
     itself PRODUCTION traffic, cannot move its events into another environment,
     and cannot attribute them to a different visitor than the one the session
     belongs to. Events naming an unknown session are dropped by the join, which
     is what the original body did too. */
  select coalesce(
           jsonb_agg(
             e.value || jsonb_build_object(
               'traffic_kind', s.traffic_kind,
               'environment',  s.environment,
               'visitor_id',   s.visitor_id
             )
           ),
           '[]'::jsonb
         )
    into v_events
    from jsonb_array_elements(p_events) as e(value)
    join public.sessions s on s.id = nullif(e.value ->> 'session_id', '')::uuid;

  return app.record_tracking_events_unchecked(v_events);
end;
$$;

comment on function public.record_tracking_events(jsonb) is
  'Refuses personal data outright and takes traffic kind, environment and visitor from the session.';

-- -----------------------------------------------------------------------------
-- Lead submission, guarded
-- -----------------------------------------------------------------------------
-- `ensure_visitor_session` required `is_live and unpublished_at is null`;
-- this function looked the funnel up by id alone, so a draft or a retired funnel
-- accepted production leads. Everything else — state, consent, traffic kind, the
-- whole attribution snapshot — was taken from the payload, which made every
-- control in `apps/funnels/src/server/submit-service.ts` (honeypot, timing,
-- `validateSubmission`, the consent gate) optional for anyone calling the RPC.

create or replace function public.submit_lead_transactional(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_funnel    public.published_funnels%rowtype;
  v_session   public.sessions%rowtype;
  v_attr      jsonb := coalesce(p_payload -> 'attribution', '{}'::jsonb);
  v_payload   jsonb := p_payload;
  v_has_proof boolean;
begin
  select * into v_funnel
    from public.published_funnels
   where id = nullif(p_payload ->> 'published_funnel_id', '')::uuid
     and is_live
     and unpublished_at is null;

  if v_funnel.id is null then
    raise exception 'Unbekannter oder nicht veröffentlichter Funnel: %',
      coalesce(nullif(p_payload ->> 'published_funnel_id', ''), '—')
      using errcode = 'AM004',
            hint = 'Nur ein live geschalteter Funnel nimmt Übermittlungen an.';
  end if;

  /* A submission belongs to a session the server opened. Requiring it is what
     stops a direct RPC call from manufacturing a lead with no funnel visit
     behind it, and it is where the trustworthy traffic classification lives. */
  select * into v_session
    from public.sessions
   where id = nullif(p_payload ->> 'session_id', '')::uuid;

  if v_session.id is null then
    raise exception 'Zur Übermittlung gehört keine bekannte Sitzung.'
      using errcode = 'AM004',
            hint = 'Die Sitzung wird von ensure_visitor_session eröffnet.';
  end if;

  /*
   * EXACT attribution is a claim about evidence, and it is the claim that ends
   * up in a revenue report. `@am/domain`'s ladder grants it only for a signed
   * launch token, a Meta click id, or a campaign parameter that maps 1:1 onto
   * one internal campaign — never for temporal proximity, which is the single
   * most common source of fabricated attribution in ad reporting.
   *
   * The database can see two of those three: an internal `campaign_version_id`
   * (recoverable only from the signed token) and a click id. A snapshot claiming
   * EXACT with neither is refused rather than quietly downgraded — silently
   * rewriting an attribution is how a number nobody can account for gets into a
   * report.
   */
  v_has_proof :=
    nullif(v_attr ->> 'campaign_version_id', '') is not null
    or nullif(v_attr ->> 'fbclid', '') is not null
    or nullif(v_attr ->> 'fbc', '') is not null;

  if v_attr ->> 'confidence' = 'EXACT' and not v_has_proof then
    raise exception 'Attribution EXACT ist ohne Klick-ID oder signiertes Token nicht zulässig.'
      using errcode = 'AM006',
            hint = 'Ohne Nachweis gilt höchstens HIGH_CONFIDENCE.';
  end if;

  v_payload := v_payload || jsonb_build_object(
    'environment',  v_funnel.environment,
    'traffic_kind', v_session.traffic_kind
  );

  return app.submit_lead_unchecked(v_payload);
end;
$$;

comment on function public.submit_lead_transactional(jsonb) is
  'Requires a live funnel and a known session, and refuses an EXACT attribution without evidence.';

-- -----------------------------------------------------------------------------
-- Experiment assignment
-- -----------------------------------------------------------------------------
-- `p_arm_id` was never checked against `p_experiment_id`, and the experiment's
-- state was read and then ignored — so a caller could bucket a visitor into an
-- arm of a different experiment, or into an experiment that had already been
-- concluded and whose result was therefore already written.

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

  if v_state <> 'RUNNING' then
    raise exception 'Experiment % verteilt keinen Traffic (Status %).', p_experiment_id, v_state
      using errcode = 'AM004',
            hint = 'Nur ein laufendes Experiment weist Arme zu.';
  end if;

  if not exists (
    select 1 from public.experiment_arms
    where id = p_arm_id and experiment_id = p_experiment_id
  ) then
    raise exception 'Arm % gehört nicht zu Experiment %.', p_arm_id, p_experiment_id
      using errcode = 'AM004';
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

comment on function public.assign_experiment_arm(uuid, uuid, uuid, numeric) is
  'Assigns once and never re-buckets. The arm must belong to the experiment and the experiment must be RUNNING.';

-- -----------------------------------------------------------------------------
-- The live slug binding is a published version too
-- -----------------------------------------------------------------------------
-- `docs/data-model.md` lists `published_funnels` under "Immutability"; no trigger
-- existed. The row binds a public slug to the exact funnel version, form version,
-- consent version and pixel a submission was delivered against, so editing it in
-- place silently rewrites the history of every submission already made under it.
-- Retiring a funnel stays possible — that is what `is_live` and `unpublished_at`
-- are for.

drop trigger if exists published_funnels_immutable on public.published_funnels;

create trigger published_funnels_immutable
  before update or delete on public.published_funnels
  for each row execute function app.enforce_version_immutability(
    'is_live', '{true}', '{updated_at,updated_by,is_live,unpublished_at}'
  );

comment on trigger published_funnels_immutable on public.published_funnels is
  'A live binding may only be retired, never re-pointed.';

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
-- The revoke has to name PUBLIC. Revoking from `anon` alone removes a grant
-- `anon` never needed to hold, and leaves the one it actually inherits.

revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;

-- The unguarded bodies are reachable only through their wrappers, which run as
-- their owner and therefore need no grant of their own.
revoke execute on function app.record_tracking_events_unchecked(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function app.submit_lead_unchecked(jsonb)
  from public, anon, authenticated, service_role;

-- The one function the public key may call: it returns a live funnel's spec and
-- nothing else, which is exactly what an anonymous visitor is allowed to see.
grant execute on function public.get_published_funnel(text) to anon, authenticated, service_role;

/*
 * Everything else the funnel runtime needs runs on the server, through
 * `resolveDatabase({ admin: true })`. Nothing in this repository calls an RPC
 * from a browser — `createBrowserDbClient()` has no call sites — so granting
 * these to `anon` bought no capability and cost every control in the request
 * path, which a direct PostgREST call skips.
 */
grant execute on function public.ensure_visitor_session(jsonb)                      to service_role;
grant execute on function public.record_tracking_events(jsonb)                      to service_role;
grant execute on function public.assign_experiment_arm(uuid, uuid, uuid, numeric)   to service_role;
grant execute on function public.record_experiment_exposure(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.submit_lead_transactional(jsonb)                   to service_role;

-- Operational functions belong to the job runner, which holds the service role
-- (`apps/console/src/server/job-runtime.ts`). A signed-in operator has no reason
-- to claim outbox rows, hold a job lock or write provider insight rows, and the
-- console never asks them to.
grant execute on function public.claim_outbox_events(text[], integer, text)     to service_role;
grant execute on function public.reclaim_stale_outbox_events(interval)          to service_role;
grant execute on function public.upsert_meta_insights_daily(jsonb)              to service_role;
grant execute on function public.record_lead_stage_event(jsonb)                 to service_role;
grant execute on function public.try_acquire_job_lock(text, text, integer)      to service_role;
grant execute on function public.release_job_lock(text, text)                   to service_role;
grant execute on function public.rollup_days_needing_recompute(uuid, date, date) to service_role;

-- RLS policies call `app.is_member` and friends as the querying role, so
-- `authenticated` keeps those. It keeps nothing else in `app`.
grant usage on schema app to authenticated, service_role;
grant execute on function app.is_member(uuid)                     to authenticated, service_role;
grant execute on function app.has_workspace_role(uuid, text[])    to authenticated, service_role;
grant execute on function app.is_workspace_admin(uuid)            to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Proof obligations
-- -----------------------------------------------------------------------------
-- Stated as assertions rather than as a comment, so a future migration that
-- reintroduces a PUBLIC grant fails at deploy time instead of in production.

do $verify$
declare
  v_public_execute text[];
  v_anon_execute   text[];
begin
  select coalesce(array_agg(p.proname order by p.proname), '{}')
    into v_public_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proacl is not null
     and exists (
       select 1 from unnest(p.proacl) as acl
        where acl::text like '=%X/%'          -- an empty grantee is PUBLIC
     );

  if coalesce(array_length(v_public_execute, 1), 0) > 0 then
    raise exception 'PUBLIC darf keine Funktion in public ausführen. Betroffen: %',
      array_to_string(v_public_execute, ', ');
  end if;

  select coalesce(array_agg(p.proname order by p.proname), '{}')
    into v_anon_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_anon_execute <> array['get_published_funnel'] then
    raise exception 'anon darf genau get_published_funnel ausführen, tatsächlich: %',
      array_to_string(v_anon_execute, ', ');
  end if;

  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal
       and c.relname = 'published_funnels'
       and t.tgname = 'published_funnels_immutable'
  ) then
    raise exception 'published_funnels braucht den Immutability-Trigger.';
  end if;
end
$verify$;
