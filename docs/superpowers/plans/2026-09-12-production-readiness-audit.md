# Production Readiness Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and either fix or explicitly record release-blocking wiring, state, and operational failures across the PWA, coach, sync queue, and Supabase edge functions.

**Architecture:** Audit every boundary where data is written in one subsystem and consumed in another. Small defects receive a regression test and a focused fix. Larger work stays in the audit backlog with its failing boundary, user impact, and the command or test needed to close it.

**Tech Stack:** React 19, TypeScript, Vite PWA, Vitest, IndexedDB outbox, Supabase Postgres and Edge Functions, Deno.

**Spec:** `docs/spec.md`, `docs/flows.md`, `docs/security.md`, and the user request in this thread.

## Global Constraints

- Preserve append-only training-set semantics and existing user data.
- Do not deploy, publish, or mutate production rows as part of the audit.
- Run a failing regression test before every production-code bug fix.
- Commit each independently verified audit increment.
- Record evidence as local, live Supabase, or blocked rather than treating one as the other.

---

## Audit log

| Status | Boundary | Evidence | Resolution |
| --- | --- | --- | --- |
| fixed locally | Coach plan write to PWA Today | The coach writes through MCP, outside `pwa/src/lib/data.ts` cache invalidation. `Today` refreshed only on mount or its own writes. | Add a `plan:changed` event, refresh Today on it, show a coach handoff, and allow a complete undated day to start. Regression checks in `planChanges.test.ts` and `Today.test.ts`. |
| in review | PWA read/cache/write boundaries | Trace cache key invalidation against every server-side writer and offline fallback. | Inspect `pwa/src/lib/data.ts`, `pwa/src/lib/db.ts`, outbox lifecycle, and callers. |
| in review | Session lifecycle | Verify an active, orphaned, discarded, or completed session cannot hide the only valid next action. | Inspect `Today`, `Session`, `End`, and open-session reconciliation. |
| in review | Edge functions and database | Check deployed-function drift, auth/RLS assumptions, error paths, and scheduled work. | Run local contracts, linked-project checks, and static function checks. |
| deferred until evidence | Native Dynamic Island / Android live activity | A web PWA cannot supply this native surface. | Specify native architecture separately; it is not a small release fix. |

## Task 1: Commit the verified user-flow repairs

**Files:**
- Modify: `pwa/src/components/CoachSheet.tsx`, `pwa/src/screens/Today.tsx`, `pwa/src/lib/planChanges.ts`
- Test: `pwa/src/lib/planChanges.test.ts`, `pwa/src/screens/Today.test.ts`

**Interfaces:**
- Produces: `notifyPlanChanged()` and `onPlanChanged()` for coach-originated program mutations.
- Produces: a visible route from a completed coach plan mutation to Today.

- [x] **Step 1: Write failing regression checks**

```ts
expect(canDoWorkoutNow("NO DATE")).toBe(true);
notifyPlanChanged(target);
expect(calls).toBe(1);
```

- [x] **Step 2: Verify the checks fail for the missing behavior**

Run: `cd pwa && npm test -- --run src/screens/Today.test.ts src/lib/planChanges.test.ts`

Observed: `NO DATE` returned `false` and `planChanges` did not exist.

- [x] **Step 3: Implement the smallest handoff**

```ts
if (isWorkoutWritingTool(name)) planWrite.current = true;
if (planWrite.current) notifyPlanChanged();
```

- [x] **Step 4: Verify the complete PWA increment**

Run: `cd pwa && npm test && npm run typecheck && npm run build`

Observed: 54 test files and 700 tests passed; typecheck and build exited zero.

- [ ] **Step 5: Commit**

Run: `git add pwa docs/superpowers/plans/2026-09-12-production-readiness-audit.md && git commit -m "Fix coach workout handoff and push settings"`

## Task 2: Audit PWA state handoffs

**Files:**
- Inspect: `pwa/src/lib/data.ts`, `pwa/src/lib/db.ts`, `pwa/src/lib/sync.ts`, `pwa/src/screens/Today.tsx`, `pwa/src/screens/Session.tsx`, `pwa/src/screens/End.tsx`
- Test: the nearest existing unit test for each confirmed defect

**Interfaces:**
- Consumes: cache key families, outbox rows, active-session records, and screen reload paths.
- Produces: either a tested minimal fix or an audit-log row naming the exact unsafe transition.

- [ ] **Step 1: Map writers to cache invalidation**

Run: `rg -n 'cache(Set|Delete)|invalidate|\.from\(' pwa/src supabase/functions`

Expected: every cross-surface plan, session, and settings writer names its cache or event consumer.

- [ ] **Step 2: Reproduce each confirmed transition with a focused test**

Use an existing `*.test.ts` beside the owner module. Assert a user-visible state, such as an active session being resumable or a completed session no longer blocking Start.

- [ ] **Step 3: Apply one minimal fix per failing test**

Keep the outbox append-only and do not add client service-role access.

- [ ] **Step 4: Verify and commit the increment**

Run: `cd pwa && npm test && npm run typecheck && npm run build`

Commit: `git commit -m "Fix audited PWA state handoff"`

## Task 3: Audit Supabase operational boundaries

**Files:**
- Inspect: `supabase/functions/coach/index.ts`, `supabase/functions/push-alerts/index.ts`, `supabase/functions/mcp-server/`, `supabase/migrations/`, `docs/security.md`
- Test: function-local Deno tests and `scripts/validate-db.mjs`

**Interfaces:**
- Consumes: authenticated user identity, Postgres RLS policies, scheduled edge calls, and function error responses.
- Produces: a tested error-handling or authorization fix, or an evidence-backed backlog entry.

- [ ] **Step 1: Check linked project and current function inventory without mutation**

Run: `supabase functions list && supabase migration list && supabase db advisors --linked`

- [ ] **Step 2: Compare function routes with PWA callers**

Run: `rg -n 'functions\.invoke|call\(' pwa/src && rg -n 'case "|Deno\.serve' supabase/functions`

Expected: every client route has an authenticated server route and an explicit non-2xx response path.

- [ ] **Step 3: Test any confirmed edge defect before changing it**

Run the function’s `deno check index.ts && deno test` before and after the smallest patch.

- [ ] **Step 4: Verify database contracts and commit**

Run: `node scripts/validate-db.mjs && git diff --check`

Commit: `git commit -m "Harden audited Supabase boundary"`

## Task 4: Record release gates

**Files:**
- Modify: this audit log
- Inspect: `docs/deploy.md`, `README.md`, `pwa/package.json`

**Interfaces:**
- Produces: a short, evidence-backed list of what prevents production release and the exact verification command for each item.

- [ ] **Step 1: Classify unresolved findings**

Use `fixed locally`, `verified live`, `blocked`, or `deferred`. Do not label a local code result as production behavior.

- [ ] **Step 2: Run final release checks**

Run: `cd pwa && npm test && npm run typecheck && npm run build`; `cd ../supabase/functions/push-alerts && deno check index.ts && deno test`; `node scripts/validate-db.mjs`.

- [ ] **Step 3: Commit the audit record**

Commit: `git commit -m "Document production readiness audit"`
