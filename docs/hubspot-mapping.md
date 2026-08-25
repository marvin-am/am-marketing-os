# HubSpot mapping

## The problem this solves

The real HubSpot property names, VQ definitions, pipeline and deal stages are
**not available yet**. They will be supplied later.

That is not a reason to stop, and it is emphatically not a reason to guess. So
nothing customer-specific is hard-coded anywhere in `@am/hubspot`. Instead there
is a **versioned mapping document** that translates whatever the customer's
HubSpot happens to look like onto eleven canonical, provider-independent sales
events. A fixture mapping stands in until the real one arrives, and a live
launch stays blocked until the required mappings plus a successful test lead
exist.

## Canonical sales events

```
FORM_COMPLETED · VQ_SCHEDULED · VQ_ATTENDED · VQ_NO_SHOW
VQ_PASSED · VQ_REJECTED · SALES_ACCEPTED · OPPORTUNITY_CREATED
CLOSED_WON · CLOSED_LOST · REVENUE_RECOGNIZED
```

Everything downstream — reporting, experiment evaluation, recommendations, CAPI
dispatch — speaks only this vocabulary. Replacing HubSpot with another CRM would
be a new adapter and a new mapping, not a rewrite of the analytics.

Each recorded event carries: the business timestamp, the source object, the
HubSpot object id, the previous and new state, the mapping version, the source
event id (so a webhook can be replayed) and the attribution snapshot.

## The wizard

Fifteen steps, each persisted so the wizard can be resumed:

1. verify the connection
2. load objects and properties
3. define the contact identifier
4. define the company rule
5. choose the pipeline
6. choose the deal-creation trigger
7. map pipeline stages and property values onto the canonical events
8. map the revenue property and the currency
9. map lost / no-show rules
10. map the acquisition fields
11. send a test lead
12. verify the contact ↔ deal association
13. test the webhook
14. test reconciliation
15. publish the mapping

Validation issues carry a **blocking level** — `PUBLISH`, `LAUNCH` or `NONE` — so
a half-finished mapping can be saved and returned to while the live launch stays
gated. `requiredMappingsComplete()` is the gate; `canPublishMapping()` is the
weaker one.

## Object rules

**Contact** — upserted on the normalised e-mail, carrying our stable internal
`am_person_id`. The same person may legitimately have several independent
submissions; that does not create several contacts.

**Company** — optional, and only for a **verified corporate domain**. A freemail
address never triggers automatic company creation, because one auto-created
"gmail.com GmbH" contaminates every account-level report thereafter. The
contact ↔ company association is set explicitly, never inferred.

**Deal / opportunity** — a deal represents a **commercial opportunity**, not one
per form submit. It carries our internal `am_opportunity_id`. The creation
trigger comes from the mapping; the dry-run default is `VQ_SCHEDULED`.
Submissions and touches stay in the Supabase ledger where they belong.

The **acquisition submission** is bound to the opportunity as an immutable
snapshot. Later touches append to `touchpoints`; they never rewrite that
binding. Without this rule, a contact returning through a different campaign in
month three quietly steals credit from the campaign that actually acquired them.

## Transitions, not observations

An outcome event is written **only on a genuine state change**. A reconciliation
pass that observes the same stage again writes nothing.

This matters more than it looks: hourly reconciliation over a few hundred deals
would otherwise generate thousands of phantom `VQ_SCHEDULED` events per day,
each one inflating a conversion rate and, worse, each one dispatched to Meta as
a conversion. The rule is tested directly — ten identical syncs of an unchanged
deal produce zero events; one real transition produces exactly one.

## Failure behaviour

Supabase is written **first**, in one transaction with the outbox row. Only then
does the sync run.

| Status | Meaning |
| --- | --- |
| `PENDING` | queued, not yet attempted |
| `SYNCED` | HubSpot confirmed |
| `FAILED_RETRYING` | failed, backing off, will retry |
| `DEAD_LETTER` | attempts exhausted, needs a human |

A HubSpot outage therefore cannot lose a lead. The lead is accepted, persisted
and attributed; only its CRM copy is missing, and that shows in the console as a
retryable state with the error attached. This is acceptance criterion 30, and it
is tested by simulating an outage and then completing the sync on retry.

Idempotency holds throughout: ten concurrent syncs of one submission yield one
contact, at most one deal, and one logical lead event.

## Webhooks

Signature verification runs over the **raw body**, before parsing — a body is
never trusted enough to parse until it verifies. Stale timestamps are rejected
to prevent replay, and redeliveries are deduplicated by event id.

Webhooks are the fast path, not the guarantee. Hourly and daily reconciliation
re-read the mapped objects and emit whatever the webhooks missed.

## VQ evaluation

Every VQ decision is stored reproducibly:

```
vq_status · vq_score · vq_reason_codes · vq_model_version · vq_evaluated_at
```

Recording the model version is what makes a historical "qualified" decision
auditable after the qualification rules change. Without it, last quarter's
qualification rate becomes unexplainable the moment someone edits a rule.

## What could not be verified

`developers.hubspot.com` is unreachable from this build environment (the egress
proxy refuses the CONNECT with a 403). The adapter is implemented against the
v3 CRM object endpoints, v4 associations, the v3 webhook signature scheme and
`Retry-After`-based rate limiting, cross-checked through search rather than the
primary docs.

Two details remain explicitly unverified and are noted in the code:

- scope introspection via `/oauth/v1/access-tokens/{token}` — used, but a
  failure is non-fatal and **never fabricates a scope list**;
- whether `Retry-After` is delivered in seconds or milliseconds — values ≤ 300
  are treated as seconds, larger values as milliseconds.

Both should be confirmed against the live API during activation. Neither can
cause an incorrect write before then, because all writes are off by default.

## Live-launch gate

A campaign cannot go live until:

- the required mappings are complete,
- a test lead has been sent successfully,
- the contact ↔ deal association has been verified.

Until then the launch-QA check reports `WARTET AUF EXTERNEN INPUT`, which blocks
only the live step — the paused Meta draft, the demo walkthrough and the whole
of product development continue unaffected.
