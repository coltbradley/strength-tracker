# Session focus deck design

## Status

Proposed and approved in conversation on 2026-09-12. This document is a
design specification, not authorization to change runtime code. The next step
after user review is a separately approved implementation plan.

## Problem

The existing session screen is an accordion. It is strong at orientation: a
lifter can see every exercise, progress, skips, supersets, and where they are
in the workout. It is weaker at the moment a set is performed, where the
lifter needs one large, unambiguous action at arm's length.

The design exploration in `docs/design-log/2026-09-07-world-class/` reached a
useful principle: the logging surface should make the hard-to-get-right fact
for the current movement prominent. It must not replace the workout map. The
earlier full-screen deck prototypes are therefore not a replacement screen
design.

## Decision

After Start, the session opens in **focus mode**. The existing accordion stays
available as the **workout overview**. They are two presentations of one
session, never two copies of the session state.

Focus mode owns the immediate set or superset round. Workout overview owns
orientation and exercise selection. The user can move between them without
losing staged edits, a rest clock, notes, correction state, selected exercise,
or synced and unsynced sets.

## Interaction model

### Focus mode

Focus mode is the default immediately after a session starts or resumes. It
opens on the existing first incomplete exercise, or the restored active
exercise when one is known.

Its quiet top-left action is **View full workout**. It changes presentation
only; it does not navigate away from `/session` and it does not clear any
draft.

For a normal exercise, focus mode presents:

- exercise name and current set position;
- sets remaining in this exercise and exercises remaining in the workout;
- the existing editable load, reps, RPE, note, correction, skip, extra-set,
  and rest controls;
- one primary log action; and
- the next suggested exercise when the current one is complete.

The deck may use a movement-specific hero, but must not represent a fact the
application does not know. A plate load is valid because `split()` uses the
actual plate inventory. A cable stack pin is out of scope until the data model
has machine-stack metadata.

### Workout overview

Workout overview is the existing accordion presentation, reached from **View
full workout**. It retains its job of showing every exercise, target, progress,
superset relationship, skip state, and workout-level controls.

Overview has a **Focus mode** action. Its behavior is exact:

1. If the lifter taps an exercise in overview, that entry becomes selected.
2. **Focus mode** opens that selected entry.
3. If the lifter changes nothing in overview, **Focus mode** returns to the
   exercise that was focused before overview opened.

An overview transition must retain any uncommitted focus draft. Selecting a
different exercise must not silently apply, discard, or overwrite that draft.

### Superset rounds

A consecutive superset is one focus unit, not two deck pages. Focus mode shows
both members together and makes the round state explicit, for example
`SUPERSET A · ROUND 2 OF 3`.

Each member has its own independently editable staged values. The normal
primary action is **Log round**, which records one set for each member. There
is also a secondary **Log A1 only** action for interruption, unavailable
equipment, or a deliberate change of order. A partial round never fabricates
the second member's result.

After **Log round**, focus remains in the same superset for its next unfinished
round. Once the pair is complete, it offers the next incomplete exercise. No
manual `Next` tap is required between the two members of a round.

## State and data ownership

`Session.tsx` remains the owner of session state. The implementation may
extract components and reducers, but it must retain one source of truth for:

- `setsRef` and rendered sets;
- `openKey`, the selected exercise entry;
- staged load, reps, set type, RPE, note, correction, and skip state;
- rest state and its persisted mirror;
- exercise/prescription snapshots and substitutions; and
- the existing append-only outbox.

Add one presentation state with exactly two values: `focus` and `overview`.
Do not add a new route, server row, or persisted preference in the first
release. A reload follows the existing session restore behavior and opens the
first incomplete entry, rather than promising to restore a visual mode that
was never persisted.

For a superset, add a local round draft keyed by the two current entry keys and
the round index. Its fields are derived from the same prefill rules used by an
ordinary set. It is transient UI state until a log action is taken. When
overview opens, the round draft remains in the mounted session owner.

## Write and offline behavior

Sets remain ordinary append-only `SetInsert` rows. A superset must not create a
new database record type or weaken idempotent retries.

**Log round** builds two client-ID-bearing set inserts. Before updating the
rendered set list, it persists both inserts together in one IndexedDB
transaction. The outbox then replays the two existing inserts in order. This
gives the user one action without pretending that two separate server requests
are an atomic Postgres write.

If the browser cannot persist the local transaction, neither member is shown
as logged and the deck keeps both editable drafts with a visible error. If a
later server replay accepts one row and rejects the other, the rendered session
continues to show both locally logged rows, and the existing Outbox surface
identifies the rejected row for recovery. The implementation must not hide the
accepted row or enqueue a compensating delete.

**Log A1 only** uses the existing single-set path. It clears only A1's staged
rating and advances the visible round state according to the actual persisted
set count.

## Movement coverage

The first implementation must render honest variants for these existing data
states:

| State | First-release focus behavior |
| --- | --- |
| Plateable barbell or machine | Numeric load stays primary; show the existing inventory-aware plate bar when applicable. |
| Dumbbell / per-side load | Show the per-hand value and the stored total explicitly; never display the doubled total as the weight in each hand. |
| Ordinary cable | Use the normal numeric load editor. Do not show an invented stack-pin position. |
| Bodyweight / no load | Omit a fake zero-load editor; reps are the primary editable value. |
| `tracking = done` | Use a completion action with no numeric load or reps editor. |
| `tracking = time` | Block focus-deck rollout until duration editing and `duration_seconds` writes are implemented and tested. |

The time state is deliberately a prerequisite, not a silent fallback. The
schema supports `tracking = time`, but the current session UI only treats
`tracking = done` specially. Rendering time as reps would be a data and UX
error.

## Component boundaries

The implementation should reduce `Session.tsx` coupling rather than add a
second large render branch inside it.

- `SessionPresentation`: owns `focus` / `overview` and transition rules.
- `WorkoutOverview`: receives the existing entry list, progress, selection,
  and overview callbacks. It does not own logging drafts.
- `FocusDeck`: receives the current entry or superset round, derived progress,
  staged values, and callbacks. It does not query Supabase or IndexedDB.
- `SetEditor`: a shared controlled editor for the current normal set; used by
  the deck and, during migration, the accordion.
- `SupersetRoundEditor`: a controlled two-member editor that emits either a
  complete round or one member.
- `enqueueSetBatch`: the outbox-level primitive that persists an ordered list
  of ordinary write operations in one IndexedDB transaction.

No component may maintain an independent copy of completed-set counts or
exercise progress. Those values stay derived from the canonical set list.

## Non-goals

- No schema migration for focus/overview mode.
- No cable-stack-pin visualization without real metadata.
- No automatic navigation to a different route after a set is logged.
- No replacement of the full-workout accordion.
- No visual reskin or adoption of the discarded cast-iron theme.
- No broad Session rewrite before the shared editor has regression coverage.

## Failure handling and accessibility

- Keep the existing `setsLoaded` and `setsFailed` guards. A deck must not log
  against an unverified empty set list.
- Preserve keyboard reachability and descriptive labels for every edit and
  action. The visual plate diagram remains supplementary to text.
- Respect reduced-motion settings when changing focused exercise or mode.
- A rest timer keeps measuring through a presentation change. Whether its strip
  is shown continues to follow the existing superset and sheet rules.
- Overview must expose an accessible current-selection state and focus deck
  must announce the selected exercise and set/round position.

## Verification plan

Tests are required before implementation code for each behavior change.

1. Pure state tests: focus/overview transitions retain selection and drafts;
   selecting in overview changes the focus destination; next exercise and
   remaining counts are derived from actual set rows.
2. Superset tests: `Log round` creates the expected two ordinary inserts with
   independent ids and correct prescription links; `Log A1 only` creates one;
   a partial round never marks A2 complete.
3. IndexedDB/outbox tests: batch enqueue is all-or-nothing locally and preserves
   replay order; replay of either item remains idempotent.
4. Render tests: normal, per-side, tick-only, and time-blocked focus states;
   accessible labels; no fake cable pin; overview-to-focus selection behavior.
5. Browser flow: Start → focus → log normal set → overview → choose exercise →
   focus → log superset round → finish. Run on a narrow phone viewport and
   with an offline transition after local persistence.

## Rollout order

1. Implement and test duration tracking separately. Do not mix it with the
   focus-deck presentation change.
2. Extract shared controlled editor logic while keeping the accordion as the
   rendered default.
3. Add focus/overview presentation switching for ordinary reps and tick-only
   work.
4. Add the local-atomic outbox batch primitive and the superset round editor.
5. Add dumbbell/per-side presentation, then verify with real gym use.
6. Put focus mode behind a temporary local setting until the complete session
   browser flow and a phone smoke test pass. Make it the default only then.
