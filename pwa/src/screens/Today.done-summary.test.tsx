// @vitest-environment jsdom
//
// A DONE day used to say only "DONE" — nothing about what happened. Once
// End.tsx writes a doneSummary cache entry keyed by the planned day
// (screens/End.tsx), Today should read it back the same lazy way it
// already reads prescriptions (loadRx).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const {
  getPlannedWorkouts,
  getDoneWorkoutIds,
  getResolvedPrescriptions,
  getUnratedSession,
  syncOpenSessions,
} = vi.hoisted(() => ({
  getPlannedWorkouts: vi.fn(),
  getDoneWorkoutIds: vi.fn(),
  getResolvedPrescriptions: vi.fn(),
  getUnratedSession: vi.fn(),
  syncOpenSessions: vi.fn(),
}));

vi.mock("../lib/data", () => ({
  getPlannedWorkouts: (...a: unknown[]) => getPlannedWorkouts(...a),
  getDoneWorkoutIds: (...a: unknown[]) => getDoneWorkoutIds(...a),
  getResolvedPrescriptions: (...a: unknown[]) =>
    getResolvedPrescriptions(...a),
  getUnratedSession: (...a: unknown[]) => getUnratedSession(...a),
  syncOpenSessions: (...a: unknown[]) => syncOpenSessions(...a),
  getExercises: vi
    .fn()
    .mockResolvedValue({ data: [], fromCache: false, stale: null }),
  getLastActuals: vi
    .fn()
    .mockResolvedValue({ data: [], fromCache: false, stale: null }),
  getServerSessionSets: vi.fn().mockResolvedValue([]),
  invalidateForSessionClose: vi.fn().mockResolvedValue(undefined),
  staleReason: () => "error",
  updatePlannedWorkout: vi.fn(),
  createPlannedWorkout: vi.fn(),
  applyTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  weekOrder: (a: { day_index: number }, b: { day_index: number }) =>
    a.day_index - b.day_index,
  makeFetchWithCache:
    () => async (_key: string, fetcher: () => Promise<unknown>) => ({
      data: await fetcher(),
      fromCache: false,
      stale: null,
    }),
}));

vi.mock("../lib/sync", () => ({
  outbox: {
    flush: vi.fn().mockResolvedValue(undefined),
    pendingSessionUpdateIds: vi.fn().mockResolvedValue(new Set()),
    pendingRatedSessionIds: vi.fn().mockResolvedValue(new Set()),
    enqueue: vi.fn(),
  },
}));

vi.mock("../lib/errors", () => ({
  reportError: vi.fn(),
  toast: vi.fn(),
}));

import { Today } from "./Today";
import { cacheSet, resetDbForTests } from "../lib/db";
import { doneSummaryKey } from "./End";

const PROGRAM = {
  id: "prog-1",
  name: "Full Body",
  source_note: null,
  created_at: "2026-09-01T00:00:00Z",
  confirmed_at: "2026-09-01T00:00:00Z",
};

// undated — the DAY 1..N fallback, whose row-detail is `dayDetail` too,
// the same function the dated week-strip card uses.
const WORKOUT = {
  id: "w-1",
  program_id: PROGRAM.id,
  day_index: 0,
  label: "Day 1",
  notes: null,
  scheduled_date: null,
  plan_note: null,
  skipped_at: null,
  exercise_count: 1,
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  getPlannedWorkouts.mockResolvedValue({
    data: { programs: [PROGRAM], workouts: [WORKOUT] },
    fromCache: false,
    stale: null,
  });
  getDoneWorkoutIds.mockResolvedValue({
    data: [WORKOUT.id],
    fromCache: false,
    stale: null,
  });
  getUnratedSession.mockResolvedValue(null);
  syncOpenSessions.mockResolvedValue({
    clearedActive: false,
    autoCompleted: 0,
    autoDiscarded: 0,
    orphan: null,
  });
  getResolvedPrescriptions.mockResolvedValue({
    data: [],
    fromCache: false,
    stale: null,
  });
  await cacheSet(doneSummaryKey(WORKOUT.id), {
    setCount: 4,
    durationSeconds: 47 * 60,
  });
});

afterEach(cleanup);

describe("Today: a DONE day's own summary", () => {
  it("shows the cached set count and duration once the day is expanded", async () => {
    render(<Today userId="u1" />);

    // DONE doesn't auto-expand (only TODAY does) — except that Today's own
    // undated-fallback auto-expand effect reads the CURRENT `states` map,
    // and on the very first render (before getDoneWorkoutIds has resolved)
    // this workout transiently reads as TODAY rather than DONE, which can
    // auto-open it before this assertion ever runs. Guard against clicking
    // an already-open row closed: check and click in the same tick, with no
    // `await` between them, so nothing else can interleave.
    const dayRow = await screen.findByText("Day 1");
    if (!dayRow.closest(".week-item")?.querySelector(".week-detail")) {
      fireEvent.click(dayRow);
    }

    expect(await screen.findByText(/4 sets/)).toBeTruthy();
    expect(screen.getByText(/47 MIN/)).toBeTruthy();
  });
});
