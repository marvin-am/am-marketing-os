# Attribution

The purpose of this document is to make one thing unambiguous: **what the system
is allowed to claim it knows**, and what it must admit it is guessing.

Canonical code: `packages/domain/src/attribution.ts` and
`packages/tracking/src/attribution.ts`.

## Four touch roles, stored in parallel

| Role | Meaning |
| --- | --- |
| `FIRST` | the earliest observed touch for this visitor |
| `LAST` | the most recent touch before the submission |
| `ACQUISITION` | the touch credited with acquiring the opportunity |
| `INFLUENCED` | every other touch in the window |

All four are stored. Single-model attribution destroys information, and the
question "did the retargeting campaign help?" cannot be answered from a
last-touch table.

## The primary rule

For campaign reporting, the acquisition touch is:

> the **last uniquely identified paid-Meta touch** before the accepted
> submission, within the attribution window (default **30 days**, configurable
> via `ATTRIBUTION_WINDOW_DAYS`).

"Uniquely identified" is doing the work in that sentence. See the confidence
ladder below.

## Confidence ladder

| Confidence | Requires |
| --- | --- |
| `EXACT` | a valid **server-signed launch token**, a Meta **click id**, or a campaign parameter that maps 1:1 onto one internal campaign version |
| `HIGH_CONFIDENCE` | generic UTMs **and** a Meta referrer |
| `MEDIUM_CONFIDENCE` | generic UTMs alone |
| `LOW_CONFIDENCE` | a Meta referrer alone, or temporal proximity alone |
| `UNKNOWN` | nothing usable |

**Temporal proximity is never `EXACT`.** "The lead arrived while campaign X was
running" is the single most common source of fabricated attribution in ad
reporting, and it is explicitly demoted to `LOW_CONFIDENCE` here.

Only `EXACT` and `HIGH_CONFIDENCE` count as trustworthy. Every campaign-level
metric is rendered next to its **attribution coverage** — the share of
underlying records that are trustworthy — so a 4× ROAS built on low-confidence
matches cannot be mistaken for a measured fact.

## The immutable snapshot

At final submit, an `attribution_snapshot` is written and then never changed. It
contains the internal campaign / angle / offer / creative / funnel / form /
experiment versions actually delivered, the Meta campaign / ad set / ad ids,
first / last / acquisition touches, influenced touch ids, click ids, UTMs,
referrer, landing URL, the resolved confidence, the consent status and the
window that was in force.

Everything downstream — CRM sync, CAPI dispatch, revenue reporting, learning
cards — reads the snapshot. Nothing re-derives attribution later.

Two reasons this matters:

1. **Campaign numbers cannot silently change months later.** If reporting
   re-derived attribution on read, a change to the window or the rules would
   quietly rewrite history.
2. **Later visits cannot steal credit.** `preserveAcquisition()` guarantees that
   a contact returning through a different campaign in month three does not
   overwrite the acquisition snapshot of an opportunity created in month one.
   Those later visits are recorded as `INFLUENCED` touches.

## Historical data

Imported historical campaigns rarely have the ids a live campaign has. They are
classified honestly rather than upgraded:

| Level | Meaning |
| --- | --- |
| `CREATIVE_ONLY` | we know the creative existed; nothing downstream is linked |
| `TRAFFIC_LINKED` | sessions can be tied to it |
| `LEAD_LINKED` | leads can be tied to it |
| `REVENUE_LINKED` | revenue can be tied to it |

A historical campaign that predates our tracking stays `CREATIVE_ONLY` and is
useful as creative and angle memory — not as a performance benchmark. Learning
cards derived from it are labelled `HYPOTHESIS`, never `FACT`.

## When there is no match

`DIRECT` or `UNKNOWN`. The system does not guess.

A lead with no identifiable paid touch is a real thing that happens — someone
saw an ad on their phone, typed the domain on their laptop a week later, and
there is no honest way to link the two. Recording that as `UNKNOWN` keeps the
denominator of "how much can we actually attribute?" truthful, which is the
number that tells you whether to trust the rest of the report.

## Consent

The snapshot records the consent status and the exact consent version. Anything
sent to Meta for ad measurement is gated on `AD_MEASUREMENT` consent
(`mayUseForAdMeasurement`). IP address and user-agent are included in CAPI
payloads only when consent permits.
