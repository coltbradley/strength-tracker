# Phase 2 record safety: A-90, A-148, A-06, A-204

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four open Phase 2 findings that can misattribute, disclose or
wrongly close a training record, each with a regression test.

**Architecture:** All four are PWA-side (outbox, Sync sheet/export, End screen,
open-session sweep). No migration. One commit per finding.

**Tech Stack:** React, IndexedDB outbox (`pwa/src/lib/outbox.ts`), supabase-js,
vitest with fake-indexeddb.

## Global Constraints

- Held, never dropped: no change may delete or silently replay another
  account's queued write (AGENTS.md, outbox identity rule).
- `sets` is append-only; a write sent under the wrong account is permanent.
- The persisted-session fallback is IDENTITY, never authorization.
- Run `npm --prefix pwa run typecheck` and the full `npm --prefix pwa test -- --run`
  before each commit.

---

### Task 1: A-90, a write queued while identity is unknown

**Files:** `pwa/src/lib/outbox.ts`, `pwa/src/lib/db.ts` (type), `pwa/src/lib/sync.ts`,
`pwa/src/lib/export.ts` (type), test `pwa/src/lib/outbox.test.ts`.

**Interfaces:** `OutboxItem.user_id?: string | null`. `undefined` = legacy
pre-multi-user row (replayable as before); `null` = queued while no identity
was known (held until an explicit decision; never auto-claimed). New optional
dep `stampUserId?: () => string | null` on `createOutbox`, defaulting to
`currentUserId`; `sync.ts` passes `() => getCurrentUserId() ?? readPersistedUserId()`
so the boot window stamps the account whose session is on the device.

- [ ] Failing tests: (a) with `currentUserId` null at enqueue and no stamp
      identity, then identity becomes ALICE and flush runs: nothing is sent and
      `inspect()` shows the item `held` with `user_id: null`. (b) with
      `currentUserId` null but `stampUserId` returning ALICE: the item is stamped
      ALICE and flushes once identity is ALICE. (c) a legacy item with no
      `user_id` key still flushes.
- [ ] Implement: `makePendingItem` always writes `user_id: owner`;
      `replayable` returns `true` for `undefined`, `false` for `null`.
- [ ] Commit `fix: hold a write queued before identity is known (A-90)`.

### Task 2: A-148, held rows disclose another account's data

**Files:** `pwa/src/components/OutboxSheet.tsx`, `pwa/src/lib/export.ts`, tests
`pwa/src/components/OutboxSheet.test.tsx`, `pwa/src/lib/export.test.ts`.

- [ ] Failing tests: the sheet with a held row naming "Barbell Squat" renders the
      held COUNT but not the exercise name; `buildQueueExport` gives a held item
      `row: null`, `queued_by: null` and no `exercise_name`, while its summary still
      counts it.
- [ ] Implement: drop the held `QueueList`, keep the count and the explanation;
      redact held items in `buildQueueExport`.
- [ ] Commit `fix: stop showing another account's queued writes (A-148)`.

### Task 3: A-06, End and Discard both queued

**Files:** `pwa/src/screens/End.tsx`, test `pwa/src/screens/End.finish.test.tsx`.

- [ ] Failing test: confirmed-empty session, click "End anyway" then
      immediately "Discard empty session" (no await): exactly one `sessions`
      update is enqueued.
- [ ] Implement: replace `endingRef` with one `terminalRef<"end" | "discard" | null>`
      checked and set synchronously by `end()` and `discard()`, released on every
      path that already released either lock; both buttons disabled while a
      terminal action is in flight.
- [ ] Commit `fix: let End and Discard never both queue for one session (A-06)`.

### Task 4: A-204, stale sweep discards a session closed elsewhere

**Files:** `pwa/src/lib/data.ts` (`OpenSessionPort.discard`, `supabaseOpenSessions`,
`syncOpenSessions`), test `pwa/src/lib/openSessions.test.ts`.

**Interfaces:** `discard(sessionId, discardedAt): Promise<boolean>`; true only
when a still-open row changed. Supabase impl adds
`.is("ended_at", null).is("discarded_at", null).select("id")`.

- [ ] Failing test: fake port whose `discard` reports false (the session was
      completed elsewhere after the snapshot): `autoDiscarded` is 0.
- [ ] Implement and commit `fix: discard only a session that is still open (A-204)`.

## Follow-on (same day): A-203, A-04, A-05, A-13, A-143

Done test-first, one commit each: a `training_maxes` history trigger
(`20260924200000`, validate-db checks); `lib/swUpdate.ts` gate with
`swUpdate.test.ts`; generation guards in Plan (`Plan.navigation.test.tsx`),
Today (`Today.plan-changed.test.tsx`) and History; an outbox retry backoff
(`outbox.test.ts`). History's index guard has no dedicated test.

