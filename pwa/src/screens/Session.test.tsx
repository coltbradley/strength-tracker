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
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
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
  },
}));

import { outbox } from "../lib/sync";
import { getServerSessionSets } from "../lib/data";
import { Session } from "./Session";

afterEach(cleanup);

const active: ActiveSession = {
  id: "session-1",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function prescription(
  id: string,
  exerciseId: string,
  name: string,
  loadKg: number,
): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position: id === "bench" ? 0 : 1,
    sets: 1,
    reps_min: id === "bench" ? 8 : 5,
    reps_max: id === "bench" ? 8 : 5,
    rest_seconds: 60,
    notes: null,
    load_kg: loadKg,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: loadKg,
    plate_load_kg: null,
    superset_group: null,
  };
}

const bench = prescription("bench", "bench-press", "Bench Press", 20);
const squat = prescription("squat", "back-squat", "Back Squat", 100);
const benchSet: SetInsert = {
  id: "bench-set-1",
  session_id: active.id,
  exercise_id: bench.exercise_id,
  prescription_id: bench.id,
  set_index: 0,
  set_type: "working",
  load_kg: 20,
  reps: 8,
  performed_at: "2026-09-12T12:05:00.000Z",
  rest_seconds_actual: null,
  load_entry: "total",
  rpe: null,
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  vi.mocked(getServerSessionSets).mockResolvedValue([benchSet]);
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), [bench, squat]);
  await cacheSet(cacheKeys.sessionSets(active.id), [benchSet]);
});

describe("Session corrections", () => {
  it("keeps a staged correction on its source entry when another Detail is requested", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // This scenario is eligible for focus, which is now the default on
    // start — go to the workout overview first, since "expand details" is
    // the accordion's own control.
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

    fireEvent.click(screen.getByRole("button", { name: "expand details" }));

    expect(screen.getByText("TARGET 1×8 @ 20 KG · REST 1:00")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe("Session log lock", () => {
  it("logs one set for a double LOG tap and flashes .is-held without a second insert", async () => {
    resetDbForTests();
    const squat2 = {
      ...prescription("squat", "back-squat", "Back Squat", 100),
      sets: 2,
    };
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat2]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    // The reps stepper initializes from the fallback setting (8) before the
    // async prefill effect syncs it to this prescription's target (5); wait
    // for that to settle before tapping LOG, matching the established
    // pattern in Session.focus.test.tsx's "no hidden bar fallback" test.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);
    fireEvent.click(log);

    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /log set/i }).className,
    ).toContain("is-held");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 130));
    });
    expect(
      screen.getByRole("button", { name: /log set/i }).className,
    ).not.toContain("is-held");
  });

  it("applies a correction started right after a log, before the 200 ms lock clears", async () => {
    resetDbForTests();
    const squat1 = prescription("squat", "back-squat", "Back Squat", 100);
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat1]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    // See the log-lock test above: wait for the prefill effect to settle
    // reps at the prescription's target before logging, or a flaky race
    // with the fallback default (8) makes this set's reps unpredictable.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);

    // No wait here — the 200 ms log lock from the tap above is still
    // engaged. A correction must go through anyway (Decision 6).
    fireEvent.click(
      screen.getByRole("button", { name: "more options for Back Squat" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "correct set 1" }),
    );
    // No jest-dom in this project (see CheckInSheet.render.test.tsx) -- read
    // the DOM state toBeDisabled() would, without adding a dependency.
    const saveButton = screen.getByRole("button", {
      name: "SAVE SET 1",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(saveButton);

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(3),
    );
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      kind: "insert",
      table: "sets",
      payload: { reps: 6 },
    });
    expect(vi.mocked(outbox.enqueue).mock.calls[2]?.[0]).toMatchObject({
      kind: "insert",
      table: "set_voids",
    });
  });

  it("keeps stepper and pad edits live while the log lock is engaged", async () => {
    resetDbForTests();
    const squat2 = {
      ...prescription("squat", "back-squat", "Back Squat", 100),
      sets: 2,
    };
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat2]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "increase load by 2.5 kg" }),
    );
    expect(
      screen.getByRole("button", { name: "load value — tap to type" })
        .textContent,
    ).toBe("102.5");

    fireEvent.click(
      screen.getByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    // Neither edit was a LOG tap, so the lock never engaged twice.
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
  });
});
