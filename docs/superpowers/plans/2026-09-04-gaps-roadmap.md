# Gaps roadmap, September 2026

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks here are sized as one PR each; expand a task into write-failing-test / run / implement / run / commit steps at execution time using the file map and interfaces given. Every task ends with the preflight in "Global constraints".

**Goal:** Close the gaps found in the 2026-09-04 audit (production data, Sentry, four code audits, market research) so the app is something a coached lifter opens every session and a coach trusts as the record.

**Architecture:** Nothing here changes the write-ownership model. Sets stay append-only, the PWA stays the only writer of training, derived metrics stay in SQL views, the coach and MCP keep one authorization boundary. New capture is new nullable columns on tables the PWA already owns, plus views that read `v_live_sets`.

**Tech Stack:** Supabase Postgres (migrations, RLS, security_invoker views), Deno edge functions (MCP server, coach), React + Vite PWA with IndexedDB outbox, vitest.

---

> **The ORDER and the DECISIONS now live in
> [2026-09-04-sequenced-plan.md](2026-09-04-sequenced-plan.md)** — waves, day
> estimates, and the settled calls on model, per-set RPE and tap-to-approve.
> This file keeps the task-level detail: exact files, interfaces, constraints.
> Where the two disagree about sequence, the sequenced plan wins.

## PICK UP HERE (last worked 2026-09-04)

### Done and committed

- **Correcting a logged set while the workout is running.** Tap a logged set,
  its numbers move into the steppers, SAVE writes a replacement at the same
  `set_index` / `performed_at` / rest / prescription and voids the old row.
  `pwa/src/lib/corrections.ts`, wired in `Session.tsx` and `SetRow.tsx`.
  Verified in the demo; 390 tests pass. Written up in `decisions.md` and
  `CLAUDE.md`. **Not deployed** — the PWA ships from a Pages build on push.
- **This roadmap**, including the two addenda (Valentine's transcript; the
  coach architecture decisions on model, cost, triggers).
- **The coach eval harness**, `scripts/coach-eval/`. Real MCP server against a
  PGlite-backed PostgREST, Valentine's 13 real turns plus 6 synthesized cases,
  end-state checks, an optional Opus judge, a report builder. Two drivers: the
  API one (`run.mjs`) and a **subagent** one (`serve.mjs` + `agent-case.mjs`)
  that needs no API key. See its README.
- **Eval run 1, seven cases, subagent driver** —
  [2026-09-04-coach-eval-run1.md](2026-09-04-coach-eval-run1.md). It settled
  what is structural and what is judgment, and turned up one gap the audit
  missed. Summary:
  - The **program clone is structural**. `upsert_program` cannot touch a
    confirmed program, so adding a day to her plan leaves two live programs no
    matter which model runs. Task 3.3's `update_planned_workout` is the only
    fix.
  - **An empty planned day cannot survive a rewrite** (`minItems: 1` on
    prescriptions). One subagent silently dropped her blank day; another
    refused to do a simple exercise swap rather than destroy it. New finding.
  - The **`remember` misses are the prompt, not Sonnet**. A capable model with
    the same prompt skipped it on both of the clearest cues.
  - **Per-hand loads, injection defence and the no-invented-training rule all
    work** through the coach. The half-weight bug is PWA-only, so Task 0.9 is
    correctly scoped.

### The one thing blocking the next step

The eval has **never been run against the production model configuration**.
This machine has no Anthropic API key, so run 1 used subagents, which cannot
answer the model question (different harness, no `effort` control). To settle
that:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > scripts/coach-eval/.env
cd scripts/coach-eval && node run.mjs --smoke            # free, confirms the stack
node run.mjs --configs sonnet-low,opus-medium --trials 1 --out out/run1   # ~$2
node report.mjs --out out/run1
```

PostgREST is not vendored; `.bin/` (gitignored) holds it plus the libpq and
krb5 bottles, and `stack.mjs` finds them automatically. The README documents
the normal `brew install libpq krb5` path too. Note that installing libpq
through Homebrew on 2026-09-04 made it try to rebuild llvm, rust and go, which
is why the bottle-only route exists.

Read `out/run1/report.md`, then the failing traces. The decision it exists to
settle: **stay on `sonnet-low`, move to `sonnet-medium`, or move the
conversation loop to `opus-medium`** (Task C.2 below). Do not change the model
in `supabase/functions/coach/index.ts:487` without that report.

**But do not wait on it for the plan work.** Run 1 already showed the two worst
bugs are unaffected by model choice.

### Then, in order

Sequence, day estimates and the settled decisions are in
[2026-09-04-sequenced-plan.md](2026-09-04-sequenced-plan.md). In short: Wave 0
is `update_planned_workout` plus the plan editor's `load_entry` plus repairing
Valentine's data (about 3 days); Wave 1 is the offline and identity fixes that
keep a logged set from being lost; then server hygiene, the set loop, the
coach, capture, and the second user. About 27 days in total, shippable a wave
at a time.

The model question is decided there too: **Opus 5 at effort `low`**, with the
API eval kept as a cheap verification rather than a precondition.

### Loose ends worth knowing

- **Sentry JAVASCRIPT-REACT-3** is still open and is stale. The `set_type`
  column is on production; the error was the migration shipping after the code
  on 2026-08-31. Resolve it by hand — the API call was blocked in the session
  that found it.
- **Valentine's two "My plan" programs.** The coach cloned rather than edited,
  so program `2be86b2a` (four days: a blank 2026-08-30, PUSH 08-31, LEGS 09-01,
  an empty PULL 09-03) is still live and reads MISSED on her calendar. Her
  logged sessions all belong to `05ca5888`. Cleanup is a soft delete of the
  older program, and it is her data: ask before running it.
- **Her dumbbell loads are stored at half.** Every `prescriptions.load_kg` on a
  dumbbell movement was typed per hand and stored as a total with no
  `load_entry`. Task 0.9 fixes the editor; the one-off repair of her existing
  rows needs her say-so first.
- **27 expired coach tokens** in `mcp_tokens`, never pruned (Task 0.8).

---

## Global constraints (from CLAUDE.md and deploy.md)

- `sets`, `sessions`, `set_voids`, `set_notes` are written ONLY by the PWA. MCP tools never write them.
- `sets` is append-only. Corrections are voids (plus a re-insert at the same index, see `pwa/src/lib/corrections.ts`). Never add an update or delete policy.
- Derived metrics live in SQL views only. Views are `security_invoker` and read `v_live_sets`, never `sets`.
- Units are kg in the database. `load_kg` is ALWAYS the total system load.
- The MCP server has no `auth.uid()`; every tool filters and stamps `db.ownerId`. Never cache anything user-derived at module scope.
- Migrations are append-only once deployed. Push the migration BEFORE the code that writes the column.
- IndexedDB version bumps are additive. Service worker stays `registerType: "prompt"`.
- Settings are device-local; a `user_settings` table needs a decision entry.
- Text colours clear WCAG AA; the accent is not for body copy. One stylesheet, tokens only.
- Every task's preflight: `node scripts/validate-db.mjs && node scripts/check-selects.mjs && (cd supabase/functions/mcp-server && deno check index.ts) && (cd pwa && npm run build && npm test -- --run)`.
- Every deviation from spec.md gets an entry in `docs/decisions.md`.

---

## What the audit found

### Production (2026-09-04)

- Two users with live sets. The owner: 13 sets, Aug 24 to 28 (smoke tests). Valentine: 41 sets in 3 completed sessions, Sep 1 to 3 (PUSH, LEGS, PULL), every set linked to a prescription, zero voids, 2 set notes, no sRPE, no bodyweight, 13 coach turns.
- Valentine built her own program THROUGH the in-app coach ("your PULL day is currently empty... writing the PULL day now"). She is not pasting a human coach's screenshot. The product has a second persona: self-coached lifter using Claude as the coach.
- She trains with dumbbells in lb (18.14 kg = 40 lb) and logs some sets after the fact (walking lunge set 2 logged 8 s after the prior set).
- Her one session note is an exercise substitution: "Had to switch tricep cable with dumbbell overhead extension". The sets were logged under the planned exercise. There is no substitution feature.
- 27 expired per-turn coach tokens sit in `mcp_tokens`, never pruned.
- Edge function gateway: zero 4xx/5xx in 7 days. Postgres and function log endpoints returned a backend error from Supabase analytics; retry later.

### Sentry

One issue, JAVASCRIPT-REACT-3, the owner's phone, Aug 31: `set_type` column missing (migration shipped after the code). Column confirmed present on production now. Resolve it in Sentry by hand; the API call was blocked in the auto-mode session.

### Code audits (four subagents, claims spot-checked)

Verified in code: prescribed warmup brackets are never read by the session screen; the rest timer uses `new Notification`, which iOS PWAs do not support; `coach_usage` insert errors are never checked (supabase-js does not throw); `programs_delete` and `pw_delete` RLS policies still exist; sign-up is open; End-screen note chips hardcode "Left shoulder"; overnight auto-discard consults only this device's outbox; Today captures the calendar day once at mount.

Plausible, verify at execution: offline open with an expired JWT lands on Login (auth-js returns `session: null` on a network failure rather than throwing); the outbox's "refresh unreachable" branch is dead for the same reason.

### Market research (what lifters and coaches look for)

Ranked by frequency: fast 2 to 3 tap set entry with last time visible; offline-first with no lost sets; RPE/RIR per set; %TM auto-load; a rest timer that gets attention through a locked phone; supersets and ramps modelled; free CSV export; deviating from the plan without fighting the UI. Abandonment: crashes mid-workout, paywall bait, entry effort exceeding payoff, stagnation, auto-programming that misjudges the lifter. What makes a COACHED app different: the prescription is the unit (per-set compliance, not a workout tick); notes and video attached to the set; the coach sees the whole calendar.

This repo already has the hard parts: offline outbox, %TM, ramps and supersets as adjacency, `v_adherence`, free export. What it lacks is the attention layer (timer, PRs, weekly feel), per-set qualitative capture, and the second-user path.

---

## Product thesis

The app is useful when three loops close every week:

1. **The set loop** (seconds): see the target and last time, lift, two taps, rest gets your attention, next set is already staged. Anything that adds a tap or a keyboard here loses.
2. **The session loop** (an hour): deviate without friction (swap, skip, add, do a different planned day), say how it felt in one tap, finish with sRPE and bodyweight without hunting for them.
3. **The week loop** (days): see that something moved (a PR, tonnage, adherence), and have the coach, human or Claude, read the same record you see.

Phases below are ordered by loop and by risk to the record. Phase 0 is about not losing or misfiling sets, which is the abandonment reason no feature outruns.

---

## Phase 0: never lose or misfile a set (this week)

### Task 0.1: Offline open keeps you signed in

**Files:**

- Modify: `pwa/src/hooks/useAuth.ts:27-34`
- Modify: `pwa/src/lib/currentUser.ts:27-32`
- Modify: `pwa/src/lib/sync.ts:26-50`
- Modify: `pwa/src/lib/outbox.ts:263-322`
- Test: `pwa/src/lib/outbox.test.ts`, new `pwa/src/lib/currentUser.test.ts`

**Interfaces:**

- Produces: `readPersistedUserId(): string | null` in `currentUser.ts`, reading the `sb-<ref>-auth-token` localStorage entry's `user.id`. `refreshAuth()` in `sync.ts` returns `true` (session), `false` (definitively signed out) or THROWS on a retryable network error (`isAuthRetryableFetchError` from `@supabase/supabase-js`).

- [ ] Reproduce first: in the demo, set the stored token's `expires_at` to the past, go offline in devtools, reload. Expect Login. This is the failing case.
- [ ] `useAuth`: when `getSession()` yields `session: null` AND a retryable error, treat the persisted user as signed in for the shell. Only a non-retryable failure (auth-js emits `SIGNED_OUT`) shows Login.
- [ ] `currentUser.getCurrentUserId()`: same fallback, so the outbox can stamp writes. The hold-if-unknown rule stays for a genuinely unknown identity.
- [ ] `sync.refreshAuth`: throw on retryable error so `outbox.ts:277-281` ("unreachable means retry") is reachable against the real transport. Before `applyOp`, if there is no user session and the last error was retryable, return early with state `"error"` and keep the item pending, so an insert is never sent with the anon key (which 42501s and dead-letters).
- [ ] Tests: outbox test asserting a retryable refresh keeps items pending and does not consume `authRefreshTried`; currentUser test for the persisted fallback.
- [ ] Decision entry: "Identity for the device comes from the persisted session when the refresh is unreachable; authorization still comes from the server."

### Task 0.2: Overnight reconciliation never discards a session another device may still be uploading

**Files:**

- Modify: `pwa/src/lib/data.ts:1273-1300` (`syncOpenSessions`)
- Test: `pwa/src/lib/openSessions.test.ts`

- [ ] Pass "started on this device" (the cached `activeSession.id`) into `syncOpenSessions`. Auto-COMPLETE stays cross-device (late sets still belong to the session). Auto-DISCARD only for the device's own session; a foreign empty session is left open and surfaces in the existing orphan card on Today.
- [ ] Test: two-device scenario from the audit (A logs offline, B opens next morning) leaves the session open.

### Task 0.3: Today knows when midnight passed

**Files:**

- Create: `pwa/src/hooks/useLocalToday.ts`
- Modify: `pwa/src/screens/Today.tsx:133,240` and the mount effect that runs `syncOpenSessions`
- Test: `pwa/src/hooks/useLocalToday.test.ts`

**Interfaces:**

- Produces: `useLocalToday(): string` (ISO date), re-rendering on `visibilitychange` to visible, on `online`, and on a timer armed for the next local midnight.

- [ ] Replace `todayLocalIso()` reads in render with the hook. When the day changes, re-seed `selectedDate` and re-run the reconciliation block.
- [ ] Test with fake timers: mount at 23:59, advance past midnight, hook value changes.

### Task 0.4: History does not resurrect a removed set

**Files:**

- Modify: `pwa/src/screens/History.tsx:208-246`
- Modify: `pwa/src/lib/outbox.ts` (add `pendingVoidIds(): Promise<Set<string>>`, twin of `pendingSessionUpdateIds`)
- Test: `pwa/src/lib/outbox.test.ts`

- [ ] `voidPastSet` and `discardSession`: `await outbox.flush()` before bumping `reloadTick`, and filter the refetched list against `pendingVoidIds()` and pending discards so an offline-then-online reload also stays honest.

### Task 0.5: Prescribed warmups are real in the session

**Files:**

- Modify: `pwa/src/lib/entries.ts:104-120` (`totalSets`, `bracketFor`)
- Modify: `pwa/src/screens/Session.tsx` prefill (`setSetType("working")` at the prefill effect and after `logSet`)
- Modify: `pwa/src/lib/format.ts:54-67` (`formatRxTarget`)
- Test: `pwa/src/lib/entries.test.ts`, `pwa/src/lib/format.test.ts`

**Interfaces:**

- `totalSets(entry)` counts WORKING brackets only; new `warmupSets(entry)` for the label. `bracketFor(entry, workingDone, warmupDone)` walks warmup brackets by warmup count and working brackets by working count.

- [ ] Prefill `setType` from `currentBracket.set_type`. A day of "1×12 @10 warmup, 3×8 @20" reads "LOG WARMUP SET 1 OF 1" then "LOG SET 1 OF 3"; the entry is done at 3 working sets whether or not the warmup was ticked.
- [ ] `formatRxTarget` suffixes "W" on warmup brackets so Today and the TARGET line show the shape the coach wrote.
- [ ] Tests for the bracket walk with mixed types and for the label.

### Task 0.6: Correction round-trip tolerance

**Files:**

- Modify: `pwa/src/lib/corrections.ts:40-46`
- Test: `pwa/src/lib/corrections.test.ts`

- [ ] `isNoopCorrection` compares `load_kg` within 0.01 kg. Reproduction from the audit: lb mode, per-side, 1 lb step lands on 3.175 kg/side, stored 6.35, re-entered 3.18 × 2 = 6.36, currently writes a spurious void + insert.

### Task 0.7: Rest clock mirror and bootstrap failures

**Files:**

- Modify: `pwa/src/screens/Session.tsx` (`logSet`, `voidSet`, bootstrap `Promise.all`)

- [ ] Write the rest cache from `logSet` and `voidSet` directly (today the mirror effect keys on `rest` state, which does not change when auto-start is off, so a reload rehydrates a stale `startedAt` and records a wrong `rest_seconds_actual`, permanently).
- [ ] If any bootstrap `cacheGet` throws, keep the LOG button disabled and show the error, instead of flipping `setsLoaded` with an empty `setsRef` (which would log `set_index` 0 on an exercise that already has sets).
- [ ] Replace `.catch(() => undefined)` on the session-sets, set-notes and rest mirrors with `reportError`.

### Task 0.8: Server-side hygiene

**Files:**

- Create: `supabase/migrations/20260905000000_drop_plan_hard_delete.sql`
- Modify: `supabase/functions/coach/index.ts:339-366` (usage insert), `:135-155` (token mint), `:392-398` (long turns), `:498` (unit)
- Test: `node scripts/validate-db.mjs`; coach tests if present, otherwise `deno check`

- [ ] Migration: `drop policy programs_delete on programs; drop policy pw_delete on planned_workouts;` (soft delete is the only path since 20260831060000 and 20260901030000; the PWA hard-deletes single prescriptions only, which the trigger covers). Also `drop policy exercise_owners_delete` (an owner deleting their own row makes a custom exercise readable by nobody).
- [ ] `record()`: read `.error` from the insert; validate `turn_id` as a UUID BEFORE the turn starts and refuse the turn (400) if the usage row cannot be written. Otherwise the daily and monthly caps count zero and the owner's Anthropic key is billed without bound.
- [ ] Revoke the per-turn token in `finally` after `record()` (`revoked_at = now()`), and add a weekly prune: `delete from mcp_tokens where expires_at < now() - interval '7 days'` via `pg_cron` or a scheduled edge function. 27 expired rows today.
- [ ] Return 413 with a message when a turn exceeds 20,000 chars instead of silently dropping it. Whitelist `unit` to `kg | lb`.

---

## Phase 1: the set loop (next two weeks)

### Task 1.1: A rest timer that gets attention on an iPhone

**Files:**

- Create: `pwa/src/hooks/useWakeLock.ts`, `pwa/src/lib/restCue.ts`
- Modify: `pwa/src/components/RestTimer.tsx:68-90`, `pwa/src/screens/Session.tsx` (mount wake lock), `pwa/src/components/SettingsSheet.tsx:155-165`
- Test: `pwa/src/lib/restCue.test.ts`

- [ ] `navigator.wakeLock.request("screen")` while `/session` is mounted; re-acquire on `visibilitychange` to visible. Best-effort, never awaited on the boot path.
- [ ] `restCue`: an `AudioContext` unlocked on the LOG tap (iOS requires a gesture), a short beep at zero. Setting: sound on/off, default on.
- [ ] Keep `new Notification` for desktop browsers only; the "Rest alerts" settings row says plainly that iOS cannot notify from a web app.
- [ ] Decision entry: wake lock over background notifications, because iOS web apps have no background execution.

### Task 1.2: Supersets stop fighting the accordion

**Files:**

- Modify: `pwa/src/screens/Session.tsx` (`nextEntry`, log button block)
- Test: `pwa/src/lib/entries.test.ts` (`supersetPartner`)

**Interfaces:**

- Produces: `supersetPartner(entries, key, done): ExerciseEntry | null` in `entries.ts`, the next not-done member of the open entry's group, wrapping.

- [ ] After logging on a superset member, render "Next · partner" as the secondary button and start the rest strip only after the LAST partner in the round. The rest clock still MEASURES from every set (data), only the strip's appearance changes.

### Task 1.3: One-tap qualitative capture per set

**Files:**

- Modify: `pwa/src/screens/Session.tsx` (set note editor), `pwa/src/screens/End.tsx:39-44`
- Modify: `supabase/functions/coach/prompt.ts` (tell the coach the tokens)
- Test: `pwa/src/components/SetRow.test.tsx` or a new `NoteChips.test.tsx`

- [ ] Chips on the per-set note editor: `failed`, `grindy`, `easy`, `pain`. They write tokens into `set_notes` (no schema change; the coach already reads notes as "the only qualitative record").
- [ ] End chips built from `coach_memory` injury facts for THIS user plus the generic ones. "Left shoulder" is the owner's body and is wrong for Valentine.

### Task 1.4: "Last time" shows the run, not one set

**Files:**

- Modify: `pwa/src/lib/data.ts:1009-1040` (`scanLastActuals`), `pwa/src/screens/Session.tsx` (`lastTime`)
- Test: `pwa/src/lib/data.test.ts`

- [ ] `LastActuals[exercise]` keeps the last session's working sets (cap 6) so the microcopy reads "60 kg × 8, 8, 6", which is what the lifter and the coach both want to see at the rack.

### Task 1.5: Do any planned day now

**Files:**

- Modify: `pwa/src/screens/Today.tsx:709-717` (preview cards for UPCOMING and MISSED)

- [ ] "Do this workout now" on a non-today card calls the existing `start(w)` without touching `scheduled_date`. Done-state already follows `sessions.planned_workout_id`. Removes the "Move to today" rewrite for the common "I'm doing Wednesday on Tuesday" case.

### Task 1.6: Substitute an exercise mid-session

**Files:**

- Modify: `pwa/src/screens/Session.tsx` (exercise header menu), `pwa/src/lib/entries.ts`
- Modify: `pwa/src/lib/data.ts` (a `substitutions` cache per session, device-local like `extras`)
- Test: `pwa/src/lib/entries.test.ts`

- [ ] "Swap" on an open entry opens the existing picker; logged sets go against the CHOSEN exercise with the planned bracket's `prescription_id` kept, so `v_adherence` still credits the slot and History files the sets under what was actually lifted. Valentine's tricep swap was written as a session note because this did not exist.
- [ ] Decision entry: substitution keeps `prescription_id` (adherence is about the slot) and changes `exercise_id` (history is about the movement).

---

## Phase 2: capture the coach asks about (schema, one migration)

### Task 2.1: Per-set RPE, optional, one tap

spec.md lists "RIR or per-set subjective ratings" as a non-goal. Research puts RPE/RIR per set third among must-haves and it is what a coach autoregulates on. Recommendation: reverse the non-goal with a decision entry, and keep it optional and one-tap so it never costs the set loop.

**Files:**

- Create: `supabase/migrations/20260906000000_set_rpe.sql`: `alter table sets add column rpe numeric(3,1) check (rpe between 5 and 10);` (nullable; below 5 is noise), and `v_live_sets` re-created to carry it.
- Modify: `pwa/src/lib/types.ts` (`SetInsert.rpe?: number | null`), `pwa/src/screens/Session.tsx` (a 6.5 to 10 chip row under the steppers, hidden until tapped once per exercise), `pwa/src/lib/corrections.ts` (correction carries rpe), MCP `get_lift_history` and `get_recent_sessions` column lists, `scripts/check-selects.mjs` fixtures.
- Test: `pwa/src/lib/corrections.test.ts`, MCP tool tests.

- [ ] Push the migration BEFORE the PWA build that writes the column (deploy.md snag).
- [ ] A set logged without RPE stays null; nothing downstream requires it.

### Task 2.2: Bodyweight without a session

**Files:**

- Create: `supabase/migrations/20260906010000_bodyweight_log.sql`: table `bodyweight_log (id uuid pk, user_id, measured_at timestamptz, weight_kg numeric(5,2) check (> 0))`, RLS insert+select owner, view `v_bodyweight` unioning it with `sessions.bodyweight_kg`.
- Modify: `pwa/src/screens/Today.tsx` (a one-line "Bodyweight" row with the existing stepper + pad), `pwa/src/lib/outbox.ts` (table union), `supabase/functions/mcp-server/tools/get_bodyweight_trend.ts` (new).

- [ ] Client-generated UUID, `on conflict do nothing`, queued through the outbox like a set.
- [ ] `get_bodyweight_trend(days)` returns the series plus 7-day mean; the coach context block gets the latest value.

### Task 2.3: Duration-tracked work

**Files:**

- Create: `supabase/migrations/20260906020000_tracking_time.sql`: extend the `prescriptions.tracking` check to `('reps','done','time')`.
- Modify: `pwa/src/screens/Session.tsx` (a seconds stepper for `time`; `reps` stores seconds, `load_kg` the added load), `pwa/src/lib/format.ts`, plan editor scheme sheet.

- [ ] Planks and carries stop being ticks. Decision entry: reps-as-seconds for `time` rows, because a second numeric column would need every view to branch.

### Task 2.4: sRPE and bodyweight are reachable from Home

**Files:**

- Modify: `pwa/src/screens/Today.tsx` (the completed-session card), `pwa/src/screens/End.tsx:213-225`

- [ ] A finished session with null `session_rpe` shows "How hard was it?" on Today's card for 24 h, writing through the existing `sessions` update op. Valentine has three sessions with no sRPE because End is only seen when you tap Finish.
- [ ] Persist the End draft on change (debounced) and on `visibilitychange` to hidden, not only on unmount, which WebKit skips on eviction.

---

## Phase 3: the week loop (feedback the lifter and coach both see)

### Task 3.1: PR feedback at the log tap

**Files:**

- Modify: `pwa/src/lib/data.ts:1009` (carry per-exercise best e1RM and best reps-at-load in `LastActuals`), `pwa/src/screens/Session.tsx` (`logSet`), `pwa/src/components/charts/E1rmChart.tsx` (dot the max)
- Test: `pwa/src/lib/e1rm.test.ts` (a pure `isPr(best, set)`)

- [ ] Working sets, 1 to 8 reps, e1RM above the all-time best: toast "New e1RM best · 120 kg". Rep PR at the same load counts too. `v_goal_progress` already computes `alltime_best_e1rm_kg`; reuse the formula in `e1rm.ts`.

### Task 3.2: Sessions view and weekly totals in History

**Files:**

- Modify: `pwa/src/screens/History.tsx` (a SESSIONS section: date, label, duration, sets, sRPE, expanding to the day's sets using `getSessionMeta` / `getServerSessionSets`)
- Create: `supabase/migrations/20260907000000_v_weekly_summary.sql`: view over `v_live_sets` plus sessions: sessions count, working sets, tonnage, adherence rate per user per week.
- Modify: `supabase/functions/mcp-server/tools/get_week_summary.ts` (new), coach context block (last week's line).

- [ ] "What did I do Tuesday" and "how many working sets this week" become one screen and one tool. `get_volume` also gets a `since` predicate on `performed_at` so it stops aggregating the whole history every call.

### Task 3.3: MCP tools the coach is missing

**Files:**

- Modify: `supabase/functions/mcp-server/tools/get_program.ts:86-92` (add `program_id`, add `list_programs`)
- Modify: `supabase/functions/mcp-server/tools/confirm_program.ts:60-65` (discarded program is not "already confirmed")
- Modify: `supabase/functions/mcp-server/tools/upsert_program.ts:119,154,165-181` (`assertIsoDate`, length caps on `notes`/`label`/`name`, superset groups need two members)
- Modify: `supabase/functions/mcp-server/tools/feedback.ts:156` (`ToolError`, not `Error`)
- Create: `update_planned_workout` (add or edit one day's prescriptions without a wholesale `upsert_program`), `get_prs`, `search_set_notes`
- Test: the tool test files beside each

- [ ] Two live confirmed programs are normal now (the PWA creates its own); `get_program` returning only the newest is how the coach rewrote from the wrong baseline.

---

## Phase 4: the second user, and running it

### Task 4.1: First run

**Files:**

- Modify: `pwa/src/screens/Today.tsx:1142-1168` (empty state), `pwa/src/screens/Login.tsx:107-128` (Resend), `pwa/src/lib/settings.ts:259-270` (unit)
- Modify: `supabase/functions/coach/index.ts:193` (owner name from `COACH_OWNER_NAME` env, not "Colt")

- [ ] A dismissable card on Today when there is no program: pick kg or lb, "tap the chat icon and paste your coach's program, or ask it to write one", and one line that coach chats are logged for the deployment owner (`COACH_LOG_CONTENT`). Valentine's first minute today is "No confirmed programs yet" with nothing pointing at the coach.
- [ ] Resend code button on Login (an expired code currently forces "Use a different email").

### Task 4.2: Close sign-up

**Files:**

- Modify: `docs/setup.md:186-192`, `supabase/functions/coach/index.ts:157-195` (allowlist check)

- [ ] Disable sign-ups in Supabase Auth and pre-create users, or gate the coach on an `allowed_users` table. Open sign-up plus a per-user coach quota means anyone with the public URL gets 150 turns a day on the owner's key.

### Task 4.3: The outbox is visible on the phone

**Files:**

- Modify: `pwa/src/components/SettingsSheet.tsx` (an OUTBOX row listing dead items: exercise, load × reps, `last_error`, with Retry and Export), `pwa/src/components/SyncStatus.tsx:16-24` (no `title`-only errors), sign-out copy (`:365-373` says "discards", the button says "kept")
- Modify: plan editor and TM save buttons gated on `useOnline`

### Task 4.4: Errors from the edge functions reach Sentry

**Files:**

- Modify: `supabase/functions/mcp-server/index.ts`, `supabase/functions/coach/index.ts` (Sentry Deno SDK, DSN from a Supabase secret, `captureException` in the top-level handlers; structured JSON logs stay)

- [ ] Today the only Sentry project is the PWA. Coach and MCP failures are invisible unless someone queries Supabase analytics, which returned a backend error during this audit.

### Task 4.5: Coach hardening

**Files:**

- Modify: `supabase/functions/coach/index.ts:525-528` (disable `update_exercise` for the coach), `:199-286` (validate attachment `kind`/`media_type`/`data` types, reject attachments on assistant turns), `:411-418` (quota check inside the turn's usage insert, and count cache tokens in the monthly formula)
- Create: `supabase/migrations/20260907010000_exercise_name_limits.sql`: `check (length(name) <= 80)` and a plain-text character class on `exercises.name`; `updated_at`/`updated_by` columns.

- [ ] A renamed seeded exercise flows into every other user's model context via `search_exercises`, `get_program`, and the PWA context block. Length and character limits bound the blast radius; the coach should not be able to rename shared rows at all.

---

## Explicitly not doing

- Social features, badges, streaks (rejected in decisions.md; the research confirms they are not why coached lifters stay).
- Video attached to sets. Real coach want, but storage and playback on a PWA is a separate project; notes and RPE first.
- Cross-device settings. Accepted in CLAUDE.md.
- Background rest notifications on iOS. Not possible from a web app; wake lock and sound are the honest version.
- A native app. The PWA's offline story is the product; the timer is the only thing a native app would do better.

---

## Findings index (raw, for execution)

PWA bugs (ranked): offline open with expired token shows Login; transient refresh dead-letters the queue and the anon-key insert 42501s; cross-device auto-discard; History void resurrection; Today's day captured at mount; rest cache not mirrored when auto-start is off; End draft and staged values lost on eviction; correction round-trip rounding; in-flight read cached for the wrong user after a user switch; multi-statement plan writes not atomic under the 8 s timeout; swallowed cache errors and a bootstrap that logs index 0 on failure.

MCP and coach (ranked): usage insert error unchecked (quota bypass); shared exercise rename is a cross-user injection surface; `programs_delete`/`pw_delete` policies still exist; long turns silently dropped; `unit` unvalidated in the system prompt; attachment schema unvalidated; `resolve_feedback` throws `Error`; `confirm_program` misreports a discarded program; `get_program` only returns the newest; `upsert_program` date and length gaps; `search_exercises` quote handling; module-scope tz cache (documented); per-turn tokens outlive the turn; non-atomic quota; `exercise_owners_delete` policy; `set_voids`/`set_notes` lack a `user_id` index; `get_volume` cannot use an index.

Product gaps (ranked): warmup brackets half-wired; rest timer cannot get attention on iOS; supersets fight the accordion; a session is welded to today's planned day; qualitative capture is free text and the chips are the owner's body; no PR feedback; no session view or cross-lift volume; Valentine's first minute; open sign-up; dead-letter recovery blind on the phone; "last time" is one set; duration and weighted-bodyweight work.

---

## Addendum: Valentine's coach transcript (13 turns, 2026-08-31)

What actually happened, in order: she asked the coach to design her LEGS supersets (three turns, then edited the day herself in the plan editor); asked for a PULL day; rejected the pullover four times before saying she wants to do a pull-up; approved the PULL layout with "Yes"; the coach wrote it; she typed "Confirm". Issues, ranked:

1. **The coach cloned her program instead of editing it.** Her app-authored "My plan" was confirmed, and `upsert_program` only replaces UNCONFIRMED same-name programs, so the coach wrote a second confirmed "My plan" with PUSH and LEGS copied and re-dated. Her original days (Aug 31 PUSH, Sep 1 LEGS, an empty Sep 3 PULL, and a blank Aug 30 day) are still live and read MISSED on her calendar. Fix: Task 3.3's `update_planned_workout` and a `program_id` on `upsert_program`, plus prompt guidance to edit the day, never re-write the program. Cleanup for her: soft-discard program `2be86b2a` after she agrees.
2. **Every dumbbell prescription prefills at half the weight.** The plan editor never writes `prescriptions.load_entry`, so her "20" (per hand) is stored as a 20 lb TOTAL; the session resolves dumbbells as per-side and shows 10 lb/side. Her first Dumbbell Bench set is 40 lb total with 20/side typed by hand. Fix: the scheme sheet applies `resolveLoadEntry` and stores `load_entry`, same as the session does. Add to Phase 0 as Task 0.9.
3. **The coach saved nothing to memory and set no goal.** She said: no calf raises, no RDL twice, a dumbbell on the hips is uncomfortable, wants a pull-up, sometimes has an assisted pull-up or lat pulldown machine. `coach_memory` and `goals` are both empty. Fix: prompt wording ("when they say 'I don't like' or 'I can't', call remember in that turn"), and a test turn in the coach eval that expects a `remember` call.
4. **Four rounds of alternatives before asking why.** The coach listed rows three times before asking what was wrong with the pullover; the answer (a pull-up goal) reshaped the day. Prompt: after one rejected alternative, ask what they are avoiding before offering another.
5. **"Yes" then "Confirm" is one turn too many for a self-coached user.** Her "Yes" was approval of exact content. Proposal for a decision entry: when the approving message precedes the write, confirm in the same turn; keep the two-step for parsed screenshots.
6. **Latency.** 9 to 18 s for answers with no tools; 37 s for the write turn (six sequential `search_exercises`, then two `upsert_program` calls). Fix: a batch `resolve_exercises(names[])` tool; investigate why the first upsert failed.
7. **Assisted pull-up load is ambiguous.** She logged 45 lb with the note "10*50"; the number is machine assistance, not load lifted, and e1RM/volume read it as lifted. Needs a decision: an `assisted` movement hint where the load is negative for analytics and shown as "−45 lb".
8. **Substitution written as prose twice** (set note and session note). Task 1.6.
9. **A blank planned day counts as missed.** The empty "Workout 1" on Aug 30 sits as MISSED forever. Today should treat a day with no prescriptions as a draft, not a miss.

### Task 0.9: The plan editor stores how a load was entered

**Files:**

- Modify: `pwa/src/components/SetSchemeSheet.tsx`, `pwa/src/screens/Plan.tsx` (wherever `load_kg` is built for a prescription), `pwa/src/lib/data.ts:560` (write `load_entry`)
- Test: `pwa/src/components/SetSchemeSheet.test.ts`

- [ ] The sheet resolves `load_entry` with `resolveLoadEntry({ equipment, name, override })`, shows PER SIDE ×2 / TOTAL exactly as the session does, and stores the TOTAL in `load_kg` with `load_entry` set. Existing rows with null `load_entry` are left as they are (null means unknown).
- [ ] One-off repair for Valentine after confirming with her: her dumbbell rows were entered per hand, so `load_kg` doubles and `load_entry = 'per_side'` for rows on dumbbell exercises in both programs.

---

## Addendum: coach architecture (model, cost, quality, triggers)

Facts that reframe the question. The coach runs `claude-sonnet-5` at `output_config.effort: "low"` (`supabase/functions/coach/index.ts:487`), with the 24-tool MCP surface and a 1-hour cache TTL on the system prompt. Valentine's 13-turn session cost about $0.44 at Sonnet prices; 64% of her input tokens were cache reads. The same token profile on Opus 5 is about $1.09, on Fable 5.1 about $2.18, on Haiku 4.5 about $0.22. Two of her four failures were structural (no day-edit tool; typed two-step approval) and would have happened on any model. Two were judgment (never called `remember`; listed alternatives instead of asking why), which low effort suppresses and which a stronger model at medium effort is more likely to get right.

### Decisions

1. **Effort before model.** Move to `medium` first. Then move the conversation loop to `claude-opus-5` at `medium` and keep it there; Opus also supports mid-conversation system messages, which lets the per-turn context block travel as an operator message instead of user text (cache-friendlier, injection-safer). Fable 5.1 stays out until an eval shows the tail needs it.
2. **Pay for it with fewer turns, not cheaper tokens.** Proposal cards with tap-to-apply, a day-edit tool, the whole week in the context block on non-session days, and a batch `resolve_exercises` tool each remove a turn or a tool round trip. Her PULL day should be about five turns, not thirteen.
3. **Cache TTL to 5 minutes.** Her turns were one to two minutes apart; the 1-hour TTL doubles every cache write for a gap that never occurs inside a session and never survives the gap between sessions.
4. **Haiku for side jobs, Batch for anything nobody waits on.** Memory extraction after each turn; a two-line session debrief on `ended_at`; a Sunday brief. None of these touch the conversation loop.
5. **Rules where rules work.** PR detection, warmup ramps, plate math, missed-day and empty-day logic, adherence: SQL and TypeScript, no model. The research (JuggernautAI, Strava) is unanimous that set-level math belongs in code.
6. **No provider switch.** The coach's tool surface is the MCP connector. Open-weight models and other providers mean rebuilding the tool loop, and the number that matters for an agent that writes to a plan is the side-effect error rate, where small models are worst. Revisit above ~50 users.

### Task C.1: An eval built from her transcript

**Files:**

- Create: `scripts/coach-eval/cases.jsonl` (her 13 turns plus ~12 synthesized: substitution, per-hand load, a mid-session "drop the set" question, an injection attempt in a pasted screenshot)
- Create: `scripts/coach-eval/run.mjs` (replays a case against the coach function with a PGlite-backed MCP fixture, records `usage`, latency, tool calls, and end state)
- Create: `scripts/coach-eval/grade.mjs` (programmatic end-state checks + an Opus-as-judge rubric with structured output)

- [ ] End-state checks: edited the existing program rather than creating one; called `remember` when the turn contained a standing fact; dumbbell loads stored doubled with `load_entry = 'per_side'`; never confirmed in the same turn as the write; no invented numbers (every number in the answer appears in context or a tool result).
- [ ] Judge rubric (concrete claims): asked what the lifter is avoiding before a second alternative; answer fits a phone screen; led with the action.
- [ ] Configs: Sonnet low (baseline), Sonnet medium, Opus low, Opus medium, Fable low. Three trials each. Report pass rate, cost per completed task, p50/p90 latency. Estimated spend: $40 to $80. Approve before running.

### Task C.2: Effort, TTL, context block

**Files:** `supabase/functions/coach/index.ts:487, 503`, `pwa/src/lib/coachContext.ts`

- [ ] `effort: "medium"`; cache TTL 5 minutes; on non-session days include the full week's plan and the last session's sets in the context block.

### Task C.3: Proposal cards and tap-to-apply

**Files:** `supabase/functions/coach/index.ts` (a `propose_workout_day` tool whose result is rendered, not applied), `pwa/src/components/CoachSheet.tsx` (card renderer with Apply / Change / Not this), `supabase/functions/mcp-server/tools/update_planned_workout.ts` (new)

- [ ] The coach proposes; the card applies through the PWA's own plan-writing path, so the approval rule is a tap and the write is the user's. Set-level tweaks the coach may apply directly with an Undo toast; day and program changes always propose (the reversibility split every product in the research uses).

### Task C.4: Background jobs

**Files:** `supabase/functions/coach-jobs/index.ts` (new; Haiku 4.5), `supabase/migrations/20260908000000_coach_jobs.sql` (pg_cron + pg_net triggers)

- [ ] After each coach turn: extract standing facts from the USER text only, write with `remember`, return them so the chat shows "Remembered: …" chips the lifter can delete.
- [ ] On `sessions.ended_at`: a two-line debrief on Today's card (what moved, what to watch). Rules compute the PR and adherence facts; Haiku writes the sentence.
- [ ] Sunday: a week brief through the Batch API.
- [ ] Memory is viewable and deletable in Settings (the Oura pattern).
