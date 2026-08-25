-- =============================================================================
-- 0016_jobs_and_outbox.sql — cooperative job locks, multi-destination claiming
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Job locks
-- -----------------------------------------------------------------------------
-- Two overlapping cron invocations must not both drain the outbox.
--
-- A `pg_advisory_lock` would be released automatically when a crashed session's
-- connection drops, which is attractive for serverless. It is the wrong tool
-- here for two reasons: PostgREST/Supabase pools connections, so the "session"
-- that holds the lock is not the invocation that took it, and an advisory lock
-- is invisible to the operator. A row with an explicit TTL gives the same crash
-- recovery (the lock simply expires), survives connection pooling, and shows up
-- in the console.
--
-- No `workspace_id`: locks are process-level, taken by the jobs runtime under
-- the service role. RLS is therefore enabled with no policies at all — deny by
-- default for `anon` and `authenticated`, bypassed by `service_role`.

create table public.job_locks (
  key          text        primary key,
  holder       text        not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  acquire_count integer    not null default 1 check (acquire_count >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint job_locks_ttl_positive check (expires_at > acquired_at)
);

comment on table public.job_locks is
  'Cooperative locks for scheduled jobs. TTL-based so a crashed invocation releases itself.';

create index job_locks_expiry_idx on public.job_locks (expires_at);

create trigger job_locks_touch
  before update on public.job_locks
  for each row execute function app.touch_updated_at();

alter table public.job_locks enable row level security;
alter table public.job_locks force row level security;
revoke all on public.job_locks from anon, authenticated;
grant all on public.job_locks to service_role;

/**
 * Takes the lock, or reports that someone else holds it.
 *
 * Succeeds when the lock is free, has expired, or is already held by the same
 * holder (a re-entrant renewal). The `where` clause on the conflict path is what
 * makes this atomic: a second worker's update matches no row and the `returning`
 * yields nothing.
 */
create or replace function public.try_acquire_job_lock(
  p_key         text,
  p_holder      text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acquired boolean;
begin
  if p_key is null or p_holder is null then
    raise exception 'Job-Lock benötigt Key und Holder.' using errcode = 'AM005';
  end if;

  insert into public.job_locks as l (key, holder, acquired_at, expires_at)
  values (p_key, p_holder, now(), now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 60), 1)))
  on conflict (key) do update
    set holder        = excluded.holder,
        acquired_at   = now(),
        expires_at    = excluded.expires_at,
        acquire_count = l.acquire_count + 1
    where l.expires_at <= now() or l.holder = excluded.holder
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

/** Releasing is a no-op unless the caller actually holds the lock. */
create or replace function public.release_job_lock(p_key text, p_holder text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.job_locks where key = p_key and holder = p_holder;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

grant execute on function public.try_acquire_job_lock(text, text, integer) to authenticated, service_role;
grant execute on function public.release_job_lock(text, text)               to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Outbox: claim across destinations in one pass
-- -----------------------------------------------------------------------------
-- The dispatcher drains every destination in a single invocation, so forcing one
-- destination per call meant N round trips and N locks. `p_destinations` now
-- takes an array; NULL means "every destination".

drop function if exists public.claim_outbox_events(text, integer, text);

create or replace function public.claim_outbox_events(
  p_destinations text[]  default null,
  p_limit        integer default 25,
  p_worker       text    default 'worker'
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
    where (p_destinations is null or o.destination = any (p_destinations))
      and o.status in ('PENDING', 'FAILED_RETRYING')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
    order by coalesce(o.next_attempt_at, o.created_at)
    limit greatest(coalesce(p_limit, 25), 1)
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

comment on function public.claim_outbox_events(text[], integer, text) is
  'Claims due outbox rows with FOR UPDATE SKIP LOCKED. NULL destinations means all of them.';

grant execute on function public.claim_outbox_events(text[], integer, text) to authenticated, service_role;

-- The dispatcher marks a result knowing only (destination, event_id): HubSpot
-- events carry no dataset id, so the three-column dedup key is not available on
-- the way back.
create index outbox_events_destination_event_idx on public.outbox_events (destination, event_id);
