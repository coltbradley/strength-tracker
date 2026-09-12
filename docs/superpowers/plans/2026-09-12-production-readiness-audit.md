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
| fixed locally | Coach plan write to PWA Today | Committed as `f789c4e`; the complete PWA suite, typecheck, and production build passed before commit. | The local change is not deployed. Confirm the deployed PWA includes this commit before treating the handoff as live. |
| deferred, transactional database work | Multi-request plan copies | `duplicatePlannedWorkout`, `saveWorkoutAsTemplate`, and `applyTemplate` insert `planned_workouts` and then prescriptions in separate browser requests. A timeout after the parent insert is ambiguous: the client cannot safely decide whether to compensate, so it can leave an empty day or hide a fully written one. | Add an authenticated Postgres RPC for each composite create, or one parameterized RPC, that creates the parent and prescription rows in one transaction. Add PGlite/RLS tests for child-insert failure and network-retry idempotency before switching the PWA callers. |
| deferred, transactional database work | First manual planned day | `createPlannedWorkout` can create a confirmed `My plan` program and then fail while creating its first day. Program deletion is intentionally prohibited, so a browser rollback is unsafe. | Include first-program creation in the same transactional RPC as planned-day creation; test that a failed day insert leaves no confirmed empty program. |
| verified locally | Dependency supply chain | `cd pwa && npm audit --omit=dev --json` reported zero production dependency vulnerabilities. | Re-run in CI on lockfile changes. |
| verified live | Linked Supabase inventory | Migration history matched through `20260907060000`; four edge functions were active. The current local commit has not been deployed. | Treat deployment/version confirmation as a release step, not evidence supplied by this audit. |
| deferred, dashboard policy | Supabase Auth protection | Linked-project advisor reports leaked-password protection disabled and insufficient MFA options. `docs/security.md` documents magic-link sign-in, so this is not evidence of a current password-flow defect. | Before enabling any password provider, enable password protection, choose an MFA policy, and verify sign-in and recovery flows. This audit does not change account security settings. |
| deferred, database performance work | RLS policy query planning | Linked-project advisor reports 97 `auth_rls_initplan` findings, where repeated `auth.uid()` evaluation can cost query performance. | Inventory policies, convert one table family at a time to `(select auth.uid())`, benchmark representative queries, and deploy only with migration/RLS regression checks. |
| release gate | End-to-end browser coverage | `pwa/package.json` has unit, typecheck, and build scripts, but no browser end-to-end test command for sign-in, plan creation, start, resume, and completion. | Add a seeded browser test suite before treating the PWA as release-ready. |
| deferred, mobile performance work | Initial PWA bundle | Fresh production build completed with a 713.40 KB uncompressed main JavaScript chunk (213.07 KB gzip), triggering Vite's 500 KB chunk warning. | Profile a cold phone load, then code-split route-only screens and heavy coach/markdown dependencies. Record before/after load and interaction timings; do not split blindly. |
| fixed locally | Edge-function verification commands | The deployment guide omitted the MCP test suite and the README advertised `deno test lib/`, which both skipped tool tests and lacked the environment/network permissions required by `protocol.test.ts`. CI already used the complete command. | Align `docs/deploy.md` and the MCP README with CI: `deno test --allow-env --allow-net`; include push-alerts and endurance-sync checks in the release guide. |
| verified locally | Session lifecycle | `syncOpenSessions` and its table-driven tests cover stale local pointers, queued set protection, auto-completion, same-day orphan adoption, and cross-device safety. `Today` blocks every start action until reconciliation resolves or times out. | No confirmed defect in this boundary. Preserve its injected-port tests when changing reconciliation. |
| verified locally | Push-alert client to edge routes | The client calls `vapid-public-key`, `subscribe`, `unsubscribe`, `arm`, `schedule`, `cancel`, and `test`; the deployed function explicitly routes each and returns non-2xx responses. | Run push function contracts and a phone smoke test before release. Closed-app delivery cannot be proven in local tests. |
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

- [x] **Step 5: Commit**

Ran: `git commit -m "Harden coach handoffs and rest alerts"` (`f789c4e`)

## Task 2: Audit PWA state handoffs

**Files:**
- Inspect: `pwa/src/lib/data.ts`, `pwa/src/lib/db.ts`, `pwa/src/lib/sync.ts`, `pwa/src/screens/Today.tsx`, `pwa/src/screens/Session.tsx`, `pwa/src/screens/End.tsx`
- Test: the nearest existing unit test for each confirmed defect

**Interfaces:**
- Consumes: cache key families, outbox rows, active-session records, and screen reload paths.
- Produces: either a tested minimal fix or an audit-log row naming the exact unsafe transition.

- [x] **Step 1: Map writers to cache invalidation**

Run: `rg -n 'cache(Set|Delete)|invalidate|\.from\(' pwa/src supabase/functions`

Expected: every cross-surface plan, session, and settings writer names its cache or event consumer.

Observed: normal PWA mutations invalidate their cache families; the MCP plan path needed the `plan:changed` bridge in Task 1. The remaining composite plan writes are explicitly recorded above because cache invalidation cannot make separate HTTP writes transactional.

- [x] **Step 2: Reproduce each confirmed transition with a focused test**

Use an existing `*.test.ts` beside the owner module. Assert a user-visible state, such as an active session being resumable or a completed session no longer blocking Start.

Observed: `openSessions.test.ts` covers stale pointer, cross-device orphan, queued-set, auto-complete, and auto-discard transitions. No additional session defect was confirmed.

- [x] **Step 3: Apply one minimal fix per failing test**

Keep the outbox append-only and do not add client service-role access.

Observed: the only confirmed cross-surface cache defect was fixed and committed in Task 1. The multi-request plan-write failure must be fixed transactionally, so it is deferred rather than patched unsafely in the client.

- [x] **Step 4: Verify the increment**

Run: `cd pwa && npm test && npm run typecheck && npm run build`

Verified: fresh `npm test`, `npm run typecheck`, and `npm run build` passed. The audit record commits with Task 4 because this task produced no separate code change.

## Task 3: Audit Supabase operational boundaries

**Files:**
- Inspect: `supabase/functions/coach/index.ts`, `supabase/functions/push-alerts/index.ts`, `supabase/functions/mcp-server/`, `supabase/migrations/`, `docs/security.md`
- Test: function-local Deno tests and `scripts/validate-db.mjs`

**Interfaces:**
- Consumes: authenticated user identity, Postgres RLS policies, scheduled edge calls, and function error responses.
- Produces: a tested error-handling or authorization fix, or an evidence-backed backlog entry.

- [x] **Step 1: Check linked project and current function inventory without mutation**

Run: `supabase functions list && supabase migration list && supabase db advisors --linked`

Observed: four functions active; migration history matches local through `20260907060000`; advisor results are classified in the audit log.

- [x] **Step 2: Compare function routes with PWA callers**

Run: `rg -n 'functions\.invoke|call\(' pwa/src && rg -n 'case "|Deno\.serve' supabase/functions`

Expected: every client route has an authenticated server route and an explicit non-2xx response path.

Observed: the rest-alert client and edge router agree on all seven authenticated routes. Coach calls its authenticated single streaming endpoint directly. No route mismatch was found.

- [ ] **Step 3: Test any confirmed edge defect before changing it**

Run the function’s `deno check index.ts && deno test` before and after the smallest patch.

- [x] **Step 4: Verify database contracts**

Run: `node scripts/validate-db.mjs && git diff --check`

Verified: `node scripts/validate-db.mjs` and `node scripts/check-selects.mjs` passed. Coach and push-alerts Deno checks and tests passed. The audit record commits with Task 4 because this task produced no separate code change.

## Task 4: Record release gates

**Files:**
- Modify: this audit log
- Inspect: `docs/deploy.md`, `README.md`, `pwa/package.json`

**Interfaces:**
- Produces: a short, evidence-backed list of what prevents production release and the exact verification command for each item.

- [x] **Step 1: Classify unresolved findings**

Use `fixed locally`, `verified live`, `blocked`, or `deferred`. Do not label a local code result as production behavior.

- [x] **Step 2: Run final release checks**

Ran: PWA test/typecheck/build; database invariants and selected-column check; coach and push-alerts Deno checks and tests. See status rows above for known build warning and unverified phone delivery.

- [x] **Step 3: Commit the audit record**

Committed: `git commit -m "Document production readiness audit"`
