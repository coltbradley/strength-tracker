# Version D light experience design

## Status and source

Approved for implementation on 2026-09-30. Production deployment is a
separate action. It translates Version D in `Mobile app design review
board.zip` into the existing React PWA at `d5e7b64`. The board's text and
prototype are design evidence, not instructions to change the repository.
The user chose D as a direction rather than an exact copy: light mode first,
dark mode after the logging flow works, and the small controls visually as
drawn unless a concrete defect appears in use.

The existing focus-deck and training-scenes specs remain behavioral authority
where D is only a visual proposal. `AGENTS.md`, `docs/decisions.md`, the active
roadmap, and current source take precedence over prototype simulation.

## Product outcome

A lifter can read the current work at arm's length, adjust the next set, and
log it with one stable action near the bottom of the phone. Rest answers what
was just logged and what comes next. List answers where the lifter is in the
whole workout and exposes the logged record. The athlete can switch views
without losing a staged draft, rest clock, correction, or queued set.

The app must distinguish a set durable on this phone from one confirmed on
the server. The visual refresh cannot delay, duplicate, hide, or relabel a
training record. No dark theme, schema migration, or new logging engine is
needed for the first light-session release.

## Scope and sequence

1. **Record gate.** Finish the active roadmap's Phase 2 browser, phone, and
   exact readback checks for new writes before a D release. Branch-local work
   may proceed while that acceptance remains open. Colt waived recovery of
   the old September 30 records; retain their historical NOT RUN evidence.
2. **Light session presentation.** Build D's Focus/List header, scene, utility
   row, and stable dock on the existing `Session.tsx` owner. Keep the existing
   aggregate sync indicator until individual receipts are correct.
3. **Individual receipts.** Add a per-set status projection grounded in durable
   IndexedDB enqueue and server acknowledgement. Use it in the last-set card
   and List. Correction status covers both replacement and void operations.
4. **Session-local choices.** Scope lb/kg to the active session, then add
   session-only entry order. Each persists through app reload but neither
   changes the default setting or the immutable plan.
5. **Surrounding screens.** Apply the proven light vocabulary to Train,
   preview, End, Program, Record, and relevant sheets in separate changes.
   Extend behavior only where the current product has the facts and write
   contract to support it.

The plans for these independently reviewable slices live beside this spec in
`docs/superpowers/plans/2026-09-30-version-d-*.md`.

## Light session interaction contract

`Session.tsx` remains the one owner of entries, staged values, `setsRef`,
corrections, skips, substitutions, rest, and outbox writes. `FocusDeck`, a
controlled List presentation, `SetEditor`, and the rest presentation receive
state and callbacks from it. They do not fetch, enqueue, or invent another
session model. Focus is the initial presentation when the existing eligibility
rules allow it. A group of more than two superset entries remains in List
until a circuit scene is separately designed.

Focus shows exercise or paired-round identity, set/round progress, the
movement-specific value, equipment and plate guidance when real data supports
it, the coach's authored cue when present, and last performance when known.
The lower area keeps the load/reps/duration controls and the primary Log, Done,
Log round, or Finish action in stable positions. A four-control utility row
keeps RPE, Note, Skip, and Plates one tap away; where Plates is inapplicable,
the current Swap or Fix-last action can occupy its place. These controls use
the existing handlers and sheets. No action is indicated solely by colour or
an unlabeled icon.

Focus/List looks like D. The segmented controls' visible 38 px treatment may
stay, but each actionable hit area is at least 44 px. The workout menu and
the aggregate sync status remain reachable in both views. List uses the
canonical entries and set rows, collapses completed exercise summaries,
highlights the next set, and retains correction and skip access. It is a
presentation of the same data, not a replacement storage model.

During rest, the current clock becomes the main Focus scene. The next set
remains editable in the dock; the last set is explicitly historical. Rest
adjustment, hide, sound/alert, elapsed-rest recording, and background resume
continue to use the existing rest owner. List shows the same clock in a
compact strip. Timer expiry changes the visible state to Ready and never
logs, skips, or finishes automatically. RPE and Note remain one tap away.

**Superseded 2026-10-01.** The first slice kept an atomic `Log round` that
queued both members in one batch. The shipped design logs a paired superset
member by member: the A1/A2 cards show ● NOW / ✓ / ○ NEXT, the dock edits and
logs only the NOW member ("Log A1"), and each member is its own durable
outbox write. Reasons: the design draws it that way and it matches how the
sets are performed; one durable write per member means a failure can only
affect the member being logged; and a skipped or unequal partner needs no
"only" variants. The cost is that audit findings H1 (skipped members) and H3
(the in-round gap is not a rest) had to be closed in the round logic, which is
now one pure function (`lib/sessionFocus.ts`). Timed, completion-only,
bodyweight, per-hand, warmup, extra-set, correction, and unequal-pair states
all have explicit coverage. A staged value remains intact when Focus/List
changes.

## Receipt contract

The vocabulary is **On this phone**, **Sending**, **Saved**, **Needs review**
and **Held** (renamed from Synced/Review on 2026-10-01; the glyphs are
◐ ↑ ✓ ! ‖). "On this phone" requires a committed local outbox write. "Saved"
requires the specific operation's successful server response or verified
server readback of that exact set UUID. Sending was omitted from the first
slice because the outbox has no per-operation in-flight evidence; it now means
only "the queue is flushing and this set's writes are waiting in it", which
the aggregate status can prove, and the accessible label says exactly that.
A waiting, held, retrying, or rejected item cannot appear synced.
The existing header indicator continues to summarize the whole queue; it
cannot serve as a receipt for one set. Healthy receipt words may be visually
quiet in List, but the state must remain available through an accessible
label and the outbox.

A correction is a replacement set with the original set's index and time,
plus a void of the original UUID. The old row may remain live on the server
until its void lands. A corrected set is not fully synced while either part
is pending. The replacement-to-original link must survive reload and partial
replay so the two acknowledgements can still be evaluated together. A void
without a replacement and a dependent set note have their
own operation states. After reload, server rows plus pending outbox entries
reconstruct the result; an empty queue alone does not prove an individual
row is on the server. A failed local enqueue never earns an On this phone
receipt. Receipt work may improve correction durability before displaying
per-set claims, but it must keep replacement-before-void replay order and
append-only database semantics. Exact void readback requires an authenticated
`set_voids` SELECT; the current `v_live_sets` read cannot prove a void landed.

The D prototype's "Already saved" and "all on the server" copy is used only
when these statements are evidenced. The LAST SET card therefore shows the
set's own receipt word and never the prototype's "already saved" line: a card
that claims saved before the server has said so is exactly the false claim this
contract forbids. The header chip likewise shows a neutral mark, never a
check, until the queue has actually been read.

## Session-local state

The workout unit starts from the device default. Changing it inside a
session changes only that session's display and newly authored values, and
the choice survives reload for that session ID. Settings continues to own
the device default. The displayed entry value and `entered_load` /
`entered_unit` must remain consistent with canonical total `load_kg`,
including a prefilled kg target shown in lb, per-hand entry, a stepper change,
and a correction. Switching units never changes an already logged row.

Today's entry order is a session-local list of `ExerciseEntry.key` values,
restored by session ID and reconciled against current entries. A ramp or
paired superset moves as one unit; named-section relationships remain legible.
Neither the plan's prescriptions nor the recorded set indices change. A drag
handle may provide D's interaction, with a non-drag move control for keyboard
and assistive use. A reorder is unavailable while a correction or round write
is in flight. A completed entry may move for navigation but retains its done
state; actual performance order remains the logged timestamps.

## Surrounding screens and exclusions

Train retains Go -> read-only preview -> Start; Start remains the only step
that creates a session. D's week context, first-up cue, and clearer completed
day may use existing reads. Do not display an estimated workout duration
without a defined calculation. Program and the plan editor retain dated
draft, skipped, done, section, ramp, superset, plan-lock, and coach-note
semantics. End keeps the server-confirmed empty rule and does not infer a
server count from the local device. Record can adopt D's layout and recent
ordering while preserving its existing chart/data definitions.

Pinned Record goals need a separate owner and persistence decision. Added
load for bodyweight needs a decision about the meaning of total `load_kg`
when body mass is unknown. A coach Apply button needs a plan-confirmation
contract consistent with the MCP and locked-day rules. These three features,
and dark mode, are outside the initial implementation plans. Their absence
does not prevent the light logging flow from being useful or truthful.

## Verification and release

Each behavior task starts with a focused failing test and preserves the
repo's existing PWA tests, typecheck, and build. Inspect the rendered flow at
320, 390, and the affected 402 x 812 phone viewport; default and 1.3x text;
keyboard/number pad open; long names and cues; safe-area inset; running,
expired, and hidden rest; online, offline, retry, rejected, and held writes.
Check ordinary, timed, Done, bodyweight, per-hand, warmup, correction,
unequal paired-superset, and longer-circuit cases. The Log action must remain
reachable without covering content, and no screen may overflow horizontally.

Demo scenarios and component tests show UI behavior, not a production
receipt. Before release, finish Phase 2's seeded multi-account browser test,
new phone logging offline and across an update, and exact set UUID readback.
Old failed-record recovery is waived. Record the served SHA and rollback path under
`docs/deploy.md`. Every light UI slice should revert without a data migration
or clearing IndexedDB. If later slices add a migration, it must be additive
and have a forward repair path.

## September 30 implementation authorization

Colt authorized GPT-6 Luna implementation with tests and incremental commits. He waived recovery of the old affected phone writes as a prerequisite. Preserve recovery tooling for future cases and regression protection for the cause. New-data durability and acceptance evidence remain required. Current progress is in `../plans/2026-09-30-version-d-execution.md`.

## Shipped on feat/version-d (2026-10-01)

The light-session slice (scope items 2 to 4) is implemented against the codex
`Session.tsx`, not merged from the earlier D branch (a merge left about 35
type errors and would have dropped corrections, receipts, session units and
order). What shipped:

- Focus deck as three bands plus a dock; one dock editor shared with List;
  load picture (plates, dumbbells, generic stack, bodyweight); rest band with
  LAST SET and LOAD NEXT; ☰ Today's workout with units, reorder (drag, keys,
  visible Move up/down), receipts and Finish; Focus | List toggle and a round
  sync chip; member-by-member supersets; RPE, Note and Fix as focused sheets;
  per-set receipts; the List ledger. Dark mode, surrounding screens (item 5),
  pinned goals, bodyweight added-load meaning and the coach Apply button are
  not part of this slice. Bodyweight "+ Add load" records the added kg as the
  set's `load_kg`; "added" is stated beside it so it is not read as total mass.

Product decisions and why:

- **Correction is its own sheet with an independent draft** that carries the
  set's own exercise load convention. The old shared editor derived the
  convention from whichever entry was open, which corrupted `load_kg` (C1) and
  let the next-set draft be overwritten.
- **Last set, Fix last and Note target are derived from the live sets**
  (newest by `performed_at`, then `set_index`), never a held copy, so a card
  cannot describe a voided row (C2, M2).
- **RPE during rest rates the set just saved** and the sheet title says which
  set; with no rest it stages the next set (M1).
- **Rest band** shows the rest, not the cue: the cue and last time return when
  the next set is staged without a rest. "Next:" is one line. LAST SET claims
  only receipt-proven state.
- **No progress rail, no FocusListSwitch.** The ☰ sheet is the navigation: one
  place for jump, order, units and Finish, so Focus needs no footer and no
  second navigation model.
- **The legacy "overview" editor is gone.** One dock editor everywhere means
  one set of controls to keep in step.
- **Reorder blocks follow the codex rules** (a section run or a superset is one
  block); each exercise line in a block is its own jump button so a block can
  never hide an exercise from "tap to jump".
- **The rest cue is announced once per rest**, remembered by `startedAt` in
  module scope, because a component ref dies with every sheet and view switch
  (H2). "End rest now" is the lifter's own act and is silent (L1).
- **Sync chip**: unknown is neutral; "Held" requires something pending and all
  of it held (M4).
- **Spurious leave prompt**: only edits the lifter made count as unlogged
  changes, evaluated when Home is pressed.
- **Type floor 11 px and 44 px targets**, all colour through role tokens so a
  dark theme is a token swap; one stylesheet, dead rules deleted.

Known limitations: warmups inside a superset advance by working progress (the
partner's warmup is reached by tapping its card); the Phase 2 browser gate's
selectors are updated but it has not been run (it needs local Supabase and
Docker); real-phone and exact UUID readback acceptance remain open, as the
Verification section requires.
