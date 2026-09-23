# Assessment of the 2026-09-23 MECE audit, and a grouped fix plan

This note re-reads the 13 area reports and `SUMMARY.md` on `docs/phase-1-plans`
at `2be4713` against the source those reports claim to describe. That source is
`e74b91d`, which is also `main` apart from these audit files. It is a source
check, not a browser run, a hosted-Supabase run, or a production claim. Where
the original report already said that, this note does not upgrade it.

The audit is a triage package. This note is the working plan: which claims
hold, which are mis-stated, what else is wrong, and which defects should be
fixed together. The eight items that cannot wait are in `MUST-FIX.md`.

## Verdict

The package is mostly true, and it is honest about its limits. The arithmetic
holds: 1 P0 + 39 P1 + 55 P2 = 95 active findings, plus G01-F01 resolved. The
cited files and the behaviors they name are still in the tree. G01-F01 is
actually fixed: `scripts/check-selects.mjs` is no longer the failure described
at discovery, and the health query selects `token_sha256`.

What the package is not:

- It is not a release verdict. No report ran the test matrix, a browser, or a
  deployed project. Several P1s are real source paths whose frequency is
  unknown.
- It is not 95 independent tickets. The summary's "actionable triage by
  boundary" table is the right shape and is too coarse. The clusters below are
  the unit of work.
- It dropped a few real defects into handoffs and then never gave them an id.
  Those are N01–N06 below. They are new relative to the numbered findings, not
  new relative to every sentence in the reports.

Severity labels below are the audit's labels unless a correction says otherwise.

## Claims that hold

Checked by reading the current function, not by trusting the report's line
numbers. Line numbers below are the current file.

| Claim | What the source actually does |
| --- | --- |
| G02-F01, P0 | Fixed. `makePendingItem` stores `user_id: null` when `getCurrentUserId()` is null. `replayable` sends a row only when its owner is a non-empty string equal to the current user. A missing owner and a legacy row with the field omitted are held. `currentUser` seeds that id from this project's persisted session before `getSession()` resolves. |
| G02-F05 | Fixed. `readPersistedSession` reads only `sb-<project-ref>-auth-token` for `VITE_SUPABASE_URL`. Another project's key and the unscoped `supabase.auth.token` name return null. |
| G02-F06 | Fixed for disclosure. `inspect()` returns only the current user's rows. The sheet counts `status.held` and does not render or export another account's payload. `cacheClearAll` still keeps the outbox. |
| G02-F07 | `sync.ts` `update` returns success when PostgREST returns no error. A zero-row update is not an error. `doFlush` then deletes the queue row. |
| G02-F08 | `makeFetchWithCache` puts `cacheSet` in the same `try` as the fetch. A thrown cache write returns the previous cache entry with `fromCache: true`. |
| G02-F11 / G02-F15 | Fixed. After the IndexedDB add, a thrown count is recorded on the outbox status and `flush` still runs. `recordBodyweight` returns once the queue write lands; a later cache failure is reported and does not reject. |
| G02-F12 | `complete` adds `.is("ended_at", null)`. `discard` updates by id only (`data.ts`). `syncOpenSessions` decides from an earlier `listOpen()` snapshot. |
| G03-F01 | Fixed. `logSet` awaits `enqueue` before React state, the cache, and the rest clock, matching the paired-round path. A rejected add is reported and the set is not shown. |
| G03-F02 | `End.tsx` guards finish with `endingRef`. `discard` has no shared lock, and both buttons stay enabled. |
| G03-F03 | `SetEditor` accepts only `"reps" \| "done"`. The normal insert does not write `duration_seconds`. `Session.focus.test.tsx` says duration tracking is unavailable. |
| G04-F01 | `Plan.tsx` `reload` applies `setList` and `setRx` from promises that do not check that `id` is still the route they started for. `reload` is recreated when `id` changes, so the old request is not cancelled. |
| G04-F02 | `Today.useTemplate`, when no program exists, calls `createPlannedWorkout` (an empty dated day) and then `applyTemplate` (a second dated day). |
| G04-F03 | `getPlannedWorkouts` loads every confirmed program, newest `created_at` first, and every workout. `Today` keeps `programs[0]` and filters the list to that id. |
| G01-F02, consequence | Composite FKs in `20260921020000_parent_fks_and_nan.sql` use unqualified `ON DELETE SET NULL` on `(parent_id, user_id)`. Child `user_id` columns are `NOT NULL`. See the correction below for what that does at runtime. |
| G01-F03, schema | NaN guards exist only on the columns listed in that migration. `goals.target_e1rm_kg` is `check (> 0)`. Activity measures and `daily_readiness.bodyweight_kg` / `alcohol_units` are lower bounds only. In PostgreSQL numeric, NaN is greater than every finite value, so `> 0` and `>= 0` accept NaN. `NaN <= ceiling` does not, which is why the existing guards work. |
| G08-F01 | `update_planned_workout` inserts at `PARK + i`, deletes old rows, then updates positions one at a time. A retry rebuilds the same parked positions. `(planned_workout_id, position)` is unique. |
| G08-F02 | `planEntries` groups by `superset_group` across the day (`sections.ts`, and the comment says that is deliberate). `groupRamps` / session partner lookup are adjacency-only (`entries.ts`). `assertSupersetGroups` only requires two members. |
| G08-F05 | `set_training_plan` sets `superseded_at` before inserting the replacement. The catch hard-deletes the new row and tries to clear `superseded_at` in a separate request. Both compensations log and continue. |
| G08-F06 | `delete_program` soft-deletes a confirmed program when `confirm_delete_confirmed` is true. There is no stored approval. The in-app coach has the tool disabled (`coach/index.ts`). A permanent bearer does not. |
| G09-F01 | `get_bodyweight` applies `.lte("measured_at", args.to)` with a date-only string. Postgres compares that as midnight, so the rest of the `to` date is excluded. The filter is not `app_tz`. The colocated test asserts the raw `lte` string. |
| G10-F01, behavior | `record` defaults content logging to on unless `COACH_LOG_CONTENT` is exactly `off`, and stores the latest user text and the answer on `coach_usage`. That text includes the PWA context block. No retention job exists. See the ranking correction. |
| G10-F05 | `reserve_coach_turn` counts `kind = 'turn' and refused is null`. A generation exception is stored in `refused`. Those attempts do not consume the daily cap. Token columns stay at the reservation zeros if `finalMessage()` never returns usage. |
| G11-F01 | `subscribe` upserts any allowed endpoint with no per-user cap. Send paths `Promise.all` every active subscription. Owner insert policy on `push_subscriptions` is shape checks only. |
| G11-F03 | The sweep selects unsent due prompts, pushes, then stamps. Two overlapping invocations can both observe the row unsent. |
| G12-F01 / F02 / F03 / F05 | Adapters request `PAGE_LIMIT` 200 once, with no cursor. `writeActivities` uses `ignoreDuplicates: true` on `(user_id, source, external_id)`. The checkpoint query does not filter `source` and passes one `since` to both providers. Non-array JSON becomes `[]`, and the caller then reports `ok`. |
| G13-F02 | The Pages smoke step saves the body and checks HTTP 200, then prints `github.sha`. It never reads a build id out of the body. The contract test only asserts that `curl` and the literal `github.sha` appear after publish. |
| G05-F06 | Production callers of `duePrompts` / `armPrompt` / `report_prompts` writes are absent outside tests, comments, and the outbox type. |
| G07-F01 | After auth, `handler.ts` calls `req.json()` with no byte cap, then the SDK validates the tool schema. |

The other numbered findings were read in the reports and spot-checked where they
share a function with a row above (outbox retry, coach recovery, observation
update, feedback `source: "claude"`, README OAuth paragraph, deploy workflow
independence from CI). Nothing in that pass showed a fabricated path. They are
not each re-proven line by line in this note. Treat an unchecked P2 as "plausible
and still needing the verification the area report already names," not as
confirmed-fixed or confirmed-false.

## Claims to correct before anyone fixes them

### G01-F02 does not null `user_id`. The parent delete aborts.

Unqualified `ON DELETE SET NULL` tries to null every column of the composite
key. `user_id` is `NOT NULL`, so the child update fails, the statement rolls
back, and the parent row stays. Production will not contain skips or sessions
whose `user_id` was cleared by this FK. What it will contain is a plan edit or
a prescription delete that errors once a `session_skips` row points at that
prescription, or a hard delete of a planned day that still has a session or
activity. The sets trigger already refuses a prescription delete when sets
exist; the skip FK is the case that trigger does not cover.

Do not go looking for orphaned owner-less children. Add a regression that
expects the delete to fail today and to succeed, with `user_id` unchanged,
after the fix. Postgres 15 (what Supabase runs) supports `ON DELETE SET NULL
(prescription_id)`.

Rank stays P2 for a single failed edit. It becomes part of cluster B because a
failed delete in the middle of `update_planned_workout` is how G08-F01's parked
rows get stuck.

### G01-F03 is a real constraint hole. The PWA cannot currently send it.

`JSON.stringify(NaN)` is `null`. The phone's number inputs do not transmit
`numeric 'NaN'`. Zod's `z.number()` allows NaN, and a tool that forwarded it
through supabase-js would persist null, not NaN. The path that works is SQL or
a client that sends the token `NaN` as text for a numeric column. Keep the
schema fix and the validator cases. Do not describe it as something a lifter
can tap into a goal today. A-49 stays "fixed" for the columns it names; the
ledger row should say which columns, not be reopened as if the load guard
regressed.

### G02-F01 is worse than "the next signed-in user," and the code comment denies it.

`replayable` returns true for a missing `user_id` even when `whoAmI()` is still
null. `enqueue` calls `flush` immediately. An ownerless row is sent on that
flush if the Supabase client already has a token, not only after a later
sign-in. The comment in `replayable` says an unknown identity holds. That is
true only for rows that already have a `user_id`. The tests cover "stamped row,
identity later null" and "legacy row with no owner, replay as current." They
do not cover "enqueue while identity is null."

The cross-user case needs a shared browser or an account switch during that
window. The same-user case still mis-labels a brand-new row as legacy, which
is what makes the cross-user case possible. P0 stands.

G02-F05 makes the window wider: the shell can believe a persisted id from the
wrong `sb-*-auth-token` while the live token, if any, belongs to someone else.
Fix them together (cluster A). Practical reach of F05 alone is a reused origin
(local dev across two projects, or a host that stored a second auth key), not
every production phone. The mechanism is not hypothetical.

### G08-F02 is an intentional editor rule that the session does not share.

`sections.ts` says a superset is gathered by letter so the editor can write
drifted members back together, and that the session must render what is stored.
MCP will store a non-contiguous group. Plan then shows one pair. Session runs
separate work until something rewrites the day. The defect is the missing
shared rule, not an accidental gather. A fix that only changes Plan, or only
adds an MCP check without a fixture through Session, will split again.

### G10-F01 is the documented default, plus a missing retention bound.

`AGENTS.md` says the operator can read the conversation and that
`COACH_LOG_CONTENT=off` disables it. Logging on is not a bug relative to that
contract. What the contract does not decide is how long the text lives, or how
an operator proves the production flag without printing it. Keep it as a
product decision with an expiry, not as a code defect bundled into the quota
fixes. Do not null historical rows as part of a coach-recovery PR.

### G13-F01 overstates what a red CI run can ship.

CI and deploy are separate workflows, and `check-deploy-contract.test.mjs`
asserts that deploy does not need CI. That part is true, and A-134 stays open
for the reason the roadmap already gives (billing).

The Pages job itself runs `npm run build` (`tsc -b` and Vite) and
`npm test -- --run` before `peaceiris/actions-gh-pages`. A PWA type error or a
failing Vitest run does not publish. What a red CI run can still ship is a
broken migration chain, a bad `check-selects` result, a failing Deno test, or a
failing `scripts/` contract test. Say that. Do not say "type and test failures"
as if the PWA job were unguarded.

G13-F02 is not overstated. A 200 from a stale Pages site, or from the wrong
`PAGES_URL`, still prints `receipt sha=<intended sha>`. The ledger treats that
line as the production proof for A-135. That proof does not read the served
build.

### G12 is not a strength-beta blocker. Do not promote it by severity count.

Five of the eleven endurance findings are P1, and they are real in the sync
function. No PWA or MCP read of `activities` / `v_weekly_endurance` showed up
in the search the report describes, and `pwa/src/lib/db.ts` still says the
dependency is one-way. Phase 5 stays behind the roadmap gate. Fix the sync
foundation before any connection UI, in one slice (cluster H), not as eleven
tickets and not ahead of cluster A or B.

### Security doc claims that are false now

`docs/security.md` says auth runs before the body is parsed and that the check
is a constant-time compare. `handler.ts` returns OPTIONS, `/health`, and OAuth
metadata before `resolve`. Static-token auth hashes the bearer and looks the
digest up in `mcp_tokens` (`lib/auth.ts`). G07 already notes the README version
of the constant-time sentence. The security model says it too.

The same page says a stolen bearer writes unconfirmed junk programs and that
confirmation keeps the active program safe. `delete_program` with the caller
flag, `update_planned_workout` / `upsert_program` with `confirm_change`, and
`repeat_planned_workout` on a confirmed program all change live plan state.
The in-app coach has `delete_program` off. Permanent tokens do not. G08-F06
covers deletion only. The threat-model paragraph has to cover the other live
writes or the tools have to grow a server-checked approval. Writing the
paragraph without the gate leaves the false claim in place.

## New findings

These were not given a `GNN-FNN` id. N01 and N02 are sharpenings of findings
above; the rest were handed off or not filed.

### N01. History drops offline work the session screen keeps

The expanded day now merges `outbox.pendingSets` with `getServerSessionSets`
and still subtracts `pendingVoidIds` (`pwa/src/screens/History.tsx`). A queued
set on a session the list already shows appears once. `getSessionLog` still
requires `ended_at` on the server and only subtracts pending discards
(`sessionHistory.ts`), so a session finished only on this device stays off
the list until that close flushes. Group 05 named the set half as a handoff
to group 02 and did not number it.

Severity P1. Confidence high for the source path. Verification: log a set and
finish while offline, open History, and see that session and those sets; after
replay, one copy, voids still hidden.

### N02. The plan editor cannot author `tracking: "time"`

`Plan.tsx` offers reps and done only. Combined with G03-F03, the phone can
neither prescribe nor log a hold or a carry. MCP can still write
`tracking: "time"`. The hard rule in `AGENTS.md` describes a path the PWA does
not implement on either side. Fixing only the session logger leaves coaches
and the plan editor unable to enter the thing the logger just learned to save.

Severity P1, same as G03-F03, one fix (cluster D).

### N03. Cross-source activity dedupe is check-then-insert

`mark_duplicate_activity` (`20260907030000_activities.sql`) selects a match and
assigns `duplicate_of` with no lock and no unique constraint across sources.
Two concurrent syncs can both observe no match and both insert live rows.
Group 12 handed this to group 01 as A-45. Group 01 did not file it. G12-F02
(apply provider corrections) will write the wrong row if both copies stay
live. Do the constraint or the lock in the same change as correction updates,
not after.

Severity P1 inside the endurance slice, not for the strength beta. Confidence
high for the race window, medium for how often two providers sync together
today (nothing schedules them).

### N04. `complete` does not notice a session that was discarded

`complete` filters `ended_at is null` and does not filter `discarded_at is null`
(`data.ts`). Views hide a row once `discarded_at` is set, so this does not put
the session back on the calendar. It does write `ended_at` onto a discarded
row, and it shares the zero-row blindness of G02-F07: the caller cannot tell
that the update matched nothing. Fold the predicate into the terminal-state
fix. Do not ship a discard guard that leaves complete able to stamp a
discarded session.

Severity P2. Confidence high.

### N05. Allowlisted push hosts accept a non-default port

`isAllowedPushEndpoint` requires `https` and an allowlisted hostname. It does
not read `url.port`. `https://fcm.googleapis.com:8443/...` passes
(`push-alerts/lib/endpoint.ts`). Group 11 saw this and refused to call it an
SSRF bypass, which is right: the host is still the provider. It is still an
unbounded connection to a non-default port on that host, next to G11-F01's
unbounded fanout. Reject a non-empty port in the same change as the fanout cap.

Severity P2. Confidence high for the accept, low for a useful attack. No
provider corpus was checked.

### N06. Coach eval export interpolates `--user` into SQL

`scripts/coach-eval/fetch-turns.mjs` builds a SQL string from the flag. Group
10 filed this as an opportunity because it is a local operator tool. The
script's own README says to ask the person first, and the script does not
check that the argument is a UUID. A shell-sourced value changes the query and
can export another transcript. Validate a UUID and refuse anything else before
invoking the Supabase CLI. This stays a small script fix, not a web
vulnerability.

Severity P2 for an operator footgun. Confidence high.

## Grouped fixes

Work the clusters in the order below. Inside a cluster, one owner and one
verification fixture. Do not split a cluster across "PWA bug" and "MCP bug"
when the fixture has to pass through both.

A finding not listed here is still real. It is a single-screen change that
does not need to wait: G04-F06 (dumbbell default), G04-F07 (Plan return
route), G06-F02 through G06-F07 (toasts, titles, sheets, unknown routes, icon
base path, settings persist result), G03-F04 and G03-F05 (draft loss, double
tap), G05-F02 (bodyweight correction UI), G09-F05 (feedback `source`),
G08-F07 and G08-F08 and G08-F10 (audit stamp, whitespace names, destructive
hints), G13-F03 (README OAuth). Land those as small PRs. They are not the
plan.

### Cluster A. One owner on the device

Findings: G02-F01, G02-F04, G02-F05, G02-F06. N01 waits on this only for the
identity stamp; the History merge itself is cluster C.

Why together: the boot path can render from a persisted id, enqueue with no
`user_id`, flush under whatever token the client has, and show another
account's queue payloads. Fixing the stamp without the storage-key match, or
hiding the sheet without fixing the stamp, leaves the append-only write.

Fix:

- While `getCurrentUserId()` is null, do not enqueue a replayable row. Either
  refuse the write with a visible retry, or store an explicit pending owner
  that `replayable` will not treat as legacy. Legacy rows already in IndexedDB
  need a one-time rule: replay only when a single persisted project key matches
  the configured project, and record that decision. Do not keep "missing
  user_id means current user" for rows created after the fix.
- `readPersistedSession` may return only the key for the configured project
  ref. Wrong project, missing key, and unreadable storage all return null.
- Cache claim finishes before account-scoped reads. Overlapping claims cannot
  clear the new account's cache.
- Outbox inspection and export show the current owner's payloads. Other
  owners remain as a count. Flush still holds them. Retry still ignores them.

Verification: two accounts, one origin, auth delayed past a log tap; two
`sb-*-auth-token` keys in both orders; outbox export under each; reload does
not send the other person's set. The existing "legacy row replays as current
user" test has to change or it will forbid the fix.

### Cluster B. A session ends once, and a logged set exists before it is shown

Findings: G03-F01, G03-F02, G03-F06, G02-F07, G02-F11, G02-F12, G02-F15, N04.
Database terminal uniqueness stays a group-01 follow-through, not a substitute
for the client lock.

Why together: the screen shows a set before IndexedDB commits; a later
post-commit error looks like failure and invites a second UUID; finish and
discard can both queue; a zero-row update is deleted from the only queue; a
discard decided from a stale snapshot can hide a session another phone
completed.

Fix:

- Landed: single-set log awaits the outbox add, then shows the set.
  `enqueue` / `enqueueBatch` treat the add as the result and schedule flush
  even if the count read fails. `recordBodyweight` does the same for its
  cache write. History's open day merges the queued set once.
- One synchronous terminal lock for finish and discard. The buttons show it.
- `update` asks for a count or a returning row. Zero rows stay in the queue
  with a visible cause, not a delete. `discard` and `complete` both require
  the session still open (`ended_at` and `discarded_at` null). Zero rows mean
  the other device won.
- Session bootstrap includes `pendingVoidIds()` even when the void cache write
  failed.

Verification: fault the add, the post-add read, and the cache write separately.
Interleave finish and discard. Interleave another device's complete between
`listOpen` and discard. Reload after a void-cache failure and the set stays
hidden. One row in `sets` per tap.

### Cluster C. Reads say whether they are complete

Findings: G02-F08, G02-F09, G02-F10, G05-F03, G05-F04, G05-F05, N01, G08-F09,
G09-F01, G09-F02, G09-F03.

Why together: several screens treat a capped, stale, or failed read as the
whole answer. The pattern is one: a successful payload stays authoritative if
the cache write fails; a response started before an invalidation cannot
repopulate the key; an error is not an empty list; a cap is either paged or
marked incomplete. The call sites are different PRs. They should share the
helper and the words, or History, Plan, and MCP will each invent a flag.

Do not fold coach context (G10-F08) into the PWA cache helper. Same idea
(empty is not the same as failed), different stack. Fix it beside cluster F.

Date bounds for `get_bodyweight` are this cluster's MCP half: inclusive local
dates in `app_tz`, half-open timestamps, fixtures around midnight in UTC and
one other zone. The current test asserts the bug. Change the test first.

### Cluster D. Timed work, both doors

Findings: G03-F03, N02.

One change: Plan can set `tracking: "time"`, Session writes `duration_seconds`
with reps 0 and total `load_kg`, overview and focus and superset all do it.
Re-open shows the seconds. `v_e1rm` and `v_weekly_volume` stay on their
existing filters. No new completion table.

Verification: unloaded hold and weighted carry, plus a plan round-trip that
stores `time` rather than a note that says "45 seconds."

### Cluster E. One plan write, one superset rule, one visible program

This is three PRs that share fixtures. Do not start the second before the
first's fixture exists, or the tests will encode today's split.

**E1. Adjacency contract.** G08-F02, G04-F04, and the Plan/Session handoff.
One ordering rule: a superset group is one contiguous run, a ramp is
consecutive same-exercise rows, a section change is one operation. MCP rejects
a non-contiguous group before any write. Plan and Session render that fixture
the same way. Section rename, dissolve, and reorder are one recoverable
operation: wholly applied, or the editor reloads the stored day and says so.
PostgREST has no transaction. A database function is the clean boundary;
a client sequence needs an explicit reconciliation state, not a silent partial
apply. G04-F01 (late response paints another day's rows, and a save can write
them) is the same editor generation bug. Put the generation guard in E1 so a
section rewrite cannot land on the wrong day.

**E2. Interrupted replacement.** G08-F01, G08-F03, G08-F04, G08-F05, G01-F02.
Parked prescription rows, duplicate phase programs, duplicate same-name
drafts, and a superseded training plan whose restore failed are one class:
several requests, a uniqueness rule that is checked too late, and a retry that
makes it worse. G01-F02 is in here because a skip FK abort is one of the
failures that leaves parked positions. Prefer one SQL function per operation
(replace day, upsert program into a phase, replace training plan) that keeps
the previous live row when the new write fails. The training-plan catch must
stop hard-deleting the attempted revision; supersede it or leave it
unconfirmed and not live. The partial unique index is why the code supersedes
first. The function can do both inside one transaction, which PostgREST
cannot.

**E3. Which program Today shows.** G04-F03 only. The read already returns
every confirmed program. Today throws the rest away. A program choice that
survives reload is enough. This is not the Phase 4 dashboard.

Also in E2's verification, not as new product scope: G04's handoff that
duplicate / save-template / apply-template drop `section`, `tracking`,
`superset_group`, or `load_entry` (`data.ts`). A day copied through those
paths will not match the E1 fixture. Fix the column lists in the same change
as the template seed-day bug (G04-F02), because both are "applying a saved day
produces a different day."

G08-F06 and the security.md paragraph are a decision, not part of E2. Either
the server stores an approval the tool can check, or the threat model states
that a permanent bearer may delete and edit confirmed plans. Do not "fix" it
by trusting the flag the caller already sends.

### Cluster F. Coach recovery and the budget

Two PRs.

**F1. The sheet.** G10-F02, G10-F03, G10-F04, G10-F09, G10-F10. Recovery
targets the turn id, not "whatever the last message is now." Stop does not
forget that the server may still finish. EOF without `done` leaves a finite
state. Retry of an attachment does not send empty bytes under the old file
name. Status is announced without reading every token. These are one component
test file.

**F2. The ledger.** G10-F05, G10-F06, G10-F07, G05-F07. An admitted turn that
then fails still counts as a daily attempt. Record provider usage when the SDK
actually returns it; do not invent tokens the SDK did not. Check-in extraction
reserves budget before the model call, or concurrent batches near the cap will
all pass. A claim stamp expires so a dead worker does not eat the note.
`checkinMemory.ts` retries a non-2xx instead of dropping the `Response`.
G10-F08 (memory read error rendered as no memory) ships with F1 or F2,
whichever touches `coachContext.ts` first, and must not wait.

G10-F01 stays out of both PRs until someone writes the retention decision:
what is stored, for how long, and how production config is shown without
printing the secret. G10-O01 (coach tool allowlist) is worth doing the next
time the connector tool list changes, not as a bugfix.

### Cluster G. Push, after deciding whether prompts exist

G05-F06 is the missing caller. G11-F02 through G11-F05 are what happens after
a row exists. Building sweep leases for prompts nothing arms is wasted, and
arming prompts on top of a double-send sweep is worse.

Order:

1. Decide, in the roadmap, whether weekly and next-morning prompts are in
   this phase. The audit is right that the pure functions are not a shipped
   flow.
2. If yes: one flow creates the `report_prompts` row, answers or skips it
   offline, and replays once (G05-F06). Then the sweep claims a row before the
   push, retries rest inside its useful window, and a failed cancel undoes the
   row it just inserted (G11-F02, F03, F04, F05).
3. If no: say so in `prompts.ts` and `push.ts`, and still fix rest-alert
   retry and the claim race, because rest timers are armed from Session today.

G11-F01 and N05 are the cap and the port check, independent of prompts.
G11-F06 (exercise name on the lock screen) is a copy default, separate.

### Cluster H. Endurance sync, still not Phase 5 product

Findings: G12-F01, F02, F03, F04, F05, F10, N03. Then F06, F07, F08, F09, F11
as the same function's guards, not a second project.

Page each provider or return an incomplete status. Corrections update
source-owned columns and leave RPE, name overrides, planned-workout link, and
`discarded_at` alone. Checkpoint per source. A checkpoint error does not
become a 400-day backfill. A non-array body is a failure. Strava either
refreshes or the setup doc stops implying it does. N03 lands before
correction writes.

G12-O01 and G12-O02 (connection UI, scheduler, CORS) stay behind the Phase 5
gate. Do not start them in this plan.

### Cluster I. Release proof

G13-F02, the narrowed G13-F01, and the leftover G01-F01 verification (CI and
deployed `/health` on the integrated tip, not another local `check-selects`).

The smoke step compares a build id embedded in the served HTML or asset with
`github.sha`, and it fails closed on a mismatch without printing a receipt.
The contract test feeds a 200 body with the wrong id and expects failure.

A-134 stays an explicit exception until a required check can run: name the
jobs that are not gated (database validators, Deno, `scripts/` tests), not
"CI" as a blob. PWA build and Vitest already gate Pages.

## What not to do with this

- Do not mark ledger rows fixed from this note. A-49, A-135, and A-119 are
  examples where "fixed with test" is narrower than the sentence in the
  ledger. Update the ledger when the regression for the remaining columns or
  the served SHA exists.
- Do not file the 95 findings as 95 issues. Clusters A, B, and E1 are the
  ones that can corrupt or hide training. C, D, and F1 are the ones a lifter
  hits without a second account. G and H wait on a product decision the
  roadmap already deferred.
- Do not treat endurance P1s as ahead of the outbox P0 because there are more
  of them.
- The original reports' "open questions" still stand: production allowlist
  (A-02), live alert sweep (A-137/A-138), encryption migration applied
  (A-159), measured OAuth revoke latency, and whether a real provider keeps
  `external_id` when it edits an activity. This note does not answer them.
