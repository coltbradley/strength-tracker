# Version D Per-Set Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a truthful local and server state for each logged set and correction in Version D Focus and List.

**Architecture:** IndexedDB outbox entries remain the write authority until the server accepts them. A small pure projector combines server-confirmed row IDs, pending operations, and the current user's identity into display receipts. `Session.tsx` subscribes to outbox changes and hands receipts to controlled views; no new database table or second queue is needed.

**Tech Stack:** TypeScript, React 19, IndexedDB, Vitest, Testing Library, existing Supabase transport.

**Spec:** `docs/superpowers/specs/2026-09-30-version-d-light-design.md`

## Global Constraints

- `sets` and `set_voids` stay append-only, with PWA-only writes and client UUID idempotency.
- A correction retains the original set index and time, queues replacement before void, and earns “Synced” only when both operations are server-confirmed.
- “On this phone” requires a committed local enqueue; “Synced” requires the specific operation's server response or verified server readback.
- Waiting, held, retrying, rejected, and unknown-owner operations cannot appear synced. Do not infer success from an empty queue.
- Preserve multi-user outbox holding, reload recovery, current aggregate sync status, and exact server readback before release.
- Do not release while the affected phone queue or Phase 2 browser/phone/readback gate remains open.

## Review Focus

1. A successful server insert followed by failed void must leave a correction in Review, not Synced (Task 2).
2. A reload after local enqueue but before sync must still show On this phone or Review (Task 3).
3. An outbox item held for a different user must not generate this user's set receipt (Task 2).
4. A transport timeout and a definitive policy rejection require different Review reasons (Task 2).
5. A row returned from the server after an ambiguous network response may become Synced only by exact UUID readback (Task 3).

---

### Task 1: Make correction durability explicit before showing receipts

**Files:** Modify `pwa/src/screens/Session.tsx`, `pwa/src/screens/Session.focus.test.tsx`, `pwa/src/lib/outbox.ts`, `pwa/src/lib/outbox.test.ts`, `pwa/src/lib/db.ts`, and `pwa/src/lib/db.test.ts`. Inspect `pwa/src/lib/corrections.ts`.

**Interfaces:** Keep `correctedSet(old, patch)` and the existing `Outbox.enqueue` / `enqueueBatch` contracts. Add `Outbox.enqueueCorrection(sessionId: string, replacement: SetInsert, originalId: string): Promise<void>` that writes both operations and `cacheKeys.sessionCorrectionLinks(sessionId)` (`replacementId -> originalId`) in one transaction across the existing `outbox` and `kv` stores. Stamp the same owner on both queued operations. The UI must mark the correction locally durable only after the transaction resolves.

- [ ] Write tests where the transaction fails before commit and where it succeeds offline. A failed enqueue must restore or retain the original visible set, void cache, and note/rest relationship, and report the failure. A successful enqueue must store both operations in replacement-first order plus the durable link.
- [ ] Run `cd pwa && npm test -- src/screens/Session.focus.test.tsx src/lib/corrections.test.ts`; confirm the new failure case fails.
- [ ] Move optimistic correction and quick RPE presentation changes behind durable queue success, or provide an exact rollback of set, void cache, note, and rest source on failure. Use `enqueueCorrection` so both queue rows and the link commit atomically. Give plain void the same durable-before-visible treatment. Do not change the server mutation model.
- [ ] Run focused tests and `cd pwa && npm run typecheck`; require both to pass.
- [ ] Commit correction durability independently of receipt UI.

### Task 2: Project receipt state from exact operations

**Files:** Create `pwa/src/lib/setReceipt.ts` and `pwa/src/lib/setReceipt.test.ts`; modify `pwa/src/lib/outbox.ts` only if its existing `inspect()` result lacks a needed operation identity or error field. Reuse `pwa/src/lib/db.ts` types.

**Interfaces:** Export `type SetReceipt = { state: 'local' | 'sending' | 'synced' | 'review'; reason?: string }` and `projectSetReceipt(input: { setId: string; ownerId: string; serverSetIds: ReadonlySet<string>; serverVoidIds: ReadonlySet<string>; entries: readonly OutboxEntry[]; correctionOf?: string }): SetReceipt`. The pure function must match `sets.payload.id` and `set_voids.payload.set_id` for the exact UUIDs, not queue totals. `correctionOf` comes from the durable replacement-to-original link. Unknown evidence maps to Review, never Synced.

- [ ] Add table tests for waiting, in-flight, held, dead, successful exact row, unknown owner, plain void, replacement-plus-void, and ambiguous timeout. Assert a replacement with pending void is Review or local, never Synced. Pin the five Review Focus cases that belong here.
- [ ] Run `cd pwa && npm test -- src/lib/setReceipt.test.ts`; confirm red because the projector does not exist.
- [ ] Implement the pure projector. Read actual `OutboxOp` discriminants and use stable operation UUIDs. `inspect()` currently exposes waiting/held/dead but no in-flight per-item state; either derive Sending only from a genuinely observed in-flight operation or omit that label until evidence exists. Never manufacture Sending from a global queue status.
- [ ] Run the projector tests, full `cd pwa && npm test`, and typecheck; require all to pass.
- [ ] Commit the projector separately from the view wiring.

### Task 3: Reconcile receipts after flush and reload

**Files:** Modify `pwa/src/lib/sync.ts`, `pwa/src/lib/outbox.ts`, `pwa/src/screens/Session.tsx`, `pwa/src/lib/data.ts`, `pwa/src/lib/outbox.test.ts`, and `pwa/src/screens/Session.focus.test.tsx`; use `pwa/src/lib/db.ts` for the durable correction link.

**Interfaces:** Add a subscriber for successful outbox operations (for example `subscribeSynced(fn: (op: OutboxOp) => void): () => void`) while preserving the check-in memory callback. `Session.tsx` refreshes its pending-op snapshot through `inspect()` and obtains exact confirmed set and void UUIDs from authenticated server reads. The `v_live_sets` session list cannot prove a void landed, so add an owner-scoped `set_voids` SELECT and exact `sets` ID read where needed. `projectSetReceipt` remains pure.

- [ ] Add tests for a set moving local -> synced after its own success callback, remaining local after another set succeeds, and recovering local state from `inspect()` on reload. Add an ambiguous-success test where exact server UUID readback, rather than queue disappearance, establishes Synced.
- [ ] Run `cd pwa && npm test -- src/lib/outbox.test.ts src/screens/Session.focus.test.tsx`; confirm new tests fail.
- [ ] Wire one success notification and pending snapshot refresh. Keep successful row IDs in session state only as evidence from the current server response or `onSynced`; on reload, read the durable correction link, exact server set/void rows, and pending ops before asserting Synced. If an offline cached row is indistinguishable from a server row, show Review until readback.
- [ ] Run focused tests, full PWA tests, typecheck, and build.
- [ ] Commit reconciliation separately.

### Task 4: Show receipts without obscuring the workout

**Files:** Modify `pwa/src/components/session/FocusDeck.tsx`, `pwa/src/components/session/WorkoutOverview.tsx`, `pwa/src/screens/Session.tsx`, their existing tests, and scoped `pwa/src/styles.css` rules. Reuse `pwa/src/components/OutboxSheet.tsx` for details.

**Interfaces:** Pass `receiptForSet: (setId: string, correctionOf?: string) => SetReceipt` from Session to both controlled views. Use the same label mapping in Focus last-set card and List logged rows; keep the header aggregate status.

- [ ] Add rendering tests for On this phone, Synced, and Review, including a corrected set whose void is pending. The accessible name must include the state even when healthy text is visually quiet.
- [ ] Run `cd pwa && npm test -- src/components/session/FocusDeck.test.tsx src/components/session/WorkoutOverview.test.tsx`; confirm new cases fail.
- [ ] Add the small state treatment and open OutboxSheet from Review. Remove D's “Already saved” or “all on the server” copy unless the exact receipt warrants it.
- [ ] Run focused and full PWA tests, typecheck, build, then browser-check offline, reconnect, dead write, account switch, and reload. Read back exact test UUIDs before interpreting a green state as server proof.
- [ ] Commit receipt presentation.
