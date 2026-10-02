# strength-tracker

A strength log for a coached lifter, with Claude as the programming layer.
Multi-user, open source. The coach programs, Claude parses screenshots and
analyzes progress, the phone app captures sets — and an in-app coach answers
questions about your own training, mid-session, from the same tools.

```
Coach screenshot ──► Claude Desktop ──► mcp-remote (bearer token)
                      or claude.ai / ChatGPT (OAuth sign-in)
                                             │ HTTPS
                                             ▼
                                  Supabase Edge Function (MCP server)
                                             │ service role, user resolved per request
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
   that user. A bearer token (`mcp_tokens`, SHA-256 stored) or a Supabase OAuth
   access token carrying `client_id` (`lib/oauth.ts`, shipped 2026-09-13)
   resolves to a user; the server never trusts a plain session JWT. Bearer
   covers `mcp-remote --header` for Claude Desktop, and OAuth sign-in covers
   claude.ai and ChatGPT connectors. Either way the token only decides who is
   asking, not what they may reach.

## Layout

```
supabase/migrations/       schema, RLS, derived-metric views
supabase/functions/mcp-server/   MCP server (Deno edge function)
supabase/functions/coach/        in-app coach (Sonnet + the MCP tools above)
supabase/seed/             generated exercise seed (873 exercises)
pwa/                       React + Vite PWA, IndexedDB outbox
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
- [docs/plan.md](docs/plan.md): historical build log (not the current plan)
- [docs/roadmaps/2026-09-19-consolidated-roadmap.md](docs/roadmaps/2026-09-19-consolidated-roadmap.md):
  active product and release roadmap (current phase and status are in it).
- [docs/roadmaps/release-ledger.md](docs/roadmaps/release-ledger.md):
  stop-release finding status

## License

MIT. Exercise data seeded from
[yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db)
(Unlicense).
