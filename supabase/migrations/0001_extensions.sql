-- =============================================================================
-- 0001_extensions.sql — extensions, roles, helper schema, shared trigger logic
-- =============================================================================
-- Runs first. Everything after this file may assume:
--   * gen_random_uuid() exists
--   * the `app` schema and its helper functions exist
--   * the Supabase roles (anon / authenticated / service_role) exist
--   * app.capability('pgvector') tells you whether real vector columns are usable
-- =============================================================================

-- pgcrypto: gen_random_uuid() (PG13+ has it built in, but digest() is ours).
create extension if not exists pgcrypto with schema public;

-- Trigram search for the console's name/slug lookups.
create extension if not exists pg_trgm with schema public;

create schema if not exists app;
comment on schema app is
  'Internal helpers: RLS predicates, trigger functions, capability flags. Never exposed to PostgREST.';

-- Supabase provides these roles; a bare Postgres (CI, local integration test)
-- does not. Creating them here keeps the migration set portable.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$roles$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Capability registry
-- -----------------------------------------------------------------------------
-- pgvector is present on Supabase and absent from a stock `postgres:17` image.
-- Rather than pretend, we record what the database can actually do and shape the
-- embedding column accordingly. `@am/db` reads this table to decide whether
-- similarity search is available or whether the caller must fall back.

create table if not exists app.schema_capabilities (
  key         text primary key,
  available   boolean     not null,
  detail      text,
  recorded_at timestamptz not null default now()
);

comment on table app.schema_capabilities is
  'What this particular database instance supports. Honest degradation, never a pretend feature.';

do $vector$
begin
  begin
    create extension if not exists vector with schema public;
    insert into app.schema_capabilities (key, available, detail)
    values ('pgvector', true, 'vector(3072) columns and similarity search are available.')
    on conflict (key) do update set available = true, detail = excluded.detail, recorded_at = now();
  exception
    when others then
      insert into app.schema_capabilities (key, available, detail)
      values (
        'pgvector',
        false,
        'pgvector konnte nicht installiert werden: ' || sqlerrm ||
        ' — knowledge_embeddings.embedding wird als real[] angelegt, Ähnlichkeitssuche ist deaktiviert.'
      )
      on conflict (key) do update set available = false, detail = excluded.detail, recorded_at = now();
      raise warning 'pgvector unavailable (%). Embeddings degrade to real[]; similarity search is disabled.', sqlerrm;
  end;
end
$vector$;

-- SECURITY DEFINER so callers can read the flag without a policy on the table
-- itself (0012 enables RLS on app.schema_capabilities with no policies).
create or replace function app.capability(p_key text)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select coalesce((select available from app.schema_capabilities where key = p_key), false);
$$;

-- -----------------------------------------------------------------------------
-- auth.uid() fallback
-- -----------------------------------------------------------------------------
-- Supabase ships `auth.uid()`. On a bare Postgres we provide a compatible
-- implementation reading the same GUC so RLS policies are testable without
-- GoTrue. We never overwrite the real one.

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

do $authuid$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $ddl$
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $body$
        select nullif(
          coalesce(
            current_setting('request.jwt.claim.sub', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          ),
          ''
        )::uuid
      $body$;
    $ddl$;
  end if;
end
$authuid$;

do $authrole$
begin
  if to_regprocedure('auth.role()') is null then
    execute $ddl$
      create function auth.role()
      returns text
      language sql
      stable
      as $body$
        select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user::text)
      $body$;
    $ddl$;
  end if;
end
$authrole$;

-- -----------------------------------------------------------------------------
-- Shared trigger functions
-- -----------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at() is
  'BEFORE UPDATE trigger keeping updated_at honest even when a caller forgets it.';

-- The one reusable immutability guard (spec §6 / AGENTS rule 6).
--
--   TG_ARGV[0] — name of the guard column, e.g. 'state'
--   TG_ARGV[1] — Postgres array literal of guard values that freeze the row,
--                e.g. '{PUBLISHED}'
--   TG_ARGV[2] — optional array literal of columns that may still change while
--                frozen. Defaults to the bookkeeping columns.
--
-- While frozen, the guard column itself may only advance to 'ARCHIVED': a
-- published version can be retired, but its content can never be rewritten.
create or replace function app.enforce_version_immutability()
returns trigger
language plpgsql
as $$
declare
  v_guard_column   text   := coalesce(tg_argv[0], 'state');
  v_frozen_values  text[] := coalesce(tg_argv[1]::text[], array['PUBLISHED']);
  v_allowed        text[] := coalesce(tg_argv[2]::text[], array['updated_at', 'updated_by', 'archived_at']);
  v_old            jsonb;
  v_new            jsonb;
  v_old_guard      text;
  v_new_guard      text;
  v_changed        text[];
begin
  v_old := to_jsonb(old);
  v_old_guard := v_old ->> v_guard_column;

  if v_old_guard is null or not (v_old_guard = any (v_frozen_values)) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'Veröffentlichte Version (%.% = %) kann nicht gelöscht werden.',
      tg_table_name, v_guard_column, v_old_guard
      using errcode = 'AM001',
            detail  = format('table=%s id=%s', tg_table_name, coalesce(v_old ->> 'id', '?')),
            hint    = 'Legen Sie eine neue Version an, statt die veröffentlichte zu verändern.';
  end if;

  v_new := to_jsonb(new);
  v_new_guard := v_new ->> v_guard_column;

  select coalesce(array_agg(key order by key), array[]::text[])
    into v_changed
  from jsonb_each(v_new) as n(key, value)
  where n.value is distinct from (v_old -> n.key);

  -- Retiring a published version is a lifecycle move, not a content change.
  if v_new_guard = 'ARCHIVED' then
    v_allowed := v_allowed || v_guard_column;
  end if;

  v_changed := array(select unnest(v_changed) except select unnest(v_allowed));

  if array_length(v_changed, 1) is not null then
    raise exception
      'Veröffentlichte Version ist unveränderlich. Geänderte Spalten: %.',
      array_to_string(v_changed, ', ')
      using errcode = 'AM001',
            detail  = format('table=%s id=%s', tg_table_name, coalesce(v_old ->> 'id', '?')),
            hint    = 'Legen Sie eine neue Version an, statt die veröffentlichte zu verändern.';
  end if;

  return new;
end;
$$;

comment on function app.enforce_version_immutability() is
  'Reusable BEFORE UPDATE/DELETE guard for published versions (spec §6). Raises SQLSTATE AM001.';

-- Experiment arms freeze against the *parent* experiment's state, not their own.
create or replace function app.enforce_experiment_arm_immutability()
returns trigger
language plpgsql
as $$
declare
  v_experiment_id uuid;
  v_state         text;
begin
  v_experiment_id := case when tg_op = 'DELETE' then old.experiment_id else new.experiment_id end;
  select state into v_state from public.experiments where id = v_experiment_id;

  if v_state is null or v_state not in ('RUNNING', 'PAUSED', 'CONCLUDED') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  raise exception
    'Arme eines laufenden oder beendeten Experiments (Status %) können nicht mehr geändert werden.',
    v_state
    using errcode = 'AM001',
          detail  = format('experiment_id=%s', v_experiment_id),
          hint    = 'Beenden Sie das Experiment und legen Sie ein neues an.';
end;
$$;

comment on function app.enforce_experiment_arm_immutability() is
  'Allocation and arm membership freeze as soon as an experiment leaves DRAFT/READY (spec §20).';
