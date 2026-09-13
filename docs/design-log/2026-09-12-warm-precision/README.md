# Warm Precision browser verification

Verified on 13 September 2026 against `npm run demo`, first with the Codex
in-app browser and then with local headless Chrome at a 390 × 844 CSS-pixel
viewport. The requested `agent-browser` CLI was not available on this host
(`command not found`), so the interaction pass used the documented browser
fallback. A Chrome DevTools Protocol pass then captured the four representative
screens below at device scale factor 2. Each capture reports a non-blank body,
the expected 390 × 844 viewport, and no framework error overlay.

## Captures

- [`train.png`](train.png): immediate workout and one Start action.
- [`loaded-focus.png`](loaded-focus.png): loaded barbell work with set progress,
  plate instruction, history, and the commit dock.
- [`bodyweight-focus.png`](bodyweight-focus.png): reps as the only hero, with no
  fake load field.
- [`superset-focus.png`](superset-focus.png): one shared round state and commit
  action for two compact members.

## What passed

| Surface or flow | Evidence |
| --- | --- |
| Train | Planned-workout hierarchy rendered with 9 movements and 30 prescribed sets after the demo-fixture additions. |
| Program and Record | Both bottom-navigation routes rendered their existing planning and history content and returned to Train. |
| Start to focus | `Start` opened Barbell Squat focus with a functional set line, load hero, reps, history, plate diagram, and log dock. |
| Logged set and rest | Logging the first squat set advanced to set 2 and exposed the 1:30 rest strip with adjust and dismiss controls. |
| More and correction | The More sheet showed plan and coach notes, completion access, logged history, correction, remove, note, type, and RPE controls. `correct set 1` opened a fully editable correction state. |
| Bodyweight movement | Hanging Leg Raise focus used reps as the hero and omitted a zero-load field. |
| Per-side movement | The demo-only Seated Dumbbell Press fixture rendered `20 kg per hand` and `EACH HAND × 2 · 40 KG TOTAL`. |
| Completion-only movement | The demo-only Plank fixture rendered one literal `DONE` action. Tapping it advanced the set line from set 1 to set 2 and started a 45-second rest strip. |
| Superset round | Romanian Deadlift plus Face Pull rendered as Superset A, round 1 of 3, with two compact members and one `Log round` action. Logging it advanced to round 2. |
| Finish and bodyweight | `Finish workout` opened End session. `Add bodyweight` exposed the bodyweight stepper. Ending the demo session returned Train to `COMPLETE` with `View record`. |

## Browser and console result

The page was non-blank, had no framework error overlay, and all checked
controls appeared in the accessibility tree. The initial run found two handled
`[getCoachAccess] Object` console errors. The mock store had omitted the
`coach_access` relation, so a normal enabled-by-default read was treated as an
unknown relation. The fix adds an empty demo-only `coach_access` table and a
fixture test. A fresh default scenario rendered normally; the in-app browser's
log API retains prior-document entries, so its two historical error records
remain visible in the log listing and are not evidence of a post-fix failure.

## Known limits

- Timed focus logging is deliberately not represented. `sets.duration_seconds`
  does not yet travel through the editor, drafts, read projection, and write
  pipeline, so seconds are not shown as repetitions.
- Assistance semantics are not inferred from an exercise name. Cable pin and
  assisted-bodyweight meanings remain outside the represented model.
- These are deterministic demo fixtures and local browser checks. They do not
  prove a production device, real network/outbox delivery, push timing, or
  human accessibility acceptance.
