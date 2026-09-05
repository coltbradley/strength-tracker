# Build plan, 2026-09-05 evening

Three workstreams, built in parallel in separate worktrees, merged by the
orchestrating session, tested on Colt's phone at the end. The design they
implement is [2026-09-05-plan-and-review-loop.md](2026-09-05-plan-and-review-loop.md)
(the plan layer and the loop) and the 6f entry in
[2026-09-04-sequenced-plan.md](2026-09-04-sequenced-plan.md) (rest alerts).

Every workstream: TypeScript strict, one stylesheet with tokens only, errors
never swallowed, tests beside the code, migrations append-only and numbered as
assigned below, `docs/decisions.md` entry for each deviation, commit messages
in the repo's voice (a sentence of title that says what changed for whom, a
body that says why and what was rejected). Run the gates before every commit:

```bash
node scripts/validate-db.mjs && node scripts/check-selects.mjs
cd pwa && npm ci && npm run typecheck && npx vitest run && npm run build
export PATH=/tmp:$PATH   # deno 2.9.6 is unpacked there
(cd supabase/functions/mcp-server && deno check index.ts)
(cd supabase/functions/coach && deno check index.ts)
```

Known constraint of this sandbox: `jsr.io` is blocked, so Deno tests that
import `jsr:@std/assert` cannot RUN here (they typecheck, and CI runs them).
npm is reachable. Prefer `npm:` or WebCrypto over `jsr:` in new function code.

## File ownership (no two workstreams touch the same file)

| Workstream | Owns |
| --- | --- |
| A · rest alerts | `supabase/migrations/20260905050000_push_alerts.sql`, `supabase/functions/push-alerts/**` (new), `pwa/vite.config.ts`, `pwa/src/sw.ts` (new), `pwa/src/main.tsx`, `pwa/src/lib/push.ts` (new, + test), the Settings component that owns the rest-alert copy (find it: `grep -rn getRestSound pwa/src`), `pwa/src/screens/Session.tsx`, `pwa/src/components/RestTimer.tsx` if needed |
| B · plan layer | `supabase/migrations/20260905060000_training_plans.sql`, `supabase/functions/mcp-server/tools/training_plan.ts` (new), `tools/get_program.ts`, `tools/upsert_program.ts` (phase filing only), `supabase/functions/coach/index.ts` (connector `configs` only), `pwa/src/lib/coachContext.ts`, `pwa/src/lib/db.ts` + `db.test.ts` (one cache key), `pwa/src/lib/data.ts` (one read) |
| C · the loop | `supabase/functions/mcp-server/tools/find_similar_days.ts` (new), `tools/repeat_planned_workout.ts` (new), `lib/prescriptions.ts` (%TM rule) + its test, `pwa/src/screens/Today.tsx`, `pwa/src/components/CoachSheet.tsx` (prefilled review turn) |
| SHARED, edit only your own clearly-labelled block | `supabase/functions/mcp-server/lib/handler.ts` (imports + register calls), `supabase/functions/coach/prompt.ts` (B adds a plan rule; C adds the prescription-note rule, the repeat flow and the review), `scripts/validate-db.mjs` (append a section headed with your workstream letter), `docs/decisions.md` (append), `docs/deploy.md` (A adds the push-alerts deploy line) |

## A · Rest alert while the app is closed (6f)

Goal: when a rest ends and the installed PWA is closed or suspended, the phone
shows "Rest over — Barbell Row set 3". iOS 16.4+ Home Screen web apps receive
Web Push through the service worker; nothing can schedule a local notification
from a closed page, so a SERVER sends at the deadline.

1. **Migration `20260905050000_push_alerts.sql`.**
   `push_subscriptions(id, user_id, endpoint unique, p256dh, auth, user_agent, created_at, revoked_at)`
   with RLS: owner select/insert/update (revoke) only.
   `push_config(id smallint primary key check (id = 1), vapid_public_key, vapid_private_jwk jsonb, created_at)`
   with RLS enabled and NO policies (the `mcp_tokens` pattern: service role only).
   `rest_alerts(id, user_id, fire_at, label, created_at, cancelled_at, sent_at, error)`
   owner-scoped RLS for select only; written by the function. Index on
   `(user_id, fire_at) where sent_at is null and cancelled_at is null`.
   validate-db checks: a user cannot read another's subscriptions; `push_config`
   is unreadable as `authenticated`.
2. **Edge function `push-alerts`** (`verify_jwt` true; caller is a Supabase
   session, resolve the user exactly as `coach/index.ts` `resolveUser` does).
   Routes by `req.url` pathname suffix: `GET /vapid-public-key`,
   `POST /subscribe`, `POST /unsubscribe`, `POST /schedule {fire_at, label}`,
   `POST /cancel {alert_id}`. VAPID keys are GENERATED LAZILY on first use with
   `crypto.subtle.generateKey(ECDSA P-256)` and stored in `push_config` by the
   service role, so no secret has to be set by hand and the private key never
   leaves Supabase. `schedule` cancels any other open alert for the user,
   inserts the row, responds `202 {alert_id}` immediately, then finishes in
   `EdgeRuntime.waitUntil(...)`: sleep until `fire_at`, re-read the row, send
   only if still uncancelled, stamp `sent_at` or `error`. Check the platform's
   wall-clock limit in the Supabase docs (Context7: `/supabase/supabase`) and
   REFUSE with a clear 422 for a `fire_at` beyond it minus 10 s, so the client
   knows no alert will come. Web Push encryption (RFC 8291 aes128gcm) and VAPID
   (RFC 8292, ES256 JWT) implemented with WebCrypto in `lib/webpush.ts`, pinned
   by a Deno test using RFC 8291 Appendix A's test vector; use an npm library
   only if `deno check` resolves it here AND it uses no Node-only crypto. On a
   410/404 from the push service, set `revoked_at` on the subscription.
   Structured JSON logs like the other functions; never log endpoint or keys.
3. **Service worker.** vite-plugin-pwa to `strategies: "injectManifest"`,
   `srcDir: "src"`, `filename: "sw.ts"`. `sw.ts` must reproduce EXACTLY what
   generateSW gave us: `precacheAndRoute(self.__WB_MANIFEST)`,
   `cleanupOutdatedCaches()`, `clientsClaim()`, the `index.html`
   NavigationRoute, NO runtime caching (cross-origin is never intercepted),
   `skipWaiting` ONLY on the `SKIP_WAITING` message (registerType stays
   "prompt"; read the comment block in CLAUDE.md on updates). Add `push` →
   `showNotification(title, {body, tag: "rest", renotify: true, data})` and
   `notificationclick` → focus an existing client or open `/`. Verify the
   built `dist/sw.js` still precaches the same entry count as before (11).
4. **Client `lib/push.ts`.** `pushSupported()`, `subscribeToRestAlerts()`
   (from a tap: `Notification.requestPermission`, `pushManager.subscribe`
   with the server's key, POST subscribe), `unsubscribe()`, `scheduleRestAlert
   (fireAt, label): Promise<string | null>`, `cancelRestAlert(id)`. All network
   calls best-effort with `timeoutFetch`, never awaited on the LOG path, errors
   through `reportSilently`. Offline: return null and do nothing.
5. **Settings.** Beside the existing rest-alert copy (which already separates
   permission from delivery, `d19178e`): a toggle "Alert me when the app is
   closed". Honest states: unsupported (not installed / no Push API), off,
   on, permission denied. Copy says photos-style plain truth: "Needs the app
   installed to the Home Screen."
6. **Session.** Where `setRest({...})` starts a rest: schedule an alert for
   `startedAt + targetSeconds*1000` if subscribed; on `−30/+30`, edit, DONE,
   the next LOG, and `setRest(null)`: cancel (and reschedule on adjust). Keep
   the alert id in component state; it does not need to survive a reload
   (the server fires regardless; a reload cannot cancel it, which is
   acceptable and should be said in a comment).
7. **Docs.** `deploy.md`: `supabase functions deploy push-alerts` (verify_jwt
   ON, like the coach). `decisions.md`: the entry from the design doc,
   updated with the wall-clock number you found and what happens above it.
   `security.md`: `push_config` joins the "RLS on, no policy, on purpose" list.

## B · The plan above the program

1. **Migration `20260905060000_training_plans.sql`** exactly as the design
   doc's tables: `training_plans` (one live per user: unique partial index on
   `(user_id) where superseded_at is null`; `confirmed_at` nullable like
   programs), `plan_phases` (ordered, dated, `exclude using gist (plan_id
   with =, daterange(starts_on, ends_on, '[]') with &&)` — needs
   `btree_gist`, create it), `programs.phase_id uuid references plan_phases`.
   RLS: owner read; owner insert/update on both plan tables (the PWA may show
   and later edit them); no delete policies. Soft-delete idiom is
   `superseded_at`. validate-db: overlap refused; a user cannot see another's
   plan; two live plans refused.
2. **MCP tools** in `tools/training_plan.ts`: `get_training_plan` (the live
   plan with phases and which phase is CURRENT by `todayIso(db)`),
   `set_training_plan` (writes a NEW plan row with phases, supersedes the old
   one, lands unconfirmed; validates dates with `assertIsoDate`, phases
   ordered and non-overlapping in code so the DB error is never the first
   thing the model sees; `exercise_id`s in `primary_exercise_ids` checked with
   `assertExercisesExist`), `confirm_training_plan`. Register in
   `handler.ts`. `upsert_program` gains optional `phase_id`; when a live
   confirmed program already exists for that phase, the write ADDS days to it
   (day_index continues from the max) instead of creating a program, and says
   so in the result. `get_program` / `list_programs` show `phase` name.
3. **Coach connector**: in `coach/index.ts` `configs`, disable
   `set_training_plan` and `confirm_training_plan` for the in-app coach, with
   the comment from the design doc (strategy at a desk, tactics between sets).
4. **Context paragraph**: `pwa/src/lib/coachContext.ts` adds the plan
   paragraph when a live CONFIRMED plan exists, via a new read in `data.ts`
   (`getTrainingPlan`, cached under a new `cacheKeys.trainingPlan`, registered
   in `db.test.ts` ALL_KEYS/UNTOUCHED). Format from the design doc, ~80 words:
   objective, "Phase n of m, name (dates): focus. Progression: rule. Next:
   name from date."
5. **Prompt rule** (your block in `prompt.ts`): a day written or edited must
   fit the current phase's focus and progression; when the request
   contradicts the phase, say so and ask rather than comply. Add ONE eval case
   under `scripts/coach-eval/cases.mjs` if the harness makes that cheap;
   otherwise describe it in the decisions entry.
6. **Docs**: decisions entry (the authority split and the rejected markdown
   document), `docs/setup.md` "Adding another user" untouched, CLAUDE.md gets
   one bullet: the plan layer, who writes it, who may not.

## C · The loop: prescription notes, %TM, repeat, review

1. **Prescription-note rule** in your `prompt.ts` block: `prescriptions.notes`
   is the coach's cue for that exercise on that day, brief, never parse
   commentary, never the lifter's name or a date. Also tighten the
   `prescriptionSchema` `notes` description in `lib/prescriptions.ts` to say
   the same.
2. **%TM without a TM**: `resolveTrainingMaxes` stops REFUSING a
   `load_pct_tm` with no current TM; it returns the map it could resolve and
   the tools include an `unresolved_pct` list in their result with the
   sentence "no training max yet; the first session sets it — propose one with
   set_training_max afterwards". `v_resolved_prescriptions` already yields
   null loads for these. Check `pwa/src/screens/Session.tsx` renders a
   prescription with `load_pct_tm` and null `resolved_load_kg` as "70% of TM
   (none set)" rather than blank; if that needs a small change in Session.tsx
   coordinate: A owns that file, so put the change in a helper under
   `pwa/src/lib/` and ask the orchestrator to wire the one-line call.
3. **`find_similar_days(exercise_ids[], limit?)`**: Jaccard over the exercise
   sets of this user's non-template, non-discarded days, >= 0.6, most recent
   first, each with: day id, label, date, program, phase, and LAST TIME's
   logged sets per exercise (load, reps, set_type, load_entry) and set notes,
   plus the order the entries were actually performed (by first
   `performed_at`). Reads through `v_live_sets` and `v_adherence`, never
   `sets`.
4. **`repeat_planned_workout(planned_workout_id, scheduled_date, confirm_change)`**:
   clones a day into the SAME program on the new date (day_index = max+1),
   prescriptions copied via `prescriptionRows`, with three adjustments the
   result names: loads replaced by last logged working loads where they
   exist, entry order following performed order, and set notes that read as
   instructions returned in the result as `notes_to_consider` (not copied).
   Refuses a template. Requires `confirm_change` on a confirmed program like
   `update_planned_workout`.
5. **Prompt**: at parse time, call `find_similar_days` BEFORE `upsert_program`
   and offer the repeat; the review turn's rubric from the design doc (compare
   to prescribed, propose TMs where % had none, set notes → exercise_notes or
   next-time loads, nothing written without a yes).
6. **Review entry point**: Today's DONE card for the last 24 h gets "Review
   with the coach", which opens `CoachSheet` with a prefilled first turn
   naming the session id and date. Read how `FabDock` opens the sheet and
   reuse it rather than a second sheet.
7. **Docs**: decisions entry per the design doc; CLAUDE.md bullet for the
   %TM change (it relaxes a rule that is written there).

## What the orchestrator does after merge

Applies migrations to production through the Supabase MCP (recording the
version), deploys `push-alerts` and `coach` through the MCP, and states plainly
that `mcp-server` still needs `supabase functions deploy mcp-server
--no-verify-jwt` from a laptop or the three deploy settings, because its 28
files do not fit through the tool available here. Then the phone checklist.

## Phone checklist (Colt, at the end)

1. Report a problem → APP VERSION is the new sha.
2. Settings → "Alert me when the app is closed" → allow → toggle on.
3. Start a session, log a set with a 60 s rest, lock the phone. Expect a
   notification at ~60 s. Log another set before the rest ends: expect NO
   notification.
4. Today → finished day → "Review with the coach" → the coach compares,
   proposes a leg-extension TM, turns the band notes into cues. Say yes to
   one, no to another; check only the yes landed.
5. In the coach: "show me my plan" (expects: none yet, and how to make one
   from Desktop). From Claude Desktop later: `set_training_plan`, confirm,
   then ask the in-app coach to add a day that contradicts the phase.
6. Upload the same coach screenshots again: the coach should recognise the
   day and offer a repeat with last time's loads.
