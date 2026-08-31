# strength-tracker

A strength log for a coached lifter, with Claude as the programming layer.
Multi-user, open source. The coach programs, Claude parses screenshots and
analyzes progress, the phone app captures sets — and an in-app coach answers
questions about your own training, mid-session, from the same tools.

```
Coach screenshot ──► Claude Desktop ──► mcp-remote (static bearer, local)
                                             │ HTTPS
                                             ▼
                                  Supabase Edge Function (MCP server)
                                             │ service role, pinned user id
                                             ▼
Phone (PWA, offline-first) ─────► Supabase Postgres (Auth + RLS + views)
```

## Design in five claims

Each of these is argued technically in [docs/decisions.md](docs/decisions.md)
and [docs/security.md](docs/security.md); the short version:

1. **The training record is append-only, enforced by RLS.** `sets` has
   insert and select policies only. With deny-by-default row level security,
   update and delete are impossible for any client, whatever the app code
   does. Offline sync then needs zero merge logic: replay the queue.
2. **Client-generated UUIDs make replay idempotent.** The phone owns
   `sessions.id` and `sets.id` (no database default on purpose), so the
   IndexedDB outbox can flush the same insert twice and
   `on conflict do nothing` makes it a no-op.
3. **Claude cannot touch the training record.** The MCP tool surface has no
   tool that writes `sessions` or `sets`. The authorization boundary is the
   tool surface itself, not a permission flag. Programs Claude writes land
   unconfirmed and require a separate confirm call after human approval.
4. **Derived metrics are views, never stored.** e1RM (Epley, working sets,
   1-8 reps only), weekly volume, prescribed-vs-achieved adherence, rest
   times, goal progress: all `security_invoker` SQL views, so they're always
   consistent with raw data and RLS applies through them.
5. **A token is an identity, not a password.** Each person gets their own MCP
   bearer token; the server stores only its SHA-256, hashes what it is given
   and resolves the user from `mcp_tokens`. Every tool then filters and stamps
   that user. Static bearer auth is what every MCP client supports today —
   `mcp-remote --header` for Claude Desktop, a URL-plus-key field for
   claude.ai and ChatGPT custom connectors — so it works everywhere without
   running an OAuth 2.1 authorization server. OAuth would change only how a
   token is obtained, not what it authorizes; the upgrade path is documented,
   not built.

## Layout

```
supabase/migrations/       schema, RLS, derived-metric views
supabase/functions/mcp-server/   MCP server (Deno edge function, 22 tools)
supabase/functions/coach/        in-app coach (Sonnet + the MCP tools above)
supabase/seed/             generated exercise seed (873 exercises)
pwa/                       React + Vite PWA, IndexedDB outbox, 6 screens
scripts/                   seed generator, database validation harness
docs/                      spec, architecture, decisions, security, setup
```

## Getting started

[docs/setup.md](docs/setup.md) is the full runbook: create a Supabase
project, push migrations, seed, deploy the edge function, wire Claude
Desktop, build the PWA. Local database validation without any infrastructure:

```bash
node scripts/build-exercise-seed.mjs   # fetch + generate seed SQL
npm --prefix scripts install
node scripts/validate-db.mjs           # runs migrations+seed+fixtures in PGlite
```

## Docs

- [docs/spec.md](docs/spec.md): original technical direction
- [docs/architecture.md](docs/architecture.md): system as built
- [docs/decisions.md](docs/decisions.md): every deviation and why
- [docs/security.md](docs/security.md): threat model, what's secret, why
  service-role-behind-a-bearer is acceptable here
- [docs/plan.md](docs/plan.md): build status

## License

MIT. Exercise data seeded from
[yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db)
(Unlicense).
