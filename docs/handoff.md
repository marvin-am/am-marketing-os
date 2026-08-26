# Handover — where this stands and what happens next

Written at the end of the session that built the product, for whoever picks it
up. It is a snapshot: the state below was true at commit `4da4c7d`. Anything
that contradicts the code is wrong, and the code wins.

Read [`AGENTS.md`](../AGENTS.md) first — it is the working agreement and it
still holds. This file is only *where things got to*.

---

## Do this first

Nothing here needs a decision. It needs a database.

```bash
# 1. Are the provider hosts reachable from this session?
#    Anything other than a real HTTP status means the egress allowlist did not
#    reach this container — see "If the hosts are still blocked" below.
for h in api.openai.com graph.facebook.com api.hubapi.com \
         mwzbsrmddfkwyudkqeyw.supabase.co; do
  printf '%-36s ' "$h"
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 15 "https://$h/"
done

# 2. Apply the 18 migrations to the real Supabase project.
pnpm db:migrate            # reads DATABASE_URL; idempotent, records in _am_migrations

# 3. Verify against the real database rather than assuming.
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration
```

Step 3 is the one that matters. `supabase/tests/privileges.test.ts` re-runs
every attack that worked against the schema before it was hardened; if those
pass against the real project, the privilege boundary is real there too.

Then, and only then, `DEMO_MODE=false`. Switching before the migrations land
points every screen at an empty database, which looks like a broken product and
is not one.

### If the hosts are still blocked

The reply carries `x-deny-reason: host_not_allowed`. That is the environment's
egress allowlist, set outside the container and copied in at startup — a
session started before the setting changed never sees it. A new session picks
it up. Do not route around it.

---

## What is actually finished

Verified by clicking it or by attacking it, not by a passing test:

- **The funnel runtime.** Multi-step form with branching, 320 px, keyboard,
  honeypot, idempotency, no personal data on the wire or in a log. This is the
  part of the product the public touches and it is production-ready.
- **The database.** 18 migrations, 81 tables, RLS on every one. The privilege
  boundary was attacked with the published anon key and closed: reading every
  pending lead's contact data out of the outbox, booking a fabricated
  closed-won, inventing Meta spend, holding the dispatcher's lock for a day. A
  VIEWER could rewrite the budget-authority matrix and publish a live funnel
  binding pointing anywhere. All reproduced, all closed, all re-run as tests.
- **The data layer.** All three surfaces select once, in a factory, from
  `resolveDatabase()`. Each port has a contract suite that runs against the
  fixture *and* against real Postgres, so "wired up" means the behaviour is the
  same, not that it compiles.
- **The honesty discipline.** No invented connection, no green success over an
  action that did not run, no dry run rendered as a result.

Current state: 31/31 typecheck tasks, 2339 tests passing, lint clean, both apps
build, 50 commits on `claude/am-marketing-os-dev-jkp1ou`.

---

## What is not finished

### Needs a migration — do not paper over these in application code

1. **The HubSpot mapping document has no column.** `hubspot_mappings` stores
   `field_map`, `stage_map`, `pipeline_id` and the version chain. The wizard's
   document also describes deal creation, stage events, revenue, VQ,
   acquisition and webhooks. The publish path therefore *refuses* rather than
   accepting a change that would vanish on reload, and the job runtime's read
   returns null and says why. Until the column exists, a live database has no
   published mapping by construction and the launch gate stays closed. That is
   correct, and it is also a blocker for going live.
2. **`submit_lead_transactional` takes one outbox row, not an array.** The
   funnel queues two (HubSpot + Meta CAPI). The HubSpot row is inside the
   transaction — it is the lead, and "an outage never loses a lead" needs it —
   and the CAPI row is enqueued one statement later. A crash in that window
   loses the CAPI event, not the lead.
3. **`form_instances` has no unique index** over (visitor, session,
   form_version). Idempotency is a read-then-insert, so two genuinely
   simultaneous renders of one page can fork the instance and double every
   step-level metric.

### Reachable but not wired

- **No pause/resume/complete control.** `pauseCampaign` is imported by no UI
  file, so acceptance criterion 22 cannot be exercised from any screen.
- **No way to create a campaign.** The product's headline promise — idea to
  paused Meta draft — has no entry point.
- **`loadToday` and `loadLibrary`** are the two live methods with the largest
  gap between what the screen wants and what the repositories return. One
  assertion each. Not production-ready.

### Where the schema cannot answer

These return null or an explicit "not known" rather than a plausible number.
Leave them that way unless you add the storage:

`claims`, `angles`/`angle_versions` and `profiles` have no repository (so an
approver renders as null, never a uuid); rollups keep no tally of the traffic
they excluded; six launch checks have no table recording an outcome; a
`DryRunResult` is never persisted; storage signing is not exposed, so a
rendition preview URL is null.

---

## Things that will bite you

**Two workspace ids exist.** The console pins
`00000000-0000-4000-8000-000000000001`; `supabase/seed/seed.sql` creates the
workspace as `0a11b0a1-0000-4000-8000-000000000001` under the slug `am`.
`workspaceResolver` in `apps/console/src/server/workspace.ts` resolves by slug
with the constant as the fallback for an unseeded database. If you add a fourth
hard-coded id you will spend an afternoon on empty dashboards: the id is a
foreign key, every rollup insert violates it, and the job reports the rows it
tried to write.

**A green suite is not a working screen.** The suite exercises packages and
fixture ports. It was green while `/einstellungen` returned a 500 on every
request, while a live campaign's budget change reported success without
producing a Meta command, and while the audit log recorded nothing. Where
[`readiness.md`](./readiness.md) says "exercised in the product", a person
clicked it. Keep that distinction when you add rows.

**The PostgREST shim is not PostgREST.** `apps/console/integration/fixtures/postgrest-over-pg.ts`
translates builder calls into SQL over `pg`, because a scratch database has no
PostgREST in front of it. The repositories, the schema, its constraints, its
triggers and its policies are real; the transport is not. Two fidelity traps
were already found and fixed (`bigint`/`numeric` arrive as strings where
PostgREST sends JSON numbers; `date`/`timestamptz` as objects where it sends ISO
strings). Assume more remain. Nothing has been tested against real PostgREST.

**Ten acceptance criteria cannot be graded** because their text is not in this
repository — it exists only in the original specification. They appear in
`readiness.md` by number with no claim attached. Whoever holds the spec should
paste the text in.

---

## The activation sequence

Ordered, external writes staying off until the last step. Full detail in
[`deployment.md`](./deployment.md).

1. Supabase migrations → verify RLS, buckets, and `privileges.test.ts`
2. `DEMO_MODE=false` → confirm the screens read the real database
3. OpenAI health check
4. Meta setup wizard through the insights read test → import history
5. HubSpot mapping wizard — blocked on gap 1 above
6. Test lead → verify contact, deal and association. **Hard live gate.**
7. Paused Meta draft against the real account, every object `PAUSED`
8. Pixel/CAPI deduplication verified in Events Manager
9. Preview deploy → run the E2E suite against it
10. Production deploy
11. Enable external writes on explicit sign-off, one flag at a time

Step 8 deserves attention: the shared event id is seeded from the submission
*attempt*, not from the stored row id. Seeding it from the row was a real defect
— the database mints its own id, so the pixel and the queued server event went
out under different ids and Meta counted every lead twice. It does not fail; it
just counts wrong. Verify it in Events Manager rather than trusting the test.

---

## Credentials

`.env.local` is gitignored and lives only in the container that created it.
Put the values in the environment's own variable settings so a new session
inherits them.

`APP_ENCRYPTION_KEY`, `TRACKING_SIGNING_SECRET` and `CRON_SECRET` were generated
during the build session and exist nowhere else. `APP_ENCRYPTION_KEY` is what
decrypts stored lead contact data — lose it after the first real lead and that
data is unreadable.

Never invent a credential, an external id, a pipeline id or a connection state.
Where a value is unknown the product says `WARTET AUF EXTERNEN INPUT`, and that
is a first-class status, not a placeholder to fill in.
