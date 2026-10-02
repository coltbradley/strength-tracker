# Deployed UI audit, transitions and failed reads, 1 October 2026

This third pass found three additional issues, bringing the combined audit to 21. It also expanded timed-plan presentation evidence under existing UI-17. The highest-priority new issue is unsafe logging after an unavailable session-set read. No audit establishes that every bug has been found.

Previous reports: [first pass](2026-10-01-deployed-ui-audit.md), [deeper pass](2026-10-01-deployed-ui-audit-deeper-pass.md).

## Target and scope

Production Settings still reports `902266d83a51a1fccbc0a16c0c0d25b42e3ebe56`, built `2026-10-01T22:58:01Z`. All source links below are pinned to that deployed commit. Production navigation and completed-plan inspection were read-only. No production session, set, note, goal, account setting, permission, coach conversation, or report was written.

Write and fault cases ran through the real deployed UI source in its isolated synthetic browser harness. Only `/private/tmp/strength-ui-audit-902266d/pwa/src/dev/mockSupabase.ts` was extended. This pass added a failed `v_live_sets` read, a fixture with an older acknowledged cached note and a newer server note, and sanitized diagnostics for synthetic set indices and note read/write boundaries. The fixture's outbox starts empty. Application UI/data-read code was unchanged. No actual second phone or production database was involved.

The added instrumentation and fixtures are preserved in `audit-harness-pass3.patch`, outside the public repository. Screenshots and diagnostics are in `/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f9df-2c26-7973-b386-678bbbef88da/ui-audit`. Changes to the temporary harness caused fixture reloads while preparing tests; those preparation reloads are not reported as application defects. The Finish/Back reproductions used ordinary router navigation without a document reload.

## Findings

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| UI-19 | High, release blocker for uncached session recovery | A failed read becomes zero sets, enables Log, and emits a duplicate first-position index | Synthetic failed-read reproduction, emitted insertion fields, deployed source |
| UI-20 | Medium | Finish review followed by Back silently drops staged set values before the session is ended | Two synthetic UI reproductions and deployed navigation/state code |
| UI-21 | Medium | An acknowledged cached note overrides a newer server note and can overwrite it on Save | Synthetic stale-cache fixture, read/write/readback diagnostics, deployed merge code |

### UI-19: Failed session hydration bypasses the logging safety gate

Reproduction: start the existing `active` fixture with its three server-side Barbell Squat sets and no cached session-set list. Inject failed reads of `v_live_sets`. Open Session. A fetch-error toast appears, but the workout displays `0 of 30 sets done`, stages set 1, and keeps Log enabled. Click Log. The synthetic insertion diagnostic records `set_index: 0`, even though the fixture's existing indices are 0, 1, and 2. The UI claims the new row is Saved.

The fixture models a session whose pointer/prescriptions are on the device while its logged sets cannot be read, such as incomplete adoption/recovery or an interrupted first load. It does not claim that every normal offline resume has no cached sets.

Root cause: `getServerSessionSets` catches the failed uncached read and returns `[]`. Session's bootstrap sees a successful empty result, so its outer catch never sets `setsFailed`. The intended disabled-Log message is bypassed. The next index is then calculated from the untrustworthy empty list. The fixture's prior sets were not deleted or replaced; this creates another append-only row at a repeated position and presents incorrect progress/prefill.

Source: [empty fallback](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/data.ts#L1903-L1908), [bootstrap and unreachable safety catch for this failure](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L1008-L1052), [index calculation](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L2009-L2014).

Evidence: `23-cold-read-log-enabled.jpg`, `cold-read-insertion-trace.json`; fixture's existing sets are defined in [active scenario](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/dev/fixtures.ts#L1393-L1415). This is the logging consequence of the same shared-helper failure seen in UI-15, recorded separately because it permits an unsafe training write rather than only misleading history display. The two findings should be repaired together without counting them as independent root causes.

Working comparison: opening Finish under the same failed-read condition displays `SET COUNT UNKNOWN OFFLINE`, cannot confirm server sets, and offers no empty-session discard. [Its server-count helper throws on failure](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/lib/data.ts#L1841-L1850).

Acceptance: when the server read fails and there is no trustworthy local set list, Session must retain an unavailable state and disable Log until a trustworthy load succeeds. A failed read must not be zero. A cached resume should retain valid offline logging. Verify against a real disposable session with existing sets, including resulting indices and server readback. Preserve append-only rows, UUID idempotency, and the recovery queue.

### UI-20: Finish review discards drafts even when the person goes back

First reproduction: in `versiond`, swap Squat to Leg Press and log the first warmup. Stage the second warmup's reps from 6 to 7. Open More > Finish workout. On the End review screen, choose Back to session without ending the session. Select Leg Press again: reps have reverted to 6. The ordinary move for this exercise and its substitution survived; its staged draft did not.

Second reproduction, without substitution or reordering: in the `active` fixture, stage Barbell Squat reps from 5 to 6. Finish workout > Back to session returns to 5. No End session submission occurred in either case.

The Train exit correctly shows Unlogged set changes, and Stay in session retains the edited value. Finish instead navigates directly to `/end`. Drafts live in the Session component's refs/state and are lost when it unmounts. The End screen's own inputs deliberately survive Back, making the asymmetry especially noticeable.

Source: [component-local staged drafts](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L366-L385), [guarded Train exit](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L1963-L1971), [unguarded Finish navigation](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L3211-L3215), [Back navigation](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/End.tsx#L858-L859).

Evidence: `24-draft-before-finish.jpg`, `25-draft-after-finish-back.jpg`, `26-draft-reopened-after-finish.jpg`. Acceptance: reviewing Finish and returning preserves unlogged values and relevant selection, or the UI explicitly asks to discard before leaving Session. Merely visiting the review must not silently lose values. Logged sets remain unaffected. This is distinct from UI-01's planning draft loss.

### UI-21: Stale device notes beat successfully fetched server notes

Fixture: `sess-active-2` has server note `Newer server note`, cached session note `Older cached note`, and no queued write. Session successfully fetches the newer server text. Open Note: the editor nevertheless displays Older cached note. Click Save without changing the text. The emitted note write contains Older cached note. Navigate through Finish and Back, then read again: the mock server now returns Older cached note. This is synthetic server readback of an overwritten annotation, not a production two-device test.

Root cause: the merge is `{ ...fresh, ...prev }`, under the comment "local unsynced edits win". `prev` includes the whole acknowledged device cache, not just pending edits. The merge therefore cannot distinguish a stale saved copy from a still-unsent edit. It re-caches the stale value and initializes the editor from it.

Source: [fresh read loses to every cached note](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L1031-L1040), [save enqueues the displayed text](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Session.tsx#L2755-L2776).

Evidence: `28-stale-note-overrides-server.jpg`, `note-refresh-boundary-trace.json`. The trace includes preparation runs; the decisive sequence reads Newer server note, writes Older cached note, then reads Older cached note. Acceptance: server refresh replaces acknowledged stale notes, while actual pending local note writes retain their content and ownership. Preserve the existing editable, last-write-wins annotation model. Verify with two real disposable device sessions before claiming cross-device acceptance.

## Expanded UI-17 evidence

The existing timed fixture's Plan editor labels Farmers Walk `2 × 0` without saying Time. Opening the row shows reps controls and only Weight & reps / Just tick it off choices; neither represents its existing `tracking=time` state. There is a separately labeled Timed rest option, which controls rest rather than carry duration. No prescription mutation was submitted, and the audit does not claim that simply opening or saving an unrelated field changes tracking.

Source: [summary handles done but always formats repetitions](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1233-L1242), [two tracking controls](https://github.com/coltbradley/strength-tracker/blob/902266d83a51a1fccbc0a16c0c0d25b42e3ebe56/pwa/src/screens/Plan.tsx#L1545-L1561). Evidence: `29-timed-plan-zero-reps.jpg`. This expands UI-17's alternative-tracking presentation gap into planned work; it is not a fourth new counted finding. Existing timed work should have a truthful mode label before any decision about adding authoring controls.

## Additional checks

| Flow | Result | Boundary |
| --- | --- | --- |
| Failed uncached session hydration and Log | Failed, UI-19 | One synthetic existing session and failed-query injection |
| Same failure on End | Correct unknown count and no empty discard | Synthetic; End session not submitted |
| Change reps > overview > Back to Train > Stay | Warning appeared, draft retained | Synthetic |
| Reorder Squat down one position | Order changed, announcement present; order survived Finish/Back | Synthetic; pointer drag not exercised |
| Keyboard reorder across a protected section/superset boundary | Refused with announcement; order unchanged | Synthetic |
| Swap Squat to Leg Press before logging | Equipment changed; movement-specific load prefill used | Synthetic |
| Swap after first logged substituted set | Frozen with an explanation; name remained Leg Press after Finish/Back | Synthetic |
| Long exercise name at 320×568 | Wrapped title, accessible controls, no document/button horizontal overflow | Populated Focus, dark theme, browser viewport rather than iPhone |
| Same populated Focus at 768×1024 and 1280×900 | No document horizontal overflow | Geometry checks, not a complete route matrix |
| Goal target adjustment and Record return | 110 to 112.5 kg with matching updated percentage and list value | Synthetic |
| Dated goal removal and Undo | Two-tap warning; Undo restored 110 kg and original 2026-12-24 date | Synthetic; Undo completed inside its advertised window |
| Exercise demo entry from substituted Leg Press | Opened and dismissed its no-demo state | Fixture has no photos; real media loading remains untested |
| Production completed plan | Expanded and discarded the untouched row; returned through Done planning | No structural save submitted |

Real production mutations, acknowledgement/replay, two-device synchronization, actual iPhone behavior, notifications, service-worker update transitions, and coach/OTP delivery remain unverified. Existing mock gaps, transient browser-control deadlines, and an expired Undo test window were not counted as product defects.

Prioritize UI-19 alongside UI-15, then UI-16's timed correction integrity. UI-20 and UI-21 are further loss-of-work paths. No implementation fixes were made.
