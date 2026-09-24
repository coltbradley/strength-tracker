# Training scenes UX review and audit reconciliation

Date: 2026-09-23

Scope: Current checkout `2be4713c6340748a3b71e2665746e36866e5ea67`, the
production PWA observed on 2026-09-23, the live `public.feedback` queue, the
2026-09-19 system audit, and the release ledger. This is a read-only review.
It does not claim production and checkout are the same revision: production
reported `main+d6dacb2`, which is not the checked-out commit.

## What was inspected

| Surface | Evidence | Result |
| --- | --- | --- |
| Live Train home, planned workout, single Focus, and paired superset | Controlled test account, browser walkthrough | Home, Focus, and a two-member Log round work as identifiable scenes; the pair is too compressed and hides rest after a completed non-final round. |
| Current implementation | `Today.tsx`, `Session.tsx`, `FocusDeck.tsx`, `sessionFocus.ts`, Plan, styles, tests | The code has a real focus model, outbox paths, typed rest, reduced-motion handling, and atomic entry movement. It also intentionally suppresses the visual rest strip while a superset round remains. |
| Live feedback | `public.feedback`, queried 2026-09-23 | Full program discoverability, add set, set note, rest transition, lb/kg, barbell math, warmup handling, and landscape are active user reports. |
| Audit and release authority | 2026-09-19 system audit and release ledger | Several unresolved session lifecycle findings directly intersect the proposed Start, Workout menu, rest, correction, and superset work. |

## First-read hierarchy

The proposed hierarchy is a product rule, not a styling preference:

1. Show any state that makes a next action unsafe, for example a held local
   write or unavailable set history.
2. Name the current scene, including REST or READY when it applies.
3. Show the immediate exercise/round and position.
4. Make the value to act on visually stable and largest.
5. Offer one primary action. Everything else is secondary or in Workout.

This fixes the current failure mode where important plan navigation, notes,
and extra-set actions exist but are discoverable only after someone already
knows to look in an overflow surface. It also avoids turning every feature
into a competing primary button.

## Motion direction

Use motion to acknowledge a durable local action or identify a scene
transition. The current code already has short sheet/set transitions, tabular
timer numerals, and a reduced-motion path. Preserve those foundations.

Add only four state-change motions: set logged to next selection, REST band
enter, REST to READY, and atomic entry reorder. Each gets a text/state
equivalent and disappears under `prefers-reduced-motion`. Do not animate
numeric countdown ticks, use a perpetual blink, or treat an animation as
proof that a queued write reached the server.

## Prioritized findings

### UX-01, P0: the proposed UI exposes a broken superset rest contract

`Session.tsx` always starts the rest measurement after a logged round, but
shows and arms the rest strip only when no partner remains. For a normal
non-final pair, the partner condition suppresses the strip. The observed live
flow advanced from round one to round two without a visible REST scene even
though the stored rest timing had started.

Consequence: the athlete is told neither when to rest nor what is next, and a
top timer redesign would merely make this inconsistency more visible.

Acceptance: after every full non-final pair, show `REST · Next: Superset A,
round n of m`; expiry changes to READY and selects the next round. A partial
member recovery and a final planned round do not start that cue.

### UX-02, P0: plan grouping has no single contract across writers

Audit A-163 found that MCP grouping and Session adjacency can describe a
superset differently. Current Focus only accepts exactly two adjacent members;
a group with three or more silently falls back to overview.

Consequence: a coach can author a plan that looks grouped in one surface and
executes differently in another. A better pair layout cannot fix a wrong
grouping boundary.

Acceptance: validate contiguous, non-reused runs in Plan and MCP before a
group reaches Focus. Paired Focus is specifically two members; larger runs are
plainly labelled overview-only circuits until designed.

### UX-03, P0: starting, logging, and leaving a session still have uncontained failure paths

Audit A-91, A-107, and A-176 to A-180 cover a zero-row session close, a normal
set shown before it has reached the local queue, simultaneous open sessions, a
void that reappears on reload, a staged set lost on Home navigation, a stale
rest cue, and a ghost active session when its enqueue fails. These are all
direct dependencies of the planned explicit Start, Workout menu, correction,
and rest scene.

Consequence: visual confidence could mask a session that does not exist, an
input that vanished, or a record that appears to undo itself.

Acceptance: add a small integrity gate before scene work, make normal and
superset logs share a durable-local-commit boundary, prove recovery on a
controlled device, and do not call the new flow accepted until it handles
ambiguous local queue outcomes without lying about state.

### UX-04, P1: the next-workout loop is missing at both rest and completion

The observed rest state says only that nothing is scheduled today. The observed
completed card centres "View record." Neither answers the opening question:
what is next and when?

Consequence: the app is an accurate log but not yet a reliable daily training
guide.

Acceptance: both scenes identify the earliest actionable future workout and
offer the read-only Go preview. Start is only in that preview.

### UX-05, P1: load language is mathematically correct but gym-incorrect

The current kg canonical value can display as 72.3 lb. Audit A-198 also found
documented pound plate cases without complete regression coverage, and A-199
found stack/cable work receiving plate guidance.

Consequence: users cannot trust that a displayed target maps to a real bar,
dumbbell, or cable-stack decision.

Acceptance: durable authored `lb`/`kg` provenance round-trips exactly, typed
off-grid values remain accepted, equipment grids are suggestions only, and
the PWA test matrix covers 65/135/225 lb plus cable and per-side dumbbell
loads.

### UX-06, P2: several reports need present-build reproduction rather than assumption

The live queue contains warmup-skip, landscape, and repeated barbell-math
reports. Current source includes a warmup transition fix and existing plate
tests, but that is not evidence that the deployed build or a phone layout is
correct. A Dynamic Island request is not a normal web-PWA capability and needs
a native Live Activity decision rather than a simulated implementation.

Acceptance: test the shipped revision on a narrow portrait device, landscape,
and a real barbell/cable workflow. Classify Dynamic Island as deferred native
work, with a web notification/rest cue as the PWA alternative.

### UX-07, P0: active-session editing needs a different meaning from plan editing

Audit A-92, A-165, and A-166 cover historical adherence changing when a
prescription changes, a planned day disappearing under an active session, and
non-atomic section changes. The desired "Modify a set" action is therefore
unsafe if it writes a live plan while the athlete is lifting.

Acceptance: in Focus, modify the next actual load/reps/duration only. Plan
editing is a before-start flow and is refused once that day has logged work.
Reordering remains an atomic future-plan operation.

## Feedback reconciliation

| Feedback theme | Current plan disposition | Evidence needed before closure |
| --- | --- | --- |
| Full workout visibility, add set, set notes | Covered by preview, Workout menu, Finish/extra-set, and per-set note work | Phone walkthrough with no session write from preview and a persisted note readback |
| Rest transition | Covered, but blocked by UX-01 and A-178 | Pair, partial pair, final round, timer expiry, auto-rest off |
| lb/kg and 72.3 lb | Covered by authored-unit contract | Database/PWA/MCP round trip and 65/135/225 lb plate tests |
| Barbell, dumbbell, cable presentation | Covered by load-grid and load-style work | Equipment matrix, custom base/stack settings, no false plate sheet |
| Warmup skip | Not assumed fixed | Reproduce against exact deployed revision, then add regression test or close with evidence |
| Landscape layout | Not reproduced in this review | 320 px, narrow portrait, and landscape visual checks on installed PWA |
| Planned versus actual coach analysis | MCP `get_session_diff` exists in current source | Authorized MCP readback against a real completed session; do not infer user comprehension from tool presence |
| Coach-access `[object Object]` error | Separate operational bug | Capture structured error and deployment/source parity before calling it fixed |

## Existing strengths to preserve

- The core Focus hierarchy already makes the movement, load, reps, and Log
  action legible for one exercise.
- Planned-entry movement is atomic in the current model, which is the correct
  foundation for ramps and paired supersets.
- The data model distinguishes append-only logged history from future-plan
  editing, which is why an active-session swipe "delete" should not be added.
- Existing reduced-motion and tabular-number work gives the motion system a
  sound base rather than requiring a new animation framework.

## Release gates and non-goals

The training-scenes release cannot replace release-ledger work on session
recovery, deployed-revision parity, or record integrity. It should add its
specific A-91, A-92, A-107, A-163, A-165, A-166, and A-176 to A-180 gate,
then run the visual/device matrix.

Dynamic Island support, a native Live Activity, arbitrary multi-member circuit
Focus, drag-only reordering, and account-synchronised device settings are not
included in this release. Each expands platform or data-contract scope and
needs a separate decision after the paired-workout loop is trustworthy.
