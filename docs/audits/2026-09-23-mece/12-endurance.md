# Group 12: Endurance sync and connected apps

## 1. Scope and evidence

**Target:** `docs/phase-1-plans` at `38e32d0`, as pinned in the audit README. Subsequent audit commits changed documentation only; the owned sync, ConnectedApps component/test, and related migrations have no path diffs from that source revision.

**Boundary:** `supabase/functions/endurance-sync/**`, `pwa/src/components/ConnectedApps.tsx` and its adjacent test, activity and credential migrations, their direct auth/database callers, and setup/deploy/roadmap claims. Read-only static review only. No tests, provider APIs, browser, deployed Supabase project, credentials, Vault values, or external services were used. The external evidence cutoff is none.

| Domain | Owner | Coverage and exclusions | Result |
| --- | --- | --- | --- |
| Sync endpoint, per-user scoping, checkpointing, and response status | Group 12 | `endurance-sync/index.ts`; static source only, no Edge runtime or database fault injection | Inspected |
| Provider normalization, paging, correction handling, retries, and timeouts | Group 12 | `providers.ts`, `normalize.ts`, adjacent tests and CI command; no provider fixtures beyond existing tests and no real API calls | Inspected |
| Activity deduplication, constraints, RLS, and credential encryption | Group 01 for shared SQL; Group 12 for sync caller | `20260907030000_activities.sql`, `20260921030000_encrypt_integration_secrets.sql`; no migration replay or production/Vault proof | Inspected; SQL fix ownership handed off where needed |
| Connected-app UI, grant revoke feedback, and timing copy | Group 12 | Component/test, `reportError`, OAuth token verifier and decision note; no live grant revocation or browser session | Inspected |
| Current product entry points and release boundary | Group 02 for future PWA transport; Group 13 for shared release/docs | PWA/MCP reference search, setup/deploy docs, Phase 5 roadmap, release ledger; no deployed-function or phone proof | Inspected; no current PWA/MCP endurance consumer found |

Commands/checks: `git status --short --branch`; `git rev-parse HEAD`; `git diff --name-only 38e32d0..HEAD -- supabase/functions/endurance-sync pwa/src/components/ConnectedApps.tsx pwa/src/components/ConnectedApps.test.tsx supabase/migrations docs/setup.md docs/deploy.md` (no paths); focused `rg` searches for endurance readers, credential writes, connected-app callers, and the prior audit leads; direct line-numbered source review. Existing tests were inspected, not run. No clean result below implies deployed behavior.

The active roadmap says Phase 5 is not started and keeps endurance product work behind trusted strength logging and operational gates (`docs/roadmaps/2026-09-19-consolidated-roadmap.md:344-372`). The findings below are current defects in the existing sync foundation; the connection, scheduling, and browser-flow gaps are separated as deferred work.

## 2. Executive summary

**11 findings:** 5 P1, 6 P2, 0 P3. There are no findings here that make the current strength-only beta depend on endurance: a focused source search found no PWA or MCP reads of `activities` or `v_weekly_endurance`, and the PWA queue comment explicitly keeps that dependency one-way (`pwa/src/lib/db.ts:62-66`).

The three largest foundation risks are silent truncation of provider history, failure to apply corrections to existing activities, and using one provider's newest activity as the other provider's checkpoint. A successful-looking response to a malformed provider payload is also a direct data-completeness risk. Phase 5 remains deferred; these do not establish a current strength-beta release blocker.

## 3. Findings

### G12-F01. Provider reads stop at the first 200 activities

**Severity:** P1. **Confidence:** high. **Existing:** A-75, still `open` in the release ledger.

**Trigger and evidence:** A backfill or poll window contains more than 200 activities. The adapters make one request with a maximum of 200 (`supabase/functions/endurance-sync/providers.ts:29-33,57-60,129-135`); `index.ts` passes the same fixed `PAGE_LIMIT` to either adapter (`supabase/functions/endurance-sync/index.ts:28-29,147-150`). Neither `Fetched` nor either adapter exposes a cursor or page loop (`providers.ts:13-17,47-105,121-186`).

**Impact:** The remaining rows are silently omitted while the provider result can still be `ok`; a long backfill can never establish complete history. This blocks the roadmap's later 12-month reconciliation gate.

**Fix boundary:** Group 12, add provider-specific pagination with an explicit total-work limit and incomplete-page status. **Verify:** fixtures spanning multiple pages for each provider, including the last/empty page and a configured cap; then reconcile a real 12-month sample before Phase 5 acceptance.

### G12-F02. Re-reading an activity cannot apply provider corrections

**Severity:** P1. **Confidence:** high. **Existing:** A-21.

**Trigger and evidence:** A provider changes a field on an activity whose `(user_id, source, external_id)` is already stored. Poll deliberately rereads a 48-hour overlap because upstream records can be edited (`supabase/functions/endurance-sync/index.ts:23-27`), but `writeActivities` uses `ignoreDuplicates: true` on that exact unique key (`index.ts:100-106`). The conflicting row is therefore left unchanged.

**Impact:** Corrected names, sport, measurements, or timestamps remain stale indefinitely when the activity stays inside the reread window. If its start time moves outside that window, polling may not retrieve it at all.

**Fix boundary:** Group 12 should persist upstream measurement corrections while preserving owner annotations such as RPE, planned-workout link, and discard state; coordinate duplicate-state recomputation with Group 01. **Verify:** replay a changed provider fixture with the same external ID and assert source-owned fields update while owner-authored fields survive.

### G12-F03. One user's newest activity is used as both providers' checkpoint

**Severity:** P1. **Confidence:** high. **Existing:** A-74, `open` in the release ledger.

**Trigger and evidence:** One provider is current while the other was disabled or unavailable and is later re-enabled. Poll selects the newest activity for the user without filtering `source` (`supabase/functions/endurance-sync/index.ts:210-220`), then passes that one `since` value to both providers (`index.ts:226-229`).

**Impact:** The lagging provider is queried only from the other provider's newest activity minus 48 hours. Its older gap is never fetched, so its history remains incomplete despite successful polls.

**Fix boundary:** Group 12, maintain an independent checkpoint/window per provider and fall back to an explicit bounded backfill for a provider without one. **Verify:** seed Intervals activity newer than a multi-week Strava gap and assert Strava's next poll covers its own gap.

### G12-F04. A checkpoint-query error is treated as an empty activity history

**Severity:** P2. **Confidence:** high. **Existing:** A-73.

**Trigger and evidence:** The checkpoint query returns a database error. The code destructures only `data` (`supabase/functions/endurance-sync/index.ts:210-217`); absent `data` then selects the default 400-day backfill window (`index.ts:218-223`).

**Impact:** The original database failure is masked and the request unexpectedly spends provider quota on a broad fetch. The returned result may look successful if the later calls work, despite the checkpoint read having failed.

**Fix boundary:** Group 12, check and report the checkpoint error and do not silently switch to the default window. **Verify:** inject a checkpoint-read error and assert no provider request is made and the response preserves the database failure.

### G12-F05. A non-array provider response becomes a successful empty sync

**Severity:** P1. **Confidence:** high. **Existing:** A-76, `open` in the release ledger.

**Trigger and evidence:** The provider returns HTTP 200 with an error object, `null`, or a changed response envelope. Both adapters convert every non-array JSON value to `[]` (`supabase/functions/endurance-sync/providers.ts:73-75,148-150`); malformed array entries missing required fields are silently skipped (`providers.ts:76-84,151-159`). The caller then writes zero rows or only the surviving subset, clears `last_error`, updates `last_sync_at`, and returns `status: "ok"` (`index.ts:151-168`).

**Impact:** A provider schema/error response is presented as a healthy, current source with no activities. The user/operator cannot distinguish an empty training period from a failed import.

**Fix boundary:** Group 12, validate the response shape and fail closed on unknown envelopes rather than treating them as no activity; surface malformed-row counts or partial failure. **Verify:** adapter fixtures for a valid empty array, an error object, `null`, and malformed array entries; only the valid empty array should report a successful empty result, and dropped rows must be visible.

### G12-F06. Provider fetches have no deadline and run serially

**Severity:** P2. **Confidence:** high. **Existing:** A-77.

**Trigger and evidence:** Either upstream request stalls. Both provider `fetch` calls omit an abort signal/deadline (`supabase/functions/endurance-sync/providers.ts:60-65,133-135`), and the endpoint awaits providers in order (`supabase/functions/endurance-sync/index.ts:226-240`).

**Impact:** A hung first provider can consume the function invocation and prevent the second provider from being attempted or a final result from being returned.

**Fix boundary:** Group 12, apply a bounded request deadline and record a timeout as that provider's failure so the other provider still runs. **Verify:** a controlled never-resolving fetch must time out within the bound, report retryable failure, and allow the second provider fixture to complete.

### G12-F07. Credential status-write errors are ignored

**Severity:** P2. **Confidence:** high. **Existing:** A-22.

**Trigger and evidence:** Activity fetch/write succeeds but updating `last_sync_at` / clearing `last_error` fails. The result of the update is ignored and the provider is returned as `ok` (`supabase/functions/endurance-sync/index.ts:152-168`). The failure path similarly ignores the `last_error` update result (`index.ts:169-180`).

**Impact:** Stored connection status can remain stale or omit the last failure while the response claims success or only reports a transient result. Once a connection UI exists, this can mislead recovery decisions.

**Fix boundary:** Group 12, treat status persistence as observable and report separately when activity rows landed but connection metadata did not. **Verify:** inject errors into each metadata update and assert the response and persisted status describe the partial outcome accurately.

### G12-F08. Request JSON is unbounded, and malformed backfill JSON starts default work

**Severity:** P2. **Confidence:** high. **Existing:** A-142.

**Trigger and evidence:** An authenticated caller submits a very large body or malformed JSON. The endpoint calls unrestricted `req.json()` (`supabase/functions/endurance-sync/index.ts:193-198`) and catches parse errors by replacing the body with `{}`. On `/backfill`, that then selects the default 400-day window (`index.ts:190-209`).

**Impact:** Parsing can consume unnecessary Edge memory/CPU, while a typo in a backfill body silently triggers provider work instead of rejecting the request. Authentication limits the caller to a signed-in user, but does not bound the request size or work.

**Fix boundary:** Group 12, bound bytes before parsing, validate content type and body shape, and distinguish an intentionally bodyless poll from malformed JSON. **Verify:** oversized input is rejected before JSON parsing; malformed backfill JSON makes no provider calls; bodyless poll remains supported.

### G12-F09. Backfill window and invocation frequency have no per-user bound

**Severity:** P2. **Confidence:** medium. **Existing:** A-157, `open` in the release ledger.

**Trigger and evidence:** A valid user repeatedly calls `/backfill` or supplies any parseable `since`. The endpoint accepts arbitrary past/future dates (`supabase/functions/endurance-sync/index.ts:203-209`) and has no per-user lock or request budget. Each call reaches both configured providers in sequence (`index.ts:226-240`). Current one-page limits cap rows per call but do not cap repeated provider requests.

**Impact:** Repeated requests can consume the connected user's provider API allowance and duplicate Edge work. The impact is bounded to that user's credentials/quotas in the inspected code; no cross-user credential path was found.

**Fix boundary:** Group 12, set an allowed backfill window, per-user concurrency/rate controls, and idempotent scheduling limits before exposing this as a user-triggered product flow. **Verify:** reject dates outside the bound and prove concurrent/repeated requests cannot exceed the configured per-user budget.

### G12-F10. A Strava 401 permanently stops this credential from syncing

**Severity:** P1. **Confidence:** high for the 401 behavior; medium for when a real token reaches it. **Existing:** A-193.

**Trigger and evidence:** Strava rejects the stored access token. The adapter returns a non-retryable reauthorization error and has no refresh-token branch (`supabase/functions/endurance-sync/providers.ts:125-145`). Setup shows a credential containing only `access_token` (`docs/setup.md:447-450`), while the original schema comment describes a Strava OAuth credential that refreshes (`supabase/migrations/20260907030000_activities.sql:212-215`).

**Impact:** If/when the access token expires or is otherwise invalidated, imports stop until an operator edits the database. There is no provider reconnect/recovery UI.

**Fix boundary:** Group 12, implement a bounded token refresh/re-authorize state with encrypted refresh fields and safe metadata persistence, or explicitly limit/remove Strava support. Group 13 should align setup instructions to the implemented credential contract. **Verify:** exercise access-token expiry, successful refresh, refresh-token rejection, and a clear user/operator recovery state using a provider sandbox or controlled fixture.

### G12-F11. Every authenticated POST path other than `/backfill` silently runs a poll

**Severity:** P2. **Confidence:** high.

**Trigger and evidence:** A caller posts to a typo or unsupported path. The mode selector maps only paths ending in `/backfill` to backfill and maps every other path to poll (`supabase/functions/endurance-sync/index.ts:190-192`); there is no route allowlist.

**Impact:** A wrong endpoint can unexpectedly call connected providers and write activities rather than return a not-found response.

**Fix boundary:** Group 12, accept only the documented `/poll` and `/backfill` paths. **Verify:** unknown paths return 404 and make no credential or provider calls.

## 4. Opportunities

### G12-O01. Build the Phase 5 provider connection and recovery flow

This is deferred work already named in the active roadmap, not a current beta defect. Provider setup currently requires SQL credential insertion and manual `curl`; disconnect is an `enabled` update or row deletion (`docs/setup.md:434-463,481-482`). `ConnectedApps` lists/revokes Supabase OAuth grants for MCP clients, not Intervals.icu or Strava provider credentials (`pwa/src/components/ConnectedApps.tsx:12-20,59-89`). A provider flow would need consent, connection state, last success/error, disable/delete semantics, and a clear distinction between removing this app's stored credential and revoking a token at the external provider. Cost is moderate to high because it changes credential lifecycle and user-visible trust. Evidence needed: complete opt-in/revoke/reconnect acceptance for each supported provider without access to another user's credentials.

### G12-O02. Add scheduled polling, retry policy, and visible status when the phase gate opens

The function returns `retryable` metadata, but no scheduled sync, retry queue, or PWA caller exists; setup documents operator-run requests only (`providers.ts:19-26`; `docs/setup.md:453-468`). The endpoint rejects `OPTIONS` and emits no CORS headers (`index.ts:31-35,184-186`), so a browser caller would also fail preflight. These are the current A-78/A-139/A-140 leads, all deferred under the roadmap's Phase 5 operational foundation. Cost includes scheduler ownership, idempotent retry/concurrency limits, browser authentication/CORS, and failure visibility. Evidence needed: a bounded two-week scheduled run with deliberate 429/5xx/timeouts, no duplicated activities, visible recovery state, and proof that no-source operation stays healthy.

### G12-O03. Preserve explicit unknown source state for any future endurance reader

The sync response distinguishes `not_connected`, `disabled`, and failure and returns 200 when no source is connected (`index.ts:67-78,127-135,242-265`). The weekly view contains only activity rows and cannot by itself distinguish an empty connected source from no connection (`20260907030000_activities.sql:236-264`). No current PWA or MCP consumer of the view was found. When a reader is added, carry source connection/freshness status beside activity data so an empty result remains UNKNOWN rather than “no runs,” as the roadmap requires (`docs/roadmaps/2026-09-19-consolidated-roadmap.md:362-364`). Cost is low to moderate depending on the read contract. Evidence needed: tests for connected-empty, disconnected, stale, partial-provider failure, and populated states.

## 5. Documentation gaps

- `pwa/src/components/ConnectedApps.tsx:9-10` promises that MCP app access stops “within the hour,” while `docs/decisions.md:29-31` records that revocation timing has not been measured. Desired claim: publish a timing only after a controlled protected-MCP-call test measures it; until then, say the grant is revoked and that the effect on already-issued tokens has not been measured. Owner: Group 12 for component copy and Group 13 for the decision note.
- `docs/setup.md:481-482` calls both disabling a row and deleting it “disconnect.” Disabling leaves `secret_enc` stored and the function skips the provider; deleting removes the stored credential row; neither path calls an external provider revoke endpoint (`index.ts:127-145`; `20260921030000_encrypt_integration_secrets.sql:109-120`). Desired claim: distinguish pause-sync, remove-the-stored-credential, and revoke-at-provider actions. Owner: Group 13, coordinated with the Phase 5 connection-flow decision.
- The Strava setup example stores only `access_token` (`docs/setup.md:447-450`), while the migration comment says a Strava OAuth triple refreshes (`20260907030000_activities.sql:212-215`) and the adapter has no refresh flow (`providers.ts:125-145`). Desired claim: make the documented credential shape and supported recovery behavior match the shipped adapter after Group 12 resolves G12-F10. Owner: Group 13.
- A-159 is fixed in the inspected code path: the later migration replaces plaintext JSON with `secret_enc` and encrypt/decrypt helpers (`20260921030000_encrypt_integration_secrets.sql:63-94,109-120`), and setup uses the encryption function (`docs/setup.md:434-450`). The release ledger says “fixed with test” but lists no production proof (`docs/roadmaps/release-ledger.md:52`). `docs/deploy.md:228-232` requires `integration_encryption_key` before migrating existing rows. Desired claim: keep production status unknown until the migration is applied and the Vault key is confirmed without exposing it. Owner: Group 13.

## 6. Handoffs

- **Group 01:** Reconcile G12-F02 correction writes with database-owned dedup state. The cross-source before-insert matcher queries then inserts without a unique cross-source constraint or serialization (`20260907030000_activities.sql:84-85,164-198`), so simultaneous syncs can both miss each other; this is A-45 and the primary fix is shared SQL. Also review the lack of cross-field checks for elapsed/moving time and average/maximum heart rate (`20260907030000_activities.sql:25-47`), the A-100 lead. This report does not count those SQL-owned issues as Group 12 findings.
- **Group 02:** When Phase 5 authorizes a PWA caller, own the client-side auth/session transport and truthful connection-status read. No current PWA call to `endurance-sync` or read of activity views exists in the searched source; no present PWA transport defect is claimed.
- **Group 13:** Reconcile release proof for migration `20260921030000` / Vault key and update the setup/deploy/decision statements listed under Documentation gaps. No live project or secret was inspected here.

## 7. Open questions and limits

- Is migration `20260921030000_encrypt_integration_secrets.sql` applied in production, and is its `integration_encryption_key` present and recoverable? Code and setup documentation are not deployment proof; no live check was authorized.
- What is the measured interval between Supabase `revokeGrant` success and a previously issued MCP access token being rejected? The current decision record says it has not been measured; no grant was revoked during this review.
- Do provider correction responses preserve the same external ID when start time, sport, or measurements change? The local adapter code is insufficient to confirm provider behavior; use sanitized fixtures or authorized provider evidence before choosing the final reconciliation key.
- Does Intervals.icu's `start_date_local` always include an explicit UTC offset? `normalize.when` documents offset-bearing ISO values (`normalize.ts:75-87`), while the adapter prefers `start_date_local` (`providers.ts:79-80`). No official provider contract or real payload was consulted, so a timezone-shift defect is not claimed.
- No browser, Edge runtime, database replay, provider sandbox, quota/rate behavior, migration application, or real user flow was tested. Existing Deno coverage is normalization-only (`normalize.test.ts:1-64`); CI likewise runs `deno test normalize.test.ts` for this function (`.github/workflows/ci.yml:77-80`).
