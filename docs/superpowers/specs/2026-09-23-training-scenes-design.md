# Training scenes and native units design

## Product decision

The app needs two changes that belong together:

1. Treat the workout as a set of purposeful scenes, not one single-exercise Focus screen with exceptions squeezed into it.
2. Make pounds and kilograms authored units, not only a display conversion of stored kilograms.

The current single-exercise Focus scene has the right hierarchy: exercise, Set 3 of 5, large working value, one obvious log action. The paired-superset screen is a compressed exception and needs a separate round scene. The current unit model stores a physical kilogram value and converts it to the current device unit. That is why a metric-authored target can read as 72.3 lb. It is mathematically truthful but not native lifting language.

## What established apps do

Hevy provides a default measurement system plus a per-exercise kg/lb override. Fitbod documents the same global/per-exercise model and says historical workouts remain in their original units, while also documenting rounding issues when a user switches units. The useful pattern is a convenient default, an exercise-level escape hatch, and preserved authored context. Their public help does not establish their database models.

## Scene inventory

| Scene | Dominant question | Primary action |
| --- | --- | --- |
| Rest / next workout | What is next? | Go |
| Workout preview | What am I about to do? | Start workout |
| Loaded single exercise | What load and reps am I doing? | Log set |
| Paired dumbbells | Is this per hand or total? | Log set |
| Bodyweight | How many reps? | Log set |
| Timed work | How long did it last? | Log set |
| Tick-only work | Did I complete it? | Mark done |
| Paired superset | What are A1 and A2 this round? | Log round |
| Rest / ready | What did I do, what is next? | Continue when ready |
| Workout menu | What is in the full workout? | Select entry |
| Correction | What exact historic fact changes? | Correct or void |
| Completed session | Finish or add more work? | Finish workout |
| Plan authoring | What should this workout contain? | Save day |

Warmups, ramps, skips, substitutions, and extra sets are states within those scenes.

## Entry flow

On a rest day, Train says:

> Rest day. Next workout: Saturday, 26 September, Lower strength.

Go opens a read-only workout preview. It does not create a session. A DRAFT day never qualifies as the next workout.

For a planned day, the home button is Go, not Start. The preview renders the whole workout: sections, ramps, supersets, targets, rest, coach note, plan note, and first-up. Only Start workout creates the active session and queues its insert.

## Active workout flow

The upper-left control becomes an actual hamburger labelled Workout, with accessible name Open workout. It opens the existing full overview. The progress rail remains visible state and navigation, not the sole hidden route to the whole workout. The upper-right overflow remains exercise-scoped.

The loaded single-exercise scene retains its large load/reps/log hierarchy. Bodyweight makes reps the hero. Timed work gets a duration hero. Tick-only work has no invented numeric input.

### Superset round

A normal paired superset is exactly two consecutive compatible rep-tracked entries.

- Header: hamburger, Superset A, Round 2 of 3.
- Body: two equal large cards, one for A1 and one for A2. Each has full name, target/last time, editable load and reps.
- Bottom: one primary Log round. Partial logging is a recovery action labelled Log [exercise] only.
- After every completed non-final round: an orange top rest cue says REST 1:20 and Next: Superset A, round 2 of 3.
- On expiry the cue animates from REST to READY and the Focus scene returns to
  the next set's ready-to-log state. If the prior movement is complete, it
  selects the next unfinished movement or round. It never logs, skips, or
  finishes automatically.

The current app only gives paired Focus to exactly two entries. A three-member group silently falls back to overview. Until a circuit scene is designed, Plan must make that explicit. We should not silently promise a Focus superset for a group the active UI cannot render.

### Rest, RPE, notes, and completion

Rest belongs at the top, visually distinct from the log action. It shows time, next set or round, adjustment controls, optional Rate last set RPE, and Note last set. RPE is per-set and optional, separate from the end-session RPE.

The state progression is explicit: logging set 2 of 5 advances the screen to
REST for set 3 of 5; timer expiry changes it to READY for set 3 of 5; logging a
final prescribed set selects the next unfinished exercise. The interface moves
forward, but the timer never writes to the training record.

After all prescribed work is done, Finish workout is primary and Add extra set is secondary. Choosing Add extra set changes local intent only. A set is written only after Log extra set. Adding an unplanned exercise remains in the full workout overview.

## Information hierarchy

The screen should answer one question at a time. Hierarchy comes first from
placement and size, then from copy and colour. Colour alone cannot identify a
state, especially in a bright gym or for someone who does not distinguish the
accent colours.

| Priority | What it communicates | Where it belongs |
| --- | --- | --- |
| 0 | A problem that changes what is safe to do, such as a held write or unavailable set history | A persistent compact status row above the scene, never buried in Settings |
| 1 | What scene the person is in: today, preview, set, round, REST, READY, or complete | Top slot. REST/READY owns this slot while active; Workout remains reachable at upper left. |
| 2 | The immediate work: exercise or A1/A2 pair, set or round position, and the next destination | The top of the content area, before optional history or coach detail. |
| 3 | The value to act on: load, reps, time, or done state | Large, stable, tabular numerals in the visual centre. |
| 4 | One action that changes the state: Go, Start workout, Log set, Log round, or Finish workout | Sticky lower action area. There is one primary action per scene. |
| 5 | Useful but deferrable detail: last time, plate advice, coach cue, RPE, set note, skip, swap, and correction | Workout menu or an explicitly opened sheet. Do not make these compete with logging. |

The same rule applies outside Focus. A rest day says "Today is a rest day",
then names the earliest actionable workout and its date, then offers Go. A
preview shows the whole plan with Start workout as the only durable action. A
completed card should promote the next actionable workout before "View record";
record review is useful, but it is not normally the next decision an athlete
opens the app to make.

## Motion and interaction feedback

Add motion as feedback for a state change, not as decoration. A workout screen
that constantly moves makes timing feel less reliable and competes with the
load and the next action. The motion system therefore has a small vocabulary:

| Event | Motion | Constraint |
| --- | --- | --- |
| Log reaches its durable local queue commit | The completed set settles out and the next set settles in, using opacity plus a short vertical movement (roughly 160–220 ms). | Do not wait for the network or imply remote sync, but never animate a log as accepted before the local outbox has committed it. |
| REST begins | The orange rest band enters the top slot and its target becomes visible in one short transition (roughly 180–240 ms). | REST is also named in text and has a timer, target, and adjustment control. Orange is reinforcement, not the only cue. |
| Timer reaches zero | REST changes to READY with a single colour/label transition and the next set becomes visually selected. | No looping celebration, no automatic log, skip, or finish. The timer uses tabular numerals and does not animate every tick. |
| Next exercise or round | The selected card changes with a short cross-fade or shared-axis transition (roughly 160–200 ms). | Preserve typed drafts. Never let movement obscure the A1/A2 pair identity. |
| Reorder planned entry | The whole entry, including its ramp or pair, moves as one object and settles into a clear destination. | Arrows remain the accessible first-release control; drag is an enhancement, not the only path. |
| Sheet, menu, or preview opens | Use the existing sheet rise/fade language. | Return leaves the Focus draft, rest clock, and selection intact. |

All of these respect `prefers-reduced-motion`: replace movement with an
instant state change and preserve the text/state cue. Do not use a repeating
blink, a countdown animation, or colour-only success feedback. Sound or
vibration, if introduced later, needs its own device-permission and gym-noise
decision; it is not part of this PWA release.

## Editing and ordering

Plan operations affect future prescriptions: Add set, Edit prescription, Remove planned exercise. Reordering operates on a complete entry. A ramp keeps all of its rows. A superset keeps both exercises and all their rows. The existing entry move model already protects this and should remain visible with arrows in the first release.

An active-session menu may change the next log draft, but it must not silently
edit the plan beneath an open or logged session. "Modify this set" means the
actual load/reps/duration the athlete is about to log. Plan editing remains a
before-start operation, or is refused once the day has logged work, so that a
future-plan change cannot rewrite the historical target or remove the active
session's prescription context.

Logged operations affect history: Add extra set, Correct logged set, Void logged set. Delete set is false language because sets are append-only. Do not hide these actions behind an active-session swipe gesture. A later drag interaction, if needed, must drag a whole entry with a destination preview, never a prescription row.

## Native lb/kg model

Keep load_kg as the canonical total-system value used by volume, e1RM, adherence, and MCP analysis. Add authored representation beside it for every newly written direct load:

- entered_load: the exact number the person or coach typed.
- entered_unit: lb or kg.
- load_entry: existing total or per_side convention.

For a pair of 30 lb dumbbells, entered_load is 30, entered_unit is lb, load_entry is per_side, and load_kg remains the total system mass. A barbell at 225 lb is stored and displayed as 225 lb, while analytics read its canonical kg equivalent.

Direct percentage-of-training-max prescriptions have no fixed authored load and leave these fields null. Legacy rows also remain null and display through the current conversion path, visibly labelled as converted only in editable contexts. We must not fabricate an original unit for history.

This is a schema and API contract, not a formatting patch. It requires an additive migration, expanded views/types, PWA outbox/correction propagation, and MCP plan-writer support. A database validation trigger should reject a new row whose canonical kg does not agree with entered_load, entered_unit, and load_entry within numeric precision. It validates but does not rewrite append-only sets.

## Input rules

- A valid typed value is accepted exactly. No silent snapping.
- A default input unit can remain device-local initially, but the unit attached to a prescription or logged set is durable and travels with it across devices.
- Each exercise can choose an input unit and an increment preference, following the established global-default/per-exercise-override model.
- Steppers recommend an equipment-aware grid: barbell/plates, dumbbells per hand, cable/machine stack. The plan editor and active logging use the same helper.
- A metric-authored legacy target may truthfully read as 72.3 lb. The UI can offer an explicit nearby standard number while editing, but may not substitute it automatically.

Moving the default unit from device-local settings to account-level is a separate product decision. Durable authored units solve the cross-device record problem without changing the existing shared-phone setting policy.

## Acceptance criteria

1. Rest day identifies the earliest actionable future workout. Preview creates no session.
2. Start workout is the only point that creates an active session.
3. Each scene above has one clear primary action at 320 px.
4. Both superset members are readable, a pair logs as one ordered local batch, and rest is visible after each complete non-final round.
5. Rest expiry advances the interface to a ready-to-log next set/entry but
   cannot mutate the log, skip work, or finish a session.
6. Workout menu is discoverable and preserves staged state on return.
7. New lb-authored and kg-authored prescriptions/sets round-trip in their authored unit exactly while analytics still use total load_kg.
8. Existing legacy rows and %TM plans continue to read correctly.
9. Entry ordering stays atomic, and historical set actions never expose a hard delete.
10. Every scene preserves the priority order above, and every motion is tied to
    a user-visible state change with a reduced-motion equivalent.
11. An active-session adjustment changes only the next actual log, never a
    historical or active plan prescription.
