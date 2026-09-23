# Group 02: PWA identity and data transport

## Scope and evidence

Read `AGENTS.md`, the audit instructions, active roadmap, release ledger, and the old system audit leads. Inspected the assigned PWA identity, IndexedDB, outbox, sync, read/cache, auth, consent, service-worker, hook, screen, component, and email-template paths plus colocated tests. Evidence is static source and test inspection only. No tests were run, no browser/device or managed Supabase behavior was exercised, and no production claims are made.

## Executive summary

Confirmed findings: **1 P0, 11 P1, 3 P2**. The highest risks are a newly queued write with unknown identity being replayable under whichever account is signed in, another account's queued data being visible/exportable from the outbox, and successful-looking update replies removing session-close operations that changed no server row. The auth/cache transition races also deserve priority because they can briefly expose or clear another account's local data.

## Findings

### G02-F01. Unknown-owner writes can be replayed as the next signed-in user

- **Severity:** P0. **Confidence:** high. **Existing lead:** A-90.
- **Trigger:** A write is enqueued before `currentUser.ts` has resolved the current account. `makePendingItem` omits `user_id` for a null mirror (`pwa/src/lib/outbox.ts:376-384`), while `replayable` treats `undefined` as immediately sendable (`pwa/src/lib/outbox.ts:316-320`). A later flush leaves the payload's `user_id` to the database default, so the active account receives the row.
- **Evidence and impact:** The production identity mirror initializes asynchronously (`pwa/src/lib/currentUser.ts:26-43`). The test for unknown identity only changes identity after an item is already stamped (`pwa/src/lib/outbox.test.ts:682-715`); a separate compatibility test deliberately replays ownerless legacy rows as the current account (`pwa/src/lib/outbox.test.ts:791-815`). That misses the null-at-enqueue case. For append-only sets, misattribution cannot be corrected through the PWA.
- **Fix boundary:** Do not accept a new write until its owner is known, or durably hold it with an independently established owner. Treat pre-multi-user rows as a separate, explicit migration case.
- **Verification needed:** Test enqueue while `currentUserId()` is null, then sign in as another account and prove no transport call occurs. Test the chosen recovery path for legacy ownerless rows separately.

### G02-F02. A waiting service-worker update can reload over staged workout input

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-04.
- **Trigger:** An update becomes ready during a workout, then the user backgrounds or locks the PWA before logging the staged set fields.
- **Evidence and impact:** When refresh arrives, `main.tsx` checks the cached active-session pointer once and, if true, waits for the next `visibilitychange` to hidden before calling `applyUpdate(true)` (`pwa/src/main.tsx:98-112`). The hidden handler does not save or otherwise preserve in-memory load, reps, RPE, or note drafts. Backgrounding can therefore activate the waiting worker and reload away staged input.
- **Fix boundary:** Defer applying while a session is active, including background/lock, until staged input is durably saved or the session is no longer active.
- **Verification needed:** Exercise an update-ready transition with an active session, hide the page, and prove no reload occurs before the staged fields survive or the session closes.

### G02-F03. Initial auth resolution can overwrite a newer auth event

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-08.
- **Trigger:** `getSession()` resolves after `onAuthStateChange` has delivered a newer session.
- **Evidence and impact:** The async result unconditionally updates state when the effect is still mounted (`pwa/src/hooks/useAuth.ts:26-49`); the listener independently updates it (`pwa/src/hooks/useAuth.ts:51-59`). The cancellation flag protects only unmount, not ordering. The UI can return to the stale account or Login screen, affecting account visibility and subsequent actions. No `useAuth` test is present in the assigned tests.
- **Fix boundary:** Reconcile the initial result with auth-event ordering, for example by tracking whether an event arrived before applying it.
- **Verification needed:** A delayed `getSession()` test where a newer sign-in or sign-out event arrives first, proving the newer state remains authoritative.

### G02-F04. Cache ownership claims can race with mounting and with each other

- **Severity:** P1. **Confidence:** high. **Existing leads:** A-09, A-42.
- **Trigger:** A user transition starts `claimCacheFor` while the authenticated shell mounts or another claim starts before the first clear completes.
- **Evidence and impact:** `useAuth` publishes session state before calling the asynchronous claim (`pwa/src/hooks/useAuth.ts:44-59`), and `App` immediately renders the user-keyed shell (`pwa/src/App.tsx:202-213`). `claimCacheFor` reads the shared marker, clears the cache asynchronously, then writes the marker without serialization (`pwa/src/lib/db.ts:293-311`). A child can read the prior account's cache before the clear, or overlapping claims can clear data after the newer account loaded it. Current DB tests cover sequential claims, not interleavings (`pwa/src/lib/db.test.ts:1-25`).
- **Fix boundary:** Make account transition and cache claim one ordered boundary; do not allow account-scoped reads until the relevant claim has completed.
- **Verification needed:** Deferred-clear tests for both shell reads during account switch and two overlapping claims resolved in reverse order.

### G02-F05. Persisted-session fallback can choose a session from another Supabase project

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-158.
- **Trigger:** More than one matching Supabase auth key is present in local storage, such as after changing project or reusing an origin.
- **Evidence and impact:** `readPersistedSession` scans any `sb-*-auth-token` key and returns the first object with a user id and refresh token (`pwa/src/lib/persistedSession.ts:25-26`, `43-61`). It does not match the key's project ref to `VITE_SUPABASE_URL`, or validate issuer/audience. `useAuth` and the synchronous outbox identity mirror use this fallback on retryable refresh errors (`pwa/src/hooks/useAuth.ts:28-49`, `pwa/src/lib/currentUser.ts:29-39`). The selected id can therefore claim the local cache and stamp queued items for the wrong project identity. Tests cover malformed shape, but not multiple project keys (`pwa/src/lib/persistedSession.test.ts:41-114`).
- **Fix boundary:** Select only the configured project's storage key and validate the stored session identity against that project before using it as a local owner hint.
- **Verification needed:** Test multiple project keys in both storage orders and verify only the configured project's session is returned.

### G02-F06. Outbox inspection exposes every account's queued payload on a shared device

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-148.
- **Trigger:** A second account opens the Outbox sheet or exports the queue on the same browser/device.
- **Evidence and impact:** `inspect()` maps all outbox rows without filtering by current owner (`pwa/src/lib/outbox.ts:582-599`). The sheet displays held entries and builds an export from that same unfiltered result (`pwa/src/components/OutboxSheet.tsx:135-148`, `165-168`, `193-204`). Queue payloads can include sets, session notes and subjective records. `cacheClearAll` deliberately retains outbox rows because they may be the only copy of unsynced work (`pwa/src/lib/db.ts:215-238`).
- **Fix boundary:** Preserve every account's rows, while limiting normal inspection/export to the current user's rows and presenting foreign rows only as a count or status without payloads.
- **Verification needed:** Seed two owners' queue rows; under each identity verify only that owner's details/export are exposed and that retry/flush still holds the other owner's rows.

### G02-F07. Session updates are deleted from the outbox when PostgREST changes zero rows

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-91.
- **Trigger:** A queued session update targets a missing row or one hidden by RLS, so PostgREST returns no error but affects zero rows.
- **Evidence and impact:** The transport performs `.update(...).eq("id", id)` without requesting a row count or representation (`pwa/src/lib/sync.ts:42-47`). `doFlush` deletes any item when the transport reports `null` (`pwa/src/lib/outbox.ts:424-434`). A finish/discard decision can disappear from the only durable queue while the server session remains open.
- **Fix boundary:** Require evidence that the update affected the intended row, and classify a zero-row result as a recoverable missing/authorization condition.
- **Verification needed:** Transport test with a successful HTTP response and zero affected rows; verify the queue item remains available and visible.

### G02-F08. Cache persistence failure can replace a successful server read with stale data

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-208.
- **Trigger:** The server returns current data but `cacheSet` fails in IndexedDB.
- **Evidence and impact:** `makeFetchWithCache` wraps both the fetch and cache write in the same `try` (`pwa/src/lib/data.ts:140-160`). A cache error falls into the fetch-failure branch and returns the previous cached value, labeling it as cached/stale although the server answered successfully. This can show old plan or metric data despite a current response.
- **Fix boundary:** Keep successful server data authoritative when only persistence fails; report the cache failure separately.
- **Verification needed:** Inject a successful fetch and rejected cache write with an older cached value, and verify the returned value is the server response.

### G02-F09. An older read can repopulate a cache after a newer mutation invalidates it

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-60.
- **Trigger:** A pre-mutation server read is still pending when a plan/session mutation invalidates its cache key; the old read then completes after invalidation.
- **Evidence and impact:** Every successful `fetchWithCache` response writes directly to cache without checking whether a newer mutation happened during the request (`pwa/src/lib/data.ts:140-147`). Invalidation helpers delete the same cache families after mutations (`pwa/src/lib/data.ts:171-184` and mutation sites in `data.ts`). A late old response can persist stale data for a later offline read.
- **Fix boundary:** Associate writes with a request/mutation generation or otherwise prevent a response started before invalidation from repopulating that key.
- **Verification needed:** Hold a read response, perform a mutation and invalidate, then resolve the old response and verify it cannot become the offline cache value.

### G02-F10. Session-set fallback hides server errors and stale state

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-14.
- **Trigger:** The session-set request fails because of network, schema, or RLS error while a cache entry exists.
- **Evidence and impact:** `getServerSessionSets` catches every error and returns cached rows without reporting or marking staleness (`pwa/src/lib/data.ts:1723-1742`). If no cache exists it reports the problem and returns `[]`, which also collapses an unknown read into an empty set list. Session code can therefore act on stale or falsely empty set state, including set indexing/correction decisions.
- **Fix boundary:** Return the same explicit freshness/error distinction used by `fetchWithCache`, and keep unknown separate from an authoritative empty response.
- **Verification needed:** Cover network failure, server-side error with cache, and failure without cache; the caller must receive stale/error/unknown states and never infer an authoritative empty log.

### G02-F11. A committed enqueue can reject before the outbox starts flushing

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-206.
- **Trigger:** The IndexedDB insert succeeds, then the follow-up count/read fails.
- **Evidence and impact:** `enqueue` commits with `db.add`, then awaits `refreshCounts`, and only after that starts `flush` (`pwa/src/lib/outbox.ts:537-543`). `enqueueBatch` similarly commits its transaction before awaiting the count refresh (`pwa/src/lib/outbox.ts:545-555`). If the post-commit read fails, the caller sees rejection although its operation is durable; a retry can create a second UUID-backed operation and the queued item is not flushed by this call.
- **Fix boundary:** Separate the durable enqueue result from best-effort status refresh and ensure a committed operation still schedules replay.
- **Verification needed:** Make the post-commit count/read fail, then verify the caller gets an unambiguous committed result, only one operation is present, and flushing is scheduled.

### G02-F12. Discard reconciliation can still discard a session completed on another device

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-204.
- **Trigger:** Another device completes an old open session after `listOpen()` snapshots it but before this device's empty-session discard.
- **Evidence and impact:** `syncOpenSessions` uses the earlier open snapshot to decide to discard (`pwa/src/lib/data.ts:1531-1570`); unlike `complete`, `discard` updates by id alone and does not reassert `ended_at IS NULL` (`pwa/src/lib/data.ts:1496-1501`). The completed session can acquire `discarded_at` and disappear from live history/calendar views.
- **Fix boundary:** Make discard conditional on the session still being open and treat a zero-row result as a concurrent state change.
- **Verification needed:** Interleave completion between list and discard; verify discard does not modify the completed row.

### G02-F13. Retryable outbox failures have no bounded retry while the app stays foregrounded

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-143.
- **Trigger:** A transient error occurs while the app remains online and visible, then connectivity recovers without another `online` event or new write.
- **Evidence and impact:** A retryable failure records the error and exits the flush (`pwa/src/lib/outbox.ts:502-510`). Later triggers are startup, online, foreground, identity change, or another enqueue (`pwa/src/lib/outbox.ts:699-722`, `537-543`); there is no timed retry while visible. Training writes can remain queued until user intervention.
- **Fix boundary:** Add a bounded backoff retry or another reliable foreground retry trigger without spinning on persistent failures.
- **Verification needed:** Simulate transient failure followed by recovery without any browser event and verify a later attempt occurs with a finite schedule.

### G02-F14. OAuth consent route starts a global outbox flush before consent is shown

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-15.
- **Trigger:** A signed-in user arrives at `/oauth/consent` with pending outbox items.
- **Evidence and impact:** `main.tsx` calls `outbox.start()` during module evaluation (`pwa/src/main.tsx:10-12`), and `start()` immediately refreshes counts and flushes (`pwa/src/lib/outbox.ts:699-723`). `App.tsx` says the consent route renders without an outbox flush (`pwa/src/App.tsx:190-199`), but that route check happens after startup. Pending PWA writes may be sent while the page is asking whether to authorize an MCP client, contrary to the route's stated behavior. This path uses the user's existing PWA auth and is not evidence that the MCP client received access.
- **Fix boundary:** Align outbox startup behavior and consent-route contract, with route-aware startup if consent is meant to remain side-effect-free.
- **Verification needed:** Route-level test with pending work proving the documented behavior and that ordinary app routes still start the outbox.

### G02-F15. Bodyweight cache failure makes a durable write look rejected

- **Severity:** P2. **Confidence:** high. **Existing lead:** none found.
- **Trigger:** The bodyweight outbox insert succeeds, then its local cache read or write fails.
- **Evidence and impact:** `recordBodyweight` awaits `outbox.enqueue` and then `cacheBodyweightPoint` before returning (`pwa/src/lib/data.ts:1987-2020`). `BodyweightRow` treats any rejection as failure (`pwa/src/components/BodyweightRow.tsx:91-100`). The measurement is already durable in the queue, but the screen reports failure; a retry can enqueue a second UUID for the same weigh-in.
- **Fix boundary:** Treat post-enqueue cache maintenance as best effort or return a result that distinguishes a committed queue write from cache-refresh failure.
- **Verification needed:** Fail cache read/write after successful enqueue; confirm the UI reports one saved measurement and retry cannot duplicate it.

## Opportunities

None identified. The assigned scope is dominated by correctness and privacy defects requiring closure before optional investment.

## Documentation gaps

- `pwa/src/App.tsx:190-199` says the OAuth consent route has “no ... outbox flush,” while `pwa/src/main.tsx:10-12` starts a queue that immediately flushes before route selection. Update the implementation or narrow the comment so it describes observed behavior.
- `pwa/src/lib/outbox.test.ts:791-815` documents ownerless legacy rows as safe to replay as whichever account is current. That compatibility assumption is not safe when the same persistent queue can span accounts; document a recovery boundary or replace the assumption.

## Handoffs

- **Group 01, database:** A-205 permits delayed outbox sets to reference discarded sessions; the database/RLS boundary must decide whether inserts into discarded sessions are rejected or otherwise recoverable. The PWA can surface the server refusal but cannot enforce the cross-device parent invariant.
- **Group 03, session:** A-06 (concurrent end/discard actions), A-58 (session-scoped cache cleanup omissions), and A-107 (regular set UI updates before durable enqueue) primarily originate in session capture/finish code outside this assignment. The current session lifecycle path also uses the data-layer stale-discard race in G02-F12.
- **Group 07, MCP gateway:** Consent copy in `pwa/src/screens/OAuthConsent.tsx:112-125` describes the MCP client's write permissions. Confirm it remains aligned with the current MCP tool allowlist and identity gates; this audit only verified the local UI disclosure text and client flow.
- **Group 13, release docs:** The release ledger still lists A-143 and A-148 as open while current source continues to exhibit their underlying retry and disclosure paths. Reconcile ledger dispositions after fixes and evidence are available.

## Open questions and limits

- It is unknown whether the current deployed PWA matches this checkout; the roadmap explicitly says a successful build or publish does not prove production behavior.
- No browser, installed PWA, two-account shared-device, IndexedDB fault-injection, or deployed Supabase checks were performed.
- `getServerSessionSets` returns cached data without a stale marker, but the assigned scope does not establish every caller's exact response to an empty fallback. Call sites should be checked during remediation.
- A-06, A-58, A-107, and A-205 are handed off because their primary fixes cross the assigned boundary.
