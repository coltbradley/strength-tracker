# Warm Precision Redesign

## Goal

Turn Strength Log into a calmer, more authored training tool without hiding
the controls needed to plan, log, correct, or recover a session. The approved
direction combines the open, movement-aware hierarchy of Set Score with the
decisive scale and action placement of the Train concept.

This is an information-architecture change as well as a visual change. Train
answers what to do now. Program owns calendar and workout editing. Record owns
past work. Focus mode answers what to enter for the current set.

## Visual system

The product uses the Aubergine and Ochre palette:

- canvas: `#f7f6fa`
- raised canvas: `#fcfbfd`
- text: `#302b3a`
- primary action: `#57417f`
- primary pressed: `#463269`
- current-set marker: `#855600`
- completed-set marker: `#665f71`
- control outline: `#766e7b`

Ochre is reserved for the current set. It is not a general accent, warning, or
button color. Completed work is quiet aubergine-grey; future work uses a neutral
outline. Plate colors remain informational and do not inherit theme accents.

The interface remains light-only, flat, and typographic. It does not use dark
panels, gradients, glass, decorative textures, handwritten type, workout
illustrations, floating circular actions, or dashboard-card grids. Chivo stays
as the offline-safe grotesk; large values use tabular numerals.

## App structure

The bottom navigation becomes:

- Train: `/`, the immediate action surface.
- Program: `/program`, the existing calendar, later-workout, template, and
  plan-management surface.
- Record: `/history`, the existing history surface.

Train and Program render different presentations of the same `Today` state.
They must not duplicate fetches, active-session reconciliation, cache handling,
or session creation. The existing `start()` function remains the only session
creation path.

The top bar uses the `SET` wordmark. Healthy sync state disappears; queued or
failed writes remain visible. Settings and recovery controls remain reachable.
The floating coach/problem dock is removed from the primary visual field and
replaced by restrained top-bar access without changing the underlying sheets.

## Train home

The default home is an open composition, not a dashboard. For a planned workout
it shows only:

1. Today's date context.
2. Workout name.
3. Honest workout shape, derived from grouped movements and prescribed sets.
4. `First up`, derived from the first grouped movement.
5. One state-led primary action: Start, Resume, Complete/view record, or rest.
6. One `View program` text action.

Duration is not estimated because the data model does not store a workout
duration. Ramp prescriptions count as one movement through `groupRamps`; raw
prescription-row count must not be presented as movement count.

Active-session and orphan-recovery states override the planned workout. Loading,
offline, and server-error states remain truthful but visually quiet. First-run
and rest-day states provide a direct route into Program. Check-in, bodyweight,
templates, later workouts, calendar navigation, rescheduling, and detailed
prescriptions live in Program or an existing sheet rather than competing on
Train.

## Program

Program preserves the current Today screen's planning behavior: week and
calendar navigation, selected-day detail, undated program order, later workouts,
templates, skip/unskip, reschedule, edit, check-in, bodyweight, and first-run
plan creation. Moving these controls is a presentation split, not a rewrite of
their data flow.

## Focus mode

The active screen keeps one open vertical column:

1. Quiet workout position and overview access.
2. Movement name.
3. Current editable value, with the value most likely to be entered incorrectly
   receiving the largest type.
4. One supporting historical line when reliable `lastActuals` data exists.
5. A compact segmented set line immediately above the controls.
6. A broad Aubergine action dock with coarse decrement, current value, increment,
   and the commit action.

The set line is functional progress, not decoration. Completed segments use the
completed marker, the current segment uses ochre, and future segments are
outlined. Text and DOM order carry the same state, so color is never the only
signal. By-feel work without a target omits the segmented line.

Movement display follows facts already represented by the app:

- plateable barbell and ordinary machine/cable work: numeric load and reps;
- paired dumbbells or kettlebells: per-side value plus explicit paired context;
- single-implement or unilateral work: stored total-entry convention, without
  inventing separate left/right events;
- bodyweight: reps is the hero and no zero-load field appears;
- completion tracking: one literal completion action;
- supersets: two compact members and one shared round commit action.

Plate diagrams only appear when the existing inventory-aware split succeeds.
Cable pin positions and assistance semantics are not inferred from names.

## Deferred capability

Timed focus logging is not part of this visual pass. Although the schema has
`sets.duration_seconds`, the current draft, editor, read projection, and logging
pipeline do not support it end to end. Time prescriptions remain in the existing
overview-safe path until that data feature receives its own tested plan. The UI
must not render seconds as reps or claim assistance semantics the model lacks.

## Accessibility and resilience

- All controls retain at least the existing 44px hit area.
- Focus order follows visual order and every icon control has a descriptive
  accessible name.
- Text and control contrast meet WCAG AA on the light canvas.
- Reduced-motion behavior remains intact.
- `setsLoaded` and `setsFailed` guards, append-only set writes, outbox behavior,
  start gating, orphan recovery, and draft retention are unchanged.
- Narrow-phone layouts must remain usable without horizontal scrolling.

## Verification

Behavior changes are test-first. Required coverage includes the three-route
navigation, Train home state/action rendering, grouped movement and set counts,
hidden healthy sync state, focus set-line semantics, bodyweight and per-side
heroes, completion mode, supersets, and preservation of existing session flows.

Run the complete PWA test suite, forced TypeScript build, production build, and
a browser pass at a narrow phone viewport. Capture Train, loaded focus,
bodyweight focus, and superset focus screenshots for review.
