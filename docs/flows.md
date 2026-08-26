# Canonical flows

The complete set of user flows the app supports. Every change should leave
each of these walkable end to end; a new feature that breaks one of these is
a regression regardless of what it adds. Format: entry → steps → exit, with
offline/empty/error edges.

## Weekly planning

- **View week** — Today tab (default). A Mon–Sun strip: each day cell shows
  the weekday letter, date, and state (accent underline = today, dot = done,
  faint underline = planned, struck = skipped, red = missed, dim = rest).
  Tapping a cell previews that day inline below the strip without losing the
  week; the preview leads with its ONE action (Start / Start again /
  Move to today), then the exercise list (ramp brackets grouped into one row
  per exercise, superset letters when paired), then collapsed notes. Today
  is selected by default.
  Days outside this week or undated live in a compact LATER list. Programs
  with no dates at all keep the original ruled list. Offline: cached plan +
  note; no cache: warning; no program: empty state + Start empty session.
- **Edit a day** — Today → expand → Edit → `/plan/:id`. EXERCISES lead
  (sets/reps/load/rest/superset per exercise, add/remove); then schedule
  (date, reorder chips), plan note, duplicate, delete day. Every action
  saves immediately with a toast. Plan writes are online-only by design.
- **Reorder the week** — Plan editor ↑/↓ swaps position AND date with the
  neighbor as displayed. Non-atomic (documented accepted risk).
- **Duplicate a day** — Plan editor → pick date → Duplicate (or unscheduled).
- **Skip / unskip a day** — Today expanded row. DB-backed (`skipped_at`),
  visible to Claude for honest adherence.
- **Move any non-done day to today** — Today expanded row, for MISSED,
  NO DATE, and UPCOMING days. One tap; the row becomes TODAY and startable.

## Session lifecycle

- **Start today's workout** — Today → TODAY row → Start. Prescriptions
  snapshot to the session cache, session queued offline-first. Offline with
  a cold prescription cache: starts by feel with an explanatory toast.
- **Start empty** — Today bottom button (hidden while a session is active).
- **Resume** — RESUME banner. All state (sets, extras, voids, skips, rest
  clock) restores from device cache + server merge.
- **Finish** — Session footer Finish, or the banner's Finish shortcut →
  End screen: sRPE up top, bodyweight and note both collapsed behind Add
  buttons so End session stays in view. A session with ZERO sets defaults
  to discard (an accidental start must not mark the day done).
- **Discard active** — End screen, two-tap.
- **Recover an orphan** — a same-day open session this device has no cache
  for (other device, restored phone) surfaces as a card on Today:
  Resume / Finish / Discard. Adoption rebuilds the session caches.
- **Overnight auto-complete** — on app open, open sessions from a previous
  local day complete at their last set's time; empty ones auto-discard; a
  stale local pointer to a session closed elsewhere is cleared. "Pause" is
  deliberately not a feature: leaving a session open is the pause, and this
  sweep bounds it.

## In-session work

- **See the whole workout** — the session screen IS the workout: one
  accordion list, every exercise visible (name, target, working-set count,
  skip state, superset A1/A2 tags with a bracket rail), exactly one open at
  a time with the orange inset accent. The first incomplete exercise opens
  on entry.
- **Switch exercise** — tap any closed row; it opens (previous closes) and
  scrolls into view, prefilled (prescription → this session → last session).
  Tapping the open header collapses it.
- **Log a set** — inside the open item: WARMUP | WORKING toggle, REPS
  stepper (above load), LOAD stepper (±5 display units + tap-to-type +
  plate hint), then "LOG SET n OF m" (working sets vs the plan; warmups
  don't consume the count). Ramp brackets (consecutive same-exercise
  prescriptions) are ONE entry walked in order: each set links to its
  bracket, crossing a bracket re-prefills its targets, the context line
  shows "NOW x-y REPS". Append-only, offline-first, rest clock starts,
  auto-unskips. When the plan is met the log button demotes to LOG EXTRA
  SET and "Next · [exercise]" becomes the primary (never auto-advances).
- **Note a set** — "+ NOTE" under any logged set expands a small editor;
  notes save to the database (editable, last-write-wins) and read back in
  History under the exact set.
- **Fix a wrong set** — ✕ on the logged row → VOID? (append-only void +
  relog; the record keeps both). Voiding the set that started the rest
  clock cancels the clock.
- **Skip / unskip / remove** — the action on each closed row (collapse the
  open one first). Session-local; the analytical record is the sets.
- **Add an exercise** — bottom of the list → search sheet.
- **Rest** — strip counts down then over; adjust, type, or dismiss; the
  clock keeps running for rest stamping. Survives leaving the screen. Rest
  alerts opt in via Settings (notification permission).
- **Plates** — per-exercise bar choice in the plate sheet (NO BAR for
  plate-loaded machines like the leg press); persists per exercise.
- **Read the day's notes** — plan note and coach note render at the top of
  the session screen.
- **Leave mid-session** — footer Home. Today/History fully usable; RESUME +
  Finish in the banner.

## Notes

- **Before** — plan note on the planned day (Today expand or Plan editor).
- **After** — session note + sRPE on the End screen.
- **Reading back** — History shows sRPE and the session note under each
  session's date group (cached for offline).

## History and corrections

- **Charts** — per-exercise e1RM (with goal %) and weekly working sets.
- **Recent sets** — grouped by session date with notes; void control on each
  set for late corrections (same append-only void as in-session).
- **Discard a past session** — the DISCARD word on the date row, two-tap;
  soft delete. (✕ always means a single-set void, never more.)
- **Un-void / un-discard** — not in-app by design (append-only; relog is the
  correction). Recoverable in the database.

## Known non-flows (deliberate)

- No from-scratch program authoring in-app (Claude/coach owns programming;
  duplicate-then-edit covers one-off days).
- No mid-session exercise reorder (tap any order instead).
- No session-level history browse yet (per-exercise only) — revisit when
  real use asks "what did I do Tuesday".
