# Readiness checklist

What is built, what is verified, and exactly what is still needed from outside
before this can go live.

## What is missing, and what it blocks

Nothing in this list blocks development, demo acceptance, or the paused-draft
workflow against fixtures. Each one blocks only the live step it names.

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
- Both Next apps build.
- Typecheck, lint (zero warnings) and the full test suite pass.

## Verified by test, per acceptance criterion

| # | Criterion | Where |
| --- | --- | --- |
| 3 | launch blocked below five distinct creatives | `@am/ai` diversity, Campaign Room |
| 4 | `MULTI_STEP_FORM` is its own versioned funnel type | `@am/funnel-schema` |
| 6 | published forms cannot be mutated | database trigger + repository |
| 7 | answers survive back navigation | funnel runtime |
| 8 | no horizontal scroll at 320/375/430 px | funnel runtime + E2E |
| 9 | validation errors are focusable and announced | `@am/ui` `FormFieldRow` |
| 10 | duplicate submits produce exactly one submission | `UNIQUE (submission_attempt_id)` |
| 11 | a visitor keeps the same arm | `@am/tracking` assignment |
| 12 | one exposure per actual render | `UNIQUE (experiment, visitor, session)` |
| 13 | running arms are immutable | trigger on `experiment_arms` |
| 14 | simultaneous creative + funnel change is flagged bundled | `@am/experiments` |
| 15 | no winner below minimum volume | `@am/experiments` `evaluateExperiment` |
| 19 | every rate shows numerator and denominator | `@am/domain` `Rate`, `MetricTile` |
| 20 | data maturity and CRM delay are visible | `MetricTile`, dashboards |
| 22 | pause and scale require confirmation | `ConfirmDialog` + command lifecycle |
| 23 | Meta success only after provider confirmation | `@am/meta` commands |
| 24 | role limits block unauthorised increases | `evaluateBudgetChange` |
| 25 | changes invalidate approvals | content-hash approvals |
| 29 | no form PII in analytics, URLs or logs | `assertNoPii`, `redact` |
| 30 | HubSpot outages lose no leads | transactional outbox |
| 31 | pixel + CAPI produce one conversion | shared `event_id` |
| 32 | VQ events only on real transitions | `toCanonicalEvents` |
| 33 | re-imports create no duplicates | `UNIQUE (provider, external_id)` |
| 34 | closed won processed exactly once | once-per-opportunity `CONVERTED` |
| 35 | preview/bot/test traffic excluded | `traffic_kind` + rollup filter |

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
