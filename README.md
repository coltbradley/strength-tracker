# strength-tracker

A strength log for a coached lifter, with Claude as the programming layer.
Single-user, open source. The coach programs, Claude parses screenshots and
analyzes progress, the phone app captures sets. Nothing else.

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
5. **No OAuth for one user.** The claude.ai connector UI supports only OAuth
   or no auth, but `mcp-remote --header` carries a static bearer token from
   the local Claude Desktop config. A constant-time token check in the edge
   function replaces an entire OAuth 2.1 deployment. The upgrade path
   (Supabase Auth's OAuth 2.1 server) is documented, not built.

## Layout

```
supabase/migrations/       schema, RLS, derived-metric views
supabase/functions/mcp-server/   MCP server (Deno edge function, 8 tools)
supabase/seed/             generated exercise seed (873 exercises)
pwa/                       React + Vite PWA, IndexedDB outbox, 4 screens
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
