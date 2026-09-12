# Observability recovery and delivery plan

> **For Codex:** Required execution skill: use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Make user-reported bugs durable and visible, repair the two confirmed telemetry gaps, and remove the release order that previously shipped a client before its database migration.

**Architecture:** Supabase `feedback` is the durable, user-owned intake record. Sentry remains the error and diagnostic mirror, but no longer decides whether the PWA tells someone their report was received. Each report writes to the existing RLS-protected table first, then mirrors to Sentry without making success depend on the mirror.

**Tech Stack:** React 19, TypeScript, Vitest, Supabase PostgREST/RLS, Supabase Edge Functions, Sentry.

**Spec:** `docs/plan.md`, `docs/endurance-plan.md`, and `docs/superpowers/plans/2026-09-04-sequenced-plan.md` remain the product plans of record. This document sequences the production recovery work that precedes their next feature tranche.

## Global constraints

- Do not lose a report merely because Sentry is unavailable, sampled, filtered, or retained differently.
- Keep the report sheet open on a failed database write. A thank-you message is only allowed after the database confirms the insert.
- The report context must contain exactly the diagnostics the user was shown, no silent extras.
- Preserve the existing `feedback` RLS owner boundary. The PWA never chooses `user_id`; Postgres derives it from the authenticated session.
- Do not resolve the existing Sentry schema issue until a fresh production build completes a plan read without it recurring.
- Do not change Supabase advisor findings in bulk. The RLS query-shape findings need a query-path audit; service-role-only tables are intentional until that audit says otherwise.

---

## Task 1: make the in-app report durable

**Files:**
- Modify: `pwa/src/lib/errors.ts`
- Modify: `pwa/src/lib/errors.test.ts`
- Modify: `pwa/src/components/ReportBugSheet.tsx`

**Step 1: Write the failing tests.**

Cover these cases with mocked `supabase.from("feedback").insert(...)`:

1. A successful submission inserts `{ kind: "bug", source: "user" }`, keeps the full human message, and serializes exactly the displayed diagnostics into `context`.
2. A returned PostgREST error produces a failed result and does not claim success.
3. Sentry still receives the best-effort feedback mirror after a durable insert.

**Step 2: Run the focused test to prove it fails.**

Run: `cd pwa && npm test -- --run src/lib/errors.test.ts`

Expected: failure because `sendBugReport` currently returns a synchronous Sentry-only boolean and never writes `feedback`.

**Step 3: Implement the smallest behaviour.**

Make `sendBugReport` async. It must insert the report into `feedback`, returning an explicit success or failure object. On success, keep the existing Sentry `captureFeedback` call as a non-blocking mirror. On failure, route the returned database error through `reportError` and return a user-safe retry message.

Update `ReportBugSheet` to await the result. Close and clear the sheet only on success. Leave it open with the entered text on failure.

**Step 4: Verify.**

Run:

```bash
cd pwa && npm test -- --run src/lib/errors.test.ts
cd pwa && npm run typecheck
cd pwa && npm run build
```

Expected: tests prove successful persistence, error visibility, and Sentry mirroring. Typecheck and build pass.

## Task 2: preserve coach refusal telemetry

**Files:**
- Create: `supabase/functions/coach/usage.ts`
- Create: `supabase/functions/coach/usage.test.ts`
- Modify: `supabase/functions/coach/index.ts`

**Step 1: Write the failing Deno tests.**

Test a returned PostgREST error and a thrown transport error from the refusal-row write. Both must report the failure; a successful write must report nothing.

**Step 2: Run the focused test to prove it fails.**

Run: `cd supabase/functions/coach && deno test usage.test.ts`

Expected: failure because the helper does not exist.

**Step 3: Implement the helper and wire it at the 429 branch.**

The handler must still return the original 429 even if telemetry cannot be written. Emit a named structured error and call `captureError` with `stage: "refusal_usage_write"` so a failed record is observable.

**Step 4: Verify.**

Run:

```bash
cd supabase/functions/coach && deno test usage.test.ts
cd supabase/functions/coach && deno check index.ts
```

## Task 3: make database-before-PWA deploy real

**Files:**
- Verify: `.github/workflows/deploy.yml`
- Verify: `docs/deploy.md`

**Manual, external action:** Add repository secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`, and repository variable `SUPABASE_PROJECT_REF`. The workflow already gates on all three and deploys Supabase before Pages. This task cannot be completed from the repository alone.

**Verification:** Trigger a dry-run deployment that changes a harmless Supabase file and confirm the job does not report `Supabase deploy skipped`. Then deploy the PWA report fix. Do not expose or paste any secret into chat, source, or a commit.

## Task 4: close the known production incident with evidence

The unresolved Sentry issue `JAVASCRIPT-REACT-3` came from release `main+624aec3`: the PWA selected `prescriptions.set_type` before migration `20260830120000_prescription_set_type` reached production. The migration is present now, but the incident remains unresolved.

After Task 3's ordered deploy succeeds, use a signed-in production account to open a plan and add an exercise. Confirm no new schema-cache error appears. Only then resolve the Sentry issue, retaining its event as the deployment-order record.

## Task 5: resume feature work in the correct order

The strength workflow through Wave 3 and endurance E0/E1 are built. The next product phase is **E2, state estimation**, not a generator: it supplies the state and `missing[]` evidence that E3 intake, E4 calendar entries, and E5 block generation depend on.

Before E2 starts, complete Tasks 1 through 4. Then use `docs/endurance-plan.md` Phase E2's gate: a complete real-user state vector, honest missing history, independent aerobic/tissue-tolerance behaviour across the known gap, and an eight-effort benchmark series. E3, E4, and E5 follow in that dependency order.

## Commit sequence

1. `Make bug reports durable` after Task 1 and its focused checks pass.
2. `Record failed coach refusal telemetry` after Task 2 and Deno checks pass.
3. No repository commit for Task 3 unless the workflow changes. Record the external configuration completion in the next operational documentation commit.
