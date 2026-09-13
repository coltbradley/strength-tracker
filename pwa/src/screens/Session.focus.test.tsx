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
import { cacheGet, cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import { resetAllSettings } from "../lib/settings";
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
  rows: ResolvedPrescriptionRow[] = [
    prescription("bench", "bench-press", "Bench Press", tracking),
  ],
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
  it("opens an eligible started or restored session in focus mode by default", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "View full workout" }),
    ).toBeTruthy();
  });

  it("returns to overview without discarding staged values", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "View full workout" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));

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
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Back Squat" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    expect(
      await screen.findByRole("heading", { name: "Back Squat" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));
    fireEvent.click(screen.getByRole("button", { name: "Bench Press" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
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

  it("keeps a timed session in overview and explains why focus is unavailable", async () => {
    resetDbForTests();
    await seed("time");
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        /duration tracking is not available in focus mode/i,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "View full workout" }),
    ).toBeNull();
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
    expect(
      screen.queryByRole("button", { name: "Next · Back Squat" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Next exercise" }),
    );

    expect(screen.getByRole("heading", { name: "Back Squat" })).toBeTruthy();
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

  it("keeps tick-only focus navigation and logging on the same entry", async () => {
    resetDbForTests();
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Next exercise" }),
    );

    expect(screen.getByRole("heading", { name: "Farmer Carry" })).toBeTruthy();
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

  it("keeps both drafts visible when the local round batch fails", async () => {
    resetDbForTests();
    await seed("reps", [
      prescription("bench", "bench-press", "Bench Press", "reps", 1, 2),
      prescription("row", "barbell-row", "Barbell Row", "reps", 1, 2),
    ]);
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
    fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    expect(screen.queryByRole("button", { name: "Log round" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log A2 only" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(2),
    );

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

    fireEvent.click(
      await screen.findByRole("button", { name: "View full workout" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Barbell Row" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));

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
      await screen.findByRole("button", { name: "View full workout" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Bench Press" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));
    expect(
      await screen.findByRole("button", { name: "Next exercise" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "more options for Bench Press" }),
    );
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
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // Bench is already done, so the session opens in focus on Squat. Switch
    // to overview, open Bench, and start correcting its logged set.
    fireEvent.click(
      await screen.findByRole("button", { name: "View full workout" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "expand details" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "correct set 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    // Select Squat (a future focus destination, not a navigation) and enter
    // Focus mode. The correction in progress must win: Bench stays open with
    // its staged edit, not Squat with a fresh prefill.
    fireEvent.click(screen.getByRole("button", { name: "Back Squat" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus mode" }));

    expect(
      await screen.findByRole("heading", { name: "Bench Press" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
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
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Next exercise" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Back Squat" }),
    ).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    // past LOG_LOCK_MS, or the correction's own Save below is a no-op tap on
    // a still-locked button.
    await new Promise((resolve) => window.setTimeout(resolve, 450));

    fireEvent.click(
      screen.getByRole("button", { name: "more options for Back Squat" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "correct set 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "View full workout" }));

    // The correction on Back Squat must still be the one on screen, staged.
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "SAVE SET 1" }));
    // calls[0] logged Bench, calls[1] logged Squat, calls[2] is the
    // correction's replacement row (calls[3] is its matching void).
    expect(vi.mocked(outbox.enqueue).mock.calls[2]?.[0]).toMatchObject({
      payload: { exercise_id: "back-squat", reps: 9 },
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
      ...prescription("bench", "bench-press", "Bench Press", "reps", 1, 1),
      rest_seconds: 90,
    };
    const rowRx: ResolvedPrescriptionRow = {
      ...prescription("row", "barbell-row", "Barbell Row", "reps", 1, 1),
      rest_seconds: 45,
    };
    await seed("reps", [benchRx, rowRx]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // Focus opens on Bench (the round's first, canonical member), so the
    // top-level `restSeconds` hook value reflects Bench's own 90s bracket —
    // the wrong number for a strip that starts after Row, the round's last
    // performed exercise, whose own bracket says 45s.
    await screen.findByText("round 1 of 1");
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    expect(await screen.findByText("0:45")).toBeTruthy();
    expect(screen.queryByText("1:30")).toBeNull();
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
    const a1More = screen.getByLabelText("A1 Bench Press · more");
    fireEvent.click(within(a1More).getByRole("button", { name: "warmup" }));
    fireEvent.click(screen.getByRole("button", { name: "CLOSE" }));
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );

    // Bench's warmup is done and Row already met its target — only Bench's
    // real working set remains.
    await screen.findByRole("button", { name: "Log A1 only" });
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));

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
    expect(await cacheGet<string[]>(cacheKeys.sessionSkips(active.id))).toEqual(
      [],
    );
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
    expect(screen.queryByRole("button", { name: "Log A1 only" })).toBeNull();
    expect(screen.getByRole("button", { name: "Log A2 only" })).toBeTruthy();

    await new Promise((resolve) => window.setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole("button", { name: "Log A2 only" }));

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      payload: { exercise_id: "barbell-row", set_index: 1 },
    });
  });
});
