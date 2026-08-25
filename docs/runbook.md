# Runbook

Operating the A&M Marketing OS.

## Daily loop

**Heute** is the start of the day. It shows active campaigns, pending
approvals, new proposals, critical tracking or sync errors, open
recommendations, campaigns whose results have matured, campaigns whose CRM
cohorts have not, and budget or performance warnings.

Work it top to bottom: errors first (they invalidate data), then approvals
(they block other people), then recommendations.

## Running a campaign

1. **Propose** — generate a campaign proposal. Review the angle against the
   similar historical campaigns the system shows you and the stated
   differentiation. If it is flagged as an iteration, that is fine — but say so
   in the hypothesis rather than pretending it is new.
2. **Approve strategy** — angle, offer, claims. Every claim needs either an
   evidence reference or a visible hypothesis label.
3. **Generate assets** — six creative concepts and two or three funnel variants
   (at least two multi-step forms). Edit copy directly; regenerate individual
   concepts rather than the whole set.
4. **Approve assets** — at least five conceptually distinct creatives. The
   diversity checker blocks launch below that; if it fires, regenerate the
   duplicates rather than approving around it.
5. **Approve the test plan** — hypothesis, variable, control, metrics,
   guardrails, minimum volume, runtime bounds, stop and scale rules, CRM
   maturity window.
6. **Launch QA** — every check green, or clearly `WARTET AUF EXTERNEN INPUT`.
7. **Create the paused Meta draft** — review the exact objects, budgets, URLs
   and tracking parameters before confirming.
8. **Publish** — a lead approves; Meta objects go live.

Editing anything after an approval invalidates that approval and the ones
downstream of it. That is intended, and the console tells you which ones.

## Reading results honestly

Three things to look at before believing a number:

- **Numerator and denominator.** Every rate shows them. "40 %" over 5 sessions
  is not a result.
- **Data maturity.** An `IMMATURE` badge means the CRM cohort has not aged past
  the maturity window. Leading indicators are real; VQ, opportunity and revenue
  numbers are not final.
- **Attribution coverage.** The share of records with `EXACT` or
  `HIGH_CONFIDENCE` attribution. Low coverage means the revenue figure is a
  lower bound on a fuzzy set, not a measurement.

`PROVISIONAL` means the statistics favour an arm but the CRM data is not mature.
It is not a winner. Do not scale on it — the engine will refuse to recommend it.

## Common situations

### A recommendation to scale

Check maturity and guardrails, then confirm. Default step is +20 %, at most one
scale per 24 h, never above the configured limit. If your role's limit blocks
it, the console names the role that can approve — send it there rather than
looking for a way around it.

Success is only shown once Meta confirms. If the badge sits at "Wird ausgeführt"
for more than a few minutes, check Integrationen → Meta for a rate limit or an
expired token.

### A campaign is spending with no leads

The pause warning fires at 1.5× target CPL with zero leads. Before pausing,
check the funnel: high CTR with a low submission rate points at the funnel or
the offer, not the creative. The recommendation says which.

### HubSpot sync failures

Integrationen → HubSpot shows `PENDING`, `SYNCED`, `FAILED_RETRYING` and
`DEAD_LETTER` counts. `FAILED_RETRYING` resolves itself; the outbox backs off
exponentially. `DEAD_LETTER` needs a human.

The lead itself is never lost — it is in Supabase, accepted, with its attribution
snapshot. Only the CRM copy is missing. Fix the cause (usually a mapping change
or a required property), then use the retry button on the dead-letter row.

### A dead-letter outbox row

1. Open the row; read `last_error` and the redacted provider response.
2. Fix the cause — a mapping gap, a permission, a rate limit.
3. Retry. The event id is deterministic, so a retry cannot create a duplicate.

If the event is genuinely obsolete (a test lead, a deleted campaign), mark it
expired rather than retrying it.

### A Meta command is stuck

Every external command records requested → confirmed → reconciled. A command
stuck in `IN_FLIGHT` past a few minutes means the provider did not answer.
Reconciliation re-reads the entity and settles it either way. Do not re-issue
the command by hand — the idempotency key makes a retry safe, but a *different*
command is a second change.

### Tracking looks wrong

- Sessions but no `experiment_exposed`: the arm is being assigned but not
  rendered. Check the funnel page.
- Events with no campaign ids: the ad URL is missing its launch token. Rebuild
  the draft's URLs.
- Numbers higher than Meta's: check `traffic_kind` — preview or internal traffic
  should be excluded and something is classifying it as `PRODUCTION`.

### Changing the HubSpot mapping

Mappings are versioned. Publish a new version; historical events keep the
version they were written under, so past results stay interpretable. Re-run the
test lead after publishing — a mapping change can silently break deal creation.

## Health checks

Integrationen shows per-provider status. `AWAITING_EXTERNAL_INPUT` is not a
failure — it means a credential or mapping has not been supplied yet, and it
blocks only the live step.

`FAIL` is a real problem. The check names the remediation.

## Restoring safety fast

If something is writing to the ad account or the CRM that should not be, set
`EXTERNAL_WRITES_ENABLED=false` in Vercel. It takes effect on the next request
without a deploy. Nothing is lost — outbox events queue and deliver when it is
turned back on.

## Verifying a change before shipping

```bash
pnpm verify      # typecheck + lint + test + build
pnpm test:e2e    # full journey against fixtures
```

The E2E journey covers proposal → approvals → launch QA → paused draft → visitor
→ stable arm → five questions → postcode → contact → consent → repeated submit →
exactly one submission → HubSpot outage → retry → VQ → qualified → closed won →
revenue on the right campaign and variant → deduplicated Meta outcome → scale
recommendation → confirmation → provider confirmation → complete audit chain.

If that suite passes, the chain the business depends on is intact.
