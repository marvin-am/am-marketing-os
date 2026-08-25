# AGENTS.md — A&M Marketing OS

Working agreement for every agent and contributor touching this repository.

## What this is

An internal marketing operating system for A&M's own Meta performance
marketing. **Not** a SaaS product, **not** multi-tenant in v1. Two deployables
out of one monorepo:

- `apps/console` — the internal tool (authenticated, German UI)
- `apps/funnels` — the public funnel/form runtime (fast, mobile-first, German)

## Non-negotiable rules

1. **No fabricated externals.** Never invent credentials, HubSpot ids, Meta ids,
   pipeline ids, or a "successful connection". If something is missing, the
   product says `AWAITING_EXTERNAL_INPUT` and keeps working against fixtures.
2. **External writes are off by default.** `EXTERNAL_WRITES_ENABLED=false` is the
   master switch. Every adapter must return a `DryRunResult` (from `@am/domain`)
   rather than performing or faking a write. A dry run is never rendered as
   success.
3. **A local click is not a provider confirmation.** Only
   `CommandState.PROVIDER_CONFIRMED` / `RECONCILED` may be shown as a completed
   external action.
4. **Data beats model opinion.** Metrics, statistics, attribution and budget
   rules are computed deterministically. The LLM may explain and hypothesise; it
   may never produce a number or a numeric recommendation.
5. **No arbitrary AI markup.** The model emits validated structured specs only.
   Rendering happens through the controlled component library. No model-authored
   HTML/JS/CSS is ever stored or served.
6. **Published versions are immutable.** Campaign, angle, offer, creative,
   funnel, form, experiment arm and prompt versions freeze at publish. Changes
   create a new version; history always points at what was actually delivered.
7. **No PII in analytics, URLs or logs.** `assertNoPii` from `@am/domain` guards
   the event collector. Use `redact()` before writing audit rows or provider
   responses.
8. **No placeholder UI.** No dead buttons, no "coming soon" pages, no misleading
   success toasts. Every action has loading / success / error states in German.
9. **No TODOs for v1 scope.** If it's in the spec, implement it.

## Language

- **UI text, validation messages, labels: German.**
- **Code, identifiers, comments, docs: English.**

## Stack

pnpm workspaces + Turborepo · Node 22 · TypeScript 5.9 strict · Next.js 16
(App Router) · React 19 · Tailwind CSS v4 (CSS-first `@theme`) · shadcn-style
components on `radix-ui` · Zod 4 · TanStack Query 5 · Recharts 3 · dnd-kit ·
Supabase (Postgres + Auth + Storage + pgvector + RLS) · OpenAI Responses API ·
Vitest 4 · Playwright 1.62.

## Package graph (ownership)

Dependencies flow strictly downward. Never introduce a cycle.

```
domain  ← everything (no workspace deps of its own)
config  ← domain
observability ← domain, config
db      ← domain, config, observability
funnel-schema ← domain
tracking      ← domain, config
experiments   ← domain
recommendations ← domain, experiments
ai            ← domain, config, funnel-schema, observability
creative-renderer ← domain, config
meta          ← domain, config, observability
hubspot       ← domain, config, observability
jobs          ← domain, config, db, meta, hubspot, experiments, recommendations, observability
ui            ← domain
apps/console  ← all
apps/funnels  ← domain, config, db, ui, funnel-schema, tracking, experiments, meta, observability
```

**Only the lead agent edits root files** (`package.json`, `pnpm-workspace.yaml`,
`turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`,
`.env.example`) and `packages/domain`. Sub-agents work exclusively inside their
assigned directories.

If you need a new dependency, say so in your report — do **not** run
`pnpm install` or edit a root manifest yourself. Concurrent installs corrupt the
lockfile.

## Conventions

- Packages export TypeScript source (`"exports": "./src/index.ts"`); apps
  consume them via `transpilePackages`. There is no build step for libraries.
- Imports between modules in a package are **extensionless** (`./foo`, not
  `./foo.js`). Bundler module resolution is configured.
- `verbatimModuleSyntax` is on: use `import { type X }` for type-only imports.
- `noUnusedLocals` / `noUnusedParameters` are on. Prefix intentionally unused
  parameters with `_`.
- Money is stored as integer **minor units** (`amountMinor`) plus an ISO
  currency. Never persist floating-point euros.
- Timestamps are ISO-8601 UTC strings at the boundary, `timestamptz` in the
  database.
- Database column names are `snake_case`; TypeScript is `camelCase` except where
  a type mirrors a row shape one-to-one (those keep `snake_case`, as in
  `TrackingEvent`).
- Rates are always carried as `{ numerator, denominator, value }` so the UI can
  render "12 / 340" beside "3,5 %". A zero denominator yields `value: null`,
  never `0`.

## Testing

- Unit: `packages/*/src/**/*.test.ts` (node) — pure logic, no I/O.
- Component: `packages/*/src/**/*.test.tsx`, `apps/*/src/**/*.test.tsx` (jsdom).
- Integration: `packages/*/integration/**/*.test.ts` — cross-package flows
  against fixture providers; Postgres-backed tests skip themselves cleanly when
  `DATABASE_URL` is unset.
- E2E: `e2e/tests/**` (Playwright).

Run from the repo root: `pnpm test`, `pnpm typecheck`, `pnpm lint`,
`pnpm build`, `pnpm test:e2e`.

Every sub-agent ships **code + tests + a short integration report**. A plan alone
is not a deliverable.

## Fixtures and demo mode

`DEMO_MODE=true` routes every provider through a deterministic fixture
implementation. Fixtures must be realistic (spend, delivery, leads, VQs,
no-shows, closed-won, revenue, sync failures, retries) and must never pretend a
real provider is connected. Provider adapters are defined as interfaces with two
implementations: `FixtureXProvider` and `LiveXProvider`. Selection happens once,
in a factory, from config — never inline in feature code.
