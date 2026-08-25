# Deployment

Two Vercel projects out of one monorepo.

| Project | Root directory | Domain | Access |
| --- | --- | --- | --- |
| `am-marketing-os` | `apps/console` | `marketing.am-beratung.de` | authenticated only |
| `am-funnel-runtime` | `apps/funnels` | `go.am-beratung.de` | public |

Both are configured by the `vercel.json` in their app directory. Build and
install commands run from the repo root so Turborepo can reuse its cache:

```json
"buildCommand":   "cd ../.. && pnpm turbo run build --filter=@am/console",
"installCommand": "cd ../.. && pnpm install --frozen-lockfile"
```

Region is `fra1` for both — the audience, the ad account and the CRM are all in
Europe, and the funnel runtime's latency is on the critical path of a mobile ad
click.

## Environments

Three, with strictly separated data:

| Environment | Supabase project | Flags |
| --- | --- | --- |
| Development | local or a dev project | `DEMO_MODE=true`, all writes off |
| Preview | **preview** project | `DEMO_MODE=false` once credentials exist, writes still off |
| Production | production project | writes enabled only after explicit sign-off |

A preview deployment must never point at the production Supabase project. The
`environment` and `traffic_kind` columns keep preview traffic out of production
metrics even if it happened, but the separation is the actual control.

## Environment variables

The complete, commented list is [`.env.example`](../.env.example). Set them in
Vercel per environment.

Only these four reach the browser and may carry the `NEXT_PUBLIC_` prefix:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_CONSOLE_URL
NEXT_PUBLIC_FUNNEL_URL
```

`SUPABASE_SERVICE_ROLE_KEY`, `APP_ENCRYPTION_KEY`, `TRACKING_SIGNING_SECRET`,
`CRON_SECRET` and every provider secret are **server-only**. Generate the two
application secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # APP_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # TRACKING_SIGNING_SECRET
```

`APP_ENCRYPTION_KEY` encrypts stored PII and provider tokens. Losing it means
losing access to that data; rotating it requires a re-encryption pass, which the
`key_version` column supports.

## Scheduled jobs

Defined in `apps/console/vercel.json`. Every handler requires the `CRON_SECRET`
bearer token, so the endpoints are not publicly triggerable.

| Schedule | Path | Purpose |
| --- | --- | --- |
| `*/5 * * * *` | `/api/cron/outbox-dispatch` | deliver pending outbox events |
| `7 * * * *` | `/api/cron/meta-insights` | hourly insights for live campaigns |
| `20 3 * * *` | `/api/cron/meta-backfill` | daily backfill for late attribution |
| `35 * * * *` | `/api/cron/hubspot-reconcile` | hourly CRM reconciliation |
| `50 4 * * *` | `/api/cron/hubspot-reconcile-deep` | daily deep reconciliation |
| `*/15 * * * *` | `/api/cron/derive-abandoned-forms` | derive `form_abandoned` |
| `10 2 * * *` | `/api/cron/performance-rollups` | daily rollups |
| `40 5 * * *` | `/api/cron/learning-cards` | learning cards for concluded tests |
| `25 6 * * *` | `/api/cron/recommendations` | regenerate recommendations |
| `0 */6 * * *` | `/api/cron/integration-health` | refresh provider health |

Minutes are deliberately offset rather than all on the hour, so an insights sync
and a reconciliation pass do not contend for the same rate-limit budget.

HubSpot webhooks deliver near-real-time changes; reconciliation is the safety
net that catches what a missed webhook would otherwise lose.

## Database

```bash
DATABASE_URL="postgresql://..." pnpm db:migrate   # idempotent, checksum-verified
DATABASE_URL="postgresql://..." pnpm db:seed      # demo data, safe to re-run
```

`db:migrate` records every applied file with its checksum in `_am_migrations` and
**refuses to run if an already-applied migration was edited** — migrations are
immutable; a change means a new file.

After migrating, verify in the Supabase dashboard:

- RLS is enabled on every non-public table,
- the five storage buckets exist with the right public/private flags,
- the `anon` role can read `published_funnels` and nothing else.

## Activation sequence

The product is complete and runs on fixtures. Turning on the real world is a
deliberate, ordered sequence — and external writes stay off until the last step.

1. **Supabase** — create the project, set the URL and both keys, run
   `pnpm db:migrate`, verify buckets and RLS.
2. **OpenAI** — set `OPENAI_API_KEY`; confirm the health check passes. Set
   `DEMO_MODE=false` to leave fixtures.
3. **Meta read** — set the app id/secret, access token, ad account, page,
   Instagram actor, pixel and dataset. Run the setup wizard through the
   permission check and the insights read test. Import history.
4. **HubSpot read** — set the credentials. Run the mapping wizard: load objects
   and properties, define the contact identifier, the company rule, the
   pipeline, the deal-creation trigger, the stage→canonical-event mapping, the
   revenue property, the lost/no-show rules and the acquisition fields.
5. **Import the real mapping** and publish it (version 1).
6. **Test lead** — send it, verify the contact, the deal and the contact↔deal
   association. This is a hard live-launch gate.
7. **Meta paused draft** — create one against the real account and confirm every
   object is `PAUSED`.
8. **Pixel / CAPI test** — verify browser and server events deduplicate on a
   shared `event_id` in Events Manager.
9. **Deploy preview** and run `pnpm test:e2e` against it.
10. **Deploy production.**
11. **Enable external writes** — only on explicit sign-off, and one flag at a
    time: `EXTERNAL_WRITES_ENABLED`, then `META_MUTATIONS_ENABLED`, then
    `META_CAPI_ENABLED`, then `HUBSPOT_WRITES_ENABLED`.

Until step 11, every mutating call returns a dry-run description and performs no
external write. That is the intended state, not a limitation.

## Kill switches

Any of these can be flipped in Vercel's environment settings and take effect on
the next request — no deploy needed:

```
EXTERNAL_WRITES_ENABLED=false   # stops every external write, everywhere
META_MUTATIONS_ENABLED=false    # stops Meta drafts, pauses, budget changes
META_CAPI_ENABLED=false         # stops conversion dispatch
HUBSPOT_WRITES_ENABLED=false    # stops CRM writes
DEMO_MODE=true                  # routes everything back to fixtures
```

Turning a flag off does not lose data. Outbox events keep accumulating in
`PENDING` and deliver once the flag is restored.

## Rollback

**Application** — Vercel's instant rollback to the previous deployment. Both
projects roll back independently; the console and the funnel runtime share only
the database contract, so a console rollback does not require a funnel rollback.

**Database** — migrations are forward-only. A bad migration is corrected by a
new migration, never by editing the applied file. Take a Supabase point-in-time
snapshot before any migration that drops or rewrites a column.

**Published funnels** — a published funnel version is immutable, so a rollback
is republishing the previous version. Live traffic switches at the next request;
in-flight form instances continue on the version they started with, which is why
`form_version_id` is stamped on the instance rather than looked up.

**Provider actions** — every external command is reversible through its inverse
command (pause ↔ resume, budget up ↔ budget down) and each is recorded with its
idempotency key, so replaying a rollback is safe.
