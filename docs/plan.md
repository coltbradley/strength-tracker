# Build plan

Status legend: [x] done, [~] in progress, [ ] not started.

## Phase 0: verify the spec (done)

- [x] Auth spike, by research instead of code. Result: static bearer via
      mcp-remote, OAuth not needed. See decisions.md.
- [x] Verify free-exercise-db (873 exercises, Unlicense, dist/exercises.json
      is live; NDJSON dist is not committed upstream, seed script transforms
      JSON itself).

## Phase 1: repo + database (done in-repo, needs a Supabase project to apply)

- [x] Git repo, folder structure, docs.
- [x] Migrations: schema, RLS (append-only via missing policies), views.
- [x] Seed script (`scripts/build-exercise-seed.mjs`) generating
      `supabase/seed/exercises.generated.sql` from upstream.
- [ ] Create Supabase project, `supabase link`, `supabase db push`, run seed.
      Needs Colt's Supabase account. See setup.md.

## Phase 2: MCP server (code done, needs deploy)

- [x] Edge function `mcp-server`: streamable HTTP, stateless per request.
- [x] Auth: constant-time bearer check against `MCP_SECRET`.
- [x] Read tools: search_exercises, get_lift_history, get_recent_sessions,
      get_goal_progress.
- [x] Write tools: upsert_program (unconfirmed), confirm_program,
      set_training_max, set_goal.
- [x] Structured logging + MCP error results.
- [ ] Deploy with `--no-verify-jwt`, set secrets, add mcp-remote entry to
      Claude Desktop config. See setup.md.
- [ ] Smoke test: hand-insert a fake session, ask Claude to analyze it.

## Phase 3: PWA (code done, needs project URL + deploy)

- [x] Vite + React + TS scaffold, PWA manifest, service worker.
- [x] Offline outbox: IndexedDB queue, client UUIDs, replay on reconnect,
      sync status surfaced in UI.
- [x] Screens: Today, Set entry (steppers + rest timer), History
      (e1RM chart + weekly volume bars), End session.
- [x] Error tracking module (console + optional Sentry DSN).
- [x] Tests: outbox replay idempotency, e1RM math, prescription resolution.
- [ ] Point at the real Supabase project (env), deploy static host, install
      to phone home screen.

## Phase 4: first real use (Colt)

- [ ] Log training maxes via Claude (set_training_max).
- [ ] Paste a coach screenshot, confirm parse, upsert + confirm program.
- [ ] Log one real gym session on the phone, offline at least part of it.
- [ ] Review adherence output with Claude. Expect set-entry UX rework.

## Out of scope (per spec)

Social, in-app routine editor, nutrition, running data, multi-user, RIR,
per-set subjective ratings, set editing of any kind.
