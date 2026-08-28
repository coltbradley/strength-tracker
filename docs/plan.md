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
- [x] Later rounds added delete_program, add_exercise, update_exercise,
      delete_exercise: 12 tools. `upsert_program` now also carries
      `scheduled_date`, `superset_group` and `load_entry`.
- [x] Live smoke test: 401 unauthenticated, initialize, tools/list,
      search_exercises against seeded data.
- [ ] Conversational smoke test in Claude Desktop: set TMs, parse a coach
      screenshot, upsert + confirm a program, analyze the fake session
      (`scripts/fixtures/fake-session.sql`).

## Phase 3: PWA (built and hosted)

- [x] Vite + React + TS scaffold, PWA manifest, service worker.
- [x] Offline outbox: IndexedDB queue, client UUIDs, dead-lettering, replay
      on reconnect, sync status surfaced in UI.
- [x] Screens: Today, Set entry (steppers + number pad + rest strip + plate
      calculator), History (e1RM chart + weekly volume bars), End session.
- [x] Index-card redesign from the Claude Design prototype, verified in a
      live browser walkthrough.
- [x] Planning round: calendar week, plan editor, voids/discards, exercise
      library, supersets, per-set notes, open-session lifecycle.
- [x] Error tracking module (console + optional Sentry DSN).
- [x] Tests: 82 across outbox, units, e1rm, prefill, plates, Stepper,
      settings, data, format.
- [x] Hosting: every push to main publishes to GitHub Pages via the `deploy`
      workflow (the Supabase auth redirect allowlist is a dashboard step —
      see docs/setup.md).
- [ ] Email template with the OTP code needs custom SMTP or a paid plan
      (free tier restriction); until then sign in via the magic link, or
      paste the link into the installed app. Template is committed and
      config push is one command.

## Phase 3.5: adversarial review (done)

- [x] Five finder agents + verification pass over the whole repo; 20
      confirmed findings, all fixed (see decisions.md, review round entry).

## Phase 3.6: polish round (done)

Driven by five audit reports in `.audit/`. Owner decisions in `.audit/PLAN.md`.

- [x] A1 CSS foundation: theme.css folded into styles.css behind
      `@layer`, ink/type/spacing tokens, ~185 dead lines removed, WCAG AA
      contrast throughout, accent → #bd5410, Chivo self-hosted + precached.
- [x] A2 Correctness: DONE requires `ended_at`, discard-empty requires a
      server-confirmed zero, one Start gate, cache invalidation on finish,
      PDT chart labels, keyset-paginated `getLastActuals`.
- [x] A3 Settings: typed registry, versioned envelope + v0→v1 migration,
      inventories, per-exercise prefs, export, reset, outbox-aware sign out.
- [x] B1 Session screen: staged values, last-time reference, per-exercise
      rest and increments, per-side logging UI.
- [x] B2 Sheet primitive: `role="dialog"`, focus trap, ESC, scroll and
      keyboard inset; one shared exercise picker replacing three copies.
- [x] C1 Responsive + consolidation: breakpoints, row/button family
      collapse, touch targets, `min-width: 0` sweep. (Class-prefix rename
      declined after measuring — see the commit body for 018239b.)
- [x] C2 Features: training max UI, adherence readback, session duration,
      tonnage and bodyweight. (Prescription notes and export landed early, in
      A2/A3. PR detection not done.)
- [x] C3 Migration + docs: per-side `load_entry` on `sets` and
      `prescriptions` (migration `20260827160000_per_side_load.sql`,
      validated in PGlite), decisions.md, flows.md, CLAUDE.md, this plan.

## Phase 3.7: multi-user (done)

Migration `20260827180000_multi_user.sql` plus the client half. See
decisions.md for the reasoning and docs/setup.md for the runbook.

- [x] Per-user MCP identity: `mcp_tokens` (SHA-256 digests), per-request `Db`,
      `scripts/issue-mcp-token.mjs`. Legacy `MCP_SECRET`/`OWNER_USER_ID` still
      work so an existing client config survives the deploy.
- [x] Per-user timezone: `app_tz(user_id)`, views bucket by the row owner's
      zone, `app_config.tz` demoted to the deployment default.
- [x] Custom exercises are owned (`exercise_owners` + claim trigger); the
      seeded library stays shared. MCP reads scope by owner in code because
      the service role bypasses RLS.
- [x] Outbox items carry their owner; another user's writes are held, never
      replayed or dropped. Device cache is claimed per user and cleared on
      change.
- [x] Client interop: CORS + preflight, unauthenticated `/health`, `x-api-key`
      accepted, RFC 9110 `WWW-Authenticate` on 401, 503 (not 401) when the
      token store is unreachable. Pinned by `lib/protocol.test.ts`.
- [ ] OAuth authorization server, for clients that refuse static API keys.
      Deliberately not built — see decisions.md.

## Phase 3.8: in-app plan authoring (done)

Reverses the "in-app routine editor" non-goal — see decisions.md. No migration:
the RLS write policies for `programs` / `planned_workouts` / `prescriptions`
already existed.

- [x] Create a planned day from the calendar ("Plan this day" on an empty
      date, "Plan a workout" when there is no program at all). Dated by
      construction; creates the first program itself when none exists.
- [x] Adding an exercise opens its editor on the new row, so sets/reps/load
      are set in the same gesture rather than hunted for afterwards.
- [x] Reorder exercises within a day; rename a day.
- [x] Ramp rows are marked in the editor, so it agrees with Today's grouped
      rendering instead of silently disagreeing.
- [x] An undated day says it is off the calendar.

## Phase 4: first real use

- [ ] Log training maxes via Claude (set_training_max).
- [ ] Paste a coach screenshot, confirm parse, upsert + confirm program.
- [ ] Log one real gym session on the phone, offline at least part of it.
- [ ] Review adherence output with Claude. Expect set-entry UX rework.

## Out of scope (per spec)

Social, nutrition, running data, RIR,
per-set subjective ratings, set editing of any kind.

Considered in the polish round and declined for now (see `.audit/PLAN.md`
and feature-gaps G1/G2/G6): time-based sets (planks, carries), e1RM for
bodyweight plus added load, per-set RPE. Also standing: streaks, badges,
month grids, mid-session reorder, "pause".
