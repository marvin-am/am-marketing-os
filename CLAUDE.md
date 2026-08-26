# A&M Marketing OS

Internal marketing operating system for the agency's own Meta performance
marketing: campaign idea → creatives → funnel → paused Meta draft → lead →
CRM → attributed revenue.

## Read these two first

- **[`AGENTS.md`](./AGENTS.md)** — the working agreement. Rules that hold
  whatever you are doing: never invent a credential or a provider connection,
  external writes off by default, rates always carry their numerator and
  denominator, published versions are immutable, no PII outside the encrypted
  table.
- **[`docs/handoff.md`](./docs/handoff.md)** — where the work actually stands,
  what is finished, what is not, and what to do next. Start there rather than
  inferring the state from the code.

UI strings are German. Code, identifiers, comments and documentation are
English.

## Layout

```
apps/console     Next.js — the internal tool (auth-gated)
apps/funnels     Next.js — the public funnels (no auth)
packages/domain  The shared contract. Every enum, schema and rule lives here.
packages/db      Supabase repositories + the in-memory store demo mode uses
packages/{ai,meta,hubspot,tracking,experiments,recommendations,jobs,ui,…}
supabase/        18 migrations, seed, and the Postgres test suites
e2e/             Playwright — console, funnel, mobile, one full journey
```

Adapters declare narrow ports and never import `@am/db`; composition happens in
the apps.

## Commands

```bash
pnpm verify                    # typecheck + lint + test + build
pnpm typecheck                 # the whole workspace, not one package
npx vitest run --project unit --project dom
DATABASE_URL=… npx vitest run --project integration   # skips cleanly without it
pnpm db:migrate                # idempotent; records in _am_migrations
pnpm test:e2e                  # Playwright; Chromium is preinstalled
```

Run `pnpm typecheck` for the workspace before reporting anything green. A
single package passing on its own has already been mistaken for the whole tree.

## Two habits worth keeping

**A passing test is not a working screen.** The suite exercises packages and
fixture ports; it does not open a page. It stayed green while `/einstellungen`
returned a 500 on every request. When a change touches a screen, load it.

**Where the schema cannot answer, say so.** Several ports deliberately return
null or an explicit "not known" rather than a plausible zero, and the UI renders
that as an awaiting-input state. Those are decisions, not gaps to fill —
`docs/handoff.md` lists them.
