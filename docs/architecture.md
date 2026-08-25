# Architecture

## What this system is

An internal operating system for A&M's own Meta performance marketing. One team
uses it to go from "we should test something" to a paused Meta draft, a live
campaign, measured leads, CRM outcomes, attributed revenue, and a decision about
what to do next — without a developer in the loop.

It is not a SaaS product and not multi-tenant in v1. The `workspaces` table
exists so that constraint is enforced in the schema rather than assumed, but
there is exactly one workspace in practice.

## Two deployables, one monorepo

| App | Root | Audience | Shape |
| --- | --- | --- | --- |
| `am-marketing-os` | `apps/console` | authenticated internal team | rich, server-rendered, data-heavy |
| `am-funnel-runtime` | `apps/funnels` | the public | tiny, fast, mobile-first |

They are separate Vercel projects on purpose. The funnel runtime must stay small
and fast (LCP target < 2.5 s on mobile) and must not carry the console's
dependency weight. It also has a different threat model: it takes untrusted
input from the open internet, so it gets the narrowest possible database
surface.

```
                    ┌──────────────────────────┐
   Meta ad click ──▶│  apps/funnels            │
                    │  go.am-beratung.de       │
                    │  · published spec render │
                    │  · /api/collect          │
                    │  · /api/submit           │
                    └────────────┬─────────────┘
                                 │ writes
                    ┌────────────▼─────────────┐
                    │  Supabase Postgres       │◀── operative truth
                    │  · RLS on every table    │
                    │  · transactional outbox  │
                    └────────────┬─────────────┘
                                 │ reads / jobs
      ┌──────────────────────────┼──────────────────────────┐
      │                          │                          │
┌─────▼──────┐          ┌────────▼────────┐        ┌────────▼────────┐
│ apps/      │          │ packages/jobs   │        │ packages/meta   │
│ console    │          │ · outbox pump   │───────▶│ · Marketing API │
│ marketing. │          │ · cron sync     │        │ · CAPI          │
│ am-        │          │ · reconcile     │        └─────────────────┘
│ beratung.de│          │ · rollups       │        ┌─────────────────┐
└────────────┘          └────────┬────────┘───────▶│ packages/hubspot│
                                 │                 └─────────────────┘
                                 └────────────────▶  OpenAI (packages/ai)
```

## Source of truth

The single most consequential decision in the system. Getting this wrong is how
marketing dashboards end up confidently reporting revenue that never existed.

| Domain | Truth | Why |
| --- | --- | --- |
| internal ids, versions, form instances, events, attribution, experiments, delivery, audit | **Supabase** | we control it, it is transactional, it is versioned |
| media spend and actual delivery | **Meta** | Meta bills it; our mirror is a cache |
| current CRM state, pipeline stage, booked deal value | **HubSpot** | sales works there; it changes without us |
| invoiced / paid revenue | a future billing integration | out of scope in v1, modelled so it can be added |

Meta pixel, PostHog and GA4 are **never** truth for lead status or revenue. They
see a browser; they do not see whether a deal closed.

Meta and HubSpot data is mirrored into Supabase (`meta_*`, `hubspot_*` tables)
so that dashboards never call a provider API during a page request. A dashboard
that fans out to the Graph API is both slow and rate-limit-fragile.

## Package graph

Dependencies flow strictly downward; there are no cycles.

```
domain ────────────────────────────────────────────────── (no workspace deps)
  ├── config ── observability
  │     └── db
  ├── funnel-schema
  ├── tracking
  ├── experiments ── recommendations
  ├── ai              (+ funnel-schema)
  ├── creative-renderer
  ├── meta
  ├── hubspot
  ├── ui
  └── jobs            (db + meta + hubspot + experiments + recommendations)
```

`@am/domain` holds every enum, Zod schema and invariant that more than one
package needs. It is deliberately the only package with no workspace
dependencies: it is the contract, so it cannot depend on an implementation.

Packages ship TypeScript source and are consumed through Next's
`transpilePackages`. There is no library build step, which removes a whole class
of stale-build bugs from a monorepo this size.

### Why some couplings are deliberately absent

- `@am/hubspot` and `@am/meta` do **not** depend on `@am/db`. They take injected
  port interfaces instead. Adapters that can reach the database tend to grow
  their own persistence opinions, and then a provider change becomes a schema
  change.
- `@am/creative-renderer` takes a storage client as a parameter rather than
  importing Supabase, for the same reason.
- `@am/ai` cannot see lead or CRM data at all. The only way context reaches a
  prompt is `buildContext()`, which asserts the assembled bundle carries no
  personal data.

## The four principles that shape the code

### 1. Human in the loop

The system prepares decisions; it does not take risky external actions on its
own. Approvals are required for strategy, assets, test plan, publication, budget
scaling and major changes to a running campaign.

Approvals reference a **content hash**, not just an object id
(`packages/domain/src/approvals.ts`). That makes "a content change invalidates
the approval" a mechanical property rather than a process someone has to
remember. `INVALIDATION_MAP` encodes which downstream approvals a given change
invalidates — editing a claim invalidates the asset approval too, because the
assets were reviewed against the old claim set.

### 2. No arbitrary AI markup

The model never emits HTML, CSS or JavaScript, and nothing model-authored is
ever stored as executable markup. It emits validated structured specs
(`MultiStepFormSpec`, `LandingPageSpec`, `CampaignProposal`), and the app renders
them with a controlled component library. Routing and qualification logic is
declarative — eight comparison operators over known field and option ids. There
is no `eval`, no free regex, no external script URL anywhere in a spec.

### 3. Data before model opinion

Every number in the product is computed deterministically. `@am/experiments`
does the statistics, `@am/recommendations` decides the action, and the model is
only allowed to *explain* a facts object it was handed — with a guard that
rejects an explanation containing a digit sequence not present in those facts.

Rates are carried as `{ numerator, denominator, value }` everywhere, so the UI
can always render "12 / 340" beside "3,5 %". A zero denominator yields
`value: null`, never `0`, because `0 %` reads as a measurement and `–` does not.

Learnings are labelled `FACT`, `INDICATION` or `HYPOTHESIS`, and the label is
*derived* from data maturity, attribution coverage and sample size
(`deriveConfidence`). A model cannot promote its own guess to a fact.

### 4. Versioning and immutability

Campaign, angle, offer, creative, funnel, form, experiment arm and prompt
versions freeze at publish, enforced by database triggers rather than
application discipline. Changes create new versions. Historical results always
point at the version that was actually delivered — otherwise a funnel edit in
March silently rewrites what February's numbers mean.

## Reliability: the transactional outbox

The lead path is the part of the system that must not lose data. A visitor
submits, and we must persist the lead even if HubSpot is down, Meta is
rate-limiting and the CAPI dataset is misconfigured.

```
final submit
  └─ BEGIN
       insert form_submissions       (UNIQUE submission_attempt_id)
       insert submission_status_history
       insert attribution_snapshots  (immutable)
       insert outbox_events          (HubSpot sync)
       insert outbox_events          (Meta CAPI initial lead)
     COMMIT
  └─ return success to the visitor
```

The business write and its outbox rows land in the **same transaction**. After
that, a background pump delivers them with exponential backoff, a dead-letter
queue and manual retry. A HubSpot outage becomes a visible `FAILED_RETRYING`
badge in the console, not a lost lead.

Idempotency is enforced at three levels: `UNIQUE (submission_attempt_id)` on
submissions, `UNIQUE (destination, dataset_id, event_id)` on the outbox, and
`UNIQUE (provider, external_id)` on every mirrored external record. Ten
concurrent identical submits therefore produce one submission, at most one
contact, at most one opportunity, one logical lead event and one deduplicated
Meta lead event.

## External writes are off by default

`EXTERNAL_WRITES_ENABLED=false` is the master switch, with per-provider flags
beneath it. Every mutating adapter method checks the flags first and returns a
`DryRunResult` describing exactly what it would have sent. The console renders
that as an unmistakable "Dry-Run – nicht ausgeführt" banner.

A local button click is never shown as a successful external action. Only
`CommandState.PROVIDER_CONFIRMED` (or `RECONCILED`) may be rendered as done, and
reconciliation re-reads the entity from the provider to confirm the change
actually took effect.

Every newly created Meta object is created `PAUSED`.

## Working without credentials

Meta, HubSpot and OpenAI credentials, and the real HubSpot property/VQ/stage
mapping, are supplied later. That is an input we do not have, not a reason to
stop building:

- every adapter is fully implemented against a documented interface,
- each has a deterministic `Fixture*Provider` alongside the live one, selected
  once in a factory from `resolveProviderMode()`,
- `DEMO_MODE=true` runs the entire workflow end to end on realistic fixture data
  including spend, delivery, leads, VQs, no-shows, closed-won, revenue, sync
  failures and retries,
- health checks report `AWAITING_EXTERNAL_INPUT` — a first-class status, not a
  failure — and that status blocks **only** the live step, never development or
  demo acceptance.

Nothing in the system ever invents a credential, an external id, or a successful
connection.

## Where the interesting logic lives

| Concern | Module |
| --- | --- |
| campaign state machine + transitions | `packages/domain/src/campaign.ts` |
| approval invalidation by content hash | `packages/domain/src/approvals.ts` |
| launch gate, live-only vs. hard blockers | `packages/domain/src/launch-qa.ts` |
| event envelope + PII guard | `packages/domain/src/events.ts` |
| attribution confidence ladder | `packages/domain/src/attribution.ts` |
| outbox retry + deterministic event ids | `packages/domain/src/outbox.ts` |
| form graph validation + runtime evaluation | `packages/funnel-schema/` |
| signed launch tokens, assignment, collector | `packages/tracking/` |
| Beta-Binomial evaluation, data maturity | `packages/experiments/` |
| the rules that produce recommendations | `packages/recommendations/` |

## Further reading

- [`data-model.md`](./data-model.md) — tables, constraints, RLS
- [`event-contract.md`](./event-contract.md) — the analytics wire format
- [`attribution.md`](./attribution.md) — touch model and confidence
- [`ai-pipeline.md`](./ai-pipeline.md) — the twelve generation steps
- [`meta-integration.md`](./meta-integration.md) — import, drafts, CAPI
- [`hubspot-mapping.md`](./hubspot-mapping.md) — the mapping wizard
- [`security-and-privacy.md`](./security-and-privacy.md) — RLS, PII, consent
- [`deployment.md`](./deployment.md) — Vercel projects, env, domains
- [`runbook.md`](./runbook.md) — operating the thing
