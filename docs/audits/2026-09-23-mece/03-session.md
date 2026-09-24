# Group 03: workout capture and finish

## Scope and evidence

Read `AGENTS.md`, the MECE audit README, the active consolidated roadmap, and the release ledger. Inspected current Session and End screens, session capture components, the assigned set-entry helpers/hooks and adjacent tests, plus `data.ts` and outbox interfaces as dependencies. Old audit entries were treated as leads and checked against current source. Static inspection only; no tests or live services were run.

## Executive summary

Confirmed findings: 3 P1, 3 P2, 0 P0/P3.

The largest risks are that a normal logged set is shown before IndexedDB confirms it is queued, End can queue both a finish and a discard for one session, and prescriptions marked as time-tracked have no duration entry or write path. Other confirmed issues include losing staged values when leaving Session, duplicate added entries on a quick double tap, and a failed void-cache write allowing a queued void to be absent from Session recovery.

## Findings

### G03-F01: Normal set logging precedes the durable outbox commit

- **Severity:** P1. **Confidence:** High.
- **Trigger:** IndexedDB enqueue fails or the app is closed after LOG but before `outbox.enqueue` commits.
- **Evidence:** `Session.tsx` adds the set to `setsRef`/React state first and starts a best-effort cache write, then calls `outbox.enqueue` without awaiting it; the rejection only reports an error (`pwa/src/screens/Session.tsx:1325-1332`). The paired-round path awaits `enqueueBatch` before showing either set (`pwa/src/screens/Session.tsx:1470-1483`), demonstrating the available local commit boundary.
- **Impact:** The session can display a set as logged even though neither its cache mirror nor sole durable outbox copy exists. On reload it disappears and cannot sync. This remains A-107 and is explicitly in Phase 2 durable capture.
- **Suggested fix boundary:** Make the single-set outbox enqueue the local commit point, then update visible state/cache; preserve a clear retryable draft if enqueue fails.
- **Verification needed:** Inject enqueue failure and app interruption around the commit point; prove the UI never reports a logged set without a durable row, and a committed row survives reload and sync.

### G03-F02: Finish and discard can both be queued for one session

- **Severity:** P1. **Confidence:** High.
- **Trigger:** Tap Discard and then End (or tap Discard twice) while the first async operation is still running.
- **Evidence:** Finish has an `endingRef` re-entrancy guard (`pwa/src/screens/End.tsx:329-332`); `discard` has no matching guard and immediately enqueues `discarded_at` (`pwa/src/screens/End.tsx:426-433`). The End buttons remain enabled and do not consult an in-flight state (`pwa/src/screens/End.tsx:591-618`, `:634-645`).
- **Impact:** Both terminal updates can enter the queue. A session can finish and then be discarded, removing completed work from live views; duplicate discard can also repeat cache cleanup/navigation. This is the current A-06 race, and Phase 2 calls for terminal-state/race protection.
- **Suggested fix boundary:** Use one synchronous terminal-action lock shared by finish and discard, and expose the pending state to both controls. Database terminal-state enforcement belongs to group 01.
- **Verification needed:** Exercise rapid end/discard and duplicate-discard taps with delayed queue operations; assert one terminal update, one cleanup, and the intended final state.

### G03-F03: Time-tracked prescriptions cannot record duration

- **Severity:** P1. **Confidence:** High.
- **Trigger:** Open a prescription whose `tracking` value is `time` and attempt to log it.
- **Evidence:** `SetEditor` accepts only `tracking: "reps" | "done"` (`pwa/src/components/session/SetEditor.tsx:18-22`). The normal session insert writes load and reps, but no `duration_seconds` (`pwa/src/screens/Session.tsx:1235-1260`); the screen's tick conversion only recognizes `tracking === "done"` (`pwa/src/screens/Session.tsx:2977-2979`). The session focus test explicitly describes duration tracking as unavailable (`pwa/src/screens/Session.focus.test.tsx:259`).
- **Impact:** A prescribed hold or carry cannot be truthfully logged as a duration, despite the project contract that timed work uses `sets.duration_seconds`. Recording seconds as reps is also not a valid workaround because the database and derived views interpret reps numerically. This is a current A-106 gap against the hard rule.
- **Suggested fix boundary:** Add a duration field and write it to `duration_seconds` for time prescriptions while keeping reps zero and preserving total-load semantics; include both overview and focus/superset paths.
- **Verification needed:** Log an unloaded hold and a weighted carry, reopen the session, and verify seconds and total system load round-trip without affecting rep-based metrics.

### G03-F04: Leaving Session drops the staged set draft

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Enter load/reps/set type/RPE and navigate Home or otherwise unmount Session before logging.
- **Evidence:** Staged values are component state (`pwa/src/screens/Session.tsx:252-271`); `stagedDraftsRef` only holds an in-memory per-entry map (`:272-284`). The Session Home button navigates away (`pwa/src/screens/Session.tsx:3395-3397`), and the finish action navigates to End (`:3154-3158`). The only persistent set state is written after a set log; no staged-draft cache key is read or written in bootstrap.
- **Impact:** A nearly completed set silently disappears on navigation or eviction, requiring the lifter to re-enter it. This is the current A-179 recovery gap.
- **Suggested fix boundary:** Persist staged values per session/entry and restore them on return, or warn before leaving when the active draft differs from its prefill. Keep the saved data local and additive.
- **Verification needed:** Stage values, unmount/remount and simulate page eviction; confirm exact values restore or navigation requires an explicit choice.

### G03-F05: A quick double tap can append the same added exercise twice

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Tap Save in the set-scheme sheet again before its cache write resolves and React rerenders.
- **Evidence:** Session passes `busy={false}` to `SetSchemeSheet` (`pwa/src/screens/Session.tsx:3465-3467`); the sheet disables Save only when `busy` is true (`pwa/src/components/SetSchemeSheet.tsx:509-518`). `saveDeclared` appends to the captured `extras` array and awaits the cache write without setting a synchronous pending guard or deduplicating (`pwa/src/screens/Session.tsx:1584-1594`).
- **Impact:** Two identical extra entries can be cached, producing duplicate exercise cards and ambiguous set ownership/progress. This is the current A-12 path.
- **Suggested fix boundary:** Guard the save synchronously and reject an existing extra by exercise ID before appending.
- **Verification needed:** Delay the cache write, double tap Save, and assert one extra entry and one visible exercise row.

### G03-F06: Session recovery does not merge queued voids when its cache mirror is missing

- **Severity:** P2. **Confidence:** Medium.
- **Trigger:** The `set_voids` enqueue succeeds while writing the per-session void cache fails, then Session is reloaded before the void reaches the server.
- **Evidence:** Bootstrap reads only cached void IDs (`pwa/src/screens/Session.tsx:479-485`, `:526-530`) and filters merged sets against that cached set (`:552-559`). `voidSet` launches the cache write and outbox enqueue independently (`pwa/src/screens/Session.tsx:1792-1808`). The outbox exposes `pendingVoidIds()` (`pwa/src/lib/outbox.ts:118`, implementation at `:638`), but Session bootstrap does not consult it.
- **Impact:** The server or cached set row can reappear in the active session even though the lifter's void remains queued. The void is still pending, so this is a recovery/UI inconsistency rather than proof the server record was restored.
- **Suggested fix boundary:** Reconcile pending void IDs into bootstrap's filter before rendering, or make the local void state and queue update one durable operation.
- **Verification needed:** Force the void-cache write to fail while retaining the queued void, reload before sync, and assert the voided set stays hidden.

## Opportunities

None supported by this pass. The primary investment is closing the concrete capture and terminal-state failures above.

## Documentation gaps

The current code does not meet the repository's stated timed-set contract: `AGENTS.md` says timed work writes seconds to `sets.duration_seconds`, while `SetEditor` and Session currently expose only reps/done and omit that field. Update the code and its focused documentation together so the contract matches the shipped behavior.

## Handoffs

- **Group 01:** Database terminal-state enforcement and any one-open-session uniqueness boundary; Session/End client locks cannot protect direct PostgREST writes or simultaneous starts.
- **Group 02:** `getServerSessionSets` reads without pagination (`pwa/src/lib/data.ts:1723-1742`), so session bootstrap can treat a capped server response as complete. Verify response limits and own the data-reader fix.
- **Group 02:** Cross-device stale session close/discard and zero-row update acknowledgement live in the data/outbox reconciliation boundary; Phase 2 lists A-91/A-204/A-205 there.
- **Group 04:** Start-session double-device race begins in Today; current A-176 ownership is outside this group.

## Open questions and limits

- No browser/device run established how often navigation or storage failure occurs in practice.
- The cache/outbox asymmetry in G03-F06 is a reachable failure path by source inspection, but needs fault injection to establish exact IndexedDB transaction behavior on supported browsers.
- Static inspection cannot establish production server pagination limits or whether a second device's terminal update is observed before the next local set.
