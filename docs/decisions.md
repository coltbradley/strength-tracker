# Decision log

Deviations from the original spec, with reasons. Newest last.

## 2026-08-25 auth: static bearer token via mcp-remote, not OAuth

The spec flagged MCP OAuth 2.1 on Supabase as the top risk and said to spike it
first. Spiked via research instead of code, findings:

- The claude.ai / Claude Desktop custom connector UI supports only OAuth (with
  dynamic client registration) or no auth. Static header entry is broken and
  the feature request was closed "not planned" (anthropics/claude-ai-mcp
  issues #112, #644).
- `mcp-remote` (geelen/mcp-remote) supports `--header "Authorization:Bearer x"`.
  It is the standard stdio-to-HTTP bridge for Claude Desktop and keeps the
  secret in local config, out of any cloud connector UI.
- Supabase officially documents MCP servers on Edge Functions with streamable
  HTTP, deployed with `--no-verify-jwt` so the function does its own auth.
- Supabase Auth does now ship an OAuth 2.1 server with DCR and PKCE
  (docs: guides/auth/oauth-server/mcp-authentication), so the claude.ai
  connector path exists if ever needed from mobile/web. It is overkill for one
  user and DCR is open registration by default, which is its own risk.

Decision: v1 auth is a long random bearer token stored in Claude Desktop's
config (via mcp-remote --header) and in the edge function's secrets
(MCP_SECRET). Constant-time comparison in the function. OAuth 2.1 documented
as the upgrade path, not built.

Consequence: the spec's line "Claude connects from Anthropic's cloud" is wrong
for this setup. mcp-remote runs locally and connects out, so the endpoint
technically only needs to be reachable from this machine. Keeping it on
Supabase public HTTPS anyway: it's free, and it keeps the claude.ai connector
door open.

## 2026-08-25 MCP writes use the service role pinned to one user id

MCP requests authenticate with the bearer token, not a Supabase Auth session,
so there is no `auth.uid()` on that path. The edge function uses the service
role key and stamps every write with the `OWNER_USER_ID` secret. Code in
`lib/db.ts` is the only place the service client is constructed, and every
tool query filters or stamps that user id. RLS still fully protects the PWA
path. Revisit if this ever becomes multi-user (it shouldn't).

## 2026-08-25 two extra write tools: set_training_max, set_goal

The spec's six tools leave `training_maxes` and `goals` with no write path at
all: the PWA has four screens (none is TM/goal entry) and Claude couldn't
write them either. Percentage-based prescriptions are unresolvable without a
TM row, and the spec itself says that's a hard requirement. Added two small
write tools. Both are low blast radius (no history, no training record).
Tool count is now eight.

## 2026-08-25 exercises keep the upstream slug as primary key

free-exercise-db ids are stable slugs (`Barbell_Squat`). Using them directly
makes seeds idempotent, programs readable in raw SQL, and re-seeding safe.
Custom exercises use the same slug format with `source = 'custom'`.
Verified upstream: 873 exercises, Unlicense, `dist/exercises.json` is the
committed artifact (the NDJSON make target exists but its output is not
committed, so the seed script transforms JSON itself, no jq dependency).

## 2026-08-25 append-only enforced by RLS, not just convention

`sets` has insert and select policies only. With RLS deny-by-default, update
and delete are impossible for the client no matter what the app code does.
`sessions` also gets update (ending a session edits the row) but no
delete. This is the mechanism, not a lint rule; do not add the missing
policies later without a decision entry here.

## 2026-08-25 client-generated UUIDs for sessions and sets

The offline queue replays inserts with `on conflict do nothing`. That is only
idempotent if the client owns the id. `sessions.id` and `sets.id` have no
database default on purpose; the PWA generates UUIDv4 at creation time.

## 2026-08-25 repo is public open source

Decided mid-build. Consequences, applied retroactively:

- No secrets, project refs, user uuids, emails, or personal identifiers
  anywhere in the repo. Secrets exist only in deployment (edge function
  secrets, local Claude Desktop config, PWA build env). The generated seed
  and all `.env*` files are gitignored.
- Security cannot rely on the code being private: docs/security.md holds the
  threat model and argues each layer (RLS floor, invoker-rights views,
  tool-surface-as-authorization, constant-time auth, confirm gate).
- Every non-obvious design choice gets a technical rationale in this file;
  the README fronts the five load-bearing claims. Open-source readers should
  be able to reconstruct the reasoning, not just the code.
- License: MIT for the code. Exercise seed data is Unlicense upstream
  (public domain), compatible, attributed in the README.

## 2026-08-25 database validated in PGlite, not a local Supabase stack

The dev machine has no Docker, so `supabase start` is unavailable, and
eyeballing 300 lines of SQL is not verification. `scripts/validate-db.mjs`
runs the real migrations, seed, and fixtures inside PGlite (Postgres compiled
to WASM, runs in Node) with a small shim for the `auth` schema
(`auth.users`, `auth.uid()` reading a session GUC) and an `authenticated`
role, then asserts view math and RLS behavior (append-only, cross-user
isolation). Not identical to the Supabase platform (no PostgREST layer, shim
instead of GoTrue), but it executes every line of committed SQL and the
core invariants. CI can run it with zero infrastructure.

## 2026-08-25 kg everywhere in storage, lb is display-only

Single unit in the database avoids a class of conversion bugs in views and
analytics. The PWA converts at the edge (display and steppers) with a
settings toggle. Plate rounding (nearest 2.5 kg / 5 lb) happens client-side
and in `v_resolved_prescriptions.plate_load_kg` for convenience.

## 2026-08-25 first adversarial review round: what it changed

Five finder agents (correctness x2, cross-layer contracts, cleanup,
conventions) plus two verifiers ran over the whole repo; 20 findings
confirmed, 1 refuted. The structural fixes, with reasoning:

- **Timezone bucketing via `app.tz`.** Views bucketed dates and ISO weeks in
  DB time (UTC), so a Sunday-evening Pacific session landed in Monday's week
  and could pick the wrong effective TM. Views now bucket through `app_tz()`,
  a function reading the `app.tz` database setting (UTC fallback). One
  setting per deployment, no schema change per user, still stateless views.
- **`goals` gained `unique (user_id, exercise_id)`.** "One goal per
  exercise" was app-layer convention enforced by a non-transactional
  delete-then-insert, which loses the goal on partial failure and duplicates
  it under concurrency. The constraint makes `set_goal` a single upsert:
  atomic, convergent.
- **Program replace inverted to insert-then-delete.** PostgREST has no
  transactions, and deleting the old unconfirmed parse before inserting the
  new one meant a mid-insert failure destroyed the only copy. Now the new
  program lands fully before the old one is removed; a failed attempt can
  leave a stray unconfirmed program (reported in the result), never a lost
  one. Asymmetry chosen deliberately: stray beats gone.
- **Outbox dead-lettering.** Retry-forever on the head item meant one
  permanent failure (FK to a deleted prescription, RLS after sign-out)
  jammed every later write behind it, and the only escape wiped IndexedDB,
  losing training data. Errors are now classified: transient retries,
  permanent parks the item (kept, visible, manually retryable) and the queue
  moves on. The one auto-repair: a set whose prescription was deleted
  server-side retries once with `prescription_id = null`, because the set
  data matters more than the planned-vs-actual link.
- **OTP code fallback on login.** On an installed iOS PWA the magic link
  opens in Safari, whose storage the installed app cannot see, so link-only
  auth locks the app out. The email's 6-digit code, entered in-app, is the
  reliable path.
- **Row caps everywhere PostgREST truncates.** Unbounded ascending queries
  silently drop the newest rows at the 1000-row default cap. History queries
  now order descending with explicit limits and reverse in code, and session
  set counts come from a `v_session_set_counts` view instead of counting
  fetched rows.
- **Editing migrations in place was allowed this round** because nothing has
  been deployed anywhere. First deploy freezes them; after that, changes are
  new migration files only.

Fixed without ceremony: exact-873 seed assertions became ranges (upstream
grows), case-sensitive Bearer scheme check, calendar-invalid dates passing
the ISO regex, per-screen duplicated formatting extracted to shared helpers,
stepper bounds mirroring DB checks.

## 2026-08-25 index-card redesign adopted from a Claude Design prototype

The visual direction came from a design prototype authored against this repo
("codebase fit" variant: same four routes, same append-only model, no schema
changes required except one). What it changed and why:

- **Tap-to-type joins the steppers.** The original "steppers only, no
  keyboard" rule existed to avoid the OS keyboard (viewport shift, locale
  decimal keys). The design keeps that reasoning but adds an in-app number
  pad component: no OS keyboard, no viewport resize, and the big value
  becomes the tap target. Steppers remain underneath. If gym use proves the
  pad unnecessary, it deletes cleanly.
- **Plate calculator, client-only.** `plate_load_kg` only rounds; nothing
  computed a plate stack. Added `lib/plates.ts` (pure, tested greedy split),
  a plate sheet, and a plates-on-hand setting stored in kg (canonical unit).
  Gated to barbell and machine (bar weight 0) equipment only.
- **Rest is now recorded, append-only intact.** `sets.rest_seconds_actual`
  (nullable int) stamps the observed rest BEFORE a set at insert time; no
  update to prior rows, so the RLS append-only design holds. `v_rest`
  remains the timestamp-derived fallback. Folded into the existing migration
  because nothing is deployed yet.
- **No fabricated dates.** The prototype shows weekday dates on Today; the
  schema has no calendar mapping for planned workouts, so the build uses
  DAY N from day_index and real dates only where they exist. Adding a
  start-date column was considered and rejected: the coach's screenshots
  don't reliably carry dates either.

## 2026-08-26 deployment: app.tz became a config table

Deploying to a real Supabase project surfaced a managed-Postgres limit:
`alter database ... set` for custom GUCs is superuser-only, and even the
`postgres` role gets "permission denied to set parameter". The GUC-based
`app_tz()` could never be configured in production. Replaced by migration
`20260825130000_app_config.sql`: a one-row `app_config` table (RLS,
select-only for authenticated since invoker-rights views call `app_tz()` on
that path) and `app_tz()` rewritten to read it. Same UTC fallback, same
contract, needs only DML to configure. First post-deploy migration, so it is
a new file, not an edit.

Also hit: free-tier projects cannot customize auth email templates without a
custom SMTP provider, so the magic-link email cannot show the `{{ .Token }}`
code yet. The template is committed (`supabase/templates/magic_link.html` +
config.toml) and `supabase config push` applies it once SMTP exists or the
plan changes; until then, installed-app sign-in falls back to using the
magic link in the browser.

## 2026-08-25 planning round: dates, notes, corrections, library

User-driven feature round (see the PR/commit for the code). Deviations and
reversals, with reasoning:

- **"No fabricated dates" reversed — planned_workouts.scheduled_date.** The
  earlier decision rejected a date column because coach screenshots don't
  carry dates. The user explicitly wants a week to look forward to and a
  hard rule: a workout can only be STARTED on its scheduled day (edited any
  day). Dates are nullable; undated programs keep the old first-unfinished-
  is-today inference, so nothing is fabricated — dates exist only when the
  user or the parse sets them.
- **Two note fields, two owners.** `planned_workouts.notes` stays coach
  notes (MCP parse). New `plan_note` is the user's pre-workout note, edited
  in the PWA plan editor. Post-workout notes were already `sessions.notes`
  (End screen). Keeping them separate means a re-parse can never clobber the
  user's own words.
- **Sets stay append-only; deletion is voiding.** "Delete a set" is an
  insert into `set_voids` (append-only: select+insert policies only). A new
  `v_live_sets` view (sets minus voids minus discarded sessions) is the one
  definition of "sets that count"; every derived view and every PWA read
  goes through it. The raw row survives for audit.
- **Sessions get soft delete.** `sessions.discarded_at` (update, which RLS
  already allowed) instead of a delete policy. Discard is offered on the End
  screen and on past sessions in History.
- **Skip semantics live at two levels.** A planned workout skips in the DB
  (`skipped_at`, so the week view shows it and Claude can see adherence
  honestly). An exercise skipped mid-session is session-local UI state
  (IndexedDB) — the analytical record is simply that no sets were logged;
  logging a set auto-unskips.
- **Reorder = swap both day_index and scheduled_date** with the adjacent
  workout ("move leg day before push day" means swap the days wholesale).
  day_index is unique per program, so the swap routes through a temp slot.
  Duplicate copies a workout + prescriptions to a chosen date at the end of
  the day order.
- **Planning writes are online-only.** The offline outbox stays reserved for
  session-critical tables (sessions/sets/set_voids). Plan edits are direct
  Supabase writes with toasts; planning happens at home, and keeping the
  outbox op set small protects the replay-ordering guarantees.
- **Exercise library grew a second seed.** `exercises.curated.sql`
  (source='curated', ~105 rows): commercial-gym machines, specialty barbell
  work, unilateral/anti-rotation accessories, runner and climber staples
  missing from free-exercise-db. Each seed's upsert only updates rows with
  its own source tag. MCP gained add_exercise (source='custom') and
  update_exercise, which re-tags edited library rows as 'custom' so
  re-seeding free-exercise-db can't revert an edit. No delete tool: sets
  reference exercises forever.
- **Home button in session.** The session screen footer gained Home; the
  active session keeps running (resume banner on Today) so history and the
  upcoming week are reachable mid-workout.
- **Known accepted risk: reorder swap is non-atomic.** PostgREST has no
  transactions, so the day_index swap is three updates through a temp slot
  (10000+). A failure mid-swap can leave a workout at a temp index; retrying
  the same swap self-heals, and the plan editor's date field remains the
  recovery path. Acceptable for a single-user planner; revisit only if it
  ever actually bites.

## 2026-08-26 open-session lifecycle

Real use on day one surfaced a dead end: a session left open (started, never
finished) kept the resume banner up forever, which hides every Start button —
the flow had no exit that didn't go through the session screen. Fixes, all
client-side (no schema change):

- **End-of-day auto-complete.** On app open, any open session started on a
  previous local day is closed: `ended_at` = its last set's `performed_at`
  (clamped to `started_at`). An open stale session with NO sets is
  auto-discarded instead — completing it would falsely mark the planned
  workout done. Runs in `syncOpenSessions` (data.ts), called from Today's
  mount; offline it silently waits for the next online launch.
- **Stale local pointer cleanup.** If the device's activeSession cache points
  at a session that is ended or discarded server-side, the cache is cleared.
  A session missing from the server entirely is left alone — its insert may
  still be in the outbox.
- **Orphan adoption.** A same-day open session the device has no cache for
  (other device, restored phone) surfaces as a card on Today with
  Resume / Finish / Discard; adoption rebuilds the session caches
  (prescriptions from the plan, extras from already-logged sets).
- **Finish shortcut on the resume banner.** Ending a session no longer
  requires going through the set-entry screen.
- "Pause" is deliberately not a feature: leaving a session open IS the pause,
  and the end-of-day sweep bounds how long it can dangle.
