# Repository audit, 2026-10-01

> Ran at `d5e7b64`, re-verified at `902266d`. Current verdicts and priorities live in the re-verification appendices and in `docs/superpowers/plans/2026-10-01-audit-remediation.md`. The original summary below predates the re-check: SESS-1, SESS-2, SESS-5, SESS-7, SESS-9, SESS-11 and PLAN-9 are since fixed, and MCP-9 is not a bug.


## Scope pin

- Repo: strength-tracker, `main` at `d5e7b64`. Untracked `docs/audits/2026-10-01-*` ignored as inputs.
- Read-only. No repo files changed. Worktrees (`.worktrees/`, `~/.codex/worktrees`) excluded.
- Environment: local macOS, PGlite replay of the full migration chain, Deno and Vitest suites. No live Supabase reads (a read-only grant query against production was blocked by the permission classifier; see "Needs your hands").
- Method: 9 Sonnet auditors, one per domain, each with one owner and its own report (appendices below). The lead re-checked the high items against source.

## Check ownership

| Domain                               | Owner (report)               | Coverage                                            | Exclusions                                                 | Status                                                                |
| ------------------------------------ | ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Schema, RLS, grants, triggers, views | DB (`db.md`)                 | all 60 migrations, latest defs; PGlite replays      | live Supabase grants                                       | tested: validate-db pass, check-selects 474 cols pass                 |
| MCP server                           | MCP (`mcp.md`)               | every tool, lib/auth, lib/oauth, dates              | coach allowlist, view SQL                                  | tested: deno check + 187 tests pass                                   |
| Coach, push-alerts, endurance-sync   | EDGE (`edge.md`)             | all three functions                                 | live provider payloads                                     | tested: 41 + 10 + 6 tests pass                                        |
| PWA offline core                     | CORE (`pwa-core.md`)         | outbox, sync, db, auth, cache, SW                   | browser runtime                                            | tested: typecheck + 687 tests pass                                    |
| PWA session/end                      | SESS (`pwa-session.md`)      | Session.tsx core paths, End, corrections, load libs | SetSchemeSheet, PlateSheet, FocusDeck, Session render/swap | tested: 483 tests, 1 flaky (SESS-11)                                  |
| PWA plan/today/history/coach UI      | PLAN (`pwa-plan.md`)         | Today, Plan, History, coach UI, calendar            | Plan row editor, drag, sections.ts, Settings, charts       | tested: 204 tests pass                                                |
| CI, deploy, scripts, deps, secrets   | INFRA (`infra.md`)           | workflows, scripts, audits, build                   | live Actions runs                                          | tested: 28 node tests, build, npm audit 0 vulns, no committed secrets |
| Docs structure + .claude config      | STRUCT (`docs-structure.md`) | all docs, links, index, settings                    | Codex worktrees                                            | done, 7/10                                                            |
| Docs content + memory                | CONTENT (`docs-content.md`)  | claims vs code, plans, ledger, memory               | full line-by-line of AGENTS.md                             | done, 6.5/10                                                          |

## Tally

| Area       | Critical | High                 | Medium | Low |
| ---------- | -------- | -------------------- | ------ | --- |
| DB         | 0        | 3                    | 4      | 6   |
| MCP        | 0        | 0 (MCP-1 downgraded) | 10     | 7   |
| EDGE       | 0        | 2                    | 6      | 7   |
| CORE       | 0        | 1                    | 4      | 8   |
| SESS       | 0        | 1                    | 3      | 7   |
| PLAN       | 0        | 0                    | 6      | 9   |
| INFRA      | 0        | 0                    | 3      | 4   |
| Code total | 0        | 7                    | 36     | 48  |

No cross-user read leak in MCP, no XSS path (no `dangerouslySetInnerHTML`, markdown renders no links), no committed secrets, no write path from MCP to `sets`/`sessions`. The outbox identity, ordering and SW update rules all held.

## Fix first (ranked, lead's judgment)

1. **DB-3, vault key callable by anon.** `integration_encryption_key()` and encrypt/decrypt only `revoke ... from public` (`20260921030000:96-98`). Supabase's default privileges grant EXECUTE to `anon` and `authenticated` explicitly, so the public anon key can call `rpc/integration_encryption_key`. The repo already knows this trap (`20260905030000` revokes from `public, anon, authenticated`). Confirmed in PGlite with Supabase-style defaults. Production state unverified.
2. **DB-2, training-max edit and delete broken in production.** The A-203 trigger (`20260924200000:27-29`) is SECURITY INVOKER and reads `auth.users`, which `authenticated` cannot select. Same-day TM correction and TM delete from the PWA (`data.ts:1134,1147`) return "permission denied for table users". validate-db runs the case as superuser, so it passed.
3. **SESS-1, rating a set right after correcting it writes a stale duplicate live set.** `saveCorrection` (`Session.tsx:1810`) never updates `lastLoggedSet`, so `rateLastSet` (`:1903`) re-voids the old row and inserts the pre-correction load and reps at the same index. Two live rows, permanent, because `sets` is append-only. Lead confirmed by reading.
4. **CORE-1, offline cold start with an expired token shows Login and wipes the cache.** auth-js 2.112.4 emits `INITIAL_SESSION(null)` when `getSession()` errors (`GoTrueClient.js:3658`). Both `useAuth` and `currentUser` listeners accept the null, bypassing the persisted-session fallback, and `claimCacheFor(null)` clears `activeSession`. That's the exact basement-gym case the hard rules describe. Lead confirmed against the library source.
5. **SESS-4, failed server-set read is swallowed.** `getServerSessionSets` returns `[]` with no cache instead of throwing, so `setsFailed` is never set and a resumed session numbers sets from 0 over existing ones. This violates a stated hard rule.
6. **SESS-2 and SESS-3, sets that can never sync.** A 5-digit load typo overflows `numeric(6,2)` because `enteredLoad` is stored raw. A 0-second timed set violates `duration_seconds between 1 and 7200` (`20260906030000:40`). Both are constraint violations, which the outbox treats as permanent, so the only copy of the set goes dead.
7. **INFRA-1 plus EDGE-1, the alert sweep never runs, and fixing that alone would spam.** push-alerts deploys with JWT verification on, and `run_alert_sweep()` sends only `x-sweep-secret`, so the gateway rejects it before the function's own check. Separately, `sendAlertNow` stamps `{}` on success (`push-alerts/index.ts:486`), never `sent_at`, so once the sweep works each prompt re-sends every 5 minutes for 6 hours. Ship both fixes together. Likely explains why A-137/A-138 never got live proof.
8. **DB-1, account deletion fails** for anyone with sets logged against a prescription (`prescriptions_keep_logged_history` fires mid-cascade). Reproduced.
9. **DB-4, `reserve_coach_turn` callable by anon** with any user id, so a known UUID can be locked out of the coach.
10. **EDGE-2, intervals.icu `start_date_local` parsed as UTC** (`providers.ts:70`), which breaks cross-source dedup with Strava. Format assumed from API knowledge.
11. **PLAN-1 and PLAN-2, copying a day or template drops structure.** `duplicatePlannedWorkout` (`data.ts:419`) omits `set_type`, `section`, `tracking`, so warmups become working sets and timed rows become reps rows. Template save/apply drops superset/section/tracking. MCP-10 is the same loss through `update_planned_workout`.
12. **PLAN-5, TrainingMaxSheet calls `window.location.reload()`** on close. If it's reachable mid-session it discards staged input, which is the same failure the SW rule forbids.
13. **DB-5 to DB-7, view correctness.** `v_adherence` regressed to `app_tz()` (caller tz) in `20260924003054`. Tick and timed sets count as working sets in four views and as `missed` in `rep_outcome`, which the coach reads.
14. **PLAN-6 and PLAN-7, coach retry and recovery.** Retry sends a duplicate turn, and "still running" is treated as interrupted, so asking again double-bills.
15. **INFRA-2 and INFRA-3.** A pwa-only push after a failed `db push` ships the client over unapplied schema. `check-pwa-env` accepts a service_role-shaped JWT as the anon key.

Everything else (medium and low) is in the appendices with location, evidence, confidence and verification path.

## Overlap ledger

| Kind                 | Items                                          | Note                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linked, distinct     | INFRA-1, EDGE-1, ledger A-137/A-138            | Same feature. INFRA-1 blocks delivery, EDGE-1 causes duplicates once delivery works.                                                                                                                               |
| Linked, distinct     | DB-2, MCP-2                                    | Same trigger (`20260924200000`). DB-2 is a permission error for `authenticated`; MCP-2 is a correct refusal surfaced as a generic error and a wrong tool description.                                              |
| Linked, distinct     | PLAN-1, PLAN-2, MCP-10                         | Same failure (structure lost on copy or restate), three code paths.                                                                                                                                                |
| Linked, distinct     | DB-6, DB-7, SESS-3, SESS-6                     | Tick and timed set handling: counted wrongly in views, zero duration rejected, duration not read back.                                                                                                             |
| Linked, distinct     | CORE-1, CORE-2                                 | Both from auth-js behaviour on a failed refresh: identity lost (CORE-1), anon reads cached as empty (CORE-2).                                                                                                      |
| Merged               | STRUCT-001, CONTENT (AGENTS.md size)           | AGENTS.md is 949 lines and loads every session; about 68% is rule history.                                                                                                                                         |
| Merged               | STRUCT-006, CONTENT (untracked audits)         | The two 2026-10-01 UI audits aren't committed or linked.                                                                                                                                                           |
| Merged               | CONTENT-001, memory `strength-tracker-project` | Both still say OAuth is unbuilt and MCP is pinned to one user.                                                                                                                                                     |
| Downgraded           | MCP-1 high to medium                           | Desktop keeping `update_exercise` on the shared library is a documented choice. The real defect is that the MCP path never writes `updated_by` (`manage_exercises.ts:311`), so a shared rename has no audit trail. |
| Known, still present | A-43, A-44, A-48, A-75, A-134, A-156           | Re-observed, not re-counted.                                                                                                                                                                                       |

## Docs and config (docs-curator audit mode)

Structure 7/10, content 6.5/10. AGENTS.md checked out accurate on every spot-check, and every regression test named in the ledger exists.

- **Must do.**
  - README, `docs/architecture.md:11`, `docs/security.md:33,43` and `docs/setup.md:149-151` still say OAuth is unbuilt and MCP is single-user.
  - The roadmap and ledger are frozen at 2026-09-24. They miss the 2026-09-30 load and unit work, and no decisions entry exists after 09-24.
  - AGENTS.md lists 3 coach-disabled tools; the code (`coach/index.ts:1162-1181`) disables 6, including an undocumented `confirm_program`.
- **Should do.**
  - Tool counts disagree across READMEs (22, 14, 41; code has about 41).
  - Plan files carry unticked boxes for merged work, and there's no index for audits, plans or the design-log.
  - The tunnel relay is documented as live although OAuth superseded it.
  - `.claude/settings.local.json` allows `git push *` and `gh repo *` broadly, plus one-off `perl -pi` and `rm -f .env` entries.
- **Consider.** Trim AGENTS.md Hard rules to 1 to 3 lines each and move the narrative to `docs/decisions.md`. Fix the two broken links in `docs/audits/2026-09-19-system-audit.md:1000-1001`.
- **Auto-memory.**
  - `app-adapts-to-lifter.md` isn't indexed in MEMORY.md.
  - `strength-tracker-project` is the most stale entry: it still says OAuth is unbuilt and MCP is pinned to one user.
  - `strength-tracker-users-and-audit` points at a plan now marked "do not execute".
  - `strength-tracker-mcp-oauth` lists a `confirm_change` gate as missing; it now exists.
  - `strength-tracker-parallel-sessions` has the wrong Codex worktree path.

Plan status table is in `docs-content.md`.

## Needs your hands

- Confirm DB-3 and DB-4 in production with a read-only query in the SQL editor:
  `select p.proname, has_function_privilege('anon', p.oid, 'execute') from pg_proc p where p.proname in ('integration_encryption_key','encrypt_integration_secret','decrypt_integration_secret','reserve_coach_turn');`
- Confirm INFRA-1: `select * from net._http_response order by created desc limit 5;` should show 401s if the sweep has run.

## Coverage gaps

- Unreviewed: Plan row editor and drag, `sections.ts`, SetSchemeSheet, PlateSheet, FocusDeck, the Session render and swap paths, Settings/ConnectedApps/charts, and the Codex worktrees.
- Live checks not run: Supabase grants, gateway URL length (MCP-4), real intervals.icu payloads (EDGE-2), real browser runtime.
- A clean result here means the listed checks passed, nothing more.


---

# Re-verification: rv-db

# DB re-verify at 902266d

Method: `git diff d5e7b64..HEAD` on supabase/migrations shows only 2 new files (20261001000000_exercise_prefs, 20261001010000_goals_visible_exercise) plus validate-db.mjs additions (+274, mostly exercise_prefs/goals cases). No existing migration changed, so every DB-n migration is byte-identical to the audited one. Re-ran e1-e6 against HEAD chain (same results as the audit). `npm --prefix scripts ci && validate-db && check-selects`: all pass (495 selected columns).

| ID | Verdict | Priority | Why |
|---|---|---|---|
| DB-1 account delete blocked by prescriptions_keep_logged_history | STILL PRESENT (e1 reproduces) | P2 | Only on account/dashboard delete of a user with sets-on-prescriptions; no in-app delete path; erasure request would hit it. Reversible (delete sets by SQL first). |
| DB-2 TM update/delete -> permission denied for auth.users | STILL PRESENT (e3 reproduces) | P1 | Same-day TM correction and TM delete in PWA data.ts:1194/1207 fail for any real user on Supabase (authenticated has no SELECT on auth.users). Recoverable (add a new-date row). |
| DB-3 integration_encryption_key/encrypt/decrypt executable by anon+authenticated | STILL PRESENT (e1/e4) | P1 | Definer fn returning at-rest key is callable via /rest/v1/rpc by anyone. Ciphertext table is service-role only so impact is bounded, but it is a public secret exposure with a one-line fix. |
| DB-4 reserve_coach_turn executable by anon, any p_user_id/limits | STILL PRESENT | P2 | Needs victim UUID; can burn a victim's daily coach cap. Fix is trivially safe. |
| DB-5 v_adherence uses app_tz() not app_tz(s.user_id) | STILL PRESENT (e5: null vs 80.0) | P2 | MCP/coach path only, only around a TM effective-date boundary for non-default-tz users. |
| DB-6 working_sets counts reps-0 ticks/holds | STILL PRESENT (e6) | P2 | Inflated counts feed coach context (top5). Tonnage/e1RM fine. |
| DB-7 rep_outcome 'missed' for done/time sets | STILL PRESENT (e6) | P2 | Coach can read activations as misses. |
| DB-8 composite SET NULL FKs null user_id | STILL PRESENT (e3) | P3 | Only activity -> deleted template path; template delete with linked activity is rare, endurance not live. |
| DB-9 parent-FK hardening incomplete | STILL PRESENT (unchanged) | P3 | Needs victim's unguessable UUID; pollution only. Note exercise_prefs/goals now check exercise visibility via RLS, narrowing the exercise-reference part for those two tables. |
| DB-10 NaN in goals.target_e1rm_kg / activities | STILL PRESENT (e6) | P3 | Self-poisoning only. |
| DB-11 current_date in trend/cycle views | STILL PRESENT | P3 | Off-by-one day at window edge. |
| DB-12 exercise_owners claim race | STILL PRESENT (speculative) | P3 | Millisecond window, slug guess. |
| DB-13 harness gaps | CHANGED (partly) | P2 | validate-db gained new cases (+274 lines) but still runs as superuser for the cases that would catch DB-1/2/3/5; no generic "no SECURITY DEFINER fn executable by anon/authenticated" loop; check-selects still hand-listed. |

Counts: STILL PRESENT 12, CHANGED 1, FIXED 0, NOT A BUG 0. P0 0, P1 2 (DB-2, DB-3), P2 6 (DB-1, 4, 5, 6, 7, 13), P3 5 (8-12).

## New migrations review

20261001000000_exercise_prefs.sql: OK. RLS enabled; select/insert/update owner-only `to authenticated`; insert and update WITH CHECK also require the exercise visible under caller RLS (closes oracle). No delete policy by design (tombstone). No SECURITY DEFINER anywhere; trigger function exercise_prefs_lww is invoker with `search_path = public, pg_temp`. No explicit grants/revokes, so no revoke-from-public trap (the only function is a trigger function, not callable via RPC; it does appear in the harness "exec by anon" list like the other trigger fns, harmless). Check constraints reject NaN (upper bounds); updated_at finite plus <= now()+1 day trigger. FK on user_id cascades, exercise_id cascades. LWW with value tie-break is deterministic; BEFORE UPDATE returning NULL on upsert is silent skip as intended. No defects found.

20261001010000_goals_visible_exercise.sql: OK. Drops and recreates goals_insert/goals_update with owner + exercise-visible check; select/delete untouched; applied-migration rule respected (new file). Existing rows untouched. validate-db has the cases (owner, library, stranger, delete-not-blocked). Minor: a goal on an own custom exercise that is later unshared... n/a (custom is never shared). No defects.

NEW-db-n: none found in d5e7b64..HEAD DB area. (Observation only: neither new migration is covered by an authenticated-role grant scan because that scan does not exist, see DB-13.)

## Fix sketches

DB-2 (P1, S): new migration `create or replace function refuse_rewriting_used_training_max()` replacing the `auth.users` exists test. Options: make it `security definer set search_path = public, pg_temp` (needs a revoke from public, anon, authenticated, and it is a trigger fn so not RPC-callable anyway), or avoid auth.users: detect cascade by `pg_trigger_depth() > 1` (fires inside RI cascade). Definer is the smaller change but widens a trigger; pg_trigger_depth is cleaner. Constraint: do not relax the lock for ordinary same-user edits of a used TM. Test: validate-db case under `set role authenticated` + app.user_id: update value_kg of an unused TM succeeds, of a used TM is refused with the intended error, delete of unused succeeds; plus existing account-delete case still passes. Suite: db (validate-db).

DB-3 (P1, S, trivially safe): new migration `revoke all on function integration_encryption_key(), encrypt_integration_secret(jsonb), decrypt_integration_secret(bytea), _integration_xor_obfuscate(bytea, text) from public, anon, authenticated;`. Callers: only endurance-sync via service_role (which keeps its explicit grants on encrypt/decrypt) and the definer encrypt/decrypt calling the key fn as owner, so the revoke on the key fn cannot break them. Same guard as reserve_coach_turn (service_role existence DO block is not needed for a pure revoke; PGlite has the roles in the harness but guard roles anyway for anon/authenticated). Test: validate-db `has_function_privilege('anon'|'authenticated', ..., 'execute') = false` for all four, and service_role still true for encrypt/decrypt where the role exists. Rotating the encryption key is not required by the revoke, but if the key was ever fetched by a third party, re-encrypt; ciphertext table was never publicly readable, so low likelihood.

DB-4 (P2, S, trivially safe): new migration `revoke all on function reserve_coach_turn(uuid, uuid, int, numeric) from anon;` and recreate with `set search_path = public, pg_temp`. Only caller is the coach edge function (service role, grant stays). Test as DB-3.

DB-1 (P2, S): new migration redefining refuse_orphaning_logged_sets with the same `not exists (select 1 from auth.users ...)` short-circuit, but beware DB-2: that fn also runs as the invoker; the cascade runs as the deleter (postgres/supabase_auth_admin on dashboard), which can read auth.users, but an authenticated-role hard delete of an rx must still not error with permission denied. Prefer `pg_trigger_depth() > 1` or definer here too. Test: user with a set on a prescription, `delete from auth.users` succeeds, zero rows remain; non-cascade rx delete with sets still refused.

DB-5 (P2, S): new migration create or replace view v_adherence restoring `app_tz(s.user_id)` (copy the 20260924003054 body, keep security_invoker). Test: service-role vs authenticated equality for a non-UTC user.

DB-6/7 (P2, S/M): product call; add `reps > 0` to counted rows in the four views, and null rep_outcome when the prescription's tracking <> 'reps'. Must not add a tracking filter to e1RM/volume views. Migration per view (create or replace, same columns).

DB-13 (P2, M): add a loop in validate-db asserting no public SECURITY DEFINER fn is executable by anon/authenticated outside an allow-list; run TM/prefs/goals DML under `set role authenticated`.


---

# Re-verification: rv-backend

# Re-verify: backend (MCP-*, EDGE-*, INFRA-*) at HEAD 902266d vs audit d5e7b64

Read-only. Checks run at HEAD from repo root:
- mcp-server: `deno check index.ts && deno test --allow-env --allow-net` -> pass, 191 passed / 0 failed
- coach: `deno check index.ts && deno test` -> pass, 42 passed
- push-alerts: `deno check index.ts && deno test lib/` -> pass, 10 passed

Churn in my area since d5e7b64: mcp-server (new lib/setLoad.ts, prescriptions.ts, repeat_planned_workout.ts, upsert_program.ts, format.ts, manage_exercises.ts error text only), coach/prompt.ts (+8 lines of prose), ci.yml (test list only). push-alerts, endurance-sync, deploy.yml, config.toml, check-pwa-env, relay, coach/index.ts: no change. So every finding outside those files is STILL PRESENT by diff.

Priority legend: P0 fix now, P1 fix soon, P2 worth fixing, P3 skip. "Gate" = latent today, must be fixed before the sweep is enabled (Phase 5, A-137/A-138; deploy.md says no SWEEP_SECRET and no Vault rows exist today).

## Table

| ID | Verdict | Pri | Why (who, how often, cost, reversible) |
|---|---|---|---|
| MCP-1 | STILL PRESENT | P1 | Any account that can OAuth/hold an MCP token can rename/edit shared seeded rows; name lands in every other user's coach context. Open sign-up + open DCR. Reversible only by hand. updated_by never written (grep: zero hits in mcp-server). |
| MCP-2 | STILL PRESENT | P2 | Correcting a TM on the same date after %TM sets were logged: trigger raises 23514, tool returns generic 500. Rare, recoverable (use a new date), but the tool text promises overwrite. |
| MCP-3 | STILL PRESENT | P1 | "Swap this exercise" while today's session is open (the normal mid-workout request for a self-coached lifter) raises 55000 in the DB; tool rethrows plain Error, model gets "Unexpected server error", DB hint is discarded, Sentry paged each time. No data loss, but model cannot recover and may improvise (e.g. a second program). |
| MCP-4 | STILL PRESENT | P1 | get_lift_history `.in("set_id", up to 500 ids)` = ~18.5 KB URL; resolve_exercises.ts already documents the same URL being "refused outright". Flagship read fails totally once a main lift passes roughly 230 sets (a few months for Valentine, already for Colt). Gateway threshold unmeasured, but the code builds the URL. |
| MCP-5 | STILL PRESENT | P2 | get_recent_sessions include_sets sorts ascending then caps 400, so the newest session is what truncates; flagged via sets_truncated but the missing rows are "how did yesterday go". |
| MCP-6 | STILL PRESENT | P2 | search/resolve rank after alphabetical cut to 20; trained variant can fall off for broad terms. Splits history across variants. |
| MCP-7 | STILL PRESENT | P3 | trained:false after 1500 sets is a ranking hint only. |
| MCP-8 | STILL PRESENT | P2 | repeat_planned_workout "last time" = newest non-discarded session even if empty; abandoned start masks the real last session, no loads carried. Foreign empty sessions are deliberately left open by design, so this state is normal. |
| MCP-9 | NOT A BUG | P3 | Legacy `load_kg` text says load_kg stays TOTAL and per_side "must be doubled when producing load_kg", i.e. the caller doubles; code stores as given and the test pins that. Consistent. Wording is ambiguous and could be tightened; new `load{}` path (now via setLoad.ts) does the doubling. |
| MCP-10 | STILL PRESENT | P2 | tracking enum lacks 'time'; update_planned_workout on a timed day rewrites it as reps silently. Needs a timed day edited via MCP; rare but silent shape loss. |
| MCP-11 | STILL PRESENT | P2 | add_exercise 23505 message confirms another user's custom id exists; non-Latin names collapse to "_". Low-value leak, blocks legit creation for non-ASCII names. |
| MCP-12 | STILL PRESENT | P2 | get_bodyweight `to` day excluded (date vs timestamptz); bad calendar dates ("2026-02-30") reach Postgres as opaque 500. Wrong answers, no damage. |
| MCP-13 | STILL PRESENT | P2 | get_program has no row cap handling; a long-lived program (~125 days x 8) passes PostgREST max-rows 1000 silently. Not reached by current users yet. |
| MCP-14 | STILL PRESENT | P3 | find_similar_days ordering/300 cap; cosmetic. |
| MCP-15 | STILL PRESENT | P3 | Concurrent repeat/upsert race; single-user, unlikely. |
| MCP-16 | STILL PRESENT | P3 | Missing .max() bounds; own-rows only. |
| MCP-17 | STILL PRESENT | P2 | delete_program confirmed branch, update_exercise, delete_exercise do not check ctx.ephemeral; only protection is the coach connector disabled list. Defense in depth for a boundary AGENTS.md calls load-bearing. Cheap. |
| MCP-18 | STILL PRESENT | P3 | tz cache documented, short-lived isolates. |
| EDGE-1 | STILL PRESENT | P1 (gate) | sendAlertNow success path stamps `{}`; sent_at never set (only deliver() sets it, index.ts:891). Every due prompt re-sent every 5 min until the 6 h stale cutoff (up to ~72 pushes). Certain the moment the sweep is on. Masked today because the sweep is off and INFRA-1 blocks it anyway. |
| EDGE-2 | STILL PRESENT | P2 | intervals `start_date_local` zone-less, parsed as UTC (providers.ts:70, normalize.ts `new Date`). Shifted by UTC offset, breaks the 2-minute cross-source dedup and day buckets. Only affects Colt-style intervals+Strava users, endurance is Phase 5. Fix by preferring `start_date`. Field format from API knowledge, not captured payload. |
| EDGE-3 | STILL PRESENT | P2 | Confirmed: PWA wraps context onto latest user turn (coach.ts:78-85), record() stores that wrapped text (index.ts:579 `last?.text`), next turn replays up to 20 stored prompts with stale context blocks. Token cost and stale-plan confusion every turn. |
| EDGE-4 | STILL PRESENT | P2 | ignoreDuplicates upsert freezes first-seen values; 48 h overlap comment is misleading. Renames/sport corrections never land. |
| EDGE-5 | STILL PRESENT | P2 | `since` is global across providers; newly connected provider never backfills. Silent gap, /backfill recovers. |
| EDGE-6 | STILL PRESENT | P3 | Concurrent schedule/arm cancel each other; needs overlapping requests, rare. |
| EDGE-7 | STILL PRESENT | P3 | COACH_LOG_CONTENT=off kills history; operator opt-in, default on. Document it. |
| EDGE-8 | STILL PRESENT | P2 | Failed mid-stream turn records 0 tokens and `refused` excludes it from the day cap; owner-key spend unmetered. Needs repeated late failures. |
| EDGE-9 | STILL PRESENT | P3 | monthlySpentTokens 1000-row cap, only guards /checkin-memory. |
| EDGE-10 | STILL PRESENT | P3 | Mint failure after reserve leaks one reserved row; `prior` error ignored. Rare. |
| EDGE-11 | STILL PRESENT | P3 | Unbounded replayed history; speculative, interacts with EDGE-3. |
| EDGE-12 | STILL PRESENT | P3 | One throwing row aborts the sweep batch; no claim step. Fix together with EDGE-1 (becomes P2 once sweep is on). |
| EDGE-13 | STILL PRESENT | P3 | Push fetch follows redirects; speculative SSRF hardening. |
| EDGE-14 | STILL PRESENT | P3 | Bookkeeping errors swallowed; no paging (A-75 known). |
| EDGE-15 | STILL PRESENT | P3 | Comment drift only. |
| INFRA-1 | STILL PRESENT | P1 (gate) | Confirmed from code: run_alert_sweep sends only Content-Type and x-sweep-secret, no Authorization/apikey; push-alerts deploys with verify_jwt on (deploy.yml:115 no flag; config.toml declares only mcp-server). The Supabase edge gateway/runtime requires `Authorization: Bearer <jwt>` when verify_jwt is on and returns 401 "Missing authorization header" before function code runs; an `apikey` header alone does not satisfy it, and `sb_publishable_` keys are not JWTs at all so would fail too. net.http_post is async, so cron reports success. Not verified live; check `net._http_response` after enabling. |
| INFRA-2 | STILL PRESENT | P2 | Path-gated per-push diff: a failed db push followed by a pwa-only push publishes the newer client over an unmigrated schema. Needs a failed supabase job plus a later pwa-only push. workflow_dispatch recovers. Version D just shipped migrations the PWA depends on, so the exposure is live-ish. |
| INFRA-3 | STILL PRESENT | P2 | check-pwa-env accepts any 3-part token (incl. service_role) and rejects `sb_publishable_`. Public Pages bundle, public repo. Needs a mispaste. Cheap guard. |
| INFRA-4 | STILL PRESENT | P3 | Relay crashes on malformed request line from a local process; supervisor restarts. |
| INFRA-5 | STILL PRESENT | P3 | Unpinned actions, wide `contents: write`, CLI `latest`. |
| INFRA-6 | STILL PRESENT | P3 | VITE_APP_VERSION is always "main", BUILD_TIME is repo updated_at; diagnostics only. |
| INFRA-7 | STILL PRESENT | P3 | stack.test.mjs not in CI (ci.yml now lists three other new scripts, not this one), no `--frozen`, no concurrency. |

## Counts

Verdicts (40 findings): STILL PRESENT 39, NOT A BUG 1 (MCP-9), FIXED 0, CHANGED 0.
Priorities: P0 0, P1 5, P2 16, P3 19.

## P1 details

### INFRA-1 + EDGE-1 + EDGE-12 (one gate: do not enable the sweep until all three land)

Key-question answers:
- config.toml: only `[functions.mcp-server] verify_jwt = false`. No push-alerts entry, so `supabase functions deploy push-alerts` (deploy.yml:115, no flag) deploys verify_jwt ON.
- Headers sent by run_alert_sweep (migration 20260907060000:55-60): `Content-Type`, `x-sweep-secret`. Nothing else.
- Gateway behavior: with verify_jwt on, the request needs a Bearer JWT. Missing header gives 401 at the gateway. The anon key would pass the signature check (it is a valid JWT, public). So verify_jwt on never protected subscribe/schedule/cancel from an unauthenticated caller anyway: `resolveUser` (index.ts:144-159) runs `auth.getUser` on the token for every non-sweep route and returns 401 otherwise. The deploy.yml comment ("--no-verify-jwt would open subscribe, schedule and cancel to anyone") is therefore wrong; the in-function check is the real gate.
- Note any fix must keep that: confirm every non-sweep route calls resolveUser first (it does; sweep is the only early return, index.ts:933-941).

Fix sketch INFRA-1 (S):
- Preferred: add `[functions.push-alerts] verify_jwt = false` to supabase/config.toml and `--no-verify-jwt` to deploy.yml:115 (mirror mcp-server), fix the stale comment at deploy.yml:107-114 and docs/deploy.md:500 area. No migration. Test: extend scripts/check-deploy-contract.test.mjs to pin push-alerts deploy flag and config.toml entry; add a push-alerts index test that a non-sweep route without Authorization returns 401 and that `/sweep` without the secret returns 401.
- Alternative needing no function change: store the anon key in Vault (`anon_key`) and add `'Authorization','Bearer '||anon_key` to run_alert_sweep via a NEW migration (never edit 20260907060000). Keeps verify_jwt on. More moving parts (third Vault row).
- Suite: database/scripts block (`node --test scripts/check-deploy-contract.test.mjs`, `validate-db.mjs` if migration) and `cd supabase/functions/push-alerts && deno check index.ts && deno test lib/`.
- Constraints: never open subscribe/schedule/cancel without resolveUser; secret stays out of migrations (Vault only); public repo.

Fix sketch EDGE-1 (S): in sendAlertNow replace `ok ? {} : {error}` with `ok ? { sent_at: new Date().toISOString() } : { error: "every endpoint failed" }` (index.ts:459). Also fix the comment at :492. Regression test: push-alerts has no index test harness today (index.ts is not importable under `deno test lib/`), so either extract `sendAlertNow`'s stamp decision into lib/ as a pure function with a test, or add a mocked-db test. Suite: push-alerts block. Constraint: sweep must stay idempotent; consider also stamping `error` rows so a permanently failing row does not retry for 6 h at 5 min cadence (decide; currently retries until stale, which is arguably intended for transient failure).

Fix sketch EDGE-12 (S, do with EDGE-1): wrap each row in try/catch in the sweep loop and count `failed`; optional claim step (`update ... set sent_at = now() where id=? and sent_at is null returning`) before sending to stop overlapping sweeps double-sending, at the cost of losing a send on crash; decide with EDGE-1.

### MCP-1 (shared exercise library writable by any token holder)

Current state: `assertVisible` returns early for non-custom rows (manage_exercises.ts:40-48), `update_exercise` applies name/muscles/equipment/category/level to shared rows, only `instructions` is gated. `updated_by` is never written (stays null, since service role has no auth.uid() and the code never passes it). Users: Colt, Valentine, anyone who signs up and OAuths. Cost: prompt-injection text (<=80 printable chars) in every account's coach context, or flipping `equipment` to alter the plate calculator for everyone. Attack needs an account but sign-up/DCR are open.

Fix sketch (M, needs a product decision recorded in docs/decisions.md): one of (a) restrict shared-row edits to an operator allowlist env (like COACH_ALLOWED_USERS) and let others create a custom copy; (b) keep open but always pass `updated_by: db.ownerId` and add an audit view; (a) is what the threat model asks for. Minimum S step regardless: stamp `updated_by` in the patch (column is NULLable uuid, trigger honors an explicit value, per 20260905020000). No migration needed for (a) or the stamp. Test: manage_exercises.test.ts, non-allowlisted caller updating a `free-exercise-db` row gets the refusal and the DB row is unchanged; allowlisted caller succeeds and `updated_by` is set. Suite: `cd supabase/functions/mcp-server && deno check index.ts && deno test --allow-env --allow-net`. Constraints: other users' custom rows must keep reporting UNKNOWN not forbidden; do not branch any policy on `updated_by` (AGENTS.md audit-trail-only rule); coach disabled list stays.

### MCP-3 (plan-lock DB errors reported as "Unexpected server error")

Fix sketch (S): in update_planned_workout.ts:279-293 (and the same pattern for dayPatch-only edits) map rpc error codes: `55000` -> ToolError with the DB message + "Finish or discard the active session, or edit a future day"; `23001`/`23514` (logged sets, locked structure) -> ToolError "this day is locked because sessions/sets reference it; edit a future day or use repeat_planned_workout". Preserve the hint from PostgREST (`error.hint`). Also check repeat/upsert paths that touch the same triggers. Test: update_planned_workout.test.ts with a mocked rpc error `{code:'55000', message, hint}` expecting `ToolError` not generic. Suite: mcp-server block. Constraint: do NOT relax the triggers or pre-check by reading `sets` only; DB stays the authority (AGENTS.md plan-lock rule). MCP-2 gets the identical treatment (map 23514 in set_training_max.ts:68-82 to "add a new TM dated from today").

### MCP-4 (long `.in()` URLs)

Locations unchanged: tools/get_lift_history.ts:146-152 (500 ids), get_recent_sessions.ts:189-198 (400), lib/lastTime.ts:134-139 (1000), find_similar_days.ts:133-141 (300). resolve_exercises.ts:312-318 already documents the failure mode, which is evidence the gateway limit is real, though the exact threshold is unmeasured.

Fix sketch (S-M): add one shared helper in lib/db.ts, `inChunks(ids, 100, fn)` (36-char uuid + comma, ~3.7 KB per 100), and use it at the four sites; or switch to a view/RPC that joins server-side. No migration. Test: Deno test with a fake client that throws if an `.in()` list exceeds 100 ids, called with 450 ids. Suite: mcp-server block. Constraint: every chunked query must keep `.eq("user_id", db.ownerId)` and read `v_live_*` views.

## Other notes

- NEW defects in d5e7b64..HEAD for my area: none found. Checked: lib/setLoad.ts (byte-identical to pwa/src/lib/setLoad.ts, pinned by scripts/load-integrity.test.mjs, now in ci.yml), prescriptionRows (LoadIntegrityError wrapped as ToolError; legacy `load_kg` path leaves entered_* null, which the validate_entered_load_consistency trigger allows), repeat_planned_workout provenanceForTotal (returns null pair when the DB rounding cannot reproduce the total; null pair + retained load_entry is legal per the trigger), humanKg (display only). Prompt change in coach/prompt.ts is prose.
- The mcp-server deno suite is 191 now vs 187 at audit; no regressions.
- Original audit claim check: EDGE-1's "stamp({}) may throw or no-op" is moot; either way sent_at stays null.
- Live proof still needed (cannot be done read-only here): INFRA-1 gateway 401 via `net._http_response`, MCP-4 URL threshold, MCP-13 max-rows.


---

# Re-verification: rv-core

# rv-core: re-verify of pwa-core.md (CORE-1..13) at HEAD 902266d

Checks: `npm run typecheck` pass; `npx vitest run src/lib src/hooks` 63 files / 948 tests pass.
Files useAuth.ts, currentUser.ts, persistedSession.ts, timeoutFetch.ts, export.ts, swUpdate.ts are byte-identical to d5e7b64. db.ts, outbox.ts, data.ts, settings.ts, OutboxSheet.tsx changed a lot but none of the audited code paths were touched (db.ts getDb/claimCacheFor unchanged; outbox classify/doFlush chain unchanged; fetchWithCache unchanged).

| id | verdict | priority | one line |
|---|---|---|---|
| CORE-1 | CHANGED (cache wipe confirmed by execution; Login screen and null userId NOT confirmed) | P1 | every offline cold start after token expiry wipes the kv cache incl. activeSession pointer, plan, end drafts |
| CORE-2 | STILL PRESENT (fetchWithCache unchanged, data.ts:150-156) | P2 | needs auth endpoint down but REST up, plus anon SELECT grants unverified |
| CORE-3 | STILL PRESENT | P2 | stale cacheSet after invalidation; heals on next online read |
| CORE-4 | STILL PRESENT, slightly worse (see CORE-1 detail: concurrent claims race, one returns false while the other clears) | P2 | transient cross-user render only on a user switch with no SIGNED_OUT |
| CORE-5 | STILL PRESENT (no terminated/blocking handlers, rejected open cached) | P2 | iOS IDB connection loss until reload; unverified how often; becomes P1 if enqueue failure drops a set silently |
| CORE-6 | STILL PRESENT (classify list unchanged, outbox.ts:282) | P2 | 413/415 poison item head-of-line blocks queue; no known payload hits it today |
| CORE-7 | STILL PRESENT (`chain = chain.then(doFlush, doFlush)` outbox.ts:606) | P3 | latency/noise only |
| CORE-8 | STILL PRESENT | P3 | two-context interleave; exercise_prefs now guarded by updated_at, set_notes still LWW-merge |
| CORE-9 | STILL PRESENT | P3 | narrow null-owner window |
| CORE-10 | STILL PRESENT for (a) CSV drops load_entry/entered_load/entered_unit/prescription_id, (b) bundle lacks bodyweight_log/session_skips/set_voids/checkins/plans (no grep hits in export.ts), (c) TAB/CR; (d) OFFSET paging unchanged | P2 | export is the "you own your log" promise; CSV of 2x30 kg dumbbells reads 60 kg total |
| CORE-11 | STILL PRESENT (no `storage` listener in settings.ts) | P3 | two-tab lost update; now also feeds exercise_prefs sync but still rare for a PWA |
| CORE-12 | STILL PRESENT (no .catch at useAuth.ts:28, currentUser.ts:29) | P3 | getSession rarely rejects |
| CORE-13 | STILL PRESENT (main.tsx:89-96 keyed on kv.activeSession) | P3 | fails safe; see NEW-CORE-1 interaction |
| NEW-CORE-1 | NEW | P1 | cold start offline with expired token sits on the loading splash ~25 s |

## CORE-1 detail: exact order and final state

Method: throwaway vitest in scratchpad (`audit/core1/core1.test.ts`, config `audit/core1/vitest.config.ts`, run with `npx vitest run --config <that>` from pwa/). It uses the REAL supabase-js 2.112.4 client (auth-js), the REAL `currentUser.ts`, `persistedSession.ts`, `db.ts` (fake-indexeddb), an in-memory localStorage stub, `window`/`document` stubs so auth-js uses localStorage, and a `fetch` that always rejects with TypeError (offline). Storage seeded with an expired session for user-A, cache owner marker user-A, and a cached `plan` kv entry. Then the exact `useAuth` effect body (getSession().then fallback + claim, then onAuthStateChange listener + claim) was run in that order.

Mechanics (auth-js source): default lockless path (`this.lock == null`), so `getSession()` and `_emitInitialSession` both call `__loadSession` concurrently, no serialization. Both hit `_callRefreshToken`, single-flighted by `refreshingDeferred`. `_refreshAccessToken` retries with backoff 200, 400, 800 ... while the cumulative wait stays under the 30 s tick, so total about 25 s of retries before the error is returned. Both callers then get `session:null` + AuthRetryableFetchError.

Observed after the ~25 s:
1. FIRST: listener gets `INITIAL_SESSION` with `null` (`_emitInitialSession` catch path calls `callback('INITIAL_SESSION', null)`). `setState({session:null})`; `claim(null)` starts: reads owner marker (user-A) != null, begins `cacheClearAll()`. currentUser's listener `set(null)` is a no-op (userId already null).
2. SECOND: `getSession().then` sees the retryable error and substitutes `readPersistedSession()`. `setState({session: persisted})` overwrites step 1, so the app renders the shell, NOT Login. currentUser `set("user-A")`, so `getCurrentUserId()` is user-A and the outbox is NOT held. `claim(user-A)` reads the marker while step 1's clear is still in flight, sees user-A == user-A, returns false (no-op).
3. Step 1's clear finishes and removes the marker.

Final state: UI session = persisted (shell, not Login); userId = user-A; kv cache EMPTY (the seeded `plan` entry gone); owner marker null; outbox untouched; persisted auth token still on disk. So the audit's claims (1) Login screen and (3) outbox held are wrong at this version, because the getSession().then fallback runs after the listener and wins the React state. Claim (2), cache wipe, is true and is the damage: kv holds activeSession, the plan, sessionEndDraft, sessionPrefs, rest state, coach thread (localStorage key too). Offline, the shell then renders with no cached plan and no active-session pointer, so the workout in progress is not shown (its sets stay safe in the outbox). The wipe also makes `sessionInProgress()` false, so the SW update gate could apply an update and reload while a workout is open once the app is back online. Cache refills on the next online read; the marker is restored on the next claim (TOKEN_REFRESHED/SIGNED_IN).

Caveat: order observed in one run on this auth-js version; it follows from both callers awaiting the same deferred in registration order (getSession's continuation first, but the listener callback path resolves in fewer microtask hops). A different auth-js could flip it; if it flipped (listener last), the UI WOULD land on Login and userId would go null, i.e. the original claim. Either order wipes the cache.

Priority P1: hit by Valentine on every offline open after the 1 h access token expiry; recoverable (outbox intact, cache refills online), but it removes the plan and the active-workout pointer exactly when she has no signal.

Fix sketch: pwa/src/hooks/useAuth.ts and pwa/src/lib/currentUser.ts. In both onAuthStateChange callbacks, ignore `event === "INITIAL_SESSION" && session === null` (the getSession().then path already owns the cold-start answer, including the genuine signed-out case where error is null). Also serialize `claim()` calls in useAuth through one promise chain so two claims cannot interleave (fixes CORE-4's race). Alternatively only call claim(null) when the last getSession error was not retryable. No migration. Regression test: new `pwa/src/hooks/useAuth.test.tsx` with @testing-library/react and a mocked `supabase.auth` (getSession resolves `{session:null,error:AuthRetryableFetchError}`, onAuthStateChange fires `('INITIAL_SESSION', null)` first); assert state stays on persisted session, `claimCacheFor` is never called with null, and a seeded kv entry survives. Suite: `cd pwa && npm test -- --run`. Effort S. Constraints: identity-never-authorization rule (persistedSession), cache owner rule (a real SIGNED_OUT must still clear), outbox untouched.

## NEW-CORE-1: ~25 s splash on offline cold start (P1)

Evidence: same test. Nothing resolved at 1.5 s; both callbacks arrived within 40 s; the retry schedule in auth-js `_refreshAccessToken` bounds it at about 25 s. `useAuth` holds `loading:true` until getSession returns and `App.tsx:189` renders the splash, with no timeout. So an offline open with an expired token shows a splash for about 25 s before the persisted-session fallback is even consulted, then the (already wiped, per CORE-1) shell. Who: Valentine, gym, any open more than an hour after the last online use. Reversible, but it reads as a broken app.
Fix: in `useAuth` race `getSession()` against a short timeout (about 3 s) or `navigator.onLine === false`, resolving to `readPersistedSession()` when it exists; keep the real answer arriving later via the listener (TOKEN_REFRESHED/SIGNED_OUT). Same in `currentUser.ts` (stamping userId early matters: enqueues in the first 25 s are stamped null and HELD, which is CORE-9's trigger). Test: same `useAuth.test.tsx` with fake timers and a never-resolving getSession. Effort S-M.

## Other notes
- CORE-10 fix: add `load_entry,entered_load,entered_unit,prescription_id` to CSV_HEADER/toCsv, add bodyweight_log/session_skips/set_voids/checkins/plans to buildExport, prefix TAB/CR in csvCell, page by keyset not OFFSET. Test: extend export tests (`cd pwa && npm test -- --run`). Effort M.
- CORE-3/2 fix: per-key epoch in makeFetchWithCache bumped by cacheDeleteByPrefix/cacheClearAll; refuse to cache when no session. Test in data.test.ts. Effort S.
- CORE-5 fix: `terminated: () => { dbPromise = null }`, `blocking: () => db.close()`, and clear dbPromise on rejection in getDb; additive only, version stays 1. Test in db.test.ts. Effort S.
- CORE-6 fix: dead-letter after N retries for 4xx other than 408/429, or treat 413/414/415/431 as dead. Test in outbox tests. Effort S.


---

# Re-verification: rv-session

# rv-session: re-verify of SESS-1..11 at 902266d (audit base d5e7b64)

Test run: `npx vitest run src/screens/Session src/screens/End src/components src/lib/corrections src/lib/outbox` -> 44 files pass, 1 file fails (2 tests, 617 pass). The 2 failures are `Session.focus.test.tsx` "F4 ... identity is unknown" and "F-8 ... unit switch", both `TypeError: Cannot read properties of undefined (reading 'clear')` at `localStorage.clear()`. vitest environment is "node" (vite.config.ts:110) and Node v26.5.0 has no global localStorage. Deterministic (2/2 reruns). Test-env problem, not product code. See NEW-SESS-1.

## Verdict table

| id      | verdict                  | priority | reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SESS-1  | FIXED                    | -        | Rate target is now `restedSet = lastSet` derived from live `sets` state (`newestOf(sets)`, Session.tsx:1165, 3677); `lastLoggedSet` no longer exists. `commitCorrection` (2404) maps old->next in `sets`, so the strip rates the replacement, not the voided id. Correction+rate go through one `outbox.enqueueCorrection` (d573937 / 125d203).                                                                                                                          |
| SESS-2  | FIXED                    | -        | `buildSetInsert` (Session.tsx:1988) and `saveCorrection` (2475) call `buildSetLoad({... maxTotalKg: MAX_LOAD_KG})`, which throws `LoadIntegrityError("too_large")` above 999 kg total or the column limit (setLoad.ts:257-262). `logSet` catch (2213) shows the message and logs nothing; `saveCorrection` toasts and keeps the sheet open. Outbox `assertQueueable` (outbox.ts:347, eac072d) is the backstop.                                                           |
| SESS-3  | STILL PRESENT            | P2       | Admission gate checks load only (`assertQueueable` -> `assertAcceptedAuthoredLoad`). Steppers `min={0}` (SetEditor.tsx:244ish), pad `Math.max(0, ...)` (Session.tsx:2900, 2989), `duration_seconds: Math.round(draft.durationSeconds ?? 60)` (2007). 0 s -> 23514 -> dead-lettered, "rejected" so Retry cannot fix.                                                                                                                                                      |
| SESS-4  | STILL PRESENT            | P1       | `getServerSessionSets(a.id)` (Session.tsx:1011) still swallows: data.ts:1903-1909 `reportError; return []` when the read fails and no cache. `orNull` was added only for Today. Bootstrap succeeds, `setsFailed` stays false, `setIndexFor` (2044) is max(pending)+1. No unique index on (session_id, exercise_id, set_index) so the dupes are accepted forever.                                                                                                         |
| SESS-5  | FIXED                    | -        | `logRound` is gone; every superset member goes through `logSet`/`logRoundMember`, and `doneAfter` (2141) excludes the just-unskipped entry (`e.key !== entryToLog.key`).                                                                                                                                                                                                                                                                                                 |
| SESS-6  | CHANGED (partly present) | P2       | The Fix-sheet duration stepper claim is moot (no duration in the correction editor now). The data half stands: `SET_COLUMNS` (data.ts:62) still omits `duration_seconds`, so after a reload every timed set reads `duration_seconds` undefined; `formatSetLine` (setLine.ts:41) then shows "0:00 held", and `correctedSet` (`...old`) writes the replacement with null duration, losing the hold time. Hits any timed set correct/rate after reload or on another phone. |
| SESS-7  | FIXED                    | -        | End.tsx:448 and 639 use `toStoredKg` (two decimals).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SESS-8  | STILL PRESENT            | P3       | `sessionSkipRows` still mints `uuid()` per call (skips.ts:51) and `writeSessionSkips` runs before later throwing steps in `end` (End.tsx:452-470). Needs a post-skip throw (cache write) plus a retry tap. No unique constraint. Cost: duplicate skip rows, context only, never a score.                                                                                                                                                                                 |
| SESS-9  | FIXED                    | -        | `commitCorrection` awaits `outbox.enqueueCorrection` before touching voids/sets/cache and returns false on failure (sheet stays open); `voidSet` awaits `outbox.enqueue` and returns early on reject (Session.tsx:2531-2545).                                                                                                                                                                                                                                            |
| SESS-10 | STILL PRESENT            | P3       | useWakeLock.ts unchanged since audit; `acquire` still guards on `sentinel !== null`, set only at resolution. Browser frees the lock on next hide.                                                                                                                                                                                                                                                                                                                        |
| SESS-11 | FIXED (test replaced)    | -        | "splits round rest across members" no longer exists (Session.focus.test.tsx rewritten, +1245/-1069). Not seen flaking in 3 runs.                                                                                                                                                                                                                                                                                                                                         |

Counts: FIXED 6 (1,2,5,7,9,11), STILL PRESENT 4 (3,4,8,10), CHANGED 1 (6). Priority: P1 1 (SESS-4), P2 2 (SESS-3, SESS-6), P3 2 (SESS-8, SESS-10), new P2 1.

## P1 detail

### SESS-4: cache-less offline resume allocates set_index from 0 over existing server sets

- Who: Valentine, phone PWA, offline in a gym. Needs an open session whose `sessionSets` cache is absent (evicted by WebKit after ~a week idle, adopted from another device, or cleared at user switch) AND a failed server read at Session mount. Then LOG enabled, first set gets index 0 (or max(pending)+1) for an exercise that already has server sets. `sets` is append-only so the duplicate index is permanent; every view that orders or counts by set_index mis-buckets, and a later correction targets "the" set at that index ambiguously.
- Root cause: Session.tsx:1011 `getServerSessionSets(a.id)` returns `[]` on error without cache (data.ts:1903-1909). The bootstrap `catch` that sets `setsFailed` (1050) never fires.
- Fix sketch (S): in Session bootstrap call a variant that throws (or use `{ orNull: true }` and `if (server === null) throw`), so the existing `setsFailed` path disables LOG with "LOG UNAVAILABLE" until a reload reads successfully. Keep History/Today behaviour. Optionally let the outbox pendingSets alone count as authoritative only when `localSets` (cache) exists. Files: pwa/src/screens/Session.tsx (~1011), pwa/src/lib/data.ts (maybe a `strict` option; toast suppressed as for orNull). No migration. Do not add any update/delete path; a DB unique (session_id, exercise_id, set_index) would be a separate decision (existing duplicate data, replay semantics).
- Test (suite: `cd pwa && npm test -- --run`): Session.regressions.test.tsx: mock `supabase.from("v_live_sets").select` to reject, empty kv cache, seed one pending set; assert LOG button disabled / `setsFailed` banner and nothing enqueued. Data-layer test for the strict variant.
- Constraint: hard rules "a session bootstrap that THREW is not an empty log" (AGENTS.md) and idempotent client UUID writes.

## P2 detail

### SESS-3: duration 0 refused by check 1..7200

- Fix (S): clamp at the source: SetEditor `min={1}`, pad commits `Math.max(1, ...)` (Session.tsx:2900, 2989), and in `buildSetInsert` `Math.min(7200, Math.max(1, Math.round(...)))`. Better: extend `assertQueueable` to refuse `duration_seconds` outside [1,7200] for `sets` so every writer is covered (outbox.test.ts case). No migration.

### SESS-6: duration_seconds not read back

- Fix (S): add `duration_seconds` to `SET_COLUMNS` (data.ts:62) and any `v_live_sets` select list; confirm `v_live_sets` exposes the column (`node scripts/check-selects.mjs` will say). Test: corrections.test.ts "keeps duration_seconds"; data test for SET_COLUMNS; run `node scripts/check-selects.mjs`. Existing cached lists lack the field until the next server read; acceptable.

## NEW findings (bounded skim of d5e7b64..HEAD in Session/outbox/corrections/setLoad)

| id         | verdict | priority | detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEW-SESS-1 | NEW     | P2       | Two Session.focus tests fail deterministically at HEAD in this environment: `localStorage.clear()` on an undefined global (vitest `environment: "node"`, Node 26.5.0; vite.config.ts:110). CI on a Node version that still ships a global/jsdom stub may pass, so the suite is green or red depending on runtime; the F4/F-8 identity tests (the ones that protect "unknown identity must not misattribute a set") are not exercised locally. Fix (S): in the test, `vi.stubGlobal("localStorage", ...)` or use a shared setup file stub; pin Node in CI/.nvmrc. Suite: `cd pwa && npm test -- --run`. |

No new defect of the SESS-1/2/9 classes found: all three post-log mutation paths (correct, rate, void) now follow enqueue-then-UI, load derivation is single-sourced in setLoad.ts with an outbox admission backstop, and the correction bundle is one atomic `enqueueCorrection`.

## Not covered

- Did not run the app; findings are from code and unit tests. `Session.tsx` (4630 lines now) read around the log/correct/void/bootstrap/rate paths only; FocusDeck, sections UI and extras not re-reviewed.
- Did not verify whether any later migration made `duration_seconds` part of `v_live_sets`' select list (affects SESS-6 fix effort).


---

# Re-verification: rv-plan

# Re-verify: PLAN-1..15 at HEAD 902266d

Vitest (src/screens src/lib/calendar src/lib/coach src/lib/templateLoads): 26 files pass, 1 fails: Session.focus.test.tsx (2 tests, `localStorage.clear` of undefined at the `resetDbForTests(); localStorage.clear()` lines). Test-env/ordering issue, not related to PLAN findings; unconfirmed whether pre-existing (see NEW-plan-1).

| id | verdict | prio | why | fix sketch / suite / effort |
|---|---|---|---|---|
| PLAN-1 | STILL PRESENT | P1 | data.ts duplicatePlannedWorkout select (435+) still omits set_type, section, tracking. Valentine's warmups/sectioned/timed days copy as plain working reps rows. Recoverable by hand editing. | Add the 3 columns to select; best: DB function copying whole day atomically (also fixes PLAN-12). New migration if function. Test: pwa vitest data test + validate-db.mjs. S (client) / M (rpc). Respect: bulk-insert rule, all defaulted keys emitted on every row. |
| PLAN-2 | STILL PRESENT | P1 | saveWorkoutAsTemplate row builder lacks superset_group, section, tracking; applyTemplate select lacks section, tracking. Template round trip un-supersets/un-sections. | Carry all 3 in save, add section+tracking to apply select; emit set_type/tracking on every row. Test: round-trip vitest in pwa (data.ts) + templateLoads. S. |
| PLAN-3 | STILL PRESENT | P3 | refreshedLoads ignores set_type; doc comment says warmups left alone. Proportional ramp scale is arguably right. | Fix the comment or honor set_type; templateLoads.test. S. Owner decision. |
| PLAN-4 | STILL PRESENT | P2 | Today.tsx useTemplate (~1003-1011) with no program still calls createPlannedWorkout(selectedDate,"") then applyTemplate on same date: stray empty DRAFT day on first-ever template use. | Create program only (or discard seed via soft-delete) ; Today test. S. |
| PLAN-5 | STILL PRESENT | P1 | Reachable in a live session: App.tsx renders the gear button in the topbar on every route including /session (inSession only swaps the wordmark), gear opens SettingsSheet, which has a Training maxes row opening TrainingMaxSheet (SettingsSheet.tsx:370,511). close() at TrainingMaxSheet.tsx:110-112 still does window.location.reload() when dirty. Loses in-memory staged reps/load/half-typed note; direct contradiction of AGENTS SW rule. Any lifter who sets a TM mid-session (first %TM session is the calibration case). Recoverable (outbox safe), but costs staged input. | Replace reload with a plan/TM-changed event (planChanges.ts notifyPlanChanged style) that Today/Session listen to and refetch v_resolved_prescriptions; test in screens Session/Today + SettingsSheet tests. M. |
| PLAN-6 | STILL PRESENT | P2 | CoachSheet retry (331-346) unchanged since d5e7b64: keeps user msg, refills draft, send appends a duplicate user turn; persisted attachments have data:"". | Pop trailing user msg too (or resend directly); CoachSheet test. S. |
| PLAN-7 | STILL PRESENT | P2 | recoverAnswer null still maps to "interrupted" with no re-poll and no catch (CoachSheet 147-170). Double-billing on re-ask, rare. | Poll a few times before declaring interrupted; add catch->reportError; coach tests. S-M. |
| PLAN-8 | STILL PRESENT | P3 | coach.ts:256 uses UTC date vs app_tz day. Display only. | todayLocalIso(); coach test with fake clock. S. |
| PLAN-9 | FIXED | - | Today.tsx ~512-530 now shows all confirmed programs' days when any has dated days; undated programs name the others (comment cites the hiding bug). Merged in train-d (c631cd6). | none |
| PLAN-10 | STILL PRESENT | P2 | sessionHistory.ts private fetchWithCache still swallows error, no reportError/stale reason (only unit-import lines changed). | Use makeFetchWithCache like checkinHistory; vitest sessionHistory. S. |
| PLAN-11 | CHANGED (still present) | P2 | History.tsx open-sets loader (now ~388-405) still an un-caught async IIFE; offline cold cache leaves openSets undefined/spinner + unhandled rejection. Screen was rewritten but the pattern remained. | try/catch -> reportError + error state; History test. S. |
| PLAN-12 | STILL PRESENT | P3 | max+1 day_index then separate inserts still in create/duplicate/save/apply; rare 23505 or empty DRAFT. | Move into DB fn with row lock (new migration). M. |
| PLAN-13 | STILL PRESENT | P3 | markdown.ts:64 italic regexes unchanged. Cosmetic. | word-boundary for `_`; markdown test. S. |
| PLAN-14 | STILL PRESENT | P2 | Login.tsx:101 `/^\d{6}$/` on trimmed raw; "123 456" rejected. Real login friction, trivially retried. | strip \s inside before test; Login test. S. |
| PLAN-15 | STILL PRESENT (speculative, not re-exercised) | P3 | clearedUp still only enqueues close and marks answered; local injuries unchanged. | Component test; drop episode from matchable set. S. |

Counts: STILL PRESENT 13, CHANGED (still present) 1 (PLAN-11), FIXED 1 (PLAN-9), NOT A BUG 0.
Priorities (of 14 open): P0 0, P1 3 (PLAN-1, PLAN-2, PLAN-5), P2 6 (4,6,7,10,11,14), P3 5 (3,8,12,13,15).

## Details P1

PLAN-1/2: lines data.ts:435-475 (duplicate), 682-720 (save template), 754-800 (apply). Hard-rule context: AGENTS says a superset/section/ramp is adjacency and "tearing apart is a bug class"; also bulk-insert NULL-union rule means any added key must be on all rows. Shared fix: one helper that copies the full prescription column set (set_type, section, tracking, superset_group, load_entry, entered_*), used by all three.

PLAN-5: path verified: App.tsx topbar gear (always rendered) -> SettingsSheet "Training maxes" row -> TrainingMaxSheet close() reload. Component comment's claim (IndexedDB keeps outbox/active session/rest timer) is true but omits in-memory staging. Note SettingsSheet rendered by App so it overlays /session.

## NEW findings
- NEW-plan-1 (P3, unconfirmed): Session.focus.test.tsx F4 and F-8 fail in this run with `localStorage` undefined at `localStorage.clear()` after `resetDbForTests()`. Likely env/ordering flake or a test that stubs globals; check whether it reproduces on main in isolation (`npx vitest run src/screens/Session.focus.test.tsx`). Not inspected further.


---

# Re-verification: rv-docs

# Re-verify: docs (STRUCT-*, CONTENT-*) at HEAD 1950a1f (audit base d5e7b64, 166 commits)

Priorities: P0 harmful/wrong action, P1 materially misleading, P2 stale harmless, P3 cosmetic. Docs only; no repo edits made.

## Table

| ID | Verdict | Pri | Note |
|---|---|---|---|
| STRUCT-001 AGENTS.md oversized | STILL PRESENT, worse (949 -> 1131 lines) | P2 | Always loaded by 3 tools; cost is tokens, not wrongness. Fix: dedicated change moving incident narratives to decisions.md. |
| STRUCT-002 duplication | STILL PRESENT | P2 | security.md/architecture.md/README still restate AGENTS rules. |
| STRUCT-003 orphan docs | CHANGED, worse | P2 | 7 new Version D plans, 1 spec, live-load-sync-e2e.md, pwa/e2e/README.md added; still no index. 2026-09-30-load-sync-recovery now gets a Status section (152) and roadmap links Version D report, but plans dir has no index. |
| STRUCT-004 two broken links (E1rmChart/VolumeChart in 2026-09-19 audit) | STILL PRESENT | P3 | Frozen audit. |
| STRUCT-005 no docs index | STILL PRESENT | P2 | No docs/README.md; AGENTS Layout does not list audits/plans/specs/flows/architecture/security/setup. |
| STRUCT-006 untracked 10-01 audits | FIXED (committed; now 3 files incl. -transitions) | P3 | Residual: still unlinked from roadmap, ledger, AGENTS (grep finds no inbound). |
| STRUCT-007 routing thin; ledger 09-24 | CHANGED | P2 | Ledger/roadmap now carry a Version D block (see NEW-docs-1) but "Reconciled 2026-09-24 / main at 4da2c7d" block is untouched. |
| STRUCT-008 naming | STILL PRESENT | P3 | |
| STRUCT-009 spec.md/plan.md legacy | STILL PRESENT | P3 | |
| STRUCT-010 settings.local.json | STILL PRESENT (local, gitignored) | P2 | Still has `Bash(gh repo *)`, `git remote *`, one-off perl/rm/node entries. Narrow `gh repo *` to `gh repo view *`; delete the 4 one-offs. |
| STRUCT-011 launch.json | NOT A BUG (info) | - | |
| STRUCT-012 worktree clutter | STILL PRESENT, worse | P3 | 7 non-main worktrees: .worktrees/{checkin-redesign, live-session-plan, visual-system, warm-precision}, ~/.codex/worktrees/{load-sync-recovery, training-scene-integrity, version-d-plan}. version-d-plan branch (125d203 ancestor of main) is merged. AGENTS now asks to delete merged worktrees. |
| CONTENT-001 README says OAuth not built / pinned user id | STILL PRESENT (README untouched since 0166154) | P1 | README:9,13,39-46 tell a reader (and a friend connecting) the wrong auth model; security.md:33-43 and architecture.md:11 same. See fixes. |
| CONTENT-002 roadmap/ledger frozen | CHANGED | P1 | Version D block added, but it is wrong now (NEW-docs-1); "Remote migrations match local through 20260924052445" still stale (migrations now end 20261001010000; 20260924190000/200000, 20261001000000/010000 newer). 09-30 load-recovery/units work and `exercise_prefs`/`goals` migrations absent from roadmap status. |
| CONTENT-003 no decisions entry for 9-30 work | FIXED | - | decisions.md now has 798 more lines, 10-01 entries (loads derived once, plate math, prefs sync, integrating seven branches...). Chronology of the 677-814 region not rechecked. |
| CONTENT-004 tool count 22/14/41 | STILL PRESENT | P2 | README:53 "22", mcp-server/README:6 "14", architecture.md:127 "41". Fix: drop numbers from README and mcp-server README; keep architecture's. |
| CONTENT-005 README phase pointer / 6 screens | STILL PRESENT | P2 | README:56 "6 screens" (7 non-test screens), README:82 "Phase 0 merged; Phase 1 is next". Fix: "see roadmap for current phase". |
| CONTENT-006 coach disabled-tool list | STILL PRESENT | P1 | See detail. |
| CONTENT-007 ledger inconsistencies | STILL PRESENT | P2 | Header run-on dup of roadmap; A-134/A-137/138 wording unchanged. |
| CONTENT-008 plan checkboxes not a status signal | STILL PRESENT, worse | P2 | 8 more plans (Version D x7 + local-verification) added; none checked as a rule. |
| CONTENT-009 tunnel/relay still documented live | STILL PRESENT | P2 | setup.md:165,207-220 still say "Use the tunnel"/"why the relay exists"; CI still runs the 3 strength-tunnel/relay tests. Memory says fallback, never installed. Label section "fallback, not installed". |
| CONTENT-010 dev-block test list shorter than CI | FIXED | - | Dev block now lists the same 6 files as "Tests, by area". |
| CONTENT-011 AGENTS size/voice | STILL PRESENT | P3 | |
| CONTENT-012 | NOT A BUG | - | |
| CONTENT-013 untracked audits | FIXED (committed) | P3 | Same residual as STRUCT-006. |
| Memory: MEMORY.md index | STILL PRESENT | P2 | app-adapts-to-lifter.md still not indexed (9 files, 8 indexed). |
| Memory: strength-tracker-project | STILL PRESENT (file untouched since Aug 26) | P1 | Says "OAuth deliberately not built", "service role pinned to OWNER_USER_ID", "Phase 4 pending", "checkout behind origin". A future session loading this will believe the pre-multi-user, pre-OAuth model. |
| Memory: parallel-sessions | STILL PRESENT | P2 | Says codex worktrees in `.worktrees/codex-*`; they live under ~/.codex/worktrees now. |
| Memory: deploy-sequencing | STILL PRESENT | P2 | Header/description say commits are not deploys; own later paragraph says CI deploys since 9-12. |
| Memory: users-and-audit | STILL PRESENT | P1 | Tells the agent to "read PICK UP HERE in gaps-roadmap first"; that plan is marked "Do not execute". Wrong entry point. |
| Memory: mcp-oauth | STILL PRESENT | P3 | "Follow-up offered, not done: set_training_plan has no confirm_change gate" is done (AGENTS.md:~578 documents it). |

## P1 details and exact fixes

CONTENT-006 (coach disabled-tool list). Code (supabase/functions/coach/index.ts, `configs` block ~1162-1181) disables SIX tools: delete_program, delete_exercise, update_exercise, set_training_plan, confirm_training_plan, confirm_program. AGENTS.md:844 lists three and the "Areas that should not be modified" bullet (AGENTS.md:1039-1042) lists three. AGENTS.md:729 covers the two plan tools; confirm_program (coach cannot confirm a live plan) appears nowhere in AGENTS (line 236 only says confirm needs approval). A future agent could "restore" confirm_program for the coach thinking it is unrestricted.
Fix, AGENTS.md:844: append sentence "Also off for the coach: `set_training_plan`, `confirm_training_plan` (strategy is a desk decision) and `confirm_program` (the coach drafts; a person confirms outside the in-app coach). `upsert_program` stays on (drafts land unconfirmed)."
Fix, AGENTS.md:1039-1042: change list to "`delete_program`, `delete_exercise`, `update_exercise`, `set_training_plan`, `confirm_training_plan` and `confirm_program`".
Note: the pasted comment in index.ts says "Claude Desktop keeps both" for the plan tools; confirm_program rationale commit is c4565ca.

CONTENT-001 (README/security/architecture OAuth framing). Fix README:9 diagram to "mcp-remote (bearer token) or claude.ai/ChatGPT (OAuth sign-in)"; README:13 "service role, pinned user id" -> "service role, user resolved per request from the token"; README claim at 39-46: replace "static bearer ... without running an OAuth 2.1 authorization server ... upgrade path is documented, not built" with "A bearer token (mcp_tokens, SHA-256 stored) or a Supabase OAuth access token carrying client_id (lib/oauth.ts, shipped 2026-09-13) resolves to a user; the server never trusts a plain session JWT." security.md:33,43 and architecture.md:11: "static bearer token" -> "bearer or OAuth token"; delete "(vs. running a full OAuth 2.1 server)" tradeoff sentence or say "OAuth sign-in is accepted alongside bearer tokens". Consistent with AGENTS Identity bullet.

CONTENT-002 (roadmap/ledger). Fix roadmap "Current status": replace "through `20260924052445`" with "through `20261001010000`" ONLY after confirming remote with `supabase migration list`; add a 2026-10-01 line: "main includes Version D, load-sync recovery, per-user exercise_prefs and goals (decisions.md 2026-10-01)".

Memory fixes (give to owner; I did not edit):
- strength-tracker-project.md: replace body with 3 lines pointing at AGENTS.md; delete the OAuth-not-built, OWNER_USER_ID, Phase 4, "behind origin" lines.
- strength-tracker-users-and-audit.md line 15: replace "read the gaps roadmap first" with "entry point is docs/roadmaps/2026-09-19-consolidated-roadmap.md and release-ledger.md; gaps-roadmap is historical, do not execute".
- MEMORY.md: add `- [App adapts to lifter](app-adapts-to-lifter.md) — <existing description>`.

## NEW defects in d5e7b64..HEAD docs

NEW-docs-1 (P1) Ledger and roadmap say Version D is "branch-local on `codex/version-d-light-plan`" and "not a deployment receipt" (ledger:6, roadmap:3-5), but 125d203 (the cited source) is an ancestor of main and decisions.md says Version D was ported onto the codex session and integrated. An agent reading the status source of truth will think the redesign is unmerged and may re-implement or skip it (the exact duplicate-work failure AGENTS' new inventory section was written to stop). Fix: reword to "merged to main; production proof for phone/new-data acceptance still unperformed" and keep the acceptance-limits sentence; point at the merge commit.

NEW-docs-2 (P2) AGENTS.md "Before you start" says the second Version D copy was on `feat/live-workout-d` and 16 stale branches existed; `git worktree list` still shows merged branch `codex/version-d-light-plan` and the older .worktrees. Housekeeping the section itself prescribes (delete merged worktrees/branches) is not done. Fix: run the prescribed cleanup or note it.

NEW-docs-3 (P2) AGENTS.md:~210 (goals bullet) says PWA writes goals by direct PostgREST "online only", while the Hard rules header still says planned tables/`sets` etc. are the only PWA-direct writers via outbox; `goals` is a fourth write class not named in the "write-ownership" prose elsewhere (README claim 3, architecture.md:47-65 were not updated, architecture.md diff only +17). Fix: add `goals` and `exercise_prefs` to architecture.md write-ownership list.

NEW-docs-4 (P3) AGENTS.md live-workout bullet embeds a glyph ("checkmark", "burger") and says type is never below 11 px / 44 px controls: fine, but "Each has a test named for it" names none. Fix: name the test files or drop the claim.

NEW-docs-5 (P3) AGENTS.md test block: new "Pre-release gate, NOT CI" live-load-sync harness writes to /tmp/live-e2e. Harmless; ok.

Checked and fine: all new files referenced by AGENTS exist (scripts/work-inventory.mjs, rehearse-queue-repair.mjs, load-integrity.test.mjs, displayLoad.ts, exercisePrefsSync.ts, setLoad.ts, sessionFocus.ts, theme.ts, pwa/e2e/live-load-sync.mjs). AGENTS "Settings are DEVICE-LOCAL" bullet correctly updated for exercise_prefs. security.md exercise_prefs/goals sections match the AGENTS text.


---

# Original report: db

# DB layer audit (area DB)

Pinned: main d5e7b64, 2026-10-01. Read-only. Scope: supabase/migrations/*.sql (60 files, latest definitions), scripts/validate-db.mjs, scripts/check-selects.mjs.

Method: read every migration, then replayed the full chain in PGlite using the same shim as validate-db (auth.users table, auth.uid() GUC, `anon`/`authenticated`/`service_role` roles, and the harness's own `alter default privileges ... grant execute on functions to anon, authenticated` that models Supabase). Throwaway experiment scripts live in `.../scratchpad/audit/e*.mjs` (outside the repo). No repo files were touched.

Summary: 3 high, 4 medium, 6 low. Already-known items still present: A-43 (invalid `user_config.tz` breaks views), A-44 (phase overlap trigger raceable), A-48 (`coach_enabled` PUBLIC grant). Not re-reported below.

## Findings

### DB-1: Deleting an account fails for any user who has logged a set against a prescription

- Severity: high. Account erasure (and Supabase dashboard "delete user") is blocked for essentially every real user; likelihood is every account that trained against a plan.
- Location: supabase/migrations/20260924042220_protect_logged_prescription_edits_and_unify_plan_writes.sql:23-31 (trigger `prescriptions_keep_logged_history`, `before update or delete`), supabase/migrations/20260901030000_soft_delete_planned_workouts.sql:124-133 (original), cascades from 20260825120001_schema.sql (`user_id ... on delete cascade`).
- Evidence: `refuse_orphaning_logged_sets()` raises if `exists (select 1 from sets s where s.prescription_id = old.id)`. `delete from auth.users` cascades to programs, planned_workouts and prescriptions before it reaches `sets`, so the BEFORE DELETE trigger fires while the sets still exist. Replay in PGlite with one user owning program, day, prescription, session and one set referencing the prescription: `delete from auth.users where id = A` -> `ERROR: prescription 33333333-... has logged sets against it`. The same account with no sets deletes cleanly (e2). The training-max trigger (20260924200000) special-cases "deleting the person" with an `auth.users` existence check, but this trigger and `guard_prescription_plan_write` have no equivalent. Existing validate-db "deleting a user takes ..." checks never include a user with sets-on-prescriptions.
- Confidence: confirmed (reproduced).
- Limitation: tested in PGlite, not on Supabase; cascade ordering is the same engine behaviour. Did not test whether a service-role manual delete order (sets first) works as a workaround; it should, but sets have no delete path for admins except SQL.
- Verification path: add a validate-db case: user with a set whose `prescription_id` is non-null, then `delete from auth.users`; expect success and zero rows left. Fix is an `auth.users` existence short-circuit (as in refuse_rewriting_used_training_max) in `refuse_orphaning_logged_sets`.

### DB-2: Editing or deleting a training max fails with "permission denied for table users" for the `authenticated` role

- Severity: high. The PWA's same-day TM correction and TM delete are broken in production; reads and new-date inserts still work, so it can go unnoticed.
- Location: supabase/migrations/20260924200000_lock_training_max_history.sql:27-29 (and `create trigger` at the end); PWA callers pwa/src/lib/data.ts:1134 (`upsert ... onConflict user_id,exercise_id,effective_date`) and :1147 (`delete`).
- Evidence: the trigger function is SECURITY INVOKER and does `if not exists (select 1 from auth.users u where u.id = old.user_id) then return ...`. `authenticated` has no SELECT on `auth.users` (Supabase default, and in the harness). Replay as `set role authenticated`: `update training_maxes set value_kg = 155 ...` -> `permission denied for table users`; `delete from training_maxes ...` -> same. The only early exit is an UPDATE that changes none of the four columns. `setTrainingMax` on a date that already has a row is an UPDATE of `value_kg`, so it hits the check; so does every `deleteTrainingMax`.
- Confidence: confirmed in the harness privilege model (which grants authenticated nothing on auth tables); real-Supabase behaviour assumed from the platform default of no direct access to auth.users.
- Limitation: not run against live Supabase. validate-db runs these cases as the superuser (no `set role`), which is why the "A-203" checks pass.
- Verification path: validate-db case with `set role authenticated` + `app.user_id` for update and delete of a TM; fix by making the function SECURITY DEFINER with a pinned search_path, or by checking existence another way (for example `pg_trigger_depth()` or catching the cascade via the RI context).

### DB-3: `integration_encryption_key()` (and encrypt/decrypt) are executable by `anon` and `authenticated`

- Severity: high. SECURITY DEFINER function returns the at-rest encryption key for `integration_credentials`; reachable at `/rest/v1/rpc/integration_encryption_key` by an unauthenticated caller. Exploitation value is limited by the ciphertext table being service-role only, but a secret key is disclosed to the public by default, which defeats the point of A-159's fix.
- Location: supabase/migrations/20260921030000_encrypt_integration_secrets.sql:96-98.
- Evidence: `revoke all on function integration_encryption_key() from public;` (same for encrypt/decrypt). Supabase grants EXECUTE to `anon`/`authenticated` by default privileges at CREATE time, and `revoke ... from public` does not remove those explicit grants. 20260905030000 documents exactly this trap and revokes from `public, anon, authenticated`. Replay with the harness default privileges: `has_function_privilege('anon', ...)` is true for `decrypt_integration_secret`, `encrypt_integration_secret`, `integration_encryption_key` (e1 output). `integration_encryption_key` is `security definer` and returns the vault key (or `app.integration_key`).
- Confidence: confirmed in the harness model of Supabase defaults.
- Limitation: not run against live Supabase; if the project has already changed default privileges for `anon`, the exposure is smaller. Did not test what an anon caller receives end to end (the function body needs `supabase_vault` and the vault row).
- Verification path: add `has_function_privilege('anon'|'authenticated', 'public.integration_encryption_key()', 'execute')` = false checks to validate-db (only purge_expired_mcp_tokens and run_alert_sweep are covered today); new migration revoking from `public, anon, authenticated` on all three plus `_integration_xor_obfuscate`.

### DB-4: `reserve_coach_turn` is executable by `anon` and takes any `p_user_id`, `p_day_limit` and `p_month_token_limit`

- Severity: medium. An unauthenticated caller who knows a victim's user UUID can write 'reserved' `kind='turn'` rows that count against that user's daily message cap (and pass a huge limit so the call always succeeds), locking them out of the coach. Needs the victim's UUID, so not trivially exploitable.
- Location: supabase/migrations/20260921010000_reserve_coach_turn.sql:61 (`revoke all ... from public, authenticated`), function header lines 4-12.
- Evidence: `anon` is omitted from the revoke; harness shows `reserve_coach_turn: anon true, authenticated false`. Body is SECURITY DEFINER with `set search_path = public` (no `pg_temp`), inserts into `coach_usage` for the supplied user.
- Confidence: confirmed (grant), likely (exploit path).
- Limitation: did not exercise the RPC through PostgREST.
- Verification path: validate-db privilege check for anon on this function; revoke from `anon` and add `pg_temp` to the search_path.

### DB-5: v_adherence regressed to `app_tz()` (caller's tz) and again mis-buckets the TM day on the service-role path

- Severity: medium. MCP/coach reads of prescribed load for %TM prescriptions use the deployment default timezone instead of the lifter's, so the prescribed load and delta around a TM effective date can be null or from the previous TM; the PWA path stays correct, so the two disagree.
- Location: supabase/migrations/20260924003054_native_load_units.sql:~176 (`t.effective_date <= (s.performed_at at time zone app_tz())::date`). Correct form lives in 20260827180000_multi_user.sql (`app_tz(s.user_id)`).
- Evidence: this migration did `create or replace view v_adherence` from an older copy and dropped the multi-user fix. Replay: user tz Pacific/Auckland, set performed at 20:00 UTC (next day in Auckland), TM effective on the Auckland date. Superuser/service path: `prescribed_load_kg = null`. As `authenticated` (auth.uid() = A): `80.0`. This is the same class decisions.md calls out (multi-user tz fix).
- Confidence: confirmed.
- Limitation: tz offsets chosen to make the day differ; effect is zero when user tz equals the app_config default.
- Verification path: validate-db case comparing v_adherence for a non-UTC user as service role vs authenticated; restore `app_tz(s.user_id)`.

### DB-6: `working_sets` counts completion ticks and timed sets (reps 0) in four views

- Severity: medium. Mobility ticks and holds inflate "working sets" in weekly volume, weekly summary, session counts, and rank into `v_trend_digest`'s "top 5 exercises by working sets", which the coach reads every turn. Tonnage and e1RM stay correct.
- Location: supabase/migrations/20260827180000_multi_user.sql (v_weekly_volume), 20260825140000_planning_voids.sql (v_session_set_counts), 20260906040000_v_weekly_summary.sql (`trained`), 20260917010000_coach_observations.sql (`top5`).
- Evidence: PWA writes tick and time sets with `set_type: draft.setType` (default 'working') and `reps: 0` (pwa/src/screens/Session.tsx:1354-1356). Views filter only `set_type = 'working'`. Replay: two tick rows on Deadlift -> `v_weekly_volume.working_sets = 2, tonnage_kg = 0.00`; `v_weekly_summary.working_sets = 2`. AGENTS.md says volume excludes these "through the filters they already have", which is true for `sum(load*reps)` and `v_e1rm`, not for `count(*)`.
- Confidence: confirmed.
- Limitation: whether the coach/product wants ticks counted as "sets" is a product call; the invariant text implies not.
- Verification path: add `reps > 0` (not a `tracking` filter, which the rules forbid) to the counted rows, with a validate-db case using a reps-0 working set.

### DB-7: `v_adherence.rep_outcome` is 'missed' for every completed tick and timed set

- Severity: medium. A done/time prescription has `reps_min >= 1` (CHECK), the logged set has reps 0, so `s.reps < p.reps_min` -> 'missed'. `get_session_diff`, `get_lift_history` and `lastTime.ts` pass `rep_outcome` through unfiltered, so the coach can read activations/holds as misses.
- Location: supabase/migrations/20260924003054_native_load_units.sql (case expression), consumers supabase/functions/mcp-server/tools/get_session_diff.ts:158, get_lift_history.ts:177, lib/lastTime.ts:143.
- Evidence: replay: prescription `tracking='done'`, reps_min 10, tick set with prescription_id -> `rep_outcome = 'missed'`.
- Confidence: confirmed in SQL; coach-side effect likely (did not read the prompt for guards).
- Limitation: a consumer may special-case tracking; I did not check every renderer.
- Verification path: validate-db case above; either return null outcome when the prescription's `tracking <> 'reps'` (reading the prescription's column is not coupling to a view filter) or document and filter in consumers.

### DB-8: Composite `ON DELETE SET NULL` FKs null `user_id` as well

- Severity: low. Latent: a parent delete that reaches a child through `set null` raises NOT NULL on `user_id`.
- Location: supabase/migrations/20260921020000_parent_fks_and_nan.sql (`sessions_planned_workout_user_fkey`, `sets_prescription_user_fkey`, `session_skips_prescription_user_fkey`, `checkins_session_user_fkey`, `pain_checks_session_user_fkey`, `activities_planned_workout_user_fkey`).
- Evidence: Postgres nulls every referencing column unless given a column list (`SET NULL (col)`, PG15+). Replay as `authenticated`: an activity pointing at a template, then deleting the template (the allowed hard delete, `pw_delete_template`) -> `null value in column "user_id" of relation "activities" violates not-null constraint`. Most other paths are shielded by triggers or never delete parents; account-deletion cascade passed (e2).
- Confidence: confirmed for activities->template; likely latent elsewhere.
- Limitation: Supabase PG version supports column-list SET NULL (15+); not checked.
- Verification path: validate-db case; switch to `on delete set null (planned_workout_id)` etc.

### DB-9: Parent-FK hardening (A-03) is incomplete

- Severity: low. Needs a victim's unguessable UUID; effect is cross-tenant row pollution or unique-slot squatting, not disclosure.
- Location: plan_phases.plan_id (20260905060000), programs.phase_id (same), checkins.episode_id / activity_id (20260916000000, 20260907040000), pain_checks.episode_id / activity_id, red_flags.episode_id, activities.duplicate_of (also A-104), exercise-referencing FKs (sets/prescriptions/goals/training_maxes/session_skips/exercise_notes -> exercises can point at another user's private custom exercise id).
- Evidence: none of these were given `(id, user_id)` composite FKs in 20260921020000; RLS insert checks only `user_id = auth.uid()`; FK checks bypass RLS. Example: user A inserts a `plan_phases` row with `plan_id` of B's plan and `position = 0`, occupying `unique (plan_id, position)`; the overlap trigger runs as invoker and cannot see B's phases.
- Confidence: likely (not replayed).
- Limitation: not executed; UUID unguessability is the mitigation.
- Verification path: extend the existing parent-FK validate-db check to these columns.

### DB-10: NaN hardening (A-49) misses `goals.target_e1rm_kg` and several `activities` measurements

- Severity: low. Owner-writable; PostgREST casts the string 'NaN' to numeric. Self-poisoning of own aggregates only.
- Location: supabase/migrations/20260825120001_schema.sql (`goals.target_e1rm_kg > 0`), 20260907030000_activities.sql (`distance_m`, `ascent_m`, `descent_m`, `avg_power_w`, `avg_cadence` use `>= 0`).
- Evidence: replay: `insert into goals ... 'NaN'` succeeds; manual activity with `distance_m 'NaN'` succeeds and `v_weekly_endurance.distance_m` returns `NaN`. NaN > 0 and NaN >= 0 are true in Postgres. The ledger lists A-49 as fixed.
- Confidence: confirmed.
- Limitation: path via PostgREST text cast not exercised.
- Verification path: add `col = col and col <= max` style checks (as done for sets/prescriptions) and a validate-db case per column.

### DB-11: Views that otherwise bucket in the user's timezone use the database `current_date` / `now()` date

- Severity: low. Off-by-one-day window edges near midnight for non-UTC users.
- Location: v_trend_digest `top5` (`week_start >= current_date - 56`, 20260917010000), v_cycle_screen `current_date` (20260907040000).
- Evidence: `current_date` is the session/DB date (UTC on Supabase), not `app_tz(user_id)`; the rest of the file uses `app_tz(t.user_id)`.
- Confidence: likely (by reading).
- Limitation: effect is small; not replayed.
- Verification path: replace with `(now() at time zone app_tz(user_id))::date`.

### DB-12: Custom-exercise ownership is claimable in the gap between two MCP statements

- Severity: low (speculative). `add_exercise` inserts the exercise, then inserts `exercise_owners` in a second call; `exercise_owners_insert` lets any authenticated user insert an owner row for any `exercise_id` with `user_id = auth.uid()` (FK bypasses RLS). A user who can guess the slug could win the claim in the window.
- Location: supabase/migrations/20260827180000_multi_user.sql (policy `exercise_owners_insert`), supabase/functions/mcp-server/tools/manage_exercises.ts:200-224.
- Confidence: speculative.
- Limitation: not exercised; window is milliseconds; failure also triggers the tool's compensating delete.
- Verification path: restrict the insert policy to rows whose exercise is already visible and unowned only via the trigger, or write both rows in one RPC.

### DB-13: Test harness gaps that let DB-1, DB-2, DB-3, DB-5 through

- Severity: low (process). Not a product bug but the reason the above shipped green.
- Location: scripts/validate-db.mjs, scripts/check-selects.mjs.
- Evidence: validate-db runs almost all behavioural checks as the superuser (the `set role` count is 32 against ~3800 lines), so privilege failures on `auth.users` never show; function-grant checks cover only `purge_expired_mcp_tokens`, `run_alert_sweep`; no check runs the service-role view path (`app_tz()` with null `auth.uid()`). check-selects only parses `.select()` lists from a hand-kept file list (no `.insert/.update/.eq/.order` column names, no coach/push-alerts function files) and its harness setup omits the default-privilege shim.
- Confidence: confirmed (by reading).
- Verification path: add a generic loop asserting no SECURITY DEFINER function in `public` is executable by `anon` or `authenticated` unless allow-listed; run key DML as `authenticated`.

## Checks run and results

- `node scripts/build-exercise-seed.mjs && npm --prefix scripts ci && node scripts/validate-db.mjs && node scripts/check-selects.mjs`: all passed ("all checks passed", "474 selected columns all exist"). `git status` before and after: only the two untracked docs/audits files; build-exercise-seed changed no tracked files (seed output is untracked/ignored), so no `git checkout` was needed.
- Own PGlite replays of the full migration chain: grants scan, RLS/security_invoker scan, account deletion (with and without sets), training-max DML as `authenticated`, v_adherence tz, NaN inserts, tick/time set effects (scripts e1-e6 in the scratchpad).
- Programmatic scans on the migrated schema: no public table without RLS; no view without `security_invoker=true`; no INSERT policy with a null WITH CHECK; UPDATE policies without WITH CHECK are the six `user_id = auth.uid()` ones, which default to USING (safe); all policies are `to authenticated`; every function has a pinned search_path (reserve_coach_turn and purge_expired_mcp_tokens lack `pg_temp`).

## Clean areas

- RLS: append-only `sets`, `set_voids`, `session_skips` have no UPDATE/DELETE policy; `programs_delete`, `exercise_owners_delete` gone; remaining DELETE policies are the intended ones (templates, bw, memory, cycle, observations, goals/tm). Service-role-only tables (`mcp_tokens`, `push_config`, `integration_credentials`) have RLS and no policies. Idempotency-by-client-id intact.
- `v_live_sets` / `v_live_activities` carry every column of their base tables now; no view reads `sets`/`activities` directly except intended guards (void/discard checks, triggers) and `v_bodyweight` (not set-derived).
- v_weekly_summary: planned_days and planned_days_done are separate counts, no ratio; drafts excluded; tz via `app_tz(user_id)`.
- v_e1rm filters (working, 1-8 reps, load>0) correct; reps-0 and time rows excluded from e1RM and tonnage.
- Plan-lock family (guard_prescription_plan_write, guard_planned_workout_update, lock_planned_workout_for_session, swap/replace/apply functions): invoker functions, owner scoped, locks taken parent-first; final definitions consistent across the five 20260924* rewrites; discard-vs-late-set race resolved by row lock (trigger tuple lock + fresh statement snapshot).
- restore_session_for_late_set: replay early-return, owner check, restore under row lock all consistent; 23514 on discard-with-sets.
- Activity dedup matcher: conservative, user-scoped, source-different, first row wins; measurement lock trigger covers the listed columns.
- Phase overlap trigger logic (apart from known A-44), training_plans single-live index, replace_training_plan (advisory lock, confirm gate, service_role only).
- Account deletion path for users with no sets (sessions, checkins, skips, pain checks, training maxes) works.
- coach_usage: no client write path; reserve_coach_turn's advisory lock and duplicate-turn handling are sound apart from the grant (DB-4).

## Not covered

- Live Supabase behaviour (default privileges, `auth.users` grants, pg_cron/pg_net/vault). Findings DB-2 and DB-3 rely on the harness model matching Supabase.
- Edge-function and PWA callers beyond the specific call sites quoted; v_symptom_episode_state's exact-7-day streak assumption (no writer exists in code yet, so not assessed).
- Performance of `app_tz(uuid)` called per row inside views (functions with SET clauses are not inlined), and index adequacy.
- Concurrency tests (two sessions racing); only reasoned from lock order.
- seed SQL correctness and the generated exercise data.


---

# Original report: mcp

# MCP server audit (supabase/functions/mcp-server), pinned main d5e7b64, 2026-10-01

Area prefix MCP. Read-only audit. No repo files touched.

## Summary

0 critical, 1 high, 9 medium, 7 low. No cross-user read leak and no forbidden write (sets/sessions/set_voids/set_notes) found. Every user-owned-table query I traced carries `.eq("user_id", db.ownerId)` or goes through a user-scoped view. The findings are mostly (a) a shared-library write that any token holder can make, (b) DB guards added in the 20260924* migrations that the tools do not pre-check, so they surface as "Unexpected server error", and (c) truncation and URL-length edges.

---

### MCP-1: Any authenticated user can rewrite shared seeded exercises (name, muscles, equipment, category) for every account

- Severity: high (open sign-up means any lifter with an MCP token can edit rows that feed every other account's PWA and coach context; no undo path in the tool)
- Location: tools/manage_exercises.ts:262-330 (update_exercise), assertVisible at :40-48; lib/handler.ts:90 registers it for all callers
- Evidence: `assertVisible` returns early for `source !== "custom"`, then the patch is applied with `db.client.from("exercises").update(patch).eq("id", args.id)` and `patch.source = "edited"`. Only `instructions` is gated (`assertInstructionsAllowed`). `name`, `primary_muscles`, `equipment` ('barbell'/'machine' toggle the plate calculator), `category`, `level` are free on shared rows. AGENTS.md says the exercise name is "untrusted cross-user input" because it flows into every other user's coach context, yet the only protection is the in-app coach's connector allowlist. Claude Desktop, claude.ai and ChatGPT tokens of any user keep the tool. Input -> user B calls `update_exercise {id:"Barbell_Squat", name:"<80 char injected instruction>"}` -> every account's `search_exercises`, `get_program`, context block now show it. The DB name CHECK limits length and control chars but not content.
- Also: update_exercise never sets `updated_by` (the migration comment says the service-role path should name the token's user), so the audit trail for such edits is null.
- Confidence: confirmed (code path); not exercised against a live DB
- Limitation: did not check whether production RLS or a DB trigger restricts updates by role (the service role bypasses RLS anyway)
- Verification path: add a test in manage_exercises.test.ts that a non-owner updating a `free-exercise-db` row's name is refused; or restrict shared-row edits to an operator allowlist.

### MCP-2: set_training_max "same date overwrites" now fails with a generic 500 once the TM was in force

- Severity: medium (documented behavior broken for exactly the case it exists for: correcting a TM after sessions used it; model sees no actionable message and Sentry gets paged)
- Location: tools/set_training_max.ts:68-82; supabase/migrations/20260924200000_lock_training_max_history.sql (trigger `training_maxes_keep_history`, errcode 23514)
- Evidence: tool description says "the same date overwrites"; code does `.upsert(..., {onConflict:"user_id,exercise_id,effective_date"})`. The trigger raises 23514 on UPDATE when logged %TM working sets fall in the TM's window. `must()` throws a plain Error -> guard returns "Unexpected server error. Reference request_id ...".
- Confidence: likely (traced from migration; not run)
- Limitation: relies on the trigger text; did not run it in PGlite
- Verification path: PGlite/Deno test: insert TM, log a set against a %TM prescription, call set_training_max with same date and different value, expect a ToolError telling the model to use a new date. Pre-check or map 23514 to ToolError.

### MCP-3: update_planned_workout / DB session locks surface as "Unexpected server error"

- Severity: medium (common mid-workout request "swap this exercise" or "move today" hits it; message gives no recovery hint; each hit also reports to Sentry)
- Location: tools/update_planned_workout.ts:218-295 (pre-check reads only `sets`), :279-293 (rpc error -> `throw new Error`)
- Evidence: the pre-check refuses only when a set exists against the day's prescriptions. Migrations 20260924040112 and 20260924044136 also refuse any edit while an open session points at the day (errcode 55000), and lock structure once any non-discarded session references it. Those raise inside `replace_planned_workout_prescriptions`; the tool rethrows a plain Error. Same for repeat_planned_workout's insert path being fine, but update (label/notes/date patch too: trigger is `before update of day_index, scheduled_date, label, notes`) is affected.
- Confidence: likely
- Limitation: did not read the final text of 20260924044136's session-lock condition beyond the grep lines
- Verification path: test with a mocked rpc error {code:'55000'} expecting ToolError("finish or discard the active session"); or add a sessions lookup for the day.

### MCP-4: `.in("set_id", ids)` lists with hundreds of UUIDs build URLs the gateway may refuse

- Severity: medium (get_lift_history for a frequently trained lift is the flagship read; failure is total, not partial)
- Location: tools/get_lift_history.ts:146-152 (up to 500 ids, ~18.5 KB), tools/get_recent_sessions.ts:189-198 (up to 400 ids, ~14.8 KB), lib/lastTime.ts:134-139 (up to 1000 ids, ~37 KB), tools/find_similar_days.ts:133-141 (300 day ids, ~11 KB)
- Evidence: resolve_exercises.ts:312-318 documents that a long `in.(...)` "builds a URL long enough to be refused outright"; the same pattern is used unguarded in these four places. postgrest-js sends GET; ids are 36 chars + comma. A 90-day window of a lift trained 3x/week x 6 sets is ~230 sets, already near an 8 KB request-line limit.
- Confidence: speculative on the exact gateway limit; confirmed that the code builds the long URLs
- Limitation: no network access to test the real Supabase gateway threshold
- Verification path: against a staging project call get_lift_history for a lift with >300 live sets; or chunk ids in batches of ~100.

### MCP-5: get_recent_sessions include_sets drops the NEWEST sets when the cap is hit

- Severity: medium (the use case is "how did yesterday go"; the truncation hides precisely that)
- Location: tools/get_recent_sessions.ts:150-165
- Evidence: `.order("performed_at", { ascending: true }).limit(SET_CAP /*400*/)` across all returned sessions (n up to 50). get_lift_history deliberately fetches newest-first for this reason (comment at :19-22); this tool does the opposite. `sets_truncated` is flagged, but the missing rows are the latest session(s). Same ascending+cap shape in lib/lastTime.ts:111-122 (cap 1000, small impact).
- Confidence: confirmed
- Limitation: none
- Verification path: unit test with 20 sessions x 30 sets and assert newest session present.

### MCP-6: search_exercises ranks AFTER truncating alphabetically, so trained movements can be missing

- Severity: medium (the guidance tells the model to prefer trained entries; for a broad term like "press" or "squat" the trained one may be beyond row 20 and never shown, so the model picks an untrained variant and splits history)
- Location: tools/search_exercises.ts:93-112 (`.order("name").limit(args.limit)`) then trained-first sort at :190-197; same shape in resolve_exercises.ts:170-172 (`slice(0, PER_NAME_CANDIDATES)` before ranking, 20 alphabetical)
- Evidence: ranking happens on the already-cut page. For resolve_exercises the rows are all fetched (limit 2000) and then cut to 20 alphabetically before `rankCandidates`, so a trained "Squat" variant sorted 25th is invisible and the result can be "ok" on an untrained variant.
- Confidence: confirmed (code); impact depends on library size per term
- Limitation: not measured against the real 873-row library
- Verification path: resolve_exercises test with 30 alphabetical candidates where the trained one is #25; expect it top.

### MCP-7: The `trained` ranking map misses lifters whose history is large (limit 1500 / 400 sets of newest rows)

- Severity: low
- Location: tools/resolve_exercises.ts:350-363, tools/search_exercises.ts:160-171
- Evidence: trained facts come from the newest 1500 (resolve) or 400 (search, filtered to the candidate ids) live sets. A movement not touched in the last 1500 sets reads `trained:false`; the tool text says `logged_sets` is "within their recent history", but `trained:false` is stated as fact.
- Confidence: confirmed
- Limitation: none
- Verification path: none needed beyond reading.

### MCP-8: repeat_planned_workout "last time" is the most recent non-discarded session even if it has zero sets

- Severity: medium (a start-then-abandon left open or ended with no sets masks the real previous session, so no loads or order carry forward and the result claims `last_trained` with an empty session)
- Location: lib/lastTime.ts:92-105 (picks `latest` per day with no ended_at or set-count filter), tools/repeat_planned_workout.ts:203-212
- Evidence: `.is("discarded_at", null).order("started_at", desc)` and the first row per day wins. AGENTS.md notes the overnight sweep only discards the session this device holds, and foreign empty sessions "are left OPEN", so empty non-discarded sessions are an expected state. `lastWorkingLoads([])` is empty -> `refreshedLoads` returns all nulls -> exact copy; `note` says "had never been trained" only when `last === null`, which is false here.
- Confidence: likely
- Limitation: did not reproduce with seeded data
- Verification path: lastTime test with two sessions on one day, newest empty; expect the older one.

### MCP-9: Legacy `load_kg` + `load_entry:"per_side"` documentation says "must be doubled"; code and test store it as the total

- Severity: medium (model following the schema text passes 30 for a 30 kg-each pair, DB stores 30 total flagged per_side, UI shows "15 x 2", e1RM/volume understate by half; `sets` analytics unaffected but plan loads wrong)
- Location: lib/prescriptions.ts:110-126 (description of `load_entry`), lib/prescriptions.ts:405-411 (no doubling for legacy `load_kg`), lib/prescriptions.test.ts:101-110 (asserts no doubling), tools/upsert_program.ts:77-82 (`kgLabel` halves it)
- Evidence: description: "per_side means the authored value is one hand and must be doubled when producing load_kg". `prescriptionRows` doubles only for the new `load:{value,unit,entry:"per_side"}` object; legacy `load_kg` is stored as given.
- Confidence: confirmed
- Limitation: new clients use `load{}` and are fine; only legacy-input callers are exposed
- Verification path: fix the description (load_kg is the TOTAL) or double in code; the existing test pins current behavior.

### MCP-10: The MCP prescription schema cannot express `tracking:'time'`; editing a timed day through update_planned_workout silently converts it to reps

- Severity: medium (data shape loss on a day the PWA authored; no error)
- Location: lib/prescriptions.ts:51-61 (`tracking: z.enum(["reps","done"])`), lib/loop.ts RxRow type; supabase/migrations/20260906030000_tracking_time.sql adds 'time'
- Evidence: get_program returns `tracking:'time'` rows; update_planned_workout replaces the whole day from the caller's list, and the only legal values are reps/done, so a restated carry or hold is written as `reps` (default). repeat_planned_workout is fine because it copies rows without zod.
- Confidence: confirmed
- Limitation: not checked whether the coach prompt tells the model to avoid editing such days
- Verification path: add 'time' to the enum (and `duration` fields if the table has them) or refuse restating a day that has time rows.

### MCP-11: add_exercise leaks existence of another user's custom exercise id, and the derived-id scheme collides globally

- Severity: medium (violates the "unknown, never forbidden" rule; also blocks legitimate creation)
- Location: tools/manage_exercises.ts:174-209
- Evidence: id = `name.replace(/[^0-9a-zA-Z]+/g,"_")`, inserted into the global `exercises.id` space. On unique violation the tool says "Exercise id 'X' already exists. Use update_exercise ...". If X is another user's custom row, update_exercise then says "No exercise" (assertVisible), so the first message confirms that someone else owns that id. Names with accents or non-Latin script collapse ("Écarté" -> "_cart_", "スクワット" -> "_"), so a second custom exercise from any user collides with the first. A 23505 against a SEEDED id also tells the model to use update_exercise, which routes into MCP-1.
- Confidence: confirmed
- Limitation: ids are guessable slugs, so the practical leak is low value, but it breaks the stated invariant
- Verification path: test add_exercise twice as two users; second should get a neutral "pick another id" without "already exists".

### MCP-12: get_bodyweight from/to compare local dates against a UTC timestamptz, so the `to` day is excluded

- Severity: low
- Location: tools/get_bodyweight.ts:80-87; v_bodyweight.measured_at is timestamptz (20260906020000_bodyweight_log.sql:19)
- Evidence: `.lte("measured_at", args.to)` with `to="2026-10-01"` resolves to 2026-10-01T00:00:00Z, so every weigh-in on the `to` date (and the user's local evening of the previous day in the west) is excluded; description promises "bound by local date". Also `mean_7d/28d` cut against `Date.now()`, not against the requested window. Input regex does not call assertIsoDate, so `2026-02-30` reaches Postgres as an opaque 500 (also in get_checkins.ts:104-117 and get_checkin_buckets.ts:49-60, `Date.parse("2026-02-30")` is a valid Mar 2 in V8, so the span check passes).
- Confidence: confirmed
- Limitation: none
- Verification path: test with a weigh-in at 2026-10-01T15:00Z and to=2026-10-01.

### MCP-13: get_program and list_programs silently truncate at PostgREST's row cap on long programs

- Severity: medium (repeat_planned_workout deliberately keeps appending days to one program; a long-lived program can pass 1000 prescription rows with no truncation flag, so the model edits from an incomplete read; AGENTS warns upsert_program-from-memory drops prescriptions)
- Location: tools/get_program.ts:196-218 (`v_resolved_prescriptions` with `.in("planned_workout_id", all day ids)`, no range/limit, also URL length per MCP-4), :313-330 (v_plan_workouts counts)
- Evidence: ~125 days x 8 prescriptions hits 1000; the `in` list of 125+ ids is ~4.7 KB. Contrast find_similar_days.ts:130-150 which pages.
- Confidence: likely
- Limitation: PostgREST `max-rows` for this project assumed to be the default 1000
- Verification path: seed 130 days x 8 rx and call get_program; compare prescription_count to DB.

### MCP-14: find_similar_days returns un-trained clones first and caps at 300 days

- Severity: low
- Location: tools/find_similar_days.ts:100-112, 147-153
- Evidence: results are ordered by `scheduled_date desc`; a repeated day (untrained, `last_time:null`) outranks the trained original within `limit` (default 5). Days beyond the newest 300 are ignored and `days_considered` does not say it was capped. Jaccard itself is correct (empty vs empty = 0, dedup via Set, intersect/union right).
- Confidence: confirmed
- Limitation: none
- Verification path: test with 6 clones of one trained day and limit 5.

### MCP-15: Race and consistency edges in plan writers (no lock around read-then-insert)

- Severity: low
- Location: tools/repeat_planned_workout.ts:253-285 (max(day_index)+1 then insert), tools/upsert_program.ts:581-612 (addDaysToProgram), :375-415 (same-name lookup then insert)
- Evidence: two concurrent calls compute the same `day_index` and one gets a unique violation -> generic 500; two concurrent same-name upserts both pass the lookup and both survive (the old-unconfirmed supersede list is computed before insert). Concurrent repeat of the same day on the same date creates duplicate dated days; nothing checks for an existing day on `scheduled_date` in the program.
- Confidence: likely
- Limitation: no concurrency test
- Verification path: Promise.all of two repeat calls in PGlite.

### MCP-16: Input bounds missing on several writes (huge numbers, long strings) end as generic 500s or unbounded storage

- Severity: low
- Location: lib/prescriptions.ts:77-93 (`load.value`, `load_kg` only `.positive()`), set_training_max.ts:30, set_goal.ts:28 (`value_kg`, `target_e1rm_kg` `.positive()`), manage_exercises.ts:101 (name no max; DB CHECK is 80 chars, so >80 or newline -> "Unexpected server error"), feedback.ts:76-87 (`detail`, `context` unbounded), coach_observations.ts:111-121 (`evidence` unbounded JSON; `check_back_on` regex only, no assertIsoDate), resolve_exercises.ts:322 (`names` entries unbounded, builds the URL)
- Evidence: e.g. `load.value: 1e300` passes zod and overflows `numeric`; 5 MB `feedback.detail` is stored. Not exploitable beyond one's own rows but a token holder can bloat storage and trigger Sentry noise.
- Confidence: confirmed (schemas); DB-side limits not all checked
- Limitation: unknown Supabase request body cap
- Verification path: add `.max()` bounds and assertIsoDate; test oversize inputs return ToolError.

### MCP-17: Defense-in-depth gaps on the in-app coach's ephemeral tokens

- Severity: low (relies solely on the coach connector allowlist, which is outside this scope)
- Location: tools/delete_program.ts:44-96, tools/manage_exercises.ts (update/delete), tools/training_plan.ts:487-492
- Evidence: `refuseIfEphemeral` guards confirm_program, confirm_training_plan, and `confirm_change=true` paths, but delete_program with `confirm_delete_confirmed=true` and update_exercise/delete_exercise do not check `ctx.ephemeral`. The "confirm" flags are model-supplied booleans, so for ephemeral callers the gate is only the connector's disabled-tools list.
- Confidence: confirmed
- Limitation: coach/index.ts not in scope
- Verification path: add refuseIfEphemeral to delete_program's confirmed branch plus a test like lib/ephemeral.test.ts.

### MCP-18: appTz cache has no eviction and ignores timezone changes until cold start

- Severity: low
- Location: lib/dates.ts:73-103
- Evidence: `tzCache` Map keyed by user id grows for the life of the isolate and a changed `user_config.tz` is not seen. It is documented, but the date used for default TM stamps (set_training_max) and week windows can disagree with SQL `app_tz()` for a traveler after changing zones.
- Confidence: confirmed
- Limitation: isolates are short-lived
- Verification path: none needed.

---

## Checks run and results

- `cd supabase/functions/mcp-server && deno check index.ts` -> pass.
- `deno test --allow-env --allow-net` -> 187 passed, 0 failed.
- `deno eval 'Date.parse("2026-02-30")'` -> 1772409600000 (valid), confirming MCP-12's date-validation hole.
- Static pass: listed every `.from(`/`.rpc(` in tools/ and lib/ (grep) and read each call's filter chain.

## Clean areas

- Identity: lib/auth.ts looks up SHA-256 digest, filters `revoked_at is null` and `expires_at null or > now` in the same UPDATE; DB errors return 503 not 401. lib/oauth.ts requires `client_id`, `role=authenticated`, verifies with `auth.getUser` and compares `sub` to the verified user; per-call client; nothing cached at module scope except configuration.
- `Db` handle built per request in handler.ts (`dbFor(userId)` inside `buildServer`); the only module-scope caches are the service-role client (stateless) and the per-user tz map (keyed by user id).
- Owner scoping: every read/write in coach_observations, feedback, memory, exercise_notes, goals, training_maxes, programs, planned_workouts, prescriptions, sessions, sets, set_notes, session_skips, checkins, v_* views carries `.eq("user_id", db.ownerId)` (programs deletes in upsert rollback use a just-inserted id). `plan_phases` lookup in upsert_program joins `training_plans` and filters user_id and superseded_at.
- Exercise visibility: requireExercise / visibleExerciseIds / canSeeExercise used by upsert_program, update_planned_workout, repeat_planned_workout, set_goal, set_training_max, set_exercise_note, get_lift_history, set_training_plan, resolve_exercises, search_exercises (explicit owner list). Only gaps are MCP-1 and MCP-11. Name lookups in get_recent_sessions/lastTime/find_similar_days join ids from the user's own data.
- No writes to sets, sessions, set_voids or set_notes anywhere in tools/ (grep). update_planned_workout reads `sets` only.
- Confirm gates: confirm_program, confirm_training_plan, confirm_change on upsert_program (phase path), update_planned_workout, repeat_planned_workout, set_training_plan are enforced server-side before writes; ephemeral callers are refused when the flag is true. No bypass found for non-ephemeral callers beyond the model-supplied boolean design.
- Bulk insert homogeneity: `prescriptionRows` emits `set_type` and `tracking` on every row; superset adjacency validator (assertSupersetGroups) is correct for ramps.
- Plan writes in update_planned_workout and set_training_plan go through the locked RPCs with `p_user_id = db.ownerId`; RPC re-checks owner.
- DST: date math in get_volume/get_week_summary is UTC-midnight date-only; `isoDateInTz` uses Intl parts.
- Error paths: unexpected errors return a generic message plus request_id; ToolError messages contain only the caller's own ids; Sentry gets tags only.
- filters.ts neutralizes PostgREST grammar characters; search_exercises' `mine.join(",")` interpolates only DB-sourced slugs.

## Not covered

- coach/ edge function connector allowlist (affects MCP-1, MCP-17) and PWA paths.
- Live behavior against Supabase (gateway URL limits for MCP-4, `max-rows`, trigger behavior for MCP-2/3); PGlite validation not run by me.
- View definitions other than v_bodyweight and the relevant triggers (v_adherence, v_weekly_*, v_trend_digest correctness) and their SQL.
- lib/testing.ts and test files beyond spot checks; protocol.test.ts transport behavior (CORS `*` with bearer auth accepted as intended).
- Rate limiting and body-size limits at the platform layer.


---

# Original report: edge

# EDGE audit: coach, push-alerts, endurance-sync (main d5e7b64)

Read-only. Paths are relative to the repo root.

## Findings

### EDGE-1: sweep never sets sent_at on success, so every due prompt is re-sent each sweep until the 6 h stale cutoff

- Severity: high (every armed prompt, i.e. OSTRC weekly and next-morning pain, buzzes the lifter repeatedly: cron is every 5 min, so up to ~72 duplicate pushes per alert; certain whenever the sweep runs)
- Location: supabase/functions/push-alerts/index.ts:459 (`await stamp(db, a.id, ok ? {} : { error: "every endpoint failed" });`), stamp at :945, sweep query at :478-486
- Evidence: on success the patch is `{}`. `stamp` is `.update(patch).eq("id", alertId)`, so `sent_at` is never written. No trigger sets it (grep of supabase/migrations for rest_alerts/sent_at finds only the column, the partial index and a comment). The sweep selects `sent_at is null and cancelled_at is null and fire_at <= now`, so the same row is picked up on the next run. It is only stamped (`error: "stale; not sent"`) once 6 h old. The comment on sweep() says "`stamp` sets sent_at", which is true only for `deliver()` (:884 passes `{sent_at: ...}`), not for `sendAlertNow`. If PostgREST rejects an empty PATCH body instead, `stamp` throws, sendAlertNow throws, and the whole sweep returns 500 after the push was already sent; the duplicate-per-sweep outcome is the same.
- Confidence: confirmed by code trace (no test covers sendAlertNow/sweep; I did not run it against a DB)
- Limitation: did not verify how PostgREST treats `update({})`; either branch is a bug.
- Verification path: add a test that arms a prompt, runs sweep twice against PGlite/mock db, asserts one send and `sent_at` not null. Fix: `{ sent_at: new Date().toISOString() }` on ok.

### EDGE-2: intervals.icu `start_date_local` (no offset) is parsed as UTC, so started_at is wrong by the athlete's UTC offset and cross-source dedup fails

- Severity: high (every non-UTC athlete's intervals rows are shifted 7-8 h for Pacific; breaks the two-minute duplicate matcher, which is the stated reason both sources can coexist; also moves rows across calendar-day buckets)
- Location: supabase/functions/endurance-sync/providers.ts:70 (`when(a.start_date_local ?? a.start_date)`), normalize.ts:84-87 (`new Date(v)`)
- Evidence: intervals.icu returns `start_date_local` as a local wall-clock string with no zone ("2026-09-30T06:15:00"). `new Date()` on a zone-less ISO string uses the runtime zone, which is UTC on the edge. The row is stored as 06:15Z when the effort started at 13:15Z. Strava's `start_date` is true UTC, so the same run from both providers differs by hours and the trigger (migrations/20260907030000, 2 min window) never matches. The normalize.ts comment promises "ISO 8601 with an offset"; this path does not deliver one.
- Confidence: confirmed for the parsing; the intervals.icu field format is from API knowledge, not from a captured response
- Limitation: no live payload checked.
- Verification path: unit test `when("2026-09-30T06:15:00")` under TZ=UTC; prefer `a.start_date` (UTC) and keep local only for display.

### EDGE-3: coach replays every stored prompt with its stale `app_current_context` envelope (up to 20 per turn)

- Severity: medium (token cost and stale-context confusion on every turn; contradicts the PWA's stated design)
- Location: supabase/functions/coach/index.ts:990-1001 (prior), :579 (stores `last?.text`), pwa/src/lib/coach.ts:75-88
- Evidence: the PWA wraps the context JSON onto the latest user message ("rebuilt per turn rather than pinned"). `record()` stores that wrapped text as `prompt`. The next turn loads the last 20 stored (prompt, response) pairs and sends them, so the model sees up to 19 old "today's plan / this week / memory" blocks plus the fresh one. All of it is billed as input, and burns the monthly cap (input/5).
- Confidence: confirmed by trace
- Limitation: size of a typical context block not measured.
- Verification path: build a thread from two recorded turns and assert old prompts contain no `app_current_context`; fix by stripping with `lifterWords()` (already exists in memory-extract.ts) before storing or before replay.

### EDGE-4: `ignoreDuplicates` upsert means the 48 h re-read window never applies upstream edits

- Severity: medium (renamed run, corrected sport, device re-upload never reach the table; sport change also feeds the dedup matcher)
- Location: supabase/functions/endurance-sync/index.ts:30-34 (OVERLAP_MS comment), :98-103
- Evidence: comment says edits are picked up by re-reading; the write is `upsert(..., { onConflict: ..., ignoreDuplicates: true })` = ON CONFLICT DO NOTHING. First-seen values are frozen.
- Confidence: confirmed
- Limitation: whether freezing is intended for measurements; the comment says otherwise.
- Verification path: sync an activity, change its name upstream, re-poll, read the row.

### EDGE-5: poll `since` is global across providers, so a newly connected or previously failing provider never backfills

- Severity: medium (silent data gap; nothing reports it)
- Location: supabase/functions/endurance-sync/index.ts:196-208
- Evidence: `since = newest(started_at over ALL activities) - 48h`. Connect Strava after intervals.icu has data: Strava only fetches the last 48 h of the newest intervals row. Provider A failing for >48 h while B succeeds: A's gap is below `since` forever. A single future-dated or bad `started_at` (the adapters accept any parseable date) moves `since` into the future and halts polling for everyone. Only `/backfill` recovers.
- Confidence: confirmed by trace
- Limitation: none significant.
- Verification path: seed one intervals row, connect strava, poll, check the `after` param sent.

### EDGE-6: concurrent `schedule`/`arm` calls cancel each other, so no alert fires

- Severity: medium (a retry, double tap or two devices logging a set together can leave zero live rest alerts; rare but silent)
- Location: supabase/functions/push-alerts/index.ts:394-405 (arm) and :584-592 (schedule)
- Evidence: each call inserts its row then `cancelOpenAlerts(db, userId, kind, alertId)` (cancels every other open row). A inserts, B inserts, A cancels B, B cancels A. No lock or single statement.
- Confidence: likely (interleaving is straightforward; not reproduced)
- Limitation: relies on two requests overlapping across two DB round trips.
- Verification path: fire two `schedule` calls with Promise.all and count uncancelled rows.

### EDGE-7: `COACH_LOG_CONTENT=off` silently removes all conversation history

- Severity: medium (operator privacy switch turns the coach amnesiac; the AGENTS text presents the switch as only about operator readability)
- Location: supabase/functions/coach/index.ts:579-580 (prompt/response nulled), :990-999 (`.not("prompt","is",null).not("response","is",null)`)
- Evidence: history is rebuilt only from stored text; with the switch off nothing qualifies, and `threadForModel` ignores all client turns except the last user turn (thread.ts:42-45).
- Confidence: confirmed by trace
- Limitation: deployment may never set it off.
- Verification path: run a two-turn exchange with the env set, inspect the messages sent.

### EDGE-8: a turn that fails mid-generation records zero tokens and is excluded from the daily count

- Severity: medium (unmetered spend on the owner's key: Anthropic bills the partial generation, but `usage` is only set after `finalMessage()`, and `refused` is set to the error text)
- Location: supabase/functions/coach/index.ts:1205-1212 vs :1214-1216, :578; supabase/migrations/20260921010000_reserve_coach_turn.sql (day count filters `refused is null`; month sum uses recorded tokens)
- Evidence: on exception `usage` stays {0,0,...}; row has `refused = message`. Day cap excludes it, month cap sums 0. A request that reliably errors late (connector timeout, tool failure after long thinking) costs money and never counts. Same for an isolate killed by the wall clock: the reserved row keeps model 'reserved', 0 tokens.
- Confidence: likely (failure-path cost depends on Anthropic billing partial streams)
- Limitation: not tested against a real failing stream.
- Verification path: mock stream that throws after deltas; assert the coach_usage row carries estimated tokens or counts toward the day.

### EDGE-9: `monthlySpentTokens` hits the PostgREST 1000-row default and under-counts

- Severity: low (only guards `/checkin-memory`; the real turn path uses the SQL function)
- Location: supabase/functions/coach/index.ts:309-327
- Evidence: selects all 30-day coach_usage rows with no range/limit; turns plus extraction rows can exceed 1000 for a heavy user, so the sum is truncated and the 429 never fires.
- Confidence: likely
- Limitation: not exercised.
- Verification path: seed >1000 rows and call; or move the check into a SQL sum.

### EDGE-10: reservation row leaks when token mint fails, and `prior` read error is ignored

- Severity: low
- Location: supabase/functions/coach/index.ts:1041-1053 (503 after reserve, no record/release), :990 (`const { data: prior }` drops `error`)
- Evidence: after `reserve_coach_turn` succeeds, a mint failure returns 503 and leaves a 'reserved' kind='turn' row with `refused` null: it consumes one of 150 daily turns and the client's retry reuse of the same turn_id gets a 409 ("already recorded") while no answer exists. A failed `prior` query yields an empty history with no error, so the coach answers without context and the exchange is stored as if normal.
- Confidence: confirmed by reading
- Limitation: low likelihood.
- Verification path: stub mcp_tokens insert to fail; retry with same turn_id.

### EDGE-11: stored history has no token bound, so a history of large turns can permanently break every turn

- Severity: low (needs ~20 near-limit messages)
- Location: supabase/functions/coach/lib/thread.ts:38-45; index.ts:990-1001
- Evidence: `MAX_TURNS`/`MAX_TURN_CHARS` bound only the incoming client turn; the 20 replayed pairs are unbounded (responses up to 16k tokens each). If the replay exceeds the model window every turn 400s. Failed turns are `refused` and excluded from prior, so the oversized set never changes.
- Confidence: speculative
- Limitation: window size and real-size history not measured.
- Verification path: seed 20 max-size rows and call.

### EDGE-12: sweep robustness: one throwing row aborts the batch; overlapping sweeps double-send

- Severity: low (amplified by EDGE-1)
- Location: supabase/functions/push-alerts/index.ts:470-520
- Evidence: `sendAlertNow` can throw (subscriptions read error, `stamp` error) with no per-row try/catch, so rows after it are skipped and the response is 500. There is no claim step, so two overlapping sweeps (cron plus a manual curl, or a slow run) both read the same rows and both send.
- Confidence: likely
- Limitation: none significant.
- Verification path: mock db with a throwing subscription read on row 1.

### EDGE-13: push fetch follows redirects

- Severity: low (speculative SSRF hardening gap)
- Location: supabase/functions/push-alerts/lib/push-to-endpoint.ts:34-40; index.ts test route fetch (:~690)
- Evidence: allowlist is checked once on the stored URL; `fetch` default `redirect: "follow"`, so an allowlisted host that 3xx's elsewhere would be followed. Only realistic if a push service is compromised.
- Confidence: speculative
- Limitation: none tested.
- Verification path: add `redirect: "manual"` and treat 3xx as failure.

### EDGE-14: endurance-sync swallows bookkeeping errors; no paging (A-75 still present)

- Severity: low
- Location: supabase/functions/endurance-sync/index.ts:140-150 (success update), :162-167 (failure update); providers.ts (single page, limit 200)
- Evidence: results of the `integration_credentials` updates are never read, so `last_sync_at`/`last_error` can silently not update (supabase-js returns errors). Pagination: still one request of at most 200; a 400-day backfill over 200 activities is truncated with `status: "ok"`.
- Confidence: confirmed
- Limitation: A-75 is known.
- Verification path: mock db update returning an error; backfill with 250 rows.

### EDGE-15: stale code comment says five tools, seven are disabled

- Severity: low (documentation drift only)
- Location: supabase/functions/coach/index.ts:33-34 vs :1161-1176
- Evidence: header says "minus five tools" / "three are named"; `configs` disables delete_program, delete_exercise, update_exercise, set_training_plan, confirm_training_plan, confirm_program (six). The AGENTS.md list omits confirm_program.
- Confidence: confirmed
- Limitation: none.
- Verification path: read.

## Checks run and results

- `cd supabase/functions/coach && deno check index.ts && deno test`: pass (41 passed, 0 failed)
- `cd supabase/functions/push-alerts && deno check index.ts && deno test lib/`: pass (10 passed)
- `cd supabase/functions/endurance-sync && deno check index.ts && deno test normalize.test.ts`: pass (6 passed)

## Clean areas

- Coach allowlist: `coachAdmission` runs before the body is read and before any DB read (only `auth.getUser` precedes it). Unset => 503, present-but-empty => 403. Same gate on `/checkin-memory`.
- `coach_access` read failure throws and returns 503, not 403 (index.ts:286-301, 1033-1038).
- `reserve_coach_turn` runs before any Anthropic call, takes an advisory lock, filters the day window on `kind='turn'`; unique violation => 409; missing/malformed turn_id => 400 before spend.
- `record()` reads the PostgREST error and reports to Sentry; runs in `finally`; token revoke in the same `finally` after record; mint failure returns before streaming. Extraction is awaited after record() and revoke, before `controller.close()`.
- Extraction input is `lastClientUserTurn(turns).text` through `lifterWords()` (strips the JSON envelope and legacy `<current_context>`); no attachments, no assistant text; both switches (`COACH_MEMORY_EXTRACT`, `COACH_LOG_CONTENT`) honored in all four extraction paths.
- Unit whitelist (`readUnit`), attachment shape/size/type checks, JSON-enveloped untrusted files, disabled tool list at the connector, SSE enqueue best effort so disconnect does not abort generation.
- push-alerts: endpoint allowlist is host-suffix based, https only, no IP literals, no userinfo, applied at subscribe, test, and send time; sweep secret compared via SHA-256 digests with an XOR loop and refuses when unset; per-kind cancel scoping; 6 h stale drop present (but see EDGE-1); `schedule` refuses leads beyond remaining worker wall clock; all per-user queries filter `user_id`.
- endurance-sync: credentials decrypted via a service-role-only RPC, secret never logged or returned, `last_error` stores only a status string; descent null (Strava) vs 0 (intervals, `nonNeg` keeps 0) handled correctly; distances and elevation are meters in both adapters; per-provider failure isolation.

## Not covered

- Real DB behavior of `update({})` (EDGE-1), RLS/trigger behavior of `activities` and `rest_alerts` beyond reading the dedup migration.
- webpush.ts crypto beyond the RFC 8291/8292 tests that pass; prompt.ts content (only the tests); sentry.ts.
- A-156 (cross-user subscription fanout / endpoint re-bind via upsert on endpoint) not re-analysed.
- Live Anthropic, Strava, intervals.icu, or Supabase calls; no network used.


---

# Original report: pwa-core

# pwa-core audit (area CORE), main d5e7b64, 2026-10-01

Scope: pwa/src offline/sync core (outbox, sync, db, data cache layer, auth/identity, SW, update gate, useLocalToday, export, settings, OutboxSheet, vite config). Read-only.

## Findings

### CORE-1: supabase-js INITIAL_SESSION(null) defeats the persisted-session fallback on an offline cold start

- Severity: high. An offline open with an expired access token (the basement-gym case the code comments target) shows Login, wipes the device cache, and holds every queued write. Likelihood: any cold start after token expiry (default 1 h) without signal.
- Location: pwa/src/hooks/useAuth.ts:51-60 (listener), :28-49 (fallback); pwa/src/lib/currentUser.ts:41-43; pwa/src/lib/db.ts:294-312 (claimCacheFor); auth-js GoTrueClient.ts `_emitInitialSession` (node_modules, ~line 4346-4358).
- Evidence: useAuth/currentUser both fall back to `readPersistedSession()` when `getSession()` returns `session:null` with a retryable error. But `onAuthStateChange` then receives `INITIAL_SESSION` with `null`: `_emitInitialSession` does `if (error) throw error` ... `catch { callback('INITIAL_SESSION', null) }`. The listener does `setState({ loading:false, session })` (session null -> `<Login/>`), `claim(null)` and currentUser does `set(null)`. The listener's callback comes from a second `getSession` (served from auth-js's cached refresh failure) so it resolves AFTER the `getSession().then` fallback and overwrites it.
- Consequences: (1) Login screen while offline, (2) `claimCacheFor(null)` runs `cacheClearAll()` (the whole kv cache incl. `activeSession`, plans, rest state, end drafts) and removes the owner marker, so the app is empty offline, (3) `userId` becomes null so `replayable()` holds every stamped item until a TOKEN_REFRESHED/SIGNED_IN arrives. Outbox items are not lost, but the user cannot see or continue the workout until the network returns.
- Confidence: likely (traced through installed auth-js 2.112.4 source and the repo's own handling; not executed against a real offline expired session).
- Limitation: did not reproduce in a browser; ordering of the two callbacks inferred from lock-serialised getSession calls. Even if the order flipped, `claim(null)` would still have run and wiped the cache.
- Verification path: jsdom/vitest test with a mock `supabase.auth` whose getSession returns `{session:null,error:AuthRetryableFetchError}` and whose onAuthStateChange immediately fires `('INITIAL_SESSION', null)`; assert `useAuth` still returns the persisted session, `getCurrentUserId()` stays the persisted id, and `claimCacheFor` is not called with null. Fix direction: ignore `INITIAL_SESSION` null when the last getSession error was retryable and a persisted session exists.

### CORE-2: reads sent with the anon key after a failed refresh return 200 `[]` and are cached over good data

- Severity: medium. Wipes/blanks the offline cache and renders "no plan" when the auth endpoint is unreachable but REST works (partial connectivity, 8 s timeout on `/token`). Likelihood: low-medium.
- Location: pwa/src/lib/data.ts:141-150 (fetchWithCache); supabase-js `_getAccessToken` (`?? this.supabaseKey`); RLS policies are `to authenticated` (supabase/migrations/20260825120002_rls.sql).
- Evidence: `const data = await fetcher(); await deps.cacheSet(key, data);` caches whatever the fetcher returns. When `getSession()` yields null (retryable refresh failure), supabase-js sends `Authorization: Bearer <anon key>`. With RLS and no anon policy, PostgREST answers SELECT with 200 and zero rows (not an error) provided anon has table grants (Supabase default). `throwIf(error)` sees no error; the empty array is written to kv, replacing the good copy.
- Writes are fine: anon write gets 401, handled by the auth branch in the flusher.
- Confidence: likely (library behaviour confirmed in source; anon grants not verified against the live project).
- Limitation: did not check live anon privileges or whether any fetcher treats empty as an error.
- Verification path: vitest with a fake supabase client returning `{data:[],error:null}` and no session; or `curl` the REST endpoint with the anon key against a local `supabase start`.

### CORE-3: fetchWithCache can write a stale response after an invalidation (and after a user switch)

- Severity: medium. A read in flight when `invalidateForSetChange()`/`cacheClearAll()` runs re-populates the cache with pre-change (or previous-user) data. Next offline read shows the old data until a successful refetch. Likelihood: moderate (History/Session fire many concurrent reads while sets are logged).
- Location: pwa/src/lib/data.ts:145-148; pwa/src/lib/db.ts:168-175, 229-240.
- Evidence: `fetcher()` awaited, then `cacheSet(key, data)` with no generation/ownership check. Sequence: read starts -> set logged -> `cacheDeleteByPrefix` deletes the key -> read resolves -> `cacheSet` writes data that predates the set. Same shape across a `claimCacheFor` clear: user A's slow fetch resolves after the clear and is stored for B.
- Confidence: likely (by reading; no existing test covers interleaving).
- Limitation: not reproduced; the stale entry heals on the next online read.
- Verification path: unit test on `makeFetchWithCache` with a deferred fetcher and an interleaved delete; fix with a per-key epoch bumped by invalidation/claim.

### CORE-4: cache ownership claim is not awaited before the new user's screens read the cache

- Severity: medium-low. On a user change without SIGNED_OUT in between (the case db.ts documents), B's screens can read A's cached plan/sets before the clear finishes (cross-user display, offline fallback serves it).
- Location: pwa/src/hooks/useAuth.ts:28-49, 51-60 (`setState` first, `claim()` fire-and-forget); pwa/src/lib/db.ts:294-312.
- Evidence: `setState({ loading:false, session }); claim(...)` then `claimCacheFor` is async (`await cacheClearAll()`), and the Shell mounts (keyed by user) and calls `fetchWithCache`, whose failure path reads the old kv. The comment in useAuth says the claim "must not depend on one event arriving" but does not make rendering wait for it. Also two concurrent claims (getSession.then + listener) both clear.
- Confidence: likely.
- Limitation: window is short and requires offline/slow network at the switch; no data is persisted wrongly beyond the transient render.
- Verification path: test that renders Shell for B with kv seeded as A and a never-resolving fetch; assert A data is not shown.

### CORE-5: IndexedDB connection is never recovered after it dies; failed open is cached forever

- Severity: medium. If `openDB` rejects once, or iOS WebKit closes the connection while backgrounded, every outbox enqueue/flush/cache call fails until a full reload. Likelihood: low-medium on iOS PWAs.
- Location: pwa/src/lib/db.ts:161-166.
- Evidence: `dbPromise ??= openDB(dbName, 1, { upgrade(db){...} })` with no `terminated()`, `blocking()` or `blocked()` callbacks, and a rejected promise stays in `dbPromise`. Latent second issue: when the version is next bumped, an older tab without `blocking()` keeps the old connection open and the new tab's `openDB` blocks indefinitely.
- Confidence: likely for the missing handlers (confirmed by reading); speculative for how often WebKit terminates.
- Limitation: not exercised on device.
- Verification path: test that `getDb()` after a rejected open succeeds on the next call; add `terminated: () => { dbPromise = null }`, `blocking: () => db.close()` and clear `dbPromise` on failure.

### CORE-6: classify() treats several deterministic client errors as retryable, which blocks the whole queue; gateway/portal 4xx dead-letters

- Severity: medium-low. One poison item at the head stalls every later write (retryable failure `return`s from the flush) with backoff capped at 5 min.
- Location: pwa/src/lib/outbox.ts:195-219 (classify), :618-627 (retry branch returns), :245-265 (deadKind).
- Evidence: dead list is `[400,403,404,409,422]` plus SQLSTATE 23xxx/42501/PGRST116. Anything else, including 405, 413 (payload too large, e.g. a large `feedback.detail/context`), 414, 415, 431, is "retry". A 413 from the API gateway will be retried forever and each retry stops the flush, so sets behind it never sync. Conversely a captive portal or proxy answering a POST with 403/404 HTML is classified dead, requiring a manual Retry for what is a transient condition. `deadKind` and `classify` agree on 23xxx/42501/PGRST116 but a bare 404 is dead in classify and "unknown/retryable" in deadKind (consistent with the doc comment, noted only).
- Confidence: likely for 413/415 (by reading); speculative that the gateway returns those for any real payload today.
- Limitation: no size cap seen on feedback payload; not checked against Supabase gateway limits.
- Verification path: outbox test with a transport returning `{status:413, code:null}` followed by a valid item; expect the second to sync (needs a poison-item cap, e.g. dead after N retries on 4xx).

### CORE-7: flush() re-walks the queue once per enqueue, hammering a failing head while retries inflate

- Severity: low. During a hanging connection (online() true, requests time out at 8 s) each logged set queues another full run in the promise chain; N sets mean N serial 8 s attempts, `retries` is bumped each time, and `flush()` awaiters (retryDead, repairDeadLoadSet) wait behind all of them. The backoff timer is bypassed by enqueue-triggered runs.
- Location: pwa/src/lib/outbox.ts:484-487, 509-640, 657-675.
- Evidence: `chain = chain.then(doFlush, doFlush)` per call; no coalescing of queued-but-not-started runs.
- Confidence: likely. Limitation: no data loss, only latency/noise.
- Verification path: outbox test with a transport that rejects slowly; enqueue 10 and count transport calls.

### CORE-8: two flushers (two tabs / PWA + browser tab) can resurrect a synced item

- Severity: low. The chain is per-JS-context and there is no Web Lock or cross-tab guard. Tab A syncs item K and deletes it; tab B, mid-attempt on K, hits a retryable/FK error and does `db.put("outbox", item, K)` (outbox.ts:564, 589, 596, 610, 620), recreating K. Replay is idempotent for inserts, but `set_notes` upserts MERGE (last write wins) and sessions `update` patches overwrite, so an older note/patch can be re-applied over a newer one.
- Location: pwa/src/lib/outbox.ts:540-628, 858-880.
- Confidence: speculative (needs an interleaving plus a failure on the second tab).
- Limitation: not tested.
- Verification path: two outbox instances over one fake-indexeddb with a flaky transport; use `navigator.locks` around `doFlush`, and make `put` conditional on the key still existing.

### CORE-9: items stamped with owner null are held permanently, and later items that depend on them die

- Severity: low. Documented intent (A-90), but there is no release path (OutboxSheet offers export only for held). If a `sessions` insert is stamped null (no identity and no persisted session at enqueue) while later sets are stamped with the real id (identity arrived), the sets are replayable, hit FK 23503, and go dead ("blocked"); retryDead requeues them against a parent that can never send.
- Location: pwa/src/lib/outbox.ts:380-387; pwa/src/lib/sync.ts:84; pwa/src/components/OutboxSheet.tsx (held section ~426).
- Confidence: speculative (requires the narrow null-owner window).
- Limitation: not checked whether Session start can happen with no persisted session.
- Verification path: outbox test: enqueue session with `stampUserId = null`, then set with a real id; expect either hold-with-parent or a visible path to reassign.

### CORE-10: exports are not the complete record

- Severity: low-medium (the premise is "you own your log").
- Location: pwa/src/lib/export.ts:50-56 (CSV_HEADER), :178-212 (toCsv), :113-153 (buildExport).
- Evidence: (a) the comment says `load_entry` "is NOT optional" for the archive, and the JSON includes `load_entry/entered_load/entered_unit`, but `CSV_HEADER` and `toCsv` drop all three plus `prescription_id`, so a CSV of a pair of 30 kg dumbbells reads as a 60 kg total with no way to tell. (b) The JSON bundle holds sessions, sets, set_notes, exercise names only: no `bodyweight_log`, `session_skips`, `set_voids`, `checkins`, programs/plans, training maxes. (c) `csvCell` neutralises `= + - @` but not a leading TAB or CR. (d) Pagination uses OFFSET over live tables, so a set synced mid-export with an earlier `performed_at` shifts later pages and can duplicate/skip a row. (e) Unsynced outbox rows are only in the separate queue export (by design).
- Confidence: confirmed for (a)-(c); likely for (d).
- Limitation: product scope of "whole record" not confirmed against docs.
- Verification path: extend export tests to assert CSV columns and bundle keys.

### CORE-11: settings envelope lost-update across tabs

- Severity: low. `persist()` writes the whole in-memory envelope; there is no `storage` event listener and `reloadSettings()` has no non-test caller. Two tabs (or PWA + Safari) each hold their own `values`; the last writer clobbers the other's setting changes (e.g. plates, unit).
- Location: pwa/src/lib/settings.ts:570-683.
- Confidence: likely. Limitation: low impact; not tested.
- Verification path: two-module-instance test writing different keys.

### CORE-12: unhandled getSession rejection leaves the app on the splash / identity unset

- Severity: low. `useAuth` and `currentUser` call `supabase.auth.getSession().then(...)` with no `.catch`. A rejection (storage lock timeout, e.g. auth-js lock acquire failure) leaves `loading:true` forever (App splash) and `userId` null (all writes held), plus an unhandled rejection toast.
- Location: pwa/src/hooks/useAuth.ts:28; pwa/src/lib/currentUser.ts:28.
- Confidence: speculative (getSession usually returns errors rather than rejecting). Verification path: mock getSession rejecting; assert `loading` resolves.

### CORE-13: update gate can be blocked indefinitely by a stale `activeSession` pointer

- Severity: low. `sessionInProgress()` is true whenever `kv.activeSession` is non-null; an abandoned session pointer (the orphan card case) defers the SW update until it is dismissed. Failure mode is safe (no mid-set reload) but a shipped build can sit unnoticed for days, which the file's own history calls out. Location: pwa/src/main.tsx:79-86, pwa/src/lib/swUpdate.ts. Confidence: likely, Limitation: depends on how often orphans persist. Verification path: unit test with a stale pointer older than e.g. 18 h.

## Checks run and results

- `cd pwa && npm run typecheck` (tsc -b --force): pass, no errors.
- `npx vitest run src/lib src/hooks src/components/OutboxSheet.test.tsx`: pass, 50 files / 687 tests.
- No runtime reproduction of CORE-1 to CORE-5 was done (read-only audit).

## Clean areas

- Hard-rule checks in outbox: unknown identity holds (`replayable` null owner -> false), stamp-at-enqueue with persisted fallback, held items never dropped, retryDead only touches dead items, dead-vs-retry split for refresh-threw vs refresh-false (sync.ts refreshAuth throws on retryable errors; flusher keeps pending and schedules retry). `authRefreshTried` per flush is acceptable because the throwing branch returns.
- Idempotency: all inserts use client UUIDs (`uuid()`; only `dev/mockSupabase` uses Math.random) and `upsert ignoreDuplicates`, set_notes merges deliberately; updates use `.select("id").single()` so zero-row is PGRST116 dead/"blocked", consistent between classify and deadKind.
- Ordering: single-threaded in-key-order replay, stop on retryable, continue past dead; dead parent yields 23503 children that are retryable ("blocked") in key order via retryDead.
- uuid.ts fallback: correct v4 bits via getRandomValues.
- db.ts: version 1, no destructive upgrade path; `cacheClearAll` leaves outbox alone.
- SW: registerType "prompt", skipWaiting only on message, no clientsClaim, no runtime caching; update gate waits for session close with visibility + 60 s polling and removes its listeners once applied; main.tsx storage.persist best-effort, not awaited.
- useLocalToday: midnight computed from calendar date (DST-safe), 1 s cushion, re-armed on visibility, `online` sync, listeners/timer cleaned up.
- timeoutFetch: timer cleared in finally, upstream signal honoured and listener removed; abort maps to status 0 / retryable.
- throwIf/QueryError/staleReason: offline (empty code) vs answered (code) distinction preserved, reporting rate-limited.
- errors.ts global handlers installed once (not removable by design).

## Not covered

- Screens that call outbox/enqueue (Session, End, Today) and data.ts functions beyond fetchWithCache/throwIf/QueryError.
- components other than OutboxSheet (first 200 lines read; the rest of its 523 lines skimmed for the held/dead actions only), SettingsSheet sign-out copy, errors.ts internals beyond global handlers, settings.ts parsers.
- Real-device behaviour (iOS WebKit IDB termination, offline cold start), live Supabase grants, supabase-js behaviour across versions other than 2.112.4.


---

# Original report: pwa-session

# SESS audit: workout-logging screens (pwa/src), main d5e7b64

Read-only. Findings are from code tracing; no repro tests were added (repo is read-only for this audit).

### SESS-1: Rating the rest strip after correcting the same set writes a stale duplicate live set

- Severity: high (silent duplicate row in an append-only table inflates volume/e1RM/history forever; needs log -> edit that set -> tap RPE chip on the still-visible rest strip, a plausible gym sequence)
- Location: pwa/src/screens/Session.tsx:383, 1444, 1663 (only writers of `lastLoggedSet`), 1904-1955 (`rateLastSet`), 1807-1898 (`saveCorrection`), 3529
- Evidence: `saveCorrection` voids `old.id` and inserts `next`, but never updates `lastLoggedSet`. `rateLastSet` then does `const old = lastLoggedSet; ... correctedSet(old, {load_kg: old.load_kg, reps: old.reps, ...rpe})`, enqueues a new insert plus a void of the already-voided `old.id`. `applySets(prev.map(x => x.id===old.id ? next : x))` matches nothing, so the UI looks unchanged. Sequence: log S1 (rest strip up, lastLoggedSet=S1) -> tap S1 in LOGGED, change load/reps, SAVE (S1 voided, S1' live) -> strip still shown (`rest && !editing`) -> tap RPE chip. Outbox now holds S1'' with the PRE-correction load/reps at the same set_index; S1' and S1'' are both live in `v_live_sets`. Reload shows two sets at that index, one with the typo values. The set note shortcut (`openNote(lastLoggedSet.id)`, line 3532) likewise attaches to the voided id.
- Confidence: likely (traced end to end; not reproduced in a test)
- Limitation: did not run it in the UI; assumes the rest strip is still shown after SAVE (rest is not cleared by saveCorrection).
- Verification path: Session test: log a set with a rest target, startCorrection + change reps + save, then click an RPE chip on the strip; assert exactly one live set in `setsRef` and that no `sets` insert carries the old reps. Fix idea: `setLastLoggedSet(next)` in saveCorrection when `old.id === lastLoggedSet?.id`.

### SESS-2: Typed load above the cap is stored unclamped and can overflow `numeric(6,2)`; set is lost on sync

- Severity: medium (permanent server rejection of a set that looks LOGGED locally; needs a 5+ digit typo)
- Location: pwa/src/screens/Session.tsx:2276-2285, 2293-2305 (pad commits), 1343-1348 (`buildSetInsert`), 1830-1833 (`saveCorrection`), 183 (`MAX_LOAD_KG = 999`)
- Evidence: pad commit clamps `entryKg` to the max but stores the raw typed value: `updateDraft({ entryKg: ..., enteredLoad: value, enteredUnit })` / `setEditing({...enteredLoad: v...})`. `buildSetInsert` then prefers it: `const enteredLoad = draft.enteredLoad !== undefined && draft.enteredUnit ? draft.enteredLoad : ...; storedLoad = loadToKg(enteredLoad, ...)`. Pad allows 6 characters. Typing 99999 lb gives load_kg 45359.24; `sets.load_kg` is `numeric(6,2)` (max 9999.99) so the insert fails with a data exception. The cap of 999 kg is also bypassed for anything under 9999 kg. The corrected-set path (`loadToKg(editing.enteredLoad,...)`) has the same hole.
- Confidence: likely (trace; DB limit read from 20260825120001_schema.sql:117)
- Limitation: did not confirm how `deadKind()` classifies SQLSTATE 22003 (the set would be dead-lettered or retried forever either way).
- Verification path: Session test: open the load pad, type 99999 in lb mode, LOG, assert the enqueued `load_kg <= 999`.

### SESS-3: Timed set duration can be 0, which the DB check refuses (1..7200)

- Severity: medium (set looks logged, never syncs)
- Location: pwa/src/components/session/SetEditor.tsx:243-246, 401-404, 444-447 (`min={0}`); pwa/src/screens/Session.tsx:2240, 2334 (`Math.max(0, ...)`), 1363
- Evidence: steppers and pad allow 0; `buildSetInsert` writes `duration_seconds: timed ? Math.round(draft.durationSeconds ?? 60) : null`. Migration 20260906030000 has `check (duration_seconds is null or duration_seconds between 1 and 7200)`. Stepping -5 down from 60, or typing 0, then LOG sends a row the server refuses (23514, permanent). Pad max is 3600, so the 7200 side is safe.
- Confidence: likely
- Limitation: not run.
- Verification path: Session test with a `tracking: "time"` prescription; set duration 0, LOG, assert enqueued `duration_seconds >= 1` (or LOG disabled).

### SESS-4: Cache-less offline resume yields set_index 0 over existing sets (setsFailed not raised)

- Severity: medium (duplicate `set_index` permanently on an append-only table; requires adopted/resumed session with no cache while offline, which End.tsx itself calls out as a real case)
- Location: pwa/src/lib/data.ts:1758-1778 (`getServerSessionSets`), pwa/src/screens/Session.tsx:566-583, 1367-1370, 607-616
- Evidence: on a failed server read with no cached list, `getServerSessionSets` does `reportError(...); return [];` instead of throwing. Bootstrap then sees success (`setsFailed` stays false, `setsLoaded` true) and merges `[]` + this device's pending sets, so `setIndexFor` returns max(pending)+1 or 0 for an exercise that already has server sets (other phone, or cache evicted). The `setsFailed` guard added for exactly this was bypassed because the error is swallowed one layer down.
- Confidence: likely
- Limitation: did not exercise the adopt-orphan path end to end.
- Verification path: test that mocks `supabase.from(...).select` to error with empty kv cache and asserts LOG is disabled (`setsFailed`), or make `getServerSessionSets` rethrow when it has no cache and have bootstrap catch.

### SESS-5: Superset round treats just-logged skipped members as done (stale `skips` closure)

- Severity: low (wrong auto-advance and missing rest strip after logging a previously skipped superset member)
- Location: pwa/src/screens/Session.tsx:1636-1645, 1666-1668 vs 1456-1464
- Evidence: `logRound` calls `persistSkips(unskipped)` then computes `doneAfter = entry => entry.key in skips || entryMet(...)` using the pre-delete `skips`. `logSet` handles this (`e.key in skips && e.key !== entryToLog.key`); `logRound` does not. Skip A1, then log a round including A1: `doneAfter(A1)` is true regardless of sets, focus advances and `showStrip` is false.
- Confidence: likely
- Limitation: needs paired Focus with a skipped member to reach.
- Verification path: Session.focus test: skip a pair member, log round, assert rest strip appears when partner still has sets.

### SESS-6: Correcting an existing set cannot change or preserve a timed set's duration; edit is silently dropped

- Severity: low
- Location: pwa/src/screens/Session.tsx:1759-1798 (`startCorrection` never loads `s.duration_seconds`), 1807-1830 (`correction` has no duration), pwa/src/lib/corrections.ts:51-70; pwa/src/lib/data.ts:54-55 (`SET_COLUMNS` omits `duration_seconds`)
- Evidence: the time-tracking editor shows a duration stepper while correcting, but `isNoopCorrection` ignores duration so a duration-only edit just cancels with no message. Separately `duration_seconds` is not in `SET_COLUMNS` and nothing in the PWA reads it (only the write at Session.tsx:1363), so after a reload sets come back from the server without it, and correcting such a set (spread of `old`) writes the replacement row with `duration_seconds` undefined/null: the hold time is lost on correction.
- Confidence: confirmed (code read; grep shows `duration_seconds` referenced only at Session.tsx:1363 and types.ts:249)
- Limitation: did not check History/MCP display of duration.
- Verification path: correct the RPE of a reloaded timed set and inspect the enqueued payload for `duration_seconds`.

### SESS-7: End bodyweight rounds to 1 decimal kg, reintroducing the lb drift `toStoredKg` exists to prevent

- Severity: low (typed 180.0 lb reads back as 179.9)
- Location: pwa/src/screens/End.tsx:445 (`Math.round(kg * 10) / 10` in pad commit) and the end patch `bodyweight_kg: bwOpen ? Math.round(bwKg * 10) / 10 : null`; contrast pwa/src/lib/units.ts `toStoredKg` doc (two decimals, "either capture path")
- Evidence: 180 lb = 81.6466 kg -> 81.6 -> toDisplay 179.9 lb. Stepper steps in lb are also quantised to 0.1 kg on save.
- Confidence: confirmed (arithmetic)
- Limitation: `sessions.bodyweight_kg` precision not checked.
- Verification path: unit test `toDisplay(Math.round(fromDisplay(180,"lb")*10)/10,"lb") === 180`.

### SESS-8: Finish retry can enqueue `session_skips` twice

- Severity: low
- Location: pwa/src/screens/End.tsx:352-421 (`end` -> `writeSessionSkips`), lib/skips.ts `sessionSkipRows` (fresh `uuid()` per call)
- Evidence: if any step after `writeSessionSkips` throws (e.g. `cacheSet(LAST_BW_KEY)`, `clearSessionCaches` partial), the catch releases the terminal lock; tapping Finish again re-enqueues `ended_at` (harmless) and a second set of skip rows with new ids. `session_skips` has no unique constraint (only `idx_session_skips_session`), so duplicates stand.
- Confidence: likely (needs a post-skip throw, rare)
- Limitation: not triggered.
- Verification path: End.finish test where `cacheSet` rejects once; assert second tap does not add skip rows (derive ids from session+entry key).

### SESS-9: Corrections, rating and voids update the UI before the outbox accepts the write

- Severity: low-medium (data-loss only if IndexedDB rejects; the log path was fixed for exactly this)
- Location: pwa/src/screens/Session.tsx:1848-1876 (`saveCorrection`), 1922-1938 (`rateLastSet`), 1986-2002 (`voidSet`)
- Evidence: `applySets` and the voids cache are updated first, then `outbox.enqueue(...).catch(reportError)`. If the insert enqueue rejects, the voids cache already hides `old.id` and the replacement exists only in React/cache; the next bootstrap merges server+pending, drops the voided old row and has no pending replacement, so the set disappears from the screen (server still has the original, unvoided). `logSet` was changed to await the enqueue first (comment at 1426-1429); these three were not.
- Confidence: speculative (needs an IndexedDB write failure)
- Limitation: not simulated.
- Verification path: mock `outbox.enqueue` to reject in `saveCorrection` and assert the UI/voids cache are not updated.

### SESS-10: Wake lock can leak a sentinel on rapid visible/hidden/visible

- Severity: low
- Location: pwa/src/hooks/useWakeLock.ts:73-95
- Evidence: `acquire` guards on `sentinel !== null`, but `sentinel` is only set when the request resolves. Two `visible` events while a request is in flight issue two requests; the second resolution overwrites `sentinel`, so the first is never released on unmount (browser frees it on next hide).
- Confidence: speculative
- Limitation: browser timing; no test.
- Verification path: hook test with a deferred `request` promise firing visibility events twice.

### SESS-11: Flaky test: "splits round rest across members"

- Severity: low (test fragility)
- Location: pwa/src/screens/Session.focus.test.tsx:1716-1763
- Evidence: failed once (expected `rest_seconds_actual: 45`) in the first full run, passed in the next three runs. It mixes a real `Date.now()` capture with fake-timer system time and a real 450 ms wait, so a few ms of skew rounds to 44/46.
- Confidence: confirmed (observed once, not reproducible on demand)
- Limitation: root cause inferred from the test code.
- Verification path: use `vi.setSystemTime` from the actual `restRef.startedAt` (or fake timers throughout).

## Checks run and results

- `npx vitest run src/screens/Session src/screens/End src/components src/lib/corrections src/lib/entries src/lib/sections src/lib/load src/lib/plates src/lib/units`: run 4 times; 3x pass (38 files, 483 tests), 1x had one failure (SESS-11, the flaky test).
- `npx vitest run src/screens src/components`: pass (38 files, 397 tests).

## Clean areas

- `correctedSet`/`isNoopCorrection`: same index, `performed_at`, rest, prescription preserved; rpe normalised with `?? null`; load_entry and entered_* kept when total is unchanged.
- `buildSetInsert`: tick sets write reps 0, load 0, rpe null; timed write reps 0 plus duration; `load_entry` never `per_side` on a zero load; per-side doubling via `loadToKg`; load rounded to 2 decimals.
- kg<->lb: 45/135/225 lb and per-side pairs round-trip at 0.1 lb display after 2-decimal kg storage; `entered_load/entered_unit` provenance avoids drift. `stepTo` snapping lands on the step grid.
- `plates.split`: non-finite input and huge targets are bounded; tolerance matches the 2-decimal kg rounding.
- RPE: scale derived from column bounds; set rpe null by default and cleared after each log; session RPE 0-10 matches the check.
- Double-tap LOG: `logLocked` is set before any await and cleared after the enqueue settles; End uses a ref lock (`terminalRef`) for End/Discard.
- Skips are written only at Finish (`writeSessionSkips`); un-skip never touches the network; legacy skips resolved from rx/extras or dropped.
- Rest clock uses `Date.now()` deltas (no backgrounding drift); rest alert arm/disarm sequencing via `seq` is sound; mirrored on every clock move.
- `setIndexFor` uses `setsRef` (synchronous) and per-exercise max+1; superset rounds allocate two indexes atomically via `enqueueBatch`.
- Overnight sweep (`syncOpenSessions`) respects queued sets and active-pointer ownership for discards.

## Not covered

- `components/SetSchemeSheet.tsx`, `PlateSheet.tsx`, `PlateBar.tsx`, `SetRow.tsx` read only superficially or not at all; `FocusDeck`/`FocusMoreSheet`/`WorkoutOverview` not read.
- `Session.tsx` read selectively (bootstrap, log/round/correct/void, pad, key effects); lines ~640-1290 and ~2400-3460 (render, swap, extras, sections UI) were not reviewed.
- `lib/sections.ts` `moveEntry`/`moveBlock` read; it is not used from Session (plan editor only), so ramp/superset tearing there was not tested.
- `restCue.ts`, `format.ts`, `sessionFocus.ts` (partly), `review.ts` skimmed only.
- No UI/browser run; all findings are from code and unit tests.


---

# Original report: pwa-plan

# PLAN audit: planning/history screens (pwa/src), main d5e7b64

Severity counts: critical 0, high 0, medium 6, low 7. No hard-rule violation found (see Clean areas).

### PLAN-1: Duplicating a day drops set_type, section and tracking
- Severity: medium (warmups become working sets, timed/tick rows become reps rows; every use of "Duplicate" on a day that has any)
- Location: pwa/src/lib/data.ts:417-430 (`duplicatePlannedWorkout`), called from pwa/src/screens/Plan.tsx:586
- Evidence: the source select is `"exercise_id,position,sets,reps_min,reps_max,load_kg,load_pct_tm,rest_seconds,notes,superset_group,load_entry,entered_load,entered_unit"`, then the rows are bulk-inserted. `set_type`, `section` and `tracking` are never read, so every copied row takes the column default (`'working'`, null, `'reps'`). A day with a 3-row warmup ramp plus a top set copies as four working sets; an "Activations" section loses its heading; a `time`/`done` prescription becomes a weight x reps row.
- Confidence: confirmed (read column list vs migrations 20260830120000, 20260831080000, 20260906030000; no test covers it)
- Limitation: did not run it against PGlite.
- Verification path: add a data.ts test (or validate-db script) that duplicates a day containing warmup, sectioned and tracking='time' rows and compares the copies.

### PLAN-2: Save-as-template drops superset_group, section, tracking; apply drops section and tracking
- Severity: medium (template round trip silently un-supersets and un-sections a day, and turns carries/ticks into reps rows)
- Location: pwa/src/lib/data.ts:~655-676 (`saveWorkoutAsTemplate` row builder), ~745-772 (`applyTemplate` select + insert)
- Evidence: the template rows set `set_type`, `load_entry`, `entered_*` but no `superset_group`, `section`, `tracking`. `applyTemplate` selects `...set_type,superset_group,load_entry,...` but not `section` or `tracking`, so even a template that had them would lose them on apply. AGENTS says superset/section/tracking are all adjacency/columns that must survive; "a superset is torn in half" is the named bug class.
- Confidence: confirmed (code read)
- Limitation: runtime not exercised.
- Verification path: round-trip test: save a day with a superset, section and a timed row as a template, apply it, diff the prescriptions.

### PLAN-3: applyTemplate says warmups are left alone; refreshedLoads rescales them
- Severity: low (doc/behaviour mismatch; the proportional ramp rescale is arguably what you want, but the stated rule is false)
- Location: pwa/src/lib/data.ts (applyTemplate doc comment "A warmup is left alone too"), pwa/src/lib/templateLoads.ts:35-69
- Evidence: `LoadRow.set_type` is declared and never read in `refreshedLoads`. Warmups in a ramp are scaled with the top set. Also, when `next[i]` is set but `load_entry`/`entered_unit` is null while `entered_load` is non-null (legacy row), `entered_load` keeps the old number next to a changed `load_kg`.
- Confidence: confirmed (read)
- Limitation: decision which behaviour is intended is the owner's.
- Verification path: templateLoads test with a warmup + working ramp; assert against the documented rule.

### PLAN-4: "Use template" with no program leaves a stray empty dated day
- Severity: low (a DRAFT day on the selected date for first-time users; harmless but wrong)
- Location: pwa/src/screens/Today.tsx:~910-925 (`useTemplate`)
- Evidence: when `program` is null it calls `createPlannedWorkout(selectedDate, "")` only to get a program id, then `applyTemplate(... selectedDate ...)` creates a second day on the same date. The seed day is never discarded.
- Confidence: confirmed (code read)
- Limitation: no UI run.
- Verification path: Today test with no program, apply template, assert exactly one planned day.

### PLAN-5: Closing the Training maxes sheet reloads the page, including mid-session
- Severity: medium (loses staged reps/load/half-typed note in the session screen; the gear is in the app header on every route including /session)
- Location: pwa/src/components/TrainingMaxSheet.tsx:109-112, App.tsx:~100,153
- Evidence: `if (dirty) window.location.reload();`. AGENTS explicitly rejects anything that reloads the page mid-set ("takes the staged reps, the load and any half-typed note"); the SW update path was built to avoid exactly this. Component comment says IndexedDB covers outbox/active session/rest timer, but not in-memory staged input.
- Confidence: likely (did not confirm the gear is rendered with `inSession` true; header code suggests it is)
- Limitation: Session.tsx staging persistence not traced.
- Verification path: open /session, stage a rep count, set a TM from Settings, close the sheet, observe reload. Fix: refetch via a `plan:changed`-style event instead of reload.

### PLAN-6: Coach "retry" duplicates the user turn
- Severity: medium (a failed turn retried via the Retry control sends the question twice, billed twice, and the model sees it twice; also resends attachments with empty data after a reload)
- Location: pwa/src/components/CoachSheet.tsx:~350-368 (`retry`), saveThread at :63-80
- Evidence: `retry` pops only trailing assistant messages, leaves the user message in `msgs`, then puts `lastUser.text` back in the draft and `lastUser.attachments` in files. Pressing send appends a second identical user turn (`history = [...msgs, mine]`). Persisted attachments are stored as `{...a, data: ""}`, so after a reload the retry attaches empty-base64 files and the server rejects the turn.
- Confidence: confirmed (code read)
- Limitation: not run in a browser.
- Verification path: CoachSheet test: fail a turn, press Retry then Send, assert `askCoach` receives one trailing user turn.

### PLAN-7: Coach recovery declares a still-running turn "interrupted"
- Severity: medium-low (user sees "Ask again" and a re-ask double-bills while the first answer completes on the server)
- Location: pwa/src/components/CoachSheet.tsx:~137-165, pwa/src/lib/coach.ts:~215-232
- Evidence: `recoverAnswer` returns null while the turn is still running (its own doc says so); the effect maps null to `m.text || "(That answer was interrupted and didn't finish. Ask again.)"` with `streaming:false`, and never polls again. Phone locked mid-answer, reopened within seconds: the real answer lands later and is never shown. Also `recoverAnswer(...).then(...)` has no catch.
- Confidence: likely
- Limitation: timing relies on server finishing after client reopens.
- Verification path: unit-test the effect with `recoverAnswer` resolving null, then a later non-null.

### PLAN-8: Coach spend "today" uses the UTC date, the view buckets by user timezone
- Severity: low (display only; today's count/cost reads 0 from late afternoon Pacific)
- Location: pwa/src/lib/coach.ts:247-256
- Evidence: `new Date().toISOString().slice(0,10)` compared to `v_coach_spend_daily.day`, defined `(created_at at time zone app_tz(user_id))::date` (20260907010000). Hard-rule area: "calendar days are per user".
- Confidence: confirmed
- Limitation: none material.
- Verification path: use `todayLocalIso()`; test with a fake clock at 18:00 PST.

### PLAN-9: Today shows only the newest confirmed program's days
- Severity: medium (likely; a second confirmed program hides the first's dated days from the week strip, doneIds and Start, while the coach context and Plan still see them)
- Location: pwa/src/screens/Today.tsx:~461-470 (`program = list.programs[0]`, `workouts` filtered by program.id); pwa/src/lib/data.ts:getPlannedWorkouts returns all confirmed programs; pwa/src/lib/coachContext.ts uses all cached workouts
- Evidence: `getPlannedWorkouts` loads days of every confirmed, undiscarded program; Today filters to `programs[0]`. `upsert_program` with `phase_id` adds days to the phase's older program, and a second confirmed program (the AGENTS "two live plans" incident) makes the older one's future days vanish from Today while the coach context names them.
- Confidence: likely (design may be intentional: comment says "most recent confirmed program drives the week")
- Limitation: did not check whether the server prevents two confirmed programs.
- Verification path: Today test with two confirmed programs each having a dated day this week.

### PLAN-10: sessionHistory's private fetchWithCache swallows server errors
- Severity: low-medium (violates the "answer of no is REPORTED, not shown as offline" rule; a broken view column on History reads as a basement)
- Location: pwa/src/lib/sessionHistory.ts:~42-53 (used by `getSessionLog`, `getWeeklySummary`)
- Evidence: `catch (e) { const cached = await cacheGet(key); if (cached !== undefined) return {data: cached, fromCache: true}; throw e; }` with no `reportError` and no stale reason, unlike `makeFetchWithCache` used by checkinHistory.ts. The file comment says it "mirrors" data.ts but it does not.
- Confidence: confirmed
- Limitation: History banner behaviour not traced.
- Verification path: make the select fail with a PGRST code with a warm cache; assert reportError is called.

### PLAN-11: History open-session sets loader has no catch
- Severity: low (unhandled rejection; `openSets` stays undefined so the row spins forever offline with a cold cache)
- Location: pwa/src/screens/History.tsx:246-262
- Evidence: `void (async () => { const [rows, voided] = await Promise.all([getServerSessionSets(openId), outbox.pendingVoidIds()]); if (!cancelled) setOpenSets(...) })();` no try/catch.
- Confidence: confirmed
- Limitation: none.
- Verification path: mock getServerSessionSets to reject; expect reportError and an error state.

### PLAN-12: Plan-row creators race on day_index and are non-atomic
- Severity: low
- Location: pwa/src/lib/data.ts: createPlannedWorkout (~958-975), duplicatePlannedWorkout, saveWorkoutAsTemplate, applyTemplate
- Evidence: each reads `max(day_index)` then inserts `max+1` under `unique (program_id, day_index)`; a concurrent create (second device, or MCP upsert adding to the same program) gives a 23505 surfaced as a generic error. The day insert and prescription insert are two statements, so a failed second leaves an empty DRAFT day (duplicate, template apply).
- Confidence: likely
- Limitation: not reproduced.
- Verification path: PGlite concurrent-insert test, or move creation into a DB function.

### PLAN-13: Markdown italics fire inside identifiers and arithmetic
- Severity: low (cosmetic; no HTML path, no links, so no XSS)
- Location: pwa/src/lib/markdown.ts:65-72
- Evidence: `/^_([^_\n]+)_/` and `/^\*([^*\n]+)\*/` match anywhere: `parseInline("goblet_squat_set")` renders "squat" italic and drops the underscores; "3*5 and 4*6" becomes "35 and 46" with italics. The file's own comment claims a lone asterisk stays literal, only true when unmatched.
- Confidence: confirmed (by reading the regexes)
- Limitation: not executed.
- Verification path: add cases to the markdown test; require word boundaries for `_`.

### PLAN-14: Login rejects a pasted code with a space
- Severity: low
- Location: pwa/src/screens/Login.tsx:~97
- Evidence: `/^\d{6}$/.test(raw)` after `trim()`; "123 456" (how some mail clients display it) falls to the URL branch and shows "does not look like the 6-digit code".
- Confidence: confirmed
- Limitation: none.
- Verification path: strip internal whitespace before the test.

### PLAN-15: Check-in sheet keeps a just-cleared episode matchable
- Severity: low (speculative)
- Location: pwa/src/components/CheckInSheet.tsx:~135-142 (`clearedUp`), matchEpisode use at :~107
- Evidence: `clearedUp` enqueues the close but does not update local `injuries`; ticking Pain with the same region/side in the same sheet files the check-in against the episode that was just closed.
- Confidence: speculative
- Limitation: not exercised.
- Verification path: component test: Cleared up, then Pain + same region, inspect the queued ops.

## Checks run and results
- `cd pwa && npx vitest run src/screens/Today src/screens/Plan src/screens/History src/screens/Login src/screens/OAuth src/lib/calendar src/lib/markdown src/lib/coach src/lib/checkin src/lib/planChanges src/lib/trainingScene`: 20 files, 204 tests, all pass.

## Clean areas
- Planned-day state machine: `workoutStates` order is DONE, SKIPPED, DRAFT, then date checks; `getDoneWorkoutIds` and `finishedWorkoutIds` both require `ended_at not null` and `discarded_at null`; coachContext `weekDayState` mirrors it with PAST on unknown.
- calendar.ts: all date math goes through parseLocalDate/todayLocalIso with `new Date(y, m, d+n)` (DST-safe); weekStart modulo correct; no toISOString for local dates in calendar/Today/History (the toISOString uses are instants).
- Hard rules: no direct writes to sets/sessions/set_voids from these screens beyond outbox; plan edits go via rpc (`swap_planned_workout_order`, `apply_plan_edit_with_delete`) or the label/date/note patches that the guard trigger covers; `createPlannedWorkout` always sets `scheduled_date`; no adherence ratio (History shows counts only).
- Coach rendering: Markdown.tsx/markdown.ts produce elements only, no links, no dangerouslySetInnerHTML anywhere in pwa/src (grep).
- OAuthConsent: authorization id is whitelisted, redirect target only comes from Supabase's `redirect_url`, host shown to the user; cancel guard present.
- coachAccess: every uncertain path resolves to enabled. Login: OTP code flow, cooldown effect cleans up its interval.
- BodyweightRow: state held in kg, `toStoredKg` rounds to 2 decimals (no double conversion); agoLabel is calendar-day based.
- fuzzy.ts: non-ASCII-only queries return 0 (guarded), withinOneEdit prefix behaviour OK.

## Not covered
- Plan.tsx (2009 lines) was read in its state/effects/run wrapper and section/template handlers only; the row editor, drag handling and lib/sections.ts reorder logic got no deep review.
- SettingsSheet, ConnectedApps, ReportBugSheet, ExerciseDemoSheet, FabDock, WorkoutPreviewSheet, NewExerciseSheet, charts/**, CheckinWeek, RateSessionCard, checkinMemory.ts were not reviewed beyond grep.
- Server-side behaviour (edge function, RLS) was not run; no browser/UI run.


---

# Original report: infra

# INFRA audit: CI/deploy, scripts, secrets, deps (main d5e7b64)

### INFRA-1: pg_cron alert sweep cannot authenticate through the Supabase gateway (push-alerts is verify_jwt ON)
- Severity: medium (when the sweep is configured, closed-app check-in prompts never deliver, and the cron job still reports success; today it is unconfigured, so latent)
- Location: supabase/migrations/20260907060000*.sql:62-69; .github/workflows/deploy.yml (`supabase functions deploy push-alerts`, no flag); docs/deploy.md:500; supabase/functions/push-alerts/index.ts:932-938; supabase/config.toml (only `[functions.mcp-server]` is declared)
- Evidence: `run_alert_sweep()` posts with headers `Content-Type` and `x-sweep-secret` only, no `Authorization`/`apikey`. deploy.md says push-alerts keeps verify_jwt ON. The function's own comment says it answers `/sweep` "BEFORE the session check", but with verify_jwt ON the platform gateway rejects a request with no valid JWT (401) before function code runs. net.http_post is fire-and-forget, so pg_cron reports success.
- Confidence: likely (gateway behavior is Supabase's documented verify_jwt semantic; I did not call the live project)
- Limitation: not verified live. A-137/A-138 are already "needs live proof", so this may surface as the reason when they are tested.
- Verification path: after setting SWEEP_SECRET and the Vault rows, read `net._http_response` for the last run; expect 401 with a gateway body. Fix options: send the anon key as `Authorization: Bearer` in `run_alert_sweep` (gateway passes, function then checks `x-sweep-secret`), or `[functions.push-alerts] verify_jwt=false` plus an in-function session check on every other route.

### INFRA-2: path-gated deploy can publish a client ahead of an unapplied schema after one failed deploy
- Severity: medium (data safe, but PWA can ship against missing migrations/functions; needs a failed supabase job followed by a pwa-only push)
- Location: .github/workflows/deploy.yml:48-66 (diff `BEFORE..AFTER` per push), :129-137 (pages gate)
- Evidence: `changed=$(git diff --name-only "$BEFORE" "$AFTER")`; `supabase=true` only if THIS push touched `supabase/`. Push 1 changes supabase/ and PWA; `db push` fails, pages is correctly skipped. Push 2 (a PWA-only fix) computes supabase=false, so the failed migration is never retried and pages publishes the newer client over a schema that still lacks Push 1's migrations.
- Confidence: confirmed by reading the logic (not run on Actions)
- Limitation: workflow_dispatch re-runs everything (BEFORE empty), which is the manual recovery; nothing forces it.
- Verification path: add a test in check-deploy-contract.test.mjs; fix by always running `supabase db push` (it is a no-op when current) or diffing against the last successful deploy SHA.

### INFRA-3: check-pwa-env accepts any JWT as the "anon" key, including a service_role key
- Severity: medium (public repo + public Pages bundle; a mispasted service key in the `VITE_SUPABASE_ANON_KEY` repo variable would ship an RLS-bypassing key; the guard exists precisely to catch bad keys)
- Location: scripts/check-pwa-env.mjs:3,26-30
- Evidence: only a three-part base64url regex. Probe: `validatePwaEnv({VITE_SUPABASE_URL:"https://abc.supabase.co", VITE_SUPABASE_ANON_KEY:"<hdr>.<payload role=service_role>.sig"})` returns `{ ok: true }`. It also rejects the new `sb_publishable_…` key format (would break the build if the project migrates keys).
- Confidence: confirmed (ran the probe)
- Limitation: variable is stored as a non-secret repo var, so a paste mistake is plausible but not observed.
- Verification path: decode the payload and require `role === "anon"` (or accept `sb_publishable_` and reject `sb_secret_`/service_role); add a test case.

### INFRA-4: MCP tunnel relay crashes on a malformed request target (unhandled rejection)
- Severity: low (loopback only; supervisor restarts it after backoff; but the single process holds the owner's bearer and a crash drops the ChatGPT tunnel)
- Location: scripts/strength-mcp-relay.mjs:98-99
- Evidence: `const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;` runs before the Origin/Host check and outside try/catch. A raw `POST // HTTP/1.1` makes `new URL` throw inside the async handler; probe output: `UNHANDLED REJECTION: Invalid URL` (Node exits on unhandled rejection by default).
- Confidence: confirmed (probe with raw socket against createRelayServer)
- Limitation: browsers normalize URLs so a web page cannot easily send this; a local process can.
- Verification path: wrap in try/catch returning 400, and move the foreign-host check first; add a relay test.

### INFRA-5: workflow hygiene (unpinned actions, wide permissions, `latest` CLI)
- Severity: low (supply-chain exposure on a job holding SUPABASE_DB_PASSWORD and a token that can write production)
- Location: .github/workflows/deploy.yml:26-27 (`permissions: contents: write` for the whole workflow), :92-94 (`supabase/setup-cli@v1`, `version: latest`), :167 (`peaceiris/actions-gh-pages@v4`), ci.yml (all actions by tag; no `permissions:` block)
- Evidence: third-party actions referenced by mutable tag, not SHA; `contents: write` applies to the supabase job and `changes` job too, though only pages needs it; the production deploy CLI floats to `latest`.
- Confidence: confirmed
- Limitation: no evidence of exploitation. No `pull_request_target`, no `github.event.*` text interpolated into `run:` (BEFORE/AFTER pass via env; `${{ github.sha }}`/`run_id` are not attacker-controlled) -- those are clean.
- Verification path: pin by SHA, set `permissions: {}` at top and `contents: write` on `pages` only, pin the CLI version.

### INFRA-6: build stamp values are wrong or meaningless
- Severity: low (diagnostics only)
- Location: .github/workflows/deploy.yml:158-160
- Evidence: `VITE_APP_VERSION: ${{ github.ref_name }}` is always `main` on push; `VITE_BUILD_TIME: ${{ github.event.repository.updated_at }}` is the repo's last-updated time (also empty on workflow_dispatch? it is the repository object, present, but not the build time). The comment says the aim was distinguishing builds; only VITE_BUILD_SHA does.
- Confidence: confirmed (reading; pwa/src/lib/build.ts:9-11 consumes both)
- Limitation: did not check where the About row shows them.
- Verification path: use `date -u` into $GITHUB_ENV for time; use a tag or short sha for version.

### INFRA-7: CI/doc gaps
- Severity: low
- Location: .github/workflows/ci.yml; scripts/coach-eval/stack.test.mjs; supabase/functions/*/deno.lock
- Evidence: (a) `scripts/coach-eval/stack.test.mjs` is never run by CI and not listed in AGENTS.md. (b) `deno check`/`deno test` run without `--frozen`, and mcp-server imports `@supabase/supabase-js@^2` (open range), so CI can resolve a different dependency than the lock records. (c) Deploy never runs the deno suites (A-134 known, still present: deploy.yml has no `needs` on CI and `pages` only runs vitest). (d) ci.yml has no `concurrency`. AGENTS.md "Tests, by area" otherwise matches ci.yml exactly.
- Confidence: confirmed
- Limitation: did not run deno (not required by assignment).
- Verification path: `deno test --frozen` in each function dir; add stack.test.mjs to the node --test line if it is pure.

## Checks run and results
- `node --test` (6 files): 28 pass, 0 fail. `node scripts/check-release-ledger.mjs`: ok.
- `cd pwa && npm run build` (tsc -b + vite build + PWA precache): pass, 11 precache entries.
- `npm audit --omit=dev` in pwa: 0 vulnerabilities. `npm audit` in scripts and scripts/coach-eval: 0 vulnerabilities.
- `npm outdated`: patch/minor drift only on pwa deps (supabase-js 2.112.4 vs 2.117.2, react 19.2.8 vs 19.3.0); majors behind: vite 6 (8 latest), vitest 3 (5), @sentry/react 9 (11), jsdom 26 (30), vite-plugin-pwa 0.21 (1.3), pglite 0.3 (0.5). Nothing abandoned. Lockfiles present and `npm ci` succeeded implicitly (node_modules existed).
- Secret grep (JWT, sk-ant, sb_secret, sbp_, stl_ tokens, PEM, AKIA, ghp_): only fake/test JWT fixtures (pwa/src/lib/supabaseEnv.test.ts, scripts/check-pwa-env.test.mjs, a plan doc), all `eyJ…` redacted here. No .env tracked (only pwa/.env.example). The Sentry DSN in deploy.yml is public by design and documented.
- Ad hoc probes: relay malformed-URL crash (INFRA-4), env checker with a service_role-shaped JWT (INFRA-3).

## Clean areas
- Deploy order: supabase job (db push, then mcp-server `--no-verify-jwt`, then coach, push-alerts, endurance-sync) precedes pages; mcp-server before coach as deploy.md requires. `--no-verify-jwt` only on mcp-server (matches config.toml `verify_jwt=false`); coach, push-alerts, endurance-sync deploy with JWT verification on.
- Gate step fails (not skips) when secrets are missing; pages skip logic via `always()` plus failure/cancelled checks is sound for the same-push case.
- Smoke polls served build.json for the exact sha; concurrency group with no cancel-in-progress protects `db push`.
- No `pull_request_target`; PR CI has no secrets. No script injection: only env-passed or non-attacker `github.*` values in `run:`.
- issue-mcp-token.mjs: 32 bytes randomBytes, base64url, SHA-256 hex digest matching mcp-server/lib/auth.ts sha256Hex over `token_sha256`; uuid validated, label quote-escaped; prints token once, no network, no disk write.
- Relay/supervisor: https-only upstream, exact `/mcp`, redirect error, body cap, Origin/Host loopback check, Keychain read without logging secret, tunnel env minimized.
- coach-eval writes `out/mcp-token.txt` but `out/` is gitignored (scripts/coach-eval/.gitignore); the token is for a throwaway PGlite stack. `.env`, `.env.*`, `supabase/.env`, `.postgrest.conf` handling fine (`.postgrest.conf` has no key; key is passed via env).
- oauth-spike never prints the access token. push-auth-config.sh sources a gitignored .env.local and `set -euo pipefail`.
- `.claude/settings.local.json` is not tracked (only launch.json is) and contains only broad `git push *`, `gh run *`, `rm -f .env` allowances locally.
- release-ledger vs docs/deploy.md: statements about the four-function deploy, fail-not-skip gate and served-sha smoke match the workflow.

## Not covered
- Live Actions behavior, Supabase gateway behavior, `supabase migration list` / ledger mis-stamp state (needs remote access).
- deno check/test (not in the assignment's commands).
- Per-package transitive license/maintenance review beyond `npm audit`/`outdated`.
- scripts/validate-db.mjs and check-selects.mjs correctness (covered by the DB audit area).


---

# Original report: docs-structure

# Docs structure audit, strength-tracker @ d5e7b64, 2026-10-01

Score: 7/10. Link hygiene and routing are strong. The weaknesses are the 949-line always-loaded AGENTS.md, no indexes for the three archive-style folders, and a cluster of orphaned plans.

Scan: 82 tracked .md files (plus 2 untracked). All relative links and anchors resolved except 2 (STRUCT-004). A bare-path scan found 1 false positive (`CLAUDE.md/AGENTS.md` prose in tasks-19-20-21-22.md). Scan script: scratchpad/audit/scan.mjs.

## Findings

STRUCT-001 (high) AGENTS.md is an oversized always-loaded file
- Location: AGENTS.md (949 lines, 63.8 KB, imported by CLAUDE.md and .github/copilot-instructions.md, so loaded in every session by all three tools).
- Evidence: "Hard rules" alone is lines 38-679 (642 lines, about 68% of the file). About 94 top-level bullets, about 160 lines containing must/never/always/do not/only. Most bullets are 10-40 lines of incident history ("that was three 500s on a real day", "a real user with two live plans", "put a lifter in a basement gym"), with migration IDs and dates. The file's own header says rules "encode invariants that have already caused real production bugs", but the rationale is mixed into the rule.
- Recommendation: keep each rule as 1-3 lines (the invariant plus the file or table that enforces it) and move the incident narrative to docs/decisions.md (3179 lines, already the deviation log) or a new docs/invariants.md linked per rule. Target under 250 lines. Candidates to move wholesale: the subjective-capture bullet (about 55 lines), the activities bullet, the planned-structure and soft-delete bullets, the offline/outbox/session-persistence bullets (about 10 bullets), the pg_cron/Vault guard bullet. Do this in a dedicated change, because several tests or docs may cite section text.

STRUCT-002 (medium) Duplication between AGENTS.md and docs/architecture.md, security.md, decisions.md
- Evidence: architecture.md lines 47-65 restate the sets/set_notes/session_skips/coach_memory write-ownership rules from AGENTS.md; security.md restates the MCP service-role and append-only model (lines 32-42, 95-101, 144); the "Security boundaries" section of AGENTS.md (24 lines) and "Areas that should not be modified casually" (29 lines) repeat Hard rules content. README "Design in five claims" is a third restatement. Four places must be edited when an invariant changes.
- Recommendation: AGENTS.md states the rule, architecture.md and security.md link to it (or the reverse) and carry no copy. Delete or collapse "Areas that should not be modified casually" into pointers to the Hard rules entries.

STRUCT-003 (medium) Orphaned docs (no inbound link from any other doc)
- Plans with zero inbound: 2026-09-12-strength-tunnel-relay.md, 2026-09-12-warm-precision-implementation.md, 2026-09-13-mcp-oauth-sign-in.md (1751 lines), 2026-09-16-live-session-adaptation.md, six `live-session-adaptation/tasks-*.md` files (about 14.7k lines total; the parent plan has no inbound link, so they hang from nothing), 2026-09-23-training-scenes.md (linked only from its own spec), 2026-09-30-load-sync-recovery.md (the newest plan; nothing links it, neither the roadmap nor the ledger).
- design-log: 2026-09-07-world-class/{README, critique-round-1, critique-rounds-2-4, fal-texture-brief, prototypes/README} have no inbound; 2026-09-12-focus-mode has no README at all (5 PNGs only); 2026-09-12-warm-precision/README is linked only from a plan.
- docs/audits/2026-09-23-mece/README.md has no inbound (SUMMARY.md is linked, README is the entry).
- .github/ISSUE_TEMPLATE/copilot-task.md and .github/copilot-instructions.md: tooling entry points, orphan by design, ignore.
- Recommendation: add the indexes in STRUCT-005 and a "Status" line at the top of each shipped plan. Link 2026-09-30-load-sync-recovery.md from the roadmap or ledger, since the ledger is the stated status source.

STRUCT-004 (low) Two broken relative links
- docs/audits/2026-09-19-system-audit.md lines 1000-1001: `../../pwa/src/components/E1rmChart.tsx` and `VolumeChart.tsx` do not exist (components renamed or moved). Audit is a frozen evidence backlog, so either leave with a "moved since" note or fix the paths. No broken anchors found.

STRUCT-005 (medium) No index for docs/audits, docs/superpowers/plans|specs, docs/design-log, or docs/ itself
- Evidence: docs/ has no README/index. docs/audits has 4 top-level files + a MECE folder (README + SUMMARY + 13 reports), no index. superpowers/plans has 26 files, specs 9, no index or status column. design-log is 6.1 MB (78 tracked PNGs, 5 CSS themes, 8 HTML prototypes) with no top index. AGENTS.md "Layout" lists only roadmap, plan, decisions, deploy, endurance docs, and does not mention audits, plans, specs, flows, architecture, security, setup or design-log.
- Recommendation: one docs/README.md table (path, purpose, status: active/historical/frozen). Give plans/ a status table (active, shipped, superseded) so agents do not pick up a finished plan. Consider moving design-log screenshots out of the main tree (or note in the index that it is archive-only).

STRUCT-006 (medium) Two untracked audit files are unreferenced and stale-prone
- docs/audits/2026-10-01-deployed-ui-audit.md (124 lines) and ...-deeper-pass.md (115 lines) are untracked. They reference each other only. Nothing in AGENTS.md, README, the roadmap or the ledger links them; the roadmap's audit list stops at 2026-09-23 files.
- Recommendation: commit them, then link from the roadmap (or the new audits index) and register any stop-release items in the ledger. Note the first file's header already says it was superseded in part by the second; that cross-reference is fine.

STRUCT-007 (low) Routing in AGENTS.md is correct but thin
- Evidence: Layout (lines 18-36) correctly names the active roadmap and release-ledger and marks plan.md historical; docs/plan.md and ledger repeat the same routing; README line 80 labels plan.md historical. The ledger header (line 6-18) was last reconciled 2026-09-24 and does not mention the 09-30 load-sync-recovery work or the 10-01 audits; roadmap last touched 09-24. Docs last modified dates: AGENTS.md 09-24, decisions.md 09-24, deploy.md 09-24, ledger 09-24, i.e. 6+ days behind commits d5e7b64 / 99fa439 / 3a06a56 which shipped phone-queue and units work.
- Recommendation: add "Where things are" pointers to architecture, security, setup, flows, audits and the plans index; re-reconcile the ledger date, or add a line in the ledger header saying 09-30 work is tracked in the load-sync-recovery plan.

STRUCT-008 (low) Naming conventions mostly consistent
- Dated YYYY-MM-DD-kebab names in plans/specs/audits/design-log/roadmaps. Exceptions: top-level docs are undated (fine), MECE reports use numbered NN-area.md, spec files use mixed suffixes (`-design`, `-redesign`, none: 2026-09-12-focus-mode-and-checkin-redesign.md vs 2026-09-16-checkin-redesign-design.md), plans lack the `-plan` suffix inconsistently (2026-09-12-observability-recovery-plan.md vs 2026-09-13-mcp-oauth-sign-in.md). Date mismatch: design-log 2026-09-07-world-class critique files last committed 2026-09-06. A plan/spec pair relation is only discoverable through links (several plans have no spec link back).
- Recommendation: pick `<date>-<topic>.md` for plans and `<date>-<topic>-design.md` for specs going forward; no mass rename (renames break the cross-references listed above).

STRUCT-009 (low) docs/spec.md and docs/plan.md are legacy but still in the main docs path
- spec.md last modified 2026-08-28, "kept verbatim, decisions.md wins"; plan.md "historical build log" with an in-document redirect. Both labelled correctly. Optional: move to docs/archive/ or mark in the index. Not urgent.

STRUCT-010 (medium) .claude/settings.local.json is stale and has some risk
- Gitignored and untracked (fine, not shared). Contents: 11 allow entries, most are one-off leftovers: a `node -e` date snippet, two `perl -pi -e` edits against relative paths (src/lib/format.ts, vite.config.ts), `rm -f .env`, plus broad wildcards `Bash(git push *)`, `Bash(gh repo *)`, `Bash(gh run *)`, `Bash(git remote *)`, `Bash(npm run *)`, `Bash(npx vitest *)`. `git push *` and `gh repo *` (can include `gh repo delete` / visibility change on a public repo) are the ones I would narrow. No secrets seen.
- Recommendation: delete the 4 one-off entries; replace `git push *` with `git push origin main` or drop it (AGENTS notes pushing main deploys everything via CI); replace `gh repo *` with `gh repo view *`.

STRUCT-011 (info) .claude/launch.json matches pwa/package.json
- dev -> `vite` (default port 5173, no port override in vite.config.ts) matches port 5173. demo -> `VITE_DEMO=1 vite --port 5199` matches 5199. pwa-demo-alt appends `-- --port 5210` after the script's own `--port 5199`; last flag wins in vite, port 5210 matches, but it is fragile. `--prefix pwa` works from repo root. launch.json is the only tracked .claude file; CLAUDE.md line 15 references it correctly.

STRUCT-012 (info) Worktree clutter
- `.worktrees/` (4 registered worktrees: checkin-redesign, live-session-plan, visual-system, warm-precision; gitignored) plus 3 external Codex worktrees in ~/.codex/worktrees. `.claude/worktrees` exists and is empty. These branches (checkin-redesign, warm-precision, live-session-adaptation-plan) correspond to September work that appears merged; they contain duplicate copies of docs and will show up in repo-wide greps. Recommendation: prune merged worktrees. Also untracked-but-ignored dirs `.audit`, `.superpowers/sdd/*`, `.impeccable`, `.playwright-mcp`, `.bin` are properly ignored.

## What is good
- AGENTS.md as shared source; CLAUDE.md (21 lines) and copilot-instructions.md (23 lines) are thin importers with only tool-specific notes, matching the stated rule.
- Cross-linking between roadmap, ledger, plans and audits is dense (ledger in=16, roadmap in=19, decisions in=23, deploy in=19).
- Every root-level doc has an inbound link; only one broken-target pair across the repo.
- supabase/functions/mcp-server/README.md (106 lines) is linked from 3 docs.

## Inventory highlights (path, last commit, lines, inbound)
README.md 2026-09-21, 91, in=1 | AGENTS.md 09-24, 949, in=23 | CLAUDE.md 09-15, 21, in=0 (tool entry) | docs/architecture.md 09-21, 311, 3 | decisions.md 09-24, 3179, 23 | deploy.md 09-24, 653, 19 | endurance-plan 09-21, 403, 9 | endurance-research 09-06, 664, 7 | flows 09-23, 505, 5 | plan 09-21, 295, 8 | security 09-21, 146, 9 | setup 09-21, 621, 15 | spec 08-28, 149, 6 | roadmap 09-24, 477, 19 | release-ledger 09-24, 70, 16 | audits/2026-09-19-system-audit 09-19, 1813, 6 | MECE 15 files 09-23 (SUMMARY in=1, README in=0) | 5 plans with in=0 plus 6 task files (see STRUCT-003). Full table: rerun `node scratchpad/audit/scan.mjs`.

## Suggested order
1. STRUCT-001/002 (trim AGENTS.md, dedupe). 2. STRUCT-005 + 006 (docs/README index, commit and link the 10-01 audits). 3. STRUCT-010 (settings allowlist). 4. STRUCT-003/004/012 cleanup.


---

# Original report: docs-content

# Docs content audit, strength-tracker @ d5e7b64, 2026-10-01

Content score: 6.5/10. AGENTS.md is accurate against code on every spot-check (model IDs, effort, migrations, helper names, CI commands). The rot is in the entry-point docs (README, mcp-server README), the roadmap/ledger (frozen at 2026-09-24), and several auto-memory entries.

## Verified accurate (no action)
- Coach model `claude-sonnet-5` (coach/index.ts:86), effort medium, extraction `claude-haiku-4-5-20251001` (memory-extract.ts:61). COACH_MEMORY_EXTRACT / COACH_LOG_CONTENT env vars exist.
- Files named in AGENTS.md exist: corrections.ts, persistedSession.ts, swUpdate.ts, exerciseMedia.ts, loadStyle.ts, loadEntry.ts, settings.ts, rpe.ts, prompts.ts, db.ts, errors.ts, memory-extract.ts, coach/lib/allowlist.ts, hooks/useLocalToday.ts (in hooks/, AGENTS.md gives no path, fine), .claude/launch.json.
- SQL objects exist in migrations: app_tz, coach_enabled, pw_delete_template, v_trend_digest, v_live_activities, restore_session_for_late_set, replace_planned_workout_prescriptions, reserve_coach_turn, run_alert_sweep.
- AGENTS.md "Tests, by area" matches ci.yml job-for-job. Ledger regression-test names all grep-resolve (outbox.test.ts A-90/A-91/A-143, OutboxSheet.test.tsx A-148, Session.focus.test.tsx A-107, validate-db.mjs A-84/A-92, allowlist.test.ts, health.test.ts, coach thread.test.ts, mcp protocol.test.ts).
- `set_training_plan` confirm_change gate exists (training_plan.ts, 7 refs).

## Findings

CONTENT-001 (high) README claims OAuth is not built
README.md:9,39-46 ("static bearer", "without running an OAuth 2.1 authorization server... the upgrade path is documented, not built"). Evidence: supabase/functions/mcp-server/lib/oauth.ts + pwa/src/screens/OAuthConsent.tsx exist; OAuth sign-in shipped 2026-09-13 (memory, plans/2026-09-13-mcp-oauth-sign-in.md); roadmap says friends connect via Claude/ChatGPT. Same stale framing in docs/architecture.md:11, docs/security.md:33,43, docs/setup.md:149-151,220. Also README diagram says "service role, pinned user id", which is the pre-multi-user model (AGENTS: the token maps to a user, MCP_SECRET refused since 1ec3045). Rec: rewrite claim 5 and the diagram to "bearer token or Supabase OAuth token, both resolve to a user".

CONTENT-002 (high) Roadmap and ledger frozen at 4da2c7d (2026-09-24); main is at d5e7b64 (9-30)
docs/roadmaps/2026-09-19-consolidated-roadmap.md:3-8, release-ledger.md:5-18. Evidence: 8 commits since (40676f5, 4d320f8, 3a06a56, 8a84a89, c7e2ae4, 99fa439, d5e7b64, f643fd3) cover load/authored-unit consistency, rejected-set recovery, rest state, superset containment; none is in the roadmap or ledger. Roadmap says "Remote migrations match local through 20260924052445" but the migration dir now ends at 20260924200000 (three newer: 190000 atomic_training_plan_replace, 200000 lock_training_max_history; 20260924003054..052445 are the earlier ones). Roadmap "Next: finish Phase 2" has no 9-30 state. Rec: add a 2026-09-30 status block (load-sync-recovery work, phone queue incident, which gate it touches), update migration line, add ledger rows if the load-consistency error got IDs.

CONTENT-003 (medium) No decisions.md entry for 2026-09-30 work
docs/decisions.md latest heading is 2026-09-24 (line 3170). AGENTS.md requires every deviation logged. The 9-30 load-recovery plan introduces a reviewed repair that marks contradictory provenance unknown (a write-ownership-adjacent choice on append-only sets) and "outbox export before repair". Also decisions.md is 3178 lines and the headings at 677-814 are not chronological with the tail (08-27, 08-28 then 09-21): ordering is by topic or appended inconsistently. Rec: add an entry; consider an index at top.

CONTENT-004 (medium) Tool-count claims disagree three ways
README.md:53 "22 tools"; supabase/functions/mcp-server/README.md:6 "14 tools"; docs/architecture.md:123 "41 tools". Code registers ~41 (grep of registerTool names). Rec: drop counts or state 41 in one place and link.

CONTENT-005 (medium) README phase pointer stale
README.md:~83 "Phase 0 merged; Phase 1 is next". Ledger/roadmap: Phase 1 gate passed 2026-09-24, Phase 2 in progress. Also "6 screens" (README:55) vs pwa/src/screens has 7 non-test screens (End, History, Login, OAuthConsent, Plan, Session, Today). Rec: point at the roadmap without restating phase, fix count.

CONTENT-006 (medium) AGENTS.md coach-disabled-tool list incomplete in one place
AGENTS.md:693 lists delete_program, delete_exercise, update_exercise as disabled; coach/index.ts:1162-1181 disables six more-or-less: also set_training_plan, confirm_training_plan (AGENTS.md:578 covers these) and confirm_program (c4565ca "Refuse live-plan confirmation from the in-app coach"; AGENTS.md:116 only says confirm needs approval, never says the coach cannot call it). And AGENTS.md:856 "Areas that should not be modified" lists only three. Rec: one list of all six in AGENTS.md:693 and :856, and note upsert_program stays.

CONTENT-007 (medium) Release-ledger inconsistencies
(a) Header prose (ledger:11-18) is a run-on narrative that duplicates the table and the roadmap status block; two places to update. (b) A-02 row has an unformatted table row (cols not padded) and A-84/A-90 etc. wrapped, harmless but check-release-ledger passes. (c) A-134 "open" with note "deferred: CI billing": decide wontfix vs open. (d) A-137/138 "needs live proof" counted as deferred to Phase 5 in roadmap but still ledger-blocking per the checker semantics: state it in the row. No fixed row has a missing test; no open row was obviously fixed by commits since 9-19 (A-74..76, 139-141, 156-158 are endurance, untouched).

CONTENT-008 (medium) Plan files' unchecked checkboxes are not a status signal
Every plan has 0 ticked boxes except production-readiness-audit (15/16). Merged work (phase-0: 24 open boxes, merged as PR #8; oauth: 50 open, shipped; checkin: 53 open, A-96 fixed) still looks unstarted. Roadmap "Plan authority" says never resume unchecked tasks, which mitigates, but only 3 plans carry a Status line. Rec: add a one-line "Status: Completed <sha>/Superseded by X" header to each plan (table below), or move completed plans to docs/superpowers/plans/archive/.

CONTENT-009 (medium) Superseded OAuth-fallback tunnel still documented as live in AGENTS.md CI and setup
AGENTS.md CI list and ci.yml still run strength-mcp-relay / tunnel-supervisor tests; setup.md:220 describes the relay as the route for ChatGPT. Memory says the tunnel was never installed and is a fallback only. Plan 2026-09-12-strength-tunnel-relay.md is effectively abandoned. Rec: label scripts and setup section "fallback, not installed"; decide whether to keep maintaining the tests.

CONTENT-010 (low) AGENTS.md "Development commands" test list is shorter than CI
AGENTS.md dev block runs `node --test` over 3 files; "Tests, by area" and ci.yml run 6. Two lists in one file that differ. Rec: dev block should say "see Tests, by area".

CONTENT-011 (low) AGENTS.md size and voice
948 lines, one file is the shared source for 4 agents; many bullets are 20+ line paragraphs holding history ("a real user's whole plan is stored at half") that belongs in decisions.md. Em dashes are used heavily despite the global voice rule (applies to Colt's own writing, not necessarily repo docs; flag only if repo is meant to follow it). Rec: leave rules in AGENTS.md, move the incident narratives to decisions.md with one-line pointers.

CONTENT-012 (low) AGENTS.md says docs/endurance-plan.md "deferred until Phase 5"; roadmap agrees. No conflict. CLAUDE.md (20 lines, imports AGENTS.md) and copilot-instructions.md (imports AGENTS.md) are consistent and non-duplicating. No contradiction with global CLAUDE.md: repo has no new README-creation rule, and the global "never create README files" is respected (README predates it).

CONTENT-013 (low) Untracked audit docs
docs/audits/2026-10-01-deployed-ui-audit*.md are untracked (git status); not referenced from roadmap, which names only the 9-19, 9-23 audits. Rec: reference or commit.

## Plan status table

| Plan | Status | Evidence |
|---|---|---|
| 2026-09-04-coach-eval-run1 | Completed (historical) | no boxes; eval harness in scripts/coach-eval |
| 2026-09-04-gaps-roadmap | Superseded | file header says "Do not execute"; 59 open boxes |
| 2026-09-04-sequenced-plan | Stale | touched 9-21 only for pointer; superseded by consolidated roadmap |
| 2026-09-05-build-plan | Completed | historical |
| 2026-09-05-plan-and-review-loop | Completed | plan/confirm tools in code |
| 2026-09-06-endurance-implementation-spec | Deferred (Phase 5) | endurance ledger rows open |
| 2026-09-12-observability-recovery-plan | Completed | Status line: settings exist, runs verified; CI deploys |
| 2026-09-12-production-readiness-audit | Completed | 15/16 boxes ticked |
| 2026-09-12-session-focus-deck-implementation | Completed (partly) | Status line: tasks 1-6 merged; 47 boxes still open, tasks 7+ not evidenced |
| 2026-09-12-strength-tunnel-relay | Abandoned/fallback | superseded by OAuth 9-13; scripts remain |
| 2026-09-12-warm-precision-implementation | In progress/unclear | branch codex/warm-precision still a live worktree at 858b48f, unmerged |
| 2026-09-13-mcp-oauth-sign-in | Completed | lib/oauth.ts, OAuthConsent.tsx, memory |
| 2026-09-16-checkin-redesign | Completed | A-96 fixed with test; CheckInSheet; worktree .worktrees/checkin-redesign still present |
| 2026-09-16-live-session-adaptation (+dir of task files) | Stale/unclear | branch live-session-adaptation-plan is a worktree at 4abe923; no ledger row; verify before deleting |
| 2026-09-21-phase-0-safety-backlog | Completed | Status line: merged PR #8 c25e3ad |
| 2026-09-21-phase-1-admission-tenant | Completed | PR #10, roadmap |
| 2026-09-21-phase-1-release-contract | Completed | PR #10, A-24/25/135 |
| 2026-09-23-training-scenes | Mostly completed | commits e76a11d, 3dc8ded, 11c0f0d, f3f7c79 on main |
| 2026-09-24-a135-a91-a84-release-and-record | Completed | bc203a0 marks fixed |
| 2026-09-24-phase-2-record-safety | Completed | 59f043a, a61922e |
| 2026-09-30-load-sync-recovery | In progress | codex/load-sync-recovery worktree at 99fa439; main has 40676f5..d5e7b64; unrecorded in roadmap |

## Auto-memory table

| Entry | Verdict | Issue |
|---|---|---|
| MEMORY.md index | Needs edit | does not list app-adapts-to-lifter.md (9 files, 8 indexed) |
| strength-tracker-project | Stale, partly wrong | says "OAuth deliberately not built", "service role pinned to OWNER_USER_ID", "Phase 4 first real use pending", "local checkout behind origin": all superseded (OAuth 9-13, multi-user 8-27). Contains owner user id and email in memory; fine locally. Shrink to a pointer to AGENTS.md. |
| strength-tracker-parallel-sessions | Mostly true | worktrees .worktrees/ exist (4); Codex worktrees now under ~/.codex/worktrees, not .worktrees/codex-*; update |
| strength-tracker-deploy-sequencing | True with stale header | opening says a migration only reaches prod when applied; its own later paragraph (CI deploys since 9-12) corrects this. Reorder; description line misleading |
| strength-tracker-users-and-audit | Partly stale | "gaps roadmap PICK UP HERE ... read that first" is wrong: that plan is now marked do-not-execute; consolidated roadmap is the entry. Frontmatter modified 9-04 but body has 9-24 fact. coach-eval "never run": unverified |
| strength-tracker-mcp-oauth | Mostly true | "follow-up: set_training_plan has no confirm_change gate" is done (training_plan.ts has it) and AGENTS.md documents it |
| precommit-hook-blocks-all-bash | Unverified, plausible | references desktop-commander; hook behavior not checkable from repo |
| subagent-model-choice | True/current | preference |
| app-adapts-to-lifter | True | not indexed in MEMORY.md |

## Instruction consistency
AGENTS.md / CLAUDE.md / copilot-instructions.md: consistent, single source. Global CLAUDE.md: no conflict on README rule; global rule "Notion is system of record for tasks" vs repo using GitHub issues and ledger is scoped to different domains, no contradiction. Duplication: the roadmap "Current status", ledger header and AGENTS.md all restate phase state (CONTENT-002/007).
