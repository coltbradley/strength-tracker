# Session Focus Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make focus mode the phone-first session surface for reps and completion-only work while retaining the full editable workout overview and supporting one-tap superset rounds offline.

**Architecture:** `Session.tsx` remains the sole owner of session rows, drafts, rest state, substitutions, and sync. Small pure helpers derive focus selection and progress; controlled editor components render that owned state in either overview or focus mode. Superset rounds enqueue two ordinary set inserts atomically in IndexedDB, then retain the existing ordered, idempotent outbox replay.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, `idb`/IndexedDB, Supabase outbox.

**Spec:** `docs/superpowers/specs/2026-09-12-session-focus-deck-design.md`

## Global Constraints

- Keep `Session.tsx` as the only source of truth for `setsRef`, selected entry, drafts, rest, substitutions, skips, and the append-only outbox.
- `focus` and `overview` are presentation state only. Do not add a route, database row, or persisted mode preference in this release.
- Never create a superset database record. A completed round is two normal `SetInsert` rows with separate client UUIDs.
- Persist both round rows in one IndexedDB transaction before updating the rendered set list. Server replay remains ordered but is not falsely described as atomic.
- Do not implement focus mode for `tracking = time` in this work. A session containing time tracking stays in overview until duration editing and `duration_seconds` writes have their own approved, tested plan.
- Render only facts the app has: show the inventory-derived `PlateBar` only when `split()` returns a plate-loaded breakdown, show per-hand and total values for dumbbells, and do not invent cable stack positions.
- Preserve `setsLoaded`/`setsFailed` guards, keyboard access, descriptive labels, reduced-motion behavior, draft retention, rest behavior, and existing correction/skip/extra-set capabilities.
- Add a focused test before each behavior change, run it red, implement the smallest change, run it green, then make one logical commit.

---

## File map

| File | Responsibility |
| --- | --- |
| `pwa/src/lib/sessionFocus.ts` | Pure presentation, selection, remaining-count, and focus-eligibility derivations. |
| `pwa/src/lib/sessionFocus.test.ts` | Unit coverage for those derivations and draft-safe transitions. |
| `pwa/src/lib/outbox.ts` | Add `enqueueBatch`, the durable all-or-nothing local queue primitive. |
| `pwa/src/lib/outbox.test.ts` | Verify batch durability, ordering, idempotent replay, and failure behavior. |
| `pwa/src/components/session/SetEditor.tsx` | Shared controlled normal-set editor, including reps, tick-only, RPE, correction, skip, extra-set, notes, and plate affordances. |
| `pwa/src/components/session/SetEditor.test.tsx` | Rendering and accessibility coverage for normal, per-side, tick, and disabled states. |
| `pwa/src/components/session/WorkoutOverview.tsx` | Existing accordion rendered as a controlled overview, including selected-entry semantics. |
| `pwa/src/components/session/WorkoutOverview.test.tsx` | Overview selection and return-to-focus behavior. |
| `pwa/src/components/session/FocusDeck.tsx` | Focus shell, current-set counters, quiet overview link, and normal/tick deck composition. |
| `pwa/src/components/session/FocusDeck.test.tsx` | Focus-mode counters, deck semantics, movement-state truthfulness, and accessibility. |
| `pwa/src/components/session/SupersetRoundEditor.tsx` | Controlled two-member round editor and explicit complete/partial actions. |
| `pwa/src/components/session/SupersetRoundEditor.test.tsx` | Round labels, independent drafts, `Log round`, and `Log A1 only` behavior. |
| `pwa/src/screens/Session.tsx` | Wire existing owned session state and callbacks to overview/focus components. Do not duplicate state. |
| `pwa/src/screens/Session.focus.test.tsx` | Session-level transition, logging, retained-draft, and offline batch integration tests. |
| `pwa/src/styles.css` | Mobile-first focus deck, round, overview action, focus-visible, and reduced-motion styles. |
| `pwa/src/components/SettingsSheet.tsx` and its test | Temporary device-local focus-mode rollout switch, removed once release verification permits the default. |
| `pwa/src/lib/settings.ts` | Register the temporary `focusDeckPreview` device-local toggle, read through the existing generic `useSetting` hook. |

The duration work is intentionally absent from this file. It must receive a separate spec and plan because it changes the set data contract and the editing model rather than only this presentation.

## Task 1: Add pure focus-presentation derivations

**Files:**
- Create: `pwa/src/lib/sessionFocus.ts`
- Create: `pwa/src/lib/sessionFocus.test.ts`

**Interfaces:**
- Consumes: `ExerciseEntry` and existing `entryMet` semantics from `pwa/src/lib/entries.ts`.
- Produces: `SessionPresentation`, `focusEntryKey`, `remainingProgress`, `isFocusEligible`, and `transitionPresentation`.

- [ ] **Step 1: Write failing unit tests for selection, counters, and time blocking**

```ts
import { describe, expect, it } from "vitest";
import {
  focusEntryKey,
  isFocusEligible,
  remainingProgress,
  transitionPresentation,
} from "./sessionFocus";

it("returns the first incomplete entry when no active entry is restored", () => {
  expect(focusEntryKey(entries, isDone, null)).toBe("deadlift");
});

it("returns the overview-selected entry when entering focus", () => {
  expect(transitionPresentation("overview", "focus", "press", "squat")).toEqual({
    presentation: "focus",
    focusKey: "press",
  });
});

it("does not offer focus mode for a timed prescription", () => {
  expect(isFocusEligible(timeTrackedEntries)).toBe(false);
});

it("counts remaining sets and exercises from canonical set rows", () => {
  expect(remainingProgress(entries, isDone)).toEqual({
    setsRemaining: 4,
    exercisesRemaining: 2,
  });
});
```

- [ ] **Step 2: Run the new test file and confirm the imports fail**

Run: `npm test -- --run pwa/src/lib/sessionFocus.test.ts`

Expected: FAIL because `sessionFocus.ts` does not exist.

- [ ] **Step 3: Implement side-effect-free helpers**

```ts
export type SessionPresentation = "focus" | "overview";

export function isFocusEligible(entries: readonly ExerciseEntry[]): boolean {
  return entries.every((entry) => entry.brackets[0]?.tracking !== "time");
}

export function transitionPresentation(
  current: SessionPresentation,
  next: SessionPresentation,
  overviewSelection: string | null,
  priorFocusKey: string | null,
): { presentation: SessionPresentation; focusKey: string | null } {
  if (current === "overview" && next === "focus") {
    return { presentation: "focus", focusKey: overviewSelection ?? priorFocusKey };
  }
  return { presentation: next, focusKey: priorFocusKey };
}
```

`remainingProgress` must accept the same `isDone(entry)` closure `Session.tsx` already uses. It must derive its answer from the canonical set list, not keep counters in component state.

- [ ] **Step 4: Run the focused tests and typecheck**

Run: `npm test -- --run pwa/src/lib/sessionFocus.test.ts && npm run typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the pure state boundary**

```bash
git add pwa/src/lib/sessionFocus.ts pwa/src/lib/sessionFocus.test.ts
git commit -m "Add session focus state helpers"
```

### Task 2: Make multi-set queueing atomic on this device

**Files:**
- Modify: `pwa/src/lib/outbox.ts`
- Modify: `pwa/src/lib/outbox.test.ts`

**Interfaces:**
- Consumes: existing `OutboxOp`, `OutboxItem`, `Database`, `getDb`, identity stamping, and `flush`.
- Produces: `Outbox.enqueueBatch(ops: readonly OutboxOp[]): Promise<void>`.

- [ ] **Step 1: Add failing outbox tests for a round batch**

```ts
it("stores a set round as two ordered items before any replay", async () => {
  const outbox = build(transport);
  await outbox.enqueueBatch([
    { kind: "insert", table: "sets", payload: setA },
    { kind: "insert", table: "sets", payload: setB },
  ]);
  expect((await db.getAll("outbox")).map((item) => item.op.payload.id)).toEqual([
    setA.id,
    setB.id,
  ]);
});

it("leaves no part of the batch when its IndexedDB transaction aborts", async () => {
  const failingOutbox = createOutbox({ getDb: () => Promise.resolve(failingDb), transport, isOnline: () => false });
  await expect(failingOutbox.enqueueBatch(roundOps)).rejects.toThrow("disk full");
  expect(await db.count("outbox")).toBe(0);
});

it("replays both batch members in order and preserves normal idempotency", async () => {
  await outbox.enqueueBatch(roundOps);
  online = true;
  await outbox.flush();
  expect(calls.map((call) => call.payload.id)).toEqual([setA.id, setB.id]);
});
```

Build the failing outbox with `createOutbox({ getDb: () => Promise.resolve(failingDb), transport, isOnline: () => false })`, where `failingDb.transaction("outbox", "readwrite")` returns a transaction whose second `store.add` rejects and whose `done` rejects. Assert through a separate normal `getDb()` that the outbox store has zero rows. Do not test rollback by deleting a row after an ordinary `enqueue`, because that would not prove atomic persistence.

- [ ] **Step 2: Run the focused outbox tests and confirm they fail**

Run: `npm test -- --run pwa/src/lib/outbox.test.ts`

Expected: FAIL because `enqueueBatch` is absent.

- [ ] **Step 3: Add batch persistence without altering replay behavior**

```ts
export interface Outbox {
  enqueue(op: OutboxOp): Promise<void>;
  enqueueBatch(ops: readonly OutboxOp[]): Promise<void>;
  flush(): Promise<void>;
  // existing members unchanged
}

async enqueueBatch(ops) {
  if (ops.length === 0) return;
  const db = await getDb();
  const owner = whoAmI();
  const tx = db.transaction("outbox", "readwrite");
  for (const op of ops) {
    await tx.store.add(makePendingItem(op, owner));
  }
  await tx.done;
  await refreshCounts();
  void flush();
}
```

Extract the shared pending-item construction used by `enqueue` and `enqueueBatch`, so user ownership, retries, status, timestamps, and failure handling cannot diverge. Do not add a batch envelope to `OutboxItem`; the stored queue continues to contain ordinary operations in auto-increment key order.

- [ ] **Step 4: Run the focused tests, all PWA tests, typecheck, and build**

Run: `npm test -- --run pwa/src/lib/outbox.test.ts && npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the durable queue primitive**

```bash
git add pwa/src/lib/outbox.ts pwa/src/lib/outbox.test.ts
git commit -m "Add atomic outbox batch enqueue"
```

### Task 3: Extract a controlled set editor from the accordion

**Files:**
- Create: `pwa/src/components/session/SetEditor.tsx`
- Create: `pwa/src/components/session/SetEditor.test.tsx`
- Modify: `pwa/src/screens/Session.tsx`
- Modify: `pwa/src/styles.css`

**Interfaces:**
- Consumes: the existing staged values and callbacks from `Session.tsx`, `ExerciseEntry`, `PlateBar`, unit formatters, and load-step definitions.
- Produces: `SetEditor`, a purely controlled component that emits user intent but never writes directly to the outbox or Supabase.

- [ ] **Step 1: Write component tests before extracting UI**

```tsx
it("shows per-hand input and a separate stored total", () => {
  render(<SetEditor {...perSideProps} />);
  expect(screen.getByText("30 kg per hand")).toBeTruthy();
  expect(screen.getByText("60 kg total")).toBeTruthy();
});

it("uses a completion action without numeric inputs for tick-only work", () => {
  render(<SetEditor {...tickProps} />);
  expect(screen.getByRole("button", { name: /done 1 of 3/i })).toBeTruthy();
  expect(screen.queryByRole("spinbutton", { name: /load/i })).toBeNull();
});

it("does not render a cable pin that the data model cannot support", () => {
  render(<SetEditor {...cableProps} />);
  expect(screen.queryByText(/pin/i)).toBeNull();
});
```

- [ ] **Step 2: Run the component test and confirm it fails**

Run: `npm test -- --run pwa/src/components/session/SetEditor.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Move the existing open-entry controls behind one controlled interface**

```ts
export interface SetEditorProps {
  entry: ExerciseEntry;
  draft: SetDraft;
  tracking: "reps" | "done";
  loadPresentation: { perSide: boolean; totalKg: number; plateSplit: PlateSplit | null };
  disabled: boolean;
  onDraftChange(next: Partial<SetEditorProps["draft"]>): void;
  onLog(): void;
  onOpenPlates(): void;
  onSkip(): void;
  onAddSet(): void;
  onStartCorrection(setId: string): void;
}

export type SetDraft = {
  entryKg: number;
  reps: number;
  setType: BracketKind;
  rpe: number | null;
};
```

Keep correction, notes, logged rows, rest display, plate sheet, and numeric-pad behavior accessible through explicit props or narrow slots. `SetEditor` must not own a second `useState` copy of staged load, reps, rating, or set type. When this task is complete, the accordion must look and behave as it did before the extraction.

- [ ] **Step 4: Run editor tests and the existing full suite**

Run: `npm test -- --run pwa/src/components/session/SetEditor.test.tsx && npm test && npm run typecheck`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the safe extraction**

```bash
git add pwa/src/components/session/SetEditor.tsx pwa/src/components/session/SetEditor.test.tsx pwa/src/screens/Session.tsx pwa/src/styles.css
git commit -m "Extract controlled session set editor"
```

### Task 4: Separate overview selection from accordion expansion

**Files:**
- Create: `pwa/src/components/session/WorkoutOverview.tsx`
- Create: `pwa/src/components/session/WorkoutOverview.test.tsx`
- Modify: `pwa/src/screens/Session.tsx`
- Modify: `pwa/src/styles.css`

**Interfaces:**
- Consumes: ordered `ExerciseEntry[]`, derived progress, existing overview callbacks, and the `SetEditor` from Task 3.
- Produces: `WorkoutOverview` with `selectedEntryKey`, `onSelectEntry`, and `onEnterFocus`.

- [ ] **Step 1: Write failing overview interaction tests**

```tsx
it("marks an overview entry selected without writing a set", () => {
  render(<WorkoutOverview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /bench press/i }));
  expect(onSelectEntry).toHaveBeenCalledWith("bench");
});

it("announces the selected exercise and exposes Focus mode", () => {
  render(<WorkoutOverview {...selectedProps} />);
  expect(screen.getByRole("button", { name: "Focus mode" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /bench press, selected/i })).toBeTruthy();
});
```

- [ ] **Step 2: Run the overview test and confirm it fails**

Run: `npm test -- --run pwa/src/components/session/WorkoutOverview.test.tsx`

Expected: FAIL because `WorkoutOverview` does not exist.

- [ ] **Step 3: Extract the accordion and give selection a distinct meaning**

```ts
export interface WorkoutOverviewProps {
  entries: readonly ExerciseEntry[];
  selectedEntryKey: string | null;
  onSelectEntry(key: string): void;
  onEnterFocus(): void;
  renderEditor(entry: ExerciseEntry): ReactNode;
}
```

An entry tap in overview sets the selected focus destination. Accordion expansion may remain a local rendering detail, but it must never clear or apply the active editor draft. `onEnterFocus` must call Task 1's `transitionPresentation` in `Session.tsx`, using the selected entry if present and otherwise the entry that was focused before overview opened.

- [ ] **Step 4: Run focused and regression tests**

Run: `npm test -- --run pwa/src/components/session/WorkoutOverview.test.tsx pwa/src/lib/sessionFocus.test.ts && npm test && npm run typecheck`

Expected: all commands exit 0.

- [ ] **Step 5: Commit overview extraction**

```bash
git add pwa/src/components/session/WorkoutOverview.tsx pwa/src/components/session/WorkoutOverview.test.tsx pwa/src/screens/Session.tsx pwa/src/styles.css
git commit -m "Add selectable workout overview"
```

### Task 5: Add the normal and tick-only focus deck behind a temporary setting

**Files:**
- Create: `pwa/src/components/session/FocusDeck.tsx`
- Create: `pwa/src/components/session/FocusDeck.test.tsx`
- Create: `pwa/src/screens/Session.focus.test.tsx`
- Modify: `pwa/src/screens/Session.tsx`
- Modify: `pwa/src/components/SettingsSheet.tsx`
- Modify: `pwa/src/components/SettingsSheet.test.tsx`
- Modify: `pwa/src/lib/settings.ts`
- Modify: `pwa/src/styles.css`

**Interfaces:**
- Consumes: `SetEditor`, Task 1's derived values, and callbacks owned by `Session.tsx`.
- Produces: `FocusDeck` with a `View full workout` action and a narrow-device rollout setting.

- [ ] **Step 1: Write failing focus-deck and session wiring tests**

```tsx
it("shows the current set plus remaining set and exercise counts", () => {
  render(<FocusDeck {...props} />);
  expect(screen.getByText("SETS REMAINING 4")).toBeTruthy();
  expect(screen.getByText("EXERCISES REMAINING 2")).toBeTruthy();
});

it("returns to overview without discarding staged values", () => {
  setSetting("focusDeckPreview", true);
  render(<Session />);
  fireEvent.change(screen.getByRole("spinbutton", { name: /reps/i }), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
  fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
  expect(screen.getByRole("spinbutton", { name: /reps/i })).toHaveValue(7);
});

it("keeps a timed session in overview and explains why focus is unavailable", () => {
  setSetting("focusDeckPreview", true);
  render(<Session />);
  expect(screen.queryByRole("button", { name: "View full workout" })).toBeNull();
  expect(screen.getByText(/duration tracking is not available in focus mode/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `npm test -- --run pwa/src/components/session/FocusDeck.test.tsx pwa/src/screens/Session.focus.test.tsx`

Expected: FAIL because focus mode and its rollout setting do not exist.

- [ ] **Step 3: Implement presentation switching without a second session state**

```ts
const focusDeckEnabled = useSetting("focusDeckPreview");
const [presentation, setPresentation] = useState<SessionPresentation>(
  focusDeckEnabled && isFocusEligible(entries) ? "focus" : "overview",
);
const [overviewSelection, setOverviewSelection] = useState<string | null>(null);
const priorFocusKey = useRef<string | null>(openKey);

function showOverview() {
  priorFocusKey.current = openKey;
  setPresentation("overview");
}

function showFocus() {
  const next = transitionPresentation("overview", "focus", overviewSelection, priorFocusKey.current);
  setOpenKey(next.focusKey ?? focusEntryKey(entries, entryDone, openKey));
  setPresentation("focus");
}
```

`FocusDeck` receives one current entry, `SetEditor`, and all write callbacks from `Session.tsx`. It shows the quiet top-left **View full workout** control, exercise/set position, derived remaining counts, next suggested exercise when the current entry is complete, and the honest plate/dumbbell/bodyweight/tick states defined in the spec. Use `aria-live="polite"` for focus entry and set/round position changes. Respect `prefersReducedMotion()` before scroll or deck transition animation.

Add `focusDeckPreview` to the existing `SETTINGS` registry in the `display` group with `{ kind: "toggle" }`, label `FOCUS MODE PREVIEW`, help `Use the focused set-entry view when a workout starts.`, default `false`, and a boolean parser. Read it through the existing `useSetting` hook and reset it with the rest of the registry in test setup. The setting is device-local, must not be written to Supabase, and is removed only in Task 8 after all release verification passes. Timed sessions ignore the setting and render the overview with the explicit duration message.

- [ ] **Step 4: Run focused tests, full tests, typecheck, and production build**

Run: `npm test -- --run pwa/src/components/session/FocusDeck.test.tsx pwa/src/screens/Session.focus.test.tsx pwa/src/components/SettingsSheet.test.tsx && npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the gated focus deck**

```bash
git add pwa/src/components/session/FocusDeck.tsx pwa/src/components/session/FocusDeck.test.tsx pwa/src/screens/Session.focus.test.tsx pwa/src/screens/Session.tsx pwa/src/components/SettingsSheet.tsx pwa/src/components/SettingsSheet.test.tsx pwa/src/lib/settings.ts pwa/src/styles.css
git commit -m "Add gated session focus deck"
```

### Task 6: Add explicit two-member superset round logging

**Files:**
- Create: `pwa/src/components/session/SupersetRoundEditor.tsx`
- Create: `pwa/src/components/session/SupersetRoundEditor.test.tsx`
- Modify: `pwa/src/screens/Session.tsx`
- Modify: `pwa/src/screens/Session.focus.test.tsx`
- Modify: `pwa/src/styles.css`

**Interfaces:**
- Consumes: a consecutive two-member run from existing `supersetPartner`, two controlled `SetEditor` drafts, and `outbox.enqueueBatch` from Task 2.
- Produces: `SupersetRoundEditor` and a Session-owned `logRound()` callback.

- [ ] **Step 1: Write failing round-editor tests**

```tsx
it("edits A1 and A2 independently and logs both with one action", () => {
  render(<SupersetRoundEditor {...props} />);
  fireEvent.change(screen.getByRole("spinbutton", { name: /a1 reps/i }), { target: { value: "8" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: /a2 reps/i }), { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Log round" }));
  expect(onLogRound).toHaveBeenCalledWith(expect.objectContaining({ a1: expect.objectContaining({ reps: 8 }), a2: expect.objectContaining({ reps: 12 }) }));
});

it("offers Log A1 only and never claims A2 is complete", () => {
  render(<SupersetRoundEditor {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));
  expect(onLogA1Only).toHaveBeenCalled();
  expect(screen.getByText(/a2.*remaining/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused component and session tests red**

Run: `npm test -- --run pwa/src/components/session/SupersetRoundEditor.test.tsx pwa/src/screens/Session.focus.test.tsx`

Expected: FAIL because `SupersetRoundEditor` and `logRound` are absent.

- [ ] **Step 3: Implement Session-owned round drafts and all-or-nothing local logging**

```ts
type SupersetRoundDraft = {
  keys: readonly [string, string];
  roundIndex: number;
  a1: SetDraft;
  a2: SetDraft;
};

async function logRound(round: SupersetRoundDraft) {
  if (!setsLoaded || setsFailed || !sessionId || logLocked) return;
  const inserts = [buildSetInsert(round.keys[0], round.a1), buildSetInsert(round.keys[1], round.a2)];
  await outbox.enqueueBatch(inserts.map((payload) => ({ kind: "insert", table: "sets", payload })));
  const next = applySets((prior) => [...prior, ...inserts]);
  await cacheSet(cacheKeys.sessionSets(sessionId), next);
}
```

Define `buildSetInsert(entryKey: string, draft: SetDraft): SetInsert` beside `logSet` in `Session.tsx`, then make the existing single-set path call it too. It must resolve the entry by key, assign a new UUID, calculate that exercise's next `set_index`, preserve the actual exercise id and prescription link, convert staged per-side load to stored total load, and attach that member's RPE and actual rest. Build both inserts before calling the queue. If `enqueueBatch` rejects, do not call `applySets`, do not clear either draft, and show a visible retryable local-storage error. Do not use client-side compensating deletes if later server replay accepts only one row. The ordinary outbox/dead-item surface remains the recovery surface.

Make **Log round** the primary action, label the card `SUPERSET A · ROUND n OF total`, and keep the pair in focus after a complete round until both entries are done. Make **Log A1 only** use the existing single-set path and clear only A1's draft. Do not add a manual Next action between the members.

- [ ] **Step 4: Run integration, outbox, full test, typecheck, and build gates**

Run: `npm test -- --run pwa/src/components/session/SupersetRoundEditor.test.tsx pwa/src/screens/Session.focus.test.tsx pwa/src/lib/outbox.test.ts && npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit superset round behavior**

```bash
git add pwa/src/components/session/SupersetRoundEditor.tsx pwa/src/components/session/SupersetRoundEditor.test.tsx pwa/src/screens/Session.tsx pwa/src/screens/Session.focus.test.tsx pwa/src/styles.css
git commit -m "Log superset rounds as atomic local batches"
```

### Task 7: Verify narrow-screen, offline, and accessibility behavior

**Files:**
- Modify: `pwa/src/screens/Session.focus.test.tsx`
- Modify: `pwa/src/styles.css`
- Modify: `docs/flows.md`

**Interfaces:**
- Consumes: completed Tasks 1-6 and the PWA's Vitest, typecheck, and production-build commands.
- Produces: documented, repeatable acceptance evidence for the focus-deck session path.

- [ ] **Step 1: Add the missing regression tests**

```tsx
it("does not show either member logged when local batch persistence fails", async () => {
  enqueueBatch.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
  render(<Session />);
  fireEvent.change(screen.getByRole("spinbutton", { name: /a1 reps/i }), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "Log round" }));
  expect(await screen.findByText(/could not save this round on this device/i)).toBeTruthy();
  expect(screen.getByRole("spinbutton", { name: /a1 reps/i })).toHaveValue(8);
});

it("keeps rest timing through focus and overview changes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
  render(<Session />);
  fireEvent.click(screen.getByRole("button", { name: /log set/i }));
  fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
  fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
  vi.advanceTimersByTime(30_000);
  expect(screen.getByText("0:30")).toBeTruthy();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run the new regression tests red**

Run: `npm test -- --run pwa/src/screens/Session.focus.test.tsx`

Expected: FAIL until local enqueue failure and rest continuity are correctly wired.

- [ ] **Step 3: Finish mobile and accessibility styling**

Add styles under a dedicated `/* ---- session focus deck ---- */` block. Ensure a 44px minimum hit target for **View full workout**, **Focus mode**, logs, skip, correction, and extra set. Keep all text controls at compliant contrast, supply `:focus-visible` outlines, make the deck safe around `env(safe-area-inset-bottom)`, and turn off deck/scroll animation under `prefers-reduced-motion: reduce`. Do not change the existing floating dock in this task.

Update `docs/flows.md` so it describes both presentation modes, selection return behavior, batch-local versus server atomicity, and the deliberate time-tracking limitation.

- [ ] **Step 4: Run all automated gates**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 5: Run manual narrow-phone acceptance checks**

Run: `npm run dev -- --host 127.0.0.1`

Using a 360px-wide browser viewport, verify and record each result:

1. Start or resume a reps workout with the local switch enabled, it opens in focus.
2. Log one normal set, then confirm both remaining counters change from canonical rows.
3. Stage an edit, open overview, select another exercise, return to focus, and confirm the first draft is still intact.
4. Log a two-member superset round offline after its local queue is durable, then reconnect and confirm ordered replay in the Outbox surface.
5. Use **Log A1 only** and confirm A2 stays unfinished.
6. Verify a tick-only exercise has no load or reps control.
7. Verify a timed exercise keeps the session in overview with the duration limitation copy.
8. Navigate controls by keyboard and use a reduced-motion preference.

Expected: all eight checks pass without console errors or duplicate/out-of-order set rows.

- [ ] **Step 6: Commit regression coverage and documentation**

```bash
git add pwa/src/screens/Session.focus.test.tsx pwa/src/styles.css docs/flows.md
git commit -m "Verify session focus deck flow"
```

### Task 8: Remove the temporary switch and make focus the default

**Files:**
- Modify: `pwa/src/screens/Session.tsx`
- Modify: `pwa/src/components/SettingsSheet.tsx`
- Modify: `pwa/src/components/SettingsSheet.test.tsx`
- Modify: `pwa/src/lib/settings.ts`
- Modify: `pwa/src/screens/Session.focus.test.tsx`
- Modify: `docs/flows.md`

**Interfaces:**
- Consumes: passing implementation and evidence from Task 7.
- Produces: focus as the default on Start/resume for eligible sessions; overview remains available through **View full workout**.

- [ ] **Step 1: Change the initial presentation test first**

```tsx
it("opens an eligible started or restored session in focus mode by default", () => {
  render(<Session />);
  expect(screen.getByRole("button", { name: "View full workout" })).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused session test and confirm it fails while the switch still gates focus**

Run: `npm test -- --run pwa/src/screens/Session.focus.test.tsx`

Expected: FAIL until the local switch is removed.

- [ ] **Step 3: Remove the setting and make the default explicit**

```ts
const initialPresentation: SessionPresentation = isFocusEligible(entries)
  ? "focus"
  : "overview";
```

Remove the early-access setting, its local-storage key, tests, and copy. Keep the time tracking fallback in overview. Do not persist focus/overview across reload: on restore, determine the focus entry from the current canonical session state.

- [ ] **Step 4: Re-run the complete release gate and repeat the phone smoke check**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0. Repeat Task 7's eight manual checks at 360px with focus mode now default for eligible sessions.

- [ ] **Step 5: Commit the production default**

```bash
git add pwa/src/screens/Session.tsx pwa/src/components/SettingsSheet.tsx pwa/src/components/SettingsSheet.test.tsx pwa/src/lib/settings.ts pwa/src/screens/Session.focus.test.tsx docs/flows.md
git commit -m "Make session focus mode the default"
```

## Completion checklist

- [ ] Re-read `docs/superpowers/specs/2026-09-12-session-focus-deck-design.md` and verify every non-goal still holds.
- [ ] Confirm there is exactly one owner of each session draft and canonical set list.
- [ ] Confirm `enqueueBatch` is local-atomic, replay-ordered, and uses ordinary operations only.
- [ ] Confirm no focus surface renders an invented cable pin, fake zero load, or doubled per-hand dumbbell value.
- [ ] Confirm time tracking has not been silently represented as reps.
- [ ] Confirm all tests, typecheck, build, and Task 7 phone acceptance checks have fresh recorded passing evidence before Task 8 or any completion claim.
