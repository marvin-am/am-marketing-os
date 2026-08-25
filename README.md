# A&M Marketing OS

Internal operating system for A&M's own Meta performance marketing — from
campaign idea to paused Meta draft, live delivery, measured leads, CRM outcomes,
attributed revenue and the decision about what to test next.

Not a SaaS product. Not multi-tenant. One team, one workspace.

## Quick start

```bash
pnpm install
cp .env.example .env.local     # defaults already run the full product on fixtures
pnpm dev                       # console :3000 · funnel runtime :3001
```

No credentials are needed. `DEMO_MODE=true` routes every provider through
deterministic fixtures and `EXTERNAL_WRITES_ENABLED=false` makes any external
write impossible.

```bash
pnpm typecheck        # tsc across the workspace
pnpm lint             # eslint, zero warnings tolerated
pnpm test             # vitest: unit, dom and integration projects
pnpm build            # both Next apps
pnpm test:e2e         # playwright (run pnpm build first)
pnpm verify           # typecheck + lint + test + build
```

Against a real Supabase instance:

```bash
DATABASE_URL="postgresql://..." pnpm db:migrate
DATABASE_URL="postgresql://..." pnpm db:seed
```

## Layout

```
apps/console            internal tool          → marketing.am-beratung.de
apps/funnels            public funnel runtime  → go.am-beratung.de

packages/domain         shared contract: enums, Zod schemas, invariants
packages/config         validated env, provider mode, feature flags
packages/db             Supabase clients, repositories, outbox, crypto
packages/ui             design system (A&M red / black / white)
packages/ai             OpenAI adapters, prompt registry, campaign pipeline
packages/creative-renderer  deterministic creative composition
packages/funnel-schema  PageSpec / MultiStepFormSpec, validators, runtime
packages/tracking       signed tokens, identity, assignment, collector
packages/experiments    statistics, data maturity, rollups
packages/recommendations deterministic decision engine
packages/meta           Marketing API, historical import, CAPI
packages/hubspot        CRM adapter, mapping wizard, reconciliation
packages/jobs           workflows, outbox pump, cron handlers
packages/observability  redacted logging, provider instrumentation

supabase/               migrations, seed, database tests
docs/                   architecture and operations
e2e/                    Playwright suites
```

## The rules the code enforces

- **Nothing external is written by default.** Four layered flags, all off. Every
  mutating adapter returns a dry-run description instead.
- **A click is not a confirmation.** Only a provider-confirmed command is shown
  as done, and reconciliation re-reads the entity to verify it.
- **Numbers come from data, never from a model.** Statistics and recommendations
  are deterministic; the model may only explain a facts object it was handed.
- **Every rate shows its numerator and denominator.** A zero denominator renders
  `–`, not `0 %`.
- **Published versions are immutable**, enforced by database triggers.
- **A content change invalidates the approval it was reviewed under**, because
  approvals reference a content hash.
- **No PII in analytics, URLs or logs**, enforced by a structural payload scan.
- **Missing credentials block only the live step** — never development, never
  demo acceptance.

See [`docs/architecture.md`](./docs/architecture.md) for the reasoning, and
[`AGENTS.md`](./AGENTS.md) for the working agreement.

## Status

Runs end to end on fixtures. Awaiting external input before going live:

| Needed | Blocks |
| --- | --- |
| Supabase project + keys | persistence beyond the in-memory demo store |
| OpenAI API key | live generation (fixtures otherwise) |
| Meta app, token, ad account, page, pixel/dataset | Meta import, drafts, CAPI |
| HubSpot credentials | CRM sync |
| HubSpot property / VQ / pipeline / deal-stage mapping | the mapping wizard's final publish, and the live-launch gate |
| Vercel project + domains | deployment |

Nothing in the system invents a credential, an external id or a successful
connection. See [`docs/deployment.md`](./docs/deployment.md) for the exact
activation sequence.
