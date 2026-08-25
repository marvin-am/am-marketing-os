/**
 * Raw SQL used by callers that hold their own transaction.
 *
 * The console and the funnel runtime go through PostgREST and the RPCs in
 * `supabase/migrations/0013_functions.sql`. Background jobs that need a real
 * transaction (`@am/jobs` via `pg`) use the statements below instead — they are
 * the same statements the RPCs run, kept here so the semantics are documented in
 * one place rather than buried in a migration.
 */

/**
 * Claims due outbox rows.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole point: several workers may drain the same
 * queue concurrently and no event is ever handed to two of them. The
 * `UPDATE … FROM claimed` marks the claim in the same statement, so a worker that
 * dies between claim and dispatch leaves the row `PROCESSING` with a `locked_at`
 * that `RECLAIM_STALE_OUTBOX_EVENTS_SQL` picks up.
 *
 * Parameters: `$1` destinations (`text[]`, NULL for all), `$2` limit,
 * `$3` worker label.
 */
export const CLAIM_OUTBOX_EVENTS_SQL = `
with claimed as (
  select o.id
  from public.outbox_events o
  where ($1::text[] is null or o.destination = any ($1::text[]))
    and o.status in ('PENDING', 'FAILED_RETRYING')
    and (o.next_attempt_at is null or o.next_attempt_at <= now())
  order by coalesce(o.next_attempt_at, o.created_at)
  limit greatest($2::int, 1)
  for update skip locked
)
update public.outbox_events o
   set status        = 'PROCESSING',
       locked_at     = now(),
       locked_by     = $3,
       attempt_count = o.attempt_count + 1,
       updated_at    = now()
  from claimed c
 where o.id = c.id
returning o.*;
`.trim();

/** Parameters: `$1` interval (e.g. `'15 minutes'`). */
export const RECLAIM_STALE_OUTBOX_EVENTS_SQL = `
update public.outbox_events
   set status     = 'FAILED_RETRYING',
       locked_at  = null,
       locked_by  = null,
       updated_at = now()
 where status = 'PROCESSING'
   and locked_at is not null
   and locked_at < now() - $1::interval
returning id;
`.trim();

/**
 * Enqueue inside an existing transaction.
 *
 * This is the statement that makes "a HubSpot outage never loses a lead" true:
 * the caller runs it in the same transaction as the business write, so either
 * both land or neither does. `ON CONFLICT DO NOTHING` on
 * `(destination, dataset_id, event_id)` makes a replay a no-op.
 *
 * Parameters: `$1` workspace_id, `$2` destination, `$3` event_id, `$4` dataset_id,
 * `$5` event_name, `$6` event_time, `$7` payload, `$8` payload_hash,
 * `$9` campaign_id, `$10` submission_id, `$11` lead_id, `$12` opportunity_id.
 */
export const ENQUEUE_OUTBOX_EVENT_SQL = `
insert into public.outbox_events (
  workspace_id, destination, event_id, dataset_id, event_name, event_time,
  payload, payload_hash, status, next_attempt_at,
  campaign_id, submission_id, lead_id, opportunity_id
)
values ($1, $2, $3, coalesce($4, ''), $5, $6, coalesce($7, '{}'::jsonb), $8, 'PENDING', now(), $9, $10, $11, $12)
on conflict (destination, dataset_id, event_id) do nothing
returning *;
`.trim();

/** Parameters: `$1` destination, `$2` dataset_id, `$3` event_id. */
export const FIND_OUTBOX_EVENT_SQL = `
select * from public.outbox_events
where destination = $1 and dataset_id = coalesce($2, '') and event_id = $3;
`.trim();

/**
 * Arm-level observation counts for the statistics engine.
 *
 * One query instead of one per arm — the console renders this for every running
 * experiment on the dashboard, so an N+1 here is felt immediately. Only
 * PRODUCTION traffic is counted (spec §35).
 *
 * Parameters: `$1` experiment_id.
 */
export const EXPERIMENT_ARM_OBSERVATIONS_SQL = `
select
  a.id                                          as arm_id,
  a.key                                         as arm_key,
  a.label                                       as label,
  a.is_control                                  as is_control,
  coalesce(x.sessions, 0)                       as sessions,
  coalesce(x.exposures, 0)                      as exposures,
  coalesce(s.conversions, 0)                    as conversions,
  coalesce(s.vq_scheduled, 0)                   as vq_scheduled,
  coalesce(s.vq_attended, 0)                    as vq_attended,
  coalesce(s.qualified_vq, 0)                   as qualified_vq,
  coalesce(s.opportunities, 0)                  as opportunities,
  coalesce(s.closed_won, 0)                     as closed_won,
  coalesce(s.revenue_minor, 0)                  as revenue_minor,
  coalesce(m.spend_minor, 0)                    as spend_minor,
  s.attribution_coverage                        as attribution_coverage
from public.experiment_arms a
left join (
  select arm_id,
         count(distinct session_id) as sessions,
         count(*)                   as exposures
  from public.experiment_exposures
  where experiment_id = $1
  group by arm_id
) x on x.arm_id = a.id
left join (
  select
    fs.experiment_arm_id                                             as arm_id,
    count(*) filter (where fs.state = 'ACCEPTED' or fs.state like 'HUBSPOT%') as conversions,
    count(*) filter (where l.vq_status in ('SCHEDULED','ATTENDED','NO_SHOW','PASSED','REJECTED')) as vq_scheduled,
    count(*) filter (where l.vq_status in ('ATTENDED','PASSED','REJECTED'))   as vq_attended,
    count(*) filter (where l.vq_status = 'PASSED')                            as qualified_vq,
    count(distinct o.id)                                                      as opportunities,
    count(distinct o.id) filter (where o.closed_won_at is not null)           as closed_won,
    coalesce(sum(o.amount_minor) filter (where o.closed_won_at is not null), 0) as revenue_minor,
    avg(case when snap.confidence in ('EXACT','HIGH_CONFIDENCE') then 1.0 else 0.0 end) as attribution_coverage
  from public.form_submissions fs
  left join public.leads l on l.submission_id = fs.id
  left join public.opportunities o on o.lead_id = l.id
  left join public.attribution_snapshots snap on snap.submission_id = fs.id
  where fs.experiment_id = $1 and fs.traffic_kind = 'PRODUCTION'
  group by fs.experiment_arm_id
) s on s.arm_id = a.id
left join (
  select ads.experiment_arm_id as arm_id, sum(i.spend_minor) as spend_minor
  from public.meta_insights_daily i
  join public.meta_adsets ads on ads.id = i.meta_adset_id
  where ads.experiment_arm_id is not null
  group by ads.experiment_arm_id
) m on m.arm_id = a.id
where a.experiment_id = $1
order by a.is_control desc, a.sort_order, a.key;
`.trim();

/**
 * The sales funnel for one campaign, as counts rather than rates: the UI needs
 * "12 / 340" beside "3,5 %", so the denominator must come back too.
 *
 * Parameters: `$1` campaign_id, `$2` from (timestamptz), `$3` to (timestamptz).
 */
export const CAMPAIGN_FUNNEL_COUNTS_SQL = `
select
  count(*)                                                             as submissions,
  count(*) filter (where fs.state not in ('REJECTED_VALIDATION','REJECTED_SPAM')) as leads,
  count(*) filter (where l.vq_status <> 'NOT_SCHEDULED')               as vq_scheduled,
  count(*) filter (where l.vq_status in ('ATTENDED','PASSED','REJECTED')) as vq_attended,
  count(*) filter (where l.vq_status = 'NO_SHOW')                      as vq_no_show,
  count(*) filter (where l.vq_status = 'PASSED')                       as qualified_vq,
  count(distinct o.id)                                                 as opportunities,
  count(distinct o.id) filter (where o.closed_won_at is not null)      as closed_won,
  count(distinct o.id) filter (where o.closed_lost_at is not null)     as closed_lost,
  coalesce(sum(o.amount_minor) filter (where o.closed_won_at is not null), 0) as revenue_minor,
  count(*) filter (where snap.confidence in ('EXACT','HIGH_CONFIDENCE')) as trustworthy_attributions
from public.form_submissions fs
left join public.leads l on l.submission_id = fs.id
left join public.opportunities o on o.lead_id = l.id
left join public.attribution_snapshots snap on snap.submission_id = fs.id
where fs.campaign_id = $1
  and fs.traffic_kind = 'PRODUCTION'
  and ($2::timestamptz is null or fs.submitted_at >= $2::timestamptz)
  and ($3::timestamptz is null or fs.submitted_at <= $3::timestamptz);
`.trim();

/**
 * Angle similarity search over the shared embedding index.
 *
 * `<=>` is pgvector's cosine distance, so `1 - distance` is the similarity that
 * `classifyAngleSimilarity()` expects. `ORDER BY <=>` is what lets the HNSW index
 * serve the query; it falls back to an exact scan when the index could not be
 * built (see `app.schema_capabilities`).
 *
 * The embedding is `vector(1536)` — `text-embedding-3-large` queried with
 * `dimensions: 1536`, because pgvector cannot index above 2000 dimensions.
 *
 * Parameters: `$1` workspace_id, `$2` embedding, `$3` limit, `$4` since.
 */
export const SIMILAR_ANGLES_SQL = `
select
  e.entity_id                as angle_id,
  a.name                     as angle_name,
  1 - (e.embedding <=> $2)   as similarity,
  a.last_used_at             as last_used_at,
  a.first_used_campaign_id   as first_used_campaign_id
from public.knowledge_embeddings e
join public.angles a on a.id = e.entity_id
where e.workspace_id = $1
  and e.source_kind = 'ANGLE'
  and ($4::timestamptz is null or a.last_used_at is null or a.last_used_at >= $4::timestamptz)
order by e.embedding <=> $2
limit greatest($3::int, 1);
`.trim();
