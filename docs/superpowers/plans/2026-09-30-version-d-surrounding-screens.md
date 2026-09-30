# Version D Surrounding Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry Version D's proven light visual language through Train, workout preview, End, Program, and Record while preserving their current data and action contracts.

**Architecture:** Restyle existing screens and controlled components with shared light tokens after the session slice passes phone review. Keep screen owners and existing read/write routes. Each screen change is a separate reviewable commit; product behaviors that need new ownership or semantics stay outside this plan.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Vite PWA.

**Spec:** `docs/superpowers/specs/2026-09-30-version-d-light-design.md`

## Global Constraints

- Light mode only; no dark theme, pinned Record goals, added bodyweight load, or coach Apply action in this plan.
- Train retains Go -> read-only preview -> Start; Start is the only action that creates a session.
- A planned day with zero exercises is Draft, an open session is not Done, and End uses server-confirmed emptiness before offering discard.
- Program keeps dated day, section, ramp, superset, coach note, plan lock, and write transaction semantics. Do not edit any applied migration.
- Record keeps existing SQL-derived metric definitions and excludes voided/discarded sets through `v_live_sets`.
- Preserve offline cache and outbox behavior; do not change background update timing or clear IndexedDB.

## Review Focus

1. A dated empty planned day must read Draft, never Missed, in the revised week strip (Task 1).
2. An open session must show Resume rather than Done or Start again (Task 1).
3. End on a second device with no local sets must not offer destructive discard without server confirmation (Task 2).
4. A locked historical day must not gain an edit affordance just because Program's card layout changed (Task 3).
5. Record with unknown or missing bodyweight must not invent a derived load or pinned goal (Task 4).

---

### Task 1: Give Train and preview the light D hierarchy

**Files:** Modify `pwa/src/components/TrainHome.tsx`, `pwa/src/components/WorkoutPreviewSheet.tsx`, `pwa/src/screens/Today.tsx`, `pwa/src/styles.css`, `pwa/src/components/TrainHome.test.tsx`, `pwa/src/components/WorkoutPreviewSheet.test.tsx`, and `pwa/src/screens/Today.done-summary.test.tsx`.

**Interfaces:** Retain the existing `TrainHome` and `WorkoutPreviewSheet` props and Today-owned navigation callbacks. The week strip consumes existing status and prescription count; a first-up cue may only use an already loaded prescription. No speculative workout-duration calculation.

- [ ] Write rendering tests for Draft, Resume, Done, a real first exercise, and absent first exercise. Pin that Go opens preview and only Start creates a session.
- [ ] Run `cd pwa && npm test -- src/components/TrainHome.test.tsx src/components/WorkoutPreviewSheet.test.tsx src/screens/Today.done-summary.test.tsx`; confirm the new visual/interaction assertions fail.
- [ ] Apply D's light date, week, next-workout, and preview hierarchy with the existing data. Keep loading and offline states explicit. Do not add an estimated duration label.
- [ ] Run focused and full PWA tests, typecheck, build, and browser-check empty draft, active session, long plan name, and 320 px width.
- [ ] Commit Train and preview together.

### Task 2: Carry the light style through Finish

**Files:** Modify `pwa/src/screens/End.tsx`, `pwa/src/screens/End.test.tsx`, `pwa/src/screens/End.finish.test.tsx`, and scoped `pwa/src/styles.css` rules.

**Interfaces:** Preserve End's existing queued finish, notes, bodyweight, session rating, and server-confirmed set-count logic. No new write payload or completion status.

- [ ] Write a test for normal finish, queued/offline finish, server-confirmed empty, and locally empty but unconfirmed server state. Assert controls and warnings remain legible after layout change.
- [ ] Run `cd pwa && npm test -- src/screens/End.test.tsx src/screens/End.finish.test.tsx`; confirm new D presentation assertions fail.
- [ ] Restyle summary, rating, and Finish action. Keep staged End input across back/forward navigation and the current outbox operation order.
- [ ] Run focused tests, typecheck, build, and phone-check enlarged text and keyboard overlap.
- [ ] Commit End separately.

### Task 3: Restyle Program without changing plan semantics

**Files:** Modify `pwa/src/screens/Plan.tsx`, `pwa/src/screens/Plan.navigation.test.tsx`, `pwa/src/screens/Plan.active-session.test.tsx`, related plan-editor components identified by `rg --files pwa/src/components | rg 'Plan|Workout'`, and scoped `pwa/src/styles.css` rules.

**Interfaces:** Keep current program/day selectors and locked-day guards. A section or superset remains a grouped entry in view and edit; no new mutation endpoint.

- [ ] Add tests for an editable future day, a locked referenced day, Draft, skipped and completed status, named section, ramp, and paired superset.
- [ ] Run the two Plan focused tests and confirm the new D layout assertions fail.
- [ ] Apply the light card and type hierarchy only after checking the actual component paths. Keep edit buttons conditional on the existing lock and keep coach `notes` distinct from user `plan_note`.
- [ ] Run focused and full PWA tests, typecheck, build, and browser-check a long section name and locked day.
- [ ] Commit Program separately.

### Task 4: Restyle Record from existing facts

**Files:** Modify `pwa/src/screens/History.tsx`, `pwa/src/screens/History.bodyweight.test.tsx`, relevant existing chart components found from History imports, and scoped `pwa/src/styles.css` rules.

**Interfaces:** Preserve History's existing read model, unit conversion, and chart calculations. D's pinned-goal card is omitted until a separate owner/persistence decision; missing metrics stay missing.

- [ ] Add tests for recent session ordering, no data, offline cached data, unknown bodyweight, and per-hand display provenance.
- [ ] Run `cd pwa && npm test -- src/screens/History.bodyweight.test.tsx`; confirm the new presentation assertions fail.
- [ ] Apply the light Record hierarchy and typography using only existing labels and values. Keep chart definitions and SQL views unchanged.
- [ ] Run focused and full PWA tests, typecheck, build, then compare a rendered chart with its existing data fixture and phone-check narrow width.
- [ ] Commit Record separately.

### Task 5: Verify the complete light path before release

**Files:** Change only defects found during verification; add focused regression tests for those defects. Record observed deployment evidence in the release ledger and runbook under the repo's existing convention.

- [ ] Walk Train -> Preview -> Start -> Focus -> Log -> Rest -> List -> Finish -> Record and Program -> day -> session on a seeded browser account.
- [ ] Repeat phone offline logging, app background/foreground, update prompt, reconnect, and exact UUID readback after the affected phone recovery has been completed.
- [ ] Check 320, 390, and 402 x 812 widths, normal and 1.3x text, safe areas, keyboard, long names, and all small controls by touch.
- [ ] Follow `docs/deploy.md` for an authorized release and record served SHA, results, and rollback. Do not mark the release gate complete from tests or screenshots alone.
