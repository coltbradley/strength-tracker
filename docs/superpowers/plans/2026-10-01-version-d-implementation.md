# Version D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Version D session redesign as three phased PRs (live workout, Train, Record) without changing any invariant in `AGENTS.md`.

**Architecture:** `Session.tsx` stays the sole owner of session rows, drafts, rest and sync. New presentation is controlled components fed by pure helpers (`pwa/src/lib/loadPicture.ts` already exists). One stylesheet, token layer first. No schema change in Phases 1 and 2; Phase 3 adds one additive view and two owner-scoped `goals` writes.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, `idb`, Supabase (PGlite-validated migrations).

**Spec:** `docs/superpowers/specs/2026-10-01-version-d-design.md`

**Status (2026-10-01):** Phase 1 skeleton landed in `6035d8b` (below). Nothing else is implemented. Test files were not touched by the skeleton and are stale until the `tests` sub-branch.

## Global constraints

- Docs-only branch `feat/live-workout-d-docs` holds this plan and the spec. No code lands there.
- Follow `AGENTS.md` "Hard rules". The ones this work leans on: `load_kg` is the total system load; `sets` is append-only; plan writes are locked; `sets`, `sessions`, `set_voids`, `set_notes` are written by the PWA only; one stylesheet with tokens; text AA; fonts self-hosted; migrations additive.
- Light mode only. Colours are tokens in `pwa/src/styles.css`; no colour literal in a component. No `theme.css`.
- 44px targets, 11px text floor, 320 px and 1.3x text checks (spec "Global rules").
- Test first for each behaviour change: failing test, smallest change, passing test, one logical commit.
- Do not push. A human opens each PR.
- Each phase ends with a real-phone pass, then a design-log README with captures at 390, 320 and 320 at 1.3x.

## Branches

```
main
 |-- feat/live-workout-d                 Phase 1 PR -> main
 |     |-- feat/live-workout-d-header
 |     |-- feat/live-workout-d-css
 |     |-- feat/live-workout-d-platesheet
 |     |-- feat/live-workout-d-superset
 |     |-- feat/live-workout-d-tests
 |     `-- feat/live-workout-d-reorder
 |-- feat/live-workout-d-docs            this plan and the spec (docs only)
 |-- feat/train-d                        Phase 2 PR -> main, after Phase 1 merges
 |-- feat/record-d                       Phase 3 PR -> main, after Phase 2 merges
 `-- feat/exercise-prefs-sync            separate PR, own decisions.md entry
```

Sub-branches merge into `feat/live-workout-d` in the order below; only `feat/live-workout-d` is a PR to `main`. `feat/train-d` and `feat/record-d` branch from `main` after the previous phase merges, because all three edit `pwa/src/styles.css`. `feat/exercise-prefs-sync` is independent: Version D works on device-local prefs and gains sync when that PR lands (only footer copy changes).

## Phase 1: Live workout (`feat/live-workout-d`)

### Landed so far (`6035d8b`)

| File | What it does |
| --- | --- |
| `pwa/src/lib/loadPicture.ts` | Pure helpers: plate and dumbbell geometry, pin-stack rows |
| `pwa/src/components/session/LoadPicture.tsx` | The drawn load picture |
| `pwa/src/components/session/FocusDeck.tsx`, `SetEditor.tsx` | Header / middle / dock bands, dock keys |
| `pwa/src/components/RestTimer.tsx` | Rest card, last-saved-set card, LOAD NEXT |
| `pwa/src/screens/Session.tsx` | Wiring |

### Sub-branches, in order

1. **`-css`**: token layer first. Add `--plate-*`, `--dumbbell-*`, `--cur`, `--curbg`, `--ok`, `--bad` as needed; band layout (`.session-header`, `.session-middle`, `.session-dock`); 44px and 11px floors; the 320 px and 1.3x behaviour (middle band scrolls, Log never pushed off). Files: `pwa/src/styles.css`.
2. **`-header`**: `☰ n/m`, Focus | List, round `✓` sync chip widening to glyph plus word, units note, set line and `SET n OF m` once. Replaces `UnitSwitch` placement. Files: `FocusDeck.tsx`, `Session.tsx`, new `SyncChip.tsx` (or the existing sync control reshaped), `UnitSwitch.tsx` moved into the sheet.
3. **`-platesheet`**: sheet with `Plate sled | Pin stack`, base weight `-`/`Type`/`+` on the in-app number pad, remainder text, footer copy. Files: `FocusMoreSheet.tsx` or a new `PlateSheet.tsx`, `lib/loadStyle.ts`, `lib/plates.ts`. Device-local `ExercisePref`, no new storage.
4. **`-superset`**: member-by-member logging, `A1 THEN A2 . REST AFTER A2`, NOW load picture, rest after A2 only. Each log uses the single-set path. Decide (spec Q3) whether `enqueueBatch` and `SupersetRoundEditor` are deleted or left. Files: `SupersetRoundEditor.tsx`, `Session.tsx`, `lib/outbox.ts`.
5. **`-reorder`**: drag handle plus `Move up`/`Move down`, whole units, upcoming only, order in the session's local persisted mirror, no plan write. Files: `WorkoutOverview.tsx`, `lib/sessionFocus.ts`, `lib/persistedSession.ts`.
6. **`-tests`**: brings the stale suite green and adds the cases in "Phase 1 tests". Last, but each sub-branch must keep its own tests green; this branch is for the cross-cutting integration cases.

### Tasks

- [ ] Dock: load and reps in one row; four keys `RPE`, `Note`, `Skip`, `Swap` or `Fix last`; full-width Log with the labels in the spec; 200ms duplicate-tap lock kept.
- [ ] Load picture: plates small outside / big inside, one donut per plate; dumbbells 1 to 2 with one weight-coloured head each end and the `+` between; pin stack; bodyweight card; caption and action lines exactly as in the spec.
- [ ] Bodyweight: reps hero, added-load row `+ 25 lb added` behind the single gating constant until spec Q8 is answered; `+ Add load (belt or vest)` as text.
- [ ] Rest: middle band card, `LAST SET . ALREADY SAVED` with receipt and Fix, `LOAD NEXT`, `REST OVER` text, `End rest now >` in the dock label row. Ending early never logs; `rest_seconds` on the next set is real elapsed.
- [ ] Dock label `NEXT SET . n OF m` only during rest or REST OVER.
- [ ] Coach cue in ink with the icon; ochre only for the current set.
- [ ] Plate sheet, `Today's workout` sheet with `Units this session`, hint text and `Finish session`.
- [ ] Reorder as above; arrows reachable without drag.
- [ ] Unit override is session-only and persisted in the session mirror; the device setting is not written.
- [ ] Update `docs/flows.md` (Focus deck, Rest, Log a superset round, Plates, header) and remove the "superseded" notes this plan's docs commit adds, in the same PR as the code.

### Phase 1 tests (add or update)

| Test file | Cases |
| --- | --- |
| `pwa/src/lib/loadPicture.test.ts` (new) | Plate order outside-in; dumbbell colour thresholds in lb and kg; head height cap; stack rows never claim a position without metadata |
| `pwa/src/components/session/FocusDeck.test.tsx` | Header `n/m`, Focus/List, chip states and accessible names; set position once; dock keys; Swap vs Fix last; Log labels; bodyweight reps-first; REST and REST OVER copy; `End rest now` changes view only; label only during rest |
| `pwa/src/components/session/SetEditor.test.tsx` | Per-side caption, one/two toggle keeps the entered number, 44px classes present, number pad opens from load |
| `pwa/src/components/session/SupersetRoundEditor.test.tsx` | Member-by-member inserts, one ordinary `SetInsert` each, rest starts after A2 only, A1 logged and A2 pending is a normal state |
| `pwa/src/components/session/WorkoutOverview.test.tsx` | Reorder moves a whole ramp or pair, done rows fixed, no plan RPC called, keyboard move works |
| `pwa/src/screens/Session.focus.test.tsx` | Draft, rest clock and selection survive Focus/List and every sheet; editing the dock during rest leaves the saved set unchanged; unit override does not write the device setting; `load_kg` is the total for per-side, sled and added load |
| `pwa/src/lib/outbox.test.ts` | Only if `enqueueBatch` is removed: no remaining caller |

### Acceptance criteria

1. Every Phase 1 state in the spec renders and is reachable from the demo scenarios (`npm run demo`).
2. Log is visible without page scroll at 320 x 640 and 1.3x text.
3. No tap target under 44px and no meaningful text under 11px in the Phase 1 screens (assert on the CSS tokens and spot-check in the browser).
4. Per-side is never shown as total or the reverse; `load_kg` written for a dumbbell pair is the total.
5. A saved set cannot be altered from the dock; Fix still writes void plus same-index row.
6. Reordering writes nothing to Supabase and the plan is unchanged after Finish.
7. `docs/flows.md` matches the shipped behaviour.
8. Real-phone pass: log a loaded set, rest, end rest early, change load during rest, fix the last set, superset A1 then A2, bodyweight, reorder, go offline and back.

### Test commands

```bash
# focused, during work
cd pwa && npm test -- --run src/lib/loadPicture.test.ts src/components/session src/screens/Session.focus.test.tsx src/screens/Session.test.tsx src/lib/plates.test.ts src/lib/loadStyle.test.ts src/lib/outbox.test.ts

# before the PR (AGENTS.md "Tests, by area", pwa)
cd pwa && npm ci && npm run build && npm test -- --run

# docs
node scripts/check-release-ledger.mjs
```

No schema or Edge Function change in Phase 1, so the database and Deno blocks do not run.

## Phase 2: Train (`feat/train-d`)

Branch from `main` after Phase 1 merges.

### Tasks

- [ ] Top-align the Train composition; remove the bottom-pinned layout.
- [ ] Week strip on Train: 7 cells, glyph plus 11px state word (`DONE`, `SKIP`, `TODAY`, `REST`, `NEXT`, `DRAFT`, and `MISS` for a missed day). Reuse the Program strip's data, not a second fetch.
- [ ] Date row with `Check in` text button (spec Q4); `Coach` and settings in the header; sync chip from Phase 1.
- [ ] Day card states and copy from the spec, including the outbox-aware `Lower A finished` line.
- [ ] Remove the duration estimate; show shape only.
- [ ] `Go`, `Resume`, `See the plan`, `Fill in this day`, `Start empty session`. Every Start still goes through the existing `start()`; Go creates no session.
- [ ] Keep the tab label `Program` unless spec Q5 is answered otherwise.
- [ ] Update `docs/flows.md` Weekly planning and Train text.

### Tests

`pwa/src/components/TrainHome.test.tsx` (planned, in progress, done with empty outbox, done with queued writes, draft, offline, error banner, no plan; no `about 65 min`), `pwa/src/screens/Today.test.ts` (state-word mapping including MISS, NEXT, DRAFT), `Today.done-summary.test.tsx`, `Today.plan-changed.test.tsx` (unchanged behaviour), and a render test for the strip at 320 px width.

### Acceptance criteria

1. Content starts directly under the strip with no gap at 390 and 320.
2. Each strip cell shows glyph and word; colour is not the only cue.
3. "all sets on the server" appears only when the outbox is empty.
4. Go opens a preview and creates no session; only Start does.
5. Strip cell width exception at 320 px confirmed on a phone (spec Train).

### Test commands

```bash
cd pwa && npm test -- --run src/components/TrainHome.test.tsx src/screens/Today.test.ts src/screens/Today.done-summary.test.tsx src/screens/Today.plan-changed.test.tsx
cd pwa && npm ci && npm run build && npm test -- --run
```

## Phase 3: Record (`feat/record-d`)

Branch from `main` after Phase 2 merges.

### Tasks

- [ ] Additive migration: a `security_invoker` view over `v_live_sets` returning, per exercise, `last_performed_on` and `session_count` (a derived metric, so a view, never a column). Add the view to the PWA types and `check-selects`.
- [ ] Record index: search, `PINNED GOALS`, `RECENT` (recent first, most sessions breaks ties), `Search the full library`, bodyweight row. Reuse the picker for the library.
- [ ] Pin toggle writes `goals` (`target_e1rm_kg` = current e1RM times 1.1 rounded to the next 5 lb or 2.5 kg step); unpin removes it (spec Q6). Absent when the exercise has no e1RM. Goal `-`/`+` steppers on the detail.
- [ ] Reuse `v_goal_progress` for the percentage and the existing chart.
- [ ] Offline: cached index; pin and unpin queue through the outbox or are disabled offline, whichever the code owner chooses (record in the decision).
- [ ] Update `docs/flows.md` History and corrections.

### Tests

`pwa/src/screens/History.test.tsx` (new or extend), `History.bodyweight.test.tsx` (unchanged), recency sort and tie-break, pin and unpin writes, no pin without e1RM, empty state, a `scripts/validate-db.mjs` assertion for the new view (RLS, `security_invoker`, excludes voided and discarded sets), and a `goals` owner-RLS write check.

### Acceptance criteria

1. Recent exercises are at the top; with equal dates the one done more often is first.
2. Pinned goals show above RECENT with `Goal`, percent and a progress bar; the toggle is text, not a filled button.
3. The new view reads `v_live_sets` and nothing else; `node scripts/validate-db.mjs` and `check-selects` pass.
4. A coach-set goal and a PWA pin are the same row (unique per exercise).

### Test commands

```bash
# database / migrations / RLS / views
node scripts/build-exercise-seed.mjs
npm --prefix scripts ci
node scripts/validate-db.mjs
node scripts/check-selects.mjs
node --test scripts/release-ledger.test.mjs scripts/strength-mcp-relay.test.mjs scripts/strength-tunnel-config.test.mjs scripts/strength-tunnel-supervisor.test.mjs scripts/check-pwa-env.test.mjs scripts/check-deploy-contract.test.mjs
node scripts/check-release-ledger.mjs

# pwa
cd pwa && npm ci && npm run build && npm test -- --run
```

The edge function blocks (`mcp-server`, `coach`, `push-alerts`, `endurance-sync`) do not run unless the view is also exposed through an MCP tool; if it is, run `cd supabase/functions/mcp-server && deno check index.ts && deno test --allow-env --allow-net`.

## `feat/exercise-prefs-sync` (separate PR)

Owns: the new Supabase table, its RLS, the PWA sync of `ExercisePref` (`barKg`, `loadStyle`, one/two dumbbells), and its own `docs/decisions.md` entry (it supersedes the "no `exercise_prefs` table, settings do not sync" paragraph in `AGENTS.md` Layout/Hard rules). This plan does not duplicate that entry. Version D touches it in exactly one place: the plate sheet footer `on this phone` becomes `on your account` when that PR merges. Whichever merges second rebases and resolves that string.

## Cross-phase checklist

- [ ] `docs/decisions.md` 2026-10-01 entry stays accurate as open questions close.
- [ ] Superseded notes added to the three earlier specs and `docs/flows.md` are removed when the code makes them wrong.
- [ ] Design-log README per phase.
- [ ] Spec open questions 1 to 8 answered or explicitly deferred before the phase that needs them starts (Q1, Q2, Q3, Q8 before Phase 1 sub-branches `-css`/`-superset`; Q4, Q5 before Phase 2; Q6, Q7 before Phase 3).
