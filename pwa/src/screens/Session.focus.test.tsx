// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  cacheGet,
  cacheKeys,
  cacheSet,
  getDb,
  resetDbForTests,
  type Database,
} from "../lib/db";
import { createOutbox, type OutboxTransport } from "../lib/outbox";
import { getUnit, resetAllSettings, setSetting } from "../lib/settings";
const receiptIdentity = vi.hoisted(() => ({
  userId: "aaaaaaaa-1111-4111-8111-111111111111" as string | null,
  listeners: new Set<(id: string | null) => void>(),
  syncedListeners: new Set<(
    op: any,
    ownerId: string | null | undefined,
    correctionLink?: { session_id: string; replacement_id: string; original_id: string },
  ) => void>(),
}));

import type {
  ActiveSession,
  ResolvedPrescriptionRow,
  SetInsert,
} from "../lib/types";

vi.mock("../lib/data", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    ...actual,
    getExercises: vi.fn(async () => ({ data: [] })),
    getLastActuals: vi.fn(async () => ({ data: {} })),
    getServerSessionSets: vi.fn(async () => []),
    getSetNotesByIds: vi.fn(async () => ({})),
    getExactSetReceiptIds: vi.fn(async () => ({ setIds: new Set<string>(), voidIds: new Set<string>() })),
  };
});

vi.mock("../lib/currentUser", () => ({
  getCurrentUserId: () => receiptIdentity.userId,
  onUserChange: (fn: (id: string | null) => void) => {
    receiptIdentity.listeners.add(fn);
    return () => receiptIdentity.listeners.delete(fn);
  },
}));

vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    enqueueBatch: vi.fn(async () => undefined),
    enqueueCorrection: vi.fn(async () => undefined),
    inspect: vi.fn(async () => []),
    correctionLinks: vi.fn(async () => ({})),
    subscribe: vi.fn(() => () => undefined),
    subscribeSynced: vi.fn((fn: (op: any, ownerId: string | null | undefined) => void) => {
      receiptIdentity.syncedListeners.add(fn);
      return () => receiptIdentity.syncedListeners.delete(fn);
    }),
    getStatus: vi.fn(() => ({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null })),
  },
}));

import { Session } from "./Session";
import { outbox } from "../lib/sync";
import { getExercises, getExactSetReceiptIds, getLastActuals, getServerSessionSets } from "../lib/data";

const active: ActiveSession = {
  id: "session-focus-1",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function prescription(
  id = "bench",
  exerciseId = "bench-press",
  name = "Bench Press",
  tracking: ResolvedPrescriptionRow["tracking"] = "reps",
  supersetGroup: number | null = null,
  sets = 2,
): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position: id === "bench" ? 0 : 1,
    sets,
    reps_min: 8,
    reps_max: 8,
    rest_seconds: 60,
    notes: null,
    load_kg: 20,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 20,
    plate_load_kg: null,
    superset_group: supersetGroup,
    tracking,
  };
}

async function seed(
  tracking: ResolvedPrescriptionRow["tracking"] = "reps",
  rows: ResolvedPrescriptionRow[] = [
    prescription("bench", "bench-press", "Bench Press", tracking),
  ],
  sets: SetInsert[] = [],
) {
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), rows);
  await cacheSet(cacheKeys.sessionSets(active.id), sets);
}

// Same arithmetic as validate_entered_load_consistency() in the applied
// Postgres migration. The queue payload must pass before it reaches the phone.
function expectAcceptedAuthoredLoad(payload: SetInsert) {
  expect(payload.entered_load).not.toBeNull();
  const expectedTotal = Math.round(
    payload.entered_load! * (payload.entered_unit === "lb" ? 0.45359237 : 1) *
      (payload.load_entry === "per_side" ? 2 : 1) * 100,
  ) / 100;
  expect(payload.load_kg).toBe(expectedTotal);
}

function firstQueuedSet(): SetInsert {
  const op = vi.mocked(outbox.enqueue).mock.calls[0]?.[0];
  if (op?.kind !== "insert" || op.table !== "sets") {
    throw new Error("expected a queued set insert");
  }
  return op.payload;
}

async function outboxWithFailedCountRefresh() {
  const db = await getDb();
  const failingReadDb = {
    add: (...args: Parameters<Database["add"]>) => db.add(...args),
    transaction: (store: "outbox", mode?: "readonly" | "readwrite") => {
      if (mode === undefined) throw new Error("count refresh failed");
      return db.transaction(store, mode);
    },
  } as unknown as Database;
  const transport: OutboxTransport = {
    insert: async () => null,
    update: async () => null,
  };
  return createOutbox({
    getDb: () => Promise.resolve(failingReadDb),
    transport,
    isOnline: () => false,
  });
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  resetAllSettings();
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(getExercises).mockReset();
  vi.mocked(getLastActuals).mockReset();
  vi.mocked(getServerSessionSets).mockReset();
  vi.mocked(getExactSetReceiptIds).mockReset();
  vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set(), voidIds: new Set() });
  receiptIdentity.userId = "aaaaaaaa-1111-4111-8111-111111111111";
  receiptIdentity.listeners.clear();
  receiptIdentity.syncedListeners.clear();
  vi.mocked(outbox.inspect).mockReset();
  vi.mocked(outbox.inspect).mockResolvedValue([]);
  vi.mocked(outbox.correctionLinks).mockReset();
  vi.mocked(outbox.correctionLinks).mockResolvedValue({});
  vi.mocked(outbox.subscribe).mockReset();
  vi.mocked(outbox.subscribe).mockReturnValue(() => undefined);
  vi.mocked(outbox.subscribeSynced).mockReset();
  vi.mocked(outbox.subscribeSynced).mockImplementation((fn) => {
    receiptIdentity.syncedListeners.add(fn as any);
    return () => receiptIdentity.syncedListeners.delete(fn as any);
  });
  vi.mocked(outbox.getStatus).mockReturnValue({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null });
  vi.mocked(outbox.enqueue).mockReset();
  vi.mocked(outbox.enqueueBatch).mockReset();
  vi.mocked(outbox.enqueueCorrection).mockReset();
  vi.mocked(getExercises).mockResolvedValue({
    data: [],
    error: null,
    status: 200,
    statusText: "OK",
  } as any);
  vi.mocked(getLastActuals).mockResolvedValue({
    data: {},
    fromCache: false,
    stale: null,
  } as any);
  vi.mocked(getServerSessionSets).mockResolvedValue([] as any);
  vi.mocked(outbox.enqueue).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueBatch).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueCorrection).mockResolvedValue(undefined);
  await seed();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  cleanup();
  resetAllSettings();
});

describe("Session focus presentation", () => {
  it("opens an eligible started or restored session in focus mode by default", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: /— current — view full workout$/ }),
    ).toBeTruthy();
    expect(screen.queryByText(/target 8/i)).toBeNull();
    expect(document.body.classList.contains("focus-chrome-hidden")).toBe(true);
  });

  it("shows one compact latest-set line for the substituted movement", async () => {
    await cacheSet(cacheKeys.sessionSwaps(active.id), {
      bench: {
        exercise_id: "dumbbell-bench",
        name: "Dumbbell Bench Press",
        planned_exercise_id: "bench-press",
        planned_name: "Bench Press",
      },
    });
    vi.mocked(getLastActuals).mockResolvedValue({
      data: {
        "dumbbell-bench": {
          load_kg: 22.5,
          reps: 7,
          run: [
            { load_kg: 20, reps: 8 },
            { load_kg: 22.5, reps: 7 },
          ],
        },
        "bench-press": { load_kg: 100, reps: 1 },
      },
      fromCache: false,
      stale: null,
    });
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Last time · 22.5 kg × 7")).toBeTruthy();
    expect(screen.queryByText("Last time · 100 kg × 1")).toBeNull();
    expect(screen.getAllByText(/Last time ·/i)).toHaveLength(1);
  });

  it("returns to overview without discarding staged values", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /— current — view full workout$/ }),
    );
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");
  });

  it("asks before Home can discard an ordinary staged set and Stay keeps it", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "back to Today — session keeps running",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Unlogged set changes",
    });
    expect(dialog.textContent).toMatch(/held only on this screen/i);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stay in session" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");
  });

  it("preserves a staged draft after switching focus to another exercise", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    fireEvent.click(
      screen.getByRole("button", { name: "increase load by 2.5 kg" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /— current — view full workout$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back Squat(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(
      await screen.findByRole("heading", { name: "Back Squat" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /— current — view full workout$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Bench Press(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(
      await screen.findByRole("heading", { name: "Bench Press" }),
    ).toBeTruthy();

    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");
    expect(
      screen.getByRole("button", { name: "load value — tap to type" })
        .textContent,
    ).toBe("22.5");
  });

  it("opens timed work in focus with duration as the hero and logs seconds", async () => {
    resetDbForTests();
    await seed("time");
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "duration value — tap to type" }).textContent).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 0, duration_seconds: 60 },
    });
  });

  it("keeps normal focus navigation and logging on the same entry", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 1),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 8, load_kg: 20 },
    });
    expect(await screen.findByRole("heading", { name: "Back Squat" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      payload: { exercise_id: "back-squat", prescription_id: "squat" },
    });
  });

  it("logs the staged values from the focus set editor", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));

    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 8, load_kg: 20 },
    });
  });

  it("requires local intent and a second tap before logging an extra set", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
    ]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    await screen.findByRole("button", { name: "Finish workout" });
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Add extra set" }));
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("button", { name: "Log extra set" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      table: "sets",
      payload: { exercise_id: "bench-press", set_index: 1 },
    });
  });

  it("shows and logs a prescription in its durable authored unit", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    const bench = prescription();
    bench.load_kg = 102.17;
    bench.resolved_load_kg = 102.17;
    bench.entered_load = 225.25;
    bench.entered_unit = "lb";
    await seed("reps", [bench]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("225.25"),
    );
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { entered_load: 225.25, entered_unit: "lb" },
    });
  });

  it("logs the rounded visible lb value of a kg-authored total", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    const bench = { ...prescription(), load_kg: 100, resolved_load_kg: 100,
      entered_load: 100, entered_unit: "kg" as const, load_entry: "total" as const };
    await seed("reps", [bench]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await vi.waitFor(() => expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("220.5"));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 100.02, entered_load: 220.5, entered_unit: "lb", load_entry: "total" });
    expectAcceptedAuthoredLoad(payload);
  });

  it("logs per-side lb provenance and canonical total from the same number", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    const pair = { ...prescription("pair", "dumbbell-bench", "Dumbbell Bench Press"),
      load_kg: 100, resolved_load_kg: 100, entered_load: 50,
      entered_unit: "kg" as const, load_entry: "per_side" as const };
    await seed("reps", [pair]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await vi.waitFor(() => expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("110.2"));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 99.97, entered_load: 110.2, entered_unit: "lb", load_entry: "per_side" });
    expectAcceptedAuthoredLoad(payload);
  });

  it("logs an explicitly typed lb load without rounding its authored number", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    const bench = { ...prescription(), load_kg: 100, resolved_load_kg: 100,
      entered_load: 100, entered_unit: "kg" as const, load_entry: "total" as const };
    await seed("reps", [bench]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 102.06, entered_load: 225, entered_unit: "lb", load_entry: "total" });
    expectAcceptedAuthoredLoad(payload);
  });

  it("switches the workout unit without changing a staged load or queuing stale provenance", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    await seed();
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    expect(screen.getByRole("button", { name: "Show weights in pounds" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Show weights in kilograms" }));
    expect(screen.getByRole("button", { name: "Show weights in kilograms" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("102.06");

    fireEvent.click(screen.getByRole("button", { name: /— current — view full workout$/ }));
    expect(screen.getByRole("button", { name: "Show weights in kilograms" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 102.06, entered_load: 225, entered_unit: "lb" });
    expectAcceptedAuthoredLoad(payload);
  });

  it("persists the unit for this owner and session without changing the device default", async () => {
    resetDbForTests();
    setSetting("unit", "kg");
    await seed();
    const first = render(<MemoryRouter><Session /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Show weights in pounds" }));
    await vi.waitFor(() => expect(cacheGet(cacheKeys.sessionPrefs(receiptOwner, active.id))).resolves.toMatchObject({ unit: "lb" }));
    expect(getUnit()).toBe("kg");
    first.unmount();

    render(<MemoryRouter><Session /></MemoryRouter>);
    expect((await screen.findByRole("button", { name: "Show weights in pounds" })).getAttribute("aria-pressed")).toBe("true");
    expect(getUnit()).toBe("kg");
  });

  it("uses the device default for another session and for a different owner", async () => {
    resetDbForTests();
    setSetting("unit", "kg");
    await seed();
    const first = render(<MemoryRouter><Session /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Show weights in pounds" }));
    await vi.waitFor(() => expect(cacheGet(cacheKeys.sessionPrefs(receiptOwner, active.id))).resolves.toMatchObject({ unit: "lb" }));
    first.unmount();

    render(<MemoryRouter><Session /></MemoryRouter>);
    expect((await screen.findByRole("button", { name: "Show weights in pounds" })).getAttribute("aria-pressed")).toBe("true");
    receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId); });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Show weights in kilograms" }).getAttribute("aria-pressed")).toBe("true"));
    expect(await cacheGet(cacheKeys.sessionPrefs(receiptIdentity.userId, active.id))).toBeUndefined();
    receiptIdentity.userId = receiptOwner;
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId); });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Show weights in pounds" }).getAttribute("aria-pressed")).toBe("true"));
    cleanup();

    const nextSession = { ...active, id: "session-focus-next" };
    await cacheSet(cacheKeys.activeSession, nextSession);
    await cacheSet(cacheKeys.sessionRx(nextSession.id), [prescription()]);
    await cacheSet(cacheKeys.sessionSets(nextSession.id), []);
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect((await screen.findByRole("button", { name: "Show weights in kilograms" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("restores the exact typed pound value when switching back during the same set", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    await seed();
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "." }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));

    fireEvent.click(screen.getByRole("button", { name: "Show weights in kilograms" }));
    fireEvent.click(screen.getByRole("button", { name: "Show weights in pounds" }));
    expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("225.25");
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 102.17, entered_load: 225.25, entered_unit: "lb" });
    expectAcceptedAuthoredLoad(payload);
  });

  it("restores the next-set draft after switching units and cancelling a correction", async () => {
    resetDbForTests();
    const old: SetInsert = {
      id: "bench-correction-1", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working",
      load_kg: 30, reps: 8, performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null, load_entry: "total", rpe: null,
    };
    await seed("reps", [prescription("bench", "bench-press", "Bench Press", "reps", null, 2)], [old]);
    vi.mocked(getServerSessionSets).mockResolvedValue([old]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    fireEvent.click(screen.getByRole("button", { name: "Last: 30 kg × 8 working" }));
    fireEvent.click(screen.getByRole("button", { name: "Show weights in pounds" }));
    fireEvent.click(screen.getByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "6" }));
    fireEvent.click(screen.getByRole("button", { name: "6" }));
    fireEvent.click(screen.getByRole("button", { name: "." }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel correction" }));

    expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("110.23");
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 50, entered_load: 50, entered_unit: "kg", set_index: 1 });
    expectAcceptedAuthoredLoad(payload);
  });

  it("saves a pound-edited correction with matching canonical kg", async () => {
    resetDbForTests();
    const old: SetInsert = {
      id: "bench-correction-2", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working",
      load_kg: 30, reps: 8, performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null, load_entry: "total", rpe: null,
    };
    await seed("reps", [prescription("bench", "bench-press", "Bench Press", "reps", null, 2)], [old]);
    vi.mocked(getServerSessionSets).mockResolvedValue([old]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "Last: 30 kg × 8 working" }));
    fireEvent.click(screen.getByRole("button", { name: "Show weights in pounds" }));
    fireEvent.click(screen.getByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const [sessionId, payload, originalId] = vi.mocked(outbox.enqueueCorrection).mock.calls[0]!;
    expect(sessionId).toBe(active.id);
    expect(originalId).toBe(old.id);
    expect(payload).toMatchObject({ load_kg: 31.75, entered_load: 70, entered_unit: "lb", load_entry: "total", set_index: 0 });
    expectAcceptedAuthoredLoad(payload);
  });

  it("keeps the original visible when the correction transaction fails", async () => {
    const old: SetInsert = {
      id: "bench-correction-failed", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working",
      load_kg: 30, reps: 8, performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null, load_entry: "total", rpe: null,
    };
    await seed("reps", [prescription()], [old]);
    await cacheSet(cacheKeys.sessionSetNotes(active.id), { [old.id]: "Grip felt uneven" });
    vi.mocked(getServerSessionSets).mockResolvedValue([old]);
    vi.mocked(outbox.enqueueCorrection).mockRejectedValueOnce(new Error("disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<MemoryRouter><Session /></MemoryRouter>);
      fireEvent.click(await screen.findByRole("button", { name: "Last: 30 kg × 8 working" }));
      fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
      fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));

      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("[correct set]", expect.any(Error)));
      expect(await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))).toEqual([old]);
      expect(await cacheGet<string[]>(cacheKeys.sessionVoids(active.id))).toBeUndefined();
      expect(await cacheGet<Record<string, string>>(cacheKeys.sessionSetNotes(active.id)))
        .toEqual({ [old.id]: "Grip felt uneven" });
      expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel correction" }));
      fireEvent.click(screen.getByRole("button", { name: "List" }));
      expect(screen.getByRole("button", { name: "Correct logged set 1" })).toBeTruthy();
      expect(vi.mocked(outbox.enqueue)).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the rated set and rest source when quick RPE enqueue fails", async () => {
    vi.mocked(outbox.enqueueCorrection).mockRejectedValueOnce(new Error("disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<MemoryRouter><Session /></MemoryRouter>);
      fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
      await screen.findByRole("button", { name: "rpe 6.5" });
      const before = await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id));
      const restBefore = await cacheGet(cacheKeys.sessionRest(active.id));
      expect(before).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "rpe 6.5" }));
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("[rate set]", expect.any(Error)));

      expect(await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))).toEqual(before);
      expect(await cacheGet<string[]>(cacheKeys.sessionVoids(active.id))).toBeUndefined();
      expect(await cacheGet(cacheKeys.sessionRest(active.id))).toEqual(restBefore);
      expect(screen.getByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps a logged row visible when plain void enqueue fails", async () => {
    const old: SetInsert = {
      id: "bench-void-failed", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working",
      load_kg: 30, reps: 8, performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null, load_entry: "total", rpe: null,
    };
    await seed("reps", [prescription()], [old]);
    vi.mocked(getServerSessionSets).mockResolvedValue([old]);
    vi.mocked(outbox.enqueue).mockRejectedValueOnce(new Error("disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<MemoryRouter><Session /></MemoryRouter>);
      await screen.findByRole("button", { name: /— current — view full workout$/ });
      fireEvent.click(await screen.findByRole("button", { name: "List" }));
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true"));
      fireEvent.click(await screen.findByRole("button", { name: "Void logged set 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm void logged set 1" }));
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("[remove set]", expect.any(Error)));

      expect(await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))).toEqual([old]);
      expect(await cacheGet<string[]>(cacheKeys.sessionVoids(active.id))).toBeUndefined();
      expect(screen.getByRole("button", { name: "Correct logged set 1" })).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps a corrected stepper load consistent after changing to pounds", async () => {
    resetDbForTests();
    const old: SetInsert = {
      id: "bench-correction-3", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working",
      load_kg: 30, reps: 8, performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null, load_entry: "total", rpe: null,
    };
    await seed("reps", [prescription("bench", "bench-press", "Bench Press", "reps", null, 2)], [old]);
    vi.mocked(getServerSessionSets).mockResolvedValue([old]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "Last: 30 kg × 8 working" }));
    fireEvent.click(screen.getByRole("button", { name: "Show weights in pounds" }));
    fireEvent.click(screen.getByRole("button", { name: "increase load by 5 lb" }));
    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1];
    expect(payload.entered_unit).toBe("lb");
    expect(payload.load_kg).not.toBe(old.load_kg);
    expectAcceptedAuthoredLoad(payload);
  });

  it("routes Note last set to the set_notes outbox row", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
    ]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    await screen.findByRole("button", { name: "Note last set" });
    fireEvent.click(screen.getByRole("button", { name: "Note last set" }));
    const note = await screen.findByPlaceholderText("Note on this set…");
    fireEvent.change(note, { target: { value: "Grip felt uneven" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      table: "set_notes",
      payload: { note: "Grip felt uneven" },
    });
  });

  it("keeps an ordinary set editable when its local queue write fails", async () => {
    let rejectQueue!: (reason?: unknown) => void;
    vi.mocked(outbox.enqueue).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectQueue = reject;
        }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      render(
        <MemoryRouter>
          <Session />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
      await vi.waitFor(() =>
        expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("LOGGED")).toBeNull();
      expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
      expect(
        await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id)),
      ).toEqual([]);

      await act(async () => {
        rejectQueue(new Error("IndexedDB unavailable"));
        await Promise.resolve();
      });

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /could not be saved locally.*retry/i,
      );
      expect(screen.getByRole("button", { name: "LOG SET" })).toBeTruthy();
      expect(screen.queryByText("LOGGED")).toBeNull();
      expect(
        screen.getByRole("button", { name: "reps value — tap to type" })
          .textContent,
      ).toBe("8");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("treats an ordinary set as saved when only the count refresh fails", async () => {
    const durableOutbox = await outboxWithFailedCountRefresh();
    vi.mocked(outbox.enqueue).mockImplementationOnce((op) =>
      durableOutbox.enqueue(op),
    );
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));

    expect(
      await screen.findByText("Last: 20 kg × 8 working"),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    expect(await (await getDb()).getAll("outbox")).toHaveLength(1);
  });

  it("logs a bodyweight movement with no load at zero, never the hidden bar fallback", async () => {
    resetDbForTests();
    vi.mocked(getExercises).mockResolvedValue({
      data: [{ id: "push-up", name: "Push Up", equipment: "body only" }],
    } as unknown as Awaited<ReturnType<typeof getExercises>>);
    const row = prescription("pushup", "push-up", "Push Up", "reps", null, 2);
    await seed("reps", [
      { ...row, load_kg: null, resolved_load_kg: null, plate_load_kg: null },
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: "LOG SET" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
        payload: { exercise_id: "push-up", load_kg: 0 },
      }),
    );
    vi.mocked(getExercises).mockResolvedValue({ data: [] } as unknown as Awaited<
      ReturnType<typeof getExercises>
    >);
  });

  it("shows bodyweight history as reps without inventing a zero-kilogram load", async () => {
    resetDbForTests();
    vi.mocked(getExercises).mockResolvedValue({
      data: [{ id: "push-up", name: "Push Up", equipment: "body only" }],
    } as unknown as Awaited<ReturnType<typeof getExercises>>);
    vi.mocked(getLastActuals).mockResolvedValue({
      data: { "push-up": { load_kg: 0, reps: 12 } },
      fromCache: false,
      stale: null,
    });
    const row = prescription("pushup", "push-up", "Push Up", "reps", null, 2);
    await seed("reps", [
      { ...row, load_kg: null, resolved_load_kg: null, plate_load_kg: null },
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Last time · 12 reps")).toBeTruthy();
    expect(screen.queryByText(/0 kg/i)).toBeNull();
  });

  it("omits zero-value history for completion tracking", async () => {
    resetDbForTests();
    vi.mocked(getLastActuals).mockResolvedValue({
      data: { "farmer-carry": { load_kg: 0, reps: 0 } },
      fromCache: false,
      stale: null,
    });
    await seed("done", [
      prescription("carry", "farmer-carry", "Farmer Carry", "done", null, 1),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "DONE" })).toBeTruthy();
    expect(screen.queryByText(/Last time/i)).toBeNull();
  });

  it("keeps tick-only focus navigation and logging on the same entry", async () => {
    resetDbForTests();
    // See the "reverse route" test below: an earlier test's
    // `getServerSessionSets.mockResolvedValue` (no "Once") outlives
    // `vi.clearAllMocks()` in `beforeEach`, which only clears call history.
    // Pin this test's own server response so a completed Bench Press left
    // over from an earlier test can't make focus skip straight to Farmer
    // Carry before "LOG SET" ever appears.
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("carry", "farmer-carry", "Farmer Carry", "done", null, 1),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    expect(await screen.findByRole("heading", { name: "Farmer Carry" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "DONE" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      payload: {
        exercise_id: "farmer-carry",
        prescription_id: "carry",
        load_kg: 0,
        reps: 0,
      },
    });
  });

  it("does not expose focus next while a superset is unfinished", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // A live round names itself, not its first member — see "Superset A" /
    // "round 1 of 1" below — so the duplicated exercise-name heading is gone.
    expect(
      await screen.findByRole("heading", { name: "Superset A" }),
    ).toBeTruthy();
    expect(screen.getByText("round 1 of 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next exercise" })).toBeNull();
  });

  it("shows one compact historical line for each superset member", async () => {
    resetDbForTests();
    vi.mocked(getLastActuals).mockResolvedValue({
      data: {
        "bench-press": { load_kg: 20, reps: 8 },
        "barbell-row": { load_kg: 50, reps: 10 },
      },
      fromCache: false,
      stale: null,
    });
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Last time · 20 kg × 8")).toBeTruthy();
    expect(screen.getByText("Last time · 50 kg × 10")).toBeTruthy();
  });

  it("keeps each member's authored load and unit in its round draft", async () => {
    resetDbForTests();
    setSetting("unit", "lb");
    const authoredBench = {
      ...prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      load_kg: 102.17,
      resolved_load_kg: 102.17,
      entered_load: 225.25,
      entered_unit: "lb" as const,
    };
    await seed("reps", [
      authoredBench,
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 2");
    const a1 = await screen.findByLabelText("A1 Bench Press");
    await vi.waitFor(() =>
      expect(within(a1).getByRole("button", { name: /load value/ }).textContent)
        .toBe("225.25"),
    );
    expect(a1.textContent).toContain("lb");
  });

  it("logs both members of a superset round through one ordered local batch", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("round 1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    const ops = vi.mocked(outbox.enqueueBatch).mock.calls[0]?.[0] ?? [];
    expect(ops).toHaveLength(2);
    expect(ops).toMatchObject([
      {
        kind: "insert",
        table: "sets",
        payload: {
          exercise_id: "bench-press",
          prescription_id: "bench",
          set_index: 0,
        },
      },
      {
        kind: "insert",
        table: "sets",
        payload: {
          exercise_id: "barbell-row",
          prescription_id: "row",
          set_index: 0,
        },
      },
    ]);
    const [first, second] = ops.filter(
      (op): op is Extract<typeof op, { kind: "insert"; table: "sets" }> =>
        op.kind === "insert" && op.table === "sets",
    );
    expect(first?.payload.id).not.toBe(second?.payload.id);
    expect(screen.queryByRole("button", { name: "Next exercise" })).toBeNull();
  });

  it("keeps both staged superset loads stable on the first unit switch", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Show weights in pounds" }));
    const a1 = screen.getByLabelText("A1 Bench Press");
    const a2 = screen.getByLabelText("A2 Barbell Row");
    expect(within(a1).getByRole("button", { name: /load value/ }).textContent).toBe("44.09");
    expect(within(a2).getByRole("button", { name: /load value/ }).textContent).toBe("44.09");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1));
    const ops = vi.mocked(outbox.enqueueBatch).mock.calls[0]?.[0] ?? [];
    for (const op of ops) {
      if (op.kind !== "insert" || op.table !== "sets") continue;
      expect(op.payload).toMatchObject({
        load_kg: 20,
        entered_load: 20,
        entered_unit: "kg",
      });
      expectAcceptedAuthoredLoad(op.payload);
    }
  });

  it("rests only after full non-final rounds and names the next A1 round", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 3),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 3),
      { ...prescription("curl", "cable-curl", "Cable Curl"), position: 2 },
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    const rest = await screen.findByRole("timer", { name: "rest timer" });
    expect(rest.textContent).toContain("Next: Superset A, round 2 of 3");

    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("timer", { name: "rest timer" }).textContent)
        .toContain("Next: Superset A, round 3 of 3"),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(3),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull(),
    );
    expect(await screen.findByRole("heading", { name: "Cable Curl" })).toBeTruthy();
  });

  it("keeps three-member circuits in overview and explains why paired Focus is unavailable", async () => {
    resetDbForTests();
    await seed("reps", [
      { ...prescription("bench", "bench-press", "Bench Press", "reps", 1, 2), position: 0 },
      { ...prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2), position: 1 },
      { ...prescription("curl", "cable-curl", "Cable Curl", "reps", 1, 2), position: 2 },
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText(
      "3-member Superset A is an overview-only circuit. Paired Focus supports exactly two members.",
    )).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Superset A" })).toBeNull();
  });

  it("keeps both drafts visible when the local round batch fails", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    await cacheSet(cacheKeys.sessionSkips(active.id), ["row"]);
    vi.mocked(outbox.enqueueBatch).mockRejectedValueOnce(
      new Error("disk full"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      render(
        <MemoryRouter>
          <Session />
        </MemoryRouter>,
      );

      await screen.findByText("round 1 of 2");
      fireEvent.click(
        screen.getAllByRole("button", { name: "increase load by 2.5 kg" })[0],
      );
      fireEvent.click(screen.getByRole("button", { name: "Log round" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /could not be saved locally.*retry/i,
      );
      expect(screen.getByLabelText("A1 Bench Press").textContent).toContain(
        "22.5",
      );
      expect(
        await cacheGet<string[] | Record<string, unknown>>(
          cacheKeys.sessionSkips(active.id),
        ),
      ).toEqual(["row"]);
      expect(screen.queryByText("LOGGED")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps both member drafts when saving a single-member set fails", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    let rejectQueue!: (reason?: unknown) => void;
    vi.mocked(outbox.enqueue).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectQueue = reject;
        }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      render(
        <MemoryRouter>
          <Session />
        </MemoryRouter>,
      );

      expect(await screen.findByText("round 1 of 2")).toBeTruthy();
      const increaseLoad = screen.getAllByRole("button", {
        name: "increase load by 2.5 kg",
      });
      fireEvent.click(increaseLoad[0]!);
      fireEvent.click(increaseLoad[1]!);
      fireEvent.click(increaseLoad[1]!);
      fireEvent.click(screen.getByRole("button", { name: "Log Bench Press only" }));
      await vi.waitFor(() =>
        expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("LOGGED")).toBeNull();
      expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Log Bench Press only" })).toBeTruthy();
      expect(screen.getByLabelText("A1 Bench Press").textContent).toContain(
        "22.5",
      );
      expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain(
        "25",
      );
      expect(
        await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id)),
      ).toEqual([]);

      await act(async () => {
        rejectQueue(new Error("IndexedDB unavailable"));
        await Promise.resolve();
      });

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /could not be saved locally.*retry/i,
      );
      expect(screen.getByLabelText("A1 Bench Press").textContent).toContain(
        "22.5",
      );
      expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain(
        "25",
      );
      expect(screen.getByText("round 1 of 2")).toBeTruthy();
      expect(screen.queryByText("LOGGED")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not offer a duplicate retry for an A1-only write with a count refresh failure", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    const durableOutbox = await outboxWithFailedCountRefresh();
    vi.mocked(outbox.enqueue).mockImplementationOnce((op) =>
      durableOutbox.enqueue(op),
    );
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("round 1 of 2")).toBeTruthy();
    const loadButtons = screen.getAllByRole("button", {
      name: "increase load by 2.5 kg",
    });
    fireEvent.click(loadButtons[0]!);
    fireEvent.click(loadButtons[1]!);
    fireEvent.click(loadButtons[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Log Bench Press only" }));

    await vi.waitFor(async () => {
      expect(await (await getDb()).getAll("outbox")).toHaveLength(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });
    await vi.waitFor(() =>
      expect(
        screen.getByLabelText("A1 Bench Press").textContent,
      ).not.toContain("22.5"),
    );
    expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain(
      "25",
    );
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    const [queued] = await (await getDb()).getAll("outbox");
    expect(queued?.op).toMatchObject({
      kind: "insert",
      table: "sets",
      payload: { exercise_id: "bench-press", load_kg: 22.5 },
    });
  });

  it("clears the old rest strip when auto-rest is turned off before a round", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 3),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 3),
      prescription("db-row", "dumbbell-row", "Dumbbell Row", "reps", 1, 3),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /— current — view full workout$/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Barbell Row(, selected)? — / }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(await screen.findByText("round 1 of 3")).toBeTruthy();

    act(() => setSetting("autoStartRest", false));
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("timer", { name: /^rest timer/ }),
      ).toBeNull(),
    );
    // The first ordinary log holds the duplicate-tap lock briefly. The rest
    // assertion above is the behavior under test; wait for the independent
    // lock before starting the next round.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );

    await vi.waitFor(() =>
      expect(
        screen.queryByRole("timer", { name: /^rest timer/ }),
      ).toBeNull(),
    );
  });

  it("keeps paired drafts when switching through overview and back to Focus", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("round 1 of 2")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "increase load by 2.5 kg",
      })[0]!,
    );
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "increase load by 2.5 kg",
      })[1]!,
    );
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /— current — view full workout$/,
      })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    expect(screen.getByLabelText("A1 Bench Press").textContent).toContain(
      "22.5",
    );
    expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain(
      "22.5",
    );
  });

  it("warns before Home can discard paired member drafts", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(await screen.findByText("round 1 of 2")).toBeTruthy();
    const loadButtons = screen.getAllByRole("button", {
      name: "increase load by 2.5 kg",
    });
    fireEvent.click(loadButtons[0]!);
    fireEvent.click(loadButtons[1]!);
    fireEvent.click(
      screen.getByRole("button", {
        name: "back to Today — session keeps running",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Unlogged set changes",
    });
    expect(dialog.textContent).toMatch(/held only on this screen/i);
    expect(screen.getByLabelText("A1 Bench Press").textContent).toContain(
      "22.5",
    );
    expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain(
      "22.5",
    );
    expect(
      within(dialog).getByRole("button", { name: "Leave and discard drafts" }),
    ).toBeTruthy();
  });

  it("does not advance either member when the local round batch cannot be saved", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    vi.mocked(outbox.enqueueBatch).mockRejectedValueOnce(
      new Error("IndexedDB unavailable"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      render(
        <MemoryRouter>
          <Session />
        </MemoryRouter>,
      );

      expect(await screen.findByText("round 1 of 2")).toBeTruthy();
      fireEvent.click(
        screen.getAllByRole("button", { name: "increase load by 2.5 kg" })[0]!,
      );
      fireEvent.click(screen.getByRole("button", { name: "Log round" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /could not be saved locally.*retry/i,
      );
      expect(screen.getByLabelText("A1 Bench Press").textContent).toContain(
        "22.5",
      );
      expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain(
        "20",
      );
      expect(screen.getByText("round 1 of 2")).toBeTruthy();
      expect(vi.mocked(outbox.enqueue)).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs an edited A1 alone without discarding A2's draft", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 2");
    const increaseLoad = screen.getAllByRole("button", {
      name: "increase load by 2.5 kg",
    });
    fireEvent.click(increaseLoad[0]);
    fireEvent.click(increaseLoad[1]);
    fireEvent.click(increaseLoad[1]);
    fireEvent.click(screen.getByRole("button", { name: "Log Bench Press only" }));

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", load_kg: 22.5 },
    });
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
    expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain("25");
  });

  it("finishes the active partial round with A2 only instead of logging A1 twice", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Log Bench Press only" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    expect(screen.queryByRole("button", { name: "Log round" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log Barbell Row only" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();

    expect(
      vi.mocked(outbox.enqueue).mock.calls.map((call) => call[0]),
    ).toMatchObject([
      {
        payload: {
          exercise_id: "bench-press",
          prescription_id: "bench",
          set_index: 0,
        },
      },
      {
        payload: {
          exercise_id: "barbell-row",
          prescription_id: "row",
          set_index: 0,
        },
      },
    ]);
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
  });

  it("returns to the canonical round editor when focus starts from A2", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // Both round members are "current" while the round is live, so either
    // dot opens overview (see FocusDeck's rail: onViewFullWorkout fires for
    // any dot whose state is "current", not one particular member).
    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: /— current — view full workout$/,
        })
      )[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Barbell Row(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    expect(await screen.findByText("round 1 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log round" })).toBeTruthy();
  });

  it("keeps rest timing through focus and overview changes", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );
    const logSet = await screen.findByRole("button", { name: /log set/i });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    await act(async () => {
      fireEvent.click(logSet);
      await Promise.resolve();
    });
    expect(screen.getByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    const activeRestScene = screen.getByRole("timer", { name: /^rest timer/ });
    expect(activeRestScene.parentElement?.className).toContain("focus-stage-scroll");
    expect(screen.getByRole("button", { name: "Note last set" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "rpe 6.5" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "reps value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    fireEvent.click(screen.getByRole("button", { name: "add 30 seconds to the rest target" }));
    expect(screen.getByRole("timer", { name: /^rest timer/ }).textContent).toContain("1:30");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "reps value — tap to type" }).textContent).toBe("9");
    expect(screen.getByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(91_000));

    expect(screen.getByRole("timer", { name: "rest timer complete" })).toBeTruthy();
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    const repsAfterReturn = screen.getByRole("button", {
      name: "reps value — tap to type",
    });
    expect(repsAfterReturn.textContent).toBe("9");
    expect(screen.getByRole("timer", { name: "rest timer complete" })).toBeTruthy();
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("routes a round member's number pad and plate sheet back to that draft", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    vi.mocked(getExercises).mockResolvedValue({
      data: [
        { id: "bench-press", name: "Bench Press", equipment: "barbell" },
        { id: "barbell-row", name: "Barbell Row", equipment: "barbell" },
      ],
      fromCache: false,
      stale: null,
    });
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 2");
    const a1 = screen.getByLabelText("A1 Bench Press");
    const a2 = screen.getByLabelText("A2 Barbell Row");
    fireEvent.click(
      within(a2).getByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));

    expect(a1.textContent).toContain("8");
    expect(a2.textContent).toContain("9");
    fireEvent.click(
      screen.getByRole("button", { name: "more options for Bench Press" }),
    );
    const a2More = screen.getByLabelText("A2 Barbell Row · more");
    fireEvent.click(
      within(a2More).getByRole("button", { name: "Plate calculator" }),
    );
    expect(await screen.findByText("BARBELL ROW · PLATES")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Type a target" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "BACK TO PLATES" }));

    expect(a1.textContent).toContain("20");
    expect(a2.textContent).toContain("25");
  });

  it("removes focus next while correcting a completed entry", async () => {
    const completedBench: SetInsert = {
      id: "bench-set-1",
      session_id: active.id,
      exercise_id: "bench-press",
      prescription_id: "bench",
      set_index: 0,
      set_type: "working",
      load_kg: 20,
      reps: 8,
      performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null,
      load_entry: "total",
      rpe: null,
    };
    resetDbForTests();
    await seed(
      "reps",
      [
        prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
        prescription("squat", "back-squat", "Back Squat", "reps", null, 1),
      ],
      [completedBench],
    );
    vi.mocked(getServerSessionSets).mockResolvedValue([completedBench]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /— current — view full workout$/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Bench Press(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(
      await screen.findByRole("button", { name: "Next exercise" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "more options for Bench Press" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Correct logged set 1" }));

    expect(screen.queryByRole("button", { name: "Next exercise" })).toBeNull();
  });

  it("keeps a correction on its source entry through select + Focus mode, not the newly selected one", async () => {
    const completedBench: SetInsert = {
      id: "bench-set-1",
      session_id: active.id,
      exercise_id: "bench-press",
      prescription_id: "bench",
      set_index: 0,
      set_type: "working",
      load_kg: 20,
      reps: 8,
      performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null,
      load_entry: "total",
      rpe: null,
    };
    resetDbForTests();
    await seed(
      "reps",
      [
        prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
        prescription("squat", "back-squat", "Back Squat", "reps", null, 1),
      ],
      [completedBench],
    );
    vi.mocked(getServerSessionSets).mockResolvedValue([completedBench]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // Bench is already done, so the session opens in focus on Squat. Switch
    // to overview, open Bench, and start correcting its logged set.
    fireEvent.click(
      await screen.findByRole("button", { name: /— current — view full workout$/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Show details for Bench Press" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Correct logged set 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    // Select Squat (a future focus destination, not a navigation) and enter
    // Focus mode. The correction in progress must win: Bench stays open with
    // its staged edit, not Squat with a fresh prefill.
    fireEvent.click(screen.getByRole("button", { name: /^Back Squat(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    expect(
      await screen.findByRole("heading", { name: "Bench Press" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1]).toMatchObject({
      exercise_id: "bench-press", reps: 9, load_kg: 20,
    });
  });

  it("keeps a correction staged through focus Next + View full workout (reverse route)", async () => {
    resetDbForTests();
    // The previous test's `mockResolvedValue` (no "Once") outlives
    // `vi.clearAllMocks()` in `beforeEach`, which only clears call history —
    // pin this test's own server response so it isn't run against a
    // completed Bench Press left over from an earlier test.
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 1),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    expect(await screen.findByRole("heading", { name: "Back Squat" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    // past LOG_LOCK_MS, or the correction's own Save below is a no-op tap on
    // a still-locked button.
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    fireEvent.click(
      screen.getByRole("button", { name: "more options for Back Squat" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Correct logged set 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: /— current — view full workout$/ }));

    // The correction on Back Squat must still be the one on screen, staged.
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1]).toMatchObject({
      exercise_id: "back-squat", reps: 9,
    });
  });

  it("splits round rest across members: the first is measured, the second stays unknown", async () => {
    resetDbForTests();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    await screen.findByText("round 2 of 2");
    // past LOG_LOCK_MS, or round 2's tap lands on a still-disabled button.
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    // Round 1 started the rest clock in real time; freeze 45s past it and log
    // round 2, then restore real timers before the next await.
    const startedAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 45_000);
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    vi.useRealTimers();

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(2),
    );
    const ops = (
      vi.mocked(outbox.enqueueBatch).mock.calls[1]?.[0] ?? []
    ).filter(
      (op): op is Extract<typeof op, { kind: "insert"; table: "sets" }> =>
        op.kind === "insert" && op.table === "sets",
    );
    // A1 (bench) just finished resting from round 1 — that elapsed time is
    // real, measured data. A2 (row) did not rest at all; it was logged in
    // the same tap, so its rest is unknown, never a copy of A1's.
    expect(ops[0]?.payload).toMatchObject({
      exercise_id: "bench-press",
      rest_seconds_actual: 45,
    });
    expect(ops[1]?.payload).toMatchObject({
      exercise_id: "barbell-row",
      rest_seconds_actual: null,
    });
  });

  it("stages the rest strip from the round's own second member, not whichever entry happens to be open", async () => {
    resetDbForTests();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    const benchRx: ResolvedPrescriptionRow = {
      ...prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      rest_seconds: 90,
    };
    const rowRx: ResolvedPrescriptionRow = {
      ...prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
      rest_seconds: 45,
    };
    await seed("reps", [benchRx, rowRx]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // Focus opens on Bench (the round's first, canonical member), so the
    // top-level `restSeconds` hook value reflects Bench's own 90s bracket.
    // The round's inter-round rest belongs to the next A1 and uses the
    // current round's A2 prescription, 45 seconds.
    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    expect(await screen.findByText("0:45")).toBeTruthy();
    expect(screen.queryByText("1:30")).toBeNull();
    expect(screen.getByText("Next: Superset A, round 2 of 2")).toBeTruthy();
  });

  it("flips a superset member's staged type from warmup to working after logging it, like logSet does", async () => {
    resetDbForTests();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    const benchWarmup: ResolvedPrescriptionRow = {
      ...prescription(
        "bench-warmup",
        "bench-press",
        "Bench Press",
        "reps",
        1,
        1,
      ),
      set_type: "warmup",
      position: 0,
    };
    const benchWorking: ResolvedPrescriptionRow = {
      ...prescription(
        "bench-working",
        "bench-press",
        "Bench Press",
        "reps",
        1,
        1,
      ),
      set_type: "working",
      position: 1,
    };
    const row: ResolvedPrescriptionRow = {
      ...prescription("row", "barbell-row", "Barbell Row", "reps", 1, 1),
      position: 2,
    };
    await seed("reps", [benchWarmup, benchWorking, row]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 1");
    // The fresh-open prefill that stages Bench on its outstanding warmup
    // lands a render after mount; force it explicitly rather than race it,
    // since this test is about what happens to the toggle AFTER logging, not
    // about that prefill's own timing.
    fireEvent.click(
      screen.getByRole("button", { name: "more options for Bench Press" }),
    );
    const a1More = await screen.findByLabelText("A1 Bench Press · more");
    fireEvent.click(within(a1More).getByRole("button", { name: "warmup" }));
    fireEvent.click(screen.getByRole("button", { name: "CLOSE" }));
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );

    // Bench's warmup is done and Row already met its target — only Bench's
    // real working set remains.
    await screen.findByRole("button", { name: "Log Bench Press only" });
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "Log Bench Press only" }));

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", set_type: "working" },
    });
  });

  it("un-skips a superset member logged mid-round, like logging a single set does", async () => {
    resetDbForTests();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 1),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 1),
    ]);
    await cacheSet(cacheKeys.sessionSkips(active.id), ["row"]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 1");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    // `skips` is a SkipRecord map as of Task 8 (was a plain key array); the
    // legacy array this test seeds is read back through `readSkipsCache`,
    // and what gets WRITTEN once nothing is skipped is the (now empty) map.
    expect(
      await cacheGet<Record<string, unknown>>(cacheKeys.sessionSkips(active.id)),
    ).toEqual({});
  });

  it("labels the tail of an unequal superset correctly and offers only the remaining member", async () => {
    resetDbForTests();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 1),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByText("round 1 of 1");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );

    // Bench (A1, target 1) is done; Row (A2, target 2) still owes a set. This
    // is the last set of a two-round day, not "round 2 of 1", and only Row
    // has anything left to log — Bench must not be offered another set.
    expect(await screen.findByText("round 2 of 2")).toBeTruthy();
    expect(screen.queryByText(/round 2 of 1/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Log round" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Log Bench Press only" })).toBeNull();
    expect(screen.getByRole("button", { name: "Log Barbell Row only" })).toBeTruthy();

    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "Log Barbell Row only" }));

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "barbell-row", set_index: 1 },
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull(),
    );
  });
});


const receiptOwner = "aaaaaaaa-1111-4111-8111-111111111111";
const receiptOriginalId = "original-set-0001";
const receiptSet = (id = "receipt-set-0001"): SetInsert => ({
  id, session_id: active.id, exercise_id: "bench-press", prescription_id: "bench",
  set_index: 0, set_type: "working", load_kg: 20, reps: 8,
  performed_at: "2026-09-12T12:10:00.000Z", rest_seconds_actual: null,
});

function receiptEntry(set: SetInsert, state: "waiting" | "held" | "dead" = "waiting") {
  return {
    key: 1, op: { kind: "insert" as const, table: "sets" as const, payload: set },
    table: "sets" as const, created_at: null, retries: 0,
    last_error: state === "dead" ? "the server rejected this set" : null,
    user_id: receiptOwner, state, cause: state === "dead" ? "rejected" as const : null, retryable: false,
  };
}

async function seedReceiptSets(...sets: SetInsert[]) {
  await seed("reps", [prescription()], sets);
  // Session reconciles server and pending rows into its live list. The local
  // cache supplies load-entry metadata, not a second source of set rows.
  vi.mocked(getServerSessionSets).mockResolvedValue(sets as any);
}

describe("Session per-set receipts", () => {
  it("shows On this phone for a committed queued set, then Review after reload when only cache remains", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(outbox.inspect).mockResolvedValue([receiptEntry(set)] as any);
    const first = render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByRole("status", { name: "Set status: On this phone" })).toBeTruthy();

    first.unmount();
    vi.mocked(outbox.inspect).mockResolvedValue([]);
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByRole("status", { name: "Set status: Review" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();
  });

  it("shows Synced only when the exact set UUID is returned by the server read", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set([set.id]), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByRole("status", { name: "Set status: Synced" })).toBeTruthy();
  });

  it("keeps a partially acknowledged correction local until its linked void is read back", async () => {
    const replacement = receiptSet("replacement-set-0001");
    await seedReceiptSets(replacement);
    vi.mocked(outbox.correctionLinks).mockResolvedValue({ [replacement.id]: receiptOriginalId });
    vi.mocked(outbox.inspect).mockResolvedValue([{
      key: 2, op: { kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } },
      table: "set_voids", created_at: null, retries: 0, last_error: null,
      user_id: receiptOwner, correction_link: { session_id: active.id, replacement_id: replacement.id, original_id: receiptOriginalId },
      state: "waiting", cause: null, retryable: false,
    }] as any);
    vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set([replacement.id]), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByRole("status", { name: "Set status: On this phone" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();
  });

  it("opens OutboxSheet with the Review reason and leaves correction available", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read timed out"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    await screen.findByRole("button", { name: /Last: 20 kg × 8 working/ });
    fireEvent.click(await screen.findByRole("button", { name: "Open workout" }));
    const review = await screen.findByRole("button", { name: /Review sync status: Could not verify exact server receipt: read timed out/i });
    expect(screen.getByRole("button", { name: "Correct logged set 1" })).toBeTruthy();
    fireEvent.click(review);
    expect(await screen.findByText(/Could not verify exact server receipt: read timed out/)).toBeTruthy();
  });

  it("keeps the dead-write reason visible when exact readback also fails", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(outbox.inspect).mockResolvedValue([receiptEntry(set, "dead")] as any);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read timed out"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: /Review sync status: the server rejected this set/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Could not verify exact server receipt: read timed out/i })).toBeNull();
  });

  it("uses only the acknowledged set UUID when exact readback is unavailable", async () => {
    const first = receiptSet("ack-set-0001");
    const second = { ...receiptSet("ack-set-0002"), set_index: 1, performed_at: "2026-09-12T12:11:00.000Z" };
    await seedReceiptSets(first, second);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read unavailable"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    await vi.waitFor(() => expect(getExactSetReceiptIds).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    const details = screen.queryByRole("button", { name: "Show details for Bench Press" });
    if (details) fireEvent.click(details);
    await screen.findByRole("button", { name: "Correct logged set 1" });
    await vi.waitFor(() => expect(receiptIdentity.syncedListeners.size).toBeGreaterThan(0));
    const listener = [...receiptIdentity.syncedListeners][0]!;
    await act(async () => {
      listener({ kind: "insert", table: "sets", payload: first }, receiptOwner);
    });
    expect(await screen.findByRole("status", { name: "Set status: Synced" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Set status: Review" })).toBeTruthy();
  });

  it("does not report a replacement Synced while its durable link snapshot is delayed", async () => {
    const replacement = receiptSet("delayed-link-replacement-0001");
    const link = { session_id: active.id, replacement_id: replacement.id, original_id: receiptOriginalId };
    let linksReleased = false;
    const waitingReads: Array<(links: Record<string, string>) => void> = [];
    await seedReceiptSets(replacement);
    vi.mocked(outbox.correctionLinks).mockImplementation(() => {
      if (linksReleased) return Promise.resolve({ [replacement.id]: receiptOriginalId });
      return new Promise((resolve) => { waitingReads.push(resolve); });
    });
    vi.mocked(outbox.inspect).mockResolvedValue([{
      key: 2, op: { kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } },
      table: "set_voids", created_at: null, retries: 0, last_error: null,
      user_id: receiptOwner, correction_link: link, state: "waiting", cause: null, retryable: false,
    }] as any);
    vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set([replacement.id]), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await screen.findByRole("button", { name: /Last: 20 kg × 8 working/ });
    fireEvent.click(screen.getByRole("button", { name: "Open workout" }));
    await screen.findByRole("button", { name: "Correct logged set 1" });
    await vi.waitFor(() => {
      expect(receiptIdentity.syncedListeners.size).toBeGreaterThan(0);
      expect(waitingReads.length).toBeGreaterThan(0);
    });
    const olderReads = waitingReads.splice(0);
    const listener = [...receiptIdentity.syncedListeners][0]!;

    await act(async () => {
      listener({ kind: "insert", table: "sets", payload: replacement }, receiptOwner, link);
    });
    expect(await screen.findByRole("status", { name: "Set status: Review" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();

    await vi.waitFor(() => expect(waitingReads.length).toBeGreaterThan(0));
    await act(async () => {
      for (const resolve of olderReads) resolve({});
    });
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();
    linksReleased = true;
    await act(async () => {
      const currentReads = waitingReads.splice(0);
      for (const resolve of currentReads) resolve({ [replacement.id]: receiptOriginalId });
    });
    expect(await screen.findByRole("status", { name: "Set status: On this phone" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();

    await act(async () => {
      listener({ kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } }, receiptOwner, link);
    });
    expect(await screen.findByRole("status", { name: "Set status: Synced" })).toBeTruthy();
  });

  it("keeps a correction in Review when its linked void is dead", async () => {
    const replacement = receiptSet("dead-void-replacement-0001");
    const link = { session_id: active.id, replacement_id: replacement.id, original_id: receiptOriginalId };
    await seedReceiptSets(replacement);
    vi.mocked(outbox.correctionLinks).mockResolvedValue({ [replacement.id]: receiptOriginalId });
    vi.mocked(outbox.inspect).mockResolvedValue([{
      key: 2, op: { kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } },
      table: "set_voids", created_at: null, retries: 1, last_error: "original set void was refused",
      user_id: receiptOwner, correction_link: link, state: "dead", cause: "blocked", retryable: true,
    }] as any);
    vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set([replacement.id]), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: /Review sync status: original set void was refused/i })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();
  });

  it("requires both captured correction ACKs when readback is unavailable", async () => {
    const replacement = receiptSet("correction-replacement-0001");
    const link = { session_id: active.id, replacement_id: replacement.id, original_id: receiptOriginalId };
    await seedReceiptSets(replacement);
    vi.mocked(outbox.correctionLinks).mockResolvedValue({ [replacement.id]: receiptOriginalId });
    vi.mocked(outbox.inspect).mockResolvedValue([{
      key: 2, op: { kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } },
      table: "set_voids", created_at: null, retries: 0, last_error: null,
      user_id: receiptOwner, correction_link: link, state: "waiting", cause: null, retryable: false,
    }] as any);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read unavailable"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    await vi.waitFor(() => expect(getExactSetReceiptIds).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    const details = screen.queryByRole("button", { name: "Show details for Bench Press" });
    if (details) fireEvent.click(details);
    await screen.findByRole("button", { name: "Correct logged set 1" });
    await vi.waitFor(() => expect(receiptIdentity.syncedListeners.size).toBeGreaterThan(0));
    const listener = [...receiptIdentity.syncedListeners][0]!;

    await act(async () => {
      listener({ kind: "insert", table: "sets", payload: replacement }, receiptOwner);
    });
    expect(await screen.findByRole("status", { name: "Set status: On this phone" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();

    await act(async () => {
      listener({ kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } }, receiptOwner, link);
    });
    expect(await screen.findByRole("status", { name: "Set status: Synced" })).toBeTruthy();
  });

  it("does not promote a late exact read from the prior account", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    let resolveOld!: (value: { setIds: Set<string>; voidIds: Set<string> }) => void;
    vi.mocked(getExactSetReceiptIds)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ setIds: new Set(), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId);
    resolveOld({ setIds: new Set([set.id]), voidIds: new Set() });
    expect(await screen.findByRole("status", { name: "Set status: Review" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();
  });

  it("does not let a late failed read overwrite the new account snapshot", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    let rejectOld!: (reason: Error) => void;
    vi.mocked(getExactSetReceiptIds)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ setIds: new Set(), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
    receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId);
    rejectOld(new Error("late account A read failure"));
    expect(await screen.findByRole("status", { name: "Set status: Review" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Set status: Synced" })).toBeNull();
  });
});
