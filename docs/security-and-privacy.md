# Security and privacy

## Threat model in one paragraph

The console is an internal tool behind authentication; its main risks are
privilege escalation between roles and an accidental external write to a live ad
account. The funnel runtime is exposed to the open internet, takes untrusted
input, and holds the only path to personal data — its main risks are injection,
spam, enumeration and leaking PII into places PII should never be. These two
surfaces get different treatment on purpose.

## Authentication and authorisation

- Supabase Auth with Google OAuth, magic link as a fallback.
- A configurable **allowlist** (`AUTH_ALLOWLIST`) of addresses and/or domains
  gates sign-in. An empty allowlist denies everyone — `isEmailAllowed()` fails
  closed, because an internal tool that defaults to "anyone with a Google
  account" is a incident waiting to happen.
- Seven roles: `VIEWER`, `MARKETING_OPERATOR`, `CREATIVE_REVIEWER`,
  `MARKETING_LEAD`, `REVOPS`, `EXECUTIVE`, `ADMIN`.
- **Route handlers and server actions check a `Permission`, never a role.** The
  matrix in `packages/domain/src/roles.ts` is the only place a capability moves.
  A member may hold several roles; permissions are the union.
- Budget authority is a separate, configurable matrix
  (`DEFAULT_ROLE_BUDGET_LIMITS`). An over-limit increase is **refused and routed
  to a role that may approve it** — never silently clamped, because a silent
  clamp means the operator believes they scaled and they did not.

## Row Level Security

RLS is enabled on every non-public table, keyed on workspace membership.

The `anon` role — which the public funnel runtime uses — can read published
funnel specs and nothing else. It cannot read leads, submissions, PII, CRM
state, campaign strategy or audit logs. Writes from the public runtime go
through narrowly scoped server endpoints and `SECURITY DEFINER` functions, never
direct table writes from a browser.

The service role key is **server-only**. It is never prefixed `NEXT_PUBLIC_`,
never imported into a client component, and `getServerEnv()` throws if it is
read in a browser context. An ESLint rule flags inline `process.env`
service-key reads outside `@am/config`.

## Data classification

Every form field carries a `piiClass`:

| Class | Examples | Storage |
| --- | --- | --- |
| `PII` | name, e-mail, phone | `submission_pii_encrypted` only, AES-256-GCM |
| `QUALIFICATION` | budget range, team size | `submission_answers_non_pii` |
| `OPERATIONAL` | timing, device class | `submission_answers_non_pii` |

`splitAnswers()` in `@am/funnel-schema` partitions a submission by class so a
caller cannot accidentally write an e-mail into the analytics table. Field types
that are inherently personal (`EMAIL`, `PHONE`, `FIRST_NAME`, `LAST_NAME`) are
forced to `PII` regardless of configuration.

Encryption uses `APP_ENCRYPTION_KEY` (32 bytes, base64) with a `key_version`
column so keys can be rotated without a destructive migration.

Non-PII answers may be persisted in the browser session so answers survive back
navigation. **Contact PII is never stored unencrypted in local storage.**

## What never leaves the building

- No personal lead or CRM data is ever sent to OpenAI. `buildContext()` is the
  only path into a prompt and it asserts the assembled bundle carries no
  e-mail or phone patterns.
- No free-text answers or sensitive qualification data go to Meta. CAPI carries
  hashed identifiers, click ids and the mapped stage — nothing else.
- Logs and audit rows pass through `redact()`, which replaces the value of any
  key in `AUDIT_REDACT_KEYS` (contact fields, tokens, secrets, `answers`) with
  `[redacted]` while preserving the shape of the change so it stays reviewable.
- Provider responses are stored redacted, or as a payload hash.

## Public endpoint hardening

The funnel runtime's `/api/collect` and `/api/submit`:

- CSRF protection and origin checking on state-changing requests
- rate limits keyed on a hashed visitor/IP
- a honeypot field plus risk-based bot scoring (timing, interaction, UA)
- strict input length limits and full **server-side** field validation — the
  server re-runs the identical `validateStep()` used by the client, so a
  tampered client cannot bypass validation
- XSS sanitisation of any editorial content rendered into a page
- a **redirect allowlist** (`REDIRECT_ALLOWLIST`); an off-list redirect target
  is refused, which is what stops the funnel becoming an open redirector
- webhook endpoints verify signatures over the **raw body** before parsing, and
  reject stale timestamps to prevent replay

## Consent

- Never pre-ticked. `consentSpecSchema` types `defaultChecked` as
  `z.literal(false)`, so a pre-checked consent box cannot be represented at all.
- Stored per submission: the exact legal text **version**, the consent
  timestamp, the collection context, and the permitted purposes.
- Consent versions are immutable; a text change creates a new version.
- Ad measurement, analytics and marketing e-mail are separate purposes and are
  checked separately.

## Auditability

`audit_logs` records generations, approvals, publications, provider actions,
settings changes and role changes — with actor, entity, a German summary,
redacted before/after payloads and a correlation id linking an entry to the
command or job that produced it.

Provider actions are auditable end to end: requested → confirmed → reconciled,
each with its idempotency key and redacted provider response.

## External write safety

Four layered flags, all defaulting to off:

```
EXTERNAL_WRITES_ENABLED=false     # master switch
META_MUTATIONS_ENABLED=false
META_CAPI_ENABLED=false
HUBSPOT_WRITES_ENABLED=false
```

With the master switch off, no adapter performs any external write regardless of
the specific flags. Mutating methods return a `DryRunResult` that the console
renders as an unmistakable dry-run banner — never as success.

These flags are read server-side only. `getFeatureFlags()` returns
`SAFE_DEFAULT_FLAGS` in a browser context, so the client can never be the thing
that decides an external write is allowed.

## Retention

A configurable retention mechanism exists for submission PII, raw provider
payloads, analytics events and audit logs. **No legal retention period is
invented here** — every value defaults to `null` ("not configured") and the
responsible party sets the policy in Settings. Purges are audited.

## Environment separation

Preview, test and production data are separated by the `environment` and
`traffic_kind` columns on every event and submission, and only `PRODUCTION`
traffic reaches metrics. Preview deployments point at preview Supabase
credentials; a preview deployment must never be pointed at the production
project.
