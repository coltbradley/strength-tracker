# Group 01: Database contract

## 1. Scope and evidence

Inspected `supabase/migrations/**`, `supabase/seed/**`, `supabase/config.toml`, `scripts/build-exercise-seed.mjs`, `scripts/validate-db.mjs`, `scripts/check-selects.mjs`, and `scripts/fixtures/**`. Traced the prescription update/delete and activity/session links where needed, plus the CI steps that invoke the owned validators. Read the repo instructions, audit README, active roadmap, release ledger, and relevant older audit leads.

Checks run:

- `node scripts/validate-db.mjs`: passed all checks, including the exercise seed assertions. This exercises the migration chain in PGlite, not hosted Supabase/PostgREST.
- `node scripts/check-selects.mjs`: failed with `supabase/functions/mcp-server/lib/health.ts: mcp_tokens has no column "idexact"`.

## 2. Executive summary

Three confirmed findings: one P1 and two P2. The top risks are a CI-blocking SELECT-checker failure, valid plan edits/deletes that fail when skip history references prescriptions, and accepted NaN values that can corrupt goals, readiness bodyweight, and endurance aggregates. The P1 is the checker failure; the database defects are P2 because they affect bounded workflows and metrics, with user-owned data.

## 3. Findings

### G01-F01. SELECT checker treats PostgREST options as selected columns

- Severity: P1. Confidence: high.
- Trigger: CI runs `node scripts/check-selects.mjs` against the health query that calls `.select("id", { head: true, count: "exact" })`.
- Evidence: `scripts/check-selects.mjs:74-84` extracts all quoted strings from the full `.select(...)` argument and joins them, producing `idexact`. The current invocation fails with the nonexistent `mcp_tokens.idexact` error. CI runs this check at `.github/workflows/ci.yml:23-27`.
- Impact: The current CI workflow fails on every run, blocking the normal release checks despite the selected `mcp_tokens.id` column existing.
- Existing audit/ledger ID: none found.
- Suggested fix boundary: Parse only the first `.select` argument, or otherwise distinguish the column expression from options.
- Verification needed: Run `node scripts/check-selects.mjs` and CI; retain a case with select options and verify unknown literal columns still fail.

### G01-F02. Composite foreign-key SET NULL actions also null the owner key

- Severity: P2. Confidence: high.
- Trigger: A referenced parent is deleted while the child row should retain its owner. For example, deleting a prescription referenced by `session_skips` causes its composite FK action to set both `prescription_id` and `user_id` to NULL. The same shape affects sessions and activities linked to a planned workout, and sets linked to prescriptions.
- Evidence: `user_id` is `NOT NULL` on child tables, e.g. `session_skips` (`supabase/migrations/20260917000000_session_skips.sql:13-20`) and `activities` (`supabase/migrations/20260907030000_activities.sql:17-18`). The composite FKs use unqualified `ON DELETE SET NULL` in `supabase/migrations/20260921020000_parent_fks_and_nan.sql:29-33,41-43,62-64,84-88`. Current validation tests prescription deletion without a skip reference (`scripts/validate-db.mjs:897-912`) and template deletion without a linked session/activity (`scripts/validate-db.mjs:1108-1118`), so it misses this case.
- Impact: A legitimate rewrite of a day’s prescriptions can fail after a skip has recorded a prescription reference; deleting a planned day can fail when retained session or activity rows point at it. These failures leave the requested edit/delete unapplied.
- Existing audit/ledger ID: none found.
- Suggested fix boundary: Restrict SET NULL to the nullable FK column where supported by the deployed Postgres version, or use an equivalent trigger/action that preserves `user_id`; add fixtures for each retained-child case.
- Verification needed: In the migration harness and on the deployed Postgres version, delete a prescription referenced by a skip and a planned workout referenced by retained rows; confirm deletion succeeds and child owner IDs remain unchanged.

### G01-F03. NaN rejection covers only some writable numeric columns

- Severity: P2. Confidence: high.
- Trigger: An owner inserts `numeric 'NaN'` into an omitted column with a lower-bound-only check, or a caller writes it into an omitted positive goal/bodyweight field.
- Evidence: The NaN migration adds guards for set/prescription loads, training maxes, bodyweight log, and session bodyweight only (`supabase/migrations/20260921020000_parent_fks_and_nan.sql:90-100`). Positive-only `goals.target_e1rm_kg` remains unguarded (`supabase/migrations/20260825120001_schema.sql:42-51`); its value feeds `v_goal_progress` (`supabase/migrations/20260825120003_views.sql:112-119`). Lower-bound-only activity measurements remain unguarded (`supabase/migrations/20260907030000_activities.sql:27-40`) and feed weekly sums (`supabase/migrations/20260907030000_activities.sql:249-264`). The subjective readiness `bodyweight_kg` and `alcohol_units` also use only lower bounds (`supabase/migrations/20260907040000_subjective_capture.sql:38,46`); readiness bodyweight is exposed by `v_readiness_trend` (`supabase/migrations/20260907040000_subjective_capture.sql:504-543`). The current NaN test covers only `sets.load_kg` (`scripts/validate-db.mjs:465-476`).
- Impact: A user can persist NaN into their goal percentage, weekly endurance totals, or readiness trend. This produces invalid or misleading derived values while the insert appears valid.
- Existing audit/ledger ID: A-49 is marked `fixed with test` in `docs/roadmaps/release-ledger.md`, but the current mitigation and regression test do not cover these fields.
- Suggested fix boundary: Add finite upper bounds (or equivalent explicit finite-number checks) to every writable numeric field whose existing checks don't reject NaN; expand the database validator across these consumer-facing fields.
- Verification needed: Attempt NaN inserts through the owner role for the goal, activity, and readiness columns and verify rejection; confirm finite boundary values remain legal.

## 4. Opportunities

### G01-O01. Make schema validation coverage track numeric consumers

The current validator is a useful full-chain check, but critical invariants are unevenly exercised: one NaN check covers one column, and cascade tests do not combine parent deletion with retained dependent rows. A compact constraint-driven matrix would reduce the chance that later tables or columns escape an invariant as migrations grow. Cost is additional harness code and fixture upkeep; it should be justified by the number of new database invariants added per release. Evidence needed: enumerate owner-writable numeric columns and FK delete actions against current consumers, then show each class is covered by focused PGlite cases.

## 5. Documentation gaps

- Current claim: the release ledger says A-49 is `fixed with test` (`docs/roadmaps/release-ledger.md`, A-49 row). Desired claim: distinguish the fields covered by the NaN migration and its test from the still-unchecked goal, activity, and readiness numeric fields, or close the gap before marking the item fixed.
- Current claim: the composite-FK migration comments explain tenant scoping but do not call out that unqualified composite `SET NULL` affects both the parent ID and `user_id` (`supabase/migrations/20260921020000_parent_fks_and_nan.sql:1-4,29-33`). Desired claim: document the required owner-key preservation semantics next to these actions.

## 6. Handoffs

- Group 07, MCP gateway: the failing SELECT check is triggered by the health query at `supabase/functions/mcp-server/lib/health.ts:19-22`; the parser fix belongs to this database validation group, while the MCP health query provides the regression input.
- Group 12, endurance: activity NaN values can poison `v_weekly_endurance` (`supabase/migrations/20260907030000_activities.sql:249-264`). The schema guard and validator are reported here; confirm downstream presentation behavior in the endurance pass.

## 7. Open questions and limits

- Static migrations and PGlite cannot establish that the same composite `SET NULL` cases have occurred in hosted data. The finding follows from declared nullability and FK action semantics; confirm against the production Postgres version before choosing syntax for the correction.
- No live Supabase or production database was queried, per assignment scope.
