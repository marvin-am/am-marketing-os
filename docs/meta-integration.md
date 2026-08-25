# Meta integration

Two distinct surfaces live in `@am/meta`: the **Marketing API** (import,
insights, drafts, budget and pause commands) and the **Conversions API** (the
initial lead plus down-funnel CRM outcomes).

## Safety posture

`EXTERNAL_WRITES_ENABLED=false` and `META_MUTATIONS_ENABLED=false` are the
defaults. Every mutating method checks the flags **first** and returns a
`DryRunResult` describing exactly what it would have sent. The console renders
that as an unmistakable dry-run banner. A dry run is not a success, and it is
never displayed as one.

Every newly created Meta object is created `PAUSED`. There is no code path that
creates an active object.

## Provider selection

One `MetaProvider` interface, two implementations, selected once in
`createMetaProvider()` from `resolveProviderMode('META')`.

`FixtureMetaProvider` is deterministic and realistic: six campaigns across
eighteen months, twelve ad sets, thirty-six ads and creatives, 1,836 daily
ad-level insight rows — roughly €64,900 spend, 2,242 leads, CPL ≈ €29, CTR
≈ 1.3 %, with weekday seasonality, a three-day learning ramp and per-creative
quality variation. It aggregates to ad-set, campaign and account level on
demand, and injects failures on request (`simulateRateLimit`,
`simulatePermissionError`, `simulateTransientFailure`).

Its `health()` reports `state: 'FIXTURE'` and every probe as
`AWAITING_EXTERNAL_INPUT`. It never claims a connection it does not have.

## Historical import

Cursor/watermark based, resumable, and **idempotent**: every upsert is keyed on
`(provider, external_id)`, so a re-import inserts zero rows. That is tested
directly — importing the same fixture data twice produces no new rows and no
size change.

Default window is 24 months (`HISTORICAL_IMPORT_MONTHS`), extensible in the UI
to the maximum available range. Raw payloads are returned tagged so the caller
persists them to the private schema and bucket rather than into business tables.

Two rules protect the outbound side during an import:

- `runInImportMode()` suppresses CAPI and CRM dispatch for its duration. Without
  it, backfilling two years of leads would fire two years of conversions at Meta
  in an afternoon.
- `assertEventTimeAcceptable()` refuses to send an event whose business
  timestamp is outside Meta's accepted window. Historical events are **never**
  re-sent with a fabricated current timestamp.

Historical creative files are copied into our own `historical-creatives` bucket
at import time, because Meta's creative URLs expire and a library of broken
images is worse than no library.

## Paused draft creation

`buildDraftPlan()` produces a fully resolved, reviewable plan — campaign, ad
set, ads, creative associations, URL parameters, budgets, placements, tracking
references — which the console renders in full before anything is sent. The
operator sees the affected objects, the audience, the budget, the URLs, the
creatives, the tracking parameters and the exact action.

`createPausedDraft()` then:

- refuses unless `canWriteMeta(flags)`, otherwise returns a dry run,
- creates every object `PAUSED`,
- carries an **idempotency key** so a retry cannot create a second campaign,
- returns provider ids only after the provider confirms them.

Because it could not be confirmed that the Marketing API offers a first-class
idempotency token, idempotency is enforced by a local command ledger plus an
`[AM:<key>]` marker in the campaign name, which lets a crashed run recover by
looking the draft up rather than creating a duplicate.

Destination URLs carry the server-signed launch token in the `am_t` parameter —
the same constant `@am/tracking` reads in the funnel runtime, defined once in
`@am/domain`. (These two drifted during the build; the failure mode was silent,
with every lead falling back to `UNKNOWN` attribution, so there is now a parity
test.)

## Commands

Every external mutation is a command with a lifecycle:

```
PENDING_CONFIRMATION → QUEUED → IN_FLIGHT → PROVIDER_CONFIRMED → RECONCILED
                                          ↘ FAILED
```

Nothing executes without explicit confirmation. **Only `PROVIDER_CONFIRMED` (or
`RECONCILED`) may be rendered as done** — a local click is not a provider
action. Reconciliation re-reads the entity from Meta and verifies the change
actually took effect, which is what catches a request that returned 200 and
changed nothing.

Budget guards: +20 % default step, at most one scale per 24 hours, never above
the configured campaign or account limit. An over-limit request is **refused
with the approving role named**, not silently clamped — a silent clamp means the
operator believes they scaled and they did not.

## Pixel and Conversions API

### The initial lead

Browser pixel and server event are built from **one source** so they cannot
drift: same event name, same `event_id`, derived from
`initialLeadEventIdSource(submissionId)`. Meta deduplicates the pair, so one lead
produces one conversion (acceptance criterion 31).

CAPI is dispatched only **after** server-side spam and validation checks, and
`event_time` is the business event time — never the retry time. Getting that
wrong shifts conversions into the wrong day and quietly corrupts every daily
comparison.

### Down-funnel CRM outcomes

Four semantic stages, mapped from our canonical sales events:

```
INITIAL_LEAD → MARKETING_QUALIFIED_LEAD → SALES_OPPORTUNITY → CONVERTED
```

These have no browser twin. Their event id is deterministic:

```
event_id = sha256(form_instance_id + ":" + event_type + ":" + transition_version)
```

with a `UNIQUE (destination, dataset_id, event_id)` constraint behind it. A
retry, a re-sync and a replay all collapse onto one provider event.

`CONVERTED` is dispatched **exactly once per opportunity**. A later change to the
deal value produces a reconciliation discrepancy — not a second conversion.
Tested directly: dispatching `CONVERTED` twice yields one event plus a
`CONVERTED_VALUE_CHANGED` discrepancy.

`CONVERTED` carries the booked value, the ISO currency and the closed-won
business timestamp.

### Matching data

Snapshotted at first contact: `fbp`, `fbc`, `fbclid`, normalised+hashed e-mail,
normalised+hashed phone, `external_id`. IP address and user agent are included
**only** when consent permits. `fbp`, `fbc`, IP and user agent are never hashed;
identifiers always are. Nine known hashing vectors are asserted in tests.

**No free-text answers and no sensitive qualification data are ever sent to
Meta.** Logs store redacted payloads or payload hashes, never raw PII.

## Setup wizard

Ten probes, each returning a `HealthCheck` with a German label and remediation:
app connection · business · ad account · page/Instagram · pixel/dataset ·
permission check · insights read test · paused-draft test · CAPI test · overall
status.

Missing credentials yield `AWAITING_EXTERNAL_INPUT`, not `FAIL` — the
distinction is what keeps a missing token from looking like a broken product,
and it blocks only the live step.

## What could not be verified

`developers.facebook.com` is unreachable from this build environment (the egress
proxy refuses the CONNECT with a 403). The following were confirmed through
secondary sources and are implemented accordingly: the `user_data` field set and
its normalisation/hashing rules, the never-hash list, the 7-day web `event_time`
limit and 62-day offline window, deduplication on `event_name` + `event_id`
within 48 hours, the endpoint shapes, `object_story_spec` with `image_hash`, and
error codes 190 and 200.

Explicitly **unverified**, and flagged in the code:

- the exact custom event names for the CRM stages — defaults are
  `MarketingQualifiedLead`, `SalesOpportunity`, `Converted`, configurable through
  `eventNameOverrides`, and they must be matched against Events Manager during
  activation;
- `custom_data.lead_event_source` / `event_source` for the conversion-leads
  integration;
- the `{{campaign.id}}` / `{{adset.id}}` / `{{ad.id}}` url_tags macros;
- the unit of `X-Business-Use-Case-Usage.estimated_time_to_regain_access`
  (implemented as minutes);
- whether the Marketing API offers a first-class idempotency token.

All of these should be confirmed against the live API during activation. None
can cause an incorrect write before then, because every write is off by default.
