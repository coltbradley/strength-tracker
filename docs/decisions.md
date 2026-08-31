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
