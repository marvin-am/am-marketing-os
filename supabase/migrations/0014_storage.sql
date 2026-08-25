-- =============================================================================
-- 0014_storage.sql — buckets and storage policies
-- =============================================================================
-- Buckets and their visibility:
--
--   brand-assets          public   logo / brand marks rendered on public funnels
--   creative-source       private  raw generations and working files
--   creative-renditions   public   finished ad placements (they end up on Meta anyway)
--   historical-creatives  private  imported ad history — internal analysis only
--   private-imports       private  CRM/CSV exports; may contain personal data
--
-- Everything is written server side. `anon` may read the two public buckets and
-- may never list, insert, update or delete anything.
-- =============================================================================

create or replace function app.is_any_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.profile_id = auth.uid() and m.is_active
  );
$$;

grant execute on function app.is_any_member() to authenticated, service_role;

do $storage$
begin
  if to_regclass('storage.buckets') is null then
    raise warning 'storage schema not present (bare Postgres): skipping bucket creation. Supabase applies this file normally.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('brand-assets',         'brand-assets',         true,   26214400,
      array['image/png','image/jpeg','image/webp','image/svg+xml','font/woff2','font/woff']),
    ('creative-source',      'creative-source',      false, 209715200,
      array['image/png','image/jpeg','image/webp','video/mp4','application/json']),
    ('creative-renditions',  'creative-renditions',  true,   52428800,
      array['image/png','image/jpeg','image/webp','video/mp4']),
    ('historical-creatives', 'historical-creatives', false, 209715200,
      array['image/png','image/jpeg','image/webp','video/mp4']),
    ('private-imports',      'private-imports',      false, 524288000,
      array['text/csv','application/json','application/zip','application/pdf',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Public read for the two public buckets. Read only — no listing of others,
  -- no writes, no deletes.
  execute $p$
    drop policy if exists am_public_bucket_read on storage.objects;
    create policy am_public_bucket_read on storage.objects
      for select to anon, authenticated
      using (bucket_id in ('brand-assets', 'creative-renditions'));
  $p$;

  -- Workspace members get full access to every A&M bucket. The service role
  -- bypasses this entirely and is what the render/import jobs actually use.
  execute $p$
    drop policy if exists am_member_read on storage.objects;
    create policy am_member_read on storage.objects
      for select to authenticated
      using (
        bucket_id in ('brand-assets','creative-source','creative-renditions',
                      'historical-creatives','private-imports')
        and app.is_any_member()
      );
  $p$;

  execute $p$
    drop policy if exists am_member_insert on storage.objects;
    create policy am_member_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id in ('brand-assets','creative-source','creative-renditions',
                      'historical-creatives','private-imports')
        and app.is_any_member()
      );
  $p$;

  execute $p$
    drop policy if exists am_member_update on storage.objects;
    create policy am_member_update on storage.objects
      for update to authenticated
      using (
        bucket_id in ('brand-assets','creative-source','creative-renditions',
                      'historical-creatives','private-imports')
        and app.is_any_member()
      )
      with check (
        bucket_id in ('brand-assets','creative-source','creative-renditions',
                      'historical-creatives','private-imports')
        and app.is_any_member()
      );
  $p$;

  -- Deleting a rendition that an ad already points at breaks the audit trail, so
  -- deletes are restricted to the roles that carry that responsibility.
  execute $p$
    drop policy if exists am_member_delete on storage.objects;
    create policy am_member_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id in ('brand-assets','creative-source','creative-renditions',
                      'historical-creatives','private-imports')
        and exists (
          select 1 from public.workspace_members m
          where m.profile_id = auth.uid()
            and m.is_active
            and m.roles && array['ADMIN','MARKETING_LEAD']::text[]
        )
      );
  $p$;
end
$storage$;
