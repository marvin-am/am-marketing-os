-- =============================================================================
-- 0012_rls.sql — privileges and row level security
-- =============================================================================
-- Two layers, on purpose:
--
--   1. GRANTs. `anon` is stripped of everything and given back exactly one
--      SELECT: the live `published_funnels` row. Even a policy mistake cannot
--      expose leads, submissions or PII to the public key, because the privilege
--      is not there.
--   2. RLS. Every workspace-scoped table carries the same predicate,
--      `app.is_member(workspace_id)`, applied by a loop so no table can be
--      forgotten.
--
-- The public funnel runtime writes through SECURITY DEFINER functions (0013),
-- never through table privileges.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Baseline privileges
-- -----------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;

-- The `app` schema is internal: never exposed to PostgREST, never granted to anon.
revoke all on all tables in schema app from anon, authenticated;
alter table app.schema_capabilities enable row level security;

-- -----------------------------------------------------------------------------
-- Enable RLS + the uniform workspace policy on every workspace-scoped table
-- -----------------------------------------------------------------------------

do $rls$
declare
  r record;
  -- Append-only: history that must never be edited after the fact.
  append_only constant text[] := array[
    'events', 'touchpoints', 'submission_status_history', 'lead_stage_events',
    'attribution_snapshots', 'audit_logs', 'experiment_results', 'experiment_exposures',
    'hubspot_stage_history', 'hubspot_sync_attempts', 'integration_health_checks',
    'recommendation_actions', 'revenue_events', 'capi_dispatches'
  ];
  -- Personal data and provider secrets: membership alone is not enough.
  restricted constant text[] := array['submission_pii_encrypted', 'integration_connections'];
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'workspace_id'
      and t.table_type = 'BASE TABLE'
    order by c.table_name
  loop
    execute format('alter table public.%I enable row level security', r.table_name);
    execute format('alter table public.%I force row level security', r.table_name);

    if r.table_name = any (restricted) then
      execute format($p$
        create policy %1$s_restricted on public.%1$I
          for all to authenticated
          using (app.has_workspace_role(workspace_id, array['ADMIN','REVOPS','MARKETING_LEAD']::text[]))
          with check (app.has_workspace_role(workspace_id, array['ADMIN','REVOPS','MARKETING_LEAD']::text[]))
      $p$, r.table_name);

    elsif r.table_name = any (append_only) then
      execute format($p$
        create policy %1$s_select on public.%1$I
          for select to authenticated using (app.is_member(workspace_id))
      $p$, r.table_name);
      execute format($p$
        create policy %1$s_insert on public.%1$I
          for insert to authenticated with check (app.is_member(workspace_id))
      $p$, r.table_name);

    else
      execute format($p$
        create policy %1$s_member on public.%1$I
          for all to authenticated
          using (app.is_member(workspace_id))
          with check (app.is_member(workspace_id))
      $p$, r.table_name);
    end if;
  end loop;
end
$rls$;

-- `force row level security` also applies the policies to the table owner, which
-- is what makes the cross-workspace test meaningful when it runs as the migration
-- role. service_role keeps BYPASSRLS and is unaffected.

-- -----------------------------------------------------------------------------
-- Tables that are not workspace scoped
-- -----------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;

create policy workspaces_member on public.workspaces
  for select to authenticated using (app.is_member(id));

create policy workspaces_admin on public.workspaces
  for update to authenticated
  using (app.is_workspace_admin(id))
  with check (app.is_workspace_admin(id));

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

-- A member may see the profiles of people they share a workspace with, and edit
-- only their own.
create policy profiles_self_or_colleague on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.workspace_members mine
      join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
      where mine.profile_id = auth.uid()
        and mine.is_active
        and theirs.profile_id = public.profiles.id
        and theirs.is_active
    )
  );

create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Membership itself is admin-managed; everyone may read their own workspace roster.
drop policy if exists workspace_members_member on public.workspace_members;

create policy workspace_members_read on public.workspace_members
  for select to authenticated using (app.is_member(workspace_id));

create policy workspace_members_admin on public.workspace_members
  for all to authenticated
  using (app.is_workspace_admin(workspace_id))
  with check (app.is_workspace_admin(workspace_id));

-- -----------------------------------------------------------------------------
-- The single anon read: a live published funnel
-- -----------------------------------------------------------------------------
-- Everything else the runtime needs (the funnel spec, the form spec, the consent
-- text) comes back from public.get_published_funnel() in 0013, which is
-- SECURITY DEFINER and returns only those columns.

grant select on public.published_funnels to anon;

create policy published_funnels_public_read on public.published_funnels
  for select to anon
  using (is_live and unpublished_at is null and environment = 'production');

-- -----------------------------------------------------------------------------
-- Proof obligations, expressed as comments next to the thing they protect
-- -----------------------------------------------------------------------------

comment on policy published_funnels_public_read on public.published_funnels is
  'The only row the anon key may read anywhere in the schema.';

do $verify$
declare
  v_missing text[];
begin
  select coalesce(array_agg(t.table_name order by t.table_name), array[]::text[])
    into v_missing
  from information_schema.tables t
  join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
  where t.table_schema = 'public'
    and t.table_type = 'BASE TABLE'
    and not c.relrowsecurity;

  if array_length(v_missing, 1) is not null then
    raise exception 'RLS is not enabled on: %', array_to_string(v_missing, ', ');
  end if;
end
$verify$;
