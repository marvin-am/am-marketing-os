# Data model

Supabase Postgres. The SQL in `supabase/migrations/` is the specification; this
document explains the shape and the constraints that carry business meaning.

**79 tables, RLS enabled on all 79, 97 policies, 77 triggers, 305 indexes.**
Verified by applying every migration to a clean Postgres 16 + pgvector instance
(see `scripts/local-pg-bootstrap.sql`).

## Global invariants

- UUID primary keys via `gen_random_uuid()`.
- Every timestamp is `timestamptz`, stored in UTC.
- Every mirrored external record carries `UNIQUE (provider, external_id)`.
- Published versions are immutable, enforced by triggers rather than
  application discipline.
- `text` + `CHECK` for enum-like columns, with the allowed values mirroring the
  arrays in `packages/domain/src/enums.ts`. Cheaper to extend than a PG enum and
  it keeps one source of truth for the values.
- `jsonb` only for validated specs, provider payloads and genuinely flexible
  metadata — never as a way to avoid designing a column.
- Audit columns `created_by` / `updated_by` on mutable business tables.
- RLS on every non-public table, keyed on workspace membership.

## Table groups

**Organisation and access** — `workspaces`, `profiles`, `workspace_members`,
`role_limits`, `workspace_settings`

**Brand knowledge** — `brand_profiles`, `audience_segments`, `services`,
`offers`, `offer_versions`, `claims`, `evidence_items`, `case_studies`,
`testimonials`, `faqs`, `guardrails`, `knowledge_documents`,
`knowledge_embeddings`

**Campaigns** — `campaigns`, `campaign_versions`, `campaign_proposals`,
`angles`, `angle_versions`, `campaign_angles`, `approvals`

**Creatives** — `creative_concepts`, `creative_assets`, `creative_versions`,
`creative_renditions`

**Funnel** — `funnels`, `funnel_versions`, `form_definitions`, `form_versions`,
`published_funnels`

**Experiments** — `experiments`, `experiment_arms`, `experiment_assignments`,
`experiment_exposures`, `experiment_results`

**Tracking and leads** — `visitors`, `sessions`, `touchpoints`, `events`,
`form_instances`, `form_submissions`, `submission_answers_non_pii`,
`submission_pii_encrypted`, `submission_status_history`, `leads`,
`lead_stage_events`, `attribution_snapshots`, `opportunities`, `revenue_events`,
`consent_versions`

**Meta** — `meta_accounts`, `meta_campaigns`, `meta_adsets`, `meta_ads`,
`meta_creatives`, `meta_insights_daily`, `capi_dispatches`

**HubSpot** — `hubspot_mappings`, `hubspot_objects`, `hubspot_sync_attempts`,
`hubspot_stage_history`

**System** — `integration_connections`, `integration_health_checks`,
`external_commands`, `sync_cursors`, `sync_jobs`, `raw_external_objects`,
`ai_jobs`, `prompt_versions`, `recommendations`, `recommendation_actions`,
`learning_cards`, `outbox_events`, `webhook_events`, `audit_logs`

## The constraints that matter

### Idempotency

Three unique constraints do most of the reliability work:

```sql
form_submissions  UNIQUE (submission_attempt_id)
outbox_events     UNIQUE (destination, dataset_id, event_id)
meta_*/hubspot_*  UNIQUE (provider, external_id)
```

The first makes a double-click, a flaky-network retry and ten concurrent
submits collapse into exactly one submission — at the database, not in a
race-prone application check. The second makes a CAPI or CRM dispatch
deliverable at-least-once while being observed exactly-once. The third makes a
repeated historical import a no-op instead of a duplication event.

Experiment stability has its own pair:

```sql
experiment_assignments UNIQUE (experiment_id, visitor_id)
experiment_exposures   UNIQUE (experiment_id, visitor_id, session_id)
```

Assignment is per visitor and permanent; exposure is per session and counted
once per actual render.

### Immutability

A reusable trigger function guards every table whose rows become historical
evidence:

`angle_versions` · `campaign_versions` · `creative_versions` · `form_versions` ·
`funnel_versions` · `offer_versions` · `prompt_versions` · `experiment_arms` ·
`attribution_snapshots` · `hubspot_mappings` · `published_funnels`

An `UPDATE` or `DELETE` on a published row raises:

```
Veröffentlichte Version ist unveränderlich. Geänderte Spalten: notes.
HINT: Legen Sie eine neue Version an, statt die veröffentlichte zu verändern.
```

`experiment_arms` has its own variant that freezes arms while the experiment is
`RUNNING` — changing an allocation mid-test silently invalidates the result, and
that is exactly the kind of mistake nobody notices until the decision has
already been made.

### PII separation

Submission answers are split across two tables by data class:

- `submission_answers_non_pii` — qualification and operational answers. A CHECK
  constraint on `field_type` **structurally excludes** `EMAIL`, `PHONE`,
  `FIRST_NAME` and `LAST_NAME`, so a mapping bug cannot write personal data into
  the analytics-joinable table. It fails at insert.
- `submission_pii_encrypted` — AES-256-GCM ciphertext plus `key_version`. Never
  joined into analytics, never logged.

`events` and `touchpoints` have no PII columns at all. The guard is the absence
of a place to put it.

### Attribution

`attribution_snapshots` is insert-only. It stores the internal ids of the
versions actually delivered, the Meta ids, first/last/acquisition touches, click
ids, UTMs, referrer, landing URL, confidence, consent status and the window that
was in force. Everything downstream reads the snapshot; nothing re-derives
attribution later.

`opportunities.acquisition_submission_id` and `acquisition_snapshot_id` bind an
opportunity to the submission that acquired it, permanently. Later touches
append to `touchpoints`; they never rewrite this binding.

## Transactional outbox

The reliability spine. The business write and its outbox rows land in one
transaction, via a SQL function so the atomicity cannot be lost at a service
boundary:

```
BEGIN
  form_submissions            ← UNIQUE (submission_attempt_id)
  submission_status_history
  attribution_snapshots       ← immutable
  outbox_events (HubSpot)     ← UNIQUE (destination, dataset_id, event_id)
  outbox_events (Meta CAPI)
COMMIT
```

`outbox_events` carries `status`, `attempt_count`, `next_attempt_at`,
`last_error`, `provider_response_redacted`, `sent_at`. Claiming uses
`FOR UPDATE SKIP LOCKED` so concurrent pump invocations do not contend, and
delivery backs off exponentially into a dead-letter state that surfaces in the
console with a manual retry.

## Embeddings

`knowledge_embeddings` stores pgvector embeddings of angles, offers, campaigns
and knowledge documents, with metadata columns for filtering by recency, angle
and offer.

Similarity search backs two features: showing the most similar historical
campaigns before a new angle is approved, and the angle-distinctness verdict
(`DISTINCT` / `ITERATION` / `TOO_SIMILAR`).

Embeddings are stored at **1536 dimensions**. `text-embedding-3-large` natively
supports dimension reduction through the `dimensions` parameter, and 1536 keeps
the column inside pgvector's 2000-dimension indexing limit so an HNSW index with
`vector_cosine_ops` is possible. At full 3072 dimensions the column would be
storable but not indexable, which for a similarity search is the same as not
having it.

## Row Level Security

Every non-public table is protected, keyed on workspace membership through an
`auth.uid()`-based helper.

The `anon` role — used by the public funnel runtime — can read
`published_funnels` and nothing else. It cannot reach leads, submissions, PII,
CRM state, campaign strategy or audit logs. Public writes go through narrow
server endpoints and `SECURITY DEFINER` functions, never direct table access
from a browser.

The service role bypasses RLS and is server-only; `getServerEnv()` throws if the
key is read in a browser context.

## Storage buckets

| Bucket | Public | Contents |
| --- | --- | --- |
| `brand-assets` | yes | logos, brand imagery used in rendered creatives |
| `creative-renditions` | yes | final rendered ad images served to Meta |
| `creative-source` | no | base motifs from the image model |
| `historical-creatives` | no | creative files copied from Meta before their URLs expire |
| `private-imports` | no | raw provider payloads |

Historical Meta creative URLs expire. Copying the files into our own bucket at
import time is what keeps the creative library from decaying into broken images.

## Applying and verifying

```bash
DATABASE_URL="postgresql://..." pnpm db:migrate   # checksum-verified, idempotent
DATABASE_URL="postgresql://..." pnpm db:seed      # deterministic demo data
```

`db:migrate` refuses to run if an already-applied migration file was edited.
Migrations are immutable; a correction is a new file.

Locally, without Supabase:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -c "CREATE DATABASE am_test;"
psql -h 127.0.0.1 -p 5433 -U postgres -d am_test -f scripts/local-pg-bootstrap.sql
DATABASE_URL="postgresql://postgres@127.0.0.1:5433/am_test" pnpm db:migrate
```

The bootstrap file recreates just enough of Supabase (`auth`, `storage`, the API
roles, `auth.uid()` reading a JWT claim) that the real migrations apply and RLS
policies can be exercised by switching roles.
