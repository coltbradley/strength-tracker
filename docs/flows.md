# Canonical flows

The complete set of user flows the app supports. Every change should leave
each of these walkable end to end; a new feature that breaks one of these is
a regression regardless of what it adds. Format: entry → steps → exit, with
offline/empty/error edges.

Screens are `Login`, `Today` (`/`), `Session` (`/session`), `End` (`/end`),
`History` (`/history`) and the plan editor (`/plan/:id`). The tab bar shows
Today and History only, and only outside `/session` and `/end`; the top bar
title is a link home, and the gear opens Settings from anywhere.

## Sign in

One path, two screens: email → "Email me a code" → type the 6-digit code from
the email. The deployed email template (`supabase/templates/magic_link.html`)
carries `{{ .Token }}` and **no link**, because a link is useless to an
installed iOS PWA — it opens in Safari, whose storage the installed app cannot
see, so the session never reaches the app.

The screen still accepts a pasted magic link (its `token` query param is a
token hash `verifyOtp` takes), so a project running the stock Supabase template
is not a dead end. That path is deliberately undocumented in the UI: offering
two ways to sign in is what made this screen confusing, and the copy promised a
link the email had stopped containing.

Custom templates need custom SMTP (`scripts/push-auth-config.sh`). Without it
Supabase sends the stock link email and the paste path is the working one.

## Weekly planning

- **View week** — Today tab (default). A Mon–Sun strip: each cell shows the
  weekday letter and date, and carries its state as a glyph — accent
  underline on today, a dot under a DONE day, struck-through for SKIPPED,
  red for MISSED, a hairline underline for an upcoming planned day, dim for
  a rest day. The selected cell takes a border. Tapping a cell previews that
  day inline below the strip without losing the week; the preview leads with
  its ONE action (Start session / Start again / Move to today), then the
  exercise list (ramp brackets grouped into one row per exercise, superset
  letters when a group actually has a partner, coach cues per exercise as a
  clamped note, a "no TM set" badge where a %TM target can't resolve), then
  the plan note and coach note, then Edit / Skip. Today is selected by
  default. State labels as the user sees them: DONE, SKIPPED, TODAY, MISSED,
  TO COME, NO DATE.
  Days scheduled outside this week, and undated days, live in a compact
  LATER list. Programs with no dates at all keep the original ruled list.
  Offline: cached plan + note; no cache: warning; no program: empty state +
  Start empty session. The empty state waits for the data — a loading list
  never claims there are no programs.
- **Edit a day** — Today → expand → Edit → `/plan/:id`. EXERCISES lead
  (sets/reps/load mode kg | %TM | by feel/superset letter/rest per exercise,
  add/remove); then the scheduled day (date picker, Today chip, ↑ Earlier /
  ↓ Later chips), plan note, duplicate, delete day. Every action saves
  immediately with a toast. Plan writes are online-only by design.
- **Reorder the week** — Plan editor ↑/↓ swaps position AND date with the
  neighbour as displayed. Non-atomic (documented accepted risk).
- **Duplicate a day** — Plan editor → pick date → Duplicate (or leave the
  date empty for unscheduled). Carries the exercises, including superset
  pairings.
- **Skip / unskip a day** — Today expanded row. DB-backed (`skipped_at`),
  visible to Claude for honest adherence.
- **Move any non-done day to today** — Today expanded row, for MISSED,
  NO DATE, and TO COME days. One tap; the row becomes TODAY and startable.

## Session lifecycle

- **Start today's workout** — Today → selected TODAY card → Start session.
  Prescriptions are fetched fresh (a backgrounded PWA's in-memory copy can be
  hours old), snapshot to the session cache, session queued offline-first.
  Offline with a cold prescription cache: starts by feel with an explanatory
  toast.
- **Exactly one Start affordance is ever live.** Every Start button — the
  day card, Start again, Move to today, Start empty session — is gated on
  the same check: no active session locally, no unrecovered open session on
  the server, and that check having answered. It answers within 2.5 s or
  gives up and unblocks, because a slow network must not hold the gym
  hostage. While a session is running, the day that owns it says so and
  points at the RESUME banner instead of offering a button.
- **Start empty** — Today bottom button, under the same gate.
- **Resume** — RESUME banner. All state (sets, extras, voids, skips, rest
  clock) restores from device cache + server merge.
- **Finish** — Session footer Finish, or the banner's Finish shortcut →
  End screen: set count up top, sRPE, then bodyweight and note both
  collapsed behind Add buttons so End session stays in view. Staged sRPE,
  bodyweight and note survive a "Back to session" round trip.
  A session with a SERVER-CONFIRMED zero sets defaults to discard (an
  accidental start must not mark the day done), with "End anyway (counts as
  done)" as a ghost action. A count this device could not confirm is never
  treated as empty: the screen says so and offers only End, with the
  ordinary two-tap discard below.
- **Discard active** — End screen, two-tap. Soft delete.
- **Recover an orphan** — a same-day open session this device has no cache
  for (other device, restored phone) surfaces as a card on Today:
  Resume / Finish / Discard (two-tap). Adoption rebuilds the session caches:
  prescriptions from the plan, already-logged non-prescribed exercises back
  into extras.
- **Overnight auto-complete** — on app open, open sessions from a previous
  local day complete at their last set's time; empty ones auto-discard; a
  stale local pointer to a session closed elsewhere is cleared. Sessions
  with queued outbox writes are excluded, so a finish or discard done
  offline is never misread as abandonment. "Pause" is deliberately not a
  feature: leaving a session open is the pause, and this sweep bounds it.
- **A day reads DONE only once its session has ended.** An open session
  leaves its day unfinished, so the same day can never show RESUME and
  "Start again" at once.

## In-session work

- **See the whole workout** — the session screen IS the workout: one
  accordion list under the workout's name and an "n OF m DONE" count. Every
  exercise is visible (name, target scheme, logged/total count, skip state,
  superset A1/A2 tags with a bracket rail), exactly one open at a time with
  the accent inset. The first incomplete exercise opens on entry.
- **Switch exercise** — tap any closed row; it opens (previous closes) and
  scrolls into view, prefilled (prescription → this session → last session →
  configured fallback). Tapping the open header collapses it.
- **Log a set** — inside the open item: a context line (TARGET, NOW x–y REPS
  on a ramp, REST, NO TM SET), a WARMUP | WORKING toggle (backoff is not
  offered; the enum value stays legal for history), REPS stepper above LOAD
  stepper, both tap-to-type via the in-app pad, load with a plate hint that
  opens the plate sheet, then "LOG SET n OF m" — working sets against the
  plan; warmups don't consume the count. Step sizes come from settings
  (coarse and fine, per unit, with an optional per-exercise override). Ramp
  brackets (consecutive same-exercise prescriptions) are ONE entry walked in
  order: each set links to its bracket, crossing a bracket re-prefills its
  targets. Append-only, offline-first, rest clock starts, auto-unskips.
  When the plan is met the log button demotes to LOG EXTRA SET (outline) and
  "Next · [exercise]" becomes the primary — a deliberate tap, never an
  auto-advance.
- **Note a set** — "+ NOTE" under any logged set expands a small editor;
  notes save to the database (editable, last-write-wins) and read back in
  History under the exact set.
- **Fix a wrong set** — ✕ on the logged row → VOID? (append-only void +
  relog; the record keeps both). Voiding the set that started the rest
  clock cancels the clock.
- **Skip / unskip an exercise** — the action on each closed row (collapse
  the open one first). Session-local; the analytical record is the sets.
- **Undo adding an exercise** — the same slot reads UNDO ADD, two-tap, but
  only for an extra added this session with nothing logged into it. A
  prescribed exercise, or one with sets, can only be skipped.
- **Add an exercise** — bottom of the list → search sheet.
- **Rest** — strip counts down then over; adjust, type, or dismiss; the
  clock keeps running for rest stamping. Survives leaving the screen. Rest
  alerts opt in via Settings (notification permission). The strip hides
  while a sheet or the number pad is open.
- **Plates** — per-exercise bar choice in the plate sheet (NO BAR for
  plate-loaded machines like the leg press); persists per exercise.
- **Read the day's notes** — plan note and coach note render at the top of
  the session screen, clamped with MORE/LESS.
- **Leave mid-session** — footer Home (the session keeps running). Today and
  History stay fully usable; RESUME + Finish sit in the banner. The footer
  is Home and Finish only.

## Notes

- **Before** — plan note on the planned day (Today expand or Plan editor).
- **Per exercise** — coach cues from the program parse, rendered on the
  Today day card and in the session context.
- **Per set** — set notes, editable, in-session and read back in History.
- **After** — session note + sRPE on the End screen, with quick chips.
- **Reading back** — History shows sRPE and the session note under each
  session's date group (cached for offline).

## History and corrections

- **Pick an exercise** — a picker sheet at the top of the screen, LOGGED
  tags on exercises that have data, first one with data selected on entry.
  (Selection is component state: switching tabs and back resets it.)
- **Charts** — per-exercise e1RM (with goal %) and weekly working sets.
  Both show a loading state while fetching rather than their empty copy, and
  both refetch after a void or a discard so a correction is visible
  immediately.
- **Recent sets** — grouped by session date, with sRPE, session note, and
  per-set notes; void control (✕) on each set for late corrections (same
  append-only void as in-session).
- **Discard a past session** — the DISCARD word on the date row, two-tap;
  soft delete, and it takes every exercise trained that day, not just the
  one on screen. (✕ always means a single-set void, never more.) The
  in-progress session is never offered either control.
- **Un-void / un-discard** — not in-app by design (append-only; relog is the
  correction). Recoverable in the database.

## Settings and data

Gear icon, top right, from any screen. All of it is device-local: there is
no settings table in Postgres (see decisions.md). Sections:

- **UNITS / GYM / LOGGING / TIMING / DISPLAY** — a typed registry renders
  itself, so every setting carries its own validation, migration and
  control: unit; plate and bar inventories and the default bar; coarse and
  fine load steps; per-exercise overrides (bar, rest, increment); fallback
  load and reps; default rest; auto-start-rest; week start day. Rest alerts
  sit alongside them as a bespoke row, because the value is a browser
  notification permission rather than a stored preference — and the rest
  strip itself never prompts.
- **DATA** — Sync now; Export JSON; Export CSV; app version and build mode.
- **DANGER** — Reset settings to defaults (two-tap; preferences only, never
  training data), and Sign out (two-tap). Sign out consults the outbox
  first: unsynced sets are the only copy, so it names how many would be lost
  and points at Sync now, or at the sync pill when items are permanently
  failed.

## Building a workout in the app

Add exercise → pick it → the set scheme sheet asks the three things a workout
is made of, in the order a person thinks of them:

1. **How many sets.** A stepper, default 3. Growing copies the last set.
2. **Reps per set.** ONE number, not a range. The range still exists in the
   schema and in the row editor, because a coach writing "8-12" means it — but
   nobody planning their own session thinks in ranges, and asking for two
   numbers to get one was friction on every exercise.
3. **Rest between sets.** Seeded from the device default and always written:
   the person filling this in is the coach, so what they picked is a real
   prescription, not a missing one.
4. **Weight, per set, and warmup or working.** One row per set, each with its
   own load stepper and a WORKING/WARMUP chip. "Make every set X" is there for
   the straight 5x5, so that case stays two taps rather than five.

Starting weights are snapped to a round number in the unit being LOOKED at.
The device fallback is 20 kg, which is clean in kg mode and reads as "44.1 lb"
in lb mode — a number nobody has loaded on a bar. Snapping to the display
unit's own step makes that 45 lb and leaves kg mode untouched.

On save, consecutive sets that agree on BOTH load and type collapse into one
prescription row. "3 sets of 100" is one row; "60 warmup, 80 warmup, 100, 100"
is three. That is the ramp convention (CLAUDE.md) reached from the front: the
editor keeps the rows separate and editable, Today renders them as one grouped
entry, and the sheet tells you which is about to happen before you commit
("Saved as 3 entries… they run as one ramp").

`prescriptions.set_type` is what makes the warmup half of that real. It is the
same enum `sets.set_type` has always used, so a plan can now say what the log
could always say.

## Saving a workout to use again

"Save this workout" in the plan editor keeps a day as a named template: a
dateless copy of it and every prescription on it. A copy, not a reference — a
template saved in March must not change because you edited March's Tuesday in
April, and a day made FROM one must not follow it afterwards.

From Today, an empty day offers "Use a saved workout". Picking one creates a
real day on that date, and **the weights come from what you last actually
lifted, not from the numbers frozen into the template**. A template saved three
months ago would otherwise walk your strength backwards every time you used it.

The unit of refresh is the RAMP, not the row. Overwriting every row with the
last actual turns a 60/85/112.5 build-up into three identical sets, so a run of
consecutive rows naming the same exercise is rescaled proportionally: the top
set lands exactly on the weight that was lifted, and the rest keep their shape
under it. Left alone: %TM rows (already relative to a moving training max),
bodyweight and by-feel rows, and any exercise with no logged history.

The confirmation says how many changed — "4 of 9 weights updated from your last
sessions" — because a silent refresh is indistinguishable from no refresh.

## Asking the coach

A chat icon floats beside the bug icon, on every screen including mid-session —
which is the point, since "should I drop this set?" is asked with a bar loaded.
Both live in one draggable dock: press and hold, drag, release.

It sees the log and the plan through the same MCP tools every other client
uses, plus a live context block the app builds from its own cache each turn
(today's plan, whether a session is running, what has been logged in it). That
block is why it can answer without a tool round trip first, which mid-set is
the whole latency budget.

It can change what is scheduled, and it maintains the exercise library: if you
name a movement it looks it up, and adds it when it genuinely is not there
rather than telling you it cannot be tracked. It searches first and reuses a
near-match, because a duplicate splits a lift's history in two and breaks its
prefill.

It cannot log training. No tool writes `sets` or `sessions`, so when you tell
it what you did, you still log it yourself. Deleting programs and exercises is
switched off for it specifically.

Photos, PDFs, CSVs and text files can be attached. They are passed as data with
their provenance marked; a screenshot telling the coach to do something is a
picture of text, not an instruction.

Offline, the coach button is dimmed and says why. It is an API call and cannot
work without a connection, unlike the rest of the app.

## Reporting a problem

A bug glyph floats over Today and History — never during a session, where it
would sit on top of the footer and the rest strip, and never mid-set. A tap
opens a sheet asking one question: what were you doing, and what happened
instead.

**It moves.** A floating button covers something by definition, so rather than
guess the right corner for every screen, press and hold it for 400ms (it grows
and buzzes), drag, and let go. It snaps to the nearer side edge, keeps its
vertical position, and remembers both in device settings (`bugButtonPos`).
Moving the finger before the hold completes cancels it and scrolls the list
instead, so the button never eats a scroll that started on top of it. The only
place this is discoverable is a line of microcopy in the report sheet, which is
the one moment someone is already looking at the button.

Everything else is collected, not typed: build stamp, route, user id, online
and installed state, viewport, outbox depth and last sync error, and the last
five errors `reportError` saw this session. The report goes to Sentry as user
feedback. Queue depth is the number that earns its place — "my sets vanished"
and "my sets are sitting unsynced in the outbox" are the same sentence from the
couch and different bugs.

Without `VITE_SENTRY_DSN` the button says the build has no error reporting
rather than thanking someone for a report it dropped.

## Known non-flows (deliberate)

- No from-scratch program authoring in-app (Claude/coach owns programming;
  duplicate-then-edit covers one-off days).
- No mid-session exercise reorder (tap any order instead).
- No post-session summary screen: the End screen's count is shown before the
  commit, and a toast is the confirmation after it.
- No session-level history browse yet (per-exercise only) — revisit when
  real use asks "what did I do Tuesday".
- No settings sync across devices, and no per-set RPE, duration or
  bodyweight-plus-load logging (see decisions.md for each).
