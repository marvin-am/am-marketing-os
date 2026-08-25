-- =============================================================================
-- 0002_core.sql — workspaces, profiles, membership, role limits
-- =============================================================================
-- Not multi-tenant in v1 (AGENTS.md), but every business row still carries a
-- workspace_id: it is what makes RLS a single, uniform predicate instead of a
-- per-table judgement call, and it is what the cross-workspace leak test asserts.
-- =============================================================================

create table public.workspaces (
  id                uuid primary key default gen_random_uuid(),
  slug              text        not null unique,
  name              text        not null,
  locale            text        not null default 'de-DE',
  default_currency  text        not null default 'EUR' check (default_currency ~ '^[A-Z]{3}$'),
  timezone          text        not null default 'Europe/Berlin',
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid
);

comment on table public.workspaces is 'One row in v1: A&M itself. The column exists so isolation is mechanical.';

-- A profile mirrors an auth.users row. The id is deliberately the auth user id
-- so `auth.uid()` can be used directly in policies without a join.
create table public.profiles (
  id            uuid primary key,
  email         text        not null,
  display_name  text        not null,
  avatar_url    text,
  locale        text        not null default 'de-DE',
  is_active     boolean     not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index profiles_email_lower_key on public.profiles (lower(email));

-- Bind to auth.users where GoTrue actually exists (Supabase); skip on bare PG.
do $fk$
begin
  if to_regclass('auth.users') is not null then
    alter table public.profiles
      add constraint profiles_id_fkey foreign key (id) references auth.users (id) on delete cascade;
  end if;
end
$fk$;

create table public.workspace_members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  profile_id   uuid        not null references public.profiles (id) on delete cascade,
  -- Mirrors ROLES in packages/domain/src/roles.ts.
  roles        text[]      not null default array['VIEWER']::text[],
  invited_by   uuid        references public.profiles (id),
  joined_at    timestamptz not null default now(),
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  updated_by   uuid,
  constraint workspace_members_unique unique (workspace_id, profile_id),
  constraint workspace_members_roles_known check (
    roles <@ array[
      'VIEWER','MARKETING_OPERATOR','CREATIVE_REVIEWER','MARKETING_LEAD','REVOPS','EXECUTIVE','ADMIN'
    ]::text[]
  ),
  constraint workspace_members_roles_present check (array_length(roles, 1) >= 1)
);

create index workspace_members_profile_idx on public.workspace_members (profile_id) where is_active;
create index workspace_members_workspace_idx on public.workspace_members (workspace_id) where is_active;

-- Mirrors DEFAULT_ROLE_BUDGET_LIMITS; every value is editable in Settings.
create table public.role_limits (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid        not null references public.workspaces (id) on delete cascade,
  role                      text        not null check (role in (
                              'VIEWER','MARKETING_OPERATOR','CREATIVE_REVIEWER','MARKETING_LEAD',
                              'REVOPS','EXECUTIVE','ADMIN')),
  max_single_increase_pct   numeric(6,4) not null default 0 check (max_single_increase_pct >= 0),
  max_daily_budget_minor    bigint      not null default 0 check (max_daily_budget_minor >= 0),
  max_scales_per_24h        integer     not null default 0 check (max_scales_per_24h >= 0),
  may_pause                 boolean     not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid,
  updated_by                uuid,
  constraint role_limits_unique unique (workspace_id, role)
);

create trigger workspaces_touch        before update on public.workspaces        for each row execute function app.touch_updated_at();
create trigger profiles_touch          before update on public.profiles          for each row execute function app.touch_updated_at();
create trigger workspace_members_touch before update on public.workspace_members for each row execute function app.touch_updated_at();
create trigger role_limits_touch       before update on public.role_limits       for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- RLS predicates
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER so the membership lookup itself is not subject to the policy
-- it is used by — otherwise the workspace_members policy recurses infinitely.

create or replace function app.current_profile_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

create or replace function app.is_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.profile_id = auth.uid()
      and m.is_active
  );
$$;

create or replace function app.has_workspace_role(p_workspace_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.profile_id = auth.uid()
      and m.is_active
      and m.roles && p_roles
  );
$$;

create or replace function app.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
as $$
  select app.has_workspace_role(p_workspace_id, array['ADMIN']::text[]);
$$;

-- Workspaces the caller belongs to. Used by the console's workspace switcher and
-- by every repository that resolves "the current workspace" server side.
create or replace function app.member_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.profile_id = auth.uid() and m.is_active;
$$;

grant execute on function app.capability(text)                        to authenticated, service_role;
grant execute on function app.current_profile_id()                    to authenticated, service_role;
grant execute on function app.is_member(uuid)                         to authenticated, service_role;
grant execute on function app.has_workspace_role(uuid, text[])        to authenticated, service_role;
grant execute on function app.is_workspace_admin(uuid)                to authenticated, service_role;
grant execute on function app.member_workspace_ids()                  to authenticated, service_role;
