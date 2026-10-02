# Deployed UI audit, deeper pass, 1 October 2026

Follow-up: [the third pass](2026-10-01-deployed-ui-audit-transitions.md) adds three findings and further coverage. This document retains the second pass's results and boundaries.

Eight additional findings bring the audit to 18. The most serious is a timed-set read omission that becomes lost duration in a correction payload. Failed reads also appear as empty training history. These deserve attention before treating the new UI as accepted.

This extends [the first audit](2026-10-01-deployed-ui-audit.md); it does not establish that every bug has been found. No application implementation, production training data, account settings, deployment, or connected-app permissions were changed. No coach message or report was submitted.

## Target and evidence boundaries

Production Settings again identified commit `902266d83a51a1fccbc0a16c0c0d25b42e3ebe56`, built `2026-10-01T22:58:01Z`, at https://coltbradley.github.io/strength-tracker/. Source links below are pinned to that commit, not the older workspace checkout.

Production checks used signed-in Chrome on macOS, with a verified 390×844 viewport. Write flows used the deployed source extracted to `/private/tmp/strength-ui-audit-902266d`, with its local synthetic-data mode. These are browser reproductions against synthetic data, not production database round trips or iPhone acceptance.

The temporary development mock was extended for three narrowly scoped checks: sanitized logging of set insertion fields; a documented SQLSTATE `23514` rejection for discarding a session containing sets; and one synthetic queue item owned by a different synthetic account. The application UI and data-read code were unchanged. The offline scenario already existed and simulates failed requests while the browser can remain nominally online. Reloading a fixture resets its mock server, so fixture reloads do not prove persistent server behavior. The timed resume reproduction navigated through the app without reloading the document.

Screenshots and diagnostics remain outside this public repository under `/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit`. Production screenshots can contain personal training data. The directory contains `audit-harness.patch`, `duration-boundary-trace.json`, and `nested-modal-semantics.json` for reproducibility.

## Additional findings

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| UI-16 | High, release blocker for timed-set resume/correction | Reading saved sets drops seconds; correcting a resumed timed set replaces it without its duration | Synthetic UI reproduction, insertion-boundary diagnostic, deployed source |
| UI-15 | High | Failed uncached history reads become false empty states | Existing offline fixture, repeated UI reproduction, deployed source |
| UI-18 | Medium | Train claims a discard succeeded after the server refuses it | Synthetic injected database refusal, queue inspection, deployed source |
| UI-14 | Medium | Three-member circuits trigger straight-set rest and next-set cues | Existing circuit fixture, UI clicks, deployed source |
| UI-17 | Medium | Record displays timed and done sets as zero repetitions | Synthetic finished session, deployed renderer |
| UI-13 | Medium | Most recent tonnage is labeled Last week regardless of its date | Production rendering, deployed source |
| UI-11 | Medium | Nested sheets expose both modal layers to accessibility navigation | Production accessibility tree and DOM semantics, deployed source |
| UI-12 | Low | Search the full library drops the existing search query | Production clicks, deployed source |

### UI-16: Timed duration disappears on resume and correction

Reproduction: open the `versiond` synthetic session; log Farmers Walk for 60 seconds at 10 kg per side. The receipt shows `1:00 held` and Saved. Return to Train through the workout overview, then Resume. The saved receipt now shows `0:00 held`. No document reload occurred. Open Fix on that saved set, select RPE 8, and save the correction.

The diagnostic captured the initial insertion with `duration_seconds: 60`, then the replacement insertion with duration missing and `rpe: 8`. `SET_COLUMNS` excludes `duration_seconds` from saved-set reads. The server read wins when merging rows, so the duration disappears from the hydrated set. Correction spreads that incomplete row into the replacement and voids the original. In the actual database, the nullable replacement duration would be absent/null; the original append-only row remains stored but hidden from the live log. This audit demonstrated the emitted payload and source path, not a production write or live database readback.

Source: [saved-set projection](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/data.ts#L62-L63), [read and server-first merge](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/data.ts#L1888-L1923), [replacement construction](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/corrections.ts#L29-L47), [correction enqueue](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L2418-L2428).

Evidence: `13-carry-before-home.jpg`, `14-carry-after-resume.jpg`, and the two JSON-valued entries in `duration-boundary-trace.json` (earlier entries rendered only as Object and are not used as proof). Acceptance: log a 60-second carry, verify the server seconds, resume, change only RPE, and verify the live replacement still has 60 seconds, the original index/time/rest/prescription, and the intended load. Preserve append-only correction and authored load semantics. Do not infer zero from an omitted duration. This is separate from the export omission in UI-04.

### UI-15: An unavailable history becomes an empty history

Reproduction: load the default synthetic Record list, leaving the Monday 28 September Pull session unopened. Switch to the existing offline fixture so the list comes from cache. Expand that session, which is listed with 12 sets but has no cached per-session detail. It says `No sets left in this session.` A transient error toast appears, but the persistent content asserts emptiness. Collapse and expand reproduces it.

A second path opens Bench Press from its cached recent list, which identifies eight sessions and an estimated 1RM of 90.4 kg. Uncached detail reads fail; the detail nevertheless says `No e1RM data yet`, `No volume data yet`, and `Nothing logged yet` beside the cached latest metric.

Source: [read failure returns an empty array](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/data.ts#L1903-L1911), [History consumes that array](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L389-L401), [detail failure clears loading without a persistent failure state](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L499-L505), [empty session copy](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/SessionHistory.tsx#L119).

Evidence: `11-offline-false-empty.jpg`, `12-offline-false-untrained.jpg`. Acceptance: distinguish successful zero, cached/stale data, and unavailable detail. Failed uncached reads should retain an unavailable/retry state rather than claiming no training. The synthetic server records were not erased.

### UI-18: A refused discard still looks successful

Reproduction: load the orphan fixture containing two logged sets with the audit refusal enabled. Confirm Discard with its two taps. The recovery card disappears and Train toasts `Session discarded`. At the same time, the header offers review of one failed write. Outbox correctly shows `Discard refused`, explains that the session contains sets, and disables retry for the permanent constraint refusal.

The database refusal was simulated using the exact documented constraint class; its trigger was not executed against production. Train treats successful durable queue insertion as successful server discard. History has a related success-toast path, but that separate UI path was not exercised against the injected refusal.

Source: [Train's immediate success path](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Today.tsx#L1187-L1201), [documented database refusal](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/supabase/migrations/20260924052445_discard_rejected_sessions.sql#L5-L19), [related History path](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L715-L740).

Evidence: `16-discard-false-success.jpg`, `17-discard-refused-queue.jpg`. Acceptance: distinguish queued from accepted, restore/retain recovery when refused, and preserve the database rule protecting sessions with sets. The queue's preservation and permanent-error classification passed; the surrounding screen's success claim failed.

### UI-14: Circuit fallback loses round-aware guidance

The `versiond-circuit` fixture deliberately disables Focus for a three-member group and falls back to List. That fallback is explicit and is not itself the finding. In List, log Face Pull B1 once. A two-minute rest starts and NEXT points to Face Pull set 2 while B2 Plank and B3 Farmers Walk are still untouched. Logging B2 and B3 produces the same straight-set pattern instead of rest only after the circuit round.

Source: [logging recognizes only a two-member partner](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L2075-L2112), [rest strip depends on that placement](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L2158-L2186).

Evidence: `10-circuit-rest.jpg` (desktop-sized capture), plus the click reproduction above. The source also suggests inter-station elapsed time can be recorded as ordinary rest; this was not verified by payload readback. Acceptance: either retain round-aware sequencing/rest for supported multi-member groups in List or explicitly explain the manual behavior. Avoid presenting straight-set next/rest cues as circuit guidance.

### UI-17: Record renders alternative tracking as zero reps

Finish a synthetic session with a fresh 60-second carry and a Plank done tick. Its Record session accordion displays the carry as `10 kg/side × 0 working` and the plank as `0 kg × 0 working`. There is no duration or completion label. A fresh second carry was logged after the UI-16 reproduction, so this renderer failure is independently visible for a set whose inserted duration was valid.

Source: [shared row always renders load × reps](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/SetRow.tsx#L43-L55). Evidence: `15-history-zero-reps.jpg`. Acceptance: show timed seconds and meaningful done-state copy in session and exercise history; preserve canonical zero reps in storage. Fixing the projection alone will not fix this renderer.

### UI-13: Last week is actually the latest week with volume

On production Barbell Squat detail, Thursday 1 October, the chart header reads `2,595 KG LAST WEEK`, while its latest bucket is the current week starting 28 September. The helper explicitly returns the last available volume row, not the previous calendar week. An inactive exercise can therefore label much older activity Last week as well; that second case is inferred from source.

Source: [latest available row](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L132-L135), [unconditional Last week label](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L1085-L1097). Evidence: `09-current-week-tonnage.jpg`. Acceptance: show the actual bucket date or intentionally select the previous week, including when it has no activity.

### UI-11: Both layers remain accessible inside nested sheets

Production Settings > Load step opens a number-entry sheet. The browser accessibility tree still exposes all Settings controls, including Sign out and Reset, alongside the number pad. DOM readback shows two dialogs with `aria-modal=true`, neither hidden nor inert. Only the main app root is inert. The nested Outbox sheet similarly exposes its Settings parent. Cancel restores focus to Load step, and closing Settings restores focus to its opener; those focus-return checks passed.

Source: [only root is made inert](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/Sheet.tsx#L49-L57), [shared open-sheet counter](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/Sheet.tsx#L125-L145). Evidence: `nested-modal-semantics.json`. Acceptance: expose only the top modal's controls while preserving correct focus restoration. Browser accessibility semantics were inspected; actual VoiceOver traversal remains untested.

### UI-12: The full-library handoff discards the query

Production Record search contains `squat`. Clicking Search the full library opens a blank search over all 983 exercises, including unrelated movements. Retyping squat filters it. Closing the picker retains the original Record query, so the loss is specifically the handoff into the picker.

Source: [picker initializes an empty search](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/components/ExercisePicker.tsx#L52), [History passes no query](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/History.tsx#L1307-L1318). Evidence: `19-library-search-reset.png`. Acceptance: initialize the picker with the current query and retain ordinary query clearing behavior.

## Expanded coverage and remaining gaps

| Check | Result | Boundary |
| --- | --- | --- |
| Timed log, navigation away, Resume, RPE-only correction | Failed, UI-16 | Synthetic UI and emitted insertion fields, no production write |
| Timed/done Finish and Record readback | Failed, UI-17 | Synthetic finished session |
| Three-member circuit in List | Failed guidance, UI-14 | Synthetic; notification delivery and stored circuit-rest value untested |
| Cached list plus uncached offline session/exercise detail | Failed empty-state truth, UI-15 | Failed-request fixture, not physical network disconnection |
| Offline check-in submission and queue inspection | Waiting check-in visible with reason; manual retry appropriately disabled while not dead | No reconnect/server replay proof |
| Refused nonempty discard | Queue preserved refusal, retry disabled; Train false success, UI-18 | Injected documented constraint error |
| Foreign-owner queue fixture | Held with owner explanation and age; retry disabled | Synthetic foreign owner, no real account switching |
| Sign-out and synthetic sign-in with held write | Accurate warning; held write survived and remained held | Mock auth, no real OTP delivery or token refresh |
| New empty account, unplanned start, Finish, discard | Explicit server-zero copy and two choices; discard returned to Train | Mock accepted empty discard |
| Production library search, detail/back navigation | Query retained on return; dropped on picker entry, UI-12 | Read-only |
| Production check-in week previous/next | Correct week/date changes | No check-in write |
| Production nested pad/Outbox and focus return | Focus return passed; parent exposure failed, UI-11 | No actual screen reader |
| Synthetic empty Program at 320×568, 768×1024, 1280×900 | No document horizontal overflow at verified dimensions | One empty-state route, not a complete responsive route matrix |
| Production console warnings/errors during inspected read paths | None captured in inspected log window | Absence of console errors does not establish backend health |

The synthetic Login email field also has no associated accessible label, extending UI-07. Empty Program's onboarding still refers to a floating speech-bubble button, extending UI-10's obsolete-control instructions. These are extensions of existing findings, not additional counted issues.

Still unverified: real production mutation acknowledgement and rollback; cross-device replay; expired-token offline recovery; cold-cache session bootstrap failure; actual iPhone keyboard, safe areas, install/resume and storage behavior; notification delivery with a locked phone; service-worker updates during a live workout; real coach replies and attachments; real OTP sign-in; connected-app disconnect; and a complete populated responsive route matrix. These remain coverage gaps, not claimed passes.

Recommended order: protect timed-set duration (UI-16), correct unavailable-history states (UI-15), then repair draft-save loss from the first audit (UI-01). Address export completeness (UI-04), refused-discard feedback, circuit guidance, and history rendering alongside their respective persistence checks. No fixes were made as part of this audit.
