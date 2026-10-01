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

## Train

- **Train tab** (default). Top to bottom, with no empty gap under the strip:
  the date and a 44px Check in button; this week's seven days, each a glyph
  with a short state word under it (DONE, SKIP, TODAY, NEXT, REST, DRAFT,
  MISSED, PAST); then the day. The words come from the same state Program's
  strip uses, so DONE still means the session has `ended_at` and an empty day
  is DRAFT, never MISSED. MISSED is said only for a dated, non-empty, unfinished
  past day AND only once the done-state has been read; if that read failed with
  nothing cached the past day reads PAST ("not knowing is not failing"). A date
  with two workouts shows today's pending one over a done one. Tapping a day
  opens Program (its spoken name ends "open program").
- **A workout day**: `TODAY · {program}`, the workout label, "{n} movements ·
  {m} sets" (no duration: nothing in the plan or log yields an honest one),
  a FIRST UP card (first movement and its scheme, "then …" for the second), the
  coach note with an ink speech-bubble icon (ochre is reserved for the current
  set), and a big **Go**. Go opens the workout preview sheet; Start lives there.
- **Session open**: `IN PROGRESS · N MIN` (past 12 hours it says when it
  started instead: `STARTED YESTERDAY`), the label, `n sets logged · m planned`
  (server sets plus sets queued on this phone, less corrections still queued;
  it includes warmups and extras, so it is not "n of m") and **Resume**. If the
  server read failed and nothing is cached the count is left out, never 0. An
  unrecovered open session still gets the orphan card instead.
- **After finishing today**: a `✓ {label} finished` card comes first, then
  what is true about the sets, read from the outbox (set writes only, any
  session): `checking…` until the outbox has been read and who is signed in is
  known; `N waiting on this phone` (waiting or held: a held write is NOT on the
  server); `N need review` (refused); and only with none of those, `all sets on
  the server`. Other queued writes (session end, voids, notes, bodyweight) are
  never called sets: they add `· N other changes waiting`. When this phone knows
  the finished session and is online, the line uses the same exact-UUID
  receipts the Session screen shows instead of an empty queue: `N sets
  confirmed on the server` only when every live set was read back by its UUID,
  `k of N sets not confirmed on the server` otherwise; a failed read falls back
  to the queue wording. Then REST DAY / Recover. and the next workout.
- **Draft today**: the label and a dashed "Draft — nothing planned in it yet.
  Not a missed day." with Fill in this day. Offline or failed refresh shows a
  dashed one-line note over the cached plan.
- **Nothing ready today**: for a SKIPPED, NO DATE or MISSED day with nothing
  else to start, the card says "Rest day / Nothing is ready to start today."
  with View program.
- **More than one confirmed program**: when any confirmed program has dated
  days, the strip and cards use the days of all of them (one shared calendar;
  the card names the program the day belongs to). Undated DAY 1..N programs
  have no shared order, so only the newest is shown and the others are named in
  a note ("Also confirmed, not shown here: …").

## Weekly planning

- **View week** — Program tab. A Mon–Sun strip: each cell shows the
  weekday letter and date, and carries its state as a glyph — accent
  underline on today, a dot under a DONE day, struck-through for SKIPPED,
  red for MISSED, a hairline underline for an upcoming planned day, dim for
  a rest day. The selected cell takes a border. Tapping a cell previews that
  day inline below the strip without losing the week; the preview leads with
  its actions, then the exercise list (ramp brackets grouped into one row per exercise, superset
  letters when a group actually has a partner, coach cues per exercise as a
  clamped note, a "no TM set" badge where a %TM target can't resolve), then
  the plan note and coach note, then Edit / Skip. Today is selected by
  default. State labels as the user sees them: DONE, SKIPPED, TODAY, MISSED,
  TO COME, NO DATE, EMPTY.

  EMPTY is a day nothing has been programmed into yet. "Plan a workout"
  creates the day before its contents, so an abandoned one used to become a
  MISSED workout the day after — a session someone failed to do that was
  never written. `v_plan_workouts.exercise_count` is what lets the strip tell
  the difference without loading every day's prescriptions.

  A day that is not today carries TWO actions, and the copy separates them
  because they mean opposite things. "Do this workout now" starts the session
  against that planned day and changes no dates: the plan is fine, the lifter
  is ahead or behind. "Reschedule to today" rewrites `scheduled_date`: the
  plan itself was wrong. It was called "Move to today", which reads as "do it
  today" and sent people to the destructive one.
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
  day card, Start again, Do this workout now, Reschedule to today, Start
  empty session — is gated on the same check: no active session locally, no unrecovered open session on
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
  ordinary discard unavailable. Sessions with logged sets stay in history and
  only offer End.
- **Discard active** — only a server-confirmed empty session can be discarded.
  The PWA waits for the outbox result before clearing the active session or
  navigating away. Offline, discard remains queued and the screen says it is
  waiting for sync. If another device's set arrives first, Postgres refuses
  the discard as a permanent row rejection; the screen keeps the session open
  and explains that the workout should be ended instead. If a queued set
  arrives after the empty session was discarded, Postgres restores the
  session before accepting the append-only set, so the workout returns to
  history and derived views.
- **Recover an orphan** — a same-day open session this device has no cache
  for (other device, restored phone) surfaces as a card on Today:
  Resume / Finish / Discard (two-tap). Adoption rebuilds the session caches:
  prescriptions from the plan, already-logged non-prescribed exercises back
  into extras.
- **Overnight auto-complete** — on app open, open sessions from a previous
  local day complete at their last set's time; empty ones auto-discard; a
  stale local pointer to a session closed elsewhere is cleared. Sessions
  with queued outbox writes are excluded, so a finish or discard done
  offline is never misread as abandonment. Even when an empty session is
  discarded, its planned day stays linked and locked because another device
  may still have queued sets. "Pause" is deliberately not a feature: leaving
  a session open is the pause, and this sweep bounds it.
- **A day reads DONE only once its session has ended.** An open session
  leaves its day unfinished, so the same day can never show RESUME and
  "Start again" at once.

## In-session work

The session screen has two views of the same entries, switched by the Focus |
List toggle in the header. Neither owns state: staged values, the running rest
clock, a correction in progress and queued sets survive a switch. Focus is the
default for an eligible session (two-member supersets, reps, timed and
tick-only work); a circuit of three or more members opens in List and says
why.

- **Header** — a round ☰ count ("9/25", skipped exercises excluded so it can
  reach its total), the Focus | List toggle, and a round sync chip. The chip
  reads the queue: ✓ only when the queue has been read and is empty; a neutral
  dashed mark until then; "On phone · n", "Sending · n", "Held" (everything
  waiting belongs to another account) and "Retrying" are different words for
  different states, and an unreadable queue never shows a check. A tap opens
  the Outbox sheet.
- **Today's workout (☰)** — one sheet for everything that is about the whole
  session: the unit for THIS session (lb | kg, with what Settings keeps), every
  exercise as a row with its state glyph, target, count and a quiet roll-up of
  its per-set receipts, tap to jump, today's order, "+ Add exercise", "Back to
  Train (the session keeps running)" and "Finish session". A superset or a
  named-section run is one movable block whose members are each their own jump
  button. Order is session-local (`sessionOrder`): drag the ⠿ handle, press
  ArrowUp/ArrowDown on it, or use the visible Move up / Move down keys; all
  three reach the same guarded move and the plan and set indices never change.
  A move the block rules refuse says so, and the keys disable while a log or a
  correction is in flight. Rows pinned by an open correction are disabled, not
  silent.
- **Focus** — three bands and a dock. Top: exercise name (or "Superset A" and
  "round n of m"), `SET n OF m` and the segmented progress, and the quiet •••
  more control. Middle (the only part that scrolls, above the dock, at 320 px
  and at 130% text): the picture of the load — plates, dumbbells, a generic
  weight stack that never implies a pin position, or the bodyweight card —
  then the coach cue in ink and last time. Dock: load and reps side by side
  (a timed set keeps its load beside the duration; a bodyweight set is
  reps-first with "+ Add load"), four small keys — RPE, Note, Skip, and Swap
  (before any set) or Fix last — and one full-width Log that reads "Saving…"
  and refuses a second tap while its write is in flight. A finished exercise
  has no next set to stage: the dock leads with the next exercise (or Finish),
  keeps Note and Fix last, and "+ Extra set" arms the editor again.
- **Load picture** — plate-loaded exercises show the plates per side and the
  base ("Bar 20 kg · change"); the sled/stack switch is offered only for
  plausible plate machines (leg press, hack squat, smith, chest press, calf
  raise) and never for a cable; an unset sled base reads "Set sled weight".
  Dumbbells show the pair and the total. The plate sheet edits the base, the
  type and the per-exercise choice, synced to your account.
- **Already warm** — while an exercise still has a prescribed warmup, a link
  beside the WARMUP | WORKING toggle stages the working set and logs nothing; it
  is a shortcut, not a skip, and is unrelated to the "Already warm" REASON chip
  that the Skip key offers.
- **Log a set** — Log appends one set at the next `set_index`, stamps the rest
  it ended, starts the rest clock and advances. Working sets count against the
  plan, warmups do not. Ramp brackets are one entry walked in order; crossing a
  bracket re-prefills its targets. A 200 ms lock after each tap stops a double
  tap inserting twice; a correction's Save is never gated. A failed local write
  keeps the draft, says so, and offers retry; nothing is shown as logged
  unless it is durable on this phone.
- **Rest** — the clock replaces the picture in the middle band: ◷ RESTING with
  −30 / +30, tap the clock to type a time, and a single-line "Next: Barbell
  Row · set 3 of 4". When the target passes it becomes a REST OVER card
  ("Ready when you are") and never logs, skips or finishes anything by itself.
  Below it: LAST SET (the set just saved, its receipt word, and Fix) and LOAD
  NEXT (the plates for the next set, tapping opens the plate sheet). The dock
  is tagged "NEXT SET · SET 4 OF 6" with "End rest now ›". The tone and
  notification fire once per rest — however many sheets, remounts or
  Focus/List switches happen — and "End rest now" is silent. List shows the
  same clock as a compact strip with a Hide.
- **LAST SET and receipts** — every logged set carries a receipt in words and a
  glyph: ◐ On this phone (a committed local write), ↑ Sending… (the queue is
  flushing and this set's writes are waiting in it), ✓ Saved (the server
  returned that exact set UUID, or acknowledged it), ! Needs review (rejected,
  or only the cache remains), ‖ Held (queued under another account). The LAST
  SET card shows only what the receipt proves; it never says "already saved"
  on its own. After a correction it names the replacement row, and while that
  correction's void is still held behind the replacement it also says
  "Correction waiting to send": the server holds both rows live until the void
  lands.
- **RPE and Note** — RPE opens a focused sheet. During a rest it rates the set
  just saved ("Rate set 2, just saved"); with no rest it stages the next set
  ("RPE for the next set"). A rating on a saved set is a correction underneath.
  Note opens a focused editor for the newest live set of what is on screen,
  never a voided row; it saves to `set_notes` and waits for the local write.
- **Fix a wrong set** — "Fix last" (the dock), "Fix" (the LAST SET card) or a
  logged row in List opens the correction as its own sheet with its own
  draft, in the SET's own exercise's load convention, so a set of exercise X is
  never corrected under Y's editor and the staged next set is never touched.
  The save is one atomic local bundle: the replacement at the same
  `set_index` and `performed_at`, the void of the original, the link between
  them and the set's note. Failure keeps the sheet open with everything typed.
  ✕ on a logged row (List) is a two-tap void.
- **Skip / unskip** — the Skip key opens reason chips (Equipment taken,
  Already warm, Out of time, Didn't feel right) or free text; a skipped entry
  shows "Skipped · <reason>. Unskip to log it." even during a rest (and the rest
  band then drops its NEXT SET tag and LOAD NEXT card). Session-local; the record
  is the sets.
- **Superset rounds** — a two-member superset is logged member by member. The
  middle band shows an A1 card and an A2 card (● NOW, ✓ done this round,
  ○ NEXT, – SKIPPED), a one-line hint, and the NOW member's load picture; the
  dock edits and logs only the NOW member ("Log A1"). Each member is its own
  durable insert. There is no rest between A1 and A2; the clock starts after
  the round's last member, in non-final rounds only, and A2's
  `rest_seconds_actual` is null (the gap is not a rest). A skipped member counts
  as finished, so the partner is NOW and loggable; tap a card to log that
  member next (an A2-first round), or "Unskip A1" on a skipped card.
- **List** — the whole workout as a ledger: one open card (the exercise you are
  on) with its logged sets, their receipt marks and the same dock; every other
  exercise one quiet row (done collapsed, the rest dim). Tap a row to make it
  the open card.
- **Switch exercise** — ☰ or a List row; staged values are kept per exercise.
- **Add an exercise** — ☰ → "+ Add exercise" (or the List footer) → search
  sheet. **Undo add** is two-tap, only for an extra with nothing logged.
- **Plates** — per-exercise bar choice in the plate sheet (NO BAR for
  plate-loaded machines); persists per exercise.
- **Read the day's notes** — plan and coach notes sit in the ••• sheet and at
  the top of List.
- **Leave mid-session** — ☰ → "Back to Train" in Focus, or Home in List's
  footer (the session keeps running). If a set has been edited but not logged
  the app asks first; logging a set and leaving never triggers that prompt.

## Notes

- **Before** — plan note on the planned day (Today expand or Plan editor).
- **Per exercise** — coach cues from the program parse, rendered on the
  Today day card and in the session context.
- **Per set** — set notes, editable, in-session and read back in History.
- **After** — session note + sRPE on the End screen, with quick chips.
- **Reading back** — History shows sRPE and the session note under each
  session's date group (cached for offline).

## History and corrections

- **Record list** — `/history` opens on a list: a search field (every word
  must match, any order), PINNED GOALS (each a card with the newest e1RM,
  target, % and a progress bar, plus a quiet `◆ Pinned` toggle), then RECENT
  (most recently performed day first; ties broken by how many sessions in the
  last 90 days included the exercise, then name; each row shows the date, "5
  sessions in 90 days", its e1RM and a `◇ Pin` toggle), then "Search the full
  library" (the picker sheet), then bodyweight, the week, check-ins, coach
  observations and the session log. Empty: "Your record starts with your first
  finished session." A failed read with nothing cached shows "Couldn't load
  your record" with Try again. Cached data carries the offline / "couldn't
  refresh" note. Sets logged on this phone and not yet sent move their
  exercise up and read "on phone, not sent yet"; sets voided or sessions
  discarded here leave the list at once. If the scan hit its cap, a note says
  older exercises may be missing. Tapping a row opens its detail; `‹ Record`
  returns. Selection is component state: switching tabs and back resets it.
- **Pin** — an exercise is pinned exactly when a `goals` row exists for it.
  `◇ Pin` writes one with a target about 5% above the current e1RM, rounded
  up to 2.5 kg / 5 lb; `◆ Pinned` removes it. Needs an e1RM, so it is
  disabled until the exercise has a 1–8 rep working set. Goal writes go
  straight to PostgREST (not the outbox), so they need a connection: offline,
  Pin / Pinned / − / + are disabled with "Needs a connection to pin or change
  goals." A failed write puts the goal back as it was and says so. Removing a
  goal that has a target date (possibly set by the coach) asks for a second
  tap and says what goes; every removal shows UNDO for 6 seconds, which
  restores the exact goal, date included. The toggle's label is "Pinned goal:
  name" with pressed state.
- **Detail goal card** — pinned: the target with `−` / `+` (2.5 kg or 5 lb per
  tap, announced to screen readers, % updates at once) and `◆ Pinned`;
  unpinned: "Pin as goal". The recent sets list includes this phone's unsent
  sets, marked "on phone, not sent yet"; the charts use only sent sets.
- **Charts** — per-exercise e1RM (dashed goal line, goal %) and weekly working sets.
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
- **Log weight** — the same `BodyweightRow` Today shows, rendered here too
  regardless of which exercise is picked: a standing fact about the person,
  not about any one exercise's history.
- **What the coach is watching** — the coach's own open conclusions
  (`coach_observations`), one entry per topic with its check-back date and a
  two-tap DELETE. Read-only otherwise: the coach writes and resolves these
  from a turn, never the lifter, who can only remove one that stopped being
  useful.

## Settings and data

Gear icon, top right, from any screen. Global settings are device-local;
there is no `user_settings` table. The one exception is the per-exercise
overrides (base weight, plates vs stack, one or two dumbbells, rest, step,
unit), which sync to your account (decisions.md, 2026-10-01): set on one phone,
true on the others, dropped from a phone when a different account signs in.
Sections:

- **UNITS / GYM / LOGGING / TIMING / DISPLAY** — a typed registry renders
  itself, so every setting carries its own validation, migration and
  control: unit; plate and bar inventories and the default bar; coarse and
  fine load steps; per-exercise overrides (bar, rest, increment; synced); fallback
  load and reps; default rest; auto-start-rest; week start day; Appearance
  (Light / Dark / System, default Light, applied by `lib/theme.ts`). Rest alerts
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

## Sections and tick-only movements

A session is not a flat list. It is activations, then the main lift, then abs,
and the parts behave differently: nobody records 12 reps at 0 kg for a banded
glute bridge, they record that they did it. Forcing every movement through
weight-and-reps made the warmup half of a session either a lie or unlogged.

**Sections** are a name on a prescription, not a table. Consecutive rows
sharing one render under a heading — the same shape supersets use, and the same
shape a ramp uses. Set it when adding an exercise or later in the row editor,
so a workout built before sections existed can be organised afterwards. The
sections already used in a day are offered first, with Activations / Abs /
Cooldown as defaults.

There is no "add a section" button, and that is structural rather than an
omission: `section` is a column on a prescription, so a part cannot exist
without an exercise in it. You make one by filing an exercise under a name, and
then add into it from the heading.

**MAIN WORK** is the null section. It gets a heading too, but only once the day
has a named part somewhere — a day with one part does not need to be told what
the part is — and it is drawn above each RUN of unsectioned exercises rather
than gathering them into a block (decisions.md says why). So a day that goes
main, then abs, then main shows two MAIN WORK headings, which is the honest
picture rather than a silent reorder.

Tapping a heading opens its panel: rename (which commits when the panel closes,
like every other field on that screen), add an exercise directly into the part,
move the whole part up or down within its rank band, or remove the heading —
which leaves its exercises in the day, in order, as main work. The heading is
also a drag handle, but the arrows are the discoverable half and the accessible
one.

**Tick-only** movements (`tracking = 'done'`) drop the weight and rep controls
entirely: one tap per set, "DONE 2 OF 3". It still writes a real row in `sets`
— reps 0 at load 0, both already legal — because a second kind of completion
record is one no view, no chart and no MCP tool knows how to read. Volume and
e1RM ignore it through the filters they already had, not through a new
coupling to the plan.

Claude can set both: `upsert_program` takes `section` and `tracking`, and the
review table shows them.

## Asking the coach

A chat icon floats beside the bug icon, on every screen including mid-session —
which is the point, since "should I drop this set?" is asked with a bar loaded.
Both live in one draggable dock: press and hold, drag, release.

Its answers render as formatted text — bold, lists, headings — parsed into
elements rather than HTML, because the text comes from a model that has just
read an uploaded screenshot and someone's CSV. Nothing in that path touches
innerHTML, so there is nothing to sanitise.

It sees the log and the plan through the same MCP tools every other client
uses, plus a live context block the app builds from its own cache each turn
(today's plan, whether a session is running, what has been logged in it, a
TRENDS line of bodyweight, energy and top-lift e1RM/volume computed fresh
from `v_trend_digest`, and an OBSERVATIONS line naming its own open
conclusions that are due for a look). That block is why it can answer
without a tool round trip first, which mid-set is the whole latency budget.

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

A turn survives the app closing. The function finishes and records every turn
whether or not anyone is still listening, against an id the client chose before
asking — so a question asked mid-set and interrupted by the phone locking is
waiting when the app reopens, rather than showing a truncated reply with no way
to tell it is truncated.

What it costs is shown in the sheet: turns today, spend today, spend this
month. Recorded either way, but the person asking is not the person paying, and
a number nobody sees is a number nobody acts on.

Offline, the coach button is dimmed and says why. It is an API call and cannot
work without a connection, unlike the rest of the app.

## Adding an exercise mid-session

Same sheet as the plan editor, reached from "Add exercise" during a session:
how many sets, reps, rest, weight per set, warmup or working, which part of the
day it belongs to, and whether it is logged by weight-and-reps or by ticking it
off. Declare it, then tick it off — the screen counts "LOG SET 2 OF 4" against
what you declared, exactly as it does against a coach's prescription.

Anything sayable while planning means the same thing said on the gym floor. The
sheet is offered the sections THIS day already uses, in plan order, and naming
a superset letter says who it pairs with. Both were missing until 20260831:
adding a warmup mid-workout offered only the generic defaults, every letter
meant nothing, and — worse — the section and the tracking mode were collected
and then dropped on the way to the entry, so choosing "just tick it off" still
produced a load stepper and a reps stepper.

The declaration is device-local and never reaches `prescriptions`, which
belongs to planned days. It is synthesised into the same bracket shape the
session screen already reads, so the target, the load prefill and the warmup
handling all come from the code that already does it for a planned exercise.

Two things that has to get right. Sets logged against a declared scheme carry
`prescription_id` NULL, because that column is a foreign key and a synthesized
id would fail the insert and then fail forever on the offline queue. And a
declared entry claims its sets BY EXERCISE rather than by bracket id — matching
on ids would attribute nothing, and the counter would sit at "SET 1 OF 4" no
matter how many sets went in.

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
- No reordering of the PLAN from the session screen. Reordering today's workout
  is session-local only (☰ → Today's workout): it never changes the plan or any
  set index, and it is not synced.
- No post-session summary screen: the End screen's count is shown before the
  commit, and a toast is the confirmation after it.
- No session-level history browse yet (per-exercise only) — revisit when
  real use asks "what did I do Tuesday".
- Global settings do not sync across devices (there is no `user_settings`
  table); only the per-exercise prefs do (decisions.md, 2026-10-01). The unit
  and the order chosen for one session are session-local and never sync.
- No swipe gestures anywhere. The lists already carry a press-and-hold drag,
  and a horizontal swipe on rows that also scroll vertically makes both feel
  unreliable — with chalky hands, mid workout, on a list whose destructive
  action removes part of a plan. Reordering is arrows plus drag: one visible
  affordance, one accessible one.
- No "add a section" button. `section` is a column on a prescription, so a
  part cannot exist without an exercise in it; you make one by filing an
  exercise under a name.
