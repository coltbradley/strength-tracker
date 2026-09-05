# CLAUDE.md

Strength log + Claude programming layer. Multi-user, public repo.

A coached lifter logs sets on their phone (PWA). Claude reads the log via MCP to
analyze progress and writes programming parsed from coach screenshots. The coach
programs. Claude parses, analyzes, and proposes. The app captures.

## Layout

- `supabase/migrations/`: schema, RLS, views. Numbered SQL, never edit an
  applied migration, add a new one.
- `supabase/functions/mcp-server/`: MCP server as a Supabase Edge Function
  (Deno, streamable HTTP). Tools in `tools/`, shared code in `lib/`.
- `pwa/`: React + Vite PWA. Offline-first, IndexedDB write queue.
- `scripts/`: seed generation and dev utilities (Node).
- `docs/`: plan, architecture, decisions, setup, deploy. `docs/decisions.md`
  is the log of every deviation from the original spec and why.
  `docs/deploy.md` is the per-release runbook — follow it instead of
  rediscovering the deploy steps.

## Hard rules

- `sets`, `sessions`, `set_voids`, and `set_notes` are written ONLY by the
  PWA. MCP tools never write them.
- `sets` is append-only. No update/delete paths anywhere (RLS enforces this).
  Corrections are voids: an insert into `set_voids` (itself append-only)
  hides a set from every view. Never add an update or delete policy.
  "Editing" a logged set in the PWA is a void PLUS a new row at the same
  `set_index` with the same `performed_at`, rest and prescription
  (`pwa/src/lib/corrections.ts`); only load, reps and type change. Never
  give it the next index: that is how a corrected set 2 became set 5.
  `set_notes` is the one editable set-adjacent row (a user annotation,
  last-write-wins) — the sessions.notes mutability class, never a way to
  edit the set itself.
- `sessions` are soft-deleted only (`discarded_at`); no delete policy exists.
  A discarded session leaves every view but stays in Postgres. So are
  `programs` and, since 20260901030000, `planned_workouts` — one soft-delete
  idiom, one column name, three tables. A HARD delete of a planned day
  cascaded to its prescriptions and, through `on delete set null`, severed the
  link from every set ever logged against them: the sets survived but what the
  plan ASKED for did not, and `sets` being append-only, nothing could restore
  it. Prescriptions deliberately have NO discarded_at of their own — a
  prescription has no life outside its day, and a second nullable timestamp
  would mean every read filtering on two. A `before delete` trigger refuses to
  delete a prescription that has sets against it instead; one nothing has been
  logged against still deletes freely, which is the ordinary edit case.
  Soft-deleting in the CODE was not enough. Both migrations left the DELETE
  policies standing, so anyone holding a session token could still perform that
  cascade straight through PostgREST — the PWA is not the boundary, RLS is.
  Since 20260905010000 `programs_delete` and `exercise_owners_delete` are gone
  outright (deleting your own ownership row does not unshare a custom exercise,
  it makes the row readable by NOBODY), and `pw_delete` is NARROWED to
  `pw_delete_template` rather than dropped: the PWA hard-deletes templates
  today, a template is dateless by constraint so nothing can ever have been
  logged against its own prescriptions, and RLS refuses by returning ZERO ROWS
  rather than an error, so a bare drop would have made that button silently do
  nothing. The danger was never "delete" as a verb, it was deleting a DATED
  day. `rx_delete` stays for the same reason the trigger exists.
- Planned tables (`programs`/`planned_workouts`/`prescriptions`) are written
  by BOTH the MCP server (service role, program parsing) and the PWA (RLS
  owner policies, plan editor). The PWA can now CREATE a day too, not just
  edit one: `createPlannedWorkout` always sets `scheduled_date` (an undated
  day leaves the calendar entirely) and makes a confirmed program when none
  exists. A user-authored program is confirmed on creation; only what CLAUDE
  writes needs the separate confirm step. `planned_workouts.notes` is coach notes from
  the parse (the coach's OWN words, brief — parse caveats go in chat);
  `plan_note` is the user's own and the parse must not touch it.
  `prescriptions.superset_group` (1=A…) marks supersets; consecutive
  same-exercise prescriptions are a ramp and render as one grouped entry.
  `prescriptions.section` names a PART of the day. MAIN WORK is the null
  section and is rendered as a LABEL on each run of unsectioned blocks, never
  as a block of its own: `moveEntry` relies on an unsectioned exercise BEING
  its own block, which is what lets the arrows walk it through the whole day,
  and gathering main work into one block would confine it and silently change
  what those arrows do. The label appears only once the day has a named part —
  a day with one part needs no heading — and the plan editor and the session
  screen must apply the same rule, or the two describe different days.
  delete_program removes a plan (confirmed ones only with the explicit flag
  after user approval); logged sessions/sets always survive it.
- Programs written by Claude land unconfirmed (`confirmed_at IS NULL`) and
  require a separate `confirm_program` call after user approval in chat.
- `update_planned_workout` edits ONE day of an existing program in place, and
  it is the correct tool for ANY change to a program that already exists:
  filling in an empty day, swapping an exercise, adding a superset, changing
  sets or loads. `upsert_program` writes a WHOLE program and refuses to touch a
  confirmed one, so it cannot edit at all — a model reaching for it to add a
  day can only write a SECOND program with the same name, which is exactly what
  left a real user with two live plans and four days on her calendar she never
  trained. Reserve `upsert_program` for a genuinely new program. The unit is
  the DAY, and its prescriptions are replaced entirely: order, supersets,
  sections and ramps are all adjacency between rows, so a per-row patch would
  let a caller tear a superset in half without ever naming it. An empty list is
  legal, because the wholesale rewrite could not restate a day with no
  prescriptions and silently dropped every empty day it touched. New rows are
  parked above the old ones and land after the delete — PostgREST has no
  transactions, and a failure mid-write should leave a visible duplicate rather
  than an emptied day. A day with logged sets against it is refused, matching
  the trigger that guards the same thing in Postgres. Editing a day of a
  CONFIRMED program takes `confirm_change=true` after approval in chat and is
  live the moment it lands; there is no confirm step after it.
- Derived metrics (e1RM, volume, adherence, rest) live in SQL views only,
  never stored. Views are `security_invoker` so RLS applies, and every
  set-derived view reads `v_live_sets` (voids and discards excluded) — never
  `sets` directly.
- Exercise library sources: 'free-exercise-db' (generated seed), 'curated'
  (hand-maintained seed), 'edited' (a seeded row a human changed), 'custom'
  (MCP add_exercise / PWA). The column carries TWO facts and the vocabulary
  keeps them apart: which seed may overwrite the row, and whether it is
  shared. Only 'custom' is private. Every policy and every MCP guard branches
  on `= 'custom'` vs `<> 'custom'`, so the other three land on the shared side
  without any of them needing to know the difference, and a CHECK closes the
  set because a typo here ('Custom') would publish a private row.
  Each seed only updates its own source's rows; update_exercise re-tags an
  edited SEEDED row 'edited' so re-seeds can't revert it, and it stays shared.
  (It re-tagged to 'custom' until 20260901010000: that made the row private,
  and private to NOBODY, because the claim trigger fires on insert and the MCP
  path is the service role with no auth.uid(). The row became readable by no
  one, and v_resolved_prescriptions inner-joins exercises, so every
  prescription naming it silently left the plan.) delete_exercise removes ONLY
  custom exercises that nothing references (FKs enforce it); seeded or
  referenced exercises are never deleted — history is never orphaned.
  `exercises` never grows a column whose value differs per VIEWER, and never a
  column the generated seed cannot populate: 873 rows would sit null forever
  and each re-seed would write it back. Ownership therefore lives in
  `exercise_owners`: SEEDED rows have no entry and are shared by everyone, a
  'custom' row belongs to one person. An `after insert` trigger claims it for
  `auth.uid()`; the service-role (MCP) path has no auth.uid() and writes the
  owner row itself.
  The service role bypasses RLS, so every MCP read of `exercises` must scope
  by owner in code — `requireExercise` is the gate. Another user's custom
  exercise reports as UNKNOWN, never as forbidden. Movement hints (unilateral,
  bar type) are derived client-side from `equipment` and the name; overrides
  live in device-local per-exercise settings.
  The per-user-column rule has exactly one carve-out, `updated_at` /
  `updated_by` (20260905020000), and it rests on the distinction the rule is
  really about. Those two are a single GLOBAL fact about the row rather than a
  different answer per reader; null there IS the answer ("unmodified since it
  was seeded"), not a placeholder; and neither seed's ON CONFLICT clause names
  them, so no re-seed writes them back. A `before update` trigger stamps them,
  an explicitly supplied `updated_by` beats `auth.uid()` so the service-role
  path can name the token's user, and an update that changes nothing stamps
  nothing. They are an AUDIT TRAIL and nothing else: no policy, no view and no
  MCP guard may branch on `updated_by`. It answers "who touched this", never
  "whose is this" — ownership remains `exercise_owners` and only
  `exercise_owners`, which is exactly the distinction `source` failed to make.
  `exercises.name` is bounded (20260905020000) to 80 characters of single-line
  printable text: no C0/C1 controls, no U+2028/U+2029, no invisible formatting
  characters. It is the one field a user writes that every OTHER user's coach
  reads — through `search_exercises`, `get_program` and the per-turn context
  block — which makes it untrusted cross-user input rather than a label. The
  constraint names what is dangerous instead of whitelisting what is allowed,
  so it cannot refuse a script nobody here happens to read.
- All client writes carry client-generated UUIDs; replay is idempotent
  (`on conflict do nothing`). Do not break this.
- A planned day is DONE only when its session has `ended_at`. An open session
  must never mark its day done — that showed RESUME and "Start again" at
  once and let an abandoned start count as training.
- `v_plan_workouts` carries `exercise_count`, and a planned day with zero is a
  DRAFT, not a MISSED workout. "Plan a workout" creates the dated day and then
  opens its editor, so abandoning it there leaves a real, dated, empty day that
  accused someone of skipping a session nobody ever programmed. DRAFT sits
  ahead of every date check and behind DONE and SKIPPED: what actually happened
  outranks emptiness, but nothing that never existed should read as something
  you failed to do. The count rides on the row because Today loads prescriptions
  lazily and otherwise has no idea what any other cell in the week strip holds.
- "Empty session" is a SERVER-confirmed zero. A local set count of zero can
  simply mean this device never had the cache; never lead with a destructive
  default on an unconfirmed count. So the overnight sweep may COMPLETE any open
  session from anywhere — sets that arrive later still belong to it, and
  `ended_at` only says the day is over — but may DISCARD only the session this
  device holds the active pointer for. Both emptiness signals are local truths
  (`queuedSetCount` reads THIS outbox, `lastSetAt` reads a server the other
  phone has not reached), and a foreign session that looks empty is left OPEN
  for Today's orphan card: an open session is a card someone dismisses, a
  wrongly discarded one is training only SQL can find. The same rule one level
  down — a session bootstrap that THREW is not an empty log, so `setsFailed`
  disables LOG and says why rather than computing `set_index` 0 on top of sets
  it could not read.
- Units are kg in the database everywhere. Display conversion is client-side.
- Identity: the MCP server has NO auth.uid() (it authenticates with a bearer
  token, not a session) and runs as the service role, which bypasses RLS. The
  token IS the identity: `mcp_tokens` maps its SHA-256 to a user, and every
  tool must filter and stamp `db.ownerId` itself. Build the `Db` handle per
  request (`dbFor`); NEVER cache it or anything derived from a user id at
  module scope — edge isolates are reused across callers, and that is how one
  person's data reaches another. The connection may be cached; the identity
  may not.
- Calendar days are per user: `app_tz(user_id)`, defaulting to `app_config.tz`
  then UTC. Views pass the user_id OF THE ROW they bucket, not `auth.uid()`,
  so the answer is the same on the PWA and service-role paths. The PWA keeps
  using the device clock — the phone travels with the lifter — but that day has
  to be a value that KEEPS UP with the clock, never one read during render. An
  installed PWA is not a page load: iOS suspends and resumes it with the same
  heap, so a screen left open on Monday evening still offered MONDAY's Start
  button on Tuesday and filed the whole workout against Monday's planned day.
  `useLocalToday` watches a midnight timer, `visibilitychange` and `online`,
  none of which is sufficient alone, and computes the boundary from the
  calendar date so DST lands on the real one. The day-change re-run of
  reconciliation must stand down while this device holds a LIVE session, or a
  23:50 start is auto-completed at its last logged set out from under someone
  still lifting.
- Every queued write carries the id of the user who made it. The flusher HOLDS
  another user's items rather than replaying them (payloads leave `user_id` to
  the DB default, so replaying as the wrong user would misattribute a set
  permanently — `sets` is append-only). Held, never dropped. An UNKNOWN
  identity holds too: `getCurrentUserId()` returns null for "signed out" and
  for "not known yet" alike, and "not known yet" is the state the app BOOTS
  in — start() flushes after two IndexedDB round trips while identity is a
  network token refresh. Treating null as permission is how one person's set
  reaches another's log. Because holding is only safe if something un-holds
  it, `start()` also re-runs the queue when identity arrives.
- A 401 whose refresh THREW is not a 401 whose refresh returned false. Only
  the second is an answer; the first means we never found out, and must stay
  retryable. The refresh is attempted once per flush, so treating a timeout as
  a verdict dead-letters the whole queue for a transient condition.
- For the same reason, a null session carrying a RETRYABLE error is not a
  sign-out. `getSession()` tries to refresh an expired token and, when it
  cannot reach the server, returns `session: null` with an error — the same
  shape as a real sign-out, which put a lifter in a basement gym on the Login
  screen and HELD every write she queued. `pwa/src/lib/persistedSession.ts`
  reads the session auth-js has on disk so `useAuth`, `currentUser` and the
  outbox transport can tell "no" from "we could not ask". That fallback is
  IDENTITY, NEVER AUTHORIZATION: it answers whose data this device is holding
  so the shell renders and the outbox stamps an owner, and every request still
  carries the real token and is still refused by the server if that token is no
  good. It reads the auth library's private storage key, which is a coupling,
  so it is deliberately loose about it — any unexpected shape, any unreadable
  store, any missing refresh token returns null and puts the app back on the
  old behaviour.
- The device cache belongs to one user, tracked by a localStorage marker, and
  is cleared when that changes. Cache keys are NOT namespaced by user on
  purpose: one marker has one place to be wrong, forty key builders do not.
- `load_kg` is ALWAYS the TOTAL system load — the whole weight moved in one
  rep. A pair of 30 kg dumbbells is stored as 60. Never store a per-hand
  value in `load_kg`; every view, chart and MCP read assumes totals and would
  be silently wrong. `sets.load_entry` / `prescriptions.load_entry`
  (`'total'` | `'per_side'` | NULL) record how the number was ENTERED, so the
  UI can show "30 × 2" and Claude can quote it back honestly. NULL means
  UNKNOWN, never "confirmed total": those rows predate the convention and
  `sets` is append-only, so they can never be corrected. Single-arm work is
  `'total'` (one dumbbell IS the whole system for that rep); what is per side
  there is the reps, which are deliberately not modelled. BOTH write paths
  resolve the convention identically now — the session screen and the plan
  editor (the scheme sheet on the way in, the row editor for rows that already
  exist) derive per-hand from the exercise's `equipment` and name and show the
  same control with the same words, so a prescription typed as "20 per hand" is
  stored as 40 with `load_entry` 'per_side' and reads back as entered. The plan
  editor wrote neither until it learned this, which is why a real user's whole
  plan is stored at half; it is also why the editor loads the exercise library
  on mount rather than when the picker opens, since a row editor that cannot
  tell dumbbells from a barbell is how that happened.
- Settings are DEVICE-LOCAL, not per-user: two people sharing one phone share
  its plate inventory and per-exercise prefs. They are in a typed registry
  (`pwa/src/lib/settings.ts`)
  behind a versioned envelope; migrations there are additive too. There is no
  `user_settings` or `exercise_prefs` table and adding one needs a decision
  entry: it would create a third write-ownership class for data no view and
  no MCP tool reads. Accepted: settings do not sync across devices.
- App updates must never lose device data: the IndexedDB database
  ("strength-log") holds unsynced sets in the outbox. Version bumps must be
  strictly additive (see the comment in `pwa/src/lib/db.ts`); never rename
  the database, delete stores, or clear storage in an update path. Postgres
  migrations are equally append-only once deployed. The same rule governs the
  SERVICE WORKER: `registerType` is "prompt", never "autoUpdate", because
  autoUpdate plus `registerSW({immediate:true})` reloads the open page the
  moment a build lands — mid-set that takes the staged reps, the load and any
  half-typed note. But a waiting worker also has to be NOTICED: the browser
  only looks on registration, so main.tsx checks on every return to the
  foreground and hourly, and applies immediately when no session is open,
  deferring to the next hidden only when one is. Deferring without checking
  is how a shipped build sits unnoticed for days; that has happened once.
- The outbox is the only copy of an unsynced set, and WebKit clears IndexedDB
  after about a week idle, so `navigator.storage.persist()` is requested at
  startup. Best-effort and never awaited on the boot path.

- Planned days have STRUCTURE beyond a flat list, and all of it is expressed
  as adjacency rather than as new tables. Consecutive prescriptions naming the
  same exercise are a RAMP; `superset_group` (1=A…4=D) pairs exercises to
  alternate; `section` is a heading ("Activations", "Abs") that consecutive
  rows share. A fourth way to say "these rows belong together" needs a
  decision entry, not a table. The unit of grouping and of reordering is the
  ENTRY (a ramp, a superset), never one row — moving or sectioning a single
  row tears those apart, which is a bug class this repo has already had.
- `prescriptions.tracking` is 'reps' (weight and reps) or 'done' (a tick, for
  activations and mobility). A tick writes a REAL row in `sets`: reps 0 at
  load 0, both already legal. Never invent a second completion record — no
  view, chart or MCP tool would know how to read it. Volume and e1RM exclude
  it through the filters they already have; do NOT add a `tracking` filter to
  those views, which would couple the analysis to the plan the way
  `v_adherence` deliberately does not.
- A TEMPLATE is a planned day with no date (`is_template`), not a table. It
  can never carry a `scheduled_date` (checked), and every plan read goes
  through `v_plan_workouts`, which drops templates AND days whose program is
  discarded. Filter there, never at the call site: a filter you have to
  remember is one someone will forget.
- `programs` are soft-deleted (`discarded_at`), like sessions. Nothing an LLM
  can write is hard-deleted. The one exception is `upsert_program`'s
  compensating rollback, which removes a fragment of a failed write that
  nobody ever saw.
- Notes have four homes and they are not interchangeable: `planned_workouts.notes`
  is the COACH's words from a parse and `plan_note` is the user's own (a parse
  must never touch it); `prescriptions.notes` is per-exercise-per-day;
  `set_notes` is one logged set; `exercise_notes` is a standing cue for a
  MOVEMENT, keyed (user_id, exercise_id) because `exercises` is a shared
  seeded library that never grows a per-user column.
- `coach_memory` holds standing facts about the person (injury, constraint,
  preference, context) — not goals, which `goals` measures against real sets.
  It reaches the coach through the per-turn CONTEXT BLOCK, never a tool call:
  memory that must be fetched is memory that gets forgotten. It is deletable,
  unlike the training record, because a fact that stopped being true makes
  every future answer worse.

## The coach (supabase/functions/coach)

- An edge function calling the Anthropic API with `claude-sonnet-5`, giving it
  the EXISTING MCP server as its tool surface via the MCP connector. One
  authorization boundary, not two. The API key is a Supabase secret and never
  reaches the browser; the caller authenticates with their Supabase session.
- The MCP connector needs a plaintext bearer and `mcp_tokens` stores only
  digests, so the function mints one per turn with a short `expires_at` and
  revokes it in the `finally` rather than leaving a live credential to time
  out; the TTL is the backstop for a function that dies mid-turn. Permanent
  tokens (anything a person pastes into a client) have `expires_at` NULL and
  must keep working untouched.
- `delete_program`, `delete_exercise` and `update_exercise` are disabled for
  the coach at the connector layer. Claude Desktop keeps them. The first two
  are destructive; the third writes OTHER PEOPLE's data, because the library is
  SHARED and renaming a seeded row puts that name in every other account's
  model context — and a screenshot the coach is asked to parse is exactly the
  untrusted input that would ask for it. Turning a tool off converts "the
  prompt says ask first" into something an injected instruction cannot reach.
  `upsert_program` stays, because drafting a plan is the job and unconfirmed is
  a real gate, if a softer one.
- Uploaded files are JSON-encoded with their provenance, never wrapped in a
  concatenated delimiter a CSV could close from the inside. Model output is
  rendered to ELEMENTS, never `dangerouslySetInnerHTML` — that path would turn
  prompt injection into script injection.
- A turn is completed and RECORDED whether or not the client is still
  listening, against a client-chosen `turn_id`, so closing the app mid-answer
  loses nothing. Usage is written in a `finally`, or an aborted turn is billed
  and invisible to the quota. A turn whose usage cannot be RECORDED must not
  run: supabase-js returns a PostgREST error rather than throwing, so a failed
  usage write was invisible and left `overLimit()` counting zero, which
  disabled both caps. The error is read now, a malformed `turn_id` is a 400
  before any tokens are spent, a reused one is a 409, and a write that fails
  anyway retries once without the id so the turn still counts. Nothing the
  client sends is trusted by the checks that depend on its shape — `unit` is
  whitelisted to kg or lb before it reaches the SYSTEM prompt, attachment
  shapes are validated before their sizes are measured, and an over-length turn
  is a 413 rather than being dropped from the array.
- `coach_usage` records tokens, cost, latency, tools AND the prompt and
  response text. That last part is a product decision, not a technical detail:
  whoever runs the deployment can read the conversation. `COACH_LOG_CONTENT=off`
  disables it.

## Commands

```bash
# db: start local stack, apply migrations + seed (needs Docker)
supabase start && supabase db reset

# db without Docker: run the whole migration chain + views + RLS in PGlite.
# This is the validation path this project actually uses — see decisions.md.
npm --prefix scripts install && node scripts/validate-db.mjs

# mcp server: serve locally
supabase functions serve mcp-server --env-file supabase/functions/.env

# pwa
cd pwa && npm install && npm run dev
cd pwa && npm test          # vitest
cd pwa && npm run build     # tsc + vite build

# regenerate exercise seed from free-exercise-db
node scripts/build-exercise-seed.mjs

# mint an MCP bearer token for one user (prints it once + the SQL to activate)
node scripts/issue-mcp-token.mjs --user <uuid> --label "Who · which client"
```

## Conventions

- TypeScript strict everywhere. Edge function code is Deno (npm: specifiers);
  PWA and scripts are Node.
- Errors: never swallow. PWA reports through `pwa/src/lib/errors.ts`
  (console + optional Sentry via env). Edge function logs structured JSON.
- Keep modules small and swappable; the spec expects the set-entry UX to be
  rebuilt at least once.
- One stylesheet (`pwa/src/styles.css`), layered tokens → base → components →
  utilities. The theme boundary is the token layer, not a second file: a
  colour must be changeable in exactly one place. Do not re-inline colour
  literals, and do not reintroduce a theme.css.
- Text colours must clear WCAG AA. The accent (#bd5410) is 4.08:1, which is
  AA for large text and UI, not for small prose — never set body copy in it.
- Fonts are self-hosted in `pwa/public/fonts` and precached. The service
  worker caches nothing cross-origin, so a webfont `@import` silently breaks
  the offline promise.
