# Canonical flows

The complete set of user flows the app supports. Every change should leave
each of these walkable end to end; a new feature that breaks one of these is
a regression regardless of what it adds. Format: entry → steps → exit, with
offline/empty/error edges.

## Weekly planning

- **View week** — Today tab (default). Confirmed program's days as a ruled
  list, chronological when dated; states DONE / SKIPPED / TODAY / MISSED /
  NO DATE / TO COME. Tap to expand: prescriptions, plan note, coach note.
  Today's row auto-expands once. Offline: cached plan + note; no cache:
  warning; no program: empty state + Start empty session.
- **Edit a day** — Today → expand → Edit → `/plan/:id`. Date (commits on
  close), plan note (auto-saves on blur), per-exercise sets/reps/load
  (kg / %TM / by feel)/rest, add/remove exercise, delete day. Every action
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
  End screen: sRPE, bodyweight, note → End session. A session with ZERO
  sets defaults to discard (an accidental start must not mark the day done).
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

- **See the whole workout** — the WORKOUT section lives inside the session
  scroll (no modal): every exercise with name, target, logged count, skip
  state, and the current one marked. The footer's Workout n/n button shows
  progress at a glance and jumps to the section.
- **Switch exercise** — tap any row in the WORKOUT section; the screen
  returns to the steppers, prefilled (prescription → this session → last
  session).
- **Log a set** — big steppers + LOG SET. Append-only, offline-first, rest
  clock starts (prescribed rest or default), auto-unskips.
- **Fix a wrong set** — ✕ on the logged row → VOID? (append-only void +
  relog; the record keeps both).
- **Skip / unskip an exercise** — WORKOUT section row action. Session-local;
  the analytical record is simply which sets exist.
- **Add an exercise** — WORKOUT section → Add exercise → search sheet.
  Extras with no sets can be removed; prescribed entries only skip.
- **Rest** — strip counts down then over; adjust, type, or dismiss; the
  clock keeps running for rest stamping. Survives leaving the screen.
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
- **Discard a past session** — ✕ on the date row, two-tap; soft delete.
- **Un-void / un-discard** — not in-app by design (append-only; relog is the
  correction). Recoverable in the database.

## Known non-flows (deliberate)

- No from-scratch program authoring in-app (Claude/coach owns programming;
  duplicate-then-edit covers one-off days).
- No mid-session exercise reorder (tap any order instead).
- No session-level history browse yet (per-exercise only) — revisit when
  real use asks "what did I do Tuesday".
