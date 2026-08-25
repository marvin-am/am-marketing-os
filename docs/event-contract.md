# Event contract

First-party analytics. No vendor SDK, no third-party collector — the funnel
runtime posts to our own endpoint and we own the data.

The canonical definition is `packages/domain/src/events.ts`. This document
explains the reasoning; the code is the specification.

## Events

| Event | Emitted by | When |
| --- | --- | --- |
| `funnel_viewed` | client | a published funnel version renders |
| `experiment_exposed` | client | an arm is **actually rendered** |
| `form_viewed` | client | the form component mounts |
| `form_started` | client | the visitor interacts with the first field |
| `form_step_viewed` | client | a step becomes visible |
| `form_step_completed` | client | a step passes validation and advances |
| `form_validation_failed` | client | a field fails validation |
| `lead_submit_attempted` | client | final submit is triggered |
| `lead_submitted` | server | a submission is accepted and persisted |
| `lead_submit_failed` | client | submit returned an error |
| `thank_you_viewed` | client | a terminal result state renders |
| `booking_started` | client | the booking CTA is followed |
| `form_abandoned` | **server** | derived after an inactivity window |
| `vq_scheduled` | **server** | a CRM transition, mirrored into the event stream |

### Two events that are easy to get wrong

**`experiment_exposed` fires on render, not on assignment.** Assignment happens
server-side and is stable forever; exposure is the moment a human could actually
have seen the variant. If you count assignments as exposures, every bot that
requests a page inflates the denominator of every experiment.

**`form_abandoned` is derived server-side**, never sent from `beforeunload`.
`beforeunload` does not fire reliably on mobile Safari, which is most of the
traffic — an abandonment rate built on it is systematically wrong in a direction
that flatters the funnel. Instead a job scans `form_instances` for inactivity
past `FORM_ABANDON_MINUTES` (default 30) and emits the event.

## Envelope

Every event carries, where available:

```
event_id                event_schema_version    occurred_at    received_at
environment             traffic_kind            visitor_id     session_id

campaign_id             campaign_version_id
angle_id                angle_version_id
offer_id                offer_version_id
creative_id             creative_version_id
funnel_id               funnel_version_id
form_id                 form_version_id
experiment_id           experiment_arm_id

form_instance_id        submission_id
step_id                 field_id               error_code
consent_status

utm_source  utm_medium  utm_campaign  utm_content  utm_term
fbclid      fbc         fbp
meta_campaign_id        meta_adset_id          meta_ad_id
referrer                landing_url
```

`occurred_at` is client time; `received_at` is server time. Both are kept
because client clocks are wrong often enough to matter, and the gap between them
is a useful signal about a device.

### Trusted vs. untrusted identifiers

The internal ids in the middle block come from the **server-signed launch
token** carried in the ad URL. Values recovered from a verified token are
trusted. Everything a browser can edit — UTMs, click ids, referrer — is stored
for reporting but may **never** overwrite a trusted id. `parseLandingUrl()`
separates the two, and the collector enforces it.

Without that split, anyone could attribute a lead to any campaign by editing a
query string.

## PII rules

The following must never appear anywhere in an analytics event:

- name, e-mail address, phone number
- free-text answers, or the full answer set
- PII in a URL
- PII in a log line

`form_validation_failed` carries a `field_id` and a standardised
`ValidationErrorCode` — never the value the visitor typed. Knowing that
`postcode` failed with `INVALID_POSTCODE` is all the analytics needs; knowing
they typed `1234` is a data-protection liability with no analytical value.

Enforcement is structural, not a review convention:

1. `trackingEventSchema` only permits known keys, and `metadata` accepts only
   short strings, numbers and booleans.
2. `findPiiViolations()` walks the whole payload looking for forbidden keys
   (`email`, `phone`, `vorname`, `answers`, `nachricht`, …) and for e-mail and
   phone *patterns* in any string value.
3. The collector rejects a violating event with a 400 rather than silently
   dropping the field — a silent drop hides a bug that is producing the PII.
4. `@am/observability` runs every log line through `redact()`. There is no
   unredacted logging path.

There is a test asserting an event carrying an e-mail address is rejected. That
test is the acceptance criterion, not a nice-to-have.

## Traffic classification

Every event is stamped with a `traffic_kind`:

`PRODUCTION` · `PREVIEW` · `INTERNAL` · `BOT` · `TEST`

Only `PRODUCTION` reaches a rollup, a metric or an experiment result. Preview
sessions from the console's funnel preview, internal team traffic, obvious bots
and E2E test runs are all classified out. Without this, every design review
session quietly pollutes the conversion rate of the funnel being reviewed.

## Delivery

The browser client (`@am/tracking/beacon`) queues events, batches them and
flushes via `navigator.sendBeacon`, falling back to `fetch(..., { keepalive: true })`.
It asserts non-PII before enqueueing, so a mistake fails in development rather
than in the log drain.

Ingestion is idempotent on `event_id`: a beacon retry after a flaky mobile
connection does not double-count.

## Versioning

`event_schema_version` is `1`. A breaking change bumps it and the collector
accepts both versions during the transition. Additive fields do not bump it.
Historical rows keep the version they were written with, so a query can always
tell which shape it is reading.
