# Group 04: PWA planning and exercise library

## Scope and evidence

Reviewed the current checkout `docs/phase-1-plans` at `30f8e33` (the README's mapped revision is `38e32d0`). Inspected `Today.tsx`, `Plan.tsx`, `CalendarSheet.tsx`, `TrainHome.tsx`, `TemplateSheet.tsx`, `ExercisePicker.tsx`, `NewExerciseSheet.tsx`, `ExerciseDemoSheet.tsx`, `TrainingMaxSheet.tsx`, `calendar.ts`, `sections.ts`, `planChanges.ts`, `templateLoads.ts`, `exerciseMedia.ts`, `fuzzy.ts`, adjacent tests, the plan/template portions of `data.ts`, the MCP superset validator, and the relevant template/soft-delete migrations. Read the shared `AGENTS.md`, this audit's README, the active roadmap, and the release ledger.

Checks were source and line-reference inspection only. `git rev-parse HEAD` returned `30f8e33dce60513799973632c69a0e03727412d7`. I inspected, but did not run, `Today.test.ts`, `Today.plan-changed.test.tsx`, `calendar.test.ts`, `sections.test.ts`, `planChanges.test.ts`, `templateLoads.test.ts`, `fuzzy.test.ts`, and `exerciseMedia.test.ts`. No browser, phone, database, or live service behavior was exercised.

The roadmap keeps the current work focused on Phase 1/2 safety and explicitly defers plan-legibility product work to Phase 4 after beta use (`docs/roadmaps/2026-09-19-consolidated-roadmap.md:248-272,306-323`). The release ledger does not list the planning leads below as closed (`docs/roadmaps/release-ledger.md:9-13`).

## Executive summary

Seven confirmed findings: four P1 and three P2. The largest risks are a Plan route race that can write to the wrong day's prescription, valid confirmed programs disappearing from the PWA, and section edits that can leave the stored day partly changed after a request failure. The date rollover and draft-versus-missed ordering are implemented in the current path; the audited date helper tests cover local dates, configured week starts, DST, and month-grid continuity.

## Findings

### G04-F01. Plan route changes can pair one day's editor with another day's prescriptions

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-05.
- **Trigger:** Open `/plan/A`, then navigate to `/plan/B` before A's prescription request resolves.
- **Evidence:** `Plan`'s `reload` starts independent list and prescription requests and unconditionally applies each result; it has no request generation, cancellation, or route-id check (`pwa/src/screens/Plan.tsx:260-270`). The displayed workout is selected from the latest list by the current route id (`pwa/src/screens/Plan.tsx:246-247`). Prescription writes use the selected row id while passing the current workout id only for cache invalidation (`pwa/src/screens/Plan.tsx:524-551`; `pwa/src/lib/data.ts:473-484`).
- **Impact:** A late A response can populate B's editor with A's rows. Saving then updates A's uniquely identified prescription while invalidating B's cache, so the person can change a different day from the one on screen.
- **Suggested fix boundary:** `Plan.tsx` request lifecycle; guard both list and prescription results against the route/workout generation before changing state. Keep the write path from accepting a row outside the displayed workout.
- **Verification needed:** A screen test that resolves A after B and proves neither A's rows nor its write controls appear under B; assert a save cannot update a prescription belonging to a different workout.

### G04-F02. First use of a saved workout leaves an extra empty draft day

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-41.
- **Trigger:** Use a saved workout when no confirmed program exists.
- **Evidence:** `Today.useTemplate` calls `createPlannedWorkout(selectedDate, "")` to obtain a program id, then calls `applyTemplate` for the same date (`pwa/src/screens/Today.tsx:834-852`). `createPlannedWorkout` inserts a dated workout with no prescriptions (`pwa/src/lib/data.ts:910-958`); `applyTemplate` inserts a second dated workout and its copied prescriptions (`pwa/src/lib/data.ts:717-781`). Today deliberately classifies any non-completed workout with `exercise_count === 0` as `DRAFT` (`pwa/src/screens/Today.tsx:137-159`).
- **Impact:** The successful first application creates a real empty calendar draft beside the intended template copy. If the copy fails after the seed day was inserted, the empty day remains as the only visible result.
- **Suggested fix boundary:** Make the template application path create/resolve the program without creating a spare dated workout, or reuse the seed day as the destination. Keep ordinary manual `createPlannedWorkout` behavior unchanged.
- **Verification needed:** Cover first template use with no program and assert exactly one dated day remains, containing the template prescriptions; cover failure after program creation and ensure no misleading calendar draft remains.

### G04-F03. Today shows only the newest confirmed program

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-162.
- **Trigger:** A user has more than one live confirmed program, which the plan read permits.
- **Evidence:** `getPlannedWorkouts` fetches every confirmed, non-discarded program ordered newest first, and loads workouts for all of them (`pwa/src/lib/data.ts:253-284`). `Today` then selects only `list.programs[0]` and filters every displayed workout to that program id (`pwa/src/screens/Today.tsx:413-428`).
- **Impact:** Workouts in older valid confirmed programs are absent from the PWA's calendar/list and cannot be reviewed, started, or edited there, despite being returned by the read layer and available to MCP.
- **Suggested fix boundary:** PWA planning navigation/list state must expose all live confirmed programs or make the selected program explicit. The roadmap's Phase 4 dashboard remains deferred; this finding is about making existing valid plans reachable, not adding a new coaching dashboard.
- **Verification needed:** A screen test with two confirmed programs, asserting that each program's dated workouts are reachable and that switching/selection does not silently discard the other program from the view.

### G04-F04. Editing a section can leave only part of the change saved

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-166.
- **Trigger:** A request fails after the first or second step while changing a row's section, renaming/dissolving a section, or settling the rendered order.
- **Evidence:** `commitRx` writes the selected prescription, writes its section mates separately, then may reorder all rows (`pwa/src/screens/Plan.tsx:524-551`). Rename and dissolve each update section rows and then separately settle order (`pwa/src/screens/Plan.tsx:681-718`). These are independent Supabase requests; the earlier successful request is not rolled back when a later one throws.
- **Impact:** A partially applied section or order change can make the stored day differ from the editor's intended grouping. Today and Session read the stored rows, so they may describe a different day than the editor showed before the failure.
- **Suggested fix boundary:** Treat a section/grouping/order change as one recoverable operation, preferably at a transactional database boundary; otherwise add explicit reconciliation/retry state that reloads and reports the persisted result before allowing another edit.
- **Verification needed:** Inject failure after each request boundary and verify the day is either wholly updated or clearly reconciled to a valid persisted layout. Include ramp and superset rows.

### G04-F05. MCP training-max writes do not refresh mounted PWA reads

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-164.
- **Trigger:** The in-app coach successfully calls `set_training_max` while a PWA plan/session or Training Max sheet is mounted.
- **Evidence:** The CoachSheet marks and broadcasts only the four plan-writing tools accepted by `isWorkoutWritingTool` (`pwa/src/components/CoachSheet.tsx:253-268`; `pwa/src/lib/planChanges.ts:7-15`). The training-max sheet loads its values once per mount or its own `reloadTick` (`pwa/src/components/TrainingMaxSheet.tsx:67-95`). PWA-side TM writes invalidate the TM and resolved-plan caches (`pwa/src/lib/data.ts:1111-1134`), but the MCP write does not pass through that PWA helper. The mounted Today/session state therefore receives no refresh signal for a coach-originated TM change.
- **Impact:** The coach can report a successful new value while the sheet still shows the old max and mounted plan/session prescriptions still show old resolved loads or a “NO TM SET” badge. A lifter may proceed using stale prescription context until a full refresh/remount.
- **Suggested fix boundary:** Add a typed coach-data invalidation signal for training-max writes and refresh affected TM/resolved-prescription consumers. Keep goal/history invalidation with its owning screen group if it is handled separately.
- **Verification needed:** A CoachSheet integration test for `set_training_max` that verifies the open Training Max sheet and mounted prescription consumer refresh after successful tool completion, while unrelated coach reads do not force a reload.

### G04-F06. Custom exercises start with dumbbell equipment semantics

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-167.
- **Trigger:** Add a custom movement without changing the equipment selection.
- **Evidence:** `NewExerciseSheet` initializes equipment to `"dumbbell"` (`pwa/src/components/NewExerciseSheet.tsx:71-75`) and saves that value (`pwa/src/components/NewExerciseSheet.tsx:89-98`). Its own copy says equipment controls plate math and per-side weight entry (`pwa/src/components/NewExerciseSheet.tsx:142-157`).
- **Impact:** A custom barbell, cable, machine, or bodyweight exercise is silently tagged as dumbbell when the user accepts the default. Downstream load-entry inference can therefore treat a total weight as per-side input and store/display a paired total incorrectly.
- **Suggested fix boundary:** Remove the consequential dumbbell default. Require an explicit equipment choice or use a neutral value until selected, and preserve the existing per-side inference for actual dumbbell work.
- **Verification needed:** Component test that a fresh form cannot save as dumbbell without an explicit choice, plus load-entry tests for a custom exercise saved under each equipment type.

### G04-F07. Completing Plan always returns to Train and leaves the editor in history

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-195.
- **Trigger:** Open an editor from the Program tab, then press “Done planning” or the “TODAY” control.
- **Evidence:** Both controls call `navigate("/")` (`pwa/src/screens/Plan.tsx:748-752,1499-1507`), while `/` is Train and `/program` is the Program presentation (`pwa/src/App.tsx:108-120`). The navigation pushes a new history entry, so browser Back returns to the Plan route.
- **Impact:** Finishing a Program-tab edit unexpectedly switches tabs; Back reopens the editor the user just left, including its stale route context.
- **Suggested fix boundary:** Preserve the entry route for return navigation and replace the editor history entry when completing, while retaining the current Today-origin return behavior.
- **Verification needed:** Router-level navigation tests for Plan opened from both Train and Program, checking the selected tab after completion and Back behavior.

## Opportunities

None identified within this pass that should be pulled forward. The roadmap defers plan-legibility additions until real beta use; the findings above concern correctness and reachability of existing planning actions.

## Documentation gaps

No owned product documentation gap was confirmed. The active roadmap already states the Phase 2 Plan-race gate and the Phase 4 deferral. The in-code comments describe the intended grouping and template behavior; the current defects are implementation mismatches against those stated rules.

## Handoffs

- **Group 02 (PWA data): A-38, A-39, and A-40 remain current in `data.ts`.** Day swaps use three independent updates with a temporary index (`pwa/src/lib/data.ts:378-402`). Duplicate/save-template/apply-template are parent-plus-prescription requests (`pwa/src/lib/data.ts:407-446,648-693,717-781`); duplicate omits newer prescription fields (`pwa/src/lib/data.ts:432-443`), save-template omits `superset_group`, `section`, `tracking`, and `load_entry` (`pwa/src/lib/data.ts:674-690`), and apply-template selects no `section`/`tracking` then spreads that incomplete row (`pwa/src/lib/data.ts:730-736,760-778`). These are data-operation fixes, so they are not counted in this report.
- **Group 01 (database): A-103 remains a schema/RLS safeguard lead.** The template constraint only forbids a template from having a date (`supabase/migrations/20260831020000_workout_templates.sql:17-22`). The owner delete policy authorizes deletion based on `is_template` (`supabase/migrations/20260905010000_drop_hard_delete_policies.sql:38-50`), and the generic update path can change day fields; validate whether a trained/referenced day can be retagged as a template and then removed. PWA template deletion filters on that flag (`pwa/src/lib/data.ts:784-792`).
- **Groups 01/02/03: A-165 remains current at the editor boundary.** Plan deletion soft-deletes the day without checking for an open session (`pwa/src/screens/Plan.tsx:508-513`; `pwa/src/lib/data.ts:464-471`). The view then hides discarded days (`supabase/migrations/20260901030000_soft_delete_planned_workouts.sql:44-51`), while an active session may still depend on the day's prescription context. Please assign the primary guard to the database/data/session boundary and include the PWA behavior in verification.
- **Groups 03/08: A-163 remains current across the Plan and Session/MCP boundaries.** The Plan editor gathers non-adjacent rows globally by `superset_group` (`pwa/src/lib/sections.ts:75-107`), while Session only recognizes consecutive entries as a superset (`pwa/src/lib/entries.ts:170-194,550-568`). The MCP validator checks that a group has at least two rows, but not that its members are contiguous (`supabase/functions/mcp-server/lib/prescriptions.ts:184-212`). A validly accepted non-contiguous group can therefore look paired in Plan and run as separate work in Session. Set the group owner for a shared ordering invariant and test both displays against the same fixture.

## Open questions and limits

- The Plan race, partial section write, route return, and stale MCP TM behavior were established from asynchronous call/state paths, not reproduced in a browser.
- The calendar helper and `useLocalToday` implement device-local date arithmetic and refresh on midnight, visibility return, and reconnect (`pwa/src/lib/calendar.ts:15-37`; `pwa/src/hooks/useLocalToday.ts:56-105`). Static inspection found no new date rollover defect. `Today` classifies zero-exercise workouts as DRAFT before checking date/state (`pwa/src/screens/Today.tsx:137-159`), and `TrainHome` has a separate explicit DRAFT display (`pwa/src/components/TrainHome.tsx:157-166`).
- No live database, deployed MCP client, or phone acceptance was available in this pass. The exact externally visible behavior of read-cache expiry and remote writes still needs the stated integration/browser checks.
