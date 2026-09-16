// @vitest-environment jsdom
//
// History has no other test file; this one only exercises the new
// BodyweightRow line, so the fixture is deliberately empty (no logged
// exercises, no sessions) — `bare` becomes true, and CheckinWeek /
// SessionHistory / the charts never mount, so nothing about them needs
// mocking here.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../hooks/useLocalToday", () => ({
  useLocalToday: () => "2026-09-16",
}));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "kg" }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/sync", () => ({
  outbox: {
    pendingDiscardIds: vi.fn().mockResolvedValue(new Set()),
    pendingVoidIds: vi.fn().mockResolvedValue(new Set()),
    flush: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue([]),
  },
}));

const getBodyweight = vi.fn();
const recordBodyweight = vi.fn();
vi.mock("../lib/data", async () => {
  // CheckinWeek's module (imported statically by History.tsx, even though
  // `bare` keeps it from ever mounting here) calls `makeFetchWithCache` at
  // import time, so a full mock of this module needs to keep that real
  // implementation around rather than only the handful of read/write calls
  // this test actually exercises.
  const actual =
    await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    makeFetchWithCache: actual.makeFetchWithCache,
    throwIf: actual.throwIf,
    getExercises: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    getLoggedExerciseIds: vi
      .fn()
      .mockResolvedValue({ data: [], fromCache: false }),
    getAdherence: vi.fn(),
    getE1rmSeries: vi.fn(),
    getGoalProgress: vi.fn(),
    getRecentSets: vi.fn(),
    getServerSessionSets: vi.fn(),
    getSessionMeta: vi.fn(),
    getSetNotesForExercise: vi.fn(),
    getWeeklyVolume: vi.fn(),
    invalidateForSessionClose: vi.fn(),
    invalidateForSetChange: vi.fn(),
    summariseAdherence: vi.fn(),
    worstStale: vi.fn(),
    getBodyweight: () => getBodyweight(),
    recordBodyweight: (...a: unknown[]) => recordBodyweight(...a),
  };
});

import { History } from "./History";
import { getSessionLog, getWeeklySummary } from "../lib/sessionHistory";
import { resetDbForTests } from "../lib/db";

vi.mock("../lib/sessionHistory", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/sessionHistory")
  >("../lib/sessionHistory");
  return {
    ...actual,
    getSessionLog: vi.fn(),
    getWeeklySummary: vi.fn(),
  };
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  vi.mocked(getSessionLog).mockResolvedValue({ data: [], fromCache: false });
  vi.mocked(getWeeklySummary).mockResolvedValue({
    data: null,
    fromCache: false,
  });
  getBodyweight.mockResolvedValue({
    data: [
      {
        measured_at: "2026-09-16T07:00:00.000Z",
        weight_kg: 77.1,
        source: "log" as const,
      },
    ],
    fromCache: false,
  });
});

afterEach(cleanup);

describe("History: bodyweight", () => {
  it("shows the same Log weight row Today has, reusing BodyweightRow", async () => {
    render(<History userId="11111111-1111-4111-8111-111111111111" />);

    await screen.findByText(
      "Nothing logged yet — finish a session and it shows up here.",
    );
    expect(await screen.findByText(/77.1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });
});
