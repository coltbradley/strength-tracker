// @vitest-environment jsdom
//
// A coach turn writes through the MCP server, outside the PWA's mutation
// helpers, so `onPlanChanged` (lib/planChanges) is the only signal an
// already-open Today screen gets that its cached prescriptions are stale.
// The handler clears every cached prescription (`setRx({})`) and reloads —
// but "reload" only ever re-fetched the SELECTED date's workout. For an
// undated DAY 1..N program there is no selected date at all: the only
// "currently visible" prescriptions are whichever row someone tapped open
// (`expanded`), and nothing re-fetched that row, so its exercise list went
// blank until it was collapsed and reopened.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
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
  getResolvedPrescriptions: (...a: unknown[]) => getResolvedPrescriptions(...a),
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
  // Not exercised here (the sheet this test renders Today around is never
  // opened), but CheckInSheet -> checkinHistory.ts calls this at module load,
  // so a mock missing it throws before any test body runs.
  makeFetchWithCache:
    () => async (_key: string, fetcher: () => Promise<unknown>) => ({
      data: await fetcher(),
      fromCache: false,
      stale: null,
    }),
  throwIf: () => {},
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
import { notifyPlanChanged } from "../lib/planChanges";
import { resetDbForTests } from "../lib/db";

const PROGRAM = {
  id: "prog-1",
  name: "Full Body",
  source_note: null,
  created_at: "2026-09-01T00:00:00Z",
  confirmed_at: "2026-09-01T00:00:00Z",
};

// scheduled_date: null on every day -> anyDates is false -> the undated
// DAY 1..N fallback list, which is exactly the case with no `selectedWorkout`.
const WORKOUT = {
  id: "w1",
  program_id: PROGRAM.id,
  day_index: 0,
  label: "Day 1",
  notes: null,
  scheduled_date: null,
  plan_note: null,
  skipped_at: null,
  exercise_count: 1,
};

const rxRow = (name: string) => ({
  id: `${name}-rx`,
  planned_workout_id: WORKOUT.id,
  exercise_id: name,
  exercise_name: name,
  position: 0,
  sets: 3,
  reps_min: 5,
  reps_max: 5,
  rest_seconds: null,
  notes: null,
  load_kg: 60,
  load_pct_tm: null,
  tm_kg: null,
  resolved_load_kg: 60,
  plate_load_kg: null,
  superset_group: null,
});

afterEach(cleanup);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  getPlannedWorkouts.mockResolvedValue({
    data: { programs: [PROGRAM], workouts: [WORKOUT] },
    fromCache: false,
    stale: null,
  });
  getDoneWorkoutIds.mockResolvedValue({
    data: [],
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
    data: [rxRow("Squat")],
    fromCache: false,
    stale: null,
  });
});

describe("Today + coach plan changes (onPlanChanged)", () => {
  it("reloads a currently-expanded undated day instead of leaving it blank", async () => {
    render(<Today userId="u1" />);

    // The DAY 1..N fallback auto-expands today's row on mount.
    await screen.findByText("Squat");

    // A coach turn rewrote the day while this screen was still open.
    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Deadlift")],
      fromCache: false,
      stale: null,
    });
    notifyPlanChanged();

    await waitFor(() => expect(screen.queryByText("Squat")).toBeNull());
    // Must recover with the freshly-written plan, not sit blank forever.
    await waitFor(() => expect(screen.queryByText("Deadlift")).toBeTruthy());
  });

  it("renders Train as a separate surface while leaving Program's tree intact", async () => {
    render(<Today presentation="train" />);

    await screen.findByText("Day 1");
    expect(await screen.findByText("1 movement · 3 sets")).toBeTruthy();
    expect(screen.getByText("Squat")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View program" }).getAttribute("href"),
    ).toBe("/program");
    expect(screen.queryByText("THIS WEEK")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByText("3×5")).toBeNull();
  });

  it("shows a failed Train details read and retries it when the plan refreshes", async () => {
    getResolvedPrescriptions.mockRejectedValue(new Error("connection lost"));

    render(<Today presentation="train" />);

    await screen.findByText(
      "Couldn’t load workout details. Refresh your plan to retry.",
    );

    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Deadlift")],
      fromCache: false,
      stale: null,
    });

    notifyPlanChanged();

    expect(await screen.findByText("Deadlift")).toBeTruthy();
    expect(getResolvedPrescriptions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["offline", "Offline, showing saved workout details."],
    ["error", "Couldn’t refresh, showing saved workout details."],
  ] as const)(
    "keeps cached %s Train details usable while naming their freshness",
    async (stale, note) => {
      getResolvedPrescriptions.mockResolvedValue({
        data: [rxRow("Squat")],
        fromCache: true,
        stale,
      });

      render(<Today presentation="train" />);

      expect(await screen.findByText("1 movement · 3 sets")).toBeTruthy();
      expect(screen.getByText(note)).toBeTruthy();
    },
  );

  it("replaces stale cached Train details when the plan refreshes", async () => {
    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Squat")],
      fromCache: true,
      stale: "offline",
    });

    render(<Today presentation="train" />);

    await screen.findByText("Offline, showing saved workout details.");

    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Deadlift")],
      fromCache: false,
      stale: null,
    });
    notifyPlanChanged();

    expect(await screen.findByText("Deadlift")).toBeTruthy();
    expect(
      screen.queryByText("Offline, showing saved workout details."),
    ).toBeNull();
    expect(getResolvedPrescriptions).toHaveBeenCalledTimes(2);
  });

  it("coalesces Train's overlapping prescription load for an undated workout", async () => {
    let resolveRead: (value: {
      data: ReturnType<typeof rxRow>[];
      fromCache: boolean;
      stale: null;
    }) => void;
    getResolvedPrescriptions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    render(<Today presentation="train" />);

    await waitFor(() =>
      expect(getResolvedPrescriptions).toHaveBeenCalledTimes(1),
    );
    resolveRead!({ data: [rxRow("Squat")], fromCache: false, stale: null });
  });
});
