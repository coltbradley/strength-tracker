# Version D Session-Local Choices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a lifter choose units and reorder entries for the current workout without changing the device default or immutable plan.

**Architecture:** Session-scoped preferences live in the existing device cache under the session UUID and owner. `Session.tsx` owns the effective unit and display order and passes them to Focus and List. Both choices survive reload, but they never mutate prescription order, set indices, or canonical kilogram values.

**Tech Stack:** React 19, TypeScript, IndexedDB cache, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-30-version-d-light-design.md`

## Global Constraints

- `load_kg` remains the total system load in kilograms; `entered_load`, `entered_unit`, and `load_entry` must describe how the lifter entered it.
- A session unit starts from the device default, changes only this session, and survives reload for the same owner/session pair.
- A reorder changes only today's navigation order. A ramp or paired superset moves as one entry; set indices, timestamps, plan order, and section meaning do not change.
- The active plan is locked once a session points to it. No bare PostgREST write, schema change, or new user settings table.
- Cache changes are additive; never clear the outbox, rename IndexedDB stores, or make a session preference visible across accounts.
- Keep the existing correction and paired-round write behavior; disable reorder during those writes.

## Review Focus

1. Switching from kg to lb while a prefilled kg target is staged must not alter the canonical load or stamp a false `entered_unit` (Task 2).
2. Per-hand entry and correction after a unit switch must preserve total `load_kg` and authored display provenance (Task 2).
3. Account B opening the same device must not inherit account A's session preference (Task 1).
4. An entry list that changes after hydration must reconcile old order without dropping new entries or splitting a pair (Task 3).
5. Reorder during an in-flight paired round or correction must remain disabled until the write settles (Task 4).

---

### Task 1: Persist typed session preferences by owner and session

**Files:** Modify `pwa/src/lib/db.ts` and `pwa/src/lib/db.test.ts`; create `pwa/src/lib/sessionPrefs.ts` and `pwa/src/lib/sessionPrefs.test.ts`.

**Interfaces:** Export `type SessionPrefs = { unit?: Unit; entryOrder?: string[] }`, `readSessionPrefs(ownerId: string, sessionId: string): Promise<SessionPrefs>`, and `writeSessionPrefs(ownerId: string, sessionId: string, patch: Partial<SessionPrefs>): Promise<void>`. Use `cacheKeys.sessionPrefs(ownerId, sessionId)` and declare it outside derived invalidation families with a documented reason. Validate the read shape; unknown keys, invalid unit values, and duplicate entry keys are ignored.

- [ ] Add tests for write/read, reload, owner isolation, corrupt cached shape, additive patch, and the cache-family registry's expected survivor behavior.
- [ ] Run `cd pwa && npm test -- src/lib/sessionPrefs.test.ts src/lib/db.test.ts`; confirm the new tests fail.
- [ ] Add the typed cache key and helper. Do not change the database version or write device-global settings. Keep the current user's marker behavior so sign-out/account switch cannot expose the previous user's choices.
- [ ] Run focused tests and typecheck.
- [ ] Commit session preference storage.

### Task 2: Make the session unit an override

**Files:** Modify `pwa/src/screens/Session.tsx`, `pwa/src/screens/Session.focus.test.tsx`, and any focused `pwa/src/lib/units.ts` test needed. Reuse `pwa/src/components/session/UnitSwitch.tsx`.

**Interfaces:** Compute `effectiveUnit = sessionPrefs.unit ?? getUnit()` for this session. `switchWorkoutUnit(next: Unit)` persists through `writeSessionPrefs` and updates local state; it never calls `setUnit(next)`. Continue passing the effective unit through existing draft, display, plate, and correction paths.

- [ ] Add failing tests for kg target -> lb switch -> Log, per-hand load, authored staged value, reload, second session default, and correction. Assert exact `load_kg`, `entered_load`, `entered_unit`, and `load_entry` payload fields.
- [ ] Run `cd pwa && npm test -- src/screens/Session.focus.test.tsx`; confirm the global-setting expectation conflicts with the new behavior.
- [ ] Replace the session's global unit mutation with the override. Preserve the current prefilled-draft stamping rule so switching units does not reinterpret a number already typed by the user. Audit all `getUnit()` and `unit` uses on the session path.
- [ ] Run focused tests, full PWA tests, typecheck, and build.
- [ ] Commit session-only unit behavior.

### Task 3: Build a pure entry-order reconciler

**Files:** Create `pwa/src/lib/sessionOrder.ts` and `pwa/src/lib/sessionOrder.test.ts`; inspect `pwa/src/lib/entries.ts` and `pwa/src/lib/sessionFocus.ts` for entry grouping.

**Interfaces:** Export `reconcileEntryOrder(entries: readonly ExerciseEntry[], savedKeys: readonly string[]): ExerciseEntry[]` and `moveSessionEntry(entries: readonly ExerciseEntry[], key: string, toIndex: number): ExerciseEntry[]`. Treat a ramp or paired superset as the existing `ExerciseEntry` unit; reject a move that would split a grouped entry or make a named section nonsensical. Stable original order is the fallback for missing/invalid keys.

- [ ] Test blank, stale, duplicate, and newly added keys; a ramp; a paired superset; two named sections; and a completed entry. Assert the same key set appears exactly once and each grouping remains intact.
- [ ] Run `cd pwa && npm test -- src/lib/sessionOrder.test.ts`; confirm red.
- [ ] Implement only the pure reconciler and move helper, following the repo's actual `ExerciseEntry` shape. Do not change prescriptions or persist yet.
- [ ] Run focused tests and typecheck.
- [ ] Commit pure order logic.

### Task 4: Connect List reorder to session navigation

**Files:** Modify `pwa/src/screens/Session.tsx`, `pwa/src/components/session/WorkoutOverview.tsx`, `pwa/src/components/session/WorkoutOverview.test.tsx`, `pwa/src/screens/Session.focus.test.tsx`, and scoped `pwa/src/styles.css` rules.

**Interfaces:** Session passes `orderedEntries` plus `onMoveEntry(key: string, toIndex: number)` to List. Persist only the resulting entry keys through `writeSessionPrefs`. Preserve selected entry by key when it moves. Expose a move control reachable by touch and keyboard; drag may be added if it passes phone testing.

- [ ] Add failing tests for move, reload, switch to Focus, section/group integrity, staged-draft preservation, and disabled movement during correction/round write.
- [ ] Run `cd pwa && npm test -- src/components/session/WorkoutOverview.test.tsx src/screens/Session.focus.test.tsx`; confirm red.
- [ ] Wire the pure order logic into session navigation and cache. Do not reorder server rows, rewrite set indices, or infer performance order from the new display order. Prefer explicit move controls to a new drag dependency; if adding drag, retain the accessible controls.
- [ ] Run focused and full PWA tests, typecheck, build, and a phone test with a long workout, long-press scrolling, and the keyboard.
- [ ] Commit session reorder.
