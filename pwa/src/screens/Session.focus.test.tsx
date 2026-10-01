// @vitest-environment jsdom

import { isAcceptedAuthoredLoad } from "../lib/setLoad";
import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { onToast } from "../lib/errors";
const receiptIdentity = vi.hoisted(() => ({
  userId: "aaaaaaaa-1111-4111-8111-111111111111" as string | null,
  beforeNextSubscription: null as (() => void) | null,
  listeners: new Set<(id: string | null) => void>(),
  syncedListeners: new Set<(
    op: any,
    ownerId: string | null | undefined,
    correctionLink?: { session_id: string; replacement_id: string; original_id: string },
  ) => void>(),
}));
const sessionPrefsMock = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  actualRead: null as ((ownerId: string, sessionId: string) => Promise<any>) | null,
  actualWrite: null as ((ownerId: string, sessionId: string, patch: any, isCurrent?: () => boolean) => Promise<void>) | null,
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
    const beforeSubscribe = receiptIdentity.beforeNextSubscription;
    receiptIdentity.beforeNextSubscription = null;
    beforeSubscribe?.();
    receiptIdentity.listeners.add(fn);
    return () => receiptIdentity.listeners.delete(fn);
  },
}));

vi.mock("../lib/sessionPrefs", async () => {
  const actual = await vi.importActual<typeof import("../lib/sessionPrefs")>("../lib/sessionPrefs");
  sessionPrefsMock.actualRead = actual.readSessionPrefs;
  sessionPrefsMock.actualWrite = actual.writeSessionPrefs;
  return {
    ...actual,
    readSessionPrefs: sessionPrefsMock.read,
    writeSessionPrefs: sessionPrefsMock.write,
  };
});

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
    isStatusKnown: vi.fn(() => true),
  },
}));

import { Session } from "./Session";
import * as sessionPrefs from "../lib/sessionPrefs";
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

// The outbox is mocked here, so apply the same gate it applies: the TS mirror
// of validate_entered_load_consistency() (lib/setLoad.ts), which the PGlite
// property test proves equal to the applied migration.
function expectAcceptedAuthoredLoad(payload: SetInsert) {
  expect(payload.entered_load).not.toBeNull();
  expect(isAcceptedAuthoredLoad(payload)).toEqual({ ok: true });
}

/** The big number on a dock card, without its caption ("8" of "8 reps"). */
function dockValue(card: "reps" | "load" | "duration"): string {
  const button = screen.getByRole("button", { name: `${card} value — tap to type` });
  return button.querySelector(".dock-num-value")?.textContent ?? "";
}

const NOTE_PLACEHOLDER = "Anything worth remembering about this set…";
const TODAY = /^Today's workout,/;

/** The ☰ count in the header opens Today's workout, where the unit lives. */
async function openToday() {
  if (!screen.queryByRole("dialog", { name: "Today's workout" })) {
    fireEvent.click(await screen.findByRole("button", { name: TODAY }));
  }
  return screen.findByRole("dialog", { name: "Today's workout" });
}

function closeToday() {
  const dialog = screen.queryByRole("dialog", { name: "Today's workout" });
  if (dialog) fireEvent.click(within(dialog).getByRole("button", { name: "CLOSE" }));
}

/** Today's workout, unit toggle: opens the sheet if it is not already open. */
async function unitToggle(name: "Show weights in pounds" | "Show weights in kilograms") {
  const dialog = await openToday();
  return within(dialog).findByRole("button", { name });
}

/** The unit toggle, once Today's workout is open. */
function unitButton(name: "Show weights in pounds" | "Show weights in kilograms") {
  return within(screen.getByRole("dialog", { name: "Today's workout" })).getByRole("button", { name });
}

const todayOpen = () => screen.queryByRole("dialog", { name: "Today's workout" }) !== null;

/** aria-pressed of a unit key, opening and closing the sheet around the read. */
function unitPressed(name: "Show weights in pounds" | "Show weights in kilograms") {
  const wasOpen = todayOpen();
  if (!wasOpen) fireEvent.click(screen.getByRole("button", { name: TODAY }));
  const pressed = unitButton(name).getAttribute("aria-pressed");
  if (!wasOpen) closeToday();
  return pressed;
}

/** Press a unit key from the ☰ sheet and close it again. */
function switchUnit(name: "Show weights in pounds" | "Show weights in kilograms") {
  if (!todayOpen()) fireEvent.click(screen.getByRole("button", { name: TODAY }));
  fireEvent.click(unitButton(name));
  closeToday();
}

/** Back to Train, wherever the current view keeps it. */
async function pressHome() {
  const dialog = await openToday();
  fireEvent.click(within(dialog).getByRole("button", { name: /^Back to Train/ }));
}

async function showList() {
  fireEvent.click(await screen.findByRole("button", { name: "List" }));
}

/** Today's order as the ☰ sheet lists it (one entry per movable unit line). */
async function todayOrder(): Promise<(string | null)[]> {
  const dialog = await openToday();
  const names = within(dialog)
    .getAllByRole("listitem")
    .flatMap((li) => [...li.querySelectorAll(".reorder-line")])
    .map((line) => line.getAttribute("aria-label")?.split(" — ")[0] ?? null);
  closeToday();
  return names;
}

/** The correction sheet, its own dialog with its own numbers. */
const fixSheet = () => within(screen.getByRole("dialog", { name: /^Fix / }));

/** RPE key, then a chip in the RPE sheet. */
async function pressRpe(value: number) {
  fireEvent.click(await screen.findByRole("button", { name: /^RPE/ }));
  const sheet = await screen.findByRole("dialog", { name: /RPE|Rate / });
  fireEvent.click(within(sheet).getByRole("button", { name: `rpe ${value}` }));
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
  sessionPrefsMock.read.mockReset().mockImplementation((ownerId: string, sessionId: string) =>
    sessionPrefsMock.actualRead!(ownerId, sessionId));
  sessionPrefsMock.write.mockReset().mockImplementation((
    ownerId: string,
    sessionId: string,
    patch: Partial<sessionPrefs.SessionPrefs>,
    isCurrent?: () => boolean,
  ) => sessionPrefsMock.actualWrite!(ownerId, sessionId, patch, isCurrent));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(getExercises).mockReset();
  vi.mocked(getLastActuals).mockReset();
  vi.mocked(getServerSessionSets).mockReset();
  vi.mocked(getExactSetReceiptIds).mockReset();
  vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set(), voidIds: new Set() });
  receiptIdentity.userId = "aaaaaaaa-1111-4111-8111-111111111111";
  receiptIdentity.beforeNextSubscription = null;
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
  vi.restoreAllMocks();
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

    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/target 8/i)).toBeNull();
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
      await screen.findByRole("button", { name: "List" }),
    );
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    expect(
      dockValue("reps"),
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
    await pressHome();

    const dialog = await screen.findByRole("dialog", {
      name: "Unlogged set changes",
    });
    expect(dialog.textContent).toMatch(/held only on this screen/i);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stay in session" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      dockValue("reps"),
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
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: /^Back Squat(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(
      await screen.findByRole("heading", { name: "Back Squat" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: /^Bench Press(, selected)? — / }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(
      await screen.findByRole("heading", { name: "Bench Press" }),
    ).toBeTruthy();

    expect(
      dockValue("reps"),
    ).toBe("9");
    expect(
      dockValue("load"),
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
    expect(dockValue("duration")).toBe("60");
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
    await screen.findByRole("button", { name: "Finish session" });
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "+ Extra set" }));
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("button", { name: /^log extra set$/i }));

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
      expect(dockValue("load")).toBe("225.25"),
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

    await vi.waitFor(() => expect(dockValue("load")).toBe("220.5"));
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

    await vi.waitFor(() => expect(dockValue("load")).toBe("110.2"));
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
    expect(unitPressed("Show weights in pounds")).toBe("true");

    switchUnit("Show weights in kilograms");
    expect(unitPressed("Show weights in kilograms")).toBe("true");
    expect(dockValue("load")).toBe("102.06");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(unitPressed("Show weights in kilograms")).toBe("true");
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
    await unitToggle("Show weights in pounds");
    await vi.waitFor(() => {
      const toggle = unitButton("Show weights in pounds");
      expect(toggle.isConnected).toBe(true);
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });
    // Reacquire the ready button after async preference hydration.
    const readyShowPounds = unitButton("Show weights in pounds");
    expect(readyShowPounds.isConnected).toBe(true);
    expect(readyShowPounds.getAttribute("aria-pressed")).toBe("false");
    const writesBeforeSwitch = sessionPrefsMock.write.mock.calls.length;
    fireEvent.click(readyShowPounds);
    expect(sessionPrefsMock.write).toHaveBeenCalledTimes(writesBeforeSwitch + 1);
    const [writeOwner, writeSession, writePatch, isCurrent] = sessionPrefsMock.write.mock.calls.at(-1)!;
    expect([writeOwner, writeSession, writePatch]).toEqual([receiptOwner, active.id, { unit: "lb" }]);
    expect(isCurrent?.()).toBe(true);
    await vi.waitFor(async () => expect(await cacheGet(cacheKeys.sessionPrefs(receiptOwner, active.id))).toMatchObject({ unit: "lb" }));
    expect(getUnit()).toBe("kg");
    first.unmount();

    render(<MemoryRouter><Session /></MemoryRouter>);
    expect((await unitToggle("Show weights in pounds")).getAttribute("aria-pressed")).toBe("true");
    expect(getUnit()).toBe("kg");
  });

  it("uses the device default for another session and for a different owner", async () => {
    resetDbForTests();
    setSetting("unit", "kg");
    await seed();
    await cacheSet(cacheKeys.sessionPrefs(receiptOwner, active.id), { unit: "lb" });

    render(<MemoryRouter><Session /></MemoryRouter>);
    expect((await unitToggle("Show weights in pounds")).getAttribute("aria-pressed")).toBe("true");
    receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId); });
    await vi.waitFor(() => expect(unitButton("Show weights in kilograms").getAttribute("aria-pressed")).toBe("true"));
    expect(await cacheGet(cacheKeys.sessionPrefs(receiptIdentity.userId, active.id))).toBeUndefined();
    receiptIdentity.userId = receiptOwner;
    const readsBeforeOwnerA = sessionPrefsMock.read.mock.calls.length;
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId); });
    await vi.waitFor(() => expect(sessionPrefsMock.read.mock.calls.length).toBeGreaterThan(readsBeforeOwnerA));
    const ownerARead = sessionPrefsMock.read.mock.results.at(-1)?.value as Promise<sessionPrefs.SessionPrefs> | undefined;
    await act(async () => { await ownerARead; });
    await vi.waitFor(() => expect(unitButton("Show weights in pounds").getAttribute("aria-pressed")).toBe("true"));
    cleanup();

    const nextSession = { ...active, id: "session-focus-next" };
    await cacheSet(cacheKeys.activeSession, nextSession);
    await cacheSet(cacheKeys.sessionRx(nextSession.id), [prescription()]);
    await cacheSet(cacheKeys.sessionSets(nextSession.id), []);
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect((await unitToggle("Show weights in kilograms")).getAttribute("aria-pressed")).toBe("true");
  });

  it("reconciles identity changed just before the listener subscribes", async () => {
    resetDbForTests();
    receiptIdentity.userId = receiptOwner;
    receiptIdentity.beforeNextSubscription = () => {
      // Simulate auth changing after render read its snapshot, before this
      // effect registers, with no event replay from currentUser.
      receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    };
    await seed();
    render(<MemoryRouter><Session /></MemoryRouter>);

    expect((await unitToggle("Show weights in kilograms")).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Loading workout choices…")).toBeNull();
  });

  it("does not block logging while identity is unknown (F4); the outbox stamps or holds", async () => {
    resetDbForTests();
    localStorage.clear(); // no persisted session either: identity is genuinely unknown
    receiptIdentity.userId = null;
    await seed();
    render(<MemoryRouter><Session /></MemoryRouter>);

    // the screen opens on the device unit and canonical order, not a spinner
    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalled());
    expect(screen.queryByText("Loading workout choices…")).toBeNull();

    // the owner arriving later does not put the screen back behind the read
    receiptIdentity.userId = receiptOwner;
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptOwner); });
    expect(screen.queryByText("Loading workout choices…")).toBeNull();
    receiptIdentity.userId = receiptOwner;
  });

  it("F-5: until the workout is ready there is no tappable LOG, and the screen says it is loading", async () => {
    resetDbForTests();
    await seed();
    sessionPrefsMock.read.mockImplementation(() => new Promise(() => undefined));
    render(<MemoryRouter><Session /></MemoryRouter>);
    expect(await screen.findByText("Loading workout choices…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^log/i })).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(vi.mocked(outbox.enqueue)).not.toHaveBeenCalled();
  });

  it("F-1: a session opened as A holds every write when the live identity flips to B", async () => {
    resetDbForTests();
    await seed();
    render(<MemoryRouter><Session /></MemoryRouter>);
    const log = await screen.findByRole("button", { name: "LOG SET" });
    await vi.waitFor(() => expect((log as HTMLButtonElement).disabled).toBe(false));

    const ownerB = "bbbbbbbb-2222-4222-8222-222222222222";
    receiptIdentity.userId = ownerB;
    act(() => { for (const listener of receiptIdentity.listeners) listener(ownerB); });

    // LOG is disabled with a reason, a tap enqueues nothing, and nothing is
    // cached for A's session under B's owner marker.
    await screen.findByText(/belongs to another account/i);
    const held = screen.getByRole("button", { name: /log unavailable/i }) as HTMLButtonElement;
    expect(held.disabled).toBe(true);
    fireEvent.click(held);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(vi.mocked(outbox.enqueue)).not.toHaveBeenCalled();
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
    expect(vi.mocked(outbox.enqueueCorrection)).not.toHaveBeenCalled();

    // The kv cache is cleared for B by claimCacheFor and then marked B's, so
    // this A-session screen must not write A's skip record into it.
    const skipButtons = screen.queryAllByRole("button", { name: "Skip" });
    expect(skipButtons.length).toBeGreaterThan(0);
    fireEvent.click(skipButtons[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Out of time" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(await cacheGet(cacheKeys.sessionSkips(active.id))).toBeUndefined();

    // flipping back to A releases the hold
    receiptIdentity.userId = receiptOwner;
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptOwner); });
    await vi.waitFor(() => expect(screen.queryByText(/belongs to another account/i)).toBeNull());
  });

  it("F-8: with no known owner the unit switch still applies locally, and the owner arriving keeps the choice and saves it", async () => {
    resetDbForTests();
    localStorage.clear();
    receiptIdentity.userId = null;
    setSetting("unit", "kg");
    await seed();
    render(<MemoryRouter><Session /></MemoryRouter>);

    const toPounds = await unitToggle("Show weights in pounds");
    expect((toPounds as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toPounds);
    await vi.waitFor(() => expect(unitButton("Show weights in kilograms").getAttribute("aria-pressed")).toBe("false"));
    expect(unitButton("Show weights in pounds").getAttribute("aria-pressed")).toBe("true");
    expect(getUnit()).toBe("kg"); // the device default is untouched

    // the owner arrives with a different saved unit: this session's own choice wins
    await cacheSet(cacheKeys.sessionPrefs(receiptOwner, active.id), { unit: "kg" });
    receiptIdentity.userId = receiptOwner;
    act(() => { for (const listener of receiptIdentity.listeners) listener(receiptOwner); });
    await vi.waitFor(() => expect(sessionPrefsMock.write).toHaveBeenCalled());
    expect(sessionPrefsMock.write.mock.calls.at(-1)?.[2]).toEqual({ unit: "lb" });
    expect(unitButton("Show weights in pounds").getAttribute("aria-pressed")).toBe("true");
    expect(getUnit()).toBe("kg");
  });

  it("discards a delayed preference read after A changes to B", async () => {
    resetDbForTests();
    const ownerA = receiptOwner;
    const ownerB = "bbbbbbbb-2222-4222-8222-222222222222";
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 2),
    ]);
    await cacheSet(cacheKeys.sessionPrefs(ownerA, active.id), {
      unit: "lb", entryOrder: ["squat", "bench"],
    });
    let releaseOwnerA: ((prefs: sessionPrefs.SessionPrefs) => void) | undefined;
    sessionPrefsMock.read.mockImplementation((ownerId: string, sessionId: string) => {
      if (ownerId === ownerA) {
        return new Promise((resolve) => { releaseOwnerA = resolve; });
      }
      return sessionPrefsMock.actualRead!(ownerId, sessionId);
    });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await vi.waitFor(() => expect(releaseOwnerA).toBeDefined());

    receiptIdentity.userId = ownerB;
    act(() => { for (const listener of receiptIdentity.listeners) listener(ownerB); });
    expect((await unitToggle("Show weights in kilograms")).getAttribute("aria-pressed")).toBe("true");
    releaseOwnerA?.({ unit: "lb", entryOrder: ["squat", "bench"] });
    await act(async () => { await Promise.resolve(); });
    expect(unitButton("Show weights in kilograms").getAttribute("aria-pressed")).toBe("true");
    expect((await todayOrder())).toEqual(["Bench Press", "Back Squat"]);
  });

  it("keeps a typed draft and logs its authored unit when session preference saving fails", async () => {
    resetDbForTests();
    setSetting("unit", "kg");
    await seed();
    sessionPrefsMock.write.mockRejectedValueOnce(new Error("disk full"));
    const messages: string[] = [];
    const stopToastListener = onToast(({ message }) => messages.push(message));
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    switchUnit("Show weights in pounds");
    await vi.waitFor(() => expect(messages).toContain("Unit choice may reset after reload"));
    expect(dockValue("load")).toBe("55.1");
    expect(getUnit()).toBe("kg");

    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    const payload = firstQueuedSet();
    expect(payload).toMatchObject({ load_kg: 25, entered_load: 25, entered_unit: "kg", load_entry: "total" });
    expectAcceptedAuthoredLoad(payload);
    stopToastListener();
  });

  it("reorders only this session, keeps the selected draft, and restores its order after reload", async () => {
    resetDbForTests();
    const rows = [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 2),
    ];
    await seed("reps", rows);
    await cacheSet(cacheKeys.sessionPrefs(receiptOwner, active.id), { unit: "lb" });
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "reps value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    await openToday();

    fireEvent.click(screen.getByRole("button", { name: "Move Bench Press down" }));
    await vi.waitFor(async () =>
      expect(await cacheGet(cacheKeys.sessionPrefs(receiptOwner, active.id))).toMatchObject({
        unit: "lb", entryOrder: ["squat", "bench"],
      }),
    );
    closeToday();
    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();
    expect(dockValue("reps")).toBe("9");

    cleanup();
    render(<MemoryRouter><Session /></MemoryRouter>);
    const names = await todayOrder();
    expect(names).toEqual(["Back Squat", "Bench Press"]);
    expect(await cacheGet(cacheKeys.sessionPrefs(receiptOwner, active.id))).toMatchObject({
      unit: "lb", entryOrder: ["squat", "bench"],
    });
  });

  it("keeps an optimistic order and staged draft when saving that order fails", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 2),
    ]);
    let rejectWrite!: (error: Error) => void;
    sessionPrefsMock.write.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectWrite = reject; }),
    );
    const messages: string[] = [];
    const stopToastListener = onToast(({ message }) => messages.push(message));
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "reps value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    await openToday();
    fireEvent.click(screen.getByRole("button", { name: "Move Bench Press down" }));

    const moveUp = await screen.findByRole("button", { name: "Move Bench Press up" });
    expect(moveUp.hasAttribute("disabled")).toBe(true);
    await act(async () => { rejectWrite(new Error("disk full")); });
    await vi.waitFor(() => expect(messages).toContain("Workout order may reset after reload"));
    expect(moveUp.hasAttribute("disabled")).toBe(false);
    const names = await todayOrder();
    expect(names).toEqual(["Back Squat", "Bench Press"]);
    expect(await cacheGet(cacheKeys.sessionPrefs(receiptOwner, active.id))).toBeUndefined();
    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();
    expect(dockValue("reps")).toBe("9");
    stopToastListener();
  });

  it("locks move arrows while a paired round is waiting for its durable local write", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("a1", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("a2", "back-row", "Back Row", "reps", 1, 2),
      prescription("next", "pressdown", "Pressdown", "reps", null, 2),
    ]);
    let resolveBatch!: () => void;
    vi.mocked(outbox.enqueue).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveBatch = resolve; }),
    );
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "Log A1" }));
    await vi.waitFor(() => expect(resolveBatch).toBeTypeOf("function"));
    await openToday();
    const moveDown = screen.getByRole("button", { name: /^Move .*Bench Press.* down$/ });
    expect(moveDown.hasAttribute("disabled")).toBe(true);

    await act(async () => { resolveBatch(); });
    await vi.waitFor(() => expect(moveDown.hasAttribute("disabled")).toBe(false));
  });

  it("locks move arrows during a correction write and restores them when it settles", async () => {
    resetDbForTests();
    const old: SetInsert = {
      id: "bench-order-correction-1", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working", load_kg: 20,
      reps: 8, performed_at: "2026-09-12T12:05:00.000Z", rest_seconds_actual: null,
      load_entry: "total", rpe: null,
    };
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 2),
    ], [old]);
    vi.mocked(getServerSessionSets).mockResolvedValue([old]);
    let resolveCorrection!: () => void;
    vi.mocked(outbox.enqueueCorrection).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveCorrection = resolve; }),
    );
    render(<MemoryRouter><Session /></MemoryRouter>);

    await showList();
    fireEvent.click(screen.getByRole("button", { name: "Bench Press — done" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Correct logged set 1/ }));
    const sheet = await screen.findByRole("dialog", { name: /Fix set 1/ });
    fireEvent.click(within(sheet).getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(resolveCorrection).toBeTypeOf("function"));
    // a modal sheet is over the screen, but the lock itself is what is tested
    fireEvent.click(screen.getByRole("button", { name: TODAY }));
    const moveDown = screen.getByRole("button", { name: "Move Bench Press down" });
    expect(moveDown.hasAttribute("disabled")).toBe(true);

    await act(async () => { resolveCorrection(); });
    await vi.waitFor(() => expect(moveDown.hasAttribute("disabled")).toBe(false));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1]).toMatchObject({
      set_index: 0, session_id: active.id,
    });
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

    switchUnit("Show weights in kilograms");
    switchUnit("Show weights in pounds");
    expect(dockValue("load")).toBe("225.25");
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
    fireEvent.click(screen.getByRole("button", { name: "Fix last" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "Cancel" }));
    switchUnit("Show weights in pounds");

    expect(dockValue("load")).toBe("110.2");
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

    await screen.findByRole("button", { name: "Fix last" });
    switchUnit("Show weights in pounds");
    fireEvent.click(screen.getByRole("button", { name: "Fix last" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));

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
      fireEvent.click(await screen.findByRole("button", { name: "Fix last" }));
      fireEvent.click(fixSheet().getByRole("button", { name: "increase load by 2.5 kg" }));
      fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));

      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("[correct set]", expect.any(Error)));
      expect(await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))).toEqual([old]);
      expect(await cacheGet<string[]>(cacheKeys.sessionVoids(active.id))).toBeUndefined();
      expect(await cacheGet<Record<string, string>>(cacheKeys.sessionSetNotes(active.id)))
        .toEqual({ [old.id]: "Grip felt uneven" });
      expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledWith(
        active.id,
        expect.objectContaining({ session_id: active.id, set_index: old.set_index }),
        old.id,
        "Grip felt uneven",
      );
      await vi.waitFor(() => expect(fixSheet().getByRole("button", { name: "Save correction" })).toBeTruthy());
      fireEvent.click(fixSheet().getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "List" }));
      expect(screen.getByRole("button", { name: /^Correct logged set 1/ })).toBeTruthy();
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
      fireEvent.click(await screen.findByRole("button", { name: "Note" }));
      const note = await screen.findByPlaceholderText(NOTE_PLACEHOLDER);
      fireEvent.change(note, { target: { value: "Grip felt uneven" } });
      fireEvent.click(screen.getByRole("button", { name: "Save note" }));
      await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(screen.queryByPlaceholderText(NOTE_PLACEHOLDER)).toBeNull());
      const before = await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id));
      const restBefore = await cacheGet(cacheKeys.sessionRest(active.id));
      expect(before).toHaveLength(1);
      const noteBefore = await cacheGet<Record<string, string>>(cacheKeys.sessionSetNotes(active.id));

      await pressRpe(6.5);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("[rate set]", expect.any(Error)));

      expect(await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))).toEqual(before);
      expect(await cacheGet<string[]>(cacheKeys.sessionVoids(active.id))).toBeUndefined();
      expect(await cacheGet<Record<string, string>>(cacheKeys.sessionSetNotes(active.id))).toEqual(noteBefore);
      expect(Object.keys(noteBefore ?? {})).toHaveLength(1);
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
      fireEvent.click(await screen.findByRole("button", { name: "List" }));
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true"));
      fireEvent.click(await screen.findByRole("button", { name: /^Void logged set 1/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Confirm void logged set 1/ }));
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("[remove set]", expect.any(Error)));

      expect(await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))).toEqual([old]);
      expect(await cacheGet<string[]>(cacheKeys.sessionVoids(active.id))).toBeUndefined();
      expect(screen.getByRole("button", { name: /^Correct logged set 1/ })).toBeTruthy();
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

    await screen.findByRole("button", { name: "Fix last" });
    switchUnit("Show weights in pounds");
    fireEvent.click(screen.getByRole("button", { name: "Fix last" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "increase load by 5 lb" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Note" }));
    const note = await screen.findByPlaceholderText(NOTE_PLACEHOLDER);
    fireEvent.change(note, { target: { value: "Grip felt uneven" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.queryByPlaceholderText(NOTE_PLACEHOLDER)).toBeNull());
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      table: "set_notes",
      payload: { note: "Grip felt uneven" },
    });
    await pressRpe(6.5);
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]).toMatchObject([
      active.id,
      expect.objectContaining({ rpe: 6.5 }),
      expect.any(String),
      "Grip felt uneven",
    ]);
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
        dockValue("reps"),
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

    expect(await screen.findByRole("button", { name: "Fix last" })).toBeTruthy();
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
      "This workout opens in List because Superset A has 3 exercises.",
    )).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Superset A" })).toBeNull();
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
    expect(activeRestScene.closest(".focus-middle")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Note" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "RPE" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "reps value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    fireEvent.click(screen.getByRole("button", { name: "add 30 seconds to the rest target" }));
    expect(screen.getByRole("timer", { name: /^rest timer/ }).textContent).toContain("1:30");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(dockValue("reps")).toBe("9");
    expect(screen.getByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(91_000));

    expect(screen.getByRole("timer", { name: "rest timer complete" })).toBeTruthy();
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(dockValue("reps")).toBe("9");
    expect(screen.getByRole("timer", { name: "rest timer complete" })).toBeTruthy();
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("Fix last on a completed entry corrects that entry, not the next exercise", async () => {
    const completedBench: SetInsert = {
      id: "bench-set-1", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working", load_kg: 20,
      reps: 8, performed_at: "2026-09-12T12:05:00.000Z", rest_seconds_actual: null,
      load_entry: "total", rpe: null,
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
    render(<MemoryRouter><Session /></MemoryRouter>);

    // Bench is done, so the session opens on Squat. Jump back to Bench.
    await openToday();
    fireEvent.click(screen.getByRole("button", { name: /^Bench Press — done/ }));
    expect(await screen.findByRole("button", { name: "Next exercise: Back Squat" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fix last" }));
    const sheet = await screen.findByRole("dialog", { name: /^Fix / });
    expect(sheet.textContent).toContain("Bench Press");
    fireEvent.click(within(sheet).getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1]).toMatchObject({
      exercise_id: "bench-press", reps: 9, set_index: 0,
    });
  });
  it("pins Today's workout to the exercise being corrected, and its edit stays in the sheet", async () => {
    const completedBench: SetInsert = {
      id: "bench-set-1", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working", load_kg: 20,
      reps: 8, performed_at: "2026-09-12T12:05:00.000Z", rest_seconds_actual: null,
      load_entry: "total", rpe: null,
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
    render(<MemoryRouter><Session /></MemoryRouter>);

    // Bench is done, so the session opens on Squat; open Bench in List and
    // start correcting its logged set.
    await showList();
    fireEvent.click(await screen.findByRole("button", { name: /^Bench Press — done/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Correct logged set 1/ }));
    const sheet = await screen.findByRole("dialog", { name: /^Fix / });
    fireEvent.click(within(sheet).getByRole("button", { name: "increase reps by 1" }));
    expect(within(sheet).getByRole("button", { name: "reps value — tap to type" }).textContent).toContain("9");
    // the correction is a draft of its own: nothing is queued until Save
    expect(vi.mocked(outbox.enqueueCorrection)).not.toHaveBeenCalled();

    // The Fix sheet's backdrop covers the header in a real browser, so Today's
    // workout cannot normally be opened now; if it is (jsdom has no hit
    // testing), jumping elsewhere still must not touch the correction's own
    // draft, which stays with the set's exercise.
    fireEvent.click(screen.getByRole("button", { name: TODAY }));
    const today = within(screen.getByRole("dialog", { name: "Today's workout" }));
    fireEvent.click(today.getByRole("button", { name: /^Back Squat/ }));
    expect(
      within(screen.getByRole("dialog", { name: /^Fix / })).getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toContain("9");

    fireEvent.click(within(screen.getByRole("dialog", { name: /^Fix / })).getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1]).toMatchObject({
      exercise_id: "bench-press", reps: 9, load_kg: 20,
    });
  });
  it("keeps a correction staged through a Focus/List switch", async () => {
    resetDbForTests();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 1),
    ]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    expect(await screen.findByRole("heading", { name: "Back Squat" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    fireEvent.click(await screen.findByRole("button", { name: "Fix last" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "increase reps by 1" }));
    expect(fixSheet().getByRole("button", { name: "reps value — tap to type" }).textContent).toContain("9");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    // the correction on Back Squat is still the one on screen, staged
    expect(fixSheet().getByRole("button", { name: "reps value — tap to type" }).textContent).toContain("9");

    fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueueCorrection).mock.calls[0]?.[1]).toMatchObject({
      exercise_id: "back-squat", reps: 9,
    });
  });
});

const R = {
  local: "Set status: On this phone, waiting to send",
  synced: "Set status: Saved to the server",
  review: "Set status: Needs review",
};
async function inList() {
  fireEvent.click(await screen.findByRole("button", { name: "List" }));
}
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
    await inList();
    expect(await screen.findByRole("note", { name: R.local })).toBeTruthy();

    first.unmount();
    vi.mocked(outbox.inspect).mockResolvedValue([]);
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    expect(await screen.findByRole("note", { name: R.review })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();
  });

  it("shows Synced only when the exact set UUID is returned by the server read", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set([set.id]), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    expect(await screen.findByRole("note", { name: R.synced })).toBeTruthy();
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
    await inList();
    expect(await screen.findByRole("note", { name: R.local })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();
  });

  it("F-6: the correction note does not say the original is live on the server while its insert is still queued", async () => {
    const original = { ...receiptSet(receiptOriginalId) };
    const replacement = receiptSet("replacement-set-0006");
    await seedReceiptSets(replacement);
    const link = { session_id: active.id, replacement_id: replacement.id, original_id: receiptOriginalId };
    vi.mocked(outbox.correctionLinks).mockResolvedValue({ [replacement.id]: receiptOriginalId });
    const entry = (key: number, op: any) => ({
      key, op, table: op.table, created_at: null, retries: 0, last_error: null,
      user_id: receiptOwner, correction_link: link, state: "waiting", cause: null, retryable: false,
    });
    vi.mocked(outbox.inspect).mockResolvedValue([
      entry(1, { kind: "insert", table: "sets", payload: original }),
      entry(2, { kind: "insert", table: "sets", payload: replacement }),
      entry(3, { kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } }),
    ] as any);
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    expect((await screen.findAllByText(/Nothing from this set has been sent yet/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/stays live on the server/)).toBeNull();
  });

  it("F-6: once the original's insert is no longer queued the note says it is live until the correction lands", async () => {
    const replacement = receiptSet("replacement-set-0007");
    await seedReceiptSets(replacement);
    const link = { session_id: active.id, replacement_id: replacement.id, original_id: receiptOriginalId };
    vi.mocked(outbox.correctionLinks).mockResolvedValue({ [replacement.id]: receiptOriginalId });
    vi.mocked(outbox.inspect).mockResolvedValue([{
      key: 3, op: { kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } },
      table: "set_voids", created_at: null, retries: 0, last_error: null,
      user_id: receiptOwner, correction_link: link, state: "waiting", cause: null, retryable: false,
    }] as any);
    vi.mocked(getExactSetReceiptIds).mockResolvedValue({ setIds: new Set([replacement.id]), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    expect((await screen.findAllByText(/The original stays live on the server until it lands/)).length).toBeGreaterThan(0);
  });

  it("opens OutboxSheet with the Review reason and leaves correction available", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read timed out"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    const review = await screen.findByRole("button", { name: /Review sync status: Could not verify exact server receipt: read timed out/i });
    expect(screen.getByRole("button", { name: /^Correct logged set 1/ })).toBeTruthy();
    fireEvent.click(review);
    expect(await screen.findByText(/Could not verify exact server receipt: read timed out/)).toBeTruthy();
  });

  it("keeps the dead-write reason visible when exact readback also fails", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    vi.mocked(outbox.inspect).mockResolvedValue([receiptEntry(set, "dead")] as any);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read timed out"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    expect(await screen.findByRole("button", { name: /Review sync status: the server rejected this set/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Could not verify exact server receipt: read timed out/i })).toBeNull();
  });

  it("uses only the acknowledged set UUID when exact readback is unavailable", async () => {
    const first = receiptSet("ack-set-0001");
    const second = { ...receiptSet("ack-set-0002"), set_index: 1, performed_at: "2026-09-12T12:11:00.000Z" };
    await seedReceiptSets(first, second);
    vi.mocked(getExactSetReceiptIds).mockRejectedValue(new Error("read unavailable"));
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    await vi.waitFor(() => expect(getExactSetReceiptIds).toHaveBeenCalled());
    // both planned sets are logged, so Bench is a closed row until opened
    const row = screen.queryByRole("button", { name: /^Bench Press — / });
    if (row) fireEvent.click(row);
    await screen.findByRole("button", { name: /^Correct logged set 1/ });
    await vi.waitFor(() => expect(receiptIdentity.syncedListeners.size).toBeGreaterThan(0));
    const listener = [...receiptIdentity.syncedListeners][0]!;
    await act(async () => {
      listener({ kind: "insert", table: "sets", payload: first }, receiptOwner);
    });
    expect(await screen.findByRole("note", { name: R.synced })).toBeTruthy();
    expect(screen.getByRole("note", { name: R.review })).toBeTruthy();
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
    await inList();
    await screen.findByRole("button", { name: /^Correct logged set 1/ });
    await vi.waitFor(() => {
      expect(receiptIdentity.syncedListeners.size).toBeGreaterThan(0);
      expect(waitingReads.length).toBeGreaterThan(0);
    });
    const olderReads = waitingReads.splice(0);
    const listener = [...receiptIdentity.syncedListeners][0]!;

    await act(async () => {
      listener({ kind: "insert", table: "sets", payload: replacement }, receiptOwner, link);
    });
    expect(await screen.findByRole("note", { name: R.review })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();

    await vi.waitFor(() => expect(waitingReads.length).toBeGreaterThan(0));
    await act(async () => {
      for (const resolve of olderReads) resolve({});
    });
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();
    linksReleased = true;
    await act(async () => {
      const currentReads = waitingReads.splice(0);
      for (const resolve of currentReads) resolve({ [replacement.id]: receiptOriginalId });
    });
    expect(await screen.findByRole("note", { name: R.local })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();

    await act(async () => {
      listener({ kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } }, receiptOwner, link);
    });
    expect(await screen.findByRole("note", { name: R.synced })).toBeTruthy();
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
    await inList();
    expect(await screen.findByRole("button", { name: /Review sync status:.*Both are live on the server.*original set void was refused/i })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();
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
    await inList();
    await vi.waitFor(() => expect(getExactSetReceiptIds).toHaveBeenCalled());
    // both planned sets are logged, so Bench is a closed row until opened
    const row = screen.queryByRole("button", { name: /^Bench Press — / });
    if (row) fireEvent.click(row);
    await screen.findByRole("button", { name: /^Correct logged set 1/ });
    await vi.waitFor(() => expect(receiptIdentity.syncedListeners.size).toBeGreaterThan(0));
    const listener = [...receiptIdentity.syncedListeners][0]!;

    await act(async () => {
      listener({ kind: "insert", table: "sets", payload: replacement }, receiptOwner);
    });
    expect(await screen.findByRole("note", { name: R.local })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();

    await act(async () => {
      listener({ kind: "insert", table: "set_voids", payload: { set_id: receiptOriginalId } }, receiptOwner, link);
    });
    expect(await screen.findByRole("note", { name: R.synced })).toBeTruthy();
  });

  it("does not promote a late exact read from the prior account", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    let resolveOld!: (value: { setIds: Set<string>; voidIds: Set<string> }) => void;
    vi.mocked(getExactSetReceiptIds)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ setIds: new Set(), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    await act(async () => {
      for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId);
      resolveOld({ setIds: new Set([set.id]), voidIds: new Set() });
    });
    expect(await screen.findByRole("note", { name: R.review })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();
  });

  it("does not let a late failed read overwrite the new account snapshot", async () => {
    const set = receiptSet();
    await seedReceiptSets(set);
    let rejectOld!: (reason: Error) => void;
    vi.mocked(getExactSetReceiptIds)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ setIds: new Set(), voidIds: new Set() });
    render(<MemoryRouter><Session /></MemoryRouter>);
    await inList();
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
    receiptIdentity.userId = "bbbbbbbb-2222-4222-8222-222222222222";
    await act(async () => {
      for (const listener of receiptIdentity.listeners) listener(receiptIdentity.userId);
      rejectOld(new Error("late account A read failure"));
    });
    expect(await screen.findByRole("note", { name: R.review })).toBeTruthy();
    expect(screen.queryByRole("note", { name: R.synced })).toBeNull();
  });
});

describe("Focus movement scene integration", () => {
  it("updates with the controlled draft, survives List, and advances to the current bracket cue", async () => {
    const first = {
      ...prescription("squat-warmup-1", "squat", "Squat", "reps", null, 1),
      position: 0,
      set_type: "warmup" as const,
      load_kg: 20,
      resolved_load_kg: 20,
      notes: "Earlier bracket cue.",
    };
    const current = {
      ...prescription("squat-warmup-2", "squat", "Squat", "reps", null, 1),
      position: 1,
      set_type: "warmup" as const,
      load_kg: 40,
      resolved_load_kg: 40,
      notes: "Current bracket cue.",
    };
    const working = {
      ...prescription("squat-working", "squat", "Squat", "reps", null, 2),
      position: 2,
      set_type: "working" as const,
      load_kg: 60,
      resolved_load_kg: 60,
      notes: "Working bracket cue.",
    };
    await seed("reps", [first, current, working]);
    // no rest scene: the next set's own cue is what this test follows
    setSetting("autoStartRest", false);
    render(<MemoryRouter><Session /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^LOG (SET|WARMUP)$/ }).hasAttribute("disabled")).toBe(false);
    });
    expect(await screen.findByText(/Earlier bracket cue\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    expect(dockValue("load")).toBe("22.5");
    expect(outbox.enqueue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(dockValue("load")).toBe("22.5");
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(dockValue("load")).toBe("22.5");

    fireEvent.click(screen.getByRole("button", { name: /^LOG (SET|WARMUP)$/ }));
    await waitFor(() => expect(outbox.enqueue).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Current bracket cue\./)).toBeTruthy();
    await waitFor(() => expect(dockValue("load")).toBe("40"));
  });
});
