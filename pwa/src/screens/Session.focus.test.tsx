// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import { resetAllSettings, setSetting } from "../lib/settings";
import type { ActiveSession, ResolvedPrescriptionRow, SetInsert } from "../lib/types";

vi.mock("../lib/data", async () => {
  const actual = await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    ...actual,
    getExercises: vi.fn(async () => ({ data: [] })),
    getLastActuals: vi.fn(async () => ({ data: {} })),
    getServerSessionSets: vi.fn(async () => []),
    getSetNotesByIds: vi.fn(async () => ({})),
  };
});

vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    enqueueBatch: vi.fn(async () => undefined),
  },
}));

import { Session } from "./Session";
import { outbox } from "../lib/sync";
import { getExercises, getServerSessionSets } from "../lib/data";

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
  rows: ResolvedPrescriptionRow[] = [prescription("bench", "bench-press", "Bench Press", tracking)],
  sets: SetInsert[] = [],
) {
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), rows);
  await cacheSet(cacheKeys.sessionSets(active.id), sets);
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  resetAllSettings();
  vi.clearAllMocks();
  await seed();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetAllSettings();
});

describe("Session focus presentation", () => {
  it("returns to overview without discarding staged values", async () => {
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));

    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toBe("9");
  });

  it("preserves a staged draft after switching focus to another exercise", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 2),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(screen.getByRole("button", { name: "increase load by 0.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Back Squat" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    expect(await screen.findByRole("heading", { name: "Back Squat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Bench Press" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "reps value — tap to type" }).textContent).toBe("9");
    expect(screen.getByRole("button", { name: "load value — tap to type" }).textContent).toBe("20.5");
  });

  it("keeps a timed session in overview and explains why focus is unavailable", async () => {
    resetDbForTests();
    await seed("time");
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    expect(await screen.findByText(/duration tracking is not available in focus mode/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View full workout" })).toBeNull();
  });

  it("keeps normal focus navigation and logging on the same entry", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("squat", "back-squat", "Back Squat", "reps", null, 1),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET 1 OF 1" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 8, load_kg: 20 },
    });
    expect(screen.queryByRole("button", { name: "Next · Back Squat" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Next exercise" }));

    expect(screen.getByRole("heading", { name: "Back Squat" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET 1 OF 1" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      payload: { exercise_id: "back-squat", prescription_id: "squat" },
    });
  });

  it("logs the staged values from the overview set editor", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 2),
    ]);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET 1 OF 2" }));

    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 8, load_kg: 20 },
    });
  });

  it("keeps tick-only focus navigation and logging on the same entry", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", null, 1),
      prescription("carry", "farmer-carry", "Farmer Carry", "done", null, 1),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET 1 OF 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next exercise" }));

    expect(screen.getByRole("heading", { name: "Farmer Carry" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "DONE 1 OF 1" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      payload: { exercise_id: "farmer-carry", prescription_id: "carry", load_kg: 0, reps: 0 },
    });
  });

  it("does not expose focus next while a superset is unfinished", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next exercise" })).toBeNull();
  });

  it("logs both members of a superset round through one ordered local batch", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    expect(await screen.findByText("SUPERSET A · ROUND 1 OF 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1));
    const ops = vi.mocked(outbox.enqueueBatch).mock.calls[0]?.[0] ?? [];
    expect(ops).toHaveLength(2);
    expect(ops).toMatchObject([
      { kind: "insert", table: "sets", payload: { exercise_id: "bench-press", prescription_id: "bench", set_index: 0 } },
      { kind: "insert", table: "sets", payload: { exercise_id: "barbell-row", prescription_id: "row", set_index: 0 } },
    ]);
    const [first, second] = ops.filter(
      (op): op is Extract<typeof op, { kind: "insert"; table: "sets" }> =>
        op.kind === "insert" && op.table === "sets",
    );
    expect(first?.payload.id).not.toBe(second?.payload.id);
    expect(screen.queryByRole("button", { name: "Next exercise" })).toBeNull();
  });

  it("keeps both drafts visible when the local round batch fails", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    vi.mocked(outbox.enqueueBatch).mockRejectedValueOnce(new Error("disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setSetting("focusDeckPreview", true);
      render(<MemoryRouter><Session /></MemoryRouter>);

      await screen.findByText("SUPERSET A · ROUND 1 OF 2");
      fireEvent.click(screen.getAllByRole("button", { name: "increase reps by 1" })[0]);
      fireEvent.click(screen.getByRole("button", { name: "Log round" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /could not be saved locally.*retry/i,
      );
      expect(screen.getByLabelText("A1 Bench Press").textContent).toContain("9");
      expect(screen.queryByText("LOGGED")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setSetting("focusDeckPreview", true);
      render(<MemoryRouter><Session /></MemoryRouter>);

      expect(await screen.findByText("SUPERSET A · ROUND 1 OF 2")).toBeTruthy();
      fireEvent.click(screen.getAllByRole("button", { name: "increase reps by 1" })[0]!);
      fireEvent.click(screen.getByRole("button", { name: "Log round" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /could not be saved locally.*retry/i,
      );
      expect(screen.getByLabelText("A1 Bench Press").textContent).toContain("9");
      expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain("8");
      expect(screen.getByText("SUPERSET A · ROUND 1 OF 2")).toBeTruthy();
      expect(screen.getByText("SETS REMAINING 4")).toBeTruthy();
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
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await screen.findByText("SUPERSET A · ROUND 1 OF 2");
    const increaseReps = screen.getAllByRole("button", { name: "increase reps by 1" });
    fireEvent.click(increaseReps[0]);
    fireEvent.click(increaseReps[1]);
    fireEvent.click(increaseReps[1]);
    fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 9 },
    });
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
    expect(screen.getByLabelText("A2 Barbell Row").textContent).toContain("10");
  });

  it("finishes the active partial round with A2 only instead of logging A1 twice", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await screen.findByText("SUPERSET A · ROUND 1 OF 2");
    fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    expect(screen.queryByRole("button", { name: "Log round" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log A2 only" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2));

    expect(vi.mocked(outbox.enqueue).mock.calls.map((call) => call[0])).toMatchObject([
      { payload: { exercise_id: "bench-press", prescription_id: "bench", set_index: 0 } },
      { payload: { exercise_id: "barbell-row", prescription_id: "row", set_index: 0 } },
    ]);
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
  });

  it("returns to the canonical round editor when focus starts from A2", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Barbell Row" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));

    expect(await screen.findByText("SUPERSET A · ROUND 1 OF 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log round" })).toBeTruthy();
  });

  it("keeps rest timing through focus and overview changes", async () => {
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);
    const logSet = await screen.findByRole("button", { name: /log set/i });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    await act(async () => {
      fireEvent.click(logSet);
      await Promise.resolve();
    });
    expect(screen.getByRole("timer", { name: "rest timer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    act(() => vi.advanceTimersByTime(30_000));

    expect(screen.getByText("0:30")).toBeTruthy();
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
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    await screen.findByText("SUPERSET A · ROUND 1 OF 2");
    const a1 = screen.getByLabelText("A1 Bench Press");
    const a2 = screen.getByLabelText("A2 Barbell Row");
    fireEvent.click(within(a2).getByRole("button", { name: "reps value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));

    expect(a1.textContent).toContain("8");
    expect(a2.textContent).toContain("9");
    fireEvent.click(within(a2).getByRole("button", { name: /›/ }));
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
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Bench Press" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    expect(await screen.findByRole("button", { name: "Next exercise" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "correct set 1" }));

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
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    // Bench is already done, so the session opens in focus on Squat. Switch
    // to overview, open Bench, and start correcting its logged set.
    fireEvent.click(await screen.findByRole("button", { name: "View full workout" }));
    fireEvent.click(await screen.findByRole("button", { name: "expand details" }));
    fireEvent.click(await screen.findByRole("button", { name: "correct set 1" }));
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toBe("9");

    // Select Squat (a future focus destination, not a navigation) and enter
    // Focus mode. The correction in progress must win: Bench stays open with
    // its staged edit, not Squat with a fresh prefill.
    fireEvent.click(screen.getByRole("button", { name: "Back Squat" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));

    expect(await screen.findByRole("heading", { name: "Bench Press" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toBe("9");
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "bench-press", reps: 9, load_kg: 20 },
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
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET 1 OF 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next exercise" }));
    expect(await screen.findByRole("heading", { name: "Back Squat" })).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET 1 OF 1" }));
    // past LOG_LOCK_MS, or the correction's own Save below is a no-op tap on
    // a still-locked button.
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    fireEvent.click(await screen.findByRole("button", { name: "correct set 1" }));
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));

    // The correction on Back Squat must still be the one on screen, staged.
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));
    // calls[0] logged Bench, calls[1] logged Squat, calls[2] is the
    // correction's replacement row (calls[3] is its matching void).
    expect(vi.mocked(outbox.enqueue).mock.calls[2]?.[0]).toMatchObject({
      payload: { exercise_id: "back-squat", reps: 9 },
    });
  });
});
