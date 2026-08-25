# Migrations

Plain `.sql` files, applied in filename order. No migration framework: `psql` in
a loop is enough for a single-deployment internal tool, and it keeps the schema
readable in a diff.

## Order and what each file owns

| File | Owns |
| --- | --- |
| `0001_extensions.sql` | `pgcrypto`, `pg_trgm`, `vector`, the `app` schema, Supabase roles, `auth.uid()` fallback, `app.touch_updated_at()`, the two immutability trigger functions |
| `0002_core.sql` | `workspaces`, `profiles`, `workspace_members`, `role_limits`, and the RLS predicates (`app.is_member`, `app.has_workspace_role`, …) |
| `0003_brand_knowledge.sql` | brand profile, ICPs, services, offers + versions, claims, evidence, case studies, testimonials, FAQs, guardrails, knowledge documents and embeddings |
| `0004_campaigns.sql` | `campaigns`, `campaign_versions`, `campaign_proposals`, `angles`, `angle_versions`, `campaign_angles`, `approvals` |
| `0005_creatives.sql` | `creative_concepts`, `creative_assets`, `creative_versions`, `creative_renditions` |
| `0006_funnels.sql` | `consent_versions`, `funnels`, `funnel_versions`, `form_definitions`, `form_versions`, `published_funnels` |
| `0007_experiments.sql` | `experiments`, `experiment_arms`, `experiment_assignments`, `experiment_exposures`, `experiment_results` |
| `0008_tracking_leads.sql` | `visitors`, `sessions`, `touchpoints`, `events`, `form_instances`, `form_submissions`, `submission_answers_non_pii`, `submission_pii_encrypted`, `submission_status_history`, `attribution_snapshots`, `leads`, `lead_stage_events`, `opportunities`, `revenue_events` |
| `0009_meta.sql` | `meta_accounts`, `meta_campaigns`, `meta_adsets`, `meta_ads`, `meta_creatives`, `meta_insights_daily`, `capi_dispatches` |
| `0010_hubspot.sql` | `hubspot_mappings`, `hubspot_objects`, `hubspot_sync_attempts`, `hubspot_stage_history` |
| `0011_system.sql` | integrations, sync plumbing, raw payloads, prompt versions, AI jobs, external commands, recommendations, learning cards, `outbox_events`, webhooks, `audit_logs`, `workspace_settings` |
| `0012_rls.sql` | privileges (`anon` is stripped to one SELECT) and row level security on every table |
| `0013_functions.sql` | the runtime RPC surface, including `submit_lead_transactional` and `claim_outbox_events` |
| `0014_storage.sql` | the five storage buckets and their policies |
| `0015_rollups.sql` | `performance_rollups` + `rollup_days_needing_recompute()` |
| `0016_jobs_and_outbox.sql` | `job_locks` + its two RPCs, and `claim_outbox_events` across destinations |

Dependencies run strictly downward, so the numeric order is also the only valid
order. Two forward references are resolved with a later `alter table … add
constraint` rather than by reordering the files (`campaigns.current_version_id`,
`published_funnels.experiment_id` and friends) — the tables they point at are
defined after the referencing table for readability.

## Applying them

Against a local Supabase instance:

```bash
supabase db reset            # drops, re-creates, applies migrations/ then seed/
```

Against any Postgres by URL (CI, a scratch container, a staging database):

```bash
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/seed.sql   # optional
```

The files are idempotent at the extension/role/bucket level but **not** at the
table level: they are `create table`, not `create table if not exists`, because a
silently skipped table is far worse than a loud failure. Apply them to a fresh
database, or add a new numbered file.

Integration tests (`supabase/tests/*.test.ts`) create their own scratch database,
apply `scripts/local-pg-bootstrap.sql` (the Supabase shim: `auth.uid()`, the
`anon`/`authenticated`/`service_role` roles, `storage.buckets`) and then every
migration, and drop it again. They skip cleanly when `DATABASE_URL` is unset:

```bash
DATABASE_URL="postgresql://postgres@127.0.0.1:5433/postgres" \
  npx vitest run --project integration supabase
```

The shim's grants matter: it hands `anon` and `authenticated` the same table
privileges Supabase does, so an RLS test fails for the right reason — a policy —
rather than passing because of a missing GRANT.

## Things worth knowing before you edit

**Enum-ish columns are `text` + `CHECK`.** Every list mirrors an array in
`packages/domain/src/enums.ts` and carries a comment saying so. Extending an enum
is then an `alter table … drop constraint … add constraint`, not a
`pg_enum` migration that cannot run inside a transaction.

**Immutability is a trigger, not a convention.**
`app.enforce_version_immutability(guard_column, frozen_values[, allowed_columns])`
is attached to `campaign_versions`, `angle_versions`, `offer_versions`,
`creative_versions`, `funnel_versions`, `form_versions`, `prompt_versions`,
`hubspot_mappings` and `attribution_snapshots`. It raises `SQLSTATE AM001`.
`experiment_arms` uses `app.enforce_experiment_arm_immutability()`, which reads
the *parent* experiment's state. A published row may still move to `ARCHIVED`
and may still have `updated_at` / `updated_by` / `archived_at` touched —
everything else is refused.

**`outbox_events.dataset_id` is `not null default ''`.** The dedup constraint is
`UNIQUE (destination, dataset_id, event_id)`; with a nullable column, NULLs
compare as distinct and HubSpot rows would silently stop deduplicating.

**pgvector and 1536 dimensions.** `text-embedding-3-large` returns 3072
dimensions natively, and pgvector's `hnsw`/`ivfflat` opclasses stop at 2000 — a
3072-dimension column simply cannot be indexed. The model supports native
dimension reduction through the `dimensions` request parameter, so the embedding
column is `vector(1536)` with a plain HNSW `vector_cosine_ops` index. That is a
documented model capability, not a truncation we invented, and it makes
similarity search actually indexed rather than a sequential scan. On a Postgres
without pgvector the column is created as `real[]`, `app.schema_capabilities`
records `pgvector = false` and `embedding_ann_index = false`, and `@am/db`
degrades honestly instead of returning wrong neighbours.

**A new table must re-assert the anon revoke.** Supabase's `alter default
privileges` grants `anon` SELECT on new tables in `public`. `0012` revokes that
for everything that existed at the time; any table added in a later migration has
to `revoke all … from anon` itself (see `0015`) or it is quietly world-readable.
`supabase/tests/schema.test.ts` asserts the invariant globally, which is how that
gap was found.

**Rollups are production-only.** `performance_rollups.traffic_scope` is fixed at
`'PRODUCTION'` by a CHECK constraint. Excluding preview, internal, bot and test
traffic happens where the counters are derived; the constraint means a row can
never *claim* a scope it does not have.

**Job locks are rows, not advisory locks.** `pg_advisory_lock` releases itself
when the session drops, which suits a crashed serverless invocation — but
PostgREST pools connections, so the holding session is not the invocation, and an
advisory lock is invisible to the operator. `job_locks` carries an explicit TTL
instead: same crash recovery, survives pooling, visible in the console.

**Anon can read exactly one thing.** `0012` revokes every privilege from `anon`
and grants back a single `SELECT` on `published_funnels`, narrowed further by the
`published_funnels_public_read` policy to live production rows. Leads,
submissions and PII are unreachable for the public key at the *privilege* level,
before RLS is even consulted. The funnel runtime writes exclusively through the
six `SECURITY DEFINER` functions in `0013`, none of which accept a caller-supplied
`workspace_id`.

**`force row level security` is on.** That makes policies apply to the table
owner too, so an RLS test is meaningful when it runs as the migration role. A
superuser or a `BYPASSRLS` role (Supabase's `postgres`, our `service_role`) still
bypasses it — which is exactly how the seed and the background jobs work.
