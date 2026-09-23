# Group 09: MCP analysis, memory, observations, and feedback

## Scope and evidence

Reviewed the assigned MCP read/write tools and colocated tests: `get_bodyweight`, `get_checkins`, `get_checkin_buckets`, `get_injuries`, `get_recent_sessions`, `get_session_diff`, `get_trends`, `get_volume`, `get_week_summary`, `get_goal_progress`, `get_lift_history`, `memory`, `coach_observations`, and `feedback`. Also checked the bodyweight, feedback, observation, and parent-FK migrations, the relevant old audit entries, the active roadmap, and release ledger.

Checks were read-only (`nl -ba`, `sed`, `rg`, `wc`, `git status --short --branch`). No tests or live services were run. The checkout is `docs/phase-1-plans` at `6afe143`, clean and five commits ahead of `origin/docs/phase-1-plans`; static findings below describe this checkout, not deployed behavior.

## Executive summary

Six confirmed findings: 2 P1, 4 P2. The top risks are incorrect date-bounded bodyweight results, accepting invalid observation replacement links/transitions, and response histories that can be cut or grow without a truthful completeness signal.

## Findings

### G09-F01. Bodyweight `to` excludes almost the entire requested end date

- **Severity:** P1. **Confidence:** High.
- **Trigger:** A caller supplies `to: YYYY-MM-DD` to `get_bodyweight`.
- **Evidence:** `measured_at` is a `timestamptz` in the view's source ([migration](../../../supabase/migrations/20260906020000_bodyweight_log.sql:14)). The tool applies `.lte("measured_at", args.to)` directly ([get_bodyweight.ts](../../../supabase/functions/mcp-server/tools/get_bodyweight.ts:80-90)). PostgREST/Postgres compares that date as midnight, so measurements later on the requested `to` date are excluded. The tool also describes the bounds as local dates while applying UTC date literals rather than the user's `app_tz`. The colocated test asserts the raw `lte:measured_at=2026-09-10` filter rather than end-of-day inclusion ([get_bodyweight.test.ts](../../../supabase/functions/mcp-server/tools/get_bodyweight.test.ts:36-49)).
- **Impact:** Requested history omits measurements on its final date, and timezone boundaries can include or exclude measurements on the first date. The returned latest point/count can therefore misstate the selected interval.
- **Existing audit/ledger ID:** None found for this path.
- **Suggested fix boundary:** Filter on an owner-local date exposed by the view, or convert inclusive local dates to a half-open timestamp interval using that user's timezone.
- **Verification needed:** Query fixtures immediately before, at, and after local midnight for at least UTC and a non-UTC zone; assert both inclusive dates and adjacent-date exclusion.

### G09-F02. Volume history can be silently partial

- **Severity:** P1. **Confidence:** High.
- **Trigger:** A user has more than 1,000 exercise-week rows inside an allowed window (up to 104 weeks, optionally across exercises).
- **Evidence:** `get_volume` hard-limits the query to 1,000 rows ([get_volume.ts](../../../supabase/functions/mcp-server/tools/get_volume.ts:107-115)); the response reports only returned-row count and the applied floor, with no truncation/cursor field ([get_volume.ts](../../../supabase/functions/mcp-server/tools/get_volume.ts:117-132)). The test explicitly pins that fixed limit but does not assert any truncation indication ([get_volume.test.ts](../../../supabase/functions/mcp-server/tools/get_volume.test.ts:156-168)).
- **Impact:** An older exercise/week is omitted while the output looks complete, which can distort claims about volume trends or deloads.
- **Existing audit/ledger ID:** A-85 and A-172 (still applicable in current source).
- **Suggested fix boundary:** Add stable keyset/range pagination, or expose and explain a truncation marker and a way to fetch the remaining rows.
- **Verification needed:** Return more than 1,000 fixture rows and verify complete pagination or a truthful, usable continuation signal.

### G09-F03. Standing-memory reads have no response bound

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Repeated `remember` or extraction writes accumulate facts and a client calls `get_memory`.
- **Evidence:** `get_memory` selects every owner's memory row and returns them all, with no `.limit()` or cursor ([memory.ts](../../../supabase/functions/mcp-server/tools/memory.ts:47-60)). Facts are limited individually to 300 characters on the MCP write path, but there is no count cap in this tool or migration. Its colocated test file only covers `update_memory`; there is no `get_memory` bound/completeness test ([memory.test.ts](../../../supabase/functions/mcp-server/tools/memory.test.ts:10-44)).
- **Impact:** The response grows with every standing fact and can exceed a client's/model's useful context. A large accumulated memory also becomes harder to inspect and deduplicate.
- **Existing audit/ledger ID:** A-33 remains applicable to `memory`; coach-context amplification is separately described by A-80 and owned outside this MCP tool.
- **Suggested fix boundary:** Bound and paginate the MCP listing, preserving a clear ordering and continuation signal. Coordinate with the memory lifecycle owner before any row cap or pruning policy.
- **Verification needed:** Seed more facts than one page and verify stable continuation with no missing or repeated rows.

### G09-F04. Feedback text can be stored and returned at arbitrary size

- **Severity:** P2. **Confidence:** High.
- **Trigger:** An authenticated caller supplies very large `detail` or `context`, then lists feedback.
- **Evidence:** `detail` and `context` have no Zod `.max()` ([feedback.ts](../../../supabase/functions/mcp-server/tools/feedback.ts:66-77)); the insert persists them as provided ([feedback.ts](../../../supabase/functions/mcp-server/tools/feedback.ts:81-95)). The database columns are unrestricted `text` ([20260831030000_feedback.sql](../../../supabase/migrations/20260831030000_feedback.sql:10-24)). `list_feedback` returns those full fields for up to 100 rows ([feedback.ts](../../../supabase/functions/mcp-server/tools/feedback.ts:131-142)).
- **Impact:** Oversized rows inflate persistent storage and a bounded row count can still produce an oversized MCP response. This is the same current path described by A-87.
- **Existing audit/ledger ID:** A-87 (still applicable).
- **Suggested fix boundary:** Set explicit per-field limits in the MCP schema and enforce corresponding storage bounds in a new migration; return an actionable validation error.
- **Verification needed:** Cover boundary and over-limit inputs at the tool and database layers, and verify that existing feedback remains readable.

### G09-F05. MCP submissions are mislabeled as Claude provenance

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Any client calls MCP `submit_feedback`, including ChatGPT or another MCP client.
- **Evidence:** The tool hardcodes `source: "claude"` ([feedback.ts](../../../supabase/functions/mcp-server/tools/feedback.ts:81-94)); the existing check constraint only permits `claude` or `user` ([20260831030000_feedback.sql](../../../supabase/migrations/20260831030000_feedback.sql:19-21)). The active roadmap explicitly says new MCP submissions should report `mcp`, preserving historical `claude` rows, before cohort feedback is analyzed by client ([roadmap](../../../docs/roadmaps/2026-09-19-consolidated-roadmap.md), “Confirmed beta model”).
- **Impact:** New ChatGPT and other MCP submissions are attributed as Claude, so the queue cannot support the roadmap's intended client-source analysis.
- **Existing audit/ledger ID:** Roadmap feedback-intake disposition; not listed as a release-ledger row.
- **Suggested fix boundary:** Change the MCP writer to `mcp`; have group 01 extend the database constraint additively. Leave existing `claude` values unchanged.
- **Verification needed:** Tool test asserts the new literal; database validation accepts `mcp` and still accepts old `claude` and PWA `user` rows.

### G09-F06. Observation resolution accepts invalid replacement links and rewrites closed rows

- **Severity:** P2. **Confidence:** High.
- **Trigger:** `resolve_observation` is called with `status: "superseded"` and a self ID, another user's known ID, or a non-newer same-user observation; or it is called again for a row already resolved/superseded.
- **Evidence:** Validation checks only that superseded has some ID and resolved has none ([coach_observations.ts](../../../supabase/functions/mcp-server/tools/coach_observations.ts:46-69)). The update filters the observation being closed by owner, but does not validate the `superseded_by` target's owner, identity, status, or creation order, and does not restrict the source row to `status = 'open'` ([coach_observations.ts](../../../supabase/functions/mcp-server/tools/coach_observations.ts:192-218)). The FK is only `superseded_by references coach_observations(id)`, with no owner-scoped relationship or self-reference check ([20260917010000_coach_observations.sql](../../../supabase/migrations/20260917010000_coach_observations.sql:28-33)). Existing tests exercise presence/absence of the field and owner scope of the source row, but not target ownership, self-link, ordering, or terminal-state updates ([coach_observations.test.ts](../../../supabase/functions/mcp-server/tools/coach_observations.test.ts:19-41, 90-123)).
- **Impact:** A superseded observation can point to itself or a row the owner cannot read; repeated resolution can rewrite a supposedly closed outcome/status. The follow-up graph can become misleading or impossible to follow.
- **Existing audit/ledger ID:** A-119 is marked fixed with test for the follow-up loop, but does not cover these invalid transition/reference cases.
- **Suggested fix boundary:** In MCP, require the source to still be open and verify that the replacement is a different, newer observation belonging to the same owner. Add a composite owner FK/check in a new migration (group 01) so the service-role path cannot bypass the relational invariant.
- **Verification needed:** Test self-link, cross-user target, same/older target, missing target, and repeated resolution; database validation should reject cross-owner references even when bypassing RLS.

## Opportunities

### G09-O01. Make feedback submission retry-safe without fuzzy duplicate suppression

`submit_feedback` inserts a fresh row on every call ([feedback.ts](../../../supabase/functions/mcp-server/tools/feedback.ts:81-95)). The description asks the model to read first and avoid repeat filing ([feedback.ts](../../../supabase/functions/mcp-server/tools/feedback.ts:35-43)), but that relies on model sequencing and cannot distinguish a retry after an ambiguous response from a new submission. A caller-supplied idempotency key could prevent exact retries; it would require a storage contract and should not fuzzy-merge similar requests. Verify with an interrupted/retried MCP call and two intentionally similar but distinct requests before investing.

## Documentation gaps

- `get_bodyweight` says `from`/`to` are local dates, while the implementation compares timestamp values directly with date-only UTC literals ([get_bodyweight.ts](../../../supabase/functions/mcp-server/tools/get_bodyweight.ts:43-60, 80-87)). The description should state the implemented timestamp semantics until the query is corrected; after correction it should name the user's local calendar date.
- `submit_feedback` describes the intake generically, while the writer labels every submission `claude`. The active roadmap requires new MCP writes to identify their source as `mcp`; the stored provenance and the roadmap contract should agree.

## Handoffs

- **Group 01, database:** extend `feedback.source` to permit `mcp` and add a same-owner relationship constraint for `coach_observations.superseded_by`. Current migrations use a global UUID FK for observation replacement and restrict feedback source to `claude`/`user`.
- **Group 08, MCP planning:** A-33 also names `exercise_notes`, whose unbounded listing is outside this report's ownership.
- **Group 10, coach:** A-80/A-81 concern memory growth and failed memory reads in coach extraction/context. G09-F03 covers only the MCP `get_memory` read path.

## Open questions and limits

- This review did not inspect managed PostgREST row-cap settings, so no claim is made about the exact deployed truncation threshold for reads without an explicit tool limit.
- No database, function, PWA, provider, or production behavior was exercised. Static source and test inspection cannot establish deployed migration/function parity or live use of feedback provenance.
- Feedback duplicate prevention currently depends on model behavior; whether the product wants exact retry idempotency across MCP clients is a policy/design choice, so it remains an opportunity rather than a confirmed defect.
