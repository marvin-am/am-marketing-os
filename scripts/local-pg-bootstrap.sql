-- ---------------------------------------------------------------------------
-- Supabase compatibility shim for a plain local Postgres instance.
--
-- The migrations in supabase/migrations/ are written against a Supabase
-- project, which provides the `auth` and `storage` schemas, the `anon` /
-- `authenticated` / `service_role` roles, and helpers such as `auth.uid()`.
--
-- Vanilla Postgres provides none of that. This file recreates just enough of it
-- that the real migrations can be applied — and therefore actually verified —
-- on a throwaway local database, and that RLS policies can be exercised by
-- switching roles and setting a JWT claim.
--
-- It is a TEST fixture. It is never applied to a Supabase project, where all of
-- these objects already exist with the real implementations.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- --- Roles -----------------------------------------------------------------

do $$
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
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

-- --- auth schema -----------------------------------------------------------

create schema if not exists auth;

create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- Supabase resolves the current user from the request's JWT claims, which
-- PostgREST exposes as the `request.jwt.claims` GUC. The local shim reads the
-- same GUC, so a test can impersonate a user with:
--
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    current_user::text
  )
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.email', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- --- storage schema --------------------------------------------------------

create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text not null references storage.buckets (id) on delete cascade,
  name        text not null,
  owner       uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (bucket_id, name)
);

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/')
$$;

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant all on storage.objects to authenticated, service_role;

-- --- Default privileges -----------------------------------------------------
-- Supabase grants table privileges to the API roles by default; RLS is what
-- actually restricts access. Mirroring that here means a policy bug shows up as
-- a failing RLS test rather than being masked by a missing GRANT.

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
