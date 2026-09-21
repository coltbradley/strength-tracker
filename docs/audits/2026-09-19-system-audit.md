# System audit, 2026-09-19

> Evidence backlog, not the active execution plan. Finding status must be
> re-verified against current code before work begins. Follow
> [`docs/roadmaps/2026-09-19-consolidated-roadmap.md`](../roadmaps/2026-09-19-consolidated-roadmap.md)
> for phase order and release gates.

Read-only audit of the PWA, Supabase migrations and Edge Functions, MCP/OAuth,
relay/tunnel scripts, CI/deployment, and documentation. No production code was
changed.

## Evidence and limits

- The PWA unit/component suite passed: 70 files, 854 tests.
- PWA typecheck and production build passed. The build warned that its initial
  JavaScript chunk is 745 kB minified (222 kB gzip).
- Script tests, database validation, select validation, MCP Deno tests, coach
  tests, push-alert tests, and endurance-sync tests passed in this audit.
- Passing tests prove only the paths they cover. The findings below are source
evidence and targeted execution, not a claim that every device/browser,
Supabase managed-service behavior, or third-party provider response was
exercised live.

## Triage index

This ledger contains 209 independently evidenced findings. The number is not a
severity ranking. Fix/review in this order:

| Priority | Findings | Why |
| --- | --- | --- |
| Stop release / contain | A-01, A-02, A-03, A-07, A-24 to A-26, A-49, A-69, A-74 to A-76, A-84, A-90 to A-92, A-94, A-98 to A-99, A-107, A-134 to A-141, A-143, A-148 to A-152, A-156 to A-159 | Broken MCP availability, wrong-account writes, unauthorized spend or access, malformed production deployments, permanent data loss, SSRF, uncontained credential exposure, or loss of the active training plan. |
| Protect the training record | A-04 to A-06, A-11 to A-14, A-20 to A-23, A-38 to A-46, A-58 to A-62, A-65, A-70 to A-71, A-73, A-77 to A-79, A-82 to A-83, A-85, A-93, A-100 to A-115, A-117, A-122 | Duplicate, discard, misfile, stale, silently truncate, falsely attribute, expose an offline inconsistency, or fail to recover user data. |
| Secure and operate the service | A-08 to A-10, A-15 to A-19, A-27, A-31 to A-37, A-47 to A-57, A-63 to A-64, A-66, A-68, A-72, A-80 to A-81, A-86 to A-89, A-116, A-118, A-121, A-142, A-144 to A-147, A-153 to A-155 | Identity, privacy, consent, auditability, quota, observability, documentation, availability, and input-boundary failures. |
| Product and maintenance debt | A-28 to A-30, A-50, A-67, A-95 to A-97, A-101 to A-106, A-119 to A-120, A-123 to A-133 | Phone performance, accessibility, retention, calendar semantics, health-feature completeness, and personalization gaps that degrade the product or leave promised user loops incomplete. |
| Feature deep-dive follow-through | A-160 to A-209 | Detailed per-feature findings and their own index below. Address the blocker clusters first, then complete each broken user flow end to end. |

Several findings deliberately appear in more than one concern above. The
numbered sections below are the source of truth and include exact evidence.
The separate Opportunities and efficiencies section contains 25 optional,
evidence-backed investments and is not part of the defect count.

## Release blockers and high-severity defects

### A-01. Secure MCP Tunnel can never start

`waitForRelay` waits for `OPTIONS /mcp` to return 204
([scripts/strength-tunnel-supervisor.mjs:44-59](../../scripts/strength-tunnel-supervisor.mjs)), but the relay explicitly rejects every non-POST method
with 405 ([scripts/strength-mcp-relay.mjs:115-118](../../scripts/strength-mcp-relay.mjs)). The supervisor retries without starting the tunnel. Existing tests
independently assert both incompatible contracts, so the green tests preserve
the outage. Add one integration test that starts the real relay and exercises
the supervisor readiness check.

### A-02. Any signed-up user can spend the coach-model budget when the allowlist secret is absent

When `COACH_ALLOWED_USERS` is unset, the allowlist is `null` and the request is
rejected only if that value is truthy
([supabase/functions/coach/index.ts:101-125](../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:845-852](../../supabase/functions/coach/index.ts)). Setup documentation describes that
open-by-default behavior. A public signup can therefore call `/coach` against
the deployment owner's Anthropic key. Production should fail closed unless an
explicit non-empty allowlist or an intended paid-access control is configured.

### A-03. Cross-user foreign parent references are not constrained

Rows have their own `user_id` plus independently checked parent identifiers,
but the RLS insert policies test only `user_id = auth.uid()`
([supabase/migrations/20260825120001_schema.sql:65-124](../../supabase/migrations/20260825120001_schema.sql), [supabase/migrations/20260825120002_rls.sql:40-62](../../supabase/migrations/20260825120002_rls.sql)). A user can create an own row that references another user's parent row.
This can corrupt tenant boundaries and service-role derived reads. Use composite
foreign keys or trigger validation, and test every parent-child mutation with a
foreign user's parent ID.

### A-04. Service-worker refresh can discard a live workout's staged input

Once a refresh is waiting, backgrounding the app unconditionally applies it
([pwa/src/main.tsx:98-112](../../pwa/src/main.tsx)). The session UI's staged load, reps, RPE, note, and
round drafts are memory-only ([pwa/src/screens/Session.tsx:252-265](../../pwa/src/screens/Session.tsx)).
Backgrounding a live workout can therefore reload the app and lose unlogged
input. There is no main/service-worker timing test.

### A-05. Plan navigation can show and edit the wrong workout's prescriptions

The Plan screen's reads do not carry a request generation or cancellation guard
([pwa/src/screens/Plan.tsx:260-268](../../pwa/src/screens/Plan.tsx)). Rapid navigation from
`/plan/A` to `/plan/B` can allow A's slower request to overwrite B's state.
The resulting editor can display or mutate prescriptions for the wrong day.
There are no Plan-screen or out-of-order route-response tests.

### A-06. End and discard can be queued together

`end()` has a re-entrancy ref, but `discard()` does not
([pwa/src/screens/End.tsx:248-335](../../pwa/src/screens/End.tsx)); controls remain usable during
the async operation ([pwa/src/screens/End.tsx:482-535](../../pwa/src/screens/End.tsx)). A double
tap can enqueue duplicate discard writes, while a fast end/discard sequence can
write both `ended_at` and `discarded_at`, clean up twice, and mark a discarded
planned day as done. The End test suite does not exercise action concurrency.

### A-07. Coach quota enforcement is non-atomic and fails open on usage-ledger failure

Quota is read before generation, without an atomic reservation
([supabase/functions/coach/index.ts:334-366](../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:898-967](../../supabase/functions/coach/index.ts)). Usage recording retries but a failed write does not
prevent the completed generation ([supabase/functions/coach/index.ts:624-672](../../supabase/functions/coach/index.ts)). Concurrent requests can exceed
the cap, and a usage-table outage makes spending uncounted. Add an atomic
reservation/settlement operation and concurrent/failure tests.

## Medium-severity integrity, recovery, and interaction defects

### A-08. Auth state can roll back to an older session

The initial async `getSession()` result may resolve after the auth subscription
has already received a newer event, then overwrite it
([pwa/src/hooks/useAuth.ts:28-52](../../pwa/src/hooks/useAuth.ts)). This can render the wrong account or the
Login screen. No delayed-getSession versus auth-event test exists.

### A-09. Cache ownership clears can interleave across an auth transition

Initial-session handling and auth events both launch asynchronous cache claims
without serialization ([pwa/src/hooks/useAuth.ts:14-17](../../pwa/src/hooks/useAuth.ts), [pwa/src/hooks/useAuth.ts:45-59](../../pwa/src/hooks/useAuth.ts),
[pwa/src/lib/db.ts:262-280](../../pwa/src/lib/db.ts)). A rapid account switch can let an old claim clear
newly loaded data or leave a stale owner marker. Tests cover only sequential
claims.

### A-10. Coach recovery can overwrite the user's newer turn

Interrupted-answer recovery does not mark the coach busy
([pwa/src/components/CoachSheet.tsx:143-165](../../pwa/src/components/CoachSheet.tsx)), so a user can send a
new question before recovery resolves. Both flows update the last assistant
message ([pwa/src/components/CoachSheet.tsx:149-163](../../pwa/src/components/CoachSheet.tsx), [pwa/src/components/CoachSheet.tsx:235-236](../../pwa/src/components/CoachSheet.tsx)), allowing the old answer to replace the new placeholder.

### A-11. Check-in submission has no duplicate-submit guard

The save control remains enabled while the first IndexedDB enqueue is pending
([pwa/src/components/CheckInSheet.tsx:74-91](../../pwa/src/components/CheckInSheet.tsx), [pwa/src/components/CheckInSheet.tsx:246-254](../../pwa/src/components/CheckInSheet.tsx)). Two taps produce two UUID-backed
check-ins, toasts, and memory-extraction triggers. Tests cover one click only.

### A-12. Adding a session exercise can duplicate it

The Session screen always passes `busy={false}` to the set-scheme sheet
([pwa/src/screens/Session.tsx:3051-3064](../../pwa/src/screens/Session.tsx)), whose save button uses that flag
([pwa/src/components/SetSchemeSheet.tsx:509-518](../../pwa/src/components/SetSchemeSheet.tsx)). A second tap while
the first cache write is pending can build a second entry from already-updated
state. There is no parent integration or rapid-save test.

### A-13. Today and History accept out-of-order reads

Today starts overlapping reloads without a response generation/cancellation
guard ([pwa/src/screens/Today.tsx:423-434](../../pwa/src/screens/Today.tsx), [pwa/src/screens/Today.tsx:527-535](../../pwa/src/screens/Today.tsx)); a
slower old plan/DONE read can replace a newer one. History has the same problem
for its exercise index after a void or discard
([pwa/src/screens/History.tsx:143-159](../../pwa/src/screens/History.tsx)). This can present stale actions
or charts.

### A-14. Session-set cache fallback hides server failure and stale data

`getServerSessionSets` returns cached rows for every fetch/schema/RLS failure,
without reporting it or identifying them as stale
([pwa/src/lib/data.ts:1723-1742](../../pwa/src/lib/data.ts)). This differs from the explicit
staleness contract used elsewhere in the read layer. A session can silently
show an old log after a server-side failure, which matters for set indexing and
correction decisions.

### A-15. OAuth-consent path still starts the global outbox, contrary to its safety contract

The app starts the outbox before routing ([pwa/src/main.tsx:10-12](../../pwa/src/main.tsx)), while
the consent-route comment says it renders with “no ... outbox flush”
([pwa/src/App.tsx:190-199](../../pwa/src/App.tsx)). An authenticated browser that has local queued
writes can mutate training data before the user acts on a consent prompt. Either
make the no-flush boundary real or correct the promise; test the consent route.

### A-16. Check-in memory extraction has no durable retry and can falsely appear healthy

The client ignores every non-2xx response and uses a raw fetch with no timeout
([pwa/src/lib/checkinMemory.ts:46-60](../../pwa/src/lib/checkinMemory.ts)). A quota/configuration/transient
failure has no local retry marker and is retried only after another synced
check-in. Extraction can silently never occur for the current note.

### A-17. Check-in memory claims can become permanent skips after a worker death

The server writes `memory_extracted_at` before extraction and only releases the
claim from its caught-error path ([supabase/functions/coach/index.ts:768-817](../../supabase/functions/coach/index.ts)). A termination between those steps
leaves the note claimed forever because there is no lease/expiry column in the
migration. Add a recoverable lease and a crash-between-claim-and-extract test.

### A-18. Monthly coach limits undercount usage

The quota query sums only input/output tokens, not cache tokens, and does not
aggregate or page past the API's default row limit
([supabase/functions/coach/index.ts:319-331](../../supabase/functions/coach/index.ts)). Cache usage is priced
and recorded elsewhere, so long-running or cache-heavy accounts can exceed the
intended spend cap.

### A-19. Failed coach generations bypass the daily-message limit

Failed rows are recorded as `refused`, while the daily quota excludes every
`refused` row ([supabase/functions/coach/index.ts:607-620](../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:350-356](../../supabase/functions/coach/index.ts)). Repeated model failures can
bypass the 150-message daily control and still cause provider cost.

### A-20. Push scheduling and sweeping can send duplicates

Scheduling inserts an alert before cancelling prior alerts, with no unique
constraint ([supabase/functions/push-alerts/index.ts:359-369](../../supabase/functions/push-alerts/index.ts), [supabase/functions/push-alerts/index.ts:566-576](../../supabase/functions/push-alerts/index.ts)). Two requests can both
remain open. The sweep separately selects due rows, sends the external push,
and only then stamps it sent ([supabase/functions/push-alerts/index.ts:486-510](../../supabase/functions/push-alerts/index.ts), [supabase/functions/push-alerts/index.ts:812-819](../../supabase/functions/push-alerts/index.ts)); concurrent workers can
deliver the same row twice.

### A-21. Endurance sync cannot apply upstream corrections

The sync claims overlap catches provider edits, but upserts use
`ignoreDuplicates: true` ([supabase/functions/endurance-sync/index.ts:23-27](../../supabase/functions/endurance-sync/index.ts), [supabase/functions/endurance-sync/index.ts:98-104](../../supabase/functions/endurance-sync/index.ts)). An activity renamed,
corrected, or re-uploaded under the same provider identifier stays stale
forever.

### A-22. Endurance sync reports success despite failed credential metadata writes

The post-sync update of `integration_credentials` ignores its returned error
([supabase/functions/endurance-sync/index.ts:143-160](../../supabase/functions/endurance-sync/index.ts)).
Activities may land while `last_sync_at` remains stale, causing repeated
backfills without an accurate operational signal.

### A-23. Planned-workout replacement cannot reliably self-heal after interruption

Replacement stages prescriptions at temporary `PARK` positions, deletes old
rows, then repositions them ([supabase/functions/mcp-server/tools/update_planned_workout.ts:271-305](../../supabase/functions/mcp-server/tools/update_planned_workout.ts)). An interruption after staging
leaves parked rows. Retrying can collide with their unique
`(planned_workout_id, position)` values. This needs one transactional RPC or
deterministic cleanup, plus failure-at-each-statement tests.

### A-24. CI can publish an unusable PWA when Supabase build values are invalid

The deploy job supplies `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` but
does not validate them ([.github/workflows/deploy.yml:143-162](../../.github/workflows/deploy.yml)); CI builds
without them ([.github/workflows/ci.yml:83-87](../../.github/workflows/ci.yml)), and the client uses
placeholder values rather than failing ([pwa/src/lib/supabase.ts:4-23](../../pwa/src/lib/supabase.ts)). A
typo can yield a green static deployment that cannot authenticate.

### A-25. Backend deployment can silently be skipped while Pages publishes

Missing Supabase credentials intentionally mark backend deployment off and
exit successfully ([.github/workflows/deploy.yml:81-100](../../.github/workflows/deploy.yml)); the Pages job
blocks only on failure/cancellation ([.github/workflows/deploy.yml:124-134](../../.github/workflows/deploy.yml)).
A commit that changes both layers can publish a new client against an old
schema/function set.

### A-26. CI omits coach tests despite claiming to run them

CI typechecks the coach only ([.github/workflows/ci.yml:51-56](../../.github/workflows/ci.yml)), but does not
run its memory-extraction or usage tests. Deployment documentation says those
tests are part of preflight ([docs/deploy.md:121-124](../deploy.md)).

### A-27. The seed is mutable and not reviewable from repository history

The generated exercise seed is ignored, while generation fetches a mutable
GitHub `main` URL and CI regenerates it
([.gitignore:21-22](../../.gitignore), [scripts/build-exercise-seed.mjs:9-34](../../scripts/build-exercise-seed.mjs), [.github/workflows/ci.yml:20-27](../../.github/workflows/ci.yml)).
Upstream changes or outages change validation and production data with no
reviewable repository diff. Pin a commit/checksum or commit a reviewed snapshot.

## Low-severity risks and quality debt

### A-28. The initial PWA bundle is large for the intended phone use

The production build produces one approximately 745 kB minified (222 kB gzip)
initial JavaScript chunk and Vite warns above 500 kB. Route-level lazy loading
would reduce cold-load cost, especially on weak gym connections.

### A-29. Browser, managed-Supabase, endpoint, and provider failure behavior lack integration coverage

There is no browser E2E suite. Edge-function tests concentrate on helpers,
leaving auth, HTTP contracts, database writes, provider 401/429/malformed
responses, and push delivery orchestration largely untested. Database CI uses
PGlite rather than a managed Supabase staging read-back. These gaps explain why
A-01 passed all local tests.

### A-30. Calendar semantics and midnight behavior are incomplete

Calendar `<button>` elements override their native role with `gridcell`, use
`aria-current` rather than selected-cell semantics, and have no grid keyboard
model ([pwa/src/components/CalendarSheet.tsx:93-124](../../pwa/src/components/CalendarSheet.tsx)). Its
month is initialized once ([pwa/src/components/CalendarSheet.tsx:48-50](../../pwa/src/components/CalendarSheet.tsx)),
so a sheet left open across midnight can show the prior month after Today has
advanced the selected date.

### A-31. Tunnel secrets remain exposed to same-user child-process inspection

The supervisor moves Keychain secrets into child environment variables
([scripts/strength-tunnel-supervisor.mjs:104-132](../../scripts/strength-tunnel-supervisor.mjs)). They are
protected at rest but readable by sufficiently privileged same-user diagnostic
tools/processes while the tunnel runs.

### A-32. Relay continues upstream work after its client disconnects

The relay has a timeout only until upstream headers and does not tie request or
response close events to its upstream abort controller
([scripts/strength-mcp-relay.mjs:128-146](../../scripts/strength-mcp-relay.mjs)). Abandoned streams may
continue MCP/model work and incur cost.

### A-33. Two MCP read tools are unbounded

`exercise_notes` and `memory` return all rows without a limit
([supabase/functions/mcp-server/tools/exercise_notes.ts:43-53](../../supabase/functions/mcp-server/tools/exercise_notes.ts), [supabase/functions/mcp-server/tools/memory.ts:48-60](../../supabase/functions/mcp-server/tools/memory.ts)). Over time a
response can overwhelm an MCP client or a model context.

### A-34. Test-only Vitest dependencies have known moderate vulnerabilities

`npm audit` reports two moderate findings in Vitest 3.2.7 / `@vitest/mocker`
(redirect-mock path traversal/arbitrary file read), fixed in Vitest 5. The
production dependency tree is clean under `npm audit --omit=dev`.

### A-35. CI/deploy tool versions are mutable

The deployment workflow installs `supabase/setup-cli@v1` with `version: latest`
and uses mutable action tags. A future upstream release can change deployment
behavior without a repository change. Pin exact action SHAs and a CLI version.

### A-36. Documentation is materially inconsistent with the implementation

The README and several documents still say OAuth is unbuilt, static bearer is
the only supported path, the app is single-user, and the MCP server has 12
tools ([README.md:42-47](../../README.md), [docs/architecture.md:3-24](../architecture.md),
[docs/architecture.md:105-142](../architecture.md), [supabase/functions/mcp-server/README.md:5](../../supabase/functions/mcp-server/README.md)).
The implementation supports OAuth and exposes 33 tools. `docs/plan.md` also
says the PWA has 82 tests, rather than the current 854. New users can follow
the wrong sign-in/connector path and operators have an inaccurate runbook.

## Second pass: contract, persistence, and database seams

This pass traced operational documentation into the actual runtime and then
followed data across browser, edge-function, and database boundaries. It adds
the findings below without repeating A-01 through A-36.

### A-37. Rest-alert failures are not silent and can interrupt set entry

`reportSilently` claims to suppress UI feedback but calls `reportError` without
`{ toast: false }` ([pwa/src/lib/push.ts:84-94](../../pwa/src/lib/push.ts)); the error funnel
toasts by default ([pwa/src/lib/errors.ts:308-337](../../pwa/src/lib/errors.ts)). Scheduling, cancelling,
unsubscribing, or testing a rest alert can therefore show a failure toast in
the middle of logging, contrary to the module's safety contract.

### A-38. PWA workout reorder is non-atomic and has no recovery state

The editor swaps a workout through a temporary day index in three independent
updates ([pwa/src/lib/data.ts:374-403](../../pwa/src/lib/data.ts)). A network timeout after the
first or second request leaves a workout at a synthetic index or separates its
calendar date from its ordering. The UI reports failure but does not reconcile
or repair that intermediate state. The flow document labels this an accepted
risk ([docs/flows.md:63-70](../flows.md)); it remains an integrity defect.

### A-39. Plan copy operations are multi-request and non-idempotent

Duplicate, save-template, and apply-template each create a parent workout and
then insert prescriptions in separate browser requests
([pwa/src/lib/data.ts:405-446](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:648-693](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:717-781](../../pwa/src/lib/data.ts)). A timeout after
the parent insert leaves an empty day/template; retrying mints another parent.
The product backlog already names a transactional RPC as unfinished
([docs/plan.md:260-262](../plan.md)), so this is known but still live.

### A-40. Workout/template copies silently discard prescription semantics

The copy queries and row builders omit fields added after the original copy
feature. Duplicate omits `set_type`, `section`, `tracking`, and `load_entry`
([pwa/src/lib/data.ts:432-443](../../pwa/src/lib/data.ts)); saving a template omits
`superset_group`, `section`, `tracking`, and `load_entry`
([pwa/src/lib/data.ts:674-690](../../pwa/src/lib/data.ts)); applying a template omits
`section` and `tracking` ([pwa/src/lib/data.ts:730-778](../../pwa/src/lib/data.ts)). Database defaults
make the operation succeed while changing the workout, for example a tick-only
or per-side prescription becomes an ordinary tracked/total-load one.

### A-41. First template use always creates a duplicate empty day

When no confirmed program exists, `useTemplate` calls `createPlannedWorkout`
for the selected date merely to create a program, then calls `applyTemplate`
for the same date ([pwa/src/screens/Today.tsx:815-845](../../pwa/src/screens/Today.tsx)). There is no
unique program/date constraint. The seed row remains an empty draft beside the
real template workout, producing an extra calendar item on the first use.

### A-42. A new user can briefly see the previous user's cache

`useAuth` sets the new session state before starting the asynchronous
`claimCacheFor` clear ([pwa/src/hooks/useAuth.ts:45-59](../../pwa/src/hooks/useAuth.ts)); App immediately mounts
a new Shell for that user ([pwa/src/App.tsx:202-213](../../pwa/src/App.tsx)). Child effects can read
the prior user's IndexedDB plan, active session, and coach thread before the
clear completes. This is a cross-account privacy race, distinct from the
cache-claim ordering issue in A-09.

### A-43. An invalid user timezone can break timezone-dependent views

Authenticated users can write arbitrary `user_config.tz`, and `app_tz()`
returns it without validation ([supabase/migrations/20260827180000_multi_user.sql:17-44](../../supabase/migrations/20260827180000_multi_user.sql)). Views pass that value to
`AT TIME ZONE` ([supabase/migrations/20260827180000_multi_user.sql:60-65](../../supabase/migrations/20260827180000_multi_user.sql)). A value such as `not-a-timezone`
raises PostgreSQL `22023`, self-denying plan/metric reads and potentially
breaking service-role MCP reads for that user.

### A-44. Training-plan phase overlap enforcement is raceable

The trigger checks for an overlap with an unlocked query and explicitly notes
the missing lock ([supabase/migrations/20260905060000_training_plans.sql:118-151](../../supabase/migrations/20260905060000_training_plans.sql)). Two concurrent inserts can both
see no conflicting committed row, then commit overlapping phases. Direct
authenticated phase insert/update policies make the race reachable
([supabase/migrations/20260905060000_training_plans.sql:187-193](../../supabase/migrations/20260905060000_training_plans.sql)).

### A-45. Cross-source activity deduplication is raceable

The before-insert trigger queries for a prior matching activity, but the
matching index is non-unique and no claim/lock is taken
([supabase/migrations/20260907030000_activities.sql:80-85](../../supabase/migrations/20260907030000_activities.sql), [supabase/migrations/20260907030000_activities.sql:164-198](../../supabase/migrations/20260907030000_activities.sql)). Concurrent
Strava and Intervals imports for one effort can both remain live and
double-count endurance volume.

### A-46. Cycle-screening referral boundaries use database UTC, not user time

Cycle screening calculates elapsed days with `current_date`
([supabase/migrations/20260907040000_subjective_capture.sql:562-584](../../supabase/migrations/20260907040000_subjective_capture.sql)), despite the rest of the app using
`app_tz(user_id)` for calendar semantics. Around UTC midnight, a non-UTC user
can be screened or referred one local day early or late.

### A-47. The `exercises.updated_by` audit field is forgeable

Custom exercise owners have a broad update policy
([supabase/migrations/20260827180000_multi_user.sql:186-195](../../supabase/migrations/20260827180000_multi_user.sql)), and the audit trigger preserves
a caller-supplied `updated_by` value when it differs from the old one
([supabase/migrations/20260905020000_exercise_name_bounds.sql:109-120](../../supabase/migrations/20260905020000_exercise_name_bounds.sql)). A client can claim another
user or null as editor. This field cannot serve as reliable audit evidence.

### A-48. `coach_enabled` remains executable by anonymous callers despite its revoke

The migration revokes execute from `anon` but leaves the default `PUBLIC`
grant intact ([supabase/migrations/20260907020000_coach_access.sql:75-94](../../supabase/migrations/20260907020000_coach_access.sql)). PostgreSQL's PUBLIC grant still
permits the call. The invoker/RLS design prevents disclosure of another user's
switch, so this is hardening/documentation drift rather than a data leak.

### A-49. Numeric checks permit PostgreSQL `NaN`, poisoning aggregates

Constraints such as `value_kg > 0` and `load_kg >= 0` accept PostgreSQL
`numeric 'NaN'`; in PostgreSQL, `NaN` compares greater than ordinary numbers.
Affected owner-writable measurements include training maxes, goals, sets,
bodyweight, and activities ([supabase/migrations/20260825120001_schema.sql:32-51](../../supabase/migrations/20260825120001_schema.sql),
[supabase/migrations/20260825120001_schema.sql:109-124](../../supabase/migrations/20260825120001_schema.sql), [supabase/migrations/20260906020000_bodyweight_log.sql:14-21](../../supabase/migrations/20260906020000_bodyweight_log.sql),
[supabase/migrations/20260907030000_activities.sql:25-40](../../supabase/migrations/20260907030000_activities.sql)). One accepted NaN can contaminate e1RM, volume,
or health displays. Existing range tests do not cover special numeric values.

### A-50. Push and prompt history has no retention policy

`rest_alerts` retains sent/cancelled/error rows and has only an open-row index
([supabase/migrations/20260905050000_push_alerts.sql:95-126](../../supabase/migrations/20260905050000_push_alerts.sql)); the sweep stamps old rows instead
of archiving/deleting them ([supabase/functions/push-alerts/index.ts:481-511](../../supabase/functions/push-alerts/index.ts)). `report_prompts` also has no
cleanup path ([supabase/migrations/20260907040000_subjective_capture.sql:382-401](../../supabase/migrations/20260907040000_subjective_capture.sql)). This creates indefinite
storage/index growth and unnecessary retention of health-prompt history.

### A-51. OAuth consent omits material destructive permissions

The consent UI says a connected app can write plans, goals, training maxes, and
notes ([pwa/src/screens/OAuthConsent.tsx:118-120](../../pwa/src/screens/OAuthConsent.tsx)), but the registered MCP surface also
includes deleting confirmed programs and mutating/deleting exercises
([supabase/functions/mcp-server/lib/handler.ts:81-103](../../supabase/functions/mcp-server/lib/handler.ts), [supabase/functions/mcp-server/tools/delete_program.ts:23-93](../../supabase/functions/mcp-server/tools/delete_program.ts)). A user cannot
give informed consent to authority the screen does not disclose.

### A-52. OAuth connector setup omits mandatory hosted-project configuration

The setup guide tells users to connect with OAuth but omits enabling the hosted
OAuth server and dynamic client registration
([docs/setup.md:185-203](../setup.md)). The decision log says both are separate required
dashboard toggles ([docs/decisions.md:14-17](../decisions.md)); without registration,
discovery lacks `registration_endpoint` and connector registration returns 403.
`supabase/config.toml` proves only a local mirror setting.

### A-53. The deployment guide omits PWA runtime variables

The runbook lists only three Supabase deployment settings
([docs/deploy.md:434-448](../deploy.md)), but the Pages build also needs
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
([.github/workflows/deploy.yml:147-150](../../.github/workflows/deploy.yml)). Their absence produces the
broken-but-green deployment in A-24. This is a separate operator runbook
failure.

### A-54. Login documentation contradicts the deployed code-only flow

Setup still says the email template should include both an OTP and a link and
tells users to use a magic link ([docs/setup.md:65-68](../setup.md), [docs/setup.md:349](../setup.md)). The
deployed template/config and UI are code-only
([supabase/templates/magic_link.html:1-6](../../supabase/templates/magic_link.html), [supabase/config.toml:24-32](../../supabase/config.toml), [pwa/src/screens/Login.tsx:84-95](../../pwa/src/screens/Login.tsx)). Operators can configure an
installed-PWA-hostile sign-in path by following the documentation.

### A-55. Confirmed-program deletion relies on an unenforced chat convention

Security documentation says explicit user approval protects confirmed programs
([docs/security.md:50-63](../security.md)). The resource server only checks whether the
caller supplies `confirm_delete_confirmed=true`, not independently recorded
approval ([supabase/functions/mcp-server/tools/delete_program.ts:30-93](../../supabase/functions/mcp-server/tools/delete_program.ts)). A stolen bearer or compromised MCP client can
remove a confirmed active plan, despite the stated boundary.

### A-56. Migration safety documentation understates destructive changes

The deployment guide says automatic migration is safe because migrations are
append-only and contain no destructive statement
([docs/deploy.md:454-461](../deploy.md)). A migration explicitly drops three RLS policies
([supabase/migrations/20260905010000_drop_hard_delete_policies.sql:26-27](../../supabase/migrations/20260905010000_drop_hard_delete_policies.sql), [supabase/migrations/20260905010000_drop_hard_delete_policies.sql:67](../../supabase/migrations/20260905010000_drop_hard_delete_policies.sql)). The policy changes are intended,
but a runbook that calls them non-destructive weakens change review.

### A-57. Security documentation falsely says the repository has no IDs/emails

`docs/security.md` claims the repository contains no project references, user
IDs, or emails ([docs/security.md:20-21](../security.md)), but `supabase/config.toml`
contains the deployed Pages URL and an AgentMail address in a comment
([supabase/config.toml:9-12](../../supabase/config.toml), [supabase/config.toml:49-53](../../supabase/config.toml)). This
is not a secret exposure, but it makes the repository-hygiene threat model
unreliable.

### A-58. Automatic session reconciliation leaves sensitive per-session cache data behind

Session substitutions are persisted under a per-session key
([pwa/src/screens/Session.tsx:1666-1669](../../pwa/src/screens/Session.tsx)). Manual close clears most
session keys but omits swaps and rating-skip state
([pwa/src/screens/End.tsx:300-315](../../pwa/src/screens/End.tsx)); overnight reconciliation clears
only closed-session families, never session-scoped keys
([pwa/src/lib/data.ts:1522-1584](../../pwa/src/lib/data.ts)). Sets, notes, drafts, rest state, and
substitutions can therefore accumulate indefinitely after auto-close/discard.

### A-59. The readiness sheet can write yesterday's state into a new day after midnight

Today passes a changing local date into `CheckInSheet`
([pwa/src/screens/Today.tsx:1768-1773](../../pwa/src/screens/Today.tsx)); the component updates its row identity and
panel only if a new-date row exists ([pwa/src/components/CheckInSheet.tsx:102-124](../../pwa/src/components/CheckInSheet.tsx)). With no row, its next write
uses the old ID/panel with the new date ([pwa/src/components/CheckInSheet.tsx:129-148](../../pwa/src/components/CheckInSheet.tsx)). Keeping the sheet open across
midnight can display stale answers, update the wrong logical row, or hit the
one-row-per-date constraint.

### A-60. Old successful reads can repopulate a cache after it is invalidated

`fetchWithCache` writes every successful response directly to IndexedDB without
a request generation/mutation epoch check
([pwa/src/lib/data.ts:140-162](../../pwa/src/lib/data.ts)). Plan mutations invalidate those same keys
([pwa/src/lib/data.ts:362-378](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:473-484](../../pwa/src/lib/data.ts)). A slow pre-mutation request can
finish after a fresh request and persist stale data for later offline use.

### A-61. Wake-lock state can become stale across a visibility race

An in-flight wake-lock request stores its sentinel once it resolves
([pwa/src/hooks/useWakeLock.ts:74-96](../../pwa/src/hooks/useWakeLock.ts)), but a hide handler may already
have released/cleared it ([pwa/src/hooks/useWakeLock.ts:100-113](../../pwa/src/hooks/useWakeLock.ts)). A late
resolution stores a now-invalid sentinel. On return to foreground, acquisition
is skipped and the screen can sleep during a rest timer.

### A-62. A stopped coach stream can corrupt the next turn

Stream callbacks patch whichever assistant message is currently last
([pwa/src/components/CoachSheet.tsx:235-274](../../pwa/src/components/CoachSheet.tsx)). Stop aborts and immediately
allows another turn ([pwa/src/components/CoachSheet.tsx:312-328](../../pwa/src/components/CoachSheet.tsx)), while buffered SSE blocks are
parsed without a signal check ([pwa/src/lib/coach.ts:130-170](../../pwa/src/lib/coach.ts)). A delayed old
chunk/done event can append to or complete the new turn.

### A-63. Notification settings can display a stale permission state

Settings reads `Notification.permission` once during initialization and refreshes
only the subscription state on later opens
([pwa/src/components/SettingsSheet.tsx:136-155](../../pwa/src/components/SettingsSheet.tsx)). A user who changes browser/OS
permission outside the app can reopen settings and see the old ON/OFF/BLOCKED
state.

### A-64. Readiness writes bypass the project's UUID fallback

`CheckInSheet` calls `crypto.randomUUID()` directly
([pwa/src/components/CheckInSheet.tsx:129](../../pwa/src/components/CheckInSheet.tsx), [pwa/src/components/CheckInSheet.tsx:183](../../pwa/src/components/CheckInSheet.tsx)), even though
`pwa/src/lib/uuid.ts` supplies a fallback for contexts without that API. On
older or non-secure browser contexts, a readiness save/skip can throw and lose
the answer.

### A-65. Set correction treats harmless display rounding as a real change

`isNoopCorrection` compares kilogram loads with exact IEEE-754 equality
([pwa/src/lib/corrections.ts:52-58](../../pwa/src/lib/corrections.ts)). In pound and per-side entry modes, the UI can round a stored total such as 6.35 kg to a displayed
per-side value and calculate 6.36 kg when it is re-entered. The unresolved
roadmap reproduces that exact case ([docs/superpowers/plans/2026-09-04-gaps-roadmap.md:245-252](../superpowers/plans/2026-09-04-gaps-roadmap.md)). Saving without a meaningful user change appends a replacement set and voids the original, permanently polluting history and volume.

### A-66. OAuth tokens are not bound to this MCP resource or a permission scope

The OAuth verifier accepts a token solely when its unverified payload has
`sub`, `role: authenticated`, and any `client_id`, then asks Supabase only
whether it belongs to the same user
([supabase/functions/mcp-server/lib/oauth.ts:57-65](../../supabase/functions/mcp-server/lib/oauth.ts), [supabase/functions/mcp-server/lib/oauth.ts:106-151](../../supabase/functions/mcp-server/lib/oauth.ts)). It never requires an audience/resource indicator for this MCP server or checks a scope. The product specification calls audience binding a high-risk OAuth requirement
([docs/spec.md:127-133](../spec.md)). This makes the MCP server accept any current or future Supabase-issued bearer that carries those general claims, rather than only a credential explicitly issued for this resource. The practical exposure depends on the issuer's other OAuth clients, but the resource-server boundary is absent and untested.

### A-67. The session-ending UI presents one person's injury as a universal prompt

The note chips include a literal `"Left shoulder"`
([pwa/src/screens/End.tsx:44-49](../../pwa/src/screens/End.tsx)). The earlier audit documentation identifies it as the deployment owner's body and specifies per-user injury facts instead
([docs/superpowers/plans/2026-09-04-gaps-roadmap.md:305-316](../superpowers/plans/2026-09-04-gaps-roadmap.md)). Other users are nudged to record an irrelevant medical symptom, contaminating the qualitative record the coach reads.

### A-68. A failed cross-device set-note read disappears without telemetry

Session bootstrap requests notes written on another device but ends the promise
chain with `.catch(() => undefined)`
([pwa/src/screens/Session.tsx:529-541](../../pwa/src/screens/Session.tsx)). A failed request leaves the user with stale or absent notes and creates neither a visible recovery state nor an error record. The prior audit explicitly called for reporting this rejection
([docs/superpowers/plans/2026-09-04-gaps-roadmap.md:254-263](../superpowers/plans/2026-09-04-gaps-roadmap.md)).

### A-69. Push subscription registration creates an authenticated SSRF primitive

Subscription validation accepts any HTTPS endpoint
([supabase/functions/push-alerts/index.ts:215-227](../../supabase/functions/push-alerts/index.ts)), then the Edge Function POSTs encrypted payloads to that URL from the
server ([supabase/functions/push-alerts/index.ts:430-435](../../supabase/functions/push-alerts/index.ts), [supabase/functions/push-alerts/index.ts:763-767](../../supabase/functions/push-alerts/index.ts)). An authenticated account can therefore direct Supabase outbound traffic to arbitrary public hosts and, where the runtime network permits it, internal HTTPS services. Validate Web Push provider origins or otherwise explicitly contain outbound destinations.

### A-70. A transient rest-alert delivery failure is terminal

`deliver` records every all-device failure as an error
([supabase/functions/push-alerts/index.ts:785-805](../../supabase/functions/push-alerts/index.ts)), while the recovery sweep explicitly excludes the `rest` kind
([supabase/functions/push-alerts/index.ts:486-492](../../supabase/functions/push-alerts/index.ts)). A momentary 429, 5xx, or network failure therefore has no retry path, unlike prompt alerts, and the lifter silently misses the timer alert.

### A-71. Failed alert replacement leaves a live orphan that can fire later

Both `arm` and `schedule` create the new row before cancelling prior open rows
([supabase/functions/push-alerts/index.ts:359-374](../../supabase/functions/push-alerts/index.ts), [supabase/functions/push-alerts/index.ts:566-592](../../supabase/functions/push-alerts/index.ts)). If cancellation fails, the endpoint returns an error but the new live row remains. A prompt can later fire despite the user seeing a failure; an unsent rest row is neither delivered nor swept. This is the failure-path counterpart to the duplicate race in A-20.

### A-72. Dead push subscriptions can survive forever when cleanup fails

Sweep delivery sees 404/410 and attempts to revoke the subscription, but
discards the update result
([supabase/functions/push-alerts/index.ts:430-441](../../supabase/functions/push-alerts/index.ts)). If the write fails, the dead endpoint remains active and is retried by every later sweep with no log, metric, or repair state.

### A-73. An endurance checkpoint-query failure silently becomes a costly backfill

Polling destructures only `data` from the newest-activity query
([supabase/functions/endurance-sync/index.ts:202-208](../../supabase/functions/endurance-sync/index.ts)). A database/RLS failure is treated as an empty history and changes the window to a 400-day provider fetch
([supabase/functions/endurance-sync/index.ts:209-213](../../supabase/functions/endurance-sync/index.ts)), without exposing the original failure. That increases provider load and can report a misleadingly successful sync.

### A-74. One cross-provider endurance checkpoint loses lagging-provider history

The poll chooses one `since` timestamp from the newest activity of any source
([supabase/functions/endurance-sync/index.ts:202-213](../../supabase/functions/endurance-sync/index.ts)) and submits that same window to each provider
([supabase/functions/endurance-sync/index.ts:216-219](../../supabase/functions/endurance-sync/index.ts), [supabase/functions/endurance-sync/index.ts:135-143](../../supabase/functions/endurance-sync/index.ts)). If Intervals is current but Strava has been disconnected for weeks, Strava is queried only for the 48-hour overlap. Its earlier missing activities are never fetched. This is distinct from A-21, which concerns edits to rows already imported.

### A-75. Endurance backfills silently stop after the first provider page

Intervals and Strava each make one request capped at 200 rows, with no cursor or
pagination loop ([supabase/functions/endurance-sync/providers.ts:57-75](../../supabase/functions/endurance-sync/providers.ts), [supabase/functions/endurance-sync/providers.ts:129-150](../../supabase/functions/endurance-sync/providers.ts)). A 400-day backfill or high-volume gap reports success while dropping every activity beyond that first page.

### A-76. Invalid successful provider payloads are recorded as an empty sync

Both adapters turn every non-array JSON response into an empty list
([supabase/functions/endurance-sync/providers.ts:73-75](../../supabase/functions/endurance-sync/providers.ts), [supabase/functions/endurance-sync/providers.ts:148-150](../../supabase/functions/endurance-sync/providers.ts)). The caller then clears `last_error` and stamps `last_sync_at`
([supabase/functions/endurance-sync/index.ts:143-152](../../supabase/functions/endurance-sync/index.ts)). An upstream 200 error object or schema change can thus hide data loss behind a healthy status.

### A-77. Provider fetches have no timeout and run serially

The two provider adapters use unrestricted `fetch` calls
([supabase/functions/endurance-sync/providers.ts:60-65](../../supabase/functions/endurance-sync/providers.ts), [supabase/functions/endurance-sync/providers.ts:133-135](../../supabase/functions/endurance-sync/providers.ts)); the request invokes providers one after another
([supabase/functions/endurance-sync/index.ts:215-219](../../supabase/functions/endurance-sync/index.ts)). One hung upstream can consume the Edge runtime and prevent the other provider from syncing.

### A-78. Retryable endurance-provider failures never schedule a retry

The adapters classify 429 and 5xx failures as retryable
([supabase/functions/endurance-sync/providers.ts:66-71](../../supabase/functions/endurance-sync/providers.ts), [supabase/functions/endurance-sync/providers.ts:141-146](../../supabase/functions/endurance-sync/providers.ts)), and the result carries that flag
([supabase/functions/endurance-sync/index.ts:161-172](../../supabase/functions/endurance-sync/index.ts)). Nothing consumes it for backoff, a durable retry, or a scheduled poll. Recovery therefore depends on a later client/manual request.

### A-79. A partial check-in-memory failure can insert duplicate standing facts

Extraction inserts new facts before it stamps its source check-ins
([supabase/functions/coach/memory-extract.ts:542-566](../../supabase/functions/coach/memory-extract.ts)). If the stamp fails, the outer handler releases the claim for retry
([supabase/functions/coach/index.ts:793-808](../../supabase/functions/coach/index.ts)). `coach_memory` has no natural-key uniqueness constraint
([supabase/migrations/20260831100000_coach_memory.sql:15-36](../../supabase/migrations/20260831100000_coach_memory.sql)), so the next run re-inserts the same fact. This is distinct from A-17's crash-leased source notes: it is an ordinary partial-commit duplication path.

### A-80. Standing-memory growth is unbounded and is injected into every coach request

The schema has no per-user row or active-fact limit
([supabase/migrations/20260831100000_coach_memory.sql:15-36](../../supabase/migrations/20260831100000_coach_memory.sql)). Both extractors read all prior facts into their prompt
([supabase/functions/coach/memory-extract.ts:500-511](../../supabase/functions/coach/memory-extract.ts), [supabase/functions/coach/memory-extract.ts:680-695](../../supabase/functions/coach/memory-extract.ts)); the PWA also injects all of them into every chat context
([pwa/src/lib/coachContext.ts:248-254](../../pwa/src/lib/coachContext.ts), [pwa/src/lib/coachContext.ts:379-387](../../pwa/src/lib/coachContext.ts)). Repeated extraction drift or user-created facts can increase latency, cost, and eventually context failure without a pruning or summarization policy.

### A-81. Coach context silently treats a failed memory read as no constraints or injuries

`standingFacts` ignores the Supabase `error` field and returns `[]` whenever no
data is returned ([pwa/src/lib/coachContext.ts:244-257](../../pwa/src/lib/coachContext.ts)). A failed query therefore makes the coach act as though the user has no known injuries, equipment limits, or preferences, with neither an operator signal nor an incomplete-context indication.

### A-82. Concurrent MCP filing can create multiple programs for one phase

`upsert_program` reads for a live program under a phase and inserts one if none
exists ([supabase/functions/mcp-server/tools/upsert_program.ts:333-360](../../supabase/functions/mcp-server/tools/upsert_program.ts)). `programs.phase_id` has only a non-unique index
([supabase/migrations/20260905060000_training_plans.sql:153-168](../../supabase/migrations/20260905060000_training_plans.sql)). Two retries/concurrent calls can both observe absence and create calendar plans for the same phase. Later calls select the newest one, leaving a duplicate live plan. This is a different writer and invariant from A-39's browser template-copy failure.

### A-83. Same-name MCP upserts can leave duplicate unconfirmed programs

The tool reads unconfirmed same-name programs, inserts the replacement, and
only then discards old candidates
([supabase/functions/mcp-server/tools/upsert_program.ts:372-411](../../supabase/functions/mcp-server/tools/upsert_program.ts), [supabase/functions/mcp-server/tools/upsert_program.ts:471-489](../../supabase/functions/mcp-server/tools/upsert_program.ts)). Concurrent parses can each insert a new program and discard only the older observed row. No uniqueness rule or transaction prevents both new programs remaining live.

### A-84. Training-plan replacement can leave the user without a valid live plan

`set_training_plan` separately reads, supersedes the prior plan, inserts the
new plan, and inserts phases, then attempts compensation with independent
requests ([supabase/functions/mcp-server/tools/training_plan.ts:522-620](../../supabase/functions/mcp-server/tools/training_plan.ts)). Concurrent calls or a mid-sequence failure can supersede the old plan without completing the replacement; failed restoration is merely logged. This is distinct from A-44's phase-overlap race, because the top-level plan lifecycle itself has no transaction.

### A-85. `get_volume` can silently return a partial history

The tool allows up to 104 weeks and multiple exercises but always imposes a
1,000-row limit ([supabase/functions/mcp-server/tools/get_volume.ts:108-115](../../supabase/functions/mcp-server/tools/get_volume.ts)). Its response reports only returned-row count, not truncation
([supabase/functions/mcp-server/tools/get_volume.ts:117-134](../../supabase/functions/mcp-server/tools/get_volume.ts)). A high-volume training history can therefore be presented as complete while older/weaker volume rows were omitted.

### A-86. MCP parses unbounded request bodies before schema validation

After authentication, the handler calls `req.json()` on the whole request with
no content-length, streamed-byte, or parser limit
([supabase/functions/mcp-server/lib/handler.ts:227-236](../../supabase/functions/mcp-server/lib/handler.ts)). Field schemas run only afterward, and not every nested text field has a maximum. An authenticated caller can consume Edge memory/CPU before rejection. This is request-side denial-of-service exposure, not A-33's unbounded response reads.

### A-87. Feedback payloads and stored feedback are unbounded

`submit_feedback` accepts unrestricted `detail` and `context` strings
([supabase/functions/mcp-server/tools/feedback.ts:66-77](../../supabase/functions/mcp-server/tools/feedback.ts)); their database columns have no length limit
([supabase/migrations/20260831030000_feedback.sql:10-24](../../supabase/migrations/20260831030000_feedback.sql)). A client can create oversized rows that increase storage and later inflate feedback listings.

### A-88. MCP exercise edits lose the actor from the audit trail

The exercise-audit migration expects service-role MCP calls to supply the
token's user as `updated_by`
([supabase/migrations/20260905020000_exercise_name_bounds.sql:103-108](../../supabase/migrations/20260905020000_exercise_name_bounds.sql)). `update_exercise` sends only the mutable fields
([supabase/functions/mcp-server/tools/manage_exercises.ts:264-277](../../supabase/functions/mcp-server/tools/manage_exercises.ts)), so the service-role path has no `auth.uid()` and records a null actor. This is distinct from A-47: direct PWA callers can forge an actor, whereas valid MCP writes omit one entirely.

### A-89. Whitespace-only MCP input escapes validation and fails as a database error

Several tool schemas allow a string of spaces through `.min(1)`, while the
database rejects `length(trim(...)) = 0`: exercise names
([supabase/functions/mcp-server/tools/manage_exercises.ts:101-103](../../supabase/functions/mcp-server/tools/manage_exercises.ts), [supabase/migrations/20260905020000_exercise_name_bounds.sql:35-49](../../supabase/migrations/20260905020000_exercise_name_bounds.sql)), training-plan names/objectives
([supabase/functions/mcp-server/tools/training_plan.ts:35-40](../../supabase/functions/mcp-server/tools/training_plan.ts), [supabase/functions/mcp-server/tools/training_plan.ts:448-452](../../supabase/functions/mcp-server/tools/training_plan.ts)), and feedback titles
([supabase/functions/mcp-server/tools/feedback.ts:58-61](../../supabase/functions/mcp-server/tools/feedback.ts), [supabase/migrations/20260831030000_feedback.sql:10-24](../../supabase/migrations/20260831030000_feedback.sql)). The user receives an opaque persistence failure instead of an actionable validation response.

### A-90. A write queued before auth initialization can be attributed to the wrong account

The outbox creates an item from the synchronous identity mirror
([pwa/src/lib/outbox.ts:535-549](../../pwa/src/lib/outbox.ts)), but when that mirror is temporarily null,
`makePendingItem` omits `user_id` and `replayable` treats the resulting undefined
owner as safe to send ([pwa/src/lib/outbox.ts:313-316](../../pwa/src/lib/outbox.ts), [pwa/src/lib/outbox.ts:373-381](../../pwa/src/lib/outbox.ts)). This directly contradicts the nearby contract that unknown identity must hold the item to avoid permanent misattribution
([pwa/src/lib/outbox.ts:299-311](../../pwa/src/lib/outbox.ts)). A set queued during boot can therefore flush under whichever authenticated session becomes active next. The existing test changes identity only after an item was stamped, so it misses the null-at-enqueue case.

### A-91. A session close can be removed from the queue after updating zero server rows

The update transport calls `.update(...).eq("id", id)` and calls it successful
whenever PostgREST reports no error, without asking for or checking an affected
row ([pwa/src/lib/sync.ts:45-50](../../pwa/src/lib/sync.ts)). If the parent session insert died, the row was already removed, or RLS hides it, `ended_at`/`discarded_at` is deleted from IndexedDB as synced even though nothing changed. The server can retain an open session and lose the user's close decision.

### A-92. Editing a prescription rewrites historical adherence

`v_adherence` compares each historical set to its current mutable prescription
row ([supabase/migrations/20260825120003_views.sql:72-100](../../supabase/migrations/20260825120003_views.sql)). The PWA directly updates those prescriptions
([pwa/src/lib/data.ts:473-484](../../pwa/src/lib/data.ts)). There is no snapshot of the prescribed reps, load, set type, section, or load-entry convention at log time. Changing a future plan can thus change a past set from hit to miss (or vice versa), defeating adherence as historical evidence.

### A-93. The claimed per-exercise set-index invariant is not enforced by the database

Session code derives the next index from what it currently sees
([pwa/src/screens/Session.tsx:1135-1138](../../pwa/src/screens/Session.tsx)), while the schema permits only a UUID primary key and no unique `(session_id, exercise_id, set_index)` tuple
([supabase/migrations/20260825120001_schema.sql:109-135](../../supabase/migrations/20260825120001_schema.sql)). Two tabs, devices, or stale offline views can create distinct rows both called set 1. Corrections and history then have no unambiguous ordinal record.

### A-94. Answered health prompts are never marked answered

`report_prompts` has `responded_at` for prompt adherence
([supabase/migrations/20260907040000_subjective_capture.sql:382-401](../../supabase/migrations/20260907040000_subjective_capture.sql)), but the client writes a prompt only when it is skipped
([pwa/src/components/CheckInSheet.tsx:176-194](../../pwa/src/components/CheckInSheet.tsx)). A completed check-in inserts only a `checkins` row
([pwa/src/components/CheckInSheet.tsx:74-91](../../pwa/src/components/CheckInSheet.tsx)); it neither links to nor updates the prompt. Any adherence metric therefore labels completed prompts as unanswered.

### A-95. The health-prompt engine is not connected to production flow

`duePrompts` contains detailed daily, weekly OSTRC, and next-morning logic
([pwa/src/lib/prompts.ts:118-225](../../pwa/src/lib/prompts.ts)), but production code never calls it, and no application flow invokes the available prompt arming path. The planned weekly and follow-up prompts are consequently not created or delivered, despite the subjective-capture schema and feature documentation. Unit tests prove pure date logic, not an end-to-end prompt.

### A-96. The approved check-in redesign remains unimplemented

The redesign requires tags, episode linkage, training impact, pain follow-up,
new views, and a new sheet
([docs/superpowers/specs/2026-09-16-checkin-redesign-design.md:36-88](../superpowers/specs/2026-09-16-checkin-redesign-design.md), [docs/superpowers/plans/2026-09-16-checkin-redesign.md:5-59](../superpowers/plans/2026-09-16-checkin-redesign.md)). The migration directory stops before its planned migration, while the current sheet still offers a free-text/energy check-in and the old readiness panel
([pwa/src/components/CheckInSheet.tsx:65-100](../../pwa/src/components/CheckInSheet.tsx), [pwa/src/components/CheckInSheet.tsx:120-194](../../pwa/src/components/CheckInSheet.tsx)). Pain episodes and their effect on training are therefore reduced to unstructured text or not captured at all.

### A-97. Users cannot review their own check-in history

The approved design requires a week grid and check-in detail
([docs/superpowers/specs/2026-09-16-checkin-redesign-design.md:232-278](../superpowers/specs/2026-09-16-checkin-redesign-design.md)), but History loads only exercise/set/session information and never queries check-ins
([pwa/src/screens/History.tsx:100-390](../../pwa/src/screens/History.tsx)). Captured wellbeing and symptom information has no user-facing review surface, making it difficult to correct, recognize trends, or assess what the coach used.

### A-98. The advertised export is neither a full account archive nor a complete set record

The export calls itself the whole training record but fetches only non-discarded
sessions, live sets, set notes, and exercise names
([pwa/src/lib/export.ts:1-12](../../pwa/src/lib/export.ts), [pwa/src/lib/export.ts:93-136](../../pwa/src/lib/export.ts)). It excludes plans, prescriptions, training maxes, goals, bodyweight logs, check-ins, subjective data, activities, coach memory, prompts, voided sets, and discarded sessions. Even for exported sets, `rpe` and `duration_seconds` are absent from the JSON and CSV shapes, and CSV omits `load_entry`
([pwa/src/lib/export.ts:29-65](../../pwa/src/lib/export.ts), [pwa/src/lib/export.ts:139-195](../../pwa/src/lib/export.ts)). The Settings UI's `SESSIONS + SETS` label accurately narrows it
([pwa/src/components/SettingsSheet.tsx:428-449](../../pwa/src/components/SettingsSheet.tsx)), but the implementation cannot provide a recoverable account archive or preserve all set semantics in CSV.

### A-99. Same-day readiness edits from an unreadable second device dead-letter

`daily_readiness` is unique by `(user_id, local_date)`
([supabase/migrations/20260907040000_subjective_capture.sql:18-58](../../supabase/migrations/20260907040000_subjective_capture.sql)). A read failure produces no existing row, so the sheet generates a new UUID
([pwa/src/lib/checkins.ts:62-85](../../pwa/src/lib/checkins.ts), [pwa/src/components/CheckInSheet.tsx:126-141](../../pwa/src/components/CheckInSheet.tsx)); the outbox then uses `id` rather than the natural date key as its conflict target
([pwa/src/lib/sync.ts:28-43](../../pwa/src/lib/sync.ts)). The second device's correction is rejected and dead-lettered instead of merging the same day.

### A-100. Endurance activity fields can contradict one another

The activity schema validates independent ranges but not cross-field facts
([supabase/migrations/20260907030000_activities.sql:25-46](../../supabase/migrations/20260907030000_activities.sql)). It accepts moving time longer than elapsed time, average heart rate above maximum, and an RPE timestamp without an RPE (or the converse). The normalizer bounds values independently rather than enforcing these relationships
([supabase/functions/endurance-sync/normalize.ts:60-99](../../supabase/functions/endurance-sync/normalize.ts)). Weekly summaries and coaching context can contain physically or semantically impossible activity records.

### A-101. Custom readiness values bypass their own field definitions

`daily_readiness.custom` accepts unrestricted JSONB
([supabase/migrations/20260907040000_subjective_capture.sql:49-51](../../supabase/migrations/20260907040000_subjective_capture.sql)), while `readiness_fields` separately defines keys, kinds, and numeric bounds
([supabase/migrations/20260907040000_subjective_capture.sql:96-113](../../supabase/migrations/20260907040000_subjective_capture.sql)). No FK, trigger, or app validation connects them. Malformed, out-of-range, or unknown values can enter data intended for charting and coach context.

### A-102. Red-flag referral timestamps can form an impossible chronology

The table stores report, referral, and acknowledgement timestamps, but constrains
only whether a flag is set
([supabase/migrations/20260907040000_subjective_capture.sql:347-363](../../supabase/migrations/20260907040000_subjective_capture.sql)). It accepts acknowledgement before referral or referral before report. Editable rows then cannot provide a reliable escalation record.

### A-103. A planned day can be converted into a template without semantic safeguards

Generic owner-update permissions permit changing planned-workout fields, while
the template migration only enforces that a template has no date
([supabase/migrations/20260831020000_workout_templates.sql:14-27](../../supabase/migrations/20260831020000_workout_templates.sql)). Nothing prevents a trained or session-referenced day becoming a template. The template-delete path can then hard-delete the plan object and cascade prescriptions
([pwa/src/lib/data.ts:784-793](../../pwa/src/lib/data.ts)), making the distinction between reusable template and historical plan unsafe.

### A-104. Activity duplicate links are not constrained to the same owner

`activities.duplicate_of` is only a foreign key to another activity
([supabase/migrations/20260907030000_activities.sql:48-64](../../supabase/migrations/20260907030000_activities.sql)). It does not require the target to have the same `user_id`, source, or ownership. The normal sync trigger chooses a same-user candidate, but service-role writes and future code have no database guard against cross-user provenance corruption.

### A-105. Skipped session exercises disappear from the record at finish

Skipping updates only React state and a per-session cache
([pwa/src/screens/Session.tsx:1616-1629](../../pwa/src/screens/Session.tsx)); no `session_skips` table or outbox operation exists
([pwa/src/lib/db.ts:39-84](../../pwa/src/lib/db.ts)). Finishing clears the cache
([pwa/src/screens/End.tsx:300-313](../../pwa/src/screens/End.tsx)). The approved adaptation design calls for durable skip rows and reasons
([docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:146-173](../superpowers/specs/2026-09-16-live-session-adaptation-design.md)). History and the coach cannot distinguish skipped from unattempted work.

### A-106. Time-tracked prescriptions cannot be logged as duration

The schema supports `tracking = time` and `sets.duration_seconds`
([supabase/migrations/20260906030000_tracking_time.sql:25-47](../../supabase/migrations/20260906030000_tracking_time.sql)), but the session editor supports only reps or `done`
([pwa/src/components/session/SetEditor.tsx:17-22](../../pwa/src/components/session/SetEditor.tsx), [pwa/src/screens/Session.tsx:2635-2637](../../pwa/src/screens/Session.tsx)). `buildSetInsert` never writes a duration
([pwa/src/screens/Session.tsx:1116-1132](../../pwa/src/screens/Session.tsx)). Timed exercises are displayed/logged as repetitions or cannot be recorded, despite their data model.

### A-107. A regular one-set log becomes visible before it is durably queued

The normal LOG path first applies the set to React state, then fires cache and
outbox writes without awaiting either
([pwa/src/screens/Session.tsx:1197-1203](../../pwa/src/screens/Session.tsx)). If IndexedDB fails or the app is killed in that gap, the lifter has been shown a logged set that disappears after reload and never reaches the server. The superset path correctly makes `enqueueBatch` its local commit point before updating UI
([pwa/src/screens/Session.tsx:1341-1355](../../pwa/src/screens/Session.tsx)); the focus-deck design requires that same order
([docs/superpowers/specs/2026-09-12-session-focus-deck-design.md:119-130](../superpowers/specs/2026-09-12-session-focus-deck-design.md)).

### A-108. Last-actual prefill silently truncates after 20,000 rows

The scan caps itself at 20 pages
([pwa/src/lib/data.ts:1227-1230](../../pwa/src/lib/data.ts)) and ends without a truncation flag
([pwa/src/lib/data.ts:1281-1294](../../pwa/src/lib/data.ts)); the partial answer is cached as a successful result
([pwa/src/lib/data.ts:1393-1409](../../pwa/src/lib/data.ts)). Long-lived accounts can lose recent actuals for exercises beyond the scan boundary and silently prefill stale/default values.

### A-109. Last-actual pagination skips timestamp ties at a page boundary

The scan orders only by `performed_at` and fetches the next page using a strict
timestamp cursor ([pwa/src/lib/data.ts:1395-1404](../../pwa/src/lib/data.ts)). Multiple rows at the boundary timestamp are skipped. Imports or rapid writes with enough tied timestamps can omit an exercise's most recent actual, independently of the 20-page cap in A-108.

### A-110. Reopening a large session silently drops server sets and undercounts it

`countServerSessionSets` limits its result to 500
([pwa/src/lib/data.ts:1679-1697](../../pwa/src/lib/data.ts)), and `getServerSessionSets` reads without pagination or an explicit completeness check
([pwa/src/lib/data.ts:1723-1742](../../pwa/src/lib/data.ts)). Session bootstrap treats that incomplete read as canonical
([pwa/src/screens/Session.tsx:516-523](../../pwa/src/screens/Session.tsx)). A large session can reopen missing rows, miscount completion, and reuse set indices.

### A-111. History silently undercounts when its visible sessions contain more than 2,000 sets

History uses a single, globally capped set query for all selected sessions
([pwa/src/lib/sessionHistory.ts:35-41](../../pwa/src/lib/sessionHistory.ts), [pwa/src/lib/sessionHistory.ts:243-253](../../pwa/src/lib/sessionHistory.ts)). It neither orders nor reports truncation. Once the visible sessions collectively exceed the cap, later sessions can show arbitrary partial or zero counts.

### A-112. Offline History omits unsynced training and can make it look lost

The offline contract promises Today and History remain usable after a session
([docs/flows.md:196-198](../flows.md)), but History reads server/cache-only metrics and sets
([pwa/src/screens/History.tsx:241-246](../../pwa/src/screens/History.tsx)), and its exercise index is built from `v_live_sets`
([pwa/src/lib/data.ts:1361-1386](../../pwa/src/lib/data.ts)). Unlike session bootstrap, it never merges `outbox.pendingSets()`. After logging offline and leaving the session, History can omit the exercise and show stale charts, reasonably leading the lifter to conclude their set vanished.

### A-113. Offline per-set notes disappear from History after session close

Session notes are queued locally
([pwa/src/screens/Session.tsx:1742-1757](../../pwa/src/screens/Session.tsx)), but session close deletes their cache
([pwa/src/screens/End.tsx:300-313](../../pwa/src/screens/End.tsx)). History fetches notes only from Postgres and does not merge pending notes
([pwa/src/lib/data.ts:1650-1674](../../pwa/src/lib/data.ts), [pwa/src/screens/History.tsx:288-297](../../pwa/src/screens/History.tsx)). A note can appear in the active session, then disappear until synchronization, contradicting the offline record promise.

### A-114. Exercise substitutions leave no durable provenance and falsely credit adherence

Substitutions live only under a device-local session cache key
([pwa/src/screens/Session.tsx:1666-1672](../../pwa/src/screens/Session.tsx), [pwa/src/lib/entries.ts:62-70](../../pwa/src/lib/entries.ts)) and are deleted at close
([pwa/src/screens/End.tsx:300-313](../../pwa/src/screens/End.tsx)). The logged set changes `exercise_id` but retains the planned `prescription_id`
([pwa/src/lib/entries.ts:41-53](../../pwa/src/lib/entries.ts)), so adherence reports the prescribed slot as completed. History and the coach cannot later explain what movement was substituted or distinguish it from following the plan.

### A-115. History cache keys omit the session-id scope they represent

Session metadata, set notes, and adherence caches are keyed only by exercise
([pwa/src/lib/db.ts:358-363](../../pwa/src/lib/db.ts)), even though their data readers accept a changing list of session IDs
([pwa/src/lib/data.ts:1623-1644](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:1667-1674](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:1818-1852](../../pwa/src/lib/data.ts)). An offline fallback after the visible history window changes can return notes, metadata, or adherence for a prior session set under the same exercise, silently mismatching information to the displayed workout.

### A-116. Coach body-size protection is bypassable before JSON parsing

The coach declares a maximum body size but checks only the caller-provided
`Content-Length` header before `req.json()` reads the full body
([supabase/functions/coach/index.ts:128-137](../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:855-866](../../supabase/functions/coach/index.ts)). Attachment validation happens afterward. Chunked requests or a false header can force an Edge worker to parse a body larger than the intended limit. This is the coach counterpart to MCP request-body exposure in A-86.

### A-117. Edited set notes retain their original timestamp and fall out of "recent" context

`set_notes.updated_at` has an insert default but no update trigger
([supabase/migrations/20260826150000_supersets_set_notes.sql:33-38](../../supabase/migrations/20260826150000_supersets_set_notes.sql)); PWA upserts do not supply a new timestamp
([pwa/src/lib/sync.ts:28-41](../../pwa/src/lib/sync.ts)). MCP exercise search orders notes by `updated_at` under a global limit
([supabase/functions/mcp-server/tools/search_exercises.ts:127-155](../../supabase/functions/mcp-server/tools/search_exercises.ts)). Editing an old note can therefore fail to bring it into recent coaching context or can leave stale ordering.

### A-118. Set-note input and storage are unbounded

The set-note column is unrestricted text
([supabase/migrations/20260826150000_supersets_set_notes.sql:33-38](../../supabase/migrations/20260826150000_supersets_set_notes.sql)), and the session textarea supplies no maximum length
([pwa/src/screens/Session.tsx:2273-2281](../../pwa/src/screens/Session.tsx)). Saving queues the entire text
([pwa/src/screens/Session.tsx:1742-1757](../../pwa/src/screens/Session.tsx)). A large note can inflate IndexedDB, sync payloads, History responses, exports, and coach context without a bound or truncation disclosure.

### A-119. The approved coach-observation follow-up loop does not exist

The adaptation design specifies durable `coach_observations`, MCP tools, due
observations in coach context, and a History management surface
([docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:280-316](../superpowers/specs/2026-09-16-live-session-adaptation-design.md)). Its reserved migration and all corresponding code are absent. Coach conclusions and check-back dates therefore disappear after conversation, so the app cannot know whether a recommendation worked.

### A-120. Session and set notes never reach coach-memory extraction

The adaptation design calls for these notes to feed reusable coach memory
([docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:81-85](../superpowers/specs/2026-09-16-live-session-adaptation-design.md)), but the sync hook triggers extraction only for check-ins
([pwa/src/lib/sync.ts:81-87](../../pwa/src/lib/sync.ts)), and the coach endpoint selects only unprocessed check-ins
([supabase/functions/coach/index.ts:740-757](../../supabase/functions/coach/index.ts)). A note such as an injured knee during a set never becomes a durable constraint for later coaching.

### A-121. Prompt-delivery cron is known to run without the authority to deliver

The deployment runbook records that no `SWEEP_SECRET` or Vault configuration is
present, so the scheduled sweep succeeds while delivering no prompts
([docs/deploy.md:7-13](../deploy.md)). This is a separate operational failure from A-95's unwired in-app scheduling: even armed prompt rows cannot be delivered in the documented production configuration.

### A-122. Normal exports omit the only copies of pending local writes

The Settings export reads server rows only
([pwa/src/components/SettingsSheet.tsx:236-252](../../pwa/src/components/SettingsSheet.tsx), [pwa/src/lib/export.ts:93-136](../../pwa/src/lib/export.ts)). Pending, held, and dead queue entries are available only through a separate Outbox-sheet export
([pwa/src/components/OutboxSheet.tsx:184-198](../../pwa/src/components/OutboxSheet.tsx)). A user who exports normally while offline or after a failed sync receives a reassuring archive that excludes their only local copies. This is the unsynced-data half of A-98's incomplete archive.

### A-123. Error and confirmation toasts are silent to screen readers

Toasts are ordinary `div` elements without `role="status"`, `role="alert"`, or
an `aria-live` region ([pwa/src/components/Toasts.tsx:18-23](../../pwa/src/components/Toasts.tsx)). A screen-reader user receives none of the app's write confirmations, sync state, or `reportError` failures, including the messages that distinguish a safe queued write from a lost one.

### A-124. Streaming coach output and errors are not announced to assistive technology

Coach status and assistant text mutate inside ordinary `div` elements with no
live region ([pwa/src/components/CoachSheet.tsx:403-455](../../pwa/src/components/CoachSheet.tsx)). A screen-reader user can submit a question but receives neither its streamed answer nor thinking/tool/error state without manually navigating the conversation after every update.

### A-125. Main text/date inputs lack programmatic labels

Several primary fields rely on a visual heading or placeholder rather than an
associated label: bug-report text
([pwa/src/components/ReportBugSheet.tsx:121-130](../../pwa/src/components/ReportBugSheet.tsx)), end-session note
([pwa/src/screens/End.tsx:445-455](../../pwa/src/screens/End.tsx)), plan date/note/duplicate date
([pwa/src/screens/Plan.tsx:1512-1526](../../pwa/src/screens/Plan.tsx), [pwa/src/screens/Plan.tsx:1569-1584](../../pwa/src/screens/Plan.tsx), [pwa/src/screens/Plan.tsx:1638-1647](../../pwa/src/screens/Plan.tsx)), and the coach composer
([pwa/src/components/CoachSheet.tsx:500-513](../../pwa/src/components/CoachSheet.tsx)). Screen readers announce ambiguous generic fields, and placeholder instructions disappear once typing starts.

### A-126. Route changes leave keyboard and screen-reader users without location context

`App` swaps routes without updating `document.title`, moving focus to a screen
heading, or announcing the new route
([pwa/src/App.tsx:120-159](../../pwa/src/App.tsx)). Actions such as Finish, Home, and open workout unmount their initiator, potentially leaving focus on a removed node. Keyboard users have no reliable indication that navigation completed.

### A-127. Focus mode's exit control misses the mobile touch-target contract

The only "View full workout" escape is a bare glyph button
([pwa/src/components/session/FocusDeck.tsx:142-149](../../pwa/src/components/session/FocusDeck.tsx)); its style has only a font size
([pwa/src/styles.css:3241-3243](../../pwa/src/styles.css)), unlike the adjacent 44px control
([pwa/src/styles.css:3245-3249](../../pwa/src/styles.css)). The route's principal navigation control is too small to hit reliably during a workout.

### A-128. Focus-mode actions can sit behind the iPhone home indicator

The standard session footer reserves `env(safe-area-inset-bottom)`
([pwa/src/styles.css:1448-1453](../../pwa/src/styles.css)), but focus mode hides it
([pwa/src/styles.css:3199-3200](../../pwa/src/styles.css)) and gives neither its scroll container nor bottom action bar equivalent safe-area padding
([pwa/src/styles.css:1437-1445](../../pwa/src/styles.css), [pwa/src/styles.css:3374-3384](../../pwa/src/styles.css)). On an installed iPhone PWA, LOG and step controls can be occluded by the home indicator.

### A-129. Plan read failures produce an infinite loading screen

The Plan screen reports failed workout/prescription reads but stores no failure
state ([pwa/src/screens/Plan.tsx:260-268](../../pwa/src/screens/Plan.tsx)). Rendering treats a null list as permanently `Loading…`
([pwa/src/screens/Plan.tsx:381-383](../../pwa/src/screens/Plan.tsx)). A transient offline or server failure leaves the plan editor unusable without a retry path.

### A-130. A failed expanded-session read leaves History permanently loading

The expanded History loader awaits server sets and pending voids without
`try/catch/finally` ([pwa/src/screens/History.tsx:201-217](../../pwa/src/screens/History.tsx)). On a failed uncached request, `openSets` stays undefined and the session remains `Loading…` forever; only the global rejection handler may surface an unrelated error.

### A-131. The disabled decimal pad key remains enabled to assistive technology

When decimals are unavailable, NumberPad gives `.` only a cosmetic class
([pwa/src/components/NumberPad.tsx:56-64](../../pwa/src/components/NumberPad.tsx), [pwa/src/styles.css:2312-2314](../../pwa/src/styles.css)). It is neither disabled nor `aria-disabled`. Keyboard and screen-reader users can focus and activate a control that does nothing, with no explanation.

### A-132. PWA icons break under the documented GitHub Pages subpath deployment

Vite supports a `PAGES_BASE` subpath
([pwa/vite.config.ts:10-12](../../pwa/vite.config.ts), [pwa/vite.config.ts:28-35](../../pwa/vite.config.ts)), but the HTML hardcodes root-relative icon paths
([pwa/index.html:12-13](../../pwa/index.html)). On `/strength-tracker/`, browsers request `/icons/...` rather than the deployed subpath and installed/home-screen icons can be absent.

### A-133. History's chart data is unavailable to nonvisual users

The e1RM chart exposes only a latest-value summary
([pwa/src/components/E1rmChart.tsx:67-89](../../pwa/src/components/E1rmChart.tsx)), and the volume chart exposes only a generic weekly label
([pwa/src/components/VolumeChart.tsx:27-51](../../pwa/src/components/VolumeChart.tsx)). Individual historical points and weekly values have no accessible table or text equivalent, so Record's primary progress information cannot be inspected with a screen reader.

### A-134. Deployment can publish a commit whose CI failed

CI and deployment are independent workflows triggered by the same push
([.github/workflows/ci.yml:3-9](../../.github/workflows/ci.yml), [.github/workflows/deploy.yml:25-29](../../.github/workflows/deploy.yml)). No workflow dependency, required-check gate, or `workflow_run` condition joins them. A failing test commit can therefore still publish Pages and deploy Supabase. This is distinct from A-25, where the backend job itself is skipped.

### A-135. Deployment has no automated production verification or rollback

The deployment workflow ends after publishing Pages
([.github/workflows/deploy.yml:162-168](../../.github/workflows/deploy.yml)). It does not check migration state, invoke deployed functions, exercise auth, fetch the published bundle, or roll back a partial release; the only smoke test is manual
([docs/deploy.md:481-490](../deploy.md)). A green deploy can therefore leave a broken production release undiscovered.

### A-136. MCP health is a false-green liveness probe

`/health` returns 200 before authentication, environment validation, database
access, or token-store access
([supabase/functions/mcp-server/lib/handler.ts:173-183](../../supabase/functions/mcp-server/lib/handler.ts)); required configuration is validated only later
([supabase/functions/mcp-server/lib/db.ts:31-45](../../supabase/functions/mcp-server/lib/db.ts)). The runbook treats that route as production health
([docs/deploy.md:481-484](../deploy.md)), so a missing service key or unusable MCP backend passes the documented check.

### A-137. Alert-sweep migration can report success without a scheduler installed

The migration installs extensions and schedules the cron job only if optional
extensions exist ([supabase/migrations/20260907060000_alert_sweep_cron.sql:20-29](../../supabase/migrations/20260907060000_alert_sweep_cron.sql), [supabase/migrations/20260907060000_alert_sweep_cron.sql:98-105](../../supabase/migrations/20260907060000_alert_sweep_cron.sql)). A managed project without one extension receives a successful migration but no scheduler. Local validation intentionally lacks those extensions, so it cannot detect this deployment state. This is separate from A-121's missing secret configuration.

### A-138. Alert-sweep failures have no active operator alert

`run_alert_sweep` fire-and-forgets its HTTP call, and missing Vault values yield
only a PostgreSQL notice
([supabase/migrations/20260907060000_alert_sweep_cron.sql:56-75](../../supabase/migrations/20260907060000_alert_sweep_cron.sql)). The runbook gives manual inspection queries
([docs/deploy.md:283-304](../deploy.md)) but no alert for a stopped job, wrong secret, queued `pg_net` request, or non-200 response. A configured prompt system can stop delivering without anyone knowing.

### A-139. The hosted PWA cannot call endurance sync

The endpoint supplies no CORS headers and rejects `OPTIONS` as POST-only
([supabase/functions/endurance-sync/index.ts:31-35](../../supabase/functions/endurance-sync/index.ts), [supabase/functions/endurance-sync/index.ts:176-178](../../supabase/functions/endurance-sync/index.ts)). Browser Authorization/JSON requests require that preflight, and no PWA caller exists. The documented path is manual curl
([docs/setup.md:451-462](../setup.md)), so the advertised product feature cannot run from the hosted app.

### A-140. Endurance sync has neither a scheduler nor a user-triggered poll

The only cron job is alert sweep; no PWA route, MCP tool, or scheduled job starts
an endurance poll. Setup requires an operator to call `/backfill` or `/poll` manually
([docs/setup.md:451-462](../setup.md)), despite the roadmap marking the endurance phase shipped
([docs/plan.md:193-200](../plan.md)). Activity data goes stale indefinitely after setup.

### A-141. Endurance credentials have no product connection or revocation flow

Setup requires direct SQL insertion into `integration_credentials`
([docs/setup.md:434-449](../setup.md)). There is no Settings UI, OAuth connection, MCP setup action, validation, or revoke path for Intervals/Strava. A normal user cannot activate or safely manage this feature without database access.

### A-142. Endurance sync parses an unbounded request body

Before looking at its single `since` parameter, the function calls unrestricted
`req.json()` ([supabase/functions/endurance-sync/index.ts:185-190](../../supabase/functions/endurance-sync/index.ts)). An authenticated caller can consume Edge memory/CPU with a large body before validation. This is a third, independent request-body boundary after A-86 and A-116.

### A-143. The outbox does not self-heal transient failures while the app stays online

On a retryable failure, the outbox records it and exits the flush
([pwa/src/lib/outbox.ts:499-507](../../pwa/src/lib/outbox.ts)). A later attempt occurs only after startup, online/identity events, or another write
([pwa/src/lib/outbox.ts:696-705](../../pwa/src/lib/outbox.ts)). If connectivity recovers without a browser online event, queued training writes can remain pending indefinitely until the user reloads or manually intervenes.

### A-144. CI does not enforce committed Deno dependency locks

CI runs Deno checks/tests without `--frozen`
([.github/workflows/ci.yml:37-70](../../.github/workflows/ci.yml)), although function manifests use broad version ranges and committed locks are intended to pin them. A runner can resolve a graph different from the reviewed lockfile without failing the build or deployment.

### A-145. Every CI run depends on a live GitHub seed download

CI always runs the seed builder
([.github/workflows/ci.yml:20](../../.github/workflows/ci.yml)), which fetches GitHub and exits on its failure
([scripts/build-exercise-seed.mjs:9-27](../../scripts/build-exercise-seed.mjs)). A transient outage, rate limit, or upstream failure blocks unrelated pull requests and urgent production repairs. This is availability risk distinct from A-27's mutable seed content.

### A-146. PWA Sentry errors lose the operation context needed for remote triage

`reportError` receives a meaningful context but sends only the raw exception to
Sentry ([pwa/src/lib/errors.ts:316-330](../../pwa/src/lib/errors.ts)). Console and local state can say `save check-in` or `load plan`, while remotely identical exceptions are indistinguishable by user flow. Production debugging lacks the context the local report already has.

### A-147. MCP request logging omits health, discovery, and preflight traffic

The handler's request-log finalizer is bypassed by early `OPTIONS`, `/health`,
and OAuth-discovery returns
([supabase/functions/mcp-server/lib/handler.ts:166-190](../../supabase/functions/mcp-server/lib/handler.ts)). The documented health probe is therefore neither logged nor correlated with service availability, concealing discovery/preflight failures from the only request telemetry.

### A-148. Held outbox rows disclose another account's unsynced data on a shared device

Sign-out deliberately retains outbox rows
([pwa/src/lib/db.ts:252-260](../../pwa/src/lib/db.ts)), but inspection returns every row regardless of current owner
([pwa/src/lib/outbox.ts:579-597](../../pwa/src/lib/outbox.ts)). The Outbox sheet displays and exports held entries verbatim
([pwa/src/components/OutboxSheet.tsx:126-159](../../pwa/src/components/OutboxSheet.tsx), [pwa/src/components/OutboxSheet.tsx:184-199](../../pwa/src/components/OutboxSheet.tsx), [pwa/src/lib/export.ts:285-314](../../pwa/src/lib/export.ts)). A second account on the same device can read/export another person's pending sets, notes, readiness, pain, and session data. This is a disclosure path distinct from cache race A-42 and attribution defect A-90.

### A-149. Legacy `MCP_SECRET` remains a permanent shared full-scope credential

The MCP server accepts the legacy secret directly and maps it to `OWNER_USER_ID`
([supabase/functions/mcp-server/lib/auth.ts:95-101](../../supabase/functions/mcp-server/lib/auth.ts)). It has no expiry, per-client revocation, or usage audit; setup confirms it remains valid until both secrets are manually removed
([docs/setup.md:613-620](../setup.md)). A leaked old client configuration keeps full MCP access indefinitely and cannot be revoked for one client.

### A-150. The in-app coach accepts fabricated assistant history as approval

The coach accepts client-supplied assistant turns and forwards them to the
model ([supabase/functions/coach/index.ts:435-471](../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:1004-1007](../../supabase/functions/coach/index.ts)). Its prompt permits writes after prior approval
([supabase/functions/coach/prompt.ts:88-107](../../supabase/functions/coach/prompt.ts), [supabase/functions/coach/prompt.ts:232-240](../../supabase/functions/coach/prompt.ts)). A client can forge an earlier assistant turn stating that a user approved a plan, then induce confirmation/write tools. There is no alternation, signature, or server-side approval provenance.

### A-151. Confirmed-plan edits rely on caller-controlled approval flags

Confirmed-plan mutation tools trust `confirm_change=true` supplied by their
caller ([supabase/functions/mcp-server/tools/update_planned_workout.ts:127-199](../../supabase/functions/mcp-server/tools/update_planned_workout.ts), [supabase/functions/mcp-server/tools/upsert_program.ts:202-221](../../supabase/functions/mcp-server/tools/upsert_program.ts), [supabase/functions/mcp-server/tools/repeat_planned_workout.ts:119-172](../../supabase/functions/mcp-server/tools/repeat_planned_workout.ts), [supabase/functions/mcp-server/tools/training_plan.ts:487-524](../../supabase/functions/mcp-server/tools/training_plan.ts)). No independently recorded approval is verified. A bearer holder can directly set the flag and change, add, repeat, or replace a confirmed plan. A-55 covers deletion only; this covers all other confirmed-plan changes.

### A-152. Persisted user text is an unescaped injection channel into a write-capable coach

The PWA wraps its built context in `<current_context>`
([pwa/src/lib/coach.ts:68-78](../../pwa/src/lib/coach.ts)), then injects memory, workout labels, plan/session notes, exercise notes, and prescription notes verbatim
([pwa/src/lib/coachContext.ts:248-257](../../pwa/src/lib/coachContext.ts), [pwa/src/lib/coachContext.ts:491-540](../../pwa/src/lib/coachContext.ts)). The system prompt treats that block as trusted application state and marks only uploads untrusted
([supabase/functions/coach/prompt.ts:145-163](../../supabase/functions/coach/prompt.ts)). A stored note containing a closing tag or instructions can steer the coach's write-capable tool use.

### A-153. Bug-report consent copy understates included user-related diagnostics

The report sheet says no written or logged data is included
([pwa/src/components/ReportBugSheet.tsx:132-135](../../pwa/src/components/ReportBugSheet.tsx)), but the error bundle includes route/plan UUIDs, workout label, active session ID, sync error, and recent messages, which are persisted/sent to feedback and Sentry
([pwa/src/lib/errors.ts:176-227](../../pwa/src/lib/errors.ts), [pwa/src/lib/errors.ts:259-299](../../pwa/src/lib/errors.ts)). This can disclose health/workout identifiers without accurate disclosure, distinct from feedback-size A-87.

### A-154. Coach conversations and health context have indefinite retention by default

Coach observability stores prompt and response content
([supabase/migrations/20260831050000_coach_observability.sql:18-32](../../supabase/migrations/20260831050000_coach_observability.sql)); the function writes it unless `COACH_LOG_CONTENT` is explicitly off
([supabase/functions/coach/index.ts:583-620](../../supabase/functions/coach/index.ts)). No TTL, deletion path, or retention job exists. Context contains sleep, fatigue, soreness, mood, symptoms, and injury state
([pwa/src/lib/coachContext.ts:390-470](../../pwa/src/lib/coachContext.ts)). This is a separate sensitive-data lifecycle problem from A-50.

### A-155. Lock-screen rest alerts disclose exercise or rehabilitation context

Session labels include the exercise name and set number
([pwa/src/screens/Session.tsx:1224-1237](../../pwa/src/screens/Session.tsx), [pwa/src/screens/Session.tsx:1385-1397](../../pwa/src/screens/Session.tsx)), and the service worker displays payload text verbatim
([pwa/src/sw.ts:100-131](../../pwa/src/sw.ts)). Settings offers permission/subscription controls but no sensitive-content option
([pwa/src/components/SettingsSheet.tsx:136-155](../../pwa/src/components/SettingsSheet.tsx)). A locked/shared phone can reveal exercises or rehab context to bystanders.

### A-156. Push subscriptions have unbounded per-user fanout

The subscription route accepts unlimited unique HTTPS endpoints
([supabase/functions/push-alerts/index.ts:215-254](../../supabase/functions/push-alerts/index.ts)), and delivery fetches every active endpoint using unbounded `Promise.all`
([supabase/functions/push-alerts/index.ts:430-441](../../supabase/functions/push-alerts/index.ts), [supabase/functions/push-alerts/index.ts:763-805](../../supabase/functions/push-alerts/index.ts)). One authenticated user can register many fake endpoints then trigger test/scheduled alerts, amplifying outbound work and A-69's destination-control flaw.

### A-157. Endurance backfill accepts unlimited historical/future windows and repeated requests

The endpoint accepts any parseable `since` date, including 1970 or the future,
then polls both providers ([supabase/functions/endurance-sync/index.ts:195-219](../../supabase/functions/endurance-sync/index.ts)). It has no per-user budget, lower/upper bound, lock, or rate limit. Repeated authenticated calls can force expensive provider scans and exhaust provider quotas, independently of A-73 and A-75.

### A-158. Persisted-session fallback can select another Supabase project's session

The fallback scans any `sb-*-auth-token` or legacy storage key and returns the
first valid session without checking project ref, issuer, or audience
([pwa/src/lib/persistedSession.ts:25-61](../../pwa/src/lib/persistedSession.ts)). `useAuth` and `currentUser` use it as device identity
([pwa/src/hooks/useAuth.ts:28-49](../../pwa/src/hooks/useAuth.ts), [pwa/src/lib/currentUser.ts:26-43](../../pwa/src/lib/currentUser.ts)). On a reused origin or project migration with multiple Supabase session keys, the app can mount against a foreign stale identity and mis-associate cache ownership.

### A-159. Third-party endurance credentials are stored as cleartext bearer secrets

Provider API keys/OAuth tokens are stored as unrestricted `secret jsonb`
([supabase/migrations/20260907030000_activities.sql:206-230](../../supabase/migrations/20260907030000_activities.sql)) and read under service-role access for upstream calls
([supabase/functions/endurance-sync/index.ts:126-143](../../supabase/functions/endurance-sync/index.ts)). A database read, backup exposure, or service-role compromise yields live external-provider credentials and the user's external history. This is distinct from A-141's missing user connection/revocation flow.

## Feature deep dive

The following findings come from tracing individual feature flows against their
schema, tests, and product documentation. They are deliberately separated from
the cross-cutting defects above so each is actionable by the feature owner.

| Feature | Findings | Immediate concern |
| --- | --- | --- |
| Health, readiness, injury, endurance, prompts | A-160 to A-161, A-189 to A-193 | The advertised injury flow is unreachable; imported Strava data stops at token expiry. |
| Planning, progression, exercises, programs | A-162 to A-167 | Plans can disappear, execute with different superset semantics, or lose their target mid-session. |
| Coach, connected apps, MCP, tunnel | A-168 to A-175 | Stream/retry recovery, consent annotations, response bounds, and tunnel liveness are unreliable. |
| Workout execution, rest, ending, recovery | A-176 to A-183 | Concurrent starts, reloads, and navigation can duplicate, resurrect, or lose training state. |
| Record, analytics, bodyweight, portability | A-184 to A-185 | Analytics count incomplete work inconsistently and bodyweight corrections are impossible. |
| Account, settings, install, synchronization | A-186 to A-188 | A failed sign-out looks successful and settings can silently roll back. |
| Route and modal boundaries | A-194 to A-196 | Browser navigation produces stale overlays and invalid route state. |
| Specifications, regression coverage, DB contracts | A-197 to A-203 | Required load calculations and correction behavior are unprotected; terminal/history invariants are bypassable. |
| Adversarial lifecycle and failure injection | A-204 to A-209 | Reconciliation and failure handling can discard completed work, hide accepted sets, duplicate writes, or falsely claim state changes. |

### Health, readiness, injury, and endurance

### A-160. The documented subjective-injury feature is not usable as a product

The roadmap marks E1 as shipped, including a weekly OSTRC form, pain checks,
red flags, cycle tracking, prompt scheduling, and badging
([docs/plan.md:184-200](../plan.md)). The feature plan likewise commits the PWA
to the OSTRC form and prompts ([docs/endurance-plan.md:82-128](../endurance-plan.md)).
The live check-in sheet writes only spontaneous `checkins`, `daily_readiness`,
and a readiness skip ([pwa/src/components/CheckInSheet.tsx:74-90](../../pwa/src/components/CheckInSheet.tsx), [pwa/src/components/CheckInSheet.tsx:126-188](../../pwa/src/components/CheckInSheet.tsx)); the only client symptom operation is a read of open episodes
([pwa/src/lib/checkins.ts:245-256](../../pwa/src/lib/checkins.ts)). The MCP handler registers
only `get_checkins`, not a symptom, OSTRC, pain, red-flag, or cycle feature
([supabase/functions/mcp-server/lib/handler.ts:69-103](../../supabase/functions/mcp-server/lib/handler.ts)).
The database tables therefore exist but athletes cannot create, answer, review,
close, or act on the central injury records through either supported product
surface. This invalidates the claimed shipped capability and leaves the safety
flow unreachable.

### A-161. An overlong spontaneous check-in is acknowledged before it is rejected

The `checkins.note` column caps text at 1,000 characters
([supabase/migrations/20260907040000_subjective_capture.sql:136-148](../../supabase/migrations/20260907040000_subjective_capture.sql)), but the spontaneous-check-in textarea has no `maxLength` or pre-enqueue validation
([pwa/src/components/CheckInSheet.tsx:74-90](../../pwa/src/components/CheckInSheet.tsx)). It immediately says "Checked in" after merely adding the row to IndexedDB. The later database constraint failure makes the queue item dead
([pwa/src/lib/outbox.ts:489-507](../../pwa/src/lib/outbox.ts)). A user can write a detailed symptom or injury note, receive a success confirmation, and only discover the loss by opening the technical sync queue. The readiness-note textarea does enforce the same limit, so this is an avoidable mismatch within one feature.

### Planning, progression, exercises, and programs

### A-162. The PWA hides valid older confirmed programs

The data layer loads all confirmed programs ([pwa/src/lib/data.ts:253-284](../../pwa/src/lib/data.ts)), but Today selects only `programs[0]` and filters every displayed workout to that one program
([pwa/src/screens/Today.tsx:406-420](../../pwa/src/screens/Today.tsx)). The MCP read surface explicitly supports multiple simultaneous confirmed programs
([supabase/functions/mcp-server/tools/get_program.ts:285-293](../../supabase/functions/mcp-server/tools/get_program.ts)). Older valid plans cannot be reviewed, started, or edited in the app. This makes historical and overlapping blocks effectively disappear and creates a mismatch between connected-app and PWA behavior.

### A-163. MCP can create supersets whose Plan and Session semantics disagree

MCP validation requires only that a `superset_group` contain two or more rows
([supabase/functions/mcp-server/lib/prescriptions.ts:184-198](../../supabase/functions/mcp-server/lib/prescriptions.ts)). Plan groups every matching id together
([pwa/src/lib/sections.ts:75-107](../../pwa/src/lib/sections.ts)), whereas the live-session builder pairs only adjacent matching rows
([pwa/src/lib/entries.ts:170-194](../../pwa/src/lib/entries.ts)). A non-contiguous group or a reused id looks like one superset while editing the plan but executes as separated work in the gym. Validation must enforce the ordering invariant or the two feature views cannot agree on the workout.

### A-164. Coach changes to goals and training maxes leave the PWA stale

The PWA only invalidates a narrow set of coach write types
([pwa/src/lib/planChanges.ts:7-15](../../pwa/src/lib/planChanges.ts)); CoachSheet therefore does not refresh local goal or training-max data after those tools run
([pwa/src/components/CoachSheet.tsx:253-267](../../pwa/src/components/CoachSheet.tsx)). History and the Training Max sheet retain their cached reads
([pwa/src/screens/History.tsx:239-266](../../pwa/src/screens/History.tsx), [pwa/src/components/TrainingMaxSheet.tsx:67-95](../../pwa/src/components/TrainingMaxSheet.tsx)). The coach can report a successful adjustment while the athlete continues planning and training from old values until a manual refresh or cache expiry.

### A-165. A planned day can be deleted under an active session

Plan deletion soft-deletes a workout without checking for an open session
([pwa/src/lib/data.ts:466-471](../../pwa/src/lib/data.ts)); the database view then excludes discarded days
([supabase/migrations/20260901030000_soft_delete_planned_workouts.sql:67-86](../../supabase/migrations/20260901030000_soft_delete_planned_workouts.sql)). Session reloads its prescription context from that view and falls back when it cannot find it
([pwa/src/screens/Session.tsx:446-471](../../pwa/src/screens/Session.tsx)). A second device, or a plan edit before a reload, can remove the active session's prescribed target and silently turn execution into by-feel logging.

### A-166. Editing a Plan section is a non-atomic multi-request mutation

`commitRx` first updates the prescription, then separately updates every section mate and finally settles ordering
([pwa/src/screens/Plan.tsx:528-553](../../pwa/src/screens/Plan.tsx)). A failure after the first write leaves a partly moved or renamed section with no rollback, recovery marker, or reconciliation UI. This is a visible planning-state corruption path separate from the broader reorder race in A-38.

### A-167. New exercises default to dumbbell loading semantics

The custom-exercise form defaults its equipment to `dumbbell` and saves it unless the user changes it
([pwa/src/components/NewExerciseSheet.tsx:72-98](../../pwa/src/components/NewExerciseSheet.tsx)). Load-entry inference treats dumbbells as per-side equipment
([pwa/src/lib/loadEntry.ts:60-66](../../pwa/src/lib/loadEntry.ts)). A new barbell, cable, or bodyweight movement therefore starts with the wrong entry semantics and can be displayed and recorded as a paired load. The form should require or safely infer equipment instead of silently choosing a consequential default.

### Coach, connected apps, MCP, and tunnel

### A-168. A clean-ended Coach stream can leave the interface permanently busy

The stream reader treats only an explicit `done` event as terminal
([pwa/src/lib/coach.ts:151-170](../../pwa/src/lib/coach.ts)). EOF without that event reaches neither a completion nor recovery path, so the sheet can retain a streaming placeholder and busy state until reload. An upstream edge disconnect is presented as an endless response rather than an actionable retry.

### A-169. Retrying a Coach attachment after reload sends an empty file

CoachSheet persists attachment metadata with `data: ""`
([pwa/src/components/CoachSheet.tsx:65-80](../../pwa/src/components/CoachSheet.tsx)), then restores and resends those entries when a retry is requested
([pwa/src/components/CoachSheet.tsx:330-345](../../pwa/src/components/CoachSheet.tsx)). The user sees the attachment name/preview but the retry has no original bytes. A post-reload retry can therefore produce a materially different answer without warning.

### A-170. Tunnel child stderr can block the supervisor and take the MCP offline

The supervisor creates piped stderr streams for both relay and tunnel children
([scripts/strength-tunnel-supervisor.mjs:78-82](../../scripts/strength-tunnel-supervisor.mjs)) but attaches no readers. Once child diagnostics fill the operating-system pipe buffer, the child can stall and the supervisor loses its tunnel. This is a self-healing failure: the process is nominally alive yet cannot make progress or expose enough logs to diagnose the stall.

### A-171. Coach's daily-spend display uses UTC while enforcement uses the athlete's timezone

The client derives "today" in UTC ([pwa/src/lib/coach.ts:233-247](../../pwa/src/lib/coach.ts)), while the cost ledger groups spend using the user's configured application timezone
([supabase/migrations/20260831070000_coach_durability_cost.sql:46-55](../../supabase/migrations/20260831070000_coach_durability_cost.sql)). Around UTC midnight, the displayed count/cost is assigned to the wrong local day. This undermines the budget feedback precisely when a user needs to understand their remaining allowance.

### A-172. Several MCP read tools have no response-size bound

`get_program`, `get_volume`, and `get_goal_progress` issue list reads without a
limit ([supabase/functions/mcp-server/tools/get_program.ts:298-323](../../supabase/functions/mcp-server/tools/get_program.ts), [supabase/functions/mcp-server/tools/get_volume.ts:152-157](../../supabase/functions/mcp-server/tools/get_volume.ts), [supabase/functions/mcp-server/tools/get_goal_progress.ts:31-42](../../supabase/functions/mcp-server/tools/get_goal_progress.ts)). Large programs or histories can cause latency, Edge-memory, and model-context failures. This is independent of the note/memory response bounds in A-33 and A-80.

### A-173. MCP program writes allow unbounded nested plans

The program-write schemas cap neither workouts nor nested prescriptions
([supabase/functions/mcp-server/tools/upsert_program.ts:58-61](../../supabase/functions/mcp-server/tools/upsert_program.ts), [supabase/functions/mcp-server/tools/upsert_program.ts:82-85](../../supabase/functions/mcp-server/tools/upsert_program.ts)). An authenticated request can persist a massive plan, then force the unbounded reads in A-172 and burden Plan/Today. Body-size controls alone do not prevent this stored amplification path.

### A-174. Destructive MCP operations are marked non-destructive to clients

The tool annotations for program confirmation, training-plan mutation, and repeated planned workouts declare `destructiveHint: false`
([supabase/functions/mcp-server/tools/confirm_program.ts:20-29](../../supabase/functions/mcp-server/tools/confirm_program.ts), [supabase/functions/mcp-server/tools/training_plan.ts:697-700](../../supabase/functions/mcp-server/tools/training_plan.ts), [supabase/functions/mcp-server/tools/repeat_planned_workout.ts:104-108](../../supabase/functions/mcp-server/tools/repeat_planned_workout.ts)). Clients that rely on annotations can omit or weaken approval UI for one-way activation and schedule mutation, contradicting the intended consent model.

### A-175. Stopping a Coach response permanently discards its recoverable remainder

Stop marks the assistant non-streaming and keeps only the partial content
([pwa/src/components/CoachSheet.tsx:309-327](../../pwa/src/components/CoachSheet.tsx)). The recovery effect then has no active streaming turn to reconcile
([pwa/src/components/CoachSheet.tsx:139-172](../../pwa/src/components/CoachSheet.tsx)). If the server completed and persisted the answer, reopening displays a permanently truncated local transcript with no explicit recovery affordance. This differs from A-62, which concerns cancellation contaminating a following turn.

### Workout execution, rest, session ending, and recovery

### A-176. Two devices can create simultaneous open sessions

Today's start gate is local to each client, so two tabs/devices can both pass it and enqueue sessions
([pwa/src/screens/Today.tsx:449-487](../../pwa/src/screens/Today.tsx), [pwa/src/screens/Today.tsx:849-887](../../pwa/src/screens/Today.tsx)). The schema has no partial uniqueness constraint requiring one open session per user
([supabase/migrations/20260825120001_schema.sql:97-107](../../supabase/migrations/20260825120001_schema.sql)). The shared active-session pointer chooses only one, leaving the other open session orphaned and creating ambiguous recovery, rest, and completion state.

### A-177. A pending set void can reappear after reloading Session

Session bootstrap reads cached voids but does not incorporate `outbox.pendingVoidIds()`
([pwa/src/screens/Session.tsx:435-455](../../pwa/src/screens/Session.tsx), [pwa/src/screens/Session.tsx:492-523](../../pwa/src/screens/Session.tsx)). `voidSet` queues the delete separately
([pwa/src/screens/Session.tsx:1596-1612](../../pwa/src/screens/Session.tsx)); a reload before the remote/cache update can therefore show the voided set again. History explicitly merges pending voids
([pwa/src/screens/History.tsx:205-212](../../pwa/src/screens/History.tsx)), proving the missing Session reconciliation is an inconsistent recovery path.

### A-178. The rest strip can show a timer after auto-rest is disabled

`logSet` and `logRound` set rest state only when `showStrip` is true, with no corresponding clearing branch
([pwa/src/screens/Session.tsx:1229-1231](../../pwa/src/screens/Session.tsx), [pwa/src/screens/Session.tsx:1388-1392](../../pwa/src/screens/Session.tsx)). A previous rest countdown remains visible when auto-rest is disabled or a superset's first member is logged, despite the alert being disarmed. The UI tells the athlete to rest for an interval that no longer governs the workout.

### A-179. Returning Home discards all staged set input without warning or recovery

The current load, reps, type, and RPE draft exists only in Session component memory
([pwa/src/screens/Session.tsx:242-255](../../pwa/src/screens/Session.tsx)). Home navigation unmounts that screen
([pwa/src/screens/Session.tsx:2986-2993](../../pwa/src/screens/Session.tsx)). Logged sets survive, but a nearly completed unsubmitted set disappears with no confirmation, restore point, or indication of what was lost.

### A-180. A failed session-start enqueue leaves a ghost active session

Today writes the prescription/session cache and active-session pointer before it queues the session insertion
([pwa/src/screens/Today.tsx:869-887](../../pwa/src/screens/Today.tsx)). Its failure handler only reports the error and does not remove those pointers
([pwa/src/screens/Today.tsx:898-900](../../pwa/src/screens/Today.tsx)). Subsequent navigation can resume an ID that does not exist locally or remotely, blocking normal start/recovery until the cache is manually repaired.

### A-181. The session-rating prompt disappears before the rating is durable

RateSessionCard clears its own prompt before persisting a rating or skip
([pwa/src/components/RateSessionCard.tsx:71-91](../../pwa/src/components/RateSessionCard.tsx)); the write is then queued through the data layer
([pwa/src/lib/data.ts:2061-2072](../../pwa/src/lib/data.ts)). An IndexedDB/queue failure removes the only retry affordance while the session remains unrated. The user receives neither a durable result nor a way back to the question.

### A-182. Pending discards can hide older valid History rows

`getSessionLog` limits the server result to 20 before removing pending-discard rows
([pwa/src/lib/sessionHistory.ts:199-217](../../pwa/src/lib/sessionHistory.ts), [pwa/src/lib/sessionHistory.ts:269-272](../../pwa/src/lib/sessionHistory.ts)). If recent rows are awaiting discard sync, the result is fewer than 20 and older valid sessions are never fetched. History can appear truncated at precisely the point an athlete needs to verify a correction.

### A-183. History can retain a selection for an exercise with no remaining data

The selected exercise is initialized once and not reconciled when `withData` changes
([pwa/src/screens/History.tsx:143-159](../../pwa/src/screens/History.tsx)). Voiding the last live set for that exercise leaves the selector pointing at an empty detail state rather than choosing a valid remaining exercise or explaining that none remains.

### Record, analytics, bodyweight, and portability

### A-184. Open sessions contaminate Record analytics with incomplete work

`v_live_sets` excludes voided/discarded rows but includes sets from open sessions
([supabase/migrations/20260825140000_planning_voids.sql:47-56](../../supabase/migrations/20260825140000_planning_voids.sql)). The weekly-summary `trained` CTE counts those sets and their tonnage, while its `sessed` CTE counts only sessions with `ended_at`
([supabase/migrations/20260906040000_v_weekly_summary.sql:19-39](../../supabase/migrations/20260906040000_v_weekly_summary.sql)). History presents both totals and per-exercise charts
([pwa/src/screens/History.tsx:182-190](../../pwa/src/screens/History.tsx), [pwa/src/lib/data.ts:1760-1784](../../pwa/src/lib/data.ts)). During an active workout, Record can show new working sets, tonnage, and e1RM while reporting zero completed sessions, contrary to the app's own completion rule
([pwa/src/lib/sessionHistory.ts:105-111](../../pwa/src/lib/sessionHistory.ts)). This makes the same workout count as complete for some analytics but not others.

### A-185. A standalone bodyweight entry cannot be corrected or deleted in the app

The schema permits update and deletion of `bodyweight_log`
([supabase/migrations/20260906020000_bodyweight_log.sql:39-48](../../supabase/migrations/20260906020000_bodyweight_log.sql)), but the client exposes only append-only `recordBodyweight`
([pwa/src/lib/data.ts:2000-2020](../../pwa/src/lib/data.ts)). BodyweightRow shows only the latest value and Save/Cancel, with no history, edit, delete, or correction affordance
([pwa/src/components/BodyweightRow.tsx:58-100](../../pwa/src/components/BodyweightRow.tsx), [pwa/src/components/BodyweightRow.tsx:163-184](../../pwa/src/components/BodyweightRow.tsx)). A mistyped weigh-in remains the apparent latest result until another entry supersedes it, despite the data model explicitly allowing correction.

### Account, settings, install, and synchronization

### A-186. Failed sign-out is presented as successful

Settings ignores the error result from `supabase.auth.signOut()` and closes the
sheet regardless ([pwa/src/components/SettingsSheet.tsx:275-283](../../pwa/src/components/SettingsSheet.tsx)). OAuth consent uses the same fire-and-forget logout behavior
([pwa/src/screens/OAuthConsent.tsx:141-145](../../pwa/src/screens/OAuthConsent.tsx)). On a shared device, a resolved Supabase error can leave the previous session active after the user believes they have signed out, creating a material account and privacy boundary failure.

### A-187. Separate tabs can overwrite each other's settings

Settings keeps an in-memory `values`/`parsed` snapshot and exposes only manual reload; it does not subscribe to the browser `storage` event
([pwa/src/lib/settings.ts:634-674](../../pwa/src/lib/settings.ts)). A stale second tab can later persist its envelope over a newer unit, inventory, or preference change
([pwa/src/lib/settings.ts:688-698](../../pwa/src/lib/settings.ts)). This is especially harmful during training, where a stale equipment/unit configuration changes what the logger displays and suggests.

### A-188. The settings interface claims persistence after local-storage failure

`setSetting` mutates memory, calls `persist`, notifies subscribers, and returns
success, while `persist` catches `localStorage.setItem` failures without
reporting them to the caller ([pwa/src/lib/settings.ts:639-654](../../pwa/src/lib/settings.ts), [pwa/src/lib/settings.ts:688-699](../../pwa/src/lib/settings.ts)). The reset path has the same behavior
([pwa/src/lib/settings.ts:716-720](../../pwa/src/lib/settings.ts)). In private/full-storage contexts the UI reports changed settings during the session, but reload silently restores old values. Equipment, unit, and rest settings therefore appear durable when they are not.

### Health, readiness, endurance, and prompts

### A-189. The readiness "7-day" trend is a seven-observation trend

`v_readiness_trend` uses `rows between 6 preceding and current row`
([supabase/migrations/20260907040000_subjective_capture.sql:543-545](../../supabase/migrations/20260907040000_subjective_capture.sql)). For someone who records every few days, a value labelled `*_7d` can span weeks rather than seven calendar days. Sparse health data is therefore presented as recent change and can mislead a user or Coach context about current readiness.

### A-190. Armed prompts do not create the adherence-denominator record

`report_prompts` is the documented denominator for prompt adherence
([supabase/migrations/20260907040000_subjective_capture.sql:382-401](../../supabase/migrations/20260907040000_subjective_capture.sql)), but the push arm route writes only `rest_alerts`
([supabase/functions/push-alerts/index.ts:359-374](../../supabase/functions/push-alerts/index.ts)). The client simply invokes that route
([pwa/src/lib/push.ts:347-369](../../pwa/src/lib/push.ts)). Once prompt scheduling is wired, weekly and next-morning prompts will still have no denominator row, making adherence unknowable or falsely high. This is distinct from A-94's missing response stamp and A-95's absence of a caller today.

### A-191. Tapping a health notification cannot open the relevant health action

The service worker receives prompt payload data but its click handler ignores the
kind, alert id, and target action, focusing an existing page or opening the app
root ([pwa/src/sw.ts:162-195](../../pwa/src/sw.ts)). There is no health deep link,
prompt route, or response association. A user who taps a weekly OSTRC or
next-morning pain notification lands on Today with no form to answer and no
connection between the prompt and a later response.

### A-192. Notification badges do not represent the advertised waiting count

Push payloads hardcode `badge: 1` for prompt and rest alerts
([supabase/functions/push-alerts/index.ts:399-409](../../supabase/functions/push-alerts/index.ts), [supabase/functions/push-alerts/index.ts:741-750](../../supabase/functions/push-alerts/index.ts)); the worker displays that value directly
([pwa/src/sw.ts:139-153](../../pwa/src/sw.ts)). Opening the app clears the badge regardless of unanswered prompts
([pwa/src/main.tsx:14-36](../../pwa/src/main.tsx)). Several pending health actions therefore still show one, then disappear from the badge without being answered, contrary to the documented waiting-count behavior.

### A-193. Strava import stops at access-token expiry with no automatic recovery

The credential schema describes an OAuth shape with refresh capability
([supabase/migrations/20260907030000_activities.sql:206-221](../../supabase/migrations/20260907030000_activities.sql)), but the provider reads only `secret.access_token`
([supabase/functions/endurance-sync/providers.ts:125-139](../../supabase/functions/endurance-sync/providers.ts)). On HTTP 401 it reports a non-retryable reauthorization error and never refreshes. A connected Strava account stops importing after its short-lived access token expires, with no automated recovery or user-facing connection repair. This is separate from the missing connection/revocation flow in A-141.

### Route, modal, and navigation boundaries

### A-194. Browser navigation changes the page behind an open global modal

Settings state is owned by Shell and Coach/Report state by FabDock, with neither
reconciled on `location` changes ([pwa/src/App.tsx:44-55](../../pwa/src/App.tsx), [pwa/src/App.tsx:153-156](../../pwa/src/App.tsx), [pwa/src/components/FabDock.tsx:21-24](../../pwa/src/components/FabDock.tsx), [pwa/src/components/FabDock.tsx:150-153](../../pwa/src/components/FabDock.tsx)). Opening Settings or Coach on Train and pressing browser Back to History or Session leaves the originating modal and its focus trap mounted over a different screen. Because modal state is absent from browser history, Back cannot close it first. This makes the visible context, underlying route, and keyboard focus disagree.

### A-195. Plan exits return to the wrong tab and resurrect the editor in history

Both Plan's "TODAY" control and "Done planning" unconditionally navigate to `/`
([pwa/src/screens/Plan.tsx:748-752](../../pwa/src/screens/Plan.tsx), [pwa/src/screens/Plan.tsx:1499-1507](../../pwa/src/screens/Plan.tsx)). An editor opened from `/program` returns to Train, and the navigation pushes rather than replaces the editor entry. Browser Back then reopens the just-completed plan editor, inviting a stale edit and contradicting the user's expected return path.

### A-196. Invalid deep links silently impersonate the Train route

The catch-all route renders Today in Train presentation without redirecting or
showing a not-found state ([pwa/src/App.tsx:121-124](../../pwa/src/App.tsx)). A typo or stale
deep link such as `/bogus` displays Train while retaining the invalid URL, leaving
no active primary tab and causing Back/Forward to replay the bad location. Bug
reports also receive that invalid route context ([pwa/src/App.tsx:95](../../pwa/src/App.tsx)). Routing failures become indistinguishable from a valid product state.

### Feature contracts, specifications, and regression coverage

### A-197. A correction made immediately after logging is silently dropped

The active adaptation specification limits its duplicate lock to LOG taps for
200 ms and explicitly excludes corrections
([docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:74-76](../superpowers/specs/2026-09-16-live-session-adaptation-design.md), [docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:178-182](../superpowers/specs/2026-09-16-live-session-adaptation-design.md)). The implementation uses a 400 ms shared lock
([pwa/src/screens/Session.tsx:151](../../pwa/src/screens/Session.tsx)) and `saveCorrection` returns while it is held
([pwa/src/screens/Session.tsx:1506-1508](../../pwa/src/screens/Session.tsx)). The focus test waits 450 ms before correcting
([pwa/src/screens/Session.focus.test.tsx:880-884](../../pwa/src/screens/Session.focus.test.tsx)), so green coverage deliberately misses the prohibited path. An athlete who immediately fixes a typo receives no warning and loses the correction.

### A-198. The pound plate calculator misses its documented exact-load cases

The active specification requires exact reconstruction for a listed set of
pound loads including 135 and 65 lb
([docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:121-123](../superpowers/specs/2026-09-16-live-session-adaptation-design.md), [docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:466-468](../superpowers/specs/2026-09-16-live-session-adaptation-design.md)). Session rounds converted pound input to two kilogram decimals
([pwa/src/screens/Session.tsx:1798-1801](../../pwa/src/screens/Session.tsx), [pwa/src/screens/Session.tsx:1833-1837](../../pwa/src/screens/Session.tsx)), while `split` demands exact lb-equivalent plate arithmetic with `EPS = 1e-6`
([pwa/src/lib/plates.ts:24-27](../../pwa/src/lib/plates.ts), [pwa/src/lib/plates.ts:62-75](../../pwa/src/lib/plates.ts)). Values such as 135 and 65 lb can be suggested as lower builds. Tests cover only an exact 225-lb case
([pwa/src/lib/plates.test.ts:55-60](../../pwa/src/lib/plates.test.ts)), leaving the required regression table unprotected.

### A-199. All machines receive plate-calculator guidance despite incompatible load systems

The active specification distinguishes barbell, plate-machine, stack/cable,
dumbbell, kettlebell, and bodyweight modes
([docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md:94-120](../superpowers/specs/2026-09-16-live-session-adaptation-design.md)). Current Session treats every `machine` as plateable
([pwa/src/screens/Session.tsx:839-842](../../pwa/src/screens/Session.tsx)), and PlateSheet always calculates plates
([pwa/src/components/PlateSheet.tsx:34-36](../../pwa/src/components/PlateSheet.tsx)). Preferences offer only bar weight and entry mode, not a load-style distinction
([pwa/src/lib/settings.ts:62-74](../../pwa/src/lib/settings.ts), [pwa/src/lib/settings.ts:204-212](../../pwa/src/lib/settings.ts)). Stack/cable users can receive false plate instructions, while machine-base/sled entry is unavailable; current tests assert total load but not the required load-system distinction
([pwa/src/lib/loadEntry.test.ts:75-80](../../pwa/src/lib/loadEntry.test.ts), [pwa/src/lib/loadEntry.test.ts:114-118](../../pwa/src/lib/loadEntry.test.ts)).

### Database feature contracts and invariants

### A-200. Session terminal state is not enforced by the database

`sessions` checks only that `ended_at` is not before `started_at`, while the
owner update policy allows arbitrary column changes
([supabase/migrations/20260825120001_schema.sql:97-107](../../supabase/migrations/20260825120001_schema.sql), [supabase/migrations/20260825120002_rls.sql:55-58](../../supabase/migrations/20260825120002_rls.sql)). A client can reopen, retimestamp, retarget, or set both terminal states on a session. Completed/discarded analytics and the recovery workflow rely on states that direct PostgREST writes can rewrite, so the database does not protect the record lifecycle the product promises.

### A-201. Confirmed training-plan history is mutable through direct PostgREST

The schema describes training-plan revisions as new rows and maintains one live
row, but owner RLS permits updating every `training_plans` column, including
objective, dates, confirmation, and supersession
([supabase/migrations/20260905060000_training_plans.sql:30-58](../../supabase/migrations/20260905060000_training_plans.sql), [supabase/migrations/20260905060000_training_plans.sql:176-185](../../supabase/migrations/20260905060000_training_plans.sql)). A direct authenticated write can mutate confirmed history in place or restore/supersede it without the MCP confirmation flow. The append-only revision model is documentation, not an enforceable contract.

### A-202. Plan phases can lie outside their parent training plan

The application validator requires every phase to fit its parent plan's
`starts_on`/`ends_on` interval
([supabase/functions/mcp-server/tools/training_plan.ts:117-121](../../supabase/functions/mcp-server/tools/training_plan.ts), [supabase/functions/mcp-server/tools/training_plan.ts:174-180](../../supabase/functions/mcp-server/tools/training_plan.ts)), but the database checks only each phase's internal date ordering
([supabase/migrations/20260905060000_training_plans.sql:60-80](../../supabase/migrations/20260905060000_training_plans.sql)). Owner policies allow bypassing the validator
([supabase/migrations/20260905060000_training_plans.sql:187-193](../../supabase/migrations/20260905060000_training_plans.sql)). Direct writes can create phases outside the plan, corrupting current/next-phase context and any future plan engine.

### A-203. Deleting a historical training max rewrites past adherence

The PWA exposes training-max deletion
([pwa/src/lib/data.ts:1123-1126](../../pwa/src/lib/data.ts)), and RLS permits it
([supabase/migrations/20260825120002_rls.sql:26-29](../../supabase/migrations/20260825120002_rls.sql)). `v_adherence` dynamically resolves each past set using the latest max effective on that date
([supabase/migrations/20260825120003_views.sql:76-100](../../supabase/migrations/20260825120003_views.sql)). Removing an old max therefore changes historical prescribed loads and deltas without preserving the former value. This is an independent historical rewrite from A-92's prescription-edit defect.

### Adversarial lifecycle and failure injection

### A-204. Stale reconciliation can discard a session another device just completed

`syncOpenSessions` snapshots a session as open, computes its last set, and then
discards it without reasserting that it remains non-terminal
([pwa/src/lib/data.ts:1488-1501](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:1531-1570](../../pwa/src/lib/data.ts)). Another tab/device can end the session after the open-session snapshot but before discard. Unlike `complete`, discard filters only by id, so it writes `discarded_at` onto the completed record. Live DONE/history/calendar views then exclude the completed workout. This is a cross-device stale-snapshot race distinct from A-06's local end/discard double action.

### A-205. Sets can land after their session was discarded and become permanently invisible

The set foreign key requires only an existing session and insert RLS checks only
the set owner ([supabase/migrations/20260825120001_schema.sql:109-124](../../supabase/migrations/20260825120001_schema.sql), [supabase/migrations/20260825120002_rls.sql:60-62](../../supabase/migrations/20260825120002_rls.sql)). Nothing rejects a delayed offline set targeting a discarded session. `v_live_sets` excludes all rows under discarded sessions
([supabase/migrations/20260825140000_planning_voids.sql:47-56](../../supabase/migrations/20260825140000_planning_voids.sql)). A cross-device queue can therefore receive a successful write whose training data is invisible in every supported view and cannot be recovered through the PWA.

### A-206. Outbox enqueue can report failure after the write is already durable

`enqueue` commits its item to IndexedDB, then awaits a status/count refresh before
resolving ([pwa/src/lib/outbox.ts:534-540](../../pwa/src/lib/outbox.ts)); the batch path
has the same order ([pwa/src/lib/outbox.ts:542-553](../../pwa/src/lib/outbox.ts)). If the
post-commit cursor/read fails, callers receive an enqueue error despite the item
already being durable, and flushing is skipped because it follows the failed
await. A user retry can queue a second UUID-backed set, check-in, or bodyweight
entry, while the interface reports the original as lost. This is a failure-after-
commit duplicate path, not a duplicate-tap race.

### A-207. Readiness skip closes the flow even when it was never queued

The skip handler catches an `outbox.enqueue` failure but unconditionally calls
`onSkipped` and closes the sheet afterward
([pwa/src/components/CheckInSheet.tsx:177-194](../../pwa/src/components/CheckInSheet.tsx)). An IndexedDB error creates no `report_prompts` row, yet Today removes the prompt as though the athlete answered "not today." On remount it can reappear, its adherence denominator is absent, and the user was given neither an error nor a retry.

### A-208. A cache-write failure can replace successful live data with stale cache

The shared data reader wraps both server `fetcher()` and `cacheSet` in one
failure branch ([pwa/src/lib/data.ts:140-160](../../pwa/src/lib/data.ts));
session-history loading repeats the pattern
([pwa/src/lib/sessionHistory.ts:46-59](../../pwa/src/lib/sessionHistory.ts)). If the server responds successfully but IndexedDB persistence fails, the catch returns an older cached value as though the network read failed, or throws when no cache exists. A current plan/history response is discarded because local caching failed, producing wrong UI despite a successful authoritative read.

### A-209. Push unsubscribe reports OFF even if server revocation failed

The client catches a failed unsubscribe request, drops the browser subscription,
and returns local `pushState()` as OFF
([pwa/src/lib/push.ts:204-225](../../pwa/src/lib/push.ts)). The server revokes the stored
subscription and cancels alerts only when its update succeeds
([supabase/functions/push-alerts/index.ts:260-275](../../supabase/functions/push-alerts/index.ts)). A network/RLS failure leaves a live server row and scheduled alerts while Settings tells the athlete alerts are off. This is a false-success consent state separate from dead-subscription cleanup in A-72.

## Opportunities and efficiencies

These are optional investments, not disguised fixes. They are deliberately
separate from A-01 to A-209: none justifies deferring data integrity, identity,
consent, or state-machine repairs. Each has a source-visible foundation, a
guardrail, and a measurable outcome.

### Investment order

| Order | Investment | Optimizes for | Gate | Success signal |
| --- | --- | --- | --- | --- |
| 1 | Record reliability | Trust and retention | Release blockers and record-integrity defects contained | No unrecoverable writes or wrong-account reads in production acceptance |
| 2 | First value and plan visibility | Activation and comprehension | Safe, reviewable starter-plan path | Sign-in-to-first-set and first-session completion improve |
| 3 | Weekly review and measured adaptation | Adherence without gamification | Enough rated sets/check-ins and a proposal audit trail | Review completion, proposal acceptance, and next-week adherence improve |
| 4 | Endurance state, calendar, replanning | Combined-training differentiation | E0/E1 quality gates and strength-path invariant | Athlete can understand, confirm, and safely replan a real block |
| 5 | Scale and operational leverage | Lower latency, cost, and maintenance | Baseline p50/p95, payload, query count, and cost measurements | Measured improvement without weaker offline or RLS behavior |

### Athlete workflow and product opportunities

### O-01. Guided first-workout calibration

The empty Train path directs an athlete to Coach or a no-plan session
([pwa/src/screens/Today.tsx:263-279](../../pwa/src/screens/Today.tsx)), while
the documented cold-cache fallback is effectively "start by feel"
([docs/flows.md:57-61](../flows.md)). Build an opt-in starter flow: choose a
goal/equipment, use a small template, log one calibration lift, then show the
next workout. It must create an explicitly unconfirmed proposal and never let
the coach silently write a plan. Measure sign-in-to-first-set, first-session
completion, and median time to first useful plan.

### O-02. In-app plan and phase dashboard

The schema retains an objective, phases, progression, dates, and primary
exercises ([supabase/migrations/20260905060000_training_plans.sql:22-80](../../supabase/migrations/20260905060000_training_plans.sql)), but the decisions log records
that a plan screen is still absent ([docs/decisions.md:2227-2237](../decisions.md)).
Show confirmed objective, current phase, rationale, progression rule, dates,
and draft-versus-confirmed state beside the calendar. This makes today's work
intelligible without turning the active session into a planning form. Measure
weekly plan views, phase-linked starts, and plan-review completion.

### O-03. Closed-loop, explainable progression proposals

The product has per-set RPE and readiness data
([pwa/src/lib/types.ts:184-222](../../pwa/src/lib/types.ts), [pwa/src/lib/types.ts:317-342](../../pwa/src/lib/types.ts)), and the design record calls RPE the missing
autoregulation signal ([docs/decisions.md:1836-1854](../decisions.md)). With
enough observations, propose, never impose, a next action: hold/add load,
reduce volume, alter rest, or ask the coach. Every proposal needs named inputs,
uncertainty, expiry, confirm/override, and an audit row. Conservative thresholds
matter because a wrong recommendation damages trust. Measure RPE completion,
proposal acceptance/override, and subsequent-session adherence.

### O-04. Weekly exception review, not a streak

`v_adherence` already compares prescribed and achieved work
([supabase/migrations/20260825120003_views.sql:72-100](../../supabase/migrations/20260825120003_views.sql)); the weekly summary combines planned/completed days, sets,
tonnage, and sRPE ([supabase/migrations/20260906040000_v_weekly_summary.sql:13-81](../../supabase/migrations/20260906040000_v_weekly_summary.sql)). Use that to
group misses by cause, distinguish deliberate changes from execution variance,
and produce one next action or a coach handoff. Do not render a score or a
punitive streak. Measure review completion, resolved exceptions, next-week
adherence, and notification opt-out.

### O-05. Portable import, restore, and workout interchange

The current export is a paged JSON/CSV archive
([pwa/src/lib/export.ts:1-11](../../pwa/src/lib/export.ts), [pwa/src/lib/export.ts:93-136](../../pwa/src/lib/export.ts)), but there is no importer or restore path. Define a
versioned canonical archive with dry-run mapping, `load_entry`/unit semantics,
provenance, idempotency, and a review before writing. The planning model was
intentionally shaped for a future FIT watch export
([docs/decisions.md:2483-2493](../decisions.md)). Measure successful dry-runs,
zero-loss fixture restores, and manual-mapping rate.

### O-06. A consented, read-only coach review packet

Records are intentionally single-user ([docs/setup.md:408-420](../setup.md)),
while an MCP bearer credential reaches the full user surface
([docs/security.md:8-15](../security.md)). Instead of broad multi-user access,
allow an athlete to create a time-limited read-only packet of selected sessions,
plan phase, adherence, and optionally redacted notes. It requires scope,
expiry, revoke, access audit, and health context off by default. Measure
creation-to-open, time from session end to review, and successful revocation
tests.

### O-07. Hands-busy and adaptive-accessibility modes

Focus mode already reduces training to one exercise and hero value
([docs/flows.md:130-150](../flows.md)), while rest alerts have browser/iOS
constraints ([pwa/src/components/RestTimer.tsx:1-8](../../pwa/src/components/RestTimer.tsx)). Add opt-in large-control, spoken/haptic rest-cue, and voice-confirmed
logging modes with browser capability detection and offline fallback. Voice must
use explicit microphone consent and confirmation, never silent recognition.
Measure task success, correction rate, and time per logged set by input mode.

### O-08. Searchable full training record

History intentionally shows only the most recent 20 sessions and sends older
history to export or Coach ([pwa/src/lib/sessionHistory.ts:35-38](../../pwa/src/lib/sessionHistory.ts)). Add a paged archive with date, exercise, plan, note, and
session-state filters, retaining the lightweight recent view. Use cursor
pagination and freshness labels. Measure time to find a past session,
archive-query p95, and page bytes.

### O-09. Finish manual program authoring where it is useful

The editor can reorder exercises inside a day but still lacks day reordering
beyond swaps and multi-week authoring ([docs/decisions.md:839-864](../decisions.md)).
Add a calendar-level batch editor and minimal multi-week block view, while
keeping Coach/screenshot parsing as the fastest route for complex plans. Require
an atomic edit boundary and draft/confirm diff. Measure self-service schedule
changes completed without coach intervention and plan-edit correction rate.

### O-10. Endurance state and constraint intake before generation

The endurance plan correctly specifies separate aerobic, tissue-tolerance,
strength, and subjective state plus explicit `missing[]` in E2
([docs/endurance-plan.md:132-167](../endurance-plan.md)), followed by race,
environment, availability, equipment, and disruption facts in E3
([docs/endurance-plan.md:169-198](../endurance-plan.md)). Build this foundation
before generating a plan. It prevents fluent output from fabricating capacity;
do not collapse it into a readiness score or finish-time prediction. Measure
state completeness, synthetic missing-data honesty, and athlete corrections to
intake facts.

### O-11. Constraint-checked combined-training blocks

E4/E5 can place efforts in the common day model and generate unconfirmed blocks
that enforce separation, strength-floor, eccentric, taper, and progression
constraints ([docs/endurance-plan.md:250-297](../endurance-plan.md)). Every
decision should cite its rule, and an unreachable target should name the
binding constraint rather than quietly violate it. Measure constraint pass rate,
confirmation rate, and impossible requests returned with an explanation.

### O-12. Replanning after real life changes

E6 proposes backdate-able disruptions, preserves trained history, and re-solves
future work against tissue tolerance rather than just aerobic capacity
([docs/endurance-plan.md:299-332](../endurance-plan.md)). The unit should be a
visible proposal, never an automatic rewrite or passive injury alert. Measure
time from disruption capture to confirmed plan, history-preservation coverage,
and accepted versus overridden replans.

### O-13. Deep activity analysis only after the planning loop proves demand

The roadmap restricts FIT parsing to a compact attached-file tool and rejects a
per-second automatic pipeline ([docs/endurance-plan.md:334-358](../endurance-plan.md)).
E8 adds endurance state to desktop strategy coaching, and E9 makes evaluation a
deployment gate ([docs/endurance-plan.md:360-376](../endurance-plan.md)). This can
be a real trail/endurance advantage only if the manual path sees repeated use.
Measure manual analyses per active athlete, analysis-to-plan-change rate,
storage per activity, and eval pass rate.

### Delivery, cost, and engineering efficiencies

### O-14. Split initial delivery by route and capability

The fresh production build emits one 745 kB minified JavaScript entry (222.51
kB gzip) and an over-500-kB warning. `App.tsx` statically imports every main
screen ([pwa/src/App.tsx:10-16](../../pwa/src/App.tsx)). Lazy-load History
analytics, Plan editing, Coach, export, and uncommon sheets; prefetch only after
the session is safe. Keep active-session functionality resident and offline.
Add CI budgets for initial JS, route chunks, and precache size. Measure cold
installed-PWA time-to-interactive, first-route JS, and offline first-session
success.

### O-15. Consolidate read-heavy screens into measured read models

History exercise selection launches four parallel reads and three further reads
for metadata, adherence, and notes ([pwa/src/screens/History.tsx:239-297](../../pwa/src/screens/History.tsx)). Today reads programs and workouts separately
through its list loader ([pwa/src/lib/data.ts:253-283](../../pwa/src/lib/data.ts)).
Build narrowly scoped authenticated History-detail and Today-week projections or
RPCs that preserve live-view, void, draft, and offline semantics. Profile first:
a broad endpoint costs cache simplicity. Measure requests, bytes, and p50/p95
screen-ready time.

### O-16. Replace scan-and-page analytical reads with server read models

`getLastActuals` may scan up to twenty sequential 1,000-row pages; the History
index separately derives logged exercise IDs and the latest exercise
([pwa/src/lib/data.ts:1393-1408](../../pwa/src/lib/data.ts), [pwa/src/lib/data.ts:1361-1386](../../pwa/src/lib/data.ts)). A `DISTINCT ON` or window-function projection
can return the compact answer with the same ordering/visibility rules. Validate
on a large fixture before optimizing a small log. Measure scanned rows, page
count, cold bootstrap p95, and response bytes.

### O-17. Coalesce reference reads and use bounded stale-while-revalidate

The common cache reader begins a network request and reads IndexedDB only after
failure ([pwa/src/lib/data.ts:140-160](../../pwa/src/lib/data.ts)); it has no
per-key in-flight coalescing or freshness window. Add coalescing and a short,
version-aware stale-while-revalidate policy for exercises, static plan metadata,
and demo instructions, not active-session truth or queued writes. Measure
duplicate requests per navigation, reference-read p95, and stale-read age.

### O-18. Make the exercise catalog cheap without losing offline search

`getExercises` requests up to 2,000 rows
([pwa/src/lib/data.ts:1138-1147](../../pwa/src/lib/data.ts)); Session and History
load it on their own paths ([pwa/src/screens/Session.tsx:374-383](../../pwa/src/screens/Session.tsx), [pwa/src/screens/History.tsx:143-152](../../pwa/src/screens/History.tsx)). Evaluate a versioned compressed static catalog plus
user-custom delta, or a local search index seeded after sign-in. Do not replace
it with server-only search, because offline picker use is a core promise.
Measure catalog bytes, parse time, picker time-to-interactive, and offline
search success.

### O-19. Compact coach context and aggregate quota state

The coach sends retained turns plus fresh context each time
([pwa/src/lib/coach.ts:68-98](../../pwa/src/lib/coach.ts)); context fans out into
memory, week, readiness, symptoms, and plan reads
([pwa/src/lib/coachContext.ts:350-482](../../pwa/src/lib/coachContext.ts)). The
quota path also counts daily use and fetches 30 days for JavaScript reduction
([supabase/functions/coach/index.ts:314-366](../../supabase/functions/coach/index.ts)).
After the coach integrity findings are fixed, add a compact versioned context
snapshot, SQL aggregates, visible context/token budget, and a low-cost factual
mode. Never reuse advice as if it were current state. Measure time-to-first
token, DB reads/turn, input tokens, and cost per useful answer.

### O-20. Tune RLS only from representative query plans

The readiness audit records 97 `auth_rls_initplan` findings
([docs/superpowers/plans/2026-09-12-production-readiness-audit.md:31-35](../superpowers/plans/2026-09-12-production-readiness-audit.md)); policies repeatedly call `auth.uid()`
([supabase/migrations/20260825120002_rls.sql:25-62](../../supabase/migrations/20260825120002_rls.sql)). Convert only benchmarked candidates to `(select auth.uid())`,
one policy family at a time, while preserving cross-user denial coverage. This
is a planner optimization, not a presumed win. Measure p95 authenticated
read/write latency, database CPU, and unchanged RLS rejection tests.

### O-21. Materialize analytics only after view cost is proven

Frequently read views recompute over append-only sets and window functions,
including strength, planning, and readiness projections
([supabase/migrations/20260825120003_views.sql:42-60](../../supabase/migrations/20260825120003_views.sql), [supabase/migrations/20260825140000_planning_voids.sql:62-80](../../supabase/migrations/20260825140000_planning_voids.sql), [supabase/migrations/20260907040000_subjective_capture.sql:444-545](../../supabase/migrations/20260907040000_subjective_capture.sql)). Use `EXPLAIN ANALYZE` and production telemetry first;
then add incremental rollups with visible freshness. This improves scale but
gives up immediate consistency. Measure view p95, database CPU, rollup lag, and
rebuild/failure behavior.

### O-22. Generate and enforce a typed database contract

The PWA client, MCP client, and `scripts/check-selects.mjs` keep separate
database knowledge ([pwa/src/lib/supabase.ts:17-28](../../pwa/src/lib/supabase.ts), [supabase/functions/mcp-server/lib/db.ts:16-20](../../supabase/functions/mcp-server/lib/db.ts), [scripts/check-selects.mjs:37-60](../../scripts/check-selects.mjs)). Generate schema types and parameterize every
client while retaining runtime ownership validation. This catches column, enum,
and nullability drift and removes hand-maintained inventories. Tradeoff:
deliberate type churn on migrations. Measure typed-call coverage and schema-drift
incidents.

### O-23. Share Edge-function operational primitives

Cross-cutting behavior is duplicated: Coach has its own Sentry wrapper because
functions are separate projects ([supabase/functions/coach/sentry.ts:1-4](../../supabase/functions/coach/sentry.ts)), while endurance-sync and MCP separately
implement auth/logging/error paths ([supabase/functions/endurance-sync/index.ts:46-64](../../supabase/functions/endurance-sync/index.ts), [supabase/functions/mcp-server/lib/errors.ts:1-9](../../supabase/functions/mcp-server/lib/errors.ts)). Extract a small versioned Deno package
for request IDs, auth, body limits, redaction, structured logging, and error
capture, with parity tests. This improves consistency but couples runtime
compatibility. Measure duplicated code, common error-field coverage, and
function deploy/test time.

### O-24. Add preventive supply-chain controls

CI covers database validation, Deno, and the PWA
([.github/workflows/ci.yml:11-88](../../.github/workflows/ci.yml)), while secret
safety largely relies on ignore rules ([.gitignore:5-10](../../.gitignore)). Add
pull-request secret scanning, lockfile composition analysis, and an
SBOM/provenance artifact. This is preventive control, not a substitute for the
credential defects in the ledger. Measure scan coverage, true-positive triage
time, and unreviewed severe findings merged to default.

### O-25. Practice recovery, not just migration replay

Deployment guidance relies on append-only migrations and rerunnable deploys
([docs/deploy.md:454-461](../deploy.md)), but defines no verified backup,
restore procedure, recovery-point objective (RPO), or recovery-time objective
(RTO). Establish managed-database backup/PITR settings, run a sanitized restore
drill, and document recovery from a bad migration or service-role write. Measure
last successful restore date, observed RPO/RTO, and quarterly drill completion.

### Opportunities deliberately rejected or deferred

The best version is not the largest one. The product specification rejects social
features, nutrition, and general running data ([docs/spec.md:12](../spec.md)).
The endurance plan rejects readiness scores, ACWR/TSB gauges, injury/finish-time
predictions, and automatic deep-data ingestion before manual use proves demand
([docs/endurance-plan.md:334-390](../endurance-plan.md)). Keep those boundaries.
They prevent intrusive gamification, unsupported medical claims, unreliable
automation, and multi-user permissions from consuming the reliability budget
that makes the core log worth trusting.
