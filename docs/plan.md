# Build plan

Status legend: [x] done, [~] in progress, [ ] not started.

## Phase 0: verify the spec (done)

- [x] Auth spike, by research instead of code. Result: static bearer via
      mcp-remote, OAuth not needed. See decisions.md.
- [x] Verify free-exercise-db (873 exercises, Unlicense, dist/exercises.json
      is live; NDJSON dist is not committed upstream, seed script transforms
      JSON itself).

## Phase 1: repo + database (done)

- [x] Git repo, folder structure, docs. Public on GitHub, CI green.
- [x] Migrations: schema, RLS (append-only via missing policies), views,
      app_config (timezone).
- [x] Seed script (`scripts/build-exercise-seed.mjs`) generating
      `supabase/seed/exercises.generated.sql` from upstream.
- [x] Supabase project created (us-west-1), migrations pushed, 873 exercises
      seeded, timezone set, owner user created.

## Phase 2: MCP server (deployed)

- [x] Edge function `mcp-server`: streamable HTTP, stateless per request.
- [x] Auth: constant-time bearer check against `MCP_SECRET`.
- [x] Read tools: search_exercises, get_lift_history, get_recent_sessions,
      get_goal_progress. Write tools: upsert_program (unconfirmed),
      confirm_program, set_training_max, set_goal.
- [x] Structured logging + MCP error results.
- [x] Deployed `--no-verify-jwt`, secrets set, mcp-remote entry added to
      Claude Desktop config (restart Claude Desktop to pick it up).
- [x] Live smoke test: 401 unauthenticated, initialize, tools/list (8),
      search_exercises against seeded data.
- [ ] Conversational smoke test in Claude Desktop: set TMs, parse a coach
      screenshot, upsert + confirm a program, analyze the fake session
      (`scripts/fixtures/fake-session.sql`).

## Phase 3: PWA (code done, needs hosting)

- [x] Vite + React + TS scaffold, PWA manifest, service worker.
- [x] Offline outbox: IndexedDB queue, client UUIDs, dead-lettering, replay
      on reconnect, sync status surfaced in UI.
- [x] Screens: Today, Set entry (steppers + number pad + rest strip + plate
      calculator), History (e1RM chart + weekly volume bars), End session.
- [x] Index-card redesign from the Claude Design prototype, verified in a
      live browser walkthrough.
- [x] Error tracking module (console + optional Sentry DSN).
- [x] Tests: 33 across outbox, units, e1rm, prefill, plates, Stepper.
- [ ] Deploy to a static host (needs Cloudflare/Vercel login), set the
      production URL in Supabase auth redirect allowlist, install to phone.
- [ ] Email template with the OTP code needs custom SMTP or a paid plan
      (free tier restriction); until then sign in via magic link in the
      browser. Template is committed and config push is one command.

## Phase 3.5: adversarial review (done)

- [x] Five finder agents + verification pass over the whole repo; 20
      confirmed findings, all fixed (see decisions.md, review round entry).

## Phase 4: first real use

- [ ] Log training maxes via Claude (set_training_max).
- [ ] Paste a coach screenshot, confirm parse, upsert + confirm program.
- [ ] Log one real gym session on the phone, offline at least part of it.
- [ ] Review adherence output with Claude. Expect set-entry UX rework.

## Out of scope (per spec)

Social, in-app routine editor, nutrition, running data, multi-user, RIR,
per-set subjective ratings, set editing of any kind.
