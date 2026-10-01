// @vitest-environment jsdom
//
// The Version D focus screen, end to end through Session: the rest panel with
// the last saved set, what to load next, the dock's fourth key, and the
// bodyweight added-load flow. Component-level behaviour lives in
// FocusDeck/SetEditor/LoadPicture/RestTimer tests.

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import { resetAllSettings } from "../lib/settings";
import type { ActiveSession, ResolvedPrescriptionRow, SetInsert } from "../lib/types";

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
  getCurrentUserId: () => "aaaaaaaa-1111-4111-8111-111111111111",
  onUserChange: () => () => undefined,
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
    subscribeSynced: vi.fn(() => () => undefined),
    getStatus: vi.fn(() => ({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null })),
    isStatusKnown: vi.fn(() => true),
  },
}));

import { Session } from "./Session";
import { outbox } from "../lib/sync";
import { getExercises, getLastActuals, getServerSessionSets } from "../lib/data";

const active: ActiveSession = {
  id: "session-focus-d",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function rx(
  id: string,
  exerciseId: string,
  name: string,
  loadKg: number | null,
  sets = 3,
): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position: 0,
    sets,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 90,
    notes: null,
    load_kg: loadKg,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: loadKg,
    plate_load_kg: null,
    superset_group: null,
    tracking: "reps",
  };
}

async function seed(rows: ResolvedPrescriptionRow[], sets: SetInsert[] = []) {
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), rows);
  await cacheSet(cacheKeys.sessionSets(active.id), sets);
  vi.mocked(getServerSessionSets).mockResolvedValue(sets as never);
}

function equipment(...rows: Array<[string, string, string]>) {
  vi.mocked(getExercises).mockResolvedValue({
    data: rows.map(([id, name, eq]) => ({ id, name, equipment: eq })),
  } as never);
}

function renderSession() {
  render(
    <MemoryRouter>
      <Session />
    </MemoryRouter>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

function queuedSets(): SetInsert[] {
  return vi
    .mocked(outbox.enqueue)
    .mock.calls.map(([op]) => op)
    .filter((op) => op.kind === "insert" && op.table === "sets")
    .map((op) => (op as { payload: SetInsert }).payload);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  resetAllSettings();
  vi.clearAllMocks();
  vi.mocked(getExercises).mockResolvedValue({ data: [] } as never);
  vi.mocked(getLastActuals).mockResolvedValue({
    data: {},
    fromCache: false,
    stale: null,
  } as never);
  vi.mocked(outbox.enqueue).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueBatch).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueCorrection).mockResolvedValue(undefined);
  vi.mocked(outbox.inspect).mockResolvedValue([]);
  vi.mocked(outbox.correctionLinks).mockResolvedValue({});
  vi.mocked(outbox.subscribe).mockReturnValue(() => undefined);
  vi.mocked(outbox.subscribeSynced).mockReturnValue(() => undefined);
  vi.mocked(outbox.getStatus).mockReturnValue({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null });
  vi.mocked(outbox.isStatusKnown).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  resetAllSettings();
});

describe("Session focus rest panel", () => {
  it("replaces the picture with the rest clock and the set just saved, tagging the dock as the NEXT set", async () => {
    equipment(["bench-press", "Bench Press", "barbell"]);
    await seed([rx("bench", "bench-press", "Bench Press", 60)]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    expect(screen.getByRole("button", { name: /Open plates$/ })).toBeTruthy();
    expect(screen.queryByText("LAST SET")).toBeNull();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));

    expect(await screen.findByText("◷ RESTING")).toBeTruthy();
    expect(screen.getByText("LAST SET")).toBeTruthy();
    expect(screen.getByText("Bench Press · set 1 · 60 kg × 5")).toBeTruthy();
    // the card claims only what the receipt proves: queued here, not "saved"
    expect(screen.queryByText(/already saved/i)).toBeNull();
    expect(screen.queryByRole("status", { name: /Saved to the server/ })).toBeNull();
    // the numbers below belong to the next set, and the picture is gone from
    // the middle band (what to load next takes its place)
    expect(screen.getByText("NEXT SET · SET 2 OF 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "End rest now ›" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open plates$/ })).toBeNull();
  });

  it("reads SET n OF m · WARMUP for the warmups of a mixed entry", async () => {
    equipment(["bench-press", "Bench Press", "barbell"]);
    await seed([
      { ...rx("bench-w", "bench-press", "Bench Press", 40, 2), set_type: "warmup", position: 0 },
      { ...rx("bench", "bench-press", "Bench Press", 60, 3), set_type: "working", position: 1 },
    ]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    await settle();
    // the plan opens on its first warmup
    expect(screen.getByText("SET 1 OF 2 · WARMUP")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^LOG (SET|WARMUP)$/ }));
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(1));
    expect(await screen.findByText("SET 2 OF 2 · WARMUP")).toBeTruthy();
  });

  it("names the saved set by its working-set number, not set_index (which counts warmups)", async () => {
    equipment(["bench-press", "Bench Press", "barbell"]);
    const prior = (index: number, type: "warmup" | "working"): SetInsert => ({
      id: `bench-${index}`,
      session_id: active.id,
      exercise_id: "bench-press",
      prescription_id: "bench",
      set_index: index,
      set_type: type,
      load_kg: 60,
      reps: 5,
      performed_at: `2026-09-12T12:0${index}:00.000Z`,
      rest_seconds_actual: null,
      load_entry: "total",
      rpe: null,
    });
    // one warmup (index 0) then two working sets (1, 2); the third working
    // set is logged now at index 3
    await seed(
      [rx("bench", "bench-press", "Bench Press", 60, 4)],
      [prior(0, "warmup"), prior(1, "working"), prior(2, "working")],
    );
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));

    expect(await screen.findByText("LAST SET")).toBeTruthy();
    expect(queuedSets()[0]?.set_index).toBe(3);
    expect(screen.getByText("Bench Press · set 3 · 60 kg × 5")).toBeTruthy();
    expect(screen.queryByText("Bench Press · set 4 · 60 kg × 5")).toBeNull();
  });

  it("Fix on the saved-set card starts a correction of that set: set_index kept, original voided", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60)]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByText("LAST SET");
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));

    // correcting happens in its own sheet; the next-set draft is untouched
    const sheet = within(await screen.findByRole("dialog", { name: /^Fix / }));
    fireEvent.click(sheet.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(sheet.getByRole("button", { name: "Save correction" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const [sessionId, replacement, originalId] = vi.mocked(outbox.enqueueCorrection).mock.calls[0]!;
    expect(sessionId).toBe(active.id);
    const [original] = queuedSets();
    expect(original).toMatchObject({ set_index: 0, reps: 5, load_kg: 60 });
    expect(replacement).toMatchObject({ set_index: 0, reps: 6, load_kg: 60 });
    expect(originalId).toBe(original!.id);
  });

  it("ends the rest early from the dock tag", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60)]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    fireEvent.click(await screen.findByRole("button", { name: "End rest now ›" }));

    // the target becomes the elapsed whole seconds, so the rest is over within
    // a second (the clock ticks every 400 ms)
    await vi.waitFor(
      () => expect(screen.queryByRole("button", { name: "End rest now ›" })).toBeNull(),
      { timeout: 3000 },
    );
    expect(screen.getByText("■ REST OVER")).toBeTruthy();
    // D8: the target is kept, never overwritten with the elapsed seconds
    expect(screen.getByText(/^Ended early at 0:0\d · target [1-9]:\d\d$/)).toBeTruthy();
  });
});

describe("Session focus load picture", () => {
  it("offers LOAD NEXT with the plates while resting on a plate-loaded exercise", async () => {
    equipment(["bench-press", "Bench Press", "barbell"]);
    await seed([rx("bench", "bench-press", "Bench Press", 60)]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));

    expect(await screen.findByText("LOAD NEXT")).toBeTruthy();
    const card = screen.getByText("LOAD NEXT").closest("button")!;
    expect(card.textContent).toContain("20 per side");
    // it is the way into the plate sheet
    fireEvent.click(card);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("D6: a dumbbell exercise keeps its pair as a compact LOAD NEXT card while resting, and the card still switches one/two", async () => {
    equipment(["db-press", "Dumbbell Press", "dumbbell"]);
    await seed([rx("db", "db-press", "Dumbbell Press", 40)]);
    renderSession();

    await screen.findByRole("heading", { name: "Dumbbell Press" });
    await settle();
    expect(screen.getByRole("button", { name: /dumbbell is the total|total\. Switch/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));

    await screen.findByText("LAST SET");
    const card = screen.getByText("LOAD NEXT").closest(".focus-load-next") as HTMLElement;
    expect(card.querySelectorAll(".lp-db")).toHaveLength(2);
    const before = card.textContent;
    fireEvent.click(card);
    const after = (screen.getByText("LOAD NEXT").closest(".focus-load-next") as HTMLElement);
    expect(after.querySelectorAll(".lp-db")).toHaveLength(1);
    expect(after.textContent).not.toBe(before);
  });

  it("D6: a pin-stack exercise keeps its pin picture as LOAD NEXT while resting", async () => {
    equipment(["leg-ext", "Leg Extensions", "machine"]);
    await seed([rx("le", "leg-ext", "Leg Extensions", 40)]);
    renderSession();

    await screen.findByRole("heading", { name: "Leg Extensions" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));

    await screen.findByText("LAST SET");
    const card = screen.getByText("LOAD NEXT").closest(".focus-load-next") as HTMLElement;
    expect(card.querySelector(".lp-stack")).not.toBeNull();
    expect(card.textContent).toMatch(/Pin at 40 kg/);
  });
});

describe("Session focus fourth key", () => {
  it("is Swap before any set and Fix last after the first log, which corrects that set", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60)]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    await settle();
    expect(screen.getByRole("button", { name: "Swap" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix last" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fix last" }));
    expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: /^Fix / })).toBeTruthy();
  });

  it("Swap opens the exercise picker", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60)]);
    renderSession();

    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(await screen.findByRole("searchbox", { name: "search exercises" })).toBeTruthy();
  });
});

describe("Session focus bodyweight added load", () => {
  async function pushUps() {
    equipment(["push-up", "Push Up", "body only"]);
    await seed([rx("pushup", "push-up", "Push Up", null)]);
    renderSession();
    await screen.findByRole("heading", { name: "Push Up" });
    await settle();
  }

  it("starts reps-only with an + Add load link, and no load card", async () => {
    await pushUps();

    expect(screen.getByText("Bodyweight")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add load (belt or vest)" })).toBeTruthy();
    expect(screen.queryByText("added")).toBeNull();
    expect(screen.queryByRole("button", { name: /^load /i })).toBeNull();
  });

  it("+ Add load opens the added-load row; stepping it logs that load, and × takes it back to zero", async () => {
    await pushUps();

    fireEvent.click(screen.getByRole("button", { name: "+ Add load (belt or vest)" }));
    expect(screen.queryByRole("button", { name: "+ Add load (belt or vest)" })).toBeNull();
    expect(screen.getByText("added")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^increase added load by / }));
    const row = document.querySelector(".dock-added-load")!;
    const staged = row.querySelector("b")!.textContent!;
    expect(staged).not.toMatch(/\+ 0 kg/);

    // × removes it and the link comes back
    fireEvent.click(screen.getByRole("button", { name: "remove added load" }));
    expect(document.querySelector(".dock-added-load")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add load (belt or vest)" })).toBeTruthy();

    // add it again and log: the staged load is what is saved
    fireEvent.click(screen.getByRole("button", { name: "+ Add load (belt or vest)" }));
    fireEvent.click(screen.getByRole("button", { name: /^increase added load by / }));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(1));
    expect(queuedSets()[0]!.load_kg).toBeGreaterThan(0);
  });

  it("logging after × stores zero load, not the removed amount", async () => {
    await pushUps();

    fireEvent.click(screen.getByRole("button", { name: "+ Add load (belt or vest)" }));
    fireEvent.click(screen.getByRole("button", { name: /^increase added load by / }));
    fireEvent.click(screen.getByRole("button", { name: "remove added load" }));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));

    await vi.waitFor(() => expect(queuedSets()).toHaveLength(1));
    expect(queuedSets()[0]).toMatchObject({ exercise_id: "push-up", load_kg: 0 });
  });
});
