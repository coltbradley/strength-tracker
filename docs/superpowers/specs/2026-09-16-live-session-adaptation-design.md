# Live session adaptation

Date: 2026-09-16. Status: design agreed in chat, awaiting spec review.

Base: `main` AFTER PR 2 (`checkin-redesign`) merges. Every branch for this
work is cut from that main. Nothing here edits a file PR 2 touches until it
has merged. That PR drops `daily_readiness`, rewrites `get_checkins`, adds
`get_checkin_buckets` / `get_injuries` / `lib/testing.ts`, and owns migration
`20260916000000`.

Inputs: the 2026-09-16 "Lower Strength" session, 17 unresolved feedback items
filed during it, Sentry, Supabase advisors, and five research passes run the
same day (bar math, sync, MCP gaps, load modes, check-ins, focus/plan and
motion, missed taps). Their conclusions are restated where they apply.

## Principle

The lifter is in real life. The plan is a proposal. The app records what
actually happened, as the lifter names it, and the coach adapts the next
session to it. Nothing in this spec scores adherence, nags about a skipped
set, or infers what a set "really" was from the slot it filled.

## Problems

1. A working set was stored as a warmup. `Session.tsx:911-915` and
   `:1073-1076` default a fresh entry's `setType` to warmup while warmup
   brackets remain, and the toggle lives behind `•••` since the focus deck
   (0faa737). Four squat working sets read as 1 + 3.
2. Skips vanish. `skips` is React state cached in IndexedDB
   (`cacheKeys.sessionSkips`) and never reaches Postgres. Four skipped
   exercises on 9/16 left nothing the coach can read.
3. Swap exists (`swapExercise`, `Session.tsx:1703-1718`) but is buried, so a
   barbell-lunge substitution was logged under Bulgarian Split Squat and its
   e1RM history is now two movements.
4. Taps are silently dropped. `LOG_LOCK_MS = 400` (`Session.tsx:151`) gates
   `logSet`, `logRound` AND `saveCorrection` with an early return and no
   feedback.
5. Plate math is wrong in lb. The pad stores `Math.round(kg * 100) / 100`
   (`Session.tsx:1800`, `:1834`) and `split()` compares with `EPS = 1e-6`
   (`plates.ts:26`), so 135 lb shows as 130, 145 as 140, 315 as 310.
   Reproduced against `split()` directly.
6. Equipment is modelled as "barbell or not". A 167 lb leg press sled cannot
   be entered as a base weight from the plate sheet, a pin-stack machine
   still offers plates, and dumbbell ×1/×2 is a pair of text chips whose name
   default (`loadEntry.ts:50-51`) misses split squat, lunge and step-up.
7. Focus and overview draw done/current/skipped differently, nothing marks
   "next", rest looks backward ("Recorded against X"), the header reads as two
   menus, and Today doesn't show a just-finished workout as done
   (`Today.tsx:535` recomputes on `doneTick`, which `End.tsx` never bumps).
8. Sync noise reads as data loss. `reportSilently` (`coach.ts:187-193`)
   toasts despite its name, `SyncStatus.tsx:63-65` says STUCK in red for a
   queued write, flush doesn't retry on `visibilitychange`, and problem reports
   insert directly (`errors.ts:250-283`) instead of through the outbox.
9. The coach recomputes everything every turn and remembers no conclusion.
   A "you may be under-eating, check again in two weeks" has nowhere to live,
   and there is no one-call trend read. Set notes (knee soreness on 9/9) never
   reach `coach_memory`.

## Decisions

1. Set type, exercise identity and skips are chosen by the lifter at log
   time. The prescription slot suggests; it never decides.
2. `load_kg` stays the total system load and nothing more is recorded. The
   sled, bar or base weight matters only to the plate calculator, so it lives
   in device-local `ExercisePref` and never on `sets`. No `base_kg` column.
3. Load presentation is a closed set of six modes, device-local per exercise,
   one tap to switch. See Load modes.
4. Skips are persisted in a new append-only `session_skips` table, written
   when the workout is finished. They are context for the coach, never a
   ratio.
5. Editing a logged set stays a void plus a new row (CLAUDE.md). In focus
   mode, fixing the last set is one visible tap. Behaviour after Finish is
   unchanged.
6. The log lock guards duplicate LOG taps only, for 200 ms, and a blocked tap
   gets visible feedback. Corrections and every other control are never
   locked.
7. Motion is four named CSS motions on transform and opacity, from tokens,
   zeroed by the existing reduced-motion rule. No animation dependency.
8. Trends are computed by SQL at read time and exposed as one tool and one
   context line. Nothing derived is stored.
9. The coach's conclusions get their own table, `coach_observations`, with a
   check-back date. Due items reach the coach through the context block.
10. No recurring body-image rating. Bodyweight plus energy plus free text is
    the signal; the coach correlates in prose, never a composite.
11. Set and session notes feed memory extraction through the same
    out-of-band pattern check-ins use.

Deferred: "primary" exercises for condensed days (revisit after skip and swap
ship), Dynamic Island / Android live activity (not possible for a PWA; a
native shell is a separate decision).

## Load modes

| Mode                 | Lifter enters     | Calculator shows       | `load_kg`                     |
| -------------------- | ----------------- | ---------------------- | ----------------------------- |
| Barbell              | total             | bar + plates per side  | total                         |
| Plate-loaded machine | total             | base + plates per side | total                         |
| Stack / cable        | pin weight        | nothing                | pin weight                    |
| Dumbbell ×1 / ×2     | per hand or total | nothing                | total (`load_entry` as today) |
| Kettlebell ×1 / ×2   | per bell or total | nothing                | total                         |
| Bodyweight           | added load        | nothing                | added load (as today)         |

- `ExercisePref` gains `loadStyle?: 'plates' | 'stack'` beside `barKg`
  (which now means "base weight": bar or sled). Resolution order is the one
  `loadEntry` uses: device override, then prescription, then a guess from
  `equipment` and name.
- Name defaults, all overridable: Leg Press, Hack Squat, Smith Machine →
  plates with base 0, so first use asks for the real base. Cable *, Lat
  Pulldown, other `machine` → stack. `barbell` → plates with the unit's bar.
- `UNILATERAL_NAME` adds split squat, lunge, step-up so those default to
  `total`.
- Icons: four inline SVG components in the house style (`viewBox="0 0 24 24"`,
  like `FabDock.tsx`): barbell, plates-machine, stack-with-pin, dumbbell,
  kettlebell. The dumbbell and kettlebell icon shows one or two bells and a
  tap toggles. The machine icon toggles plates ↔ stack. Barbell and bodyweight
  have no toggle. Every icon button has a text label for screen readers and a
  44px target.
- The plate sheet gets a typed "base weight" entry that writes the exercise's
  `barKg` without adding to the global bar catalog, relabels BAR / NO BAR to
  BASE / NO BASE for machines, and is not offered at all in stack mode.
- Plate math: widen `EPS` to 0.01 kg in `plates.ts`, and make the pad and
  `Stepper.tsx:85` round the same way. Load a regression table from 9/16:
  135, 145, 225, 315, 257, 347, 437, 65, 15 lb must reconstruct exactly.

## Session capture

### Set type on the hero

The warmup / working segmented control is on the focus hero next to LOG
whenever the entry has warmup brackets, and stays in the `•••` sheet for
parity. Beside it, "Already warm" sets the draft to working and logs nothing;
warmup and working runs are counted separately (`entries.ts:226-257`) so no
label shifts.

### Fix the last set

After a log, the focus hero shows the last logged set as a tappable line
("Last: 145 × 5 working"). Tapping it opens the existing correction flow
(`startCorrection`). `onEdit` for ticks stays undefined.

### Swap and skip

- "Swap exercise" moves from the collapsed context block to a visible
  secondary action on the hero. Sets keep the performed `exercise_id` and the
  planned `prescription_id`, as they already do.
- "Skip" on the hero skips the current exercise (today's local `skips`
  behaviour), with an optional reason chip row: Equipment taken, Already warm,
  Out of time, Didn't feel right, and free text. Skipped entries render with
  the skipped state in both views (see State vocabulary).

### session_skips

```sql
create table session_skips (
  id              uuid primary key,              -- client generated
  user_id         uuid not null default auth.uid()
                    references auth.users (id) on delete cascade,
  session_id      uuid not null references sessions (id),
  prescription_id uuid references prescriptions (id) on delete set null,
  exercise_id     text not null references exercises (id),
  scope           text not null check (scope in ('exercise','warmups')),
  reason          text check (length(reason) <= 200),
  created_at      timestamptz not null default now()
);
```

- RLS: select and insert for the owner. No update, no delete, like `sets`.
- Written through the outbox with `on conflict do nothing`, one row per
  skipped entry, when the lifter taps Finish (`End.tsx`). An un-skip during
  the session therefore never hits the network. A session that is never
  finished loses its skips; that is accepted and noted in decisions.md.
- The row builder emits every column on every row (bulk-insert NULL rule).
- `get_recent_sessions` returns a session's skips beside its sets.
- Check the exact `exercises.id` type before writing the FK.

### Missed taps

`logLocked` gates `logSet` and `logRound` only, for 200 ms. `saveCorrection`
and draft edits are never gated. A tap that lands on the lock adds a
`.is-held` class to the button for one `--motion-fast` pulse. Tests: a double
LOG inserts one set; a correction saved 50 ms after a log is applied; stepper
and pad edits apply while locked.

## Clarity and motion

### One model

Overview is the map, focus is the walk. Focus stays the default. A progress
rail at the top of focus has one dot per entry; tapping a dot jumps focus to
that entry, and the rail replaces the `≡` button as the way into overview. The
same state vocabulary renders the entry rail, the set dots
(`FocusSetProgress`) and the overview rows, from one shared component.

### State vocabulary

| State    | Glyph      | Text                        | Other            |
| -------- | ---------- | --------------------------- | ---------------- |
| done     | check      | `--text-dim`                | no strikethrough |
| current  | solid dot  | full ink                    | outline ring     |
| next     | hollow dot | full ink                    | none             |
| skipped  | dash       | `--text-dim`, strikethrough | reason on tap    |
| upcoming | hollow dot | `--text-dim`                | none             |

Warmups get their own dot shape in the set dots so they're visible. Never
colour alone.

### Rest looks forward

`RestTimer` names the next set ("Next: Squat 145 × 5, set 3 of 4"), computed
from the `nextEntry` / `advanceTo` logic that already exists
(`Session.tsx:818-837`). Below it, optional RPE chips for the set just logged
(the correction path, so it's a void plus a new row only if tapped).

### Focus extras

In the `•••` sheet: How to (opens `ExerciseDemoSheet`), Add note to this set
(`set_notes`), and coach notes with expand / collapse.

### Header

`App.tsx` top bar: sync status, FabDock and settings collapse into one
visually subordinate cluster so the bar reads as one menu.

### Today

`End.tsx` bumps the done state before navigating home, so a finished day is
DONE immediately. A done day's card shows sets, working volume and duration,
and uses the done accent from the state vocabulary.

### Motion tokens

Added to the token layer beside `--dur-sheet` / `--ease-sheet`:

```css
--motion-fast: 120ms;
--motion-med: 200ms;
--ease-out: var(--ease-sheet);
```

| Motion          | Properties                                            | Duration  |
| --------------- | ----------------------------------------------------- | --------- |
| Set logged      | opacity 1→0, translateY 0→-8px on the leaving row     | fast      |
| Next set enters | opacity 0→1, translateY 8px→0, 40 ms after log starts | med       |
| Mode switch     | opacity cross-fade                                    | med       |
| Sheet           | existing `rise`                                       | unchanged |

Transform and opacity only. Nothing animates height, top or padding,
especially near the rest timer, which re-renders every 400 ms. The existing
`prefers-reduced-motion` block (`styles.css:411-420`) covers all of it.

## Sync and errors

- `coach.ts`: pass `{ toast: false }` at the three `reportSilently` call
  sites; `CoachSheet` already shows calm inline copy.
- `SyncStatus.tsx`: a retryable item reads RETRYING in neutral ink; STUCK
  and red are reserved for dead items.
- `outbox.ts`: flush on `visibilitychange` to visible, beside the `online`
  listener.
- Problem reports go through the outbox: add `feedback` to the transport's
  table union, a client UUID from `lib/uuid.ts`, diagnostics captured at
  enqueue time. Confirm `feedback.id` accepts a client UUID; if not, this
  needs a migration and says so.

## Coach and MCP

### Trends without recomputation

`v_trend_digest` (`security_invoker`), one row per user, computed at read
time:

- bodyweight: latest, 7-day and 28-day means with counts, 28-day slope per
  week (from `v_bodyweight`)
- per main lift (top 5 by working sets in 8 weeks): latest e1RM, e1RM 4 weeks
  ago, working sets this week and last (from `v_e1rm`, `v_weekly_volume`)
- energy: 14-day mean with count (from `checkins`)

Every mean carries its count. `get_trends` returns it. The context block gets
one TRENDS line built from it. Nothing is written.

### coach_observations

```sql
create table coach_observations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  topic          text not null check (topic in
                   ('bodyweight','fueling','recovery','lift','injury','other')),
  observation    text not null check (length(trim(observation)) between 1 and 500),
  recommendation text check (length(recommendation) <= 500),
  evidence       jsonb not null default '{}',
  check_back_on  date,
  status         text not null default 'open'
                   check (status in ('open','resolved','superseded')),
  outcome        text check (length(outcome) <= 500),
  superseded_by  uuid references coach_observations (id),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
```

- `evidence` is the numbers the coach saw, frozen for a later then-vs-now
  comparison. No view, chart or tool may read it as a metric. That carve-out
  from "derived metrics are never stored" goes in decisions.md.
- RLS: owner select and delete (it's the coach's opinion, deletable like
  memory). Writes come only from the MCP service role.
- Tools: `record_observation`, `resolve_observation` (status, outcome,
  optional `superseded_by`), `get_observations(status?)`. All owner-scoped by
  `db.ownerId`. Enabled for the in-app coach.
- Context block: an OBSERVATIONS section listing open items whose
  `check_back_on` is today or earlier, plus open items with no date, capped at
  five, one line each with id. Nothing else about observations rides every
  turn.
- Coach prompt: after a session review or any weight / energy / fueling
  conclusion, record an observation with a check-back date; when one is due,
  compare the evidence to `get_trends` and resolve or supersede it.
- PWA: no memory screen exists today. Add a "What the coach is watching" section to `History.tsx`: open observations with topic, check-back date and delete. Read-only otherwise.

### Session diff

`get_session_diff(session_id)`: per prescription, planned vs performed
(exercise swapped, sets taken as working vs warmup, load and reps delta, from
`v_adherence`), unplanned sets, and `session_skips` with reasons. The tool
description frames the output as "what changed, for adapting the next
session".

### Other tools

- `get_bodyweight(from?, to?)` over `v_bodyweight`, points plus 7 and 28-day
  means with counts. Registered next to the check-in tools in `handler.ts`,
  added to `EXPECTED_ANNOTATIONS` in `lib/protocol.test.ts`, tested with
  `lib/testing.ts`.
- `add_exercise` accepts `instructions: string[]`. `update_exercise` accepts
  it only when the row is `source = 'custom'` and owned by the caller;
  otherwise it refuses and points at `set_exercise_note`. Still disabled for
  the in-app coach.

### Coach prompt wording

REVIEWING A SESSION step 1 (`prompt.ts:56-58`) becomes: compare logged to
prescribed with `get_session_diff`; say what changed (swaps, skips, sets taken
as working, loads that moved) and the likely reason from notes and the order
of the day; turn it into a change for the next occurrence. Never tell the
lifter to follow the plan more closely.

Add: a single-session e1RM jump or drop over 20% is checked against set notes
and swaps before it's treated as strength change.

### Notes into memory

Migration adds `set_notes.memory_extracted_at timestamptz` and
`sessions.notes_memory_extracted_at timestamptz`, and widens
`coach_memory.source` to admit `'set_note'`. A route in
`supabase/functions/coach` copies `extractFromCheckins` (`memory-extract.ts`):
unprocessed notes above a length floor, same prompt, `parseFacts`, `newFacts`,
stamp the column. Runs where the check-in route runs.

### Indexes

One migration: `sets.exercise_id`, `prescriptions.exercise_id`,
`prescriptions.user_id`, `training_maxes.exercise_id`, `goals.exercise_id`,
`exercise_notes.exercise_id`. Skip only if an existing index already covers
the column (check `pg_indexes` in validate-db).

## Migrations

Reserved, all after PR 2's `20260916000000`:

| Timestamp                               | Content                                  |
| --------------------------------------- | ---------------------------------------- |
| `20260917000000_session_skips.sql`      | table, RLS                               |
| `20260917010000_coach_observations.sql` | table, RLS, `v_trend_digest`             |
| `20260917020000_note_memory.sql`        | two columns, `coach_memory.source` CHECK |
| `20260917030000_fk_indexes.sql`         | six indexes                              |

All additive. Each extends `scripts/validate-db.mjs`.

## Build plan

Written for Sonnet and Haiku implementers. Each task is one agent, one
branch or worktree, with an explicit file list. Two tasks that share a file
never run at the same time. `Session.tsx` and `styles.css` are the contended
files, so they're serialized.

### Rules for every implementer

- Read CLAUDE.md and this spec first. Touch only the files the task lists;
  if another file needs a change, stop and report.
- An editor hook reformats files written with Edit/Write. Prefer shell edits
  for existing files and check `git diff -w` before committing.
- `git add` explicit paths only. Never push. Never apply a migration to
  production.
- Before reporting done: `cd pwa && npm test` and `npm run build` for PWA
  tasks; `node scripts/validate-db.mjs` for SQL tasks; the tool's own test file
  plus `lib/protocol.test.ts` for MCP tasks. Paste the pass/fail lines. `tsc
--noEmit` is a no-op in this repo; use the build.
- Report: files changed, tests added, anything skipped and why.

### Wave 0: gate

PR 2 merged to main and deployed. Every branch below starts from that main.

### Wave 1: parallel, disjoint files

| Task                            | Model  | Files                                                                                                                                | Size |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1A Plate math                   | Haiku  | `lib/plates.ts`, `lib/plates.test.ts`, `components/Stepper.tsx`                                                                      | S    |
| 1B Load mode logic              | Sonnet | `lib/loadStyle.ts` (new) + test, `lib/loadEntry.ts` + test, `lib/settings.ts` + test                                                 | S    |
| 1C Migrations                   | Sonnet | the four migrations, `scripts/validate-db.mjs`                                                                                       | M    |
| 1D Sync noise                   | Sonnet | `lib/coach.ts`, `components/SyncStatus.tsx`, `lib/outbox.ts`, `lib/errors.ts`, `components/ReportBugSheet.tsx`, `lib/sync.ts`, tests | M    |
| 1E Icons + motion tokens        | Haiku  | `components/icons/LoadIcons.tsx` (new), token layer of `styles.css` only                                                             | S    |
| 1F MCP reads without new tables | Sonnet | `tools/get_bodyweight.ts` (new), `tools/manage_exercises.ts`, `lib/handler.ts`, `lib/protocol.test.ts`, tests                        | S    |

1A's pad rounding lives in `Session.tsx:1800,1834`; 1A only widens `EPS` and
fixes `Stepper`, and 2A aligns the pad.

### Wave 2: Session.tsx, one task at a time

| Task                                                          | Model  | Files                                                                                                           | Depends           |
| ------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| 2A Tap lock + pad rounding                                    | Sonnet | `screens/Session.tsx`, `Session.test.tsx`                                                                       | 1A                |
| 2B Set type on hero, Already warm, fix last set, visible swap | Sonnet | `Session.tsx`, `session/SetEditor.tsx`, `session/FocusDeck.tsx`, `session/FocusMoreSheet.tsx`, styles for these | 2A                |
| 2C Skip reasons + `session_skips` write at Finish             | Sonnet | `Session.tsx`, `screens/End.tsx`, `lib/db.ts` (outbox op), `lib/sync.ts`, `lib/types.ts`                        | 2B, 1C, 1D merged |
| 2D Load mode UI                                               | Sonnet | `session/SetEditor.tsx`, `components/PlateSheet.tsx`, `Session.tsx` (`loadPresentation`), styles                | 2C, 1B, 1E        |

In parallel with wave 2, on files it doesn't touch:

| Task                   | Model  | Files                                                                                                                                                                 | Depends                               |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 2E MCP writes and diff | Sonnet | `tools/coach_observations.ts` (new), `tools/get_trends.ts` (new), `tools/get_session_diff.ts` (new), `tools/get_recent_sessions.ts`, `handler.ts`, `protocol.test.ts` | 1C, 1F                                |
| 2F Today done state    | Sonnet | `screens/Today.tsx`, `screens/End.tsx` (done bump only), styles for the done card                                                                                     | none; merge before 2C touches End.tsx |
| 2G Header              | Haiku  | `App.tsx`, its styles                                                                                                                                                 | none                                  |

### Wave 3: clarity, after wave 2 merges

| Task                                           | Model  | Files                                                                                                  | Depends |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ | ------- |
| 3A State vocabulary component + progress rail  | Sonnet | `session/StateGlyph.tsx` (new), `FocusDeck.tsx`, `WorkoutOverview.tsx`, `Session.tsx` (wiring), styles | 2D      |
| 3B Rest looks forward + RPE chips              | Sonnet | `components/RestTimer.tsx`, `Session.tsx` props                                                        | 3A      |
| 3C Motion                                      | Sonnet | `Session.tsx` class hooks, `FocusDeck.tsx`, styles                                                     | 3B      |
| 3D Focus extras: how-to, set note, coach notes | Haiku  | `FocusMoreSheet.tsx`, `Session.tsx` (`moreExtrasFor`)                                                  | 3C      |

In parallel with wave 3:

| Task                            | Model  | Files                                                                             | Depends |
| ------------------------------- | ------ | --------------------------------------------------------------------------------- | ------- |
| 3E Coach prompt + context block | Sonnet | `functions/coach/prompt.ts`, `lib/coachContext.ts` (TRENDS, OBSERVATIONS) + tests | 2E      |
| 3F Notes into memory            | Sonnet | `functions/coach/memory-extract.ts`, `functions/coach/index.ts` + tests           | 1C      |
| 3G Observations list in PWA     | Haiku  | `screens/History.tsx` section, `lib/data.ts` read                                       | 2E      |

### Wave 4: close out

One Sonnet task: `docs/decisions.md` entries (lifter decides set type; skips
table and the lost-if-unfinished trade; base weight is presentation only;
observations and the evidence carve-out; no body-image rating), CLAUDE.md
bullets for `session_skips`, load modes and `coach_observations`, then the
full check: `npm test`, `npm run build`, `validate-db.mjs`, MCP tests. The
reviewing session (not the implementer) reads the whole diff against the hard
rules before anything is pushed, and follows `docs/deploy.md`.

Housekeeping, by the reviewing session with the user's OK: resolve Sentry
JAVASCRIPT-REACT-3 (stale `set_type` schema-cache error), resolve the test
feedback item, and resolve each feedback item as its task ships.

## Testing

- Plate table from 9/16 in lb and kg; `loadStyle` defaults for leg press,
  hack squat, smith, cable row, lat pulldown, leg extension; `loadEntry`
  defaults for split squat, lunge, step-up.
- Session: double LOG inserts one set; correction 50 ms after a log applies;
  "Already warm" makes the next logged set working; swapped set keeps
  `prescription_id` and the performed `exercise_id`; Finish enqueues one
  `session_skips` row per skipped entry with every column present.
- `validate-db.mjs`: `session_skips` has no update/delete policy;
  `coach_observations` select/delete owner-only; `v_trend_digest` means carry
  counts and bucket by `app_tz`; the widened `coach_memory.source` CHECK;
  the six indexes exist.
- MCP: owner scoping for every new tool (another user's rows never appear);
  `update_exercise` refuses `instructions` on a seeded row; `get_session_diff`
  reports a swap, a skip and a warmup-taken-as-working.
- Manual on an iPhone: 135 lb shows 45 + 45 per side; leg press base 167
  shows plates for 257; stack mode shows no plates; dumbbell icon toggles;
  finish a workout and Today shows DONE immediately; lock the phone mid-rest
  and unlock with the queue flushing and no red pill; Reduce Motion on kills
  every motion.

## Open questions

1. Weigh-in entry point. The check-in sheet is capped at three inputs by
   choice (PR 2). Options: a weigh-in on the End screen (`sessions.bodyweight_kg`
   already exists), a small line in History, or a fourth input on the sheet.
   Recommendation: End screen plus History, sheet untouched.
2. Should editing a set lock after Finish? Today it doesn't, and that is safe
   under void-plus-row. The lifter said locking is acceptable, not required.
   Recommendation: leave it open.
