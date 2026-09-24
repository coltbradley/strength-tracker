# Training scenes and native units implementation plan

> Required implementation skill: use superpowers:subagent-driven-development or superpowers:executing-plans. Keep commits independently testable.

Goal: Make planning and active training legible by scene, redesign paired supersets, and preserve lb/kg as native authored values while retaining canonical kg analytics.

Design: docs/superpowers/specs/2026-09-23-training-scenes-design.md

## Non-negotiable constraints

- Sets remain append-only. Corrections are void plus replacement at the original set index and performed time.
- Sessions, sets, skips, and set notes remain PWA-only writes.
- load_kg stays the total system load in every metric and MCP calculation.
- Timer expiry may move the interface to the next ready-to-log set or next
  unfinished entry, but may never write, skip, or finish.
- All database work is additive. Existing records stay valid and readable.

## Task 0: Gate scene work on session and grouping integrity

Implementation disposition (2026-09-23): the first local integrity slice is
implemented and verified: durable session enqueue precedes the active pointer,
ordinary and partial member logs wait for a durable local write, post-commit
queue-count failures cannot masquerade as failed writes, staged drafts require
an explicit discard on Home, stale visible rest clears, active-day editing is
refused on the device holding the session, and Plan/MCP share contiguous,
two-distinct-exercise superset validation. Cross-device session uniqueness,
server-side plan-mutation refusal, and the remaining database lifecycle
findings stay separate migration and reconciliation work; this client gate does
not claim to solve them.

Files:

- Modify: the smallest relevant session-start, Session bootstrap, rest, and
  Plan/MCP validation modules after tracing each writer
- Modify: focused PWA, database, and MCP tests
- Modify: docs/roadmaps/release-ledger.md only after actual evidence

Steps:

- [ ] Reconcile the current source against audit findings A-91, A-92, A-107,
  A-163, A-165, A-166, and A-176 to A-180 before moving visual controls. In
  particular, reproduce or close zero-row session close, historical-target
  mutation, a normal log shown before durable local enqueue, incompatible
  grouping, active-plan deletion, non-atomic section editing, the start-queue
  ghost session, pending-void resurrection, staged-input loss on navigation,
  and stale rest state with current tests and a controlled device.
- [ ] Define one shared superset-run contract across Plan and every MCP
  plan-writing path: a group is contiguous and cannot be reused in a later
  non-adjacent block. A two-member run is eligible for paired Focus. A larger
  run is explicitly an overview-only circuit until a circuit scene exists.
  Preserve existing coach-authored rows; do not add an arbitrary database cap
  without a migration and rollout decision.
- [ ] Make session start recoverable: do not publish an active-session pointer
  until its durable local session write is known to exist, and give an enqueue
  ambiguity a recover/reconcile path rather than treating it as absence.
- [ ] Make ordinary single-set logging use the same durable-local-commit
  boundary as a superset round before updating the Focus state or playing its
  success motion. A server retry is allowed; a missing local queue item is not.
- [ ] Keep active-session adjustments session-local. Disable or refuse plan
  mutation after the session starts or the day has logged work, and state the
  choice in the UI instead of presenting it as an editable prescription.
- [ ] Clear visible rest state whenever auto-rest is off or the current action
  has no actionable rest. Measurement and `rest_seconds_actual` may remain
  separate from whether a cue is shown.
- [ ] Add regression coverage for duplicate/open-session recovery, failed or
  ambiguous enqueue, reload after pending void, navigation with a staged set,
  auto-rest toggle, a pair, and a non-contiguous/reused group.

Gate:

- [ ] Do not ship the scene redesign while any of those paths can create a
  ghost session, silently resurrect a voided set, or render the wrong grouping.

## Task 1: Establish native-unit schema and contracts

Files:

- Create: supabase/migrations/YYYYMMDDHHMMSS_native_load_units.sql
- Modify: pwa/src/lib/types.ts
- Modify: pwa/src/lib/units.ts
- Modify: pwa/src/lib/format.ts
- Modify: pwa/src/lib/data.ts
- Modify: supabase/functions/mcp-server/lib/prescriptions.ts
- Modify: all affected resolved-program, history, recent-session, session-diff, and repeat-workout MCP queries/types/tests
- Create: tests for database constraints and PWA/MCP conversion contracts

Steps:

- [ ] Add nullable entered_load numeric and entered_unit enum columns to sets and prescriptions. Preserve existing load_entry and load_kg. Null means legacy or a percentage-based prescription, never implied kg.
- [ ] Add an invariant trigger for new direct-load rows: convert entered_load according to entered_unit and load_entry, compare against total load_kg within database numeric precision, and reject disagreement. Do not rewrite a set.
- [ ] Recreate affected security-invoker views with new columns appended, including v_live_sets, v_resolved_prescriptions, adherence views, and any dependent view that currently enumerates columns.
- [ ] Extend PWA types, cache serialisation, outbox payloads, correction replacement, and reads. Add pure conversion/formatting helpers that prefer durable authored values and fall back to legacy conversion only when provenance is null.
- [ ] Replace MCP direct-load input with an explicit load object containing value, unit, and entry convention. Keep a documented temporary kg compatibility input only if a migration rollout needs it. Do not accept ambiguous unitless numbers from a coach parser.
- [ ] Update screenshot/program parsing guidance so 225 lb, 100 kg, 30 lb each, and 60% TM become distinct typed objects.
- [ ] Test a 225 lb barbell, 30 lb per-side dumbbells, 100 kg cable stack, a %TM prescription, a legacy row, correction replacement, repeat-workout operation, and analytical totals.

Run:

~~~sh
cd pwa && npm test -- --run src/lib/units.test.ts src/lib/format.test.ts
deno test -A supabase/functions/mcp-server/lib/prescriptions.test.ts
npm run test:db
~~~

Commit:

~~~sh
git add supabase pwa/src/lib
git commit -m "feat: preserve authored load units"
~~~

## Task 2: Build pure scene and load-grid helpers

Files:

- Create: pwa/src/lib/trainingScene.ts
- Create: pwa/src/lib/trainingScene.test.ts
- Create: pwa/src/lib/loadGrid.ts
- Create: pwa/src/lib/loadGrid.test.ts
- Modify: pwa/src/lib/sessionFocus.ts and test
- Modify: pwa/src/lib/settings.ts and test

Steps:

- [ ] Add nextActionableWorkout(workouts, states, today). It returns the earliest future dated UPCOMING non-draft workout and never templates, discarded programs, done/skipped days, or a DRAFT.
- [ ] Classify loaded, per-side, bodyweight, time, tick-only, paired-superset, and explicit grouped-overview scenes. A group of more than two must not silently claim paired Focus.
- [ ] Add loadGridFor(exercise, authored unit, entry convention, settings). It supplies suggested coarse/fine steps and nearby standard values, never validation or mutation.
- [ ] Use existing per-exercise preferences first. Default barbell/plate work, dumbbell-per-hand work, and cable/machine stack work independently.
- [ ] Test data selection, all scene kinds, barbell/dumbbell/cable grids, overrides, and an off-grid typed value that remains unchanged.

Run:

~~~sh
cd pwa && npm test -- --run src/lib/trainingScene.test.ts src/lib/loadGrid.test.ts src/lib/sessionFocus.test.ts src/lib/settings.test.ts
~~~

Commit:

~~~sh
git add pwa/src/lib
git commit -m "feat: classify workout scenes"
~~~

## Task 3: Add rest-next card and preview-before-start

Files:

- Create: pwa/src/components/WorkoutPreviewSheet.tsx and test
- Modify: pwa/src/screens/Today.tsx
- Modify: pwa/src/components/TrainHome.tsx and test
- Modify: pwa/src/styles.css

Steps:

- [ ] Render Rest day plus next workout date/name and Go using Task 2 selection.
- [ ] Make Go open a read-only preview with sections, ramps, superset tags, targets, rest, notes, and first-up. Use the current prescription cache/read paths and distinguish loading, cached offline, and query errors.
- [ ] Move the current start-session call behind Start workout in preview. Assert Go/close cause no session insert, active pointer, or outbox write.
- [ ] Treat a DRAFT as no next workout. Retain View program when no future actionable plan exists.
- [ ] Test keyboard/screen-reader labels and 320 px layout.

Run:

~~~sh
cd pwa && npm test -- --run src/components/TrainHome.test.tsx src/components/WorkoutPreviewSheet.test.tsx src/screens/Today.plan-changed.test.tsx
~~~

Commit:

~~~sh
git add pwa/src/components/WorkoutPreviewSheet.tsx pwa/src/screens/Today.tsx pwa/src/components/TrainHome.tsx pwa/src/styles.css
git commit -m "feat: preview workouts before starting"
~~~

## Task 4: Make Focus a scene shell, not a single-set exception

Files:

- Modify: pwa/src/components/session/FocusDeck.tsx and test
- Modify: pwa/src/components/session/WorkoutOverview.tsx and test
- Modify: pwa/src/components/RestTimer.tsx and test
- Modify: pwa/src/components/session/SetEditor.tsx and test
- Modify: pwa/src/screens/Session.tsx and focus test
- Modify: pwa/src/styles.css

Steps:

- [ ] Add a Focus top slot and an upper-left hamburger labelled Workout, accessible as Open workout. Preserve the progress rail as state/navigation.
- [ ] Rename overview return to Go to current exercise and prove staged values, rest, selection, and correction state survive the switch.
- [ ] Move Focus rest to the top slot. Give it an accessible orange REST/READY treatment, next set/round, time adjustment, optional per-set RPE, and Note last set. Respect reduced motion.
- [ ] Apply the motion grammar in the design: a successful local log settles to
  the next selection, REST enters the top slot, READY changes once at expiry,
  and scene changes preserve draft/input state. Keep tabular timer numerals,
  text equivalents for colour, and no looping countdown animation.
- [ ] Define the state progression: logging a non-final set selects its next
  set and starts REST; timer expiry changes this to READY; logging a final set
  selects the next unfinished entry or round. This is a UI transition only.
- [ ] Route Note last set through existing set_notes outbox/editor mechanics. No open-session note field.
- [ ] Add duration Focus, retain bodyweight rep hero and tick-only Mark done.
- [ ] After prescribed work, make Finish workout primary and Add extra set an explicit local intent. Log extra set uses existing append-only path only after a second tap.
- [ ] Use durable authored values/unit in the large hero and numeric pad. Plan and session display the same authored unit and nearby-grid suggestion.

Run:

~~~sh
cd pwa && npm test -- --run src/components/session/FocusDeck.test.tsx src/components/session/WorkoutOverview.test.tsx src/components/RestTimer.test.tsx src/components/session/SetEditor.test.tsx src/screens/Session.focus.test.tsx
~~~

Commit:

~~~sh
git add pwa/src/components/session pwa/src/components/RestTimer.tsx pwa/src/screens/Session.tsx pwa/src/styles.css
git commit -m "feat: clarify focus workout scenes"
~~~

## Task 5: Redesign paired supersets and fix hidden rest

Files:

- Modify: pwa/src/components/session/SupersetRoundEditor.tsx and test
- Modify: pwa/src/components/session/FocusDeck.tsx and test
- Modify: pwa/src/screens/Session.tsx and focus test
- Modify: pwa/src/lib/sessionFocus.ts and test
- Modify: pwa/src/screens/Plan.tsx and test
- Modify: pwa/src/styles.css

Steps:

- [ ] Replace compact two-row superset controls with equal A1/A2 cards: full name, target/last time, large editable authored load, reps, and clear pair identity.
- [ ] Keep controlled drafts in Session and Log round as one ordered durable local batch. Name partial recovery actions by member and keep them secondary.
- [ ] After every full non-final round, expose the top rest band, mirror rest, and arm the alert. Keep rest attached only to the next A1 set. Never start it after a partial round or final planned round.
- [ ] Make next text say Next: Superset A, round n of m.
- [ ] For groups with more than two members, render an explicit overview/circuit limitation and prevent Plan from silently suggesting paired Focus. Do not add a DB cap without a decision on pre-existing coach-authored groups.
- [ ] Enforce Task 0's contiguous, non-reused superset-run contract in the
  Plan path and all MCP write paths before rendering any group as a pair.
- [ ] Test three rounds, REST-to-READY transition to the next round, final
  no-rest plus next-entry selection, partial A1/A2 no-rest, ordered offline
  replay, local failure draft retention, unequal-pair tails, changed rest, and
  explicit third-member behaviour.

Run:

~~~sh
cd pwa && npm test -- --run src/components/session/SupersetRoundEditor.test.tsx src/components/session/FocusDeck.test.tsx src/lib/sessionFocus.test.ts src/screens/Session.focus.test.tsx src/lib/outbox.test.ts
~~~

Commit:

~~~sh
git add pwa/src/components/session pwa/src/screens/Session.tsx pwa/src/screens/Plan.tsx pwa/src/lib/sessionFocus.ts pwa/src/styles.css
git commit -m "feat: redesign superset rounds"
~~~

## Task 6: Preserve atomic planned edits and verify

Files:

- Modify: pwa/src/screens/Plan.tsx and create/modify Plan.test.tsx
- Modify: pwa/src/lib/entries.test.ts
- Modify: pwa/src/components/SetRow.tsx
- Modify: docs/roadmaps/release-ledger.md only after actual evidence

Steps:

- [ ] Test that entry moves preserve whole ramps, supersets, sections, and all prescription rows. Keep visible arrow order controls in this release.
- [ ] Use precise labels: Edit planned sets, Move exercise block, Remove planned exercise, Correct logged set, Void logged set. Do not introduce active-session swipe delete.
- [ ] Run full PWA suite, PWA build, database checks, and MCP tests.
- [ ] On a controlled installed PWA, verify rest-next, preview-no-write, all single scene variants, a three-round paired superset, exact native lb/kg round trip, legacy conversion, correction, extra set, offline replay, and server readback.
- [ ] Verify 320 px and landscape layouts, reduced-motion variants, and that
  REST/READY remains understandable with colour removed.
- [ ] Compare deployed revision with the tested source commit. If they differ, mark deployment evidence unverified and do not call the release accepted.

Run:

~~~sh
cd pwa && npm test -- --run
cd pwa && npm run build
npm run test:db
DATABASE_URL=/tmp/dw-e2e-final.db npm run test:e2e
~~~
