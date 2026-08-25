-- =============================================================================
-- 0018_role_gated_writes.sql — writes follow the permission matrix, not membership
-- =============================================================================
-- 0012 gave every workspace-scoped table the same predicate for every command:
-- `app.is_member(workspace_id)`. That is the right answer for reads and the
-- wrong one for writes. The console checks a `Permission` before every mutating
-- server action, but the browser holds a Supabase session token and PostgREST
-- answers it directly, so a member with no authority at all could still write
-- any row the policy let them see — rewrite the per-role budget ceilings that
-- the budget gate reads, or repoint a live funnel's redirect.
--
-- This file splits that single policy in two:
--
--   <table>_read   SELECT           — membership, exactly as before.
--   <table>_write  INSERT/UPDATE/DELETE — the capability that governs the write.
--
-- Permissive policies are OR-ed per command, so SELECT keeps the membership
-- predicate and the write commands get only the capability one. Reads are not
-- narrowed anywhere in this file.
--
-- The capability names are the `Permission` union in packages/domain/src/roles.ts
-- and the role sets are that file's `ROLE_PERMISSIONS`, mirrored once into
-- `app.permission_roles` instead of being copied into a dozen policy bodies. A
-- capability moves by editing one row, in the same way it moves by editing one
-- array in roles.ts. `supabase/tests/role-write-authority.test.ts` compares the
-- two representations row by row, so a change to one that is not made in the
-- other fails the suite rather than drifting silently.
--
-- Append-only tables (0012) and the restricted tables `submission_pii_encrypted`
-- and `integration_connections` are deliberately untouched: they already answer
-- this question, and answering it twice in two places is how the two answers
-- start disagreeing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The permission matrix
-- -----------------------------------------------------------------------------
-- One row per `Permission`, holding every `Role` that grants it. The role names
-- are checked against the same seven-value list the `workspace_members.roles`
-- column is checked against, so a typo is a constraint violation at migration
-- time rather than a policy that silently never matches anyone.

create table if not exists app.permission_roles (
  permission text primary key,
  roles      text[] not null check (
    array_length(roles, 1) >= 1
    and roles <@ array[
      'VIEWER','MARKETING_OPERATOR','CREATIVE_REVIEWER','MARKETING_LEAD',
      'REVOPS','EXECUTIVE','ADMIN'
    ]::text[]
  )
);

comment on table app.permission_roles is
  'Mirror of ROLE_PERMISSIONS in packages/domain/src/roles.ts, inverted to permission -> roles.';

-- Rewritten wholesale on every run: this table is a projection of roles.ts, and
-- a stale row left behind by an earlier version of that file would be an
-- authority grant nobody can find in the source.
--
-- `app.approval_kind_permissions` below references these rows, so on a re-run it
-- has to be emptied before the parent can be. It is refilled a few statements
-- down, in the same transaction.
do $reset$
begin
  if to_regclass('app.approval_kind_permissions') is not null then
    delete from app.approval_kind_permissions;
  end if;
end
$reset$;

delete from app.permission_roles;

insert into app.permission_roles (permission, roles) values
  ('campaign.read',                array['VIEWER','MARKETING_OPERATOR','CREATIVE_REVIEWER','MARKETING_LEAD','REVOPS','EXECUTIVE','ADMIN']),
  ('campaign.create',              array['MARKETING_OPERATOR','MARKETING_LEAD','ADMIN']),
  ('campaign.edit',                array['MARKETING_OPERATOR','MARKETING_LEAD','ADMIN']),
  ('campaign.approve_strategy',    array['MARKETING_LEAD','EXECUTIVE','ADMIN']),
  ('campaign.approve_assets',      array['CREATIVE_REVIEWER','MARKETING_LEAD','ADMIN']),
  ('campaign.approve_test_plan',   array['MARKETING_LEAD','ADMIN']),
  ('campaign.publish',             array['MARKETING_LEAD','ADMIN']),
  ('campaign.pause',               array['MARKETING_LEAD','ADMIN']),
  ('campaign.scale_budget',        array['MARKETING_LEAD','EXECUTIVE','ADMIN']),
  ('campaign.scale_budget_major',  array['EXECUTIVE','ADMIN']),
  ('campaign.archive',             array['MARKETING_LEAD','ADMIN']),
  ('creative.edit',                array['MARKETING_OPERATOR','MARKETING_LEAD','ADMIN']),
  ('creative.generate',            array['MARKETING_OPERATOR','MARKETING_LEAD','ADMIN']),
  ('creative.approve',             array['CREATIVE_REVIEWER','MARKETING_LEAD','ADMIN']),
  ('funnel.edit',                  array['MARKETING_OPERATOR','MARKETING_LEAD','ADMIN']),
  ('funnel.publish',               array['MARKETING_LEAD','ADMIN']),
  ('experiment.edit',              array['MARKETING_OPERATOR','MARKETING_LEAD','ADMIN']),
  ('experiment.conclude',          array['MARKETING_LEAD','ADMIN']),
  ('recommendation.execute',       array['MARKETING_LEAD','ADMIN']),
  ('crm.mapping.manage',           array['REVOPS','ADMIN']),
  ('crm.revenue.manage',           array['REVOPS','ADMIN']),
  ('integration.manage',           array['REVOPS','ADMIN']),
  ('settings.manage',              array['ADMIN']),
  ('user.manage',                  array['ADMIN']),
  ('audit.read',                   array['VIEWER','MARKETING_OPERATOR','CREATIVE_REVIEWER','MARKETING_LEAD','REVOPS','EXECUTIVE','ADMIN']);

-- The `app` schema is internal (0012). RLS with no policy on top of no grant so
-- that the matrix cannot be read, and above all not written, through PostgREST.
alter table app.permission_roles enable row level security;
revoke all on app.permission_roles from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Which permission each approval kind requires
-- -----------------------------------------------------------------------------
-- Mirror of APPROVAL_PERMISSIONS in packages/domain/src/approvals.ts. An
-- approval is the one row whose authority depends on its own content, so the
-- policy on `approvals` resolves the permission per row from its `kind` rather
-- than admitting the union of everyone who may approve anything.

create table if not exists app.approval_kind_permissions (
  kind       text primary key,
  permission text not null references app.permission_roles (permission)
);

comment on table app.approval_kind_permissions is
  'Mirror of APPROVAL_PERMISSIONS in packages/domain/src/approvals.ts.';

delete from app.approval_kind_permissions;

insert into app.approval_kind_permissions (kind, permission) values
  ('STRATEGY',     'campaign.approve_strategy'),
  ('ASSETS',       'campaign.approve_assets'),
  ('TEST_PLAN',    'campaign.approve_test_plan'),
  ('PUBLISH',      'campaign.publish'),
  ('BUDGET_SCALE', 'campaign.scale_budget'),
  ('MAJOR_CHANGE', 'campaign.scale_budget_major');

alter table app.approval_kind_permissions enable row level security;
revoke all on app.approval_kind_permissions from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Which capability governs writing each table
-- -----------------------------------------------------------------------------
-- Derived from the `defineAction({ permission: … })` call sites in
-- apps/console/src/app/(app)/**/actions.ts and the repository each one writes
-- through. Where several capabilities legitimately write the same table the row
-- lists all of them, because the union of the real writers is what must survive:
-- a policy that is correct but too narrow breaks a working feature, which is how
-- a security fix gets reverted.
--
-- A table absent from this list keeps the membership policy from 0012. That is a
-- statement about evidence, not about safety: those tables have no mutating
-- console call site and no capability in roles.ts that names them, and guessing
-- a role for them would put authority in the schema that the product does not
-- have anywhere else.

create table if not exists app.write_capabilities (
  table_name  text primary key,
  permissions text[] not null check (array_length(permissions, 1) >= 1)
);

comment on table app.write_capabilities is
  'Table -> the capabilities whose holders may INSERT/UPDATE/DELETE it. Read by the policy loop below and by the verification block.';

delete from app.write_capabilities;

insert into app.write_capabilities (table_name, permissions) values
  -- Settings. The budget authority matrix, the workspace configuration the gates
  -- read, the consent texts, and the prompt registry that decides what the model
  -- is asked. `settings.manage` is ADMIN only.
  ('role_limits',          array['settings.manage']),
  ('workspace_settings',   array['settings.manage']),
  ('consent_versions',     array['settings.manage']),
  ('prompt_versions',      array['settings.manage']),

  -- Campaign lifecycle. `campaigns` also carries `daily_budget_minor`, which
  -- `campaign.scale_budget` changes and which EXECUTIVE holds without holding
  -- `campaign.edit`.
  ('campaigns',            array['campaign.edit','campaign.scale_budget']),
  ('campaign_versions',    array['campaign.edit']),

  -- Creatives. Editing and reviewing are different capabilities held by
  -- different roles, and both write `review_state` on the same rows.
  ('creative_concepts',    array['creative.edit','creative.approve']),
  ('creative_versions',    array['creative.edit','creative.approve']),
  ('creative_assets',      array['creative.edit']),
  ('creative_renditions',  array['creative.edit']),

  -- Funnels and forms. Publishing is a strictly smaller role set than editing,
  -- so the draft tables need only `funnel.edit`; the published row is the one
  -- the public internet resolves, and it needs `funnel.publish`.
  ('funnels',              array['funnel.edit']),
  ('funnel_versions',      array['funnel.edit']),
  ('form_definitions',     array['funnel.edit']),
  ('form_versions',        array['funnel.edit']),
  ('published_funnels',    array['funnel.publish']),

  -- Experiments. `experiment.conclude` is held by a subset of the roles that
  -- hold `experiment.edit`, so the narrower one adds nothing at table level.
  ('experiments',          array['experiment.edit']),
  ('experiment_arms',      array['experiment.edit']),

  -- Recommendations are produced by jobs under the service role; the only thing
  -- an operator does to one is execute or dismiss it.
  ('recommendations',      array['recommendation.execute']),

  -- CRM and integrations.
  ('hubspot_mappings',     array['crm.mapping.manage']),
  ('opportunities',        array['crm.revenue.manage']),
  ('outbox_events',        array['integration.manage']);

alter table app.write_capabilities enable row level security;
revoke all on app.write_capabilities from anon, authenticated;

-- -----------------------------------------------------------------------------
-- The predicates
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER and a pinned search_path for the same reason as
-- `app.is_member` (0002): the lookup must not itself be subject to the policy it
-- is evaluated for, and a policy predicate is the last place a search_path
-- should be resolvable by the caller.

create or replace function app.has_capability(p_workspace_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.has_workspace_role(
    p_workspace_id,
    coalesce((select r.roles from app.permission_roles r where r.permission = p_permission), array[]::text[])
  );
$$;

comment on function app.has_capability(uuid, text) is
  'True when the caller holds a role that grants this permission in this workspace. An unknown permission grants nobody.';

create or replace function app.has_any_capability(p_workspace_id uuid, p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.has_workspace_role(
    p_workspace_id,
    coalesce(
      (select array_agg(distinct role)
         from app.permission_roles r, unnest(r.roles) as role
        where r.permission = any (p_permissions)),
      array[]::text[]
    )
  );
$$;

comment on function app.has_any_capability(uuid, text[]) is
  'True when the caller holds any role granting any of these permissions in this workspace.';

create or replace function app.approval_capability(p_kind text)
returns text
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select k.permission from app.approval_kind_permissions k where k.kind = p_kind;
$$;

comment on function app.approval_capability(text) is
  'The permission required to decide an approval of this kind.';

revoke all on function app.has_capability(uuid, text) from public, anon;
revoke all on function app.has_any_capability(uuid, text[]) from public, anon;
revoke all on function app.approval_capability(text) from public, anon;

grant execute on function app.has_capability(uuid, text)          to authenticated, service_role;
grant execute on function app.has_any_capability(uuid, text[])    to authenticated, service_role;
grant execute on function app.approval_capability(text)           to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Replace the uniform policy on every table that carries authority
-- -----------------------------------------------------------------------------

do $split$
declare
  r record;
begin
  for r in select w.table_name, w.permissions from app.write_capabilities w order by w.table_name
  loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then
      raise exception 'app.write_capabilities names public.%, which does not exist', r.table_name;
    end if;

    execute format('drop policy if exists %I on public.%I', r.table_name || '_member', r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name || '_read',   r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name || '_write',  r.table_name);

    execute format($p$
      create policy %1$I on public.%2$I
        for select to authenticated
        using (app.is_member(workspace_id))
    $p$, r.table_name || '_read', r.table_name);

    execute format($p$
      create policy %1$I on public.%2$I
        for all to authenticated
        using (app.has_any_capability(workspace_id, %3$L::text[]))
        with check (app.has_any_capability(workspace_id, %3$L::text[]))
    $p$, r.table_name || '_write', r.table_name, r.permissions);
  end loop;
end
$split$;

-- -----------------------------------------------------------------------------
-- Approvals: the required capability depends on the row
-- -----------------------------------------------------------------------------
-- Three separate rules, because an approval row moves through three different
-- kinds of hands:
--
--   * Deciding it — APPROVED or REJECTED — is the authority, and it is the one
--     `APPROVAL_PERMISSIONS` names for that kind.
--   * Requesting one (PENDING) is not authority: the row carries no decision
--     yet, and the campaign flow raises it as content becomes ready.
--   * Invalidating one is the mechanical consequence of a content change
--     (spec §4.1, criterion 25). Whoever may change the content must be able to
--     invalidate the approval that covered it, or a stale approval outlives the
--     content it approved — which is the failure this rule exists to prevent.

drop policy if exists approvals_member   on public.approvals;
drop policy if exists approvals_read     on public.approvals;
drop policy if exists approvals_write    on public.approvals;
drop policy if exists approvals_request  on public.approvals;
drop policy if exists approvals_decide   on public.approvals;
drop policy if exists approvals_withdraw on public.approvals;

create policy approvals_read on public.approvals
  for select to authenticated
  using (app.is_member(workspace_id));

create policy approvals_request on public.approvals
  for insert to authenticated
  with check (
    app.has_capability(workspace_id, app.approval_capability(kind))
    or (state = 'PENDING' and app.has_capability(workspace_id, 'campaign.edit'))
  );

create policy approvals_decide on public.approvals
  for update to authenticated
  using (
    app.has_capability(workspace_id, app.approval_capability(kind))
    or app.has_capability(workspace_id, 'campaign.edit')
  )
  with check (
    app.has_capability(workspace_id, app.approval_capability(kind))
    or (state in ('PENDING', 'INVALIDATED') and app.has_capability(workspace_id, 'campaign.edit'))
  );

create policy approvals_withdraw on public.approvals
  for delete to authenticated
  using (app.has_capability(workspace_id, app.approval_capability(kind)));

comment on policy approvals_decide on public.approvals is
  'APPROVED and REJECTED need the kind''s permission; INVALIDATED follows content edit rights so a content change always voids its approval.';

-- -----------------------------------------------------------------------------
-- Proof obligations
-- -----------------------------------------------------------------------------

do $verify$
declare
  v_offenders  text[];
  v_missing    text[];
  v_unreadable text[];
  v_unknown    text[];
begin
  -- Every capability referenced for a write must exist in the matrix, or the
  -- policy would resolve to an empty role array and lock the table for everyone
  -- including the roles that are supposed to hold it.
  select coalesce(array_agg(distinct p order by p), array[]::text[])
    into v_unknown
  from app.write_capabilities w, unnest(w.permissions) as p
  where not exists (select 1 from app.permission_roles r where r.permission = p);

  if array_length(v_unknown, 1) is not null then
    raise exception 'app.write_capabilities references unknown permission(s): %',
      array_to_string(v_unknown, ', ');
  end if;

  -- No authority table may still be writable on membership alone. A `for all to
  -- authenticated` policy whose predicate is `app.is_member` is exactly the
  -- policy this migration replaces, and a permissive one left in place would
  -- OR itself back over the capability check.
  select coalesce(array_agg(distinct p.tablename order by p.tablename), array[]::text[])
    into v_offenders
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in (select table_name from app.write_capabilities union select 'approvals')
    and p.permissive = 'PERMISSIVE'
    and p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
    and 'authenticated' = any (p.roles)
    and coalesce(p.qual, p.with_check, '') like '%is_member%';

  if array_length(v_offenders, 1) is not null then
    raise exception 'Membership alone still grants writes on: %', array_to_string(v_offenders, ', ');
  end if;

  -- …and each of them must actually have gained the capability-scoped rule,
  -- so that a table cannot pass the check above by having no write policy that
  -- someone forgot to create.
  select coalesce(array_agg(w.table_name order by w.table_name), array[]::text[])
    into v_missing
  from app.write_capabilities w
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = w.table_name
      and p.cmd = 'ALL' and 'authenticated' = any (p.roles)
      and coalesce(p.qual, '') like '%has_any_capability%'
  );

  if array_length(v_missing, 1) is not null then
    raise exception 'No capability-scoped write policy on: %', array_to_string(v_missing, ', ');
  end if;

  -- Reads were not narrowed: every table touched here keeps a membership SELECT.
  select coalesce(array_agg(t order by t), array[]::text[])
    into v_unreadable
  from (select table_name as t from app.write_capabilities union select 'approvals') tables
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = tables.t
      and p.cmd = 'SELECT' and 'authenticated' = any (p.roles)
      and coalesce(p.qual, '') like '%is_member%'
  );

  if array_length(v_unreadable, 1) is not null then
    raise exception 'Membership no longer grants SELECT on: %', array_to_string(v_unreadable, ', ');
  end if;
end
$verify$;
