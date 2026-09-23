# Group 08: MCP plan and exercise tools

## Scope and evidence

Reviewed the MCP plan and exercise paths on `docs/phase-1-plans`. The code revision mapped by the audit README is `38e32d0`; later commits during this review added only audit reports. Read `AGENTS.md`, the audit README, the active roadmap, and release ledger.

Inspected `lib/prescriptions.ts` and its test, plus `confirm_program.ts`, `delete_program.ts`, `exercise_notes.ts`, `find_similar_days.ts`, `get_program.ts`, `manage_exercises.ts` and its test, `repeat_planned_workout.ts`, `resolve_exercises.ts` and its test, `search_exercises.ts`, `set_goal.ts`, `set_training_max.ts`, `training_plan.ts` and its test, `update_planned_workout.ts`, and `upsert_program.ts`. Read the directly relevant security, RLS, parent-FK, plan, exercise-name, and adherence-view SQL and traced the PWA superset grouping dependency.

Checks were static source and line-reference inspection: `git rev-parse HEAD`, `git status --short`, `rg --files ...test`, and targeted `rg`/`nl -ba` reads. Inspected `prescriptions.test.ts`, `manage_exercises.test.ts`, `resolve_exercises.test.ts`, and `training_plan.test.ts`; did not execute tests or call a database, MCP client, or live service. The roadmap keeps Phase 2 blocked on Phase 1 and requires transactional plan replacement; A-84 remains open in the release ledger (`docs/roadmaps/2026-09-19-consolidated-roadmap.md:248-275`; `docs/roadmaps/release-ledger.md:24-28`).

## Executive summary

Ten confirmed findings: five P1 and five P2. The top risks are failed day replacements that make their parked rows block every retry, accepted supersets whose editor and session meanings differ, and plan writes whose separate requests can leave the user without a live strategy or create concurrent duplicate programs. The unbounded plan schema/read path can amplify the latter into persistently incomplete MCP reads.

## Findings

### G08-F01. A failed day replacement leaves rows that make retry collide

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-23.
- **Trigger:** A request fails after staging replacement prescriptions, or while moving staged rows into their final positions, then the caller retries.
- **Evidence:** `update_planned_workout` inserts new rows at `PARK + i`, deletes old rows, then updates staged rows one at a time (`supabase/functions/mcp-server/tools/update_planned_workout.ts:275-309`). It does not clean up or recognize already staged rows on failure. The next call reads every prescription for the day, builds the same `PARK + i` positions, and inserts them again (`:229-237,273-285`); the unique `(planned_workout_id, position)` constraint rejects the duplicate positions (`supabase/migrations/20260825120001_schema.sql:90`).
- **Impact:** A transient failure can turn into a persistent refusal to edit that day. If failure occurs during final positioning, the day can also retain a mixture of final-position and parked rows.
- **Suggested fix boundary:** Replace the multi-request sequence with a transactional database operation, or add deterministic recovery that identifies the exact staged attempt without deleting the prior valid list.
- **Verification needed:** Inject failure after staging, old-row deletion, and each final-position update; retry each case and verify exactly the requested ordered rows remain, including the empty-list clear case.

### G08-F02. MCP accepts non-adjacent superset members that execute as separate work

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-163.
- **Trigger:** A plan write puts another exercise or an ungrouped row between two prescriptions with the same `superset_group`.
- **Evidence:** `assertSupersetGroups` only rejects groups with fewer than two rows; it does not require members to be contiguous (`supabase/functions/mcp-server/lib/prescriptions.ts:184-212`). The Plan editor deliberately gathers all rows with the same group across the day (`pwa/src/lib/sections.ts:75-107`), while the session tags and partner lookup operate on a consecutive run (`pwa/src/lib/entries.ts:491-545,550-581`).
- **Impact:** The editor shows one paired entry while the session loses the pairing or splits it into separate runs. The lifter can perform a different workout from the one reviewed in the plan.
- **Suggested fix boundary:** Enforce one contiguous run per superset group in the shared MCP validator, or align both PWA representations to one explicit storage rule. Keep a single whole-entry ordering rule across writers and readers.
- **Verification needed:** Share non-adjacent, repeated-group fixtures across MCP validation, Plan grouping, and session superset tags/partner behavior; malformed writes must be refused before any database write.

### G08-F03. Concurrent writes can create multiple programs for one phase

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-82.
- **Trigger:** Two `upsert_program` calls for the same phase run before either inserts its program.
- **Evidence:** Each call lists live programs for the phase and chooses the newest only if one already exists (`supabase/functions/mcp-server/tools/upsert_program.ts:337-360`). If both observe none, each follows the new-program insert path and stamps the same `phase_id` (`:397-415`). The schema has only a non-unique index over live phase programs (`supabase/migrations/20260905060000_training_plans.sql:153-168`).
- **Impact:** Two unconfirmed proposals survive for one phase; later calls add days only to whichever duplicate sorts newest, leaving the other live and potentially confirmable.
- **Suggested fix boundary:** Make phase lookup/create and day insertion atomic, with a database invariant or conflict recovery that preserves the one-program-per-phase rule.
- **Verification needed:** Run two synchronized writes against an empty phase and verify there is one target program, all accepted days are accounted for, and a losing/retried call reports the actual target id.

### G08-F04. Concurrent same-name upserts retain both new drafts

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-83.
- **Trigger:** Two same-name parses read the same unconfirmed draft before either writes its replacement.
- **Evidence:** `upsert_program` snapshots old unconfirmed ids, inserts a fresh program, writes its days and prescriptions, and only afterward soft-deletes the ids from that snapshot (`supabase/functions/mcp-server/tools/upsert_program.ts:376-415,475-493`). A concurrent replacement is not in either snapshot, and no live-name uniqueness constraint exists; the migration only makes `programs.id` unique with `user_id` (`supabase/migrations/20260921020000_parent_fks_and_nan.sql:8-13`).
- **Impact:** Both newly written drafts remain live with the same name. The model and user can be shown competing proposals and can confirm either one.
- **Suggested fix boundary:** Serialize same-name replacement or use a transactional database boundary that selects and retires the prior draft and returns the sole new draft.
- **Verification needed:** Race two calls after both complete the existing-row read; assert one live unconfirmed same-name program remains and each caller receives its id or an explicit conflict.

### G08-F05. Training-plan replacement can lose the live plan after a failed recovery

- **Severity:** P1. **Confidence:** medium. **Existing lead:** A-84, open in the release ledger.
- **Trigger:** Phase insertion fails after the old plan has been superseded, and the independent restore request also fails.
- **Evidence:** `set_training_plan` supersedes the existing row before inserting the new plan and phases (`supabase/functions/mcp-server/tools/training_plan.ts:530-586`). Its catch hard-deletes the partial new plan and tries to restore the previous row in a separate request; a restore error is only logged before the original error is returned (`:588-623`). The live-plan partial unique index makes the supersede-first gap necessary today (`supabase/migrations/20260905060000_training_plans.sql:54-58`).
- **Impact:** The user can receive a failed tool result while the app has no live training plan. The catch also hard-deletes the just-written plan row, although the project rule says a revision is superseded, never deleted (`AGENTS.md:540-546`).
- **Suggested fix boundary:** Move supersede/insert/phases into a transaction that preserves the prior live row on failure and retains a recoverable record for an attempted revision, consistent with the plan-history rule.
- **Verification needed:** Fail each write boundary and the compensating path; verify the prior live plan remains readable, no partial plan controls the unique live slot, and failed revision history follows the documented retention rule.

### G08-F06. Confirmed-program deletion treats a caller flag as user approval

- **Severity:** P1. **Confidence:** high. **Existing lead:** A-55.
- **Trigger:** A holder of a valid permanent MCP bearer calls `delete_program` for a confirmed program with `confirm_delete_confirmed: true`.
- **Evidence:** The tool checks the flag and then soft-deletes the program; it has no approval record or confirmation exchange to verify (`supabase/functions/mcp-server/tools/delete_program.ts:39-47,51-82`). The request context only distinguishes the in-app coach's ephemeral token (`supabase/functions/mcp-server/lib/errors.ts:14-27`), and `delete_program` does not call that guard. `docs/security.md` describes a stolen bearer as limited to unconfirmed junk programs and says explicit chat approval keeps plans safe (`docs/security.md:48-60`), which omits this path.
- **Impact:** A stolen bearer can remove the user's active program from every live plan read. The soft-deleted row is recoverable with SQL, but there is no normal product restore path.
- **Suggested fix boundary:** Add an approval mechanism the server can verify for confirmed-plan deletion, or update the security threat model so the bearer’s full write authority and the approval boundary are stated accurately.
- **Verification needed:** With a permanent bearer and no user approval, prove the confirmed plan remains live; then exercise the approved flow and verify it deletes the intended program only.

### G08-F07. MCP exercise edits omit the actor from the shared-library audit trail

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-88.
- **Trigger:** `update_exercise` changes a seeded or edited exercise through the service-role path.
- **Evidence:** The tool builds a patch from mutable fields and updates by exercise id without setting `updated_by` (`supabase/functions/mcp-server/tools/manage_exercises.ts:282-317`). The database trigger uses `auth.uid()` when no explicit actor is supplied (`supabase/migrations/20260905020000_exercise_name_bounds.sql:113-120`); MCP has no `auth.uid()` and that migration explicitly says the tool must stamp the token user (`:92-107`).
- **Impact:** The globally shared exercise can be changed while the audit row loses the responsible account id.
- **Suggested fix boundary:** Stamp `db.ownerId` in this tool's update patch and cover both PWA and service-role trigger behavior without treating the stamp as ownership.
- **Verification needed:** Update a seeded row through the tool harness and read the resulting row with the actor id; verify a no-op still leaves the timestamp and actor unchanged.

### G08-F08. Blank exercise and training-plan names pass MCP validation then fail in SQL

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-89.
- **Trigger:** The caller supplies whitespace for an exercise name, plan objective, or phase name.
- **Evidence:** The relevant MCP schemas use `.min(1)` without trimming (`manage_exercises.ts:101-103`; `training_plan.ts:37-41,449-452`). The database checks trimmed non-empty text (`20260905020000_exercise_name_bounds.sql:36-40`; `20260905060000_training_plans.sql:25,65`). The resulting database error goes through the unexpected-error branch rather than an input `ToolError` (`lib/errors.ts:54-84`).
- **Impact:** A correctable input mistake is reported as a generic server failure, encouraging opaque retries rather than showing the bad field.
- **Suggested fix boundary:** Trim and validate these text inputs at the tool schema boundary, matching the database bounds while keeping database constraints authoritative.
- **Verification needed:** Exercise each whitespace-only input and assert a named validation response with no write request; retain DB tests for direct-write enforcement.

### G08-F09. Plan write size is unbounded and `get_program` can silently truncate it

- **Severity:** P2. **Confidence:** high. **Existing leads:** A-172 and A-173.
- **Trigger:** A valid MCP request contains many workouts or many prescriptions per workout, or a user accumulates a large program.
- **Evidence:** `upsert_program` requires at least one prescription/day but places no maximum on either nested array (`upsert_program.ts:59-62,83-86`). `get_program` reads all workouts and prescriptions without paging or an explicit limit (`get_program.ts:182-210`). PostgREST's 1000-row response ceiling is acknowledged in the paged prescription scan in `find_similar_days.ts:33-35`; the `get_program` result does not mark truncation.
- **Impact:** A large request can persist excessive plan rows, while a later read can omit workouts or prescriptions and present the partial program as complete. Subsequent edits based on that read can overwrite a day without the omitted rows.
- **Suggested fix boundary:** Bound total nested plan size at the write boundary and page or explicitly detect truncation in plan reads, returning truthful incomplete metadata.
- **Verification needed:** Test at, below, and above the accepted total limits, including a program crossing 1000 returned rows; confirm rejection or complete paging, and ensure no partial plan is presented as complete.

### G08-F10. MCP marks one-way plan activation and live day creation non-destructive

- **Severity:** P2. **Confidence:** high. **Existing lead:** A-174.
- **Trigger:** An MCP client relies on tool annotations to decide whether to show a confirmation UI before calling a plan tool.
- **Evidence:** `confirm_program` describes confirmation as one-way but sets `destructiveHint: false` (`confirm_program.ts:22-29`). `repeat_planned_workout` says the new day is immediately live on a confirmed program, yet also sets the hint false (`repeat_planned_workout.ts:101-108`). `confirm_training_plan` likewise activates the plan and calls confirmation one-way while setting the hint false (`training_plan.ts:695-705`). `upsert_program` may add days to a confirmed program after `confirm_change`, but its annotation is false too (`upsert_program.ts:198-208`).
- **Impact:** Clients that use the standard MCP hint can omit or weaken an approval prompt for state changes the tool descriptions say are one-way or immediately live.
- **Suggested fix boundary:** Mark tools according to their live effect, not only their HTTP verb; retain separate user approval gates in the tool behavior.
- **Verification needed:** Inspect tool/list metadata in the MCP protocol harness and assert the client-visible hint for activation and confirmed-program writes.

## Opportunities

None identified. The roadmap defers plan-legibility expansion until beta use; this pass found correctness and recovery work in existing MCP paths.

## Documentation gaps

- `docs/security.md:48-60` says plan confirmation needs human approval and frames a stolen bearer as limited to unconfirmed junk programs, but confirmed-program deletion accepts a caller-supplied flag and has no product restore flow. State the actual bearer capability and approval boundary, or close the gap in the tool authorization path before retaining that claim.

## Handoffs

- **Group 01 (database):** A-82/A-83 need durable uniqueness/atomic-write support if the MCP writer is to serialize by phase and draft name. A-201 and A-202 remain direct-write gaps in `training_plans`/`plan_phases` (`20260905060000_training_plans.sql:54-80,176-193`); MCP's validator cannot protect direct authenticated writes. A-203 also belongs here: owner RLS permits deleting training-max history (`20260825120002_rls.sql:26-29`), and `v_adherence` resolves maxima dynamically by performed date (`20260825140000_planning_voids.sql:90-112`).
- **Group 01 (database) with Group 08:** A-23 and A-84 need transactional write boundaries. The MCP call sequences and their failure consequences are documented above; the database-owned transaction is the route that closes the interruption window.
- **Groups 03/04 (session and PWA planning):** G08-F02 depends on their execution and editor semantics. Group 04 already observed the same A-163 case; use shared fixtures so validator, Plan and Session retain one superset rule.
- **Group 07 (MCP gateway):** For G08-F06, review whether the gateway can provide a verifiable user-approval signal to MCP tools. This report establishes that the current delete tool accepts the flag as sufficient evidence; the permanent-token and request-context trust boundary belongs in the gateway review.
- **Groups 01/04:** A-103 concerns PWA/SQL template conversion and deletion. The inspected MCP tools do not set `is_template`; `update_planned_workout` refuses moving a template to a date and `repeat_planned_workout` refuses templates (`update_planned_workout.ts:185-195`; `repeat_planned_workout.ts:164-170`).

## Open questions and limits

- The concurrency and failure-injection outcomes were derived from independent PostgREST statements and current constraints, not reproduced against a running database. No transaction or network failure was induced.
- No Deno tests, MCP clients, managed Supabase reads, phone, or production service were exercised. `get_program`'s exact server row cap and a live client's use of `destructiveHint` still need integration verification.
- The report evaluates the checked-out source; it does not establish deployed behavior or migration/function parity.
