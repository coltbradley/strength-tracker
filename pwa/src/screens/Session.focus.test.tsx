// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import { resetAllSettings, setSetting } from "../lib/settings";
import type { ActiveSession, ResolvedPrescriptionRow } from "../lib/types";

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
  },
}));

import { Session } from "./Session";

const active: ActiveSession = {
  id: "session-focus-1",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function prescription(tracking: ResolvedPrescriptionRow["tracking"] = "reps"): ResolvedPrescriptionRow {
  return {
    id: "bench",
    planned_workout_id: "workout-1",
    exercise_id: "bench-press",
    exercise_name: "Bench Press",
    position: 0,
    sets: 2,
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
    tracking,
  };
}

async function seed(tracking: ResolvedPrescriptionRow["tracking"] = "reps") {
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), [prescription(tracking)]);
  await cacheSet(cacheKeys.sessionSets(active.id), []);
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  resetAllSettings();
  await seed();
});

afterEach(() => {
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

  it("keeps a timed session in overview and explains why focus is unavailable", async () => {
    resetDbForTests();
    await seed("time");
    setSetting("focusDeckPreview", true);
    render(<MemoryRouter><Session /></MemoryRouter>);

    expect(await screen.findByText(/duration tracking is not available in focus mode/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View full workout" })).toBeNull();
  });
});
