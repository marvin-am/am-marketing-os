# Readiness checklist

What is built, what is verified, and exactly what is still needed before this
can go live.

## Two gaps, not one

An earlier version of this document listed only the first of these, which made
the remaining distance look like a matter of pasting credentials into Vercel. It
is not, and the difference matters when planning:

1. **External input** — credentials, ids and the HubSpot mapping. Listed below.
   These are genuinely outside our control.
2. **Wiring** — several console surfaces read a fixture port unconditionally,
   with no branch on `DEMO_MODE` and no live implementation behind them
   (`getCampaignPort()`, `getOpsPort()`, the analytics pages' inline
   `createAnalyticsFixturePort()`, and `apps/funnels/src/server/store.ts`, whose
   own comment still says "when `@am/db` is wired in"). `@am/ai` and
   `@am/creative-renderer` are declared dependencies of the console and imported
   by no file under `apps/console/src`.

The consequence is worth stating plainly rather than leaving to be discovered:
**supplying every credential tomorrow would not change what those screens do.**
The remaining work there is ours. The funnel runtime, the job runner and the
database are wired; the Campaign Room, the analytics dashboards and the ops
screens are not.

A green test suite does not contradict this. The suite exercises the packages
and the fixture ports thoroughly, which is why it stayed green while
`/einstellungen` returned a 500 on every request.

## What is missing from outside, and what it blocks

Each one blocks only the live step it names.

| Needed from outside | Blocks | Where it goes |
| --- | --- | --- |
| Supabase project URL, anon key, service role key, `DATABASE_URL` | persistence beyond the in-memory demo store | `.env.local` / Vercel env |
| `APP_ENCRYPTION_KEY`, `TRACKING_SIGNING_SECRET`, `CRON_SECRET` | encrypted PII and tokens, signed launch tokens, cron auth | same |
| `OPENAI_API_KEY` | live generation (fixtures otherwise) | same |
| Meta app id/secret, access token, ad account, page, Instagram actor, pixel, dataset | Meta import, paused drafts, CAPI | Meta setup wizard |
| HubSpot credentials (OAuth pair or private app token) + webhook secret | CRM sync | HubSpot mapping wizard |
| **HubSpot property, VQ, pipeline and deal-stage mapping** | the mapping wizard's final publish, and the live-launch gate | HubSpot mapping wizard, steps 3–10 |
| Vercel projects and the two domains | deployment | Vercel |

**No credential, external id, pipeline id or "connected" state has been invented
anywhere in this codebase.** Where a value is unknown, the product says
`WARTET AUF EXTERNEN INPUT`.

## Verified in this environment

- All migrations apply cleanly to Postgres 16 + pgvector: **81 tables, RLS
  enabled on every one**, unique constraints on external ids, on
  `submission_attempt_id` and on the outbox dedup key.
- Immutability triggers were exercised directly: an `UPDATE` on a published
  version is rejected with a German message naming the changed columns.
- The privilege boundary was attacked, not assumed: with the public anon key,
  every function in `public` was executable — enough to read every pending
  lead's contact data out of the outbox, book a fabricated closed-won, and hold
  the dispatcher's lock for a day. `0017_harden_privileges.sql` closes it and
  `supabase/tests/privileges.test.ts` re-runs each of those attacks and asserts
  they now fail.
- Both Next apps build.
- Typecheck, lint (zero warnings) and the full test suite pass.

What that last line does **not** mean, since it is the sentence most likely to
be over-read: the suite exercises the packages and the fixture ports. It does
not open a page. It was green while `/einstellungen` returned a 500 on every
request, and green while a live campaign's budget change reported success
without producing a Meta command. Where a criterion above says "exercised in the
product", a person clicked it.

## Acceptance criteria

Two things about how this table is graded, because the earlier version of it
conflated them and that made the product look further along than it was.

**A passing package test is not the same as a criterion being met.** The
criteria are written about what the operator can do, so a guarantee that holds
in `@am/experiments` but cannot be reached from any screen is recorded here as
reached-in-code-only, not as met. Four criteria are in that state purely because
the surface that would exercise them reads a fixture port (see "Two gaps"
above), and two more because they need a database or a provider this deployment
does not have.

**Ten criteria cannot be graded from this repository at all.** Their text exists
only in the original specification, which is not checked in — they appear below
by number with no claim attached. That is itself a finding: a readiness document
nobody outside the original conversation can audit is not much of a control.
Whoever holds the specification should paste the missing text into this table.

| # | Criterion | Status | Where |
| --- | --- | --- | --- |
| 1 | *text not in this repository* | ungradeable | — |
| 2 | *text not in this repository* | ungradeable | — |
| 3 | launch blocked below five distinct creatives | met, exercised in the product | `@am/ai` diversity, Campaign Room, `guardedTransition` |
| 4 | `MULTI_STEP_FORM` is its own versioned funnel type | met, exercised in the product | `@am/funnel-schema`, form builder, funnel runtime |
| 5 | *text not in this repository* | ungradeable | — |
| 6 | published forms cannot be mutated | met in the product; trigger reached in code only | read-only builder + `form_versions` trigger |
| 7 | answers survive back navigation | met, exercised in the product | funnel runtime |
| 8 | no horizontal scroll at 320/375/430 px | met at 320 and 390 px, measured | funnel runtime + E2E |
| 9 | validation errors are focusable and announced | partial — text inputs correct, radio/checkbox groups put `aria-describedby` on the `<fieldset>` rather than the focused control | `@am/ui` `FormFieldRow` |
| 10 | duplicate submits produce exactly one submission | met, exercised in the product | `UNIQUE (submission_attempt_id)`, replayed payload returns the same id |
| 11 | a visitor keeps the same arm | met, exercised in the product | `@am/tracking` assignment |
| 12 | one exposure per actual render | reached in code only — the funnel runtime has no database | `UNIQUE (experiment, visitor, session)` |
| 13 | running arms are immutable | reached in code only — no UI edits arms | trigger on `experiment_arms` |
| 14 | simultaneous creative + funnel change is flagged bundled | met, exercised in the product | `@am/experiments` |
| 15 | no winner below minimum volume | met, exercised in the product | `@am/experiments` `evaluateExperiment` |
| 16 | *text not in this repository* | ungradeable | — |
| 17 | *text not in this repository* | ungradeable | — |
| 18 | *text not in this repository* | ungradeable | — |
| 19 | every rate shows numerator and denominator | partial — the zero-denominator `–` rule holds; money numerators render as raw minor units in the Campaign Room, the Heute board and the campaign table | `@am/domain` `Rate`, `MetricTile` |
| 20 | data maturity and CRM delay are visible | met, exercised in the product | `MetricTile`, dashboards |
| 21 | *text not in this repository* | ungradeable | — |
| 22 | pause and scale require confirmation | scale met; **pause has no control at all** — `pauseCampaign` is imported by no UI file | `ConfirmDialog` + command lifecycle |
| 23 | Meta success only after provider confirmation | met on the recommendation path; **not met** for "Pausierten Meta-Entwurf erstellen", which asserts a Meta-side draft with no confirmation and no dry run | `@am/meta` commands |
| 24 | role limits block unauthorised increases | met, exercised in the product | `evaluateBudgetChange`, re-checked server-side |
| 25 | changes invalidate approvals | met, exercised in the product | content-hash approvals |
| 26 | audit log records generations, approvals, state changes | met, exercised in the product | `/kampagnen/<id>/versionen` |
| 27 | *text not in this repository* | ungradeable | — |
| 28 | *text not in this repository* | ungradeable | — |
| 29 | no form PII in analytics, URLs or logs | met, exercised in the product | `assertNoPii`, `redact`, verified against real submitted contact data |
| 30 | HubSpot outages lose no leads | partial — the submit writes its outbox rows transactionally, but the dispatcher reads a different, empty in-memory queue | transactional outbox |
| 31 | pixel + CAPI produce one conversion | reached in code only — no provider in this deployment | shared `event_id` |
| 32 | VQ events only on real transitions | reached in code only — no CRM in this deployment | `toCanonicalEvents` |
| 33 | re-imports create no duplicates | reached in code only — no importer is reachable from the UI | `UNIQUE (provider, external_id)` |
| 34 | closed won processed exactly once | reached in code only | once-per-opportunity `CONVERTED` |
| 35 | preview/bot/test traffic excluded | met, exercised in the product | `traffic_kind` + rollup filter |
| 36 | *text not in this repository* | ungradeable | — |

Of the 26 gradeable criteria: 16 met in the product, 4 partial, 2 not met, 4
reachable in code only.

## Known limitations

**Provider documentation was unreachable from this build environment.** The
egress proxy refuses `CONNECT` to `developers.facebook.com`,
`developers.hubspot.com` and `developers.openai.com` with a 403. The adapters
are implemented against the API shapes the installed SDK types declare and
against shapes cross-checked through search, and every detail that could not be
confirmed against primary documentation is listed explicitly in
[`meta-integration.md`](./meta-integration.md) and
[`hubspot-mapping.md`](./hubspot-mapping.md).

Those should be confirmed against the live APIs during activation. None can
cause an incorrect write beforehand, because every external write is disabled by
default.

**Embeddings are stored at 1536 dimensions**, not the model's native 3072.
`text-embedding-3-large` supports the reduction natively, and 1536 keeps the
column inside pgvector's 2000-dimension indexing limit so similarity search can
actually use an index.

**Video creatives are out of scope for v1**, as specified. The domain model
carries a `MediaKind` so they can be added without a migration to the creative
tables.

## Activation sequence

Ordered, with external writes staying off until the final step. Full detail in
[`deployment.md`](./deployment.md).

1. Supabase project → migrate → verify RLS and buckets
2. OpenAI key → health check → `DEMO_MODE=false`
3. Meta credentials → setup wizard through the insights read test → import history
4. HubSpot credentials → mapping wizard
5. Publish the real mapping (version 1)
6. Test lead → verify contact, deal and association — **hard live gate**
7. Paused Meta draft against the real account, all objects `PAUSED`
8. Pixel/CAPI deduplication verified in Events Manager
9. Preview deploy → run the E2E suite against it
10. Production deploy
11. Enable external writes on explicit sign-off, one flag at a time

## Evidence that nothing was written externally

- `EXTERNAL_WRITES_ENABLED` defaults to `false` and gates every provider write;
  the three per-provider flags default to `false` beneath it.
- Tests assert that with the flags off, a mutating call returns a `DryRunResult`
  and the underlying `fetch` is never invoked.
- The browser can never enable a write: `getFeatureFlags()` returns
  `SAFE_DEFAULT_FLAGS` in a browser context.
- No provider credential exists in this environment, so no live call was
  possible; every provider ran through its fixture implementation, which reports
  `state: 'FIXTURE'` and never claims a connection.
- CI runs with all four flags explicitly `false`.
