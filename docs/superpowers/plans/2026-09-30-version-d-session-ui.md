# Version D Light Session UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing workout a light Version D Focus/List layout, stable logging dock, and rest scene without changing the training record or outbox contract.

**Architecture:** `Session.tsx` remains the only state and write owner. Controlled session components render its existing entries, drafts, rest clock, and callbacks. This plan ships neutral last-set copy and the current aggregate sync status; the separate receipt plan adds individual save claims.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, existing CSS and IndexedDB outbox.

**Spec:** `docs/superpowers/specs/2026-09-30-version-d-light-design.md`

## Global Constraints

- Start from `d5e7b64` or re-audit changed source before editing; the ZIP prototype is design data, not code to embed.
- No schema change, new logging route, second rest clock, or write from a presentational component.
- Keep `setsLoaded` / `setsFailed`, append-only corrections, UUID idempotency, owner-held outbox writes, and paired-round local batch behavior.
- Focus/List preserves staged drafts, rest, selection, and notes. More-than-two-member circuits remain List-only.
- Light mode only. Match D's visible controls, but give the 38 px Focus/List controls at least 44 px actionable areas.
- Do not show “Already saved”, “Synced”, or “all on the server” for a specific set in this plan.
- Do not release this UI until the affected phone queue and the roadmap Phase 2 browser/phone/readback gate are verified.

## Review Focus

1. A 320 px phone with 1.3x text and a long exercise name still exposes Log without horizontal overflow (Task 2 layout check).
2. A number pad or note sheet does not cover the dock or lose a staged value (Task 2 browser check).
3. A paired superset with unequal progress still logs only the selected real members (Task 4 test).
4. Changing Focus/List during rest keeps the same timer, adjustment, and next-set draft (Task 3 test).
5. A timed, Done, bodyweight, or >2-member circuit never falls into a reps-shaped false scene (Task 4 test).

---

### Task 1: Put Focus/List in the session header

**Files:** Modify `pwa/src/components/session/FocusDeck.tsx`, `pwa/src/components/session/WorkoutOverview.tsx`, `pwa/src/screens/Session.tsx`, and `pwa/src/components/session/FocusDeck.test.tsx`; inspect `pwa/src/lib/sessionFocus.ts` without changing its record semantics.

**Interfaces:** Consume the existing `SessionPresentation`, `transitionPresentation`, `onViewFullWorkout`, and `onEnterFocus` callbacks. Produce a controlled `FocusListSwitch` in `pwa/src/components/session/FocusListSwitch.tsx` with `value: SessionPresentation` and `onChange(next: SessionPresentation): void`; it owns no state.

- [ ] Add a rendering test that Focus/List reports the active choice with `aria-pressed` and changes presentation through its callback. Check the 44 px action area in the browser, since jsdom cannot measure CSS layout.
- [ ] Run `cd pwa && npm test -- src/components/session/FocusDeck.test.tsx`; confirm the new test fails for the absent switch.
- [ ] Implement `FocusListSwitch` and replace the mode controls in both presentation headers. Keep Workout/overflow and aggregate sync reachable; do not navigate away from `/session` on a mode change.
- [ ] Run the focused component test and `cd pwa && npm run typecheck`; require both to pass.
- [ ] Commit the header change as one logical commit.

### Task 2: Compose the light Focus stage and stable dock

**Files:** Modify `pwa/src/components/session/FocusDeck.tsx`, `pwa/src/components/session/SetEditor.tsx`, `pwa/src/components/session/FocusMoreSheet.tsx`, `pwa/src/screens/Session.tsx`, `pwa/src/styles.css`, and their existing focus/editor tests. Reuse `pwa/src/components/icons/LoadIcons.tsx` and `pwa/src/components/PlateSheet.tsx`.

**Interfaces:** Consume existing controlled `SetDraft`, `SetEditorProps`, `onOpenMore`, `onSkip`, `onSwap`, `onOpenPlates`, `onLog`, and `loadPresentation`. The dock edits only the current staged set; it never edits `lastLoggedSet`.

- [ ] Add focused rendering tests for a loaded set, per-hand total, bodyweight reps, `tracking='done'`, and `tracking='time'`: each shows its actual value and one appropriate primary action. Verify RPE, Note, Skip, and Plates (or the applicable fallback) are reachable by name.
- [ ] Run `cd pwa && npm test -- src/components/session/SetEditor.test.tsx src/components/session/FocusDeck.test.tsx` and confirm the new D composition assertions fail.
- [ ] Recompose the existing editor into D's light stage, equipment/cue region, utility row, and non-scrolling dock. Reuse the existing setters and load-entry resolution; do not put a second draft in the new controls. Scope new rounded surfaces to the session so unrelated screens keep their current layout until their own plan.
- [ ] Run the focused tests, `cd pwa && npm run typecheck`, and `cd pwa && npm run build`; require clean results.
- [ ] Inspect the demo at 320, 390, and 402 x 812 px, normal and 1.3x text, with keyboard/number pad and a long cue. Confirm no horizontal overflow, no covered control, and a reachable Log. This visual check is distinct from the unit tests.
- [ ] Commit the Focus composition and CSS as one reviewable change.

### Task 3: Make rest a scene without duplicating its clock

**Files:** Modify `pwa/src/components/RestTimer.tsx`, `pwa/src/screens/Session.tsx`, `pwa/src/components/session/FocusDeck.tsx`, `pwa/src/components/RestTimer.test.tsx`, `pwa/src/screens/Session.focus.test.tsx`, and scoped `pwa/src/styles.css` rules.

**Interfaces:** Add `variant?: 'strip' | 'scene'` to `RestTimer` if its current props can support both presentations; otherwise extract a display-only `FocusRestScene` receiving the same `ActiveRest`-derived values and callbacks. `Session.tsx` remains the timer owner.

- [ ] Add a test for Focus rest running -> over -> hidden and a Focus/List switch during rest. Assert the next draft and adjustment remain unchanged, and expiry causes no set write.
- [ ] Run `cd pwa && npm test -- src/components/RestTimer.test.tsx src/screens/Session.focus.test.tsx`; confirm the new presentation assertions fail.
- [ ] Render D's large Focus clock, last-set neutral summary, next-set guidance, and compact List strip from the existing rest data. Preserve sound/alert scheduling, elapsed-rest write meaning, and RPE/Note reachability.
- [ ] Run the focused tests and typecheck; inspect a real countdown, return from background, sheet open/close, and reduced motion in the demo.
- [ ] Commit rest presentation separately from the logging dock.

### Task 4: Make List the same session's workout map

**Files:** Modify `pwa/src/components/session/WorkoutOverview.tsx`, `pwa/src/components/session/WorkoutOverview.test.tsx`, `pwa/src/screens/Session.tsx`, `pwa/src/screens/Session.focus.test.tsx`, and scoped `pwa/src/styles.css`; reuse `pwa/src/components/SetRow.tsx` and `pwa/src/lib/entries.ts`.

**Interfaces:** Add optional `variant?: 'accordion' | 'list'` and `renderLoggedRows?: (entry: ExerciseEntry) => ReactNode` to `WorkoutOverview`. Session passes its existing canonical `setsForEntry`/correction actions through the callback. The List variant changes only presentation and selection, not set ownership.

- [ ] Add tests that completed entries collapse to a summary, the current entry shows its actual logged rows and next set, a tapped row opens the existing correction path, and >2-member circuits remain available in List. Include an unequal A1/A2 progress case.
- [ ] Run `cd pwa && npm test -- src/components/session/WorkoutOverview.test.tsx src/screens/Session.focus.test.tsx`; confirm the new List assertions fail.
- [ ] Implement the compact List variant and wire Focus/List transitions through the existing presentation helper. Keep section labels, ramps, skipped states, and plan targets from canonical entries. Show no individual sync receipt yet; the header retains aggregate status.
- [ ] Run focused tests, full `cd pwa && npm test`, typecheck, and build. Inspect List after offline logging, correction, and returning to Focus with a staged value.
- [ ] Commit List as a separate change.

### Task 5: Review the whole light session on a phone

**Files:** No product file required unless the review finds a concrete issue; add a narrow regression test for each corrected behavior. Record release evidence under the relevant runbook/plan only after observed.

- [ ] Walk Go -> Preview -> Start -> Focus -> Log -> Rest -> List -> correction -> Focus -> Finish in the demo, including normal, timed, Done, bodyweight, per-hand, paired superset, and long circuit fixtures.
- [ ] Repeat the interaction on a phone at normal and enlarged text with the number pad open, using the existing offline queue. Confirm the small controls by touch instead of redesigning them speculatively.
- [ ] Read back every test set UUID and correction after the phone reconnects; confirm that List and Focus describe the same session and queue state.
- [ ] Follow `docs/deploy.md` for any authorized release, record served SHA and rollback, and keep the D release behind the Phase 2 gate until it passes.
