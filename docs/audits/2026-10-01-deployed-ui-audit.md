# Deployed UI audit, 1 October 2026

A deeper follow-up found eight additional issues, including loss of timed duration during resume and correction. See [the deeper pass](2026-10-01-deployed-ui-audit-deeper-pass.md). The original findings and coverage boundaries below are retained.

A third pass adds three further findings, bringing the combined count to 21. See [the transition and failed-read audit](2026-10-01-deployed-ui-audit-transitions.md), including unsafe logging after a failed session read and stale note overwrite.

The main navigation and the synthetic logging flow work, but planning can silently lose an open draft. Ten findings are recorded below. This is a browser audit with explicit coverage gaps, not complete production or iPhone acceptance.

Production target: https://coltbradley.github.io/strength-tracker/. Both the public build.json and Settings identified 902266d83a51a1fccbc0a16c0c0d25b42e3ebe56, built 2026-10-01T22:58:01Z. The local checkout was older (d5e7b64), so source references below use the deployed commit, fetched from origin/main and extracted into a temporary directory. No implementation changes, commits, deployments, or production training writes were made.

Chrome on macOS was used for the live signed-in audit. Phone layout was inspected at 390×844; the synthetic editor was also inspected at 320×568 in dark mode. A desktop first-load screen was inspected, but the complete route matrix was not repeated at desktop size. Browser viewport emulation does not reproduce the iPhone keyboard, safe areas, installation, notification delivery, or WebKit storage behavior.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| UI-01 | High | Done planning silently drops an open prescription draft despite the autosave claim | Synthetic click reproduction and deployed source |
| UI-02 | Medium | Train's day links forget the date clicked | Production clicks and deployed source |
| UI-03 | Medium | Completed days advertise editing without explaining their permanent plan lock | Production controls and source lock handling; save refusal not exercised |
| UI-04 | High | Both exports omit timed duration and set RPE; CSV also drops authored load information | Production downloaded files and deployed exporter |
| UI-05 | Medium | Recent lift numbers do not identify themselves as estimated 1RM | Production rendering and source |
| UI-06 | Medium | Numeric stepper accessible names omit their current value | Production accessibility tree, synthetic changed-value check, and source |
| UI-07 | Medium | Several form fields have no associated accessible label | Production accessibility tree and source |
| UI-08 | Low | Program calls past workouts Later and past missed workouts To go | Production rendering and source filtering |
| UI-09 | Low | Exercise counts mix prescription rows, grouped entries, and movements | Production rendering and source |
| UI-10 | Low | Report still instructs users to drag buttons that are now fixed in the header | Production copy and source |

1. UI-01: Done planning drops drafts.

   Open an unused future day's editor, expand a prescription, increase its sets from four to five, then click Done planning without first collapsing the row or clicking Save planned sets. Reopen the same day: it still has four sets. There is no warning. The page explicitly says, "Everything here saves as you go."

   Reproduced using the deployed source's synthetic future-day fixture, without writing to the production account. The draft is component state; the increment only updates that state. Done planning calls navigate("/") without saving or checking the draft. This UI-only loss does not depend on the mock server accepting writes.

   Source: [draft updates](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1280-L1285), [Done planning](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1763-L1771). Fix constraint: either save the open draft successfully before leaving or present an explicit keep/discard choice. Do not promise autosave while requiring a separate row save. Acceptance: change four to five, leave through Done planning, and verify five after reopening; a failed save must keep the draft visible.

2. UI-02: Train's week links lose selection.

   On production Train, click Wednesday 30 September, marked done. Program opens with Thursday 1 October selected and the rest-day card. The person must select Wednesday again. All seven date links have the same destination, without passing the clicked date.

   Source: [week links](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/TrainHome.tsx#L368-L379). Fix constraint: carry the date into Program and consume it when selecting the week/day; preserve the user's local timezone. Acceptance: click a non-today date on Train and see that date's card and selected cell on Program, including a week boundary.

3. UI-03: Completed-day editing sets the wrong expectation.

   Production Program's completed 30 September workout offers Edit. Its editor enables prescription controls, adding exercises, removing exercises, sections, and reordering, and presents the ordinary autosave text. It gives no advance indication that a referenced day's structure is permanently locked. The lock is surfaced only by mutation error handling. The audit did not submit a mutation against that real workout.

   Source: [mutation refusal handling](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/data.ts#L502-L512), [editor mutation wrapper](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L480-L512). Fix constraint: retain database locking and preserve historical prescriptions. Expose the locked state before typing, and provide a clear path to duplicate or edit a future day. Do not disable unrelated actions merely because the day is historical. Acceptance: a completed/referenced day shows why its structure cannot change before a structural edit is attempted.

4. UI-04: Both exports lose meaningful set fields.

   Settings downloads both formats successfully. The production JSON parsed and contained 14 sessions and 148 sets; the CSV parsed with 148 data rows. Neither format contains per-set rpe or duration_seconds: the shared export SELECT never requests them. CSV additionally omits load_entry, entered_load, and entered_unit, which JSON does preserve. CSV's session_rpe is a different field and does not preserve an individual set's effort rating.

   A timed carry consequently exports reps=0 without its held seconds in either format. A reader cannot recover its duration from either archive. Authored pounds and per-side entry cannot be reconstructed reliably from CSV's total kg alone. This is an observed export-schema omission, not a claim that a new timed production set was exported in this audit. It does not alter the original server records.

   Source: [shared SELECT](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/export.ts#L63-L71), [CSV serialization](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/export.ts#L142-L200). Fix constraint: retain total-system load_kg and add the missing fields rather than reinterpreting reps or replacing canonical kg. Keep formula escaping. Acceptance: export a timed set, an RPE-rated set, and a per-side pound entry; both formats must preserve seconds and set effort, and CSV must preserve original load meaning alongside canonical kg.

5. UI-05: Record's recent numbers lack a metric label.

   Recent rows show numbers such as 162 kg next to an exercise and its latest training date, without saying what those numbers represent. Opening the exercise identifies that number as estimated 1RM (an estimate of the most weight for one repetition). The list can therefore read like the latest logged load, especially beside the date.

   Source: [recent metric cell](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L960-L972). Acceptance: the number is visibly and accessibly identified as estimated 1RM, with its relevant time basis. Preserve the compact scan and disabled pin explanation for movements without qualifying sets.

6. UI-06: Steppers do not announce their current value.

   A Plan sets control with visible "5 sets" is named only "sets value — tap to type." The accessible name remains unchanged after increasing four to five. The same pattern occurs for reps and load controls. The aria-label overrides their visible display.

   Source: [Stepper value button](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/Stepper.tsx#L116-L124). Acceptance: focus the control with assistive technology and hear its field, current value, and unit. After an increment, the current value must be available without opening the number-entry sheet. This audit inspected browser accessibility semantics; it did not run VoiceOver itself.

7. UI-07: Form labels are visual text, not associated labels.

   Report's textarea and Coach's composer have placeholders but no associated label or aria-label. Plan's scheduled-date, duplicate-date, and plan-note fields likewise appear without a named field in the accessibility tree. Check in provides an associated note label and is a useful existing pattern to retain.

   Source: [Report textarea](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/ReportBugSheet.tsx#L121-L130), [Coach textarea](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/CoachSheet.tsx#L500-L515), [Plan date](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1775-L1791), [Plan note](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1834-L1851), [duplicate date](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1903-L1926). Acceptance: each field has a stable, distinct accessible name after its placeholder disappears.

8. UI-08: Later and To go describe historical work.

   On 1 October, Later contains completed and missed workouts from August and September. The header says three To go, although those three are past missed days and there are no future planned workouts in this account. The filter includes anything outside the displayed week, in both time directions.

   Source: [outside-week filter](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Today.tsx#L847-L858), [Later heading](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Today.tsx#L1971-L1976). Acceptance: labels distinguish past/missed, upcoming, and unscheduled work without changing historical completion semantics. The defect is misleading language, not evidence that the underlying historical states are wrong.

9. UI-09: Exercise counts describe different units.

   The completed editor says Exercises 23, counting prescription rows. It contains 12 distinct movement names across 10 grouped entries. Upper body says three exercises while holding two supersets plus a standalone exercise, five movements. Ramps inflate the total, while supersets shrink section counts.

   Source: [total uses rx.length](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L984-L987). Acceptance: choose and name one counting unit consistently. If the UI says movements/exercises, count the movements; if it means prescription rows or grouped entries, name those. Preserve ramp and superset grouping for reordering.

10. UI-10: Report gives obsolete drag instructions.

    Report says, "In the way? Press and hold the buttons, then drag them anywhere." Coach and Report are now fixed header controls. FabDock no longer implements dragging.

    Source: [obsolete instruction](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/ReportBugSheet.tsx#L155-L159), [fixed header actions](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/FabDock.tsx#L107-L175). Acceptance: remove or replace the instruction with behavior the current controls actually support.

The first-read hierarchy is effective on Train and Session: date and workout context lead to one main action, and the load/reps controls remain prominent above Log. The session's prior-set receipt, next-set load cue, and explicit early-rest completion should survive revision. The principal design debt is Program and Plan: multiple long program names occupy the top of the phone screen, while row counts and historical labels make the training structure harder to scan. Shortening that heading is a usability proposal, not a functional defect.

| Surface or action | What was exercised | Result and boundary |
| --- | --- | --- |
| Production Train | Rest-day state, week links, Program/Record navigation, Check in opening | Loaded; day-link issue UI-02 |
| Production Program | Selected days, completed-day preview, calendar opening/date pick, saved-workout list opening | Loaded; UI-03, UI-08, UI-09 |
| Production Plan | Completed-day editor, opening/discarding prescription panel, reading dates and template/duplicate controls | Loaded; no real structural mutation submitted |
| Production Record | Recent list, search match/no-match, full library, logged and unlogged lift details, charts, session accordion | Loaded; UI-05 |
| Production check-ins | Check in form opening and dismissal; weekly check-in display | No answers submitted; persistence untested |
| Production Coach | Opening and dismissal, empty composer, quick prompts and attachment control inspection | No prompt sent and no file uploaded; response behavior untested |
| Production Report | Opening, diagnostics display, disabled empty submission, dismissal | No report sent; UI-07 and UI-10 |
| Production Settings | All sections inspected, training-max nested sheet, connected-app list, outbox nested sheet, version | Read paths loaded; permission, reset, sign-out, disconnect and account preference mutations not applied |
| Production outbox | Empty-queue display and disabled retry/export controls | No stuck/held/dead queue present, those states untested here |
| Production exports | JSON and CSV button clicks, downloaded file parse and collection/row counts | Both downloaded and parsed; UI-04 |
| Synthetic active session | Resume, Focus/List, plates, RPE, Log, Fix correction, skip/unskip, Finish and End, optional note/bodyweight controls | UI actions passed against the mock server; correction kept its place and displayed the changed reps |
| Synthetic alternate tracking | Session-only pounds, timed carry, tick-only set, A1/A2 alternation, two paired rounds and the remaining A1 set offered | Receipts and flow observed; not production server readback |
| Synthetic future planning | Four-to-five sets draft, Done planning, reopening | Draft dropped, UI-01 |
| Synthetic plan save | Explicit Save planned sets | Blocked by mock limitation: "supabase.rpc is not a function." Not counted as a production defect or a successful save |
| Responsive/appearance | Production phone layouts; synthetic small-phone dark editor; desktop initial Train view | No whole-document horizontal overflow in the inspected 320px editor; not a full viewport/device matrix |

Unverified work remains: production Start/Log/Finish/replay and plan-save round trips under a disposable account; timed/correction exports after production writes; goal and training-max writes; saved-workout apply/create/duplicate/delete; coach responses and uploads; notification permission/delivery; installed iPhone lifecycle, offline/auth recovery, real software keyboard, rotation, reduced-motion and VoiceOver use. No disposable production account was supplied during this pass.

An initial cached older build displayed "getCoachAccess: [object Object]" before the service worker loaded 902266d. That was not reproduced in the fresh pinned-build tab and is not counted among the ten current-build findings. A browser automation download-event wait timed out; the actual exported files were subsequently found and parsed, so the timeout is also not a product defect.

The demo's mock store is rebuilt on page reload and lacks the plan RPC implementation. Neither limitation demonstrates a production regression. Unit tests/builds were not rerun because this task changed no application behavior; the evidence is manual browser interaction, exported-file inspection, and deployed-source tracing.

Screenshots are local artifacts outside the public repository. Some production captures contain training data; nothing was published. The synthetic captures are labeled DEMO in their top corner.

| Capture | Context |
| --- | --- |
| [Completed plan controls](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/01-completed-plan-edit.jpg) | Production, enabled prescription editor |
| [Record recent list](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/02-record-recent.jpg) | Production, unlabeled estimated 1RM |
| [Record charts](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/03-record-chart.jpg) | Production, lift detail |
| [Session](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/04-demo-session.jpg) | Synthetic, 390px Focus layout |
| [Open five-set draft](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/05-demo-plan-unsaved-draft.jpg) | Synthetic, local unsaved change |
| [Small dark editor](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/06-demo-plan-320-dark.jpg) | Synthetic, 320px |
| [Program Later](/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit/07-program-past-later.jpg) | Production, historical entries |
