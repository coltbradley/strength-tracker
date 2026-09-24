# Group 11: Push alerts and subscriptions

## Scope and evidence

Read `AGENTS.md`, the audit README, the active roadmap, and the release ledger. Inspected `supabase/functions/push-alerts/index.ts`, its endpoint and delivery helpers/tests, `pwa/src/lib/push.ts` and its tests, the notification settings component, `pwa/src/sw.ts`, session scheduling call sites, and the push/alert SQL migrations. Checked the old audit leads against current code and searched production PWA code for `armPrompt` and `duePrompts` call sites. No tests or live services were run; this is source evidence only. Starting checkout: `docs/phase-1-plans` at `60fbbfa8d65a775e6a528990a7d8e78958a401ef`, ahead 7 of its origin tracking ref.

## Executive summary

Confirmed: 1 P1 and 5 P2 findings. The highest risks are unbounded outbound fanout from one account, overlapping sweeps that can deliver a prompt more than once, and failed replacements that leave orphan alerts. The current provider endpoint allowlist materially fixes A-69's arbitrary-host SSRF path; provider-domain and HTTPS checks also run again at send time. The missing production prompt caller is recorded once by the Record owner as G05-F06.

## Findings

### G11-F01. One account can trigger unbounded push fanout

- **Severity:** P1. **Confidence:** High.
- **Trigger:** An authenticated account registers many distinct endpoint strings, then schedules an alert.
- **Evidence:** `subscribe` accepts a valid endpoint and upserts by endpoint, with no per-user count or rate bound (`supabase/functions/push-alerts/index.ts:225-279`). The alert send paths select every active subscription and launch all sends in one `Promise.all` (`supabase/functions/push-alerts/index.ts:436-485`, `817-874`). Each send can hold an outbound request for up to eight seconds (`supabase/functions/push-alerts/lib/push-to-endpoint.ts:27-44`). The endpoint allowlist prevents arbitrary-host SSRF, but it does not limit row count or outbound concurrency.
- **Impact:** A single authenticated user can make one alert fan out to an unbounded number of provider requests, consuming edge-function memory, connections, and execution time. The current public table policies also allow owner inserts subject only to the looser SQL shape checks (`supabase/migrations/20260905050000_push_alerts.sql:36-43`, `55-61`), so the edge route is not the only way to grow this set.
- **Existing audit/ledger:** A-156 remains open in the release ledger. A-69 is materially mitigated in current code by `isAllowedPushEndpoint` and the send-time recheck (`supabase/functions/push-alerts/lib/endpoint.ts:24-35`; `lib/push-to-endpoint.ts:23-26`); its old arbitrary-HTTPS-host claim is no longer current.
- **Fix boundary:** Bound active subscriptions per user and bound concurrent provider sends. Consider whether direct owner writes should be removed or held to the same contract.
- **Verification needed:** Add tests proving excess registrations are rejected and a large stored fanout is processed within a fixed concurrency bound; verify direct PostgREST insert/update cannot bypass the chosen limit.

### G11-F02. Rest alert delivery failure has no retry path

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Every push endpoint rejects or fails a scheduled rest send, including transient 429, 5xx, or network errors.
- **Evidence:** `deliver` stamps an error when no endpoint succeeds, without setting `sent_at` (`supabase/functions/push-alerts/index.ts:879-892`); exceptions are also stamped as errors (`index.ts:900-906`). The recovery sweep filters out `kind = 'rest'` (`index.ts:522-530`), so these open rows are never retried. The PWA reports scheduling failures silently during logging (`pwa/src/lib/push.ts:9-16`, `281-286`).
- **Impact:** The lifter can miss the closed-app rest cue after a temporary provider/network failure, with no user-visible recovery. The row remains open but has no later delivery attempt.
- **Existing audit/ledger:** A-70 remains current; it is not in the stop-release ledger.
- **Fix boundary:** Define a bounded, deadline-aware retry policy for rest alerts, with a terminal state that distinguishes expired from retryable.
- **Verification needed:** Inject a transient failure followed by success and verify one eventual push before its usefulness window closes; verify permanent failures stop retrying and are observable.

### G11-F03. Concurrent prompt sweeps can send the same alert twice

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Two authenticated sweep requests select the same due prompt before either request stamps it sent, for example an overlapping scheduled invocation and manual/retry invocation.
- **Evidence:** The sweep selects due unsent rows (`supabase/functions/push-alerts/index.ts:522-530`), loops over them (`index.ts:536-550`), and calls `sendAlertNow`, which sends externally before stamping (`index.ts:425-489`). There is no claim/lease or conditional state transition before the external push. The SQL scheduler is every five minutes and makes asynchronous `pg_net` calls (`supabase/migrations/20260907060000_alert_sweep_cron.sql:61-76`, `89-104`).
- **Impact:** A weekly or next-morning prompt can produce duplicate notifications. The comment calling the sweep idempotent describes sequential repeats only; it does not prevent concurrent sends.
- **Existing audit/ledger:** A-20 remains current as to the sweep send-then-stamp race.
- **Fix boundary:** Atomically claim due rows before delivery, using a lease or equivalent concurrency-safe state transition that recovers after a worker dies.
- **Verification needed:** Run two sweep handlers concurrently against one due row with a controlled push stub; assert only one external send and that an expired claim can be recovered.

### G11-F04. Failed replacement can leave an alert after the request returns an error

- **Severity:** P2. **Confidence:** High.
- **Trigger:** The insert succeeds, then cancelling older open alerts fails.
- **Evidence:** Both `arm` and `schedule` insert the new `rest_alerts` row before calling `cancelOpenAlerts` (`supabase/functions/push-alerts/index.ts:391-407`, `627-638`). The route catch then returns a generic 500 (`index.ts:976-983`). A prompt row remains eligible for the next sweep; a rest row remains open but no `deliver` task is started because that begins after cancellation (`index.ts:640-653`) and the sweep excludes rest rows (`index.ts:522-530`).
- **Impact:** The caller sees failure while the prompt may later arrive anyway; a rest row can remain stranded and look live in owner-visible history without a worker that will deliver it.
- **Existing audit/ledger:** A-71 remains current.
- **Fix boundary:** Make replacement and cancellation failure-safe, or compensate by cancelling the newly inserted row before returning an error.
- **Verification needed:** Force the cancellation update to fail after insert; verify a failed request leaves no deliverable prompt and no stranded live rest row.

### G11-F05. Expired prompt subscriptions can remain active after a failed revoke

- **Severity:** P2. **Confidence:** High.
- **Trigger:** A prompt push endpoint returns 404 or 410 and the follow-up subscription update fails.
- **Evidence:** The sweep send path attempts to set `revoked_at` but ignores the Supabase update result (`supabase/functions/push-alerts/index.ts:475-481`). The alert remains retryable when every endpoint fails (`index.ts:485-488`), so the dead subscription is selected and attempted on later sweeps.
- **Impact:** A dead endpoint keeps consuming outbound work, and no log or row error identifies the failed cleanup.
- **Existing audit/ledger:** A-72 remains current.
- **Fix boundary:** Check and log the revoke result, and expose a repair/monitoring signal if cleanup cannot be persisted.
- **Verification needed:** Make the revoke write fail after a 410 response; assert structured error logging and bounded repeat behavior.

### G11-F06. Rest alerts expose exercise names on the lock screen

- **Severity:** P2. **Confidence:** High.
- **Trigger:** A rest timer is armed during a workout and its push arrives while the device is locked or visible to another person.
- **Evidence:** Session labels include the exercise name and set number (`pwa/src/screens/Session.tsx:1353-1366`, `1519-1526`). The server copies that label into the push body (`supabase/functions/push-alerts/index.ts:831-841`), and the service worker displays the body verbatim (`pwa/src/sw.ts:107-130`). There is no notification privacy preference in the push settings UI (`pwa/src/components/SettingsSheet.tsx:518-615`).
- **Impact:** A shared or unattended lock screen can reveal exercise or rehabilitation context.
- **Existing audit/ledger:** A-155 remains current.
- **Fix boundary:** Use generic lock-screen copy by default, with any detailed notification content gated by an explicit preference.
- **Verification needed:** Verify default payloads do not include exercise/session identifiers; test the opt-in path and Settings copy on a locked-device acceptance run.

## Opportunities

None identified beyond the bounded fanout control in G11-F01; that is a defect, not optional investment.

## Documentation gaps

- `pwa/src/lib/push.ts:347-374` says the foreground prompt path falls back to `duePrompts`, but current production code has no call site for `duePrompts` or `armPrompt`. Update the claim when the integration is implemented, or describe the current prompt path accurately.
- The push schema comment says subscriptions are one per device (`supabase/migrations/20260905050000_push_alerts.sql:17-22`) while it enforces only endpoint uniqueness, not an active-subscription cap per user (`:23-43`). Document a bound if one is added.

## Handoffs

- **Group 01 (SQL):** Review subscription owner INSERT/UPDATE policies and alert history retention. The database currently permits owner writes with only basic shape constraints (`supabase/migrations/20260905050000_push_alerts.sql:36-61`); the push service assumes stronger endpoint validation and has no retention path for `rest_alerts`.
- **Group 02 (PWA platform/service worker):** Own notification click routing and badge lifecycle. The worker focuses/opens the root regardless of payload kind (`pwa/src/sw.ts:161-193`) and clears the app badge on click (`:165-176`); push payloads hard-code `badge: 1` (`supabase/functions/push-alerts/index.ts:450-458`, `831-841`). These are the service-worker/badge parts of A-191/A-192.
- **Group 05 (record/health capture):** Own the production call site for `duePrompts` / `armPrompt` and linkage to the relevant capture UI. Group 11 owns the push arm/delivery contract; current missing wiring is outside the push module.
- **Group 06 (shared UI/settings):** Notification permission is initialized once (`pwa/src/components/SettingsSheet.tsx:136-139`) and is not refreshed when the sheet reopens (`:144-155`); this is the stale permission-state lead A-63.
- **Group 13 (release/docs):** A-137/A-138 still need the live scheduler and operator-visibility evidence listed in the release ledger (`docs/roadmaps/release-ledger.md:38-39`). Static source cannot prove managed `pg_cron`, Vault, or `pg_net` state.

## Open questions and limits

- Provider endpoints are constrained to HTTPS and known push-service hostnames, including provider subdomains (`supabase/functions/push-alerts/lib/endpoint.ts:24-35`). The validator does not explicitly reject a non-default URL port or constrain paths. No provider endpoint corpus or managed egress test was available, so this report does not claim that this bypasses the arbitrary-host SSRF fix.
- No managed Supabase, scheduler, push gateway, browser, or locked-device behavior was exercised. Endpoint acceptance by a push gateway is not proof that the OS displayed a notification.
- Prompt scheduling is uncalled in the current source tree; prompt-denominator writes in `report_prompts` and SQL retention are handed to group 01/05 rather than reported as separate push findings.
