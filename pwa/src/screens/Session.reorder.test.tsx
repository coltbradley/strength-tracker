// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheGet, cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import { resetAllSettings } from "../lib/settings";
import type { ActiveSession, ResolvedPrescriptionRow } from "../lib/types";

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
import { getExercises, getLastActuals, getServerSessionSets } from "../lib/data";

const active: ActiveSession = {
  id: "session-reorder-1",
  planned_workout_id: "workout-1",
  started_at: "2026-10-01T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function rx(id: string, exerciseId: string, name: string, position: number): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position,
    sets: 1,
    reps_min: 8,
    reps_max: 8,
    rest_seconds: 60,
    notes: null,
    load_kg: 20,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 20,
    plate_load_kg: null,
    superset_group: null,
    tracking: "reps",
  };
}

const PLAN = [
  rx("bench", "bench-press", "Bench Press", 0),
  rx("squat", "back-squat", "Back Squat", 1),
  rx("row", "barbell-row", "Barbell Row", 2),
];

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  resetAllSettings();
  vi.clearAllMocks();
  vi.mocked(getExercises).mockReset();
  vi.mocked(getLastActuals).mockReset();
  vi.mocked(getServerSessionSets).mockReset();
  vi.mocked(outbox.enqueue).mockReset();
  vi.mocked(outbox.enqueueBatch).mockReset();
  vi.mocked(getExercises).mockResolvedValue({ data: [], error: null, status: 200, statusText: "OK" } as any);
  vi.mocked(getLastActuals).mockResolvedValue({ data: {}, fromCache: false, stale: null } as any);
  vi.mocked(getServerSessionSets).mockResolvedValue([] as any);
  vi.mocked(outbox.enqueue).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueBatch).mockResolvedValue(undefined);
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), PLAN);
  await cacheSet(cacheKeys.sessionSets(active.id), []);
});

afterEach(() => {
  cleanup();
  resetAllSettings();
});

async function logFirstAndFindNext() {
  fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
  await waitFor(() => expect(outbox.enqueue).toHaveBeenCalled());
  const op = vi.mocked(outbox.enqueue).mock.calls[0]?.[0];
  if (op?.kind !== "insert" || op.table !== "sets")
    throw new Error("expected set insert");
  return op.payload;
}

describe("Session today's order (session-local reorder)", () => {
  it("reorders in the overview, persists device-locally, and never touches the plan or the outbox", async () => {
    // a 3-member superset is an overview-only circuit, so the overview shows
    const ss = (id: string, ex: string, name: string, pos: number) => ({
      ...rx(id, ex, name, pos),
      superset_group: 1,
    });
    await cacheSet(cacheKeys.sessionRx(active.id), [
      ss("a", "ex-a", "Alpha", 0),
      ss("b", "ex-b", "Bravo", 1),
      ss("c", "ex-c", "Charlie", 2),
      rx("d", "ex-d", "Delta", 3),
      rx("e", "ex-e", "Echo", 4),
    ]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );
    // the screen may remount once sets load; click until the list is up
    await waitFor(() => {
      const toggle = screen.queryByRole("button", {
        name: "Reorder today’s workout",
      });
      if (toggle) fireEvent.click(toggle);
      expect(screen.getByRole("list", { name: "Today's order" })).toBeTruthy();
    });
    const handle = () =>
      screen.getByRole("button", { name: /^Reorder Echo/ });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(
      screen
        .getAllByRole("listitem")
        .map((li) => li.querySelector(".reorder-title")?.textContent),
    ).toEqual(["Echo", "A1 Alpha · A2 Bravo · A3 Charlie", "Delta"]);

    await waitFor(async () =>
      expect(await cacheGet(cacheKeys.sessionOrder(active.id))).toEqual([
        "e",
        "a",
        "b",
        "c",
        "d",
      ]),
    );
    const planned = await cacheGet<ResolvedPrescriptionRow[]>(
      cacheKeys.sessionRx(active.id),
    );
    expect(planned?.map((r) => [r.id, r.position])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
      ["e", 4],
    ]);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(outbox.enqueueBatch).not.toHaveBeenCalled();
  });

  it("a saved order drives focus: next exercise follows it, and the set keeps its prescription link", async () => {
    await cacheSet(cacheKeys.sessionOrder(active.id), ["squat", "row", "bench"]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );
    // first unfinished entry in TODAY's order is Back Squat
    expect(
      await screen.findByLabelText("Back Squat set"),
    ).toBeTruthy();
    const payload = await logFirstAndFindNext();
    expect(payload.prescription_id).toBe("squat");
    expect(payload.exercise_id).toBe("back-squat");
    expect(payload.set_index).toBe(0);
    // focus advances to what follows in TODAY's order (Row), not the plan's
    // next (Bench)
    expect(
      await screen.findByLabelText("Barbell Row set"),
    ).toBeTruthy();
  });

  it("ignores stale keys in a saved order", async () => {
    await cacheSet(cacheKeys.sessionOrder(active.id), ["gone", "row", "bench"]);
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );
    const payload = await logFirstAndFindNext();
    expect(payload.prescription_id).toBe("row");
  });
});
