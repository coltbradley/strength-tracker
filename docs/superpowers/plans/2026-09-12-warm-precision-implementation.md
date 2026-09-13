# Warm Precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to execute this plan task by task.

**Goal:** Ship the approved Aubergine and Ochre Train, Program, Record, and
focus-mode redesign without duplicating state or weakening logging safety.

**Architecture:** `Today` remains the single data owner for Train and Program.
A small presentational Train component receives derived, honest display facts
and existing callbacks. `Session` remains the single owner of drafts and writes;
`FocusDeck` and `SetEditor` only change presentation. Global role tokens carry
the new palette.

**Spec:** `docs/superpowers/specs/2026-09-12-warm-precision-redesign.md`

## Global constraints

- Do not duplicate the `Today` load/reconciliation/start state machine.
- Do not add schema changes or infer timed, assisted, cable-pin, or separate-side
  semantics.
- Keep all existing start gates, recovery paths, append-only writes, and focus
  draft behavior.
- Write a failing focused test before each behavior change.
- Use exact palette values from the spec and keep ochre exclusive to current-set
  progress.

## Task 1: Split Train, Program, and Record navigation

**Files:**
- Modify `pwa/src/App.tsx`
- Modify `pwa/src/components/SyncStatus.tsx`
- Create `pwa/src/components/PrimaryNav.test.tsx`
- Modify `pwa/src/styles.css`

- [ ] Add a failing render test for Train, Program, and Record links, their
  routes, and the absence of a healthy `SYNCED` pill.
- [ ] Add `/program`, rendering `Today` with a presentation prop.
- [ ] Rename navigation labels and the top-bar wordmark to the approved system.
- [ ] Hide only the healthy sync pill; preserve queued, active, and failed states.
- [ ] Replace the persistent floating dock with restrained header access while
  preserving Coach, problem report, Settings, and their sheets.
- [ ] Run focused tests, typecheck, then commit.

## Task 2: Add the sparse Train home

**Files:**
- Create `pwa/src/components/TrainHome.tsx`
- Create `pwa/src/components/TrainHome.test.tsx`
- Modify `pwa/src/screens/Today.tsx`
- Modify `pwa/src/screens/Today.test.ts`
- Modify `pwa/src/styles.css`

- [ ] Add failing tests for planned, active, rest, loading/error, and first-run
  compositions. Assert that calendar, check-in, bodyweight, and detailed
  prescription controls are absent on Train.
- [ ] Add pure helpers that choose today's actionable workout and summarize
  grouped movement count, prescribed set count, and First up.
- [ ] Render `TrainHome` for `presentation="train"`; retain the current planning
  tree for `presentation="program"`.
- [ ] Route every Start through the existing `start()` function and every plan
  action to `/program`.
- [ ] Run focused tests, full Today-related tests, typecheck, then commit.

## Task 3: Build the functional focus set line

**Files:**
- Modify `pwa/src/components/session/FocusDeck.tsx`
- Modify `pwa/src/components/session/FocusDeck.test.tsx`
- Modify `pwa/src/components/session/SupersetRoundEditor.tsx`
- Modify `pwa/src/components/session/SupersetRoundEditor.test.tsx`
- Modify `pwa/src/styles.css`

- [ ] Add failing tests for completed, current, and future segment semantics,
  by-feel omission, and one shared progress indicator for a superset round.
- [ ] Render the segment line from canonical progress and target values. Keep a
  single accessible textual status and no color-only meaning.
- [ ] Place it immediately above the existing commit dock without adding state.
- [ ] Run focused tests, session focus tests, typecheck, then commit.

## Task 4: Apply movement-aware Warm Precision focus hierarchy

**Files:**
- Modify `pwa/src/components/session/SetEditor.tsx`
- Modify `pwa/src/components/session/SetEditor.test.tsx`
- Modify `pwa/src/screens/Session.tsx`
- Modify `pwa/src/screens/Session.focus.test.tsx`
- Modify `pwa/src/styles.css`

- [ ] Add failing tests for loaded, per-side, bodyweight, done, and superset
  hierarchy, plus the single historical support line.
- [ ] Pass a compact, substitution-aware last-performance string from Session;
  do not duplicate the full logged-history surface.
- [ ] Remove target and explanatory visual clutter from focus while retaining it
  behind More and through accessible naming where needed.
- [ ] Style the open column, large tabular values, square Aubergine dock, and
  one-handed steppers without changing draft arithmetic or log callbacks.
- [ ] Run focused tests, full session tests, typecheck, then commit.

## Task 5: Apply palette and finish the product shell

**Files:**
- Modify `pwa/src/styles.css`
- Modify `pwa/index.html`
- Modify `pwa/vite.config.ts`
- Modify relevant visual assertions if present

- [ ] Add or update token-level assertions for the approved colors and current
  marker role.
- [ ] Replace global color roles with the exact spec palette while preserving
  informational plate colors and danger/warning differentiation.
- [ ] Match browser and installed-PWA theme colors to the new canvas/action.
- [ ] Check narrow, tablet, reduced-motion, focus-visible, loading, offline,
  error, and empty states.
- [ ] Run the full test suite, forced typecheck, production build, then commit.

## Task 6: Browser verification and design record

**Files:**
- Create `docs/design-log/2026-09-12-warm-precision/README.md`
- Create screenshots under `docs/design-log/2026-09-12-warm-precision/`

- [ ] Run the demo on a narrow phone viewport.
- [ ] Verify Train to Program to Record, Start to focus, loaded movement,
  per-side movement, bodyweight, done, superset round, More, correction, rest,
  and session finish.
- [ ] Capture representative screenshots and record known limitations, including
  timed logging and assistance semantics.
- [ ] Run final tests, typecheck, and build; commit the design record.

## Completion gate

Request a whole-branch code and design review against the spec. Fix critical and
important findings, rerun all verification, then use the branch-finishing
workflow. Do not merge or push without the user's instruction.
