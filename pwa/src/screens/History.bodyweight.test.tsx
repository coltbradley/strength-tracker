// @vitest-environment jsdom
//
// History has no other test file; this one only exercises the new
// BodyweightRow line, so the fixture is deliberately empty (no logged
// exercises, no sessions) — `bare` becomes true, and CheckinWeek /
// SessionHistory / the charts never mount, so nothing about them needs
// mocking here.
//
// BodyweightRow's "Update" vs "Weigh in" label depends on comparing a fixed
// `measured_at` against the REAL clock (`agoLabel(latest.measured_at, new
// Date())` — see BodyweightRow.tsx), not against the mocked `useLocalToday`.
// A hardcoded calendar date in the fixture is date rot waiting to happen: it
// read as "today" only until the real date rolled past it, then silently
// flipped the button label out from under the assertion. `todayRef` and the
// fixtures below are derived from `new Date()` at the top of each test run,
// so the pair stays self-consistent whatever day this actually runs on.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const todayRef = vi.hoisted(() => ({ current: "" }));

vi.mock("../hooks/useLocalToday", () => ({
  useLocalToday: () => todayRef.current,
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
    getObservations: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    deleteObservation: vi.fn().mockResolvedValue(undefined),
  };
});

import { History } from "./History";
import { getSessionLog, getWeeklySummary } from "../lib/sessionHistory";
import { resetDbForTests } from "../lib/db";
import { todayLocalIso } from "../lib/format";

/** An ISO instant on `d`'s local calendar day, at a fixed local time. Only
 * the calendar day matters to `agoLabel` (see BodyweightRow.tsx), so the
 * hour is arbitrary — it exists to keep the string readable as "morning". */
function localIsoAt(d: Date, hour: number): string {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    hour,
    0,
    0,
    0,
  ).toISOString();
}

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
  todayRef.current = todayLocalIso(new Date());
  vi.mocked(getSessionLog).mockResolvedValue({ data: [], fromCache: false });
  vi.mocked(getWeeklySummary).mockResolvedValue({
    data: null,
    fromCache: false,
  });
});

afterEach(cleanup);

describe("History: bodyweight", () => {
  it("shows the same Log weight row Today has, reusing BodyweightRow", async () => {
    getBodyweight.mockResolvedValue({
      data: [
        {
          measured_at: localIsoAt(new Date(), 7),
          weight_kg: 77.1,
          source: "log" as const,
        },
      ],
      fromCache: false,
    });

    render(<History userId="11111111-1111-4111-8111-111111111111" />);

    await screen.findByText(
      "Nothing logged yet — finish a session and it shows up here.",
    );
    expect(await screen.findByText(/77.1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("offers Weigh in, not Update, when the last weigh-in was not today", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    getBodyweight.mockResolvedValue({
      data: [
        {
          measured_at: localIsoAt(yesterday, 7),
          weight_kg: 77.1,
          source: "log" as const,
        },
      ],
      fromCache: false,
    });

    render(<History userId="11111111-1111-4111-8111-111111111111" />);

    await screen.findByText(
      "Nothing logged yet — finish a session and it shows up here.",
    );
    expect(await screen.findByText(/77.1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Weigh in" })).toBeTruthy();
  });
});
