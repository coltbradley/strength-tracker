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

## 2026-08-26 in-session flow round ("I can't see all the exercises")

Real gym use exposed both a design problem and two state bugs behind the
same symptom. `docs/flows.md` (new) is now the canonical flow map.

- **The workout is a section, not a modal.** The exercise drawer is gone.
  A WORKOUT section lives inside the session scroll: every exercise with
  target, logged count, skip state, the current one marked with an inset
  accent rule; day-level plan/coach notes render at its top. The footer's
  "Workout n/n" button is the always-visible progress glance and jumps to
  the section. Rejected: horizontal pill rails (hide off-screen exercises —
  the complaint restated) and the Strong/Hevy full-list inversion (dethrones
  the big-stepper logging surface).
- **No logged set may be invisible.** Sets whose prescription link is null
  or dangling (prescription deleted mid-session, outbox FK repair, lost
  extras cache, cross-device logs) are claimed by the first rx entry for
  their exercise, or get a synthesized fallback entry. Previously they
  counted toward set numbering while appearing nowhere.
- **An empty prescription snapshot heals itself.** Start writes the rx
  snapshot once; if it's empty (offline/cold start) the session bootstrap
  refetches when connectivity returns and repairs the cache. Start also
  always fetches fresh (a backgrounded PWA's in-memory rx can be hours old)
  and warns when starting fully offline with no targets.
- **Ending an empty session defaults to discard** — an accidental start must
  not mark the planned day DONE. "End anyway" remains as a ghost action.
- **Late corrections in History.** Sets can be voided after the session
  ended (same append-only mechanism); session meta (notes/sRPE) is cached
  for offline read-back.
- **Orphan reconciliation trusts the outbox first.** The open-session sweep
  flushes and excludes sessions with queued updates, so a finish/discard
  done offline is never misread as an abandoned session (which Discard
  would then have soft-deleted). The outbox FK repair now also checks the
  constraint is actually the prescription one before stripping the link.
- Smaller: double-tap Start can't create two sessions; voiding the set that
  started the rest clock cancels the clock; session-scoped caches are
  deleted when the session closes; rest alerts get a Settings row that
  requests notification permission (the strip itself never prompts).

## 2026-08-26 design round: calendar week, accordion logging, supersets, set notes

Owner-driven refinement pass, informed by a best-practice sweep of Strong /
Hevy / Fitbod / Boostcamp adapted to the index-card idiom.

- **Today is a calendar.** A Mon–Sun strip (weekday letter + date + state
  glyph: accent underline today, dot done, struck skipped, red missed, dim
  rest) with the selected day previewing inline below — the week context
  never leaves the screen. Out-of-week and undated days live in LATER.
  Undated programs keep the ruled list (a calendar needs dates). Month grids
  and streak badges rejected as motivational-app noise.
- **The session is an accordion.** One exercise open at a time, logging
  surface inside it: warmup/working toggle (backoff dropped from the UI —
  the enum value stays legal for history), reps above load, load steps ±5
  display units only + tap-to-type, "LOG SET n OF m" counts WORKING sets
  against the prescription (warmups don't consume it). Completing an
  exercise surfaces a NEXT ▸ hint; deliberate tap, never auto-advance.
  Skip/remove live on closed rows only.
- **Supersets are display, not enforcement.** prescriptions.superset_group
  (1=A…26=Z) set by the MCP parse or the plan editor; consecutive group
  members get A1/A2 mono tags and a hairline bracket rail. Logging order
  stays free — append-only capture doesn't care.
- **Per-set notes are a separate mutable row.** set_notes (set_id pk,
  editable, last-write-wins — the sessions.notes mutability class), so sets
  stay append-only. The outbox's one MERGING upsert. Collapsed "+ NOTE"
  affordance; existing notes preview inline and in History under the exact
  set.
- **The bar is a property of the exercise.** Per-exercise bar choice
  (NO BAR / catalog) persisted device-locally; defaults barbell→global bar,
  everything else→none. Fixes the leg-press-with-a-45 miscount for any
  plate-loaded machine.
- Smaller: default rest is typed (number pad) with any 0–3600 s value
  surviving reload (the preset-only init was silently resetting custom
  values); the top-left title navigates home; History renders set notes.

## 2026-08-26 hierarchy round (first real-data screenshot)

Live use with a real coach parse exposed hierarchy failures. Governing rule
adopted: every screen has ONE obvious primary action; reference text
collapses until asked for; parse artifacts never dominate.

- **The primary action always exists and leads.** The selected day's card
  puts Start (or "Start again" for an already-done today, or Move-to-today)
  ABOVE the exercise list. DONE no longer strands the day with no action —
  losing the Start button to a state label was the round's trigger.
- **Notes are reference, not headline.** New Note component clamps anything
  over ~120 chars to two lines with MORE/LESS; used for coach + plan notes
  on Today and Session. Program source_note no longer renders on Today at
  all (provenance belongs to the parse conversation).
- **Ramp brackets are one exercise.** Coach schemes like 1×8-15 / 1×6-8 /
  3×3-5 parse as separate prescriptions (correct data) but now render as ONE
  row ("1×8-15 · 1×6-8 · 3×3-5") on Today and ONE accordion entry in the
  session, which walks the brackets: LOG SET n OF total counts across them,
  each set links to the bracket it fulfills (adherence stays per-bracket),
  crossing a bracket re-prefills its reps/load, and the context line shows
  "NOW 3-5 REPS". Non-consecutive repeats of an exercise stay separate
  entries.
- **upsert_program now constrains notes** (coach's own words, ≤300 chars;
  source_note ≤120) and instructs the parser to keep caveats in chat — the
  screenshot's wall of parse commentary came from the tool being too
  permissive.
- **Board-wide hierarchy audit applied** (same round): completed exercises
  demote the log button ("LOG EXTRA SET", outline) and promote NEXT to the
  primary; History's session discard is the word DISCARD, never ✕ (✕ =
  single-set void, app-wide); End collapses the note behind "Add note" so
  End session sits above the fold, and the empty-session variant no longer
  duplicates discard; Plan leads with EXERCISES (schedule/note/duplicate/
  delete follow), reorder shrinks to chips, coach note collapses; Login
  leads with "tap the link" and tucks the installed-app fallback into
  microcopy; Sign out is two-tap like every destructive action; "LOGGED ·
  APPEND ONLY" is just "LOGGED"; History has a first-run empty state;
  PlateSheet has one exit. One accent element per screen holds everywhere.
- **MCP delete tools** (same day): delete_program (unconfirmed freely;
  confirmed only with an explicit flag after chat approval; logged
  sessions/sets always survive via FK nulling) and delete_exercise (custom
  - unreferenced only — the FK restraint IS the guarantee; seeded rows
    refuse since re-seeding restores them). The "exercises are never deleted"
    hard rule softened to "referenced or seeded exercises are never deleted".
- **CI gained workflow_dispatch**: GitHub silently dropped push events for
  two consecutive pushes (64c9705, d8821c0 — commits landed, zero workflow
  runs); manual dispatch is the recovery path for both workflows now.

## 2026-08-27 polish round phase A: one stylesheet, real contrast, a settings registry

Five audit reports (`.audit/`) drove a pass over the presentation layer, a
batch of correctness bugs, and settings. What changed structurally, and why:

- **theme.css folded into styles.css; the seam is tokens, not selectors.**
  The two files re-declared the same `:root` block byte for byte, so every
  colour change needed two edits and drifted between them; and 19 of
  theme.css's selectors were load-bearing base rules, not a skin, so the split
  never actually separated "theme" from "structure". A skin/base split only
  works when the skin is a closed set of values. The replacement is one file
  with `@layer tokens / base / components / utilities`: the theme boundary is
  the token layer, which IS a closed set, and swapping it can't take layout
  with it. `--ink-rgb` became six ink roles (58 hand-inlined
  `rgba(42,45,50,a)` literals across 17 alphas, now zero), 20 ad-hoc sizes
  became a 9-step scale, and composite rule tokens expose their colour
  separately so nothing has to re-inline. ~185 lines of dead CSS went, each
  re-verified against the TSX including template-literal class construction.
- **Contrast, and the accent moved to #bd5410.** Every text token now clears
  WCAG AA. The old `--accent` #e7792e was 2.53:1 on paper and 2.79:1 for
  button text — decorative, not readable, on a phone held at arm's length in
  a bright gym. #bd5410 is 4.08:1 on paper and 4.51:1 for #fff9eb text on it.
  `--text-dim` 3.24 → 4.89, `--warn` 4.24 → 5.22, and the ten "faint" greys
  (2.0–2.5:1) collapsed into `--text-dim` rather than being nudged one by one.
  Accepted: 4.08:1 is AA for large text and UI components, not for accent-
  coloured body copy, so the accent is never used for small prose.
- **Fonts are self-hosted.** Chivo and Chivo Mono came in through a Google
  Fonts `@import` while the service worker deliberately caches nothing
  cross-origin. The offline promise was therefore already broken on the one
  axis nobody checks: a cold offline launch rendered in system fonts with
  letter-spacing tuned for Chivo. Four variable woff2 (94 KB) now ship in the
  bundle and are precached. Self-hosting also removes a third-party request
  from a single-user app that otherwise talks only to Supabase.
- **Settings became a typed registry, and got no database table.** One
  declaration per setting carries storage, validation, migration, hook,
  export and its rendered control; adding a setting was four files and is now
  about seven lines, behind a versioned envelope with a tested v0→v1
  migration that preserves existing plate/bar/rest/unit choices. Deliberately
  NOT added: `user_settings` or `exercise_prefs` tables. Every one of these
  values is a property of the phone and the gym it walks into (which plates
  are on the rack, which bar, which increment), not of the training record;
  putting them in Postgres would create a third write-ownership class beside
  "PWA writes actuals" and "both write plans", for data no view and no MCP
  tool reads. Accepted cost: settings do not sync across devices, and a
  cleared browser storage loses them. Export exists; training data is never
  in there.
- **Two correctness fixes changed semantics, not just behaviour.** A planned
  day now reads DONE only when its session has `ended_at` — an open session
  used to mark its day done, so mid-workout the same day showed RESUME and
  "Start again" at once, and an abandoned start silently counted as training.
  And "discard empty session" now requires a SERVER-confirmed zero: the local
  set count can be empty simply because this device never had the cache, and
  the old code led with Discard on that, verified against a case that would
  have offered to discard three logged sets. An unconfirmed count now says so
  and offers only End.
- Also fixed, without ceremony: End could render permanently blank (no
  try/catch around its bootstrap); finishing a session did not invalidate the
  derived caches that discarding did, so offline the day never showed DONE
  and the next session prefilled stale; orphan-recovery and Start could both
  render, opening two concurrent sessions (one gate now governs every Start);
  volume-chart week labels were a day early in PDT (`new Date` on a date-only
  string parses as UTC); `getLastActuals` scanned at most 1000 sets and then
  silently decayed, now keyset-paginated; duplicating a planned day dropped
  `superset_group`; sign out now consults the outbox instead of discarding
  unsynced sets in silence. Tests 33 → 82.

## 2026-08-27 per-side load: load_kg is always the TOTAL system load

`sets` and `prescriptions` had no unilateral convention at all, so a dumbbell
row logged as "30" was ambiguous between 30 per hand and 60 total. Nothing in
the schema recorded which, and every day of use accumulated more mixed data.
This was the round's one approved schema change; time-based sets, bodyweight

- added load and per-set RPE were considered and declined.

* **`load_kg` is the total system load, everywhere, always.** A pair of 30 kg
  dumbbells is 60. `v_e1rm`, `v_weekly_volume`, `v_adherence` and every future
  query keep working untouched and keep being right. The alternative — store
  the number the user typed and make readers multiply — pushes the ambiguity
  into every reader that will ever exist, including Claude's MCP reads, and
  guarantees that one of them eventually forgets.
* **`load_entry` records how the number was EXPRESSED**, so the UI can still
  show and prefill "30 × 2" and Claude can quote back what the lifter
  actually said. `'per_side'` means one side was entered and both sides moved
  together; `'total'` means the number is already the whole system.
* **NULL is not 'total'.** `sets` is append-only and RLS has no update path,
  so pre-convention rows can never be corrected: their ambiguity is permanent
  and has to stay visible. The column is nullable with no default —
  defaulting to `'total'` would have backdated an assertion nobody made
  across every row already logged. `get_lift_history` says so in its
  description and tells Claude to call NULL-mode dumbbell numbers ambiguous
  rather than reporting them as fact. Accepted risk: a trend line that
  crosses the NULL/asserted boundary can be an artefact of the convention
  rather than of training, and no migration can fix that.
* **The plan side carries the same column.** Without it, a coach's "DB row
  3×10 @ 30" would sit in `prescriptions.load_kg` as a per-hand number while
  sets stored totals, and `v_adherence` would report a phantom +30 kg
  overshoot on every dumbbell set it ever compared. `upsert_program` now
  instructs the parser to double per-hand numbers into `load_kg` and mark
  them `per_side`, and echoes both figures in its review table.
* **Single-arm work is `'total'`, not `'per_side'`.** One 30 kg dumbbell in a
  one-arm row IS the whole system for that rep. What is per side there is the
  REPS, and reps-per-side is deliberately not modelled — log each side as its
  own set. Calling that case `per_side` would have doubled its tonnage, which
  is exactly the corruption the column exists to prevent.
* **No hint column on `exercises`.** It is a shared library seeded from two
  sources: free-exercise-db carries no unilateral field, so 873 generated
  rows could never be populated and every re-seed would write the column back
  to null. The UI derives its default from `equipment` and the movement name
  (dumbbell, and not single-/one-arm/alternating → per_side) and persists any
  override in the device-local per-exercise settings, next to bar and
  increment. A wrong default costs one tap; `load_entry` on the row is what
  makes the record honest.
* A check constraint refuses `'per_side'` on a 0 kg bodyweight set, and on a
  "by feel" prescription with no load: half of nothing is still nothing.
* Validated in PGlite (the 2026-08-25 precedent): full migration chain from
  scratch, all 29 existing view and RLS checks still green, plus 15 new
  assertions covering the enum, the three-state NULL/total/per_side
  distinction, unchanged tonnage and e1RM math on totals, `v_adherence`
  surfacing both entry modes, and the append-only guarantee that NULL rows
  can never be backfilled.

## 2026-08-27 "today" is one date, read from `app_config.tz`

Three writers had three definitions of the calendar day that
`training_maxes.effective_date` is written and compared against:

| where      | definition                            | source                     |
| ---------- | ------------------------------------- | -------------------------- |
| SQL views  | `(now() at time zone app_tz())::date` | `20260825120003_views.sql` |
| MCP server | UTC                                   | `lib/dates.ts`             |
| PWA        | device local                          | `pwa/src/lib/format.ts`    |

With `app_config.tz = 'America/Los_Angeles'` (what `docs/setup.md` tells you to
set), the MCP server's UTC "today" runs a day ahead of everyone else's for the
last 7-8 hours of each local day. Reproduced against the real migrations in
PGlite at 2026-08-27T02:30Z, which is 19:30 on the 26th in Los Angeles:

1. `set_training_max` stamped `effective_date = 2026-08-27` and reported
   success.
2. Its own future-date warning could not fire, because `isFuture` compared the
   stamp against the same wrong UTC today.
3. `v_current_tm` (`effective_date <= app_tz() today`) could not see the row,
   so the app kept showing the old TM.
4. A follow-up `%TM` `upsert_program` failed with "no current training max",
   and the branch that exists to explain exactly that missed too:
   `.gt("effective_date", todayIso())` excludes a row dated exactly today.
5. The PWA (device local) and the MCP (UTC) writing that same evening produced
   two `training_maxes` rows for one lifter-day.

Decision: the MCP server reads the same `app_config` row `app_tz()` reads.
`todayIso(db)` is now async and formats through
`Intl.DateTimeFormat(...).formatToParts` in that zone, which is the TypeScript
equivalent of `(instant at time zone tz)::date`. The timezone is cached for the
life of the isolate (it is deployment config, not per-request data), so a
change to `app_config.tz` takes effect on the next cold start. An unreadable
`app_config` row throws rather than falling back to UTC: silently guessing a
timezone is the defect being fixed. A genuinely absent row still falls back to
UTC, matching the SQL `coalesce(..., 'UTC')`.

The boundary comparison in `upsert_program` became `.gte`. The database owns
the boundary day: a TM dated exactly today is either already current (so it is
never in the missing list) or the view has not reached it, and `.gt` dropped
precisely that row.

**The PWA's device-local today stays device-local, deliberately.** The phone is
where the lifter is; a set logged at 21:00 belongs on the day the lifter just
trained, whatever `app_config.tz` says. `app_config.tz` is the _home_ timezone,
the fixed reference the database needs because Postgres has no device. The two
agree except while travelling across a date boundary, and there the phone is
right about the workout and the home timezone is right about the weekly
buckets. Do not "fix" the PWA to read `app_config.tz`, and do not make the MCP
server read a device clock — it has none.

Not every date has to agree. `defaultSince()` in `get_lift_history` stays UTC
and says so in a comment: it is the far end of a rolling 90-day window, not a
day the lifter experiences, and nothing keys off it. Only dates compared
against `app_tz()` dates have to match.

Coverage, both halves pinned to the same instant so they cannot drift apart:
`supabase/functions/mcp-server/lib/dates.test.ts` (Deno, run in CI) for the
TypeScript formatter, and a new check in `scripts/validate-db.mjs` for the SQL
rule and the `.gt`/`.gte` boundary.

## 2026-08-27 signing out clears the device cache (never the outbox)

Signing out ended the Supabase session and did nothing else. Everything the
app had cached to work offline — programs, planned workouts, sessions, sets,
training maxes, coach notes — stayed in the IndexedDB `kv` store, readable by
whoever opened the app next. Reproduced in the demo harness: after sign-out the
Login screen renders while `plannedWorkouts` and `trainingMaxes` (with values)
are still there, and offline they would stay there indefinitely, because the
refetch that would replace them cannot run.

`onAuthStateChange` now clears `kv` on `SIGNED_OUT` (`cacheClearAll` in
`lib/db.ts`, called from `hooks/useAuth.ts`).

**The outbox is deliberately not touched.** It holds sets that exist nowhere
else. The sign-out flow already asks about those in its own confirmation step
("N unsynced — sign out anyway?" → "Discard unsynced sets and sign out"), and a
cache drop must never be the thing that discards them. Both halves are pinned
in `lib/db.test.ts`.

This is a prerequisite for the multi-user question, not an answer to it. Cache
keys still carry no user id, so a _different_ user signing in without the
previous one signing out first would still read the previous user's cache.
Closing that needs either per-user key prefixes or a clear on user-id change,
and that is a decision to make alongside the rest of the multi-user work
(`app_config.tz` is one global row, `exercises` has no owner, and the MCP
server is pinned to `OWNER_USER_ID` — see the 2026-08-25 service-role entry).

## 2026-08-27 multi-user: identity is the token, ownership is a side table

The schema was per-user from day one — every training table carries `user_id`,
33 RLS policies enforce it, views are `security_invoker` so RLS reaches every
derived metric. Three things assumed exactly one person anyway, and all three
are now closed. Migration `20260827180000_multi_user.sql`.

**The MCP server had one credential and one identity.** `lib/db.ts` built a
service-role client pinned to `OWNER_USER_ID`; `requireAuth` compared a single
`MCP_SECRET`. Anyone holding that secret WAS that user. Now a token is the
identity: `mcp_tokens` maps a SHA-256 digest to a `user_id`, `resolveCaller`
looks it up, and `dbFor(userId)` builds the handle per request.

Chose static per-user tokens over Supabase JWTs and over OAuth. JWTs expire
hourly, which is unusable in a config file a client reads at launch. OAuth is
what claude.ai and ChatGPT prefer for one-click connector installs, but running
an authorization server (PKCE, dynamic client registration, consent UI) is a
project in itself and would still need exactly the per-user identity built here.
Bearer tokens are what every MCP client supports today, so this is the version
that works everywhere now and does not preclude OAuth later.

The sharp edge is caching. `getDb()` returned a module-level singleton, which
was correct when the owner came from an env var and would have been a
cross-user data leak the moment it came from a request: edge isolates are
reused, and every tool trusts `db.ownerId` completely. `getClient()` still
caches the connection (it holds no user state); the `Db` handle is built fresh
per request and the comment there says why. `lib/dates.ts` had the same shape —
a single `cachedTz` slot — and is now a Map keyed by user.

**One global timezone.** `app_config.tz` was a single row and five views called
`app_tz()`. The fix is `app_tz(user_id)`, and the views pass the user id OF THE
ROW they are bucketing rather than asking who is asking. A training max becomes
effective in ITS OWNER's calendar. That is the correct semantics anyway, and it
is what makes the service-role path right without impersonating anyone —
`auth.uid()` is null there, so a view reading the caller would have silently
fallen back to the deployment default. `app_config.tz` survives as that default,
which is the right answer for a household in one timezone.

**An unowned exercise library.** `exercises_insert_custom` let any authenticated
user insert `source = 'custom'`, visible to everyone. CLAUDE.md forbids a
per-user column on `exercises` (873 generated rows would carry a null forever
and every re-seed would write it back), so ownership lives in `exercise_owners`.
Seeded rows have no entry and stay shared, which is right: a library is not
anyone's data. Claiming is an `after insert` trigger so the invariant cannot be
forgotten by a new writer; the service-role path has no `auth.uid()` and
inserts the owner row itself. The backfill assigns each custom exercise to
whoever actually referenced it, which needs no guess about who "the" user is.

Because the service role bypasses RLS, the scoping had to be repeated in the
MCP tools: `requireExercise` is the single gate every tool naming an exercise
passes through, and `search_exercises` filters explicitly. Another person's
custom lift reports as _unknown_, not as forbidden — confirming that an id
exists but belongs to someone else is itself a leak.

### The client half

Queued writes leave `user_id` to the database default (`auth.uid()`). That was
safe while one person could be signed in and became a data-integrity hazard the
moment two could: a set queued offline by one user and flushed after another
signed in would be stamped, permanently and append-only, with the wrong owner.
Outbox items now carry their owner and the flusher holds anything that is not
the current user's — held, never dropped, and still counted in the sync pill so
it cannot go quietly missing. Items queued before this shipped carry no owner
and are treated as the current user's, which is exactly what they already were.

The device cache is claimed by one user id in localStorage and cleared when it
changes. Cache keys are deliberately NOT namespaced: `cacheKeys` is the single
vocabulary for every key in the app, and threading a user through it would give
forty call sites a chance to get the prefix wrong. One marker has one place to
be wrong. When localStorage is unavailable the check is skipped rather than
clearing every load, which would have destroyed the offline promise in private
mode for no gain (IndexedDB is per-session there anyway).

Sign-out no longer claims to "discard unsynced sets". It never did discard
them, and now they are explicitly held for their owner, so the button says so.

### Not done, deliberately

PWA settings stay device-local. Two people sharing one phone share its plate
inventory and per-exercise preferences. Making them per-user means a
`user_settings` table, which CLAUDE.md rules out as a third write-ownership
class for data no view and no MCP tool reads. Two phones, no overlap, and that
is the expected setup.

There is no timezone control in the app. It is a SQL one-liner in setup.md that
changes about once in a lifetime, and putting it in device-local settings would
be the wrong home for a server-side per-user value.

## 2026-08-27 toasts sat on the topbar, and how the sweep missed it

A toast is `position: fixed` anchored to the top of the viewport, 92vw wide,
alive for 4.5s and stackable three deep. That put it directly on the topbar,
and because it is a real element in the hit test it swallowed every tap aimed
at the settings gear and the wordmark's go-to-Today button for as long as it
showed. An error toast is precisely when someone reaches for settings.

Two changes, either of which fixes the blocking; both are worth having.
`pointer-events: none` on `.toasts`, because an overlay with no interactive
content must never be in the hit path on ANY screen size, measured or not. And
`top: var(--topbar-h)`, published by the shell from a ResizeObserver (the same
idea as `--kb` in `<Sheet>`), so the toast does not visually cover the chrome
either. Measured rather than hard-coded: the topbar's height moves with the
safe-area inset, the font and the breakpoint's gutter.

**Why the earlier responsive sweep called this clean.** It measured geometry —
document overflow, elements outside the viewport, character stacking, computed
tap-target size — and geometry cannot see occlusion. Every one of those checks
passes on a button with a toast sitting on top of it. It also only ever
measured at scroll-top, and never opened a sheet, so overlays were not in the
DOM at all when it ran.

The check that finds this class is `document.elementFromPoint` at the centre
and four inset corners of every interactive element: if the topmost element
there is not the control or its descendant, the control is unreachable. It
catches occlusion from any cause at once — fixed overlays, modal backdrops, and
a neighbouring control's `::after` hit extension stealing taps — because
hit-testing attributes a pseudo-element to the element that owns it.

Three things that harness has to get right, each of which produced a false
positive first:

- Clip by scroll containers, not the viewport. An element inside `.content`
  can be below that container's clip while still "on screen" by its own
  coordinates. It is scrolled away, not covered.
- Settle animations before measuring. Sheets slide in with a `rise` keyframe,
  and CSS animations do not advance in a hidden tab — which is where an
  automated sweep runs — so an unsettled sheet measures as sitting entirely
  below the fold. `getAnimations().forEach(a => a.finish())` first.
- A modal backdrop covering the page is the point of a modal, not a defect.

`.sheet-close` measures 44.5x42.2 rather than 44x44: its hit extension reaches
16.25px above the ink and `.sheet` has 16px of top padding, so the top ~2px is
clipped by the sheet's own overflow. Left alone — closing it means adding
padding to the top of every sheet for half a millimetre on the one control that
is also dismissable by backdrop tap and by ESC. Recorded in styles.css beside
the family so the next person measures rather than trusting the rule.

## 2026-08-28 the app plans workouts now (reverses a non-goal)

`spec.md` and `plan.md` both listed "in-app routine editor" as a non-goal. The
premise was a division of labour: the coach programs, Claude parses, the app
captures. Reversed on the owner's request, and the reasons it was worth
reversing are worth recording.

The editor that existed could only edit days that already existed. The only
`insert` into `planned_workouts` anywhere in the PWA lived inside _Duplicate to
another day_, so a day could be copied but never created — and before the first
MCP-parsed program existed there was no planning affordance at all. The whole
empty state was "Start empty session". That is not a deliberate boundary, it is
a hole: planning was possible only if Claude had already planned something.

What changed:

- **A day is created from the calendar**, on the day being planned ("Plan this
  day" on an empty date, "Plan a workout" from the empty state). It is dated by
  construction, which matters more than it sounds: a day with no
  `scheduled_date` does not merely sort oddly, it leaves the calendar entirely
  — the week strip disappears and Today falls back to a DAY 1..N list. An
  undated day now says so in the editor.
- **Adding an exercise opens its editor on the new row.** It used to insert a
  fixed 3x8-by-feel and close, leaving the user to find the row they had just
  made in order to say anything about it. `addPrescription` returns the new id
  so the caller can open it; the defaults are a starting point, not an answer.
- **Exercises reorder within a day.** Nothing wrote `position` before, so an
  exercise added last was last forever. `unique (planned_workout_id, position)`
  means the swap parks on a free slot first, the same shape `swapWorkoutOrder`
  already used for `day_index`.
- **A day can be renamed**, and `workoutName()` now resolves blank and null the
  same way. `label ?? fallback` does not fire for an empty string, so a
  freshly created day rendered with no heading at all — caught by testing the
  create flow rather than by reading it.

**A user-created program is CONFIRMED on creation**, unlike anything Claude
writes. The confirm step exists so a parsed or prompt-injected program cannot
go live unreviewed; there is nothing to review in a day the user is authoring
by hand, and making them approve their own typing would be theatre. The MCP
path is untouched: `upsert_program` still lands `confirmed_at IS NULL`.

Consecutive prescriptions naming the same exercise remain a ramp, rendered by
Today as one grouped entry ("1x8 @60 · 1x6 @85 · 3x3 @112") and by the editor
as separate editable rows. That is the right behaviour for a warmup ramp, but
it happened silently, so adding an exercise twice looked like the two screens
disagreeing. Ramp rows are now marked in the editor and the toast says what
just happened.

Still not built: no way to reorder DAYS other than the existing earlier/later
swap, and no multi-week program authoring. Claude remains much better at
turning a coach's screenshot into a block than any form would be; this is for
the day you want to change something yourself.

## Error reporting is Sentry, and the tester gets a button

Sentry was wired into `reportError` from the start but never given a DSN, so
production reported nothing: an error surfaced as a toast on the phone and then
did not exist. That is survivable for one person who also owns the repo and
fails the moment a second, non-technical person is the one hitting the bug.

`VITE_SENTRY_DSN` is now set in `deploy.yml` alongside a real build stamp
(`VITE_APP_VERSION` / `VITE_BUILD_SHA` / `VITE_BUILD_TIME`), which the About
row, the CSV export and every bug report already wanted and had been faking
with a hardcoded `0.1.0`. The DSN sits in the workflow rather than in secrets
because it is not one — it is write-only and ships in the client bundle by
design. On a public repo that means anyone can read it and post events, so the
mitigation is on the Sentry side, not hiding the string: the DSN is capped at
1000 events per hour, and an allowed-domains entry (Settings → Security &
Privacy) restricts ingest to the Pages origin. The cap is generous enough that
a real bad day still reports in full and low enough that a stranger cannot bury
the issue stream.

Session replay is on (10% of sessions, 100% of sessions with an error) with the
SDK's `maskAllText` and `blockAllMedia` defaults left alone. Replay is the
whole point of this for a tester who cannot describe what she tapped, and the
masking is the reason it is acceptable to watch: it shows the shape of the
interaction, not a readable training log.

The in-app reporter asks for one sentence and attaches the rest. The single
most useful attached field is outbox depth — a person cannot tell "my sets
vanished" from "my sets are queued", and those are different bugs. When no DSN
is configured the button says so instead of returning a thank-you for a report
it threw away; a silent drop dressed as success is worse than no button.

## The report button is draggable, and that is not a gimmick

A floating action button covers content — that is the deal you make for putting
one on screen. The usual fix is to pick a corner and pad the scroller under it,
which is what the first version did. It still covered the right-hand value of a
row whenever the list ended near the button.

Rather than keep guessing, the button moves: 400ms hold, drag, release. It
snaps to the nearer side edge (a button parked mid-list reads as a bug, not as
chrome) and keeps its vertical position as a FRACTION of the band between the
top bar and the tab bar, so it lands in the same relative place after a
rotation or on a different phone. Position lives in the settings registry as
`bugButtonPos`, device-local like everything else there.

The gesture has one non-obvious requirement: moving more than 8px before the
hold completes must cancel it. Without that, a scroll flick starting on top of
the button is swallowed and the list does not move — the exact bug that makes
draggable buttons feel broken. Pointer capture is likewise taken only after the
hold completes, never on pointerdown, for the same reason.

Discoverability is one line of microcopy inside the report sheet. There is no
tooltip, no coach mark and no settings row: the sheet is the one moment the
person is already looking at the button and wondering about it.

## The login screen stopped promising a link

The email template went code-only (`{{ .Token }}`, no link) when custom SMTP
landed, because a link cannot sign in an installed iOS PWA — Safari opens it
and the installed app cannot see Safari's storage. The screen's copy was never
updated: the button said "Send magic link", the confirmation said "Tap it in
your email", and the microcopy explained how to long-press a link. All three
described an email that had not been sent in months. Someone non-technical
would have hunted a nonexistent link on step one, before seeing anything else
in the app.

Now: "Email me a code" → "We sent a 6-digit code to <email>". The paste-a-link
path stays in the code, undocumented, so a deployment on the stock Supabase
template still works — but it is no longer offered, because two advertised ways
to sign in is what made the screen confusing in the first place.

## Warmups belong in the plan, and adding an exercise became a question

`sets.set_type` has existed since the first migration; `prescriptions` had no
equivalent. A coach's "two light sets, then three working" could only be
written as a ramp of consecutive rows with different loads and no way to say
which of them were warmups — so the lifter re-decided that on the gym floor,
from memory, every session. One additive column with the safe default
('working', which every existing row already was) closes it.

`v_adherence` is deliberately NOT changed. It gates on the ACTUAL set's
set_type, which is the honest gate: what the lifter did is what counts, and a
warmup they chose to treat as a working set still counts as one. Filtering on
the PLAN's set_type would let a mislabelled prescription silently delete real
work from the analysis. The harness pins that.

Adding an exercise used to insert a bare 3x8-by-feel row and leave you to find
the editor. It now opens a sheet that asks how many sets, what each weighs, and
which are warmups. Per-set weight is not a new shape — it is the existing ramp
convention, reached from the front instead of by adding the same exercise three
times and knowing that meant something. Consecutive sets agreeing on load AND
type collapse back into one row on save, so a straight 5x5 stays one
prescription; the sheet says which is about to happen before you commit.

## The MCP surface could write a plan but never read one

Three holes, all of them the same shape: Claude could act but not look.

`get_program` did not exist. upsert_program replaces a program wholesale, so
editing a day meant rewriting it from memory — which is how prescriptions
disappear. There was also no way to answer "what am I doing Thursday" without
asking the user to read it off their phone. The tool returns the current
program with every day, its coach notes and the user's own plan_note, and every
prescription including set_type.

`set_notes` was invisible. It is the only qualitative record in the system —
"left shoulder twinged", "bar speed died" — and an analysis could report a
clean rep scheme on a session the lifter had flagged as painful. Now attached
to sets in get_lift_history, and to sets in get_recent_sessions.

`get_recent_sessions` returned counts, not sets. "How did yesterday go" was
unanswerable without already knowing which exercises were trained.
`include_sets` returns the actual work — exercise, warmup vs working, load,
reps, note — capped at 400 rows with a truncation flag.

## A template is a planned day without a date

The alternative was a parallel table pair — workout_templates plus
template_prescriptions — duplicating the whole prescription shape and cutting
the plan editor and the MCP off from it. A template is the same thing as a
planned day minus the date, so it is one: `planned_workouts.is_template`, and
prescriptions hang off it unchanged.

The cost of that choice is leakage — a template appearing on the calendar — and
two things contain it. A template can never carry a scheduled_date (a check
constraint), so every date-keyed read already excludes them. And
`v_plan_workouts` exists so the dateless reads have something to select from
that cannot include one; the PWA's plan read and the MCP's get_program both go
through it rather than filtering at each call site, because a filter you have
to remember is a filter someone will forget.

Applying a template refreshes loads from the last set actually logged. The
naive version — overwrite every row with the last actual — flattens ramps:
60/85/112.5 becomes 110/110/110, three identical sets where a warmup build-up
used to be. So the unit of refresh is the ramp. A run of consecutive rows
naming one exercise is rescaled proportionally, the top set landing exactly on
the weight that was lifted rather than on a rounded product of it. %TM rows are
skipped entirely: they are already relative to a training max that moves on its
own, and replacing one with an absolute number severs that link silently.

## Claude can file what it could not do

Every tool either read the log or wrote a plan. None of them had anywhere to
put the thing that happens constantly: a coach screenshot describing something
the schema cannot express, a metric the user asked for that no view computes, a
shape the parser had to flatten. That went into a chat message and died there.

`feedback` is the table that outlives the conversation, with submit / list /
resolve tools. Three deliberate constraints. `kind` is a closed set and `title`
is capped at 200 characters, because the value here is being readable at a
glance months later, not being able to hold anything — this is not a general
note store, and the tool description says so. There is no delete policy:
resolving answers a request, and the record of having asked stays. And the tool
tells the assistant to say what it filed, because a request the user never
hears about is the same as no request at all.

## The in-app coach

A chat, in the app, backed by Claude Sonnet 5, which can read the log and
change the plan. The API key is a Supabase secret; the browser authenticates
with its own Supabase session and never holds a credential that reaches the
MCP server directly.

**The tool surface is the existing MCP server**, reached through the Anthropic
MCP connector rather than reimplemented. One authorization boundary instead of
two, no tool loop to get wrong, and the guarantees that already matter come for
free: no tool writes `sets` or `sessions`, so the coach cannot log training,
and a program it writes lands unconfirmed. The connector needs a plaintext
bearer and `mcp_tokens` stores only digests, so the function mints a fresh
token per turn with a ten-minute expiry. Permanent tokens (everything a person
pastes into an MCP client) have `expires_at` NULL and are untouched.

`delete_program` and `delete_exercise` are switched OFF for the coach at the
connector layer. Claude Desktop keeps them. The coach has no use for them, and
disabling them converts "the prompt says ask first" into something an injected
instruction cannot reach at all. `upsert_program` stays, because drafting a
plan is the job; its unconfirmed gate is real but softer, resting on the
model's judgment rather than on structure. Worth knowing rather than trusting
blindly.

**Untrusted input is JSON-encoded, not delimited.** The first version wrapped
uploaded files in `<uploaded_file name="...">` built by concatenation, which a
CSV containing the closing tag can break out of — landing attacker text in the
turn as if the lifter had typed it. JSON escaping cannot be closed from the
inside. Images and PDFs now carry a provenance block too; they previously
arrived with nothing distinguishing them from the lifter's own words except a
blanket rule in the system prompt.

**Four bugs found by researching the design rather than by running it**, all
now fixed and all invisible from the outside:

- Usage was recorded after `finalMessage()`, so an aborted turn — which the UI
  offers as a first-class action — was billed by Anthropic and invisible to the
  quota. Recording moved into a `finally`.
- The daily limit counted refusal rows, so every retry after hitting the cap
  extended the rolling window. A 24-hour limit was a permanent lockout, and the
  message shown to the user ("resets a day after your first message") was false.
- Only output tokens were metered. Input is the side the user controls.
- `max_tokens` was 8000 while Sonnet 5 defaults to HIGH effort with adaptive
  thinking, which counts against the same budget. That truncates mid-sentence.
  Now 16000 at `effort: "low"`, which is the right trade for someone holding a
  phone between sets.

`thinking.display` defaults to `"omitted"` on Sonnet 5, so the stream emitted
empty thinking blocks and the UI sat silent for seconds looking broken. Set to
`"summarized"` and forwarded as its own SSE event.

**Caching** uses a 1-hour TTL rather than the 5-minute default: a lifter
between sets is exactly the gap where the 2x write cost pays for itself, and at
5 minutes every question after a working set was a cold miss on ~17k tokens of
tool definitions. Verified live — a follow-up turn reads 9,656 cached tokens
and writes none.

**The prompt is XML-structured with worked examples**, not markdown with
instructions. Sonnet 5 takes prompt structure as a cue for output structure,
and markdown headers were nudging markdown answers onto a phone screen.
Brevity is shown rather than described, which is what actually moves it.

**Conversation history is device-local.** There is no server table of threads;
localStorage holds the last 24 turns with attachment payloads stripped. A
shared phone shares a thread and a new phone starts empty — the same trade the
settings registry makes, and the right one for the most personal thing here.

**What IS recorded server-side is the prompt and the response**, along with
tokens, latency, tools used and cache counters. That is a product decision and
not a technical detail: whoever runs the deployment can read the conversation.
It is on because the owner asked for it, `COACH_LOG_CONTENT=off` disables it
without touching anything else, and anyone else using the deployment should be
told.

## Context beats a tool call

The coach gets a `<current_context>` block on every turn: today's plan, whether
a session is running, what has been logged in it, coach and plan notes. Built
from the app's own cache — the same state on the lifter's screen.

Without it, "should I drop the last set?" costs a tool round trip before the
model can say anything, and mid-set that round trip is the whole latency
budget. Worse, a model that has to go looking may answer generically instead.

Rebuilt per turn rather than pinned to the top of the thread, because it goes
stale the moment another set is logged — which is exactly when someone asks.
Attached to the newest user turn, which also keeps it after the cache
breakpoint. It covers today only; tools remain the way to reach history.

## Programs are soft-deleted too

`sets` are append-only, `sessions` soft-delete via `discarded_at`, corrections
go through `set_voids` — and then `programs`, the one table an LLM can write,
had a hard DELETE. A mis-parsed instruction or a misread "get rid of that"
destroyed a plan with no undo, in a codebase whose entire stated principle is
that the record survives. The asymmetry was exactly backwards: the least
trustworthy writer had the most destructive verb.

`delete_program` now sets `discarded_at`. So does the path that retires a
superseded unconfirmed draft — a draft is still something the model wrote. The
one delete left hard is the compensating rollback when a write fails partway:
that is cleaning up a fragment nobody ever saw, and soft-deleting it would
leave debris instead of removing it.

The leak this had to close is not the program row, it is the days hanging off
it. A discarded program's `planned_workouts` are untouched rows carrying real
`scheduled_date`s, so without joining through to the program they keep
appearing on the calendar after the plan is gone. `v_plan_workouts` already
existed as the single place every plan read goes (added with templates for the
same reason), so the join lives there rather than in each caller — and the
harness pins both filters, because adding the second one is exactly where the
first gets dropped by accident.

Restoring is a SQL update, not a UI. That is deliberate: undoing a deletion is
a rare, deliberate act, and a restore button is a second way to change the plan
for a case that should be measured in "once".

## A coach turn outlives the app

Someone asks a question mid-set, the phone locks, and the answer was gone. Not
just undelivered — abandoned: `controller.enqueue` throws once the stream is
dead, that threw out of the generation loop, and the turn was billed for
whatever it had produced with nothing to show for it.

Enqueue is now best-effort and a departing client is not an error. Generation
runs to completion and the whole answer is written to `coach_usage` against a
`turn_id` the CLIENT chose before asking — client-generated for the same reason
set and session ids are: it has to know the id before the round trip, or it has
nothing to ask for afterwards. On reopen, an assistant turn still marked
streaming is looked up and filled in.

Verified by hanging up three seconds in: the client received zero bytes, and
the server still finished a 571-token answer, `stop_reason: end_turn`, recorded
in full.

## Declared schemes for unplanned exercises

Adding an exercise mid-session gives it the same sheet the plan editor uses,
and the declaration is synthesised into the bracket shape the session screen
already reads — so "LOG SET 2 OF 4", the load prefill and the warmup handling
all come free from the code that already does it for a planned exercise.

Two things that had to be right, and one of them I got wrong first.

`sets.prescription_id` is a foreign key. A synthesized bracket id in it fails
the insert, and on the offline queue it fails forever, so a locally declared
bracket writes NULL. That part I anticipated.

What I did not: `setsForEntry` attributes sets by bracket id whenever an entry
has brackets. Writing NULL therefore meant a declared entry owned none of its
own sets, and the counter sat at "SET 1 OF 4" however many went in. Caught by
using it, not by reading it. A locally declared entry now claims by exercise,
like an undeclared extra — the brackets are a target, not an attribution key.

## What the coach costs is shown, not just recorded

Tokens were already in `coach_usage`; nobody reads tokens. `v_coach_cost`
prices them (Sonnet 5 list, cache writes 1.25x input, reads 0.1x) and
`v_coach_spend_daily` rolls them up per user per day, so a client never pages
the ledger to add up a number. The sheet shows turns today, spend today, spend
this month.

Pricing lives in the view rather than a stored column: re-pricing is then one
CREATE OR REPLACE and never a backfill that rewrites what history cost.

## Sections are a name, not a table

A third grouping concept with its own table would be a third way to express
"these rows belong together", alongside superset_group and the repeated
exercise_id that makes a ramp. So a section is `prescriptions.section`, and
consecutive rows sharing one render under a heading exactly as the other two
do. Editable on existing rows, so a workout built before sections existed can
be organised afterwards.

`tracking` ('reps' | 'done') is the other half. A tick still writes a real row
in `sets` — reps 0 at load 0, both already legal — rather than inventing a
second kind of completion record that no view, no chart and no MCP tool knows
how to read. And crucially the analytics need no change: a 0-rep set
contributes 0 tonnage and sits outside e1RM's 1-8 rep window already. Adding a
`tracking` filter to those views would couple the analysis to the plan, which
is the same mistake v_adherence exists to avoid.

## The row editor saves itself

Every other field on the plan screen commits on blur — the name, the date, the
note. One section demanding a deliberate Save was the odd one out, and
forgetting it silently discarded the edit. Collapsing a row now saves it, the
button says Done, and Cancel says "Discard changes" so the destructive one is
the one that is labelled. A no-op edit writes nothing and says nothing: opening
a row and closing it should not claim to have updated anything.

## Rendering a model's markdown

Coach answers arrived full of asterisks. The fix is a parser to a STRUCTURE and
a component that emits elements — never `dangerouslySetInnerHTML`. The text
comes from a model that has just read an uploaded screenshot and someone's CSV;
routing that through innerHTML would turn prompt injection into script
injection. Nothing in the path touches HTML, so there is nothing to sanitise.

No dependency: the service worker precaches the whole bundle for offline use,
and a markdown library is larger than the rest of the chat. The parser covers
what actually appears and nothing else, with tests for what must NOT be
formatting — "3*5" is a set scheme, not italics.

## Notes belong to the movement, and travel with it

Every note in the system was scoped to an occasion — a planned day, a logged
set, a session. None of them carried "front foot stays flat", which is true
every time that exercise comes up and had to be retyped onto each day or
forgotten.

`exercise_notes` is keyed (user_id, exercise_id) rather than being a column on
`exercises`, for the reason CLAUDE.md already gives for `exercise_owners`: that
table is a shared library seeded from free-exercise-db, it never grows a
per-user column, and never a column the generated seed cannot populate — 873
rows would sit null forever and every re-seed would write it back.

More useful than the table is that both kinds of note now travel WITH the
exercise. `search_exercises` — the tool the assistant calls while programming —
returns each result carrying the standing note and the last three things the
lifter wrote while actually lifting it. Making it fetch history per exercise to
find that out is a round trip it will usually skip, and "left hip pinches below
parallel" is exactly the sentence that should change what gets written down.

## Search is ranked by what the lifter trains

The seeded library holds a dozen near-identical variants of most movements —
eleven lateral raises, six squats beginning "Barbell" — returned alphabetically.
Handing that back unranked is how a program ends up prescribing three squats
that are the same squat, which is what happened.

Results are now ordered by what the lifter has actually logged, annotated with
`last_trained` and a set count, and carry guidance saying to prefer them. The
coach prompt says the rest: never two variants of one movement in a session,
and vary the movement PATTERN rather than the name of the same exercise. An
untrained variant gives them no history to compare against and no working
weight to start from — the cost is invisible until a chart has a hole in it.

## The coach remembers the person

A conversation remembered itself and nothing else: "New" wiped it, a second
device started empty, and the lifter re-explained their shoulder every time.
None of that is derivable from the log — no view holds "I train at 6am before
work" or "no barbell on Fridays".

`coach_memory` holds standing facts, kinded (injury / constraint / preference /
context) and capped at 300 characters, because the value is being readable in
full at the start of every conversation rather than holding everything.
Deliberately not goals: `goals` and v_goal_progress already measure those
against real sets, which is a better record than a sentence.

**It arrives in the context block, not through a tool.** Memory that has to be
fetched is memory that gets forgotten. Verified: a brand new conversation with
no history opened with "Given your left shoulder impingement (no overhead
pressing) and that Friday you're home with just dumbbells and bands" and
programmed around both.

It is deletable, unlike the training record. A fact that has stopped being true
is not history worth keeping — it is something that would make every future
answer worse. This is the sessions.notes mutability class, not the sets one.

## What the recorded conversations said

The point of logging prompts and responses is to read them. Thirteen turns in:
median latency 10.8s, cache hits 12/13, median answer 280 characters — brevity
is holding, caching is working, and three turns needed no tool at all because
the context block already answered them.

The one clear waste: the model called `get_memory` on a turn where memory was
already in its context. Seconds spent by someone standing at a rack, for
nothing. The prompt now says not to, and says why tool calls cost what they
cost — one well-chosen tool beats three thorough ones.

## The chat broke when the keyboard opened

Two bugs, both structural rather than cosmetic.

`.sheet` is `overflow-y: auto` so a long form can be reached. A chat has its
own scroller inside it, and with both, the keyboard shrinking the sheet
scrolled the COMPOSER out of view instead of pinning it above the keys. The
chat sheet is now `overflow: hidden`: one scroller, the thread.

And raising `.sheet-tall` from 78dvh to 88dvh had done nothing, because
`.sheet` sets a `max-height` and max-height beats height. Both are set now, and
both subtract `--kb`. Measured: keyboard open, the sheet shrinks to 468px and
the composer's bottom edge sits at 472 against a keyboard starting at 492.

The thread also re-pins to the bottom on a visualViewport resize, or the answer
being replied to scrolls away the moment the box is tapped.

## Two bugs from the same misreading of a gesture

`useDragList` read `e.currentTarget` inside its long-press timeout. React sets
that to null once the handler returns, so the drag threw a TypeError after
`setDragging` and before taking pointer capture — leaving the row mid-drag with
no capture, which on a phone reads as the page having locked up. That was the
"can't navigate out of the plan editor" report. The element is held in a
variable now.

Capture was also never RELEASED. `useFabDrag` had a `release()`; the list hook
did not, and a capture that outlives its drag sends every later pointer event
to that row — the same frozen-page symptom by a different route. It is released
first and unconditionally in `finish()`.

Worth noting the pattern: both hooks implement the same gesture, and the bug
existed only in the one written second, in the one place the two implementations
differed.

## Weights drifted off the pound grid

Loads are stored in kg and stepped by the DISPLAY unit's increment, so in lb
mode the step is five pounds expressed as 2.26796 kg. Added to a kg-authored
100 kg that gave 220.5 → 225.5 → 230.5 lb: the value kept the half-pound of its
kilogram origin forever and never reached a number anyone loads on a bar.

`Stepper` now snaps to a multiple of the step rather than adding to it, so the
first press lands on 225 and every one after stays round. Opt-in (`snap`),
because reps and seconds are already integers in the unit they are shown in,
and a no-op in kg mode where the value is already on the grid.

The same bug had a second face, invisible unless you use a screen reader: the
spoken label rendered the raw delta, announcing "increase load by
2.2679618500000003" — internal units and a float, to the one person who cannot
see the screen to work out what was meant. Steps carry an `announce` string in
the user's own unit now.

Typing was always exact and still is: 50 lb round-trips through 22.6796 kg back
to 50 lb. Only the stepper was wrong, which is why it survived the round-trip
test that was written when per-side loads landed.

## A superset is gathered by its letter, not by adjacency

The spec models a planned day as a flat, ordered list, with `superset_group`
as a label on rows that happen to sit next to each other. The plan editor now
treats the letter as authoritative and gathers a superset by GROUP even when
its members have drifted apart, then writes them back together.

The deviation matters because the letter is the coach's declaration that these
exercises alternate. Adjacency is downstream of that: it is how the day
happens to be stored after edits, reorders and section moves, and any of those
could separate two rows that must still be performed as a pair. An editor that
grouped by adjacency would show one superset as two half-supersets and let a
person move a heading between them, which describes a day nobody can perform.

`entries.ts` stays adjacency-only, and that difference is deliberate rather
than an oversight. The session screens cannot reorder anything, so they must
render exactly what is stored; the editor is the one place allowed to have an
opinion about what the stored order SHOULD be.

A ramp stays adjacency-only in both places. Consecutive rows naming the same
exercise are one climb; the same exercise squatted early and again as a
finisher is two exercises in the day, and no letter says otherwise.

## Sections are ranked, and the drag is clamped to the rank

Activations, warm-ups, prep and mobility run before the main body; cooldowns,
stretches and finishers run after it. Everything else ranks WITH the main body
and keeps the place the user put it — a section the coach invented ("Grip",
"Carries") is not banished to one end by a table that has never heard of it.

Two consequences worth writing down. Ranking happens at render AND any
grouping write stores the ranked order, so Today, the session screen and the
editor never read a different day. And the drag is clamped to the rank band
rather than being allowed anywhere: letting someone drag a cooldown to the top
and then silently ranking it back down is a UI that argues with the person
using it.

## An edited library exercise is 'edited', not 'custom'

`exercises.source` was carrying two unrelated facts: which seed may overwrite
the row, and whether the row is shared. Editing a seeded exercise only ever
meant to change the second one — the edit must survive a re-seed — and it was
expressed by re-tagging the row 'custom', which before multi-user meant nothing
more than "no seed owns this".

`20260827180000_multi_user` then gave 'custom' a second meaning: private to one
person, via `exercise_owners`. The two rules silently contradicted each other
from that day. A re-tagged row satisfied neither branch of `exercises_read`
(`source <> 'custom'` was false, and no owner row existed, because the claim
trigger fires on INSERT and the MCP path is the service role with no
auth.uid()), so it became readable by NOBODY. And `v_resolved_prescriptions`
inner-joins `exercises`, so every prescription naming that movement quietly
left the plan.

'edited' gives the first fact its own value. Nothing about the policies had to
change: all six of them, and `assertVisible` in the MCP server, already branch
on `= 'custom'` vs `<> 'custom'`, and 'edited' lands on the correct side of
every one. A CHECK now closes the vocabulary, because RLS branching on a free
text column meant a typo — 'Custom', 'custum' — published a private row.

Rejected: copy-on-write (leave the seeded row alone, insert a private copy).
It reads well until you notice that every prescription, set, training max and
goal still points at the ORIGINAL id, so the edit applies to nothing that
references it. Rejected too: writing the owner row on re-tag, which would make
fixing a typo in the shared library take that movement away from everyone else.

## Main work is a label on a run, not a block of its own

A day whose sections named themselves while its main body did not read as a
nameless stretch, then ABS, then another nameless stretch. The section
interrupted the day instead of dividing it, and nothing said where the main
work began or ended.

The obvious fix — gather the unsectioned entries into a MAIN WORK block — is
wrong, and it is worth writing down why. `moveEntry` relies on an unsectioned
exercise BEING its own block; that is exactly what lets the arrows walk it
through the whole day rather than trapping it between two headings. Gathering
them would confine every main-work exercise and silently change what those
buttons do, which is a much bigger change than the one being asked for.

So the heading is a label drawn above each RUN of unsectioned blocks, and only
once the day has a named part somewhere — a day with one part does not need to
be told what the part is. A run that resumes after a named section gets its own
heading rather than being folded back into the first: two MAIN WORK headings is
the honest picture of a day that really does go main, then abs, then main, and
it shows the person why their day looks odd instead of quietly reordering it.

The plan editor and the session screen apply the same rule. Two screens
describing different days is the bug the whole sections module exists to stop.

## A section renames itself, and can move without a drag

Two smaller corrections in the same flow.

The section panel had a Rename button on a screen whose own `saveRx` comment
says a Save button was "the odd one out" — the day's name, its date and its
note all commit by themselves. It now commits when the panel closes, exactly as
a row commits when it collapses. NOT on blur, which was tried first: tapping
"Add exercise here" blurs that input, so committing there closes the panel out
from under the tap.

And a part could only be reordered by pressing and holding its heading. The
exercise rows already had arrows ALONGSIDE their drag; sections had drag alone,
which is undiscoverable and fails WCAG 2.5.7. `moveBlock` gives them the same
two buttons, clamped to the same rank band as the drag, so a cooldown still
refuses to go above the main body — by disabling the button rather than by
springing back.

Deliberately NOT added: swipe gestures. The list already carries a
press-and-hold drag, and a horizontal swipe on rows that also scroll vertically
is the standard way to make both feel unreliable — with chalky hands, mid
workout, on a list whose destructive action removes part of a plan. Arrows plus
drag gives one visible affordance and one accessible one, which is the whole
job.

## A service worker that waits still has to be noticed

`registerType: "autoUpdate"` with `registerSW({immediate: true})` reloads the
open page the moment a new build is found. Mid-set that discards the staged
reps, the load and any half-typed note — logged sets are safe in the outbox,
the rest of the screen is not. So the worker was changed to "prompt", which
installs and waits.

Deferring every update to the next visibilitychange→hidden, with no periodic
check, was then too far the other way. The browser only looks for a new worker
when the page registers; an installed PWA can go a long time without a clean
background-and-return; and a shipped build sat unnoticed while the person using
it wondered where the feature had gone. That is a worse bug than the one being
fixed.

Split into noticing and applying. It checks on every return to the foreground
and hourly while open, and applies IMMEDIATELY when no session is in progress —
reloading Today or History costs nothing. Only mid-session does it wait, and
only until the app is next hidden. If it cannot tell which, it assumes
mid-session: a late update is a nuisance, an interrupted set is lost work.

## A logged set can be corrected, and the correction keeps its place

Sets are append-only and a wrong number was fixed by voiding the set and
logging it again. That is still the only write path — but "log it again" gave
the replacement the NEXT index, so a mistyped set 2 came back as set 5, the
LOGGED list read in the order the typo was noticed, and `rest_seconds_actual`
on the replacement measured the time spent noticing rather than the rest
before the set. The microcopy that explained "there is no pencil" was
explaining a gap, not a decision.

Tapping a logged set now moves its numbers into the steppers, LOG becomes
SAVE SET N and a Cancel puts the staged values back. Save appends the new row
with the OLD row's `set_index`, `performed_at`, `rest_seconds_actual` and
`prescription_id`, then voids the old one (`pwa/src/lib/corrections.ts`).
Only load, reps and set type change. A no-op edit writes nothing, as in the
plan editor. The set's note follows it to the new id. The rest clock is not
touched — the set still happened when it happened.

Insert BEFORE void in the outbox: if the queue dies between the two, the log
briefly holds a duplicate rather than a hole, and a duplicate is visible.
Nothing about the schema changed: no `set_voids.replaced_by` column, because
the pair is already legible in the data (same index, one voided) and a link
column would be one more thing every view had to know to ignore. History
still voids only; corrections happen while the workout is in progress, where
the steppers are.

## One day changed is one day written

`upsert_program` replaces a program wholesale and refuses to touch a confirmed
one. Those two facts together meant "add the PULL day to my plan" had no
correct call at all: the only thing a model could do was write a SECOND program
with the same name. That is what happened to a real user on 2026-08-31 — two
live plans, and four days on her calendar she never trained, every one of them
reading MISSED — and the eval reproduced it with a different model driving,
which is how we know it was the tool surface rather than the judgment.

The wholesale shape had a second failure with the same root. A day with no
prescriptions could not be restated, because the array required at least one,
so every rewrite silently dropped every empty day. In the eval one subagent
dropped a blank day and another refused a one-exercise swap outright rather
than destroy it: the surface made "change one exercise" and "keep the empty
days" mutually exclusive, so the careful model did nothing and the incautious
one deleted. Editing one day never restates the others, so both go away
together.

`update_planned_workout` takes one planned day and replaces its prescription
list in place. The DAY is the unit and the row is not, deliberately: order,
supersets, sections and ramps are all adjacency between rows, so a per-row
patch API would let a caller tear a superset in half without ever naming it.
The schema lost the `position` field it was drafted with on the way in — array
order is the order, and a caller-supplied position is a second source of truth
that can silently reshape a day.

Two mechanics carry weight. New rows are inserted at parked positions above
anything real and moved down only after the old ones are deleted, because
PostgREST has no transactions and a failure between statements should leave the
day holding two lists — visible, and fixable on the next call — rather than
holding nothing, which is the failure the whole tool exists to stop. And a day
with logged sets against it is refused in the tool, matching the trigger that
already refuses it in Postgres.

Editing a day of a CONFIRMED program takes `confirm_change=true` and the user's
approval in chat, because the change is live on their calendar the moment it
lands. There is no confirm step afterwards; nothing new was written to confirm.
Validation is shared with `upsert_program` (`lib/prescriptions.ts`) so an
exercise id or a %TM that fails one fails the other identically.

The tool description says all of this out loud, because the failure was a model
reaching for the only plan-writing tool it could see. `upsert_program` is now
for a genuinely new program and nothing else.

## An empty day is a draft, not a workout you missed

"Plan a workout" creates the dated day and then opens its editor, so abandoning
it there leaves a real, dated, empty day behind. The moment its date passed,
Today called it MISSED — for ever, for a session that was never programmed. A
real user has one of these on her calendar from 2026-08-30, sitting among three
sessions she actually trained, and it would have gone on accusing her next
year.

Today could not tell the difference on its own. Prescriptions load lazily, for
the selected day and for today's, so for every other cell in the week strip the
screen has no idea whether the day holds anything. So the count goes on the row
that describes it: `v_plan_workouts` gains `exercise_count`, additively, and
the demo mock mirrors the same subquery so the state behaves identically there.
It counts prescription ROWS rather than summing their `sets`, because a ramp is
three rows and one exercise and either number answers "is this day empty".

DRAFT sits ahead of every date check and behind DONE and SKIPPED. What actually
happened outranks emptiness — a session logged against a day nobody programmed
is still a session — but nothing that never existed should read as something
you failed to do. The card says EMPTY and points at Edit. The state computation
came out of the component so the branch ORDER, which is the whole meaning of
the function, could be pinned by tests.

The migration ships before the code that reads the column, per the runbook: the
schema tolerates a column nothing selects, and the app does not tolerate
selecting one that is not there.

## The delete doors soft delete was supposed to have closed

Two migrations gave `programs` and `planned_workouts` a `discarded_at`, both
for the same reason: prescriptions cascade from `planned_workouts`, and
`sets.prescription_id` is ON DELETE SET NULL, so ONE hard delete of a planned
day severs the link from every set ever logged against it. The sets survive.
What the plan ASKED for does not, and `sets` is append-only, so nothing puts it
back — `v_adherence` and the prescription line History renders above each
session are gone for good.

Both migrations changed how the CODE deletes. Neither dropped the POLICY that
lets the database do it. The PWA stopped taking that path, but the PWA was
never the boundary: anyone holding a session token talks to PostgREST directly,
and RLS was the only thing in the way. `programs_delete` is gone outright, and
so is `exercise_owners_delete`, which is the same shape one table over —
deleting your own ownership row does not unshare a custom exercise, it makes it
readable by NOBODY, which is precisely the state 20260901010000 had to write a
repair for, arrived at from the other direction.

`pw_delete` is NARROWED rather than dropped, and that distinction was found by
reading the client rather than the schema. `deleteTemplate` hard-deletes a
template today, and RLS refuses by returning ZERO ROWS rather than an error, so
a bare drop would have made the template delete button silently do nothing at
all. A template is dateless by constraint, never appears on a calendar, and is
APPLIED by copying its prescriptions onto a real day, so nothing can ever have
been logged against its own rows. The danger was never "delete" as a verb; it
was deleting a DATED day.

`rx_delete` stays. Removing one exercise from a day is an ordinary plan edit,
and the case that would sever history is already refused row by row by the
`prescriptions_keep_logged_history` trigger.

## An exercise name is untrusted cross-user input

`exercises.name` was `text` with no constraint. The library is SHARED, and
`update_exercise` can rename a seeded row, so that name travels: it comes back
from `search_exercises`, from `get_program` through
`v_resolved_prescriptions.exercise_name`, and from the coach's per-turn context
block, unquoted, in front of the model, for EVERY account on the deployment
rather than only the one that typed it.

The dangerous part is structural rather than semantic. A name carrying newlines
can close whatever framing it was rendered inside and open another one, and a
name carrying zero-width or bidi formatting characters can do it invisibly, so
the person reading "Barbell Squat" in the picker and the model reading the row
disagree about what the row says. One line of bounded plain text can still say
something rude; it cannot forge a turn.

So the constraint bounds the length and requires a single line of printable
text. 80 characters, calibrated against all 979 seeded rows (longest 58) and
against the punctuation they actually use — apostrophes, parens, commas,
hyphens and slashes. Deliberately NOT an allow-list of characters: whitelisting
ASCII letters would refuse a name written in a script this repo's author does
not read, and the POSIX classes that would not are collation-dependent, which
means a constraint accepting different text in PGlite than in Postgres than in
production. Naming what is dangerous — the C0/C1 controls, U+2028 and U+2029,
and the invisible formatting characters — is both narrower and portable.

## An audit stamp on the one table that may not have per-user columns

CLAUDE.md forbids `exercises` growing a per-user column, and this is an
explicit exception to it, which is why it is written down here rather than only
in the migration.

The name is bounded now but still mutable, and the question that was impossible
to answer after the fact was "this library row no longer says what the seed
says — who did that?". `source = 'edited'` records THAT a human changed a
seeded row; it cannot say which human, or when. A rename that landed in
everyone's model context had no trail back to an account at all. So `exercises`
gains `updated_at` and `updated_by`.

The rule it deviates from has two stated reasons, and neither one applies. 873
generated rows would carry a null forever: true, but null here is not a
placeholder standing in for a value that belongs in the row, it IS the answer —
"not modified since it was seeded" — true of the whole library the day this
lands and true of most of it for ever. And every re-seed would write it back:
both ON CONFLICT DO UPDATE clauses name eight columns and neither of these is
one, so no seed touches them. The rule is really about data that differs per
VIEWER; this is a single global fact about the row.

The third condition is the load-bearing one. This is an audit trail and must
never be read as ownership. Ownership lives in `exercise_owners` and nowhere
else, and no policy, view or MCP guard may branch on `updated_by`. It answers
"who touched this", not "whose is this" — which is exactly the distinction the
`source` column failed to make, and that failure is the bug 20260901010000
exists to repair.

Stamped by a trigger rather than by each writer, for the reason
`claim_custom_exercise` is a trigger: there are two write paths, and a stamp
every future call site has to remember is one a future call site will forget.
A no-op update stamps nothing, because the seeds upsert every row on every run
and a re-seed rewriting a row with the values it already holds has not edited
it. An explicitly supplied `updated_by` beats `auth.uid()`, so the MCP server
can name the token's user on a path where `auth.uid()` is null; left alone
there it stays null, which is honest rather than wrong.

## `update_exercise` joins the tools the coach cannot reach

`delete_program` and `delete_exercise` were already disabled for the in-app
coach at the connector layer. `update_exercise` now joins them, and it is a
different argument: it is not destructive, it writes OTHER PEOPLE's data.

The library is shared — everything not sourced 'custom' is one library that
every account reads — so renaming a seeded row is a write nobody can see
happening, and the new name flows into every other user's model context through
`search_exercises`, `get_program` and the context block. There is no coaching
reason to rename a shared movement, and a screenshot the coach is asked to
parse is exactly the untrusted input that would ask for it.

Turning a tool off converts "the prompt says ask first" into something an
injected instruction cannot reach. `upsert_program` deliberately stays:
drafting a plan is the job, and it lands unconfirmed, which is a real gate but
a softer one — it rests on the model's judgment rather than on structure.
Claude Desktop keeps all three, because a person typing into a desktop client
is not an untrusted screenshot.

## A basement gym is not a sign-out

Opening the app with no signal and a token that expired overnight showed the
Login screen — to someone who signed in perfectly well yesterday, whose refresh
token was sitting valid in localStorage.

`getSession()` tries to refresh an expired token and, when it cannot reach the
server, returns `session: null` with a RETRYABLE error: the same shape as a
real sign-out. Verified against the installed auth-js, which only preserves the
session while the access token is still inside its own expiry window, so past
that point a dead network and a revoked token are indistinguishable to every
caller that reads the null and stops there. Three callers did. `useAuth` showed
Login. `currentUser` reported "nobody", which HOLDS every queued write —
correct when identity is genuinely unknown, wrong when the device knows
perfectly well whose it is. And the outbox transport returned false, which
means "the server answered and there is no session, this item is dead", so the
"unreachable, keep it pending" branch it already had, with a comment explaining
exactly this failure, could never once have fired against the real transport. A
timeout on gym wifi dead-lettered a whole session's worth of sets.

All three separate "no" from "we could not ask". The transport throws on a
retryable error so the outbox's existing branch works as written, and the other
two fall back to the session auth-js has on disk.

That fallback is IDENTITY, NEVER AUTHORIZATION, and `persistedSession.ts` says
so at length. It answers "whose data is this device holding" so the shell can
render and the outbox can stamp an owner; every request still carries the real
token and is still refused by the server if that token is no good. It reads the
auth library's private storage key, which is a coupling, so it is deliberately
loose about it: any unexpected shape, any unreadable store, any missing refresh
token returns null and puts the app back on the previous behaviour.

## Only the device that started a session may discard it

The overnight sweep discarded yesterday's open sessions when they looked empty.
Both of its "empty" signals are local truths dressed as global ones:
`queuedSetCount` reads THIS device's outbox, and `lastSetAt` reads a server the
other phone has not reached yet.

So: phone A starts a session at the gym on Monday and logs 25 sets offline.
Tuesday morning the lifter opens the iPad. Both signals say zero, the sweep
discards, and phone A's sets flush into a session `v_live_sets` excludes and
the PWA has no way to un-discard. The training survives in Postgres and
vanishes from the app.

Completing stays cross-device, because it is safe from anywhere: sets that
arrive later still belong to the session, and `ended_at` only says the day is
over. Discarding now requires owning the active pointer, which is the one piece
of evidence that the absent outbox is OUR absent outbox. A foreign session that
looks empty is left OPEN, where Today's orphan card can offer it back — an open
session is a card someone dismisses, and a wrongly discarded one is training
only SQL can find.

## Today has to notice that it is tomorrow

An installed PWA is not a page load. iOS suspends it and resumes it with the
same heap and the same rendered output, so a calendar day read during render is
a fact about whenever this screen last rendered. Left open on Monday evening
and picked up on Tuesday morning, Today still said Monday and still offered
MONDAY's Start button. The first tap filed the whole workout against Monday:
its planned day, its brackets, every set. `sets` is append-only, so Monday read
DONE for ever and Tuesday stayed open for ever.

`useLocalToday` watches three signals, none of which is sufficient alone. A
timer armed for the next local midnight is the only one that fires while
someone is looking at the screen. `visibilitychange` covers the suspended app
whose timers never ran. `online` covers the phone that spent the night in a
basement. The boundary is computed from the calendar date rather than by adding
24 hours, so DST lands on the real one.

`selectedDate` follows the clock only when it was still tracking it. That state
carries two meanings which look identical — "today, because that is where this
screen opens" and "this day, because I tapped it" — and what tells them apart
is what the day used to be. Someone reading next Thursday's plan at midnight
keeps their place.

The day-change re-run opened two hazards, both closed here. Reconciliation
re-runs at midnight, which is right for a session abandoned overnight and very
wrong for one in progress: a 23:50 start would have been auto-completed at its
last logged set and the active pointer cleared out from under someone still
lifting, so the re-run stands down while this device holds a live session. The
mount run never stands down, because clearing yesterday's pointer is exactly
what a fresh launch is for. And the re-run does not re-close the start gate,
which would disable every Start button for a couple of seconds at midnight.

## The plan editor learns what a pair of dumbbells is

`load_kg` is always the TOTAL system load, and the plan editor had no per-hand
concept at all. Whatever number was typed went straight into `load_kg`, so "20"
meaning a pair of 20s was stored as a 20 kg total, and the session screen —
which DOES resolve dumbbells as per-side — prefilled 10 a hand. Half the
weight, on every dumbbell exercise, on the first set of every session. A real
user's whole plan is stored that way, and her logged sets show her retyping the
real number every time.

Both write paths now resolve the convention identically, from the exercise's
`equipment` and name, and show the same control with the same words. The scheme
sheet gains it on the way in; the row editor gains it for rows that already
exist, which is what makes an existing plan correctable in the app rather than
only in SQL. What gets stored is the total, with `load_entry` saying how it was
typed, so the number comes back the way it was written — including in the
collapsed row summary, because a summary reading 40 above an editor reading 20
is the same confusion in a smaller font.

Consequence worth recording: the plan editor now loads the exercise library on
mount rather than when the picker opens. The row editor needs each exercise's
equipment to know what its weight MEANS, and a row editor that cannot tell
dumbbells from a barbell is how this happened. The read is cached, so the
picker still opens instantly.

## A coach eval a Claude Code subagent can drive

`scripts/coach-eval/` replays turns against the REAL MCP server on a
PGlite-backed PostgREST and grades what the model DID — the rows it wrote,
whether it edited or cloned, whether a load landed doubled with `load_entry`
set. It could only be driven by the Anthropic API, and there is no key on this
machine, so it had never been run.

`serve.mjs` holds the stack up and exposes a small control API, which lets a
Claude Code subagent play the coach instead: it reads a generated prompt pack
(the real system prompt, the real tool schemas, the context block, the
conversation) and drives the tools over `tool.mjs`. Tool calls are read from
the MCP server's own log rather than self-reported, because an agent that says
it called `remember` and did not is exactly the failure being measured.

That driver cannot answer the model question — a subagent runs under a
different harness with no effort control — but it answers a question that
matters more and answers it for free: which failures are STRUCTURAL. Run 1 said
the program clone reproduces no matter who is driving, and found a second gap
the audit had missed in the empty-day rewrite. Both point at
`update_planned_workout`, which is why that tool came before any model change.
The API-driven run stays as the verification of the model question itself.

## A schema error is not a bad day for wifi

`fetchWithCache` is the read layer's whole offline story: try the server, and
on any failure serve what IndexedDB has. It caught `unknown`, and `throwIf` had
already flattened every PostgREST error to `new Error(message)`, so the catch
could not tell a phone with no signal from a server that had just answered
"column does not exist". Both got the cache, both got the banner that says
"offline", and neither went through `reportError`. That last part is what made
it a bug rather than a design: the Report-a-problem sheet exists so a person can
send what actually blew up, and it read RECENT ERRORS: none through the entire
class of failure that most needs reporting. A deploy that ships a select ahead
of its migration, the snag deploy.md already records, would have been invisible
on every device that had ever loaded the plan.

postgrest-js draws the line for us. A fetch that never got a response (offline,
DNS, a timeout, an abort) comes back with an EMPTY `code` and `status: 0`;
anything Postgres or PostgREST said carries a SQLSTATE or a PGRSTxxx code.
`throwIf` now throws a `QueryError` that keeps the code, and `staleReason` reads
it: no code is "offline", everything else — including a throw from our own
code, which is a bug and not weather — is "error".

The fallback itself did not change shape. The cache is still served whenever it
exists, because the alternative is a blank screen mid-session over a transient
500. What changed is that hiding a real error behind cached data is no longer
silent: it is reported once per message per thirty seconds (History fires seven
reads at once, and seven toasts for one broken view is noise, not information),
and the banner says "couldn’t refresh" in the warning colour rather than
"offline" in the info colour. When there is NO cache the error propagates
exactly as before and the caller reports it, as every caller already did, so
nothing is reported twice.

Rejected: rethrowing server errors instead of serving the cache. Correct in the
abstract and wrong in a gym, where the plan on screen is the thing being
trained from and the failure is usually not the lifter's to fix. Rejected: a
per-family dedupe key. A view that breaks breaks for every family that reads
it; the message is what is the same, so the message is the key. Rejected:
reporting from inside `fetchWithCache` even when it rethrows. Every caller
already reports what it catches, and two toasts for one failure teaches people
to dismiss toasts.

The factory `makeFetchWithCache` exists so the rule is tested without IndexedDB
or a network: `data.test.ts` pins offline-serves-quietly, error-serves-and-
reports, once-per-window, and propagate-when-empty.

## Migrations apply from CI, in front of the client

The deploy workflow published the PWA on every push and nothing else. A
migration needed `supabase db push` by hand, an edge function needed its own
`functions deploy` by hand, and the runbook said so — but a runbook is advice,
and the ordering it asks for (schema first, then the code that reads it) was
enforced by nobody. `prescriptions.set_type` shipped as a select before its
column existed and every write failed until someone ran the push. The
`exercise_count` question on 2026-09-05 was the same shape; it turned out to
be already applied, but establishing that took a database connection, and the
app itself would have said "offline" (the entry above).

`deploy.yml` now has a `supabase` job that pushes migrations and deploys both
functions when anything under `supabase/` changed, and the Pages job `needs` it.
A skipped Supabase job (nothing under `supabase/` changed) lets Pages run; a
failed one blocks it. The order is a property of the workflow rather than of
someone's memory.

It is gated on three repository settings and does nothing without them, so
merging the workflow changed nothing on its own. That gate is deliberate: the
settings are a credential and a database password, and adding them is a
decision the deployment owner makes in the dashboard, not something a commit
should be able to do.

The tradeoff is real and worth stating plainly: a migration reaches production
with no human between merge and database. Three facts about THIS repo make
that acceptable. CI already runs the entire chain in PGlite before a merge;
migrations are append-only by rule, so there is no destructive statement to
fire; and `db push` applies only what the remote has not seen, so a rerun is a
no-op. Remove any one of those and this decision should be reopened.

Rejected: deploying the seeds from CI too. A seed rewrites hundreds of rows in
a shared table, and "the seed file changed" should mean "someone decided to
re-seed", not "someone merged". Rejected: letting a `supabase/`-only push
republish the client. The Pages build stamps the sha into the bundle, so a
republish of identical code still shows every phone an "update available" for
nothing. Rejected: `cancel-in-progress: true`, which the old workflow had. It
is fine to abandon a Pages publish; it is not fine to abandon a `db push`.
