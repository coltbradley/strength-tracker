# Audit remediation plan

Status: in progress (streams A to G dispatched 2026-10-01). Sources: `docs/audits/2026-10-01-repository-audit.md` and the three `docs/audits/2026-10-01-deployed-ui-audit*.md` passes.

The audit ran at `d5e7b64`. Every finding was then re-checked at `902266d`, after the Version D, load-precision and exercise_prefs merges, by reading current code, re-running the PGlite replays, and executing the real supabase-js client offline for CORE-1. This plan uses the re-checked verdicts only.

## What changed since the audit

- **Fixed by the Version D work (6).** SESS-1 (rating after a correction wrote a stale duplicate), SESS-2 (oversize typed load), SESS-5, SESS-7, SESS-9, SESS-11.
- **Fixed by the train-d merge (1).** PLAN-9 (Today showed only the newest program).
- **Not a bug (1).** MCP-9. The load_kg wording is ambiguous, but code and tests agree.
- **Changed (2).** CORE-1 runs as "cache wiped, shell stays up" in the observed event order, not "Login screen". DB-13 is partly addressed.
- **Still present.** Everything else. No existing migration changed. The two new migrations (`exercise_prefs`, `goals_visible_exercise`) are clean: owner RLS, no grant trap, NaN rejected.

## Is any of it serious?

No P0. Nothing currently loses a logged set, leaks one user's data to another, or breaks logging in production. The outbox, identity hold, append-only and MCP owner-scoping rules all held up under both passes.

Eleven items are worth fixing soon (P1). Each has a real user who will hit it or a security exposure with a one-line fix. Most are effort S.

| Id             | What actually happens                                                                                                                                                            | Who hits it                                                                                      | Why P1                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-3           | `integration_encryption_key()` and encrypt/decrypt are callable by `anon` via `/rest/v1/rpc` (revoked from `public` only).                                                       | Anyone holding the public anon key.                                                              | Secret exposure. Bounded because the ciphertext table is service-role only and endurance sync isn't live, but the fix is one revoke.            |
| DB-2           | Same-day training-max correction and TM delete fail with "permission denied for table users" (invoker trigger reads `auth.users`).                                               | Valentine, any time she fixes a TM.                                                              | Broken core flow in production. validate-db ran it as superuser, so CI stayed green.                                                            |
| CORE-1         | Offline cold start with an expired token: `INITIAL_SESSION(null)` reaches the listeners and `claimCacheFor(null)` wipes the kv cache (plan, active-session pointer, end drafts). | Valentine opening the app in the gym with no signal after an hour away.                          | Plan and resume pointer vanish when there's no network to refetch them. Sets in the outbox survive. Confirmed by executing supabase-js 2.112.4. |
| NEW-CORE-1     | Same start sits on the loading splash for about 25 s while auth-js retries the refresh.                                                                                          | Same.                                                                                            | Looks like a hung app at the rack.                                                                                                              |
| SESS-4         | `getServerSessionSets` returns `[]` on a failed read with no cache, so `setsFailed` never fires and new sets number from 0 over existing ones.                                   | Resume or adopt a session offline with no cached sets. CORE-1 makes "no cache" much more likely. | Violates the "a bootstrap that threw is not an empty log" hard rule.                                                                            |
| SESS-3         | A timed set can be logged at 0 s. The DB check is 1 to 7200, and the outbox admission gate checks load only.                                                                     | Anyone who taps LOG on a hold without setting a time.                                            | Constraint violation means the outbox marks the only copy dead.                                                                                 |
| SESS-6         | `SET_COLUMNS` omits `duration_seconds`. After a reload a timed set reads "0:00", and a correction or rating writes a replacement with a null duration.                           | Any timed set that's corrected or rated after a reload.                                          | Writes wrong data into append-only `sets`.                                                                                                      |
| PLAN-5         | Closing the Training maxes sheet after a change calls `window.location.reload()`, and the gear is reachable on `/session`.                                                       | Editing a TM mid-workout.                                                                        | Loses staged reps, load and note, the same failure the SW rule forbids. Rare but trivial to fix.                                                |
| PLAN-1, PLAN-2 | Duplicating a day drops `set_type`, `section`, `tracking`. Template save drops `superset_group`, `section`, `tracking`, and apply drops `section`, `tracking`.                   | Valentine reusing a structured day.                                                              | Silent shape loss: warmups become working sets, holds become rep sets.                                                                          |
| MCP-3          | Swapping an exercise while today's session is open hits the plan lock (55000). The tool rethrows a bare Error and the coach sees "Unexpected server error".                      | The most common mid-workout coach request.                                                       | The coach can't explain or recover. MCP-2 is the same pattern for 23514.                                                                        |
| MCP-4          | `get_lift_history` builds `.in("set_id", up to 500 ids)`, about 18 KB of URL. The repo already documents a list like this being refused.                                         | Any main lift past about 230 logged sets.                                                        | The flagship history read fails outright. URL limit unverified live, so verify first.                                                           |

Gated pair, not P1 today but must ship together: **INFRA-1** (the cron sweep sends no `Authorization`, and push-alerts deploys with JWT verification on, so the gateway rejects it) and **EDGE-1** (a successful send never sets `sent_at`). Today the sweep does nothing, and nobody misses it because `SWEEP_SECRET` isn't set. Fix INFRA-1 alone and every prompt re-sends every 5 minutes for 6 hours.

## Deployed UI audits folded in

The three browser audits of the deployed `902266d` build (`docs/audits/2026-10-01-deployed-ui-audit.md`, `-deeper-pass.md`, `-transitions.md`) found 21 issues, UI-01 to UI-21. Several are the same defects this audit found from the code side:

| UI id | Same as                | Note                                                                                                          |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| UI-19 | SESS-4                 | Failed session read becomes zero sets, Log enabled, duplicate index. Both audits independently reproduced it. |
| UI-16 | SESS-6                 | Saved sets drop `duration_seconds`; correcting a resumed timed set loses it.                                  |
| UI-04 | CORE-10                | Exports omit duration, RPE and authored load.                                                                 |
| UI-15 | PLAN-10, PLAN-11       | Failed uncached history reads show as empty.                                                                  |
| UI-21 | CORE-8 (set_notes LWW) | A stale cached note overrides a newer server note.                                                            |

The rest are new: UI-01 (Done planning drops an open prescription draft, High), UI-02, UI-03, UI-05 to UI-14, UI-17, UI-18, UI-20. Every one is assigned to a workstream below.

## Workstreams (implementation order and ownership)

These supersede the batch ordering further down for implementation. They are cut by file ownership so the streams can run in parallel worktrees without stepping on each other. The batch text below remains the fix detail.

| Stream                               | Owns                                                                                                                                                      | Items                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Database                          | `supabase/migrations/` (new files only), `scripts/validate-db.mjs`                                                                                        | DB-1, DB-2, DB-3, DB-4, DB-5, DB-6, DB-7, DB-11, DB-13                                                                                                      |
| B. MCP server                        | `supabase/functions/mcp-server/`                                                                                                                          | MCP-1 (updated_by only), MCP-2, MCP-3, MCP-4, MCP-5, MCP-6, MCP-8, MCP-10, MCP-11, MCP-12, MCP-13, MCP-17                                                   |
| C. Edge and infra                    | `supabase/functions/{coach,push-alerts,endurance-sync}/`, `.github/workflows/`, `supabase/config.toml`, `scripts/check-*`                                 | INFRA-1 with EDGE-1 and EDGE-12, EDGE-2, EDGE-3, EDGE-4, EDGE-5, EDGE-8, INFRA-2, INFRA-3                                                                   |
| D. PWA auth and cache                | `useAuth.ts`, `currentUser.ts`, `db.ts`, `outbox.ts`, `fetchWithCache` in `data.ts`                                                                       | CORE-1, NEW-CORE-1, CORE-2, CORE-3, CORE-4, CORE-5, CORE-6, CORE-12                                                                                         |
| E. PWA live session                  | `Session.tsx`, `End.tsx`, `components/session/**`, `TrainingMaxSheet`, set-note code, `getServerSessionSets` and `SET_COLUMNS` in `data.ts`, vitest setup | SESS-3, SESS-4/UI-19, SESS-6/UI-16, PLAN-5, UI-14, UI-20, UI-21, NEW-SESS-1                                                                                 |
| F. PWA plan, train, record, coach UI | `Plan.tsx`, `Today.tsx`/Train, Record/History, `CoachSheet`, `Login`, `export.ts`, `sessionHistory.ts`, template and duplicate code in `data.ts`          | PLAN-1, PLAN-2, PLAN-4, PLAN-6, PLAN-7, PLAN-10/PLAN-11/UI-15, PLAN-14, CORE-10/UI-04, UI-01, UI-02, UI-03, UI-05, UI-08, UI-09, UI-12, UI-13, UI-17, UI-18 |
| G. PWA accessibility and copy        | `Stepper`, `Sheet`, unlabeled form fields, Report copy                                                                                                    | UI-06, UI-07, UI-10, UI-11                                                                                                                                  |
| H. Docs and memory                   | docs, AGENTS.md, auto-memory                                                                                                                              | Batch 8, done last against the merged result                                                                                                                |

Product decision deferred to Colt, not implemented: whether shared seeded exercises stay editable by any account (MCP-1 beyond `updated_by`). INFRA-1 and EDGE-1 land together in stream C; turning the sweep on (secrets, Vault rows) stays a manual step.

## Fix batches

Each batch is one branch and one PR, independently shippable, in this order. Tests named are the AGENTS.md "Tests, by area" suites.

### Batch 1: grants and the TM trigger (migration only, S)

- New migration `2026100102xxxx_audit_grants_and_tm_trigger.sql`:
  - `revoke all on function integration_encryption_key(), encrypt_integration_secret(jsonb), decrypt_integration_secret(bytea), _integration_xor_obfuscate(bytea, text) from public, anon, authenticated;` then re-grant encrypt/decrypt to `service_role` (DB-3).
  - `revoke all on function reserve_coach_turn(...) from anon;` and add `pg_temp` to its search_path (DB-4).
  - Replace the `auth.users` existence check in `refuse_rewriting_used_training_max` with a SECURITY DEFINER helper that has a pinned `search_path`, or with `pg_trigger_depth() > 1` for the cascade case (DB-2). Give `refuse_orphaning_logged_sets` the same cascade short-circuit (DB-1).
- validate-db: add `set role authenticated` cases for TM update and delete, a user-delete case with sets on prescriptions, and a loop asserting that no SECURITY DEFINER function in `public` is executable by `anon` unless allowlisted (DB-13).
- Before merging, run the grant query below in production to confirm the live state matches the replay.
- Verify: `node scripts/validate-db.mjs`, `node scripts/check-selects.mjs`.

### Batch 2: offline boot (PWA, S to M)

- `useAuth.ts` and `currentUser.ts`: ignore `INITIAL_SESSION` with a null session, because `getSession().then` owns that case. Serialize `claim()` so two claims can't interleave (CORE-1, CORE-4).
- Race `getSession()` against a short timeout or `navigator.onLine === false` and fall back to `readPersistedSession()` (NEW-CORE-1). Add the missing `.catch` (CORE-12).
- Session bootstrap calls `getServerSessionSets(id, { orNull: true })` and treats null as failed, so the existing LOG-disabled guard fires (SESS-4).
- Tests: a new `useAuth.test.tsx` asserting the cache survives an offline expired-token boot (port the scratch test from the audit), plus a Session test for the null read. Run `cd pwa && npm run typecheck && npm test -- --run`.

### Batch 3: timed sets and the reload (PWA, S)

- Duration steppers and pad clamp to at least 1. `assertQueueable` also checks `duration_seconds` against 1..7200 (SESS-3).
- Add `duration_seconds` to `SET_COLUMNS` (SESS-6), then run `node scripts/check-selects.mjs`.
- TrainingMaxSheet emits a plan-changed event and refetches instead of `window.location.reload()` (PLAN-5).
- Tests: the outbox gate rejects 0 s, a corrected timed set keeps its duration, and the TM sheet close doesn't reload.

### Batch 4: plan copy fidelity (PWA plus MCP, S to M)

- `duplicatePlannedWorkout`: select and copy `set_type`, `section`, `tracking`, and emit every defaulted column on every row (the bulk-insert hard rule) (PLAN-1).
- `saveWorkoutAsTemplate` and `applyTemplate`: carry `superset_group`, `section`, `tracking` (PLAN-2).
- MCP prescription schema: add `'time'` to `tracking` so `update_planned_workout` can restate a timed day (MCP-10).
- Template use with no program: don't leave a stray draft day (PLAN-4).
- Tests: a round-trip test per path asserting every structural column survives. Run vitest plus the mcp-server deno tests.

### Batch 5: MCP reliability (Deno, S to M)

- Map SQLSTATE 55000 (locked day, open session) and 23514 (TM history) to a `ToolError` carrying the DB hint (MCP-3, MCP-2). Fix the `set_training_max` "same date overwrites" description.
- Chunk `.in()` id lists into batches of about 100 at the four sites (MCP-4). Verify the live limit first with one long `get_lift_history` call.
- Stamp `updated_by = db.ownerId` on `update_exercise` (MCP-1, minimum fix).
- `repeat_planned_workout`: skip empty sessions when finding "last time" (MCP-8).
- Defense in depth: `delete_program`'s confirmed branch, `update_exercise` and `delete_exercise` refuse when `ctx.ephemeral` (MCP-17).
- Decision needed (Colt): should shared seeded rows be editable by any account? With open sign-up and open client registration, any account can rename a seeded exercise for every user's coach. Options: an operator allowlist for shared-row edits, or leave it and rely on `updated_by`. Record the choice in `docs/decisions.md`.

### Batch 6: view correctness (migration, S)

- `v_adherence` back to `app_tz(s.user_id)` (DB-5).
- `working_sets` counts only `reps > 0`, never a `tracking` filter, per the hard rule (DB-6).
- `rep_outcome` null when the prescription's `tracking <> 'reps'` (DB-7).
- `current_date` to `(now() at time zone app_tz(user_id))::date` in `v_trend_digest` and `v_cycle_screen` (DB-11).
- validate-db cases for each, run as service role and as `authenticated`.

### Batch 7: alerts (only when turning the sweep on)

- `supabase/config.toml` gets `[functions.push-alerts] verify_jwt = false`, `deploy.yml` deploys it with `--no-verify-jwt`, and `check-deploy-contract.test.mjs` pins both. Every non-sweep route already calls `auth.getUser`, so the deploy.yml comment claiming this "opens subscribe/schedule/cancel" is wrong (INFRA-1).
- `sendAlertNow` stamps `{ sent_at: now }` on success, with per-row try/catch (EDGE-1, EDGE-12).
- Then set `SWEEP_SECRET` and the Vault rows, and close A-137 and A-138 with the proof the ledger asks for.

### Batch 8: docs and memory (no code)

- README, `docs/security.md:33,43`, `docs/architecture.md:11`, `docs/setup.md:149-151`: describe OAuth sign-in and multi-user auth as shipped (CONTENT-001).
- AGENTS.md: the coach disabled-tool list is six tools, including `confirm_program` (CONTENT-006).
- Roadmap and ledger: migrations through `20261001010000`; Version D is on main, not branch-local (CONTENT-002, NEW-docs-1).
- `architecture.md` write-ownership list: add `goals` and `exercise_prefs`.
- Auto-memory: rewrite `strength-tracker-project` and `strength-tracker-users-and-audit`, fix the Codex worktree path, and index `app-adapts-to-lifter.md`.
- Pin Node 22 locally (`.nvmrc` plus `engines`). Node 26's built-in `localStorage` shadows jsdom and fails two Session.focus tests locally, while CI on 22 passes (NEW-SESS-1).
- Later, separately: trim AGENTS.md (now 1131 lines and loaded every session) by moving incident narrative to `decisions.md`.

## P2 backlog (worth doing, not urgent)

Each has evidence and a fix sketch in the audit appendices.

- **DB.** DB-1 (folded into batch 1), DB-4 (folded into batch 1).
- **MCP.** MCP-5 (newest sets truncated first), MCP-6 (trained variants ranked after an alphabetical cut), MCP-11 (custom id existence leak, non-Latin ids), MCP-12 (bodyweight `to` day excluded, impossible dates), MCP-13 (`get_program` over 1000 rows).
- **Edge functions.** EDGE-2 (intervals.icu local time parsed as UTC), EDGE-3 (stale context replayed in coach history), EDGE-4 (upstream edits never land), EDGE-5 (new provider never backfills), EDGE-8 (failed turns unmetered).
- **Infra.** INFRA-2 (a pwa-only push after a failed `db push`), INFRA-3 (env check accepts a service_role JWT).
- **PWA core.** CORE-2, CORE-3, CORE-5, CORE-6, CORE-10 (export drops load_entry and several tables).
- **PWA plan and coach UI.** PLAN-6, PLAN-7 (coach retry and recovery), PLAN-10, PLAN-11, PLAN-14 (pasted "123 456" code rejected).

## P3, not planned

These are rare, cosmetic, or need a victim's unguessable UUID: DB-8 to DB-12, MCP-7, MCP-14 to MCP-16, MCP-18, EDGE-6, EDGE-7, EDGE-9 to EDGE-11, EDGE-13 to EDGE-15, INFRA-4 to INFRA-7, CORE-7 to CORE-9, CORE-11, CORE-13, SESS-8, SESS-10, PLAN-3, PLAN-8, PLAN-12, PLAN-13, PLAN-15. Reopen any of them if it shows up in Sentry or a user report.

## Production checks to run first (read-only, SQL editor)

```sql
select proname, has_function_privilege('anon', oid, 'execute') as anon_exec
from pg_proc
where proname in ('integration_encryption_key','encrypt_integration_secret',
                  'decrypt_integration_secret','reserve_coach_turn');
```

`true` on any row confirms DB-3 or DB-4 live.
