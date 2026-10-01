// @vitest-environment jsdom
//
// The Record list: ordering, the PINNED GOALS section, pin / unpin through the
// goals write path, and the empty state. The pure ordering rules are in
// lib/record.test.ts; this proves the screen wires them and the writes.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../hooks/useLocalToday", () => ({ useLocalToday: () => "2026-10-01" }));
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
vi.mock("../components/BodyweightRow", () => ({ BodyweightRow: () => null }));
vi.mock("../components/CheckinWeek", () => ({ CheckinWeek: () => null }));

const goalsNow = vi.hoisted(() => ({ rows: [] as unknown[] }));
const setGoal = vi.fn();
const removeGoal = vi.fn();
const getRecordIndex = vi.fn();

vi.mock("../lib/data", async () => {
  const actual = await vi.importActual<typeof import("../lib/data")>("../lib/data");
  const empty = { data: [], fromCache: false, stale: null };
  return {
    makeFetchWithCache: actual.makeFetchWithCache,
    throwIf: actual.throwIf,
    getExercises: vi.fn().mockResolvedValue({
      data: [
        { id: "sq", name: "Back Squat" },
        { id: "bp", name: "Bench Press" },
        { id: "dl", name: "Deadlift" },
        { id: "cu", name: "Curl" },
      ],
      fromCache: false,
    }),
    getRecordIndex: () => getRecordIndex(),
    getGoals: () => Promise.resolve({ data: goalsNow.rows, fromCache: false }),
    setGoal: (...a: unknown[]) => setGoal(...a),
    removeGoal: (...a: unknown[]) => removeGoal(...a),
    getAdherence: vi.fn().mockResolvedValue(empty),
    getE1rmSeries: vi.fn().mockResolvedValue(empty),
    getRecentSets: vi.fn().mockResolvedValue(empty),
    getServerSessionSets: vi.fn().mockResolvedValue([]),
    getSessionMeta: vi.fn().mockResolvedValue({ data: {}, fromCache: false }),
    getSetNotesForExercise: vi.fn().mockResolvedValue({ data: {}, fromCache: false }),
    getWeeklyVolume: vi.fn().mockResolvedValue(empty),
    invalidateForSessionClose: vi.fn(),
    invalidateForSetChange: vi.fn(),
    summariseAdherence: vi.fn().mockReturnValue(new Map()),
    worstStale: vi.fn().mockReturnValue(null),
    getBodyweight: vi.fn().mockResolvedValue(empty),
    recordBodyweight: vi.fn(),
    getObservations: vi.fn().mockResolvedValue(empty),
    deleteObservation: vi.fn(),
  };
});

vi.mock("../lib/sessionHistory", async () => {
  const actual = await vi.importActual<typeof import("../lib/sessionHistory")>("../lib/sessionHistory");
  return {
    ...actual,
    getSessionLog: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    getWeeklySummary: vi.fn().mockResolvedValue({ data: null, fromCache: false }),
  };
});

import { History } from "./History";
import { resetDbForTests } from "../lib/db";

const entry = (exerciseId: string, lastAt: string, recentSessions: number, e1rmKg: number | null) => ({
  exerciseId,
  lastAt,
  recentSessions,
  e1rmKg,
});
const goalRow = (ex: string, name: string, target: number, pct: number | null) => ({
  goal_id: `g-${ex}`,
  exercise_id: ex,
  exercise_name: name,
  target_e1rm_kg: target,
  target_date: null,
  recent_best_e1rm_kg: pct === null ? null : (target * pct) / 100,
  alltime_best_e1rm_kg: null,
  pct_of_target: pct,
});

const INDEX = [
  entry("sq", "2026-09-30T10:00:00", 6, 140),
  entry("bp", "2026-09-30T10:30:00", 9, 100),
  entry("dl", "2026-09-20T10:00:00", 3, 180),
  entry("cu", "2026-09-30T11:00:00", 2, null),
];

const render_ = () => render(<History userId="11111111-1111-4111-8111-111111111111" />);

/** names in a section, in DOM order */
function names(section: HTMLElement): string[] {
  return [...section.querySelectorAll(".rec-name")].map((n) => n.textContent ?? "");
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  goalsNow.rows = [];
  getRecordIndex.mockResolvedValue({ data: INDEX, fromCache: false });
  // the server: writes change what the next getGoals() returns
  setGoal.mockImplementation(async (ex: string, kg: number) => {
    const rows = goalsNow.rows as ReturnType<typeof goalRow>[];
    const cur = rows.find((g) => g.exercise_id === ex);
    goalsNow.rows = cur
      ? rows.map((g) => (g.exercise_id === ex ? { ...g, target_e1rm_kg: kg } : g))
      : [...rows, goalRow(ex, ex, kg, null)];
  });
  removeGoal.mockImplementation(async (ex: string) => {
    goalsNow.rows = (goalsNow.rows as ReturnType<typeof goalRow>[]).filter(
      (g) => g.exercise_id !== ex,
    );
  });
});
afterEach(cleanup);

describe("Record list", () => {
  it("lists RECENT most recent day first, sessions in the window break the tie", async () => {
    render_();
    const recent = await screen.findByRole("region", { name: "Recent" });
    // Sep 30 ties for sq, bp, cu: bp (9) > sq (6) > cu (2); dl is older
    expect(names(recent)).toEqual(["Bench Press", "Back Squat", "Curl", "Deadlift"]);
    expect(within(recent).getByText("RECENT")).toBeTruthy();
  });

  it("shows pinned goals at the top with the target, percent and no repeat under RECENT", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    const pinned = await screen.findByRole("region", { name: "Pinned goals" });
    expect(names(pinned)).toEqual(["Back Squat"]);
    expect(within(pinned).getByText(/160 kg · 88%/)).toBeTruthy();
    expect(within(pinned).getByRole("button", { name: "Unpin Back Squat" }).textContent).toContain("◆ Pinned");
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(names(recent)).not.toContain("Back Squat");
  });

  it("has no PINNED GOALS section when nothing is pinned", async () => {
    render_();
    await screen.findByRole("region", { name: "Recent" });
    expect(screen.queryByRole("region", { name: "Pinned goals" })).toBeNull();
  });

  it("pins with a default target above the current e1RM and moves the row up", async () => {
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Pin Back Squat" }));
    // 140 * 1.05 = 147 -> next 2.5 kg step
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("sq", 147.5));
    const pinned = await screen.findByRole("region", { name: "Pinned goals" });
    expect(names(pinned)).toEqual(["Back Squat"]);
  });

  it("unpins by deleting the goal and returns the row to RECENT", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Unpin Back Squat" }));
    await waitFor(() => expect(removeGoal).toHaveBeenCalledWith("sq"));
    expect(screen.queryByRole("region", { name: "Pinned goals" })).toBeNull();
    expect(names(screen.getByRole("region", { name: "Recent" }))).toContain("Back Squat");
  });

  it("cannot pin an exercise with no e1RM yet", async () => {
    render_();
    const pin = (await screen.findByRole("button", { name: "Pin Curl" })) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);
    fireEvent.click(pin);
    expect(setGoal).not.toHaveBeenCalled();
  });

  it("search narrows both sections", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    await screen.findByRole("region", { name: "Recent" });
    fireEvent.change(screen.getByLabelText("Search your exercises"), { target: { value: "dead" } });
    expect(screen.queryByRole("region", { name: "Pinned goals" })).toBeNull();
    expect(names(screen.getByRole("region", { name: "Recent" }))).toEqual(["Deadlift"]);
  });

  it("detail: pinned shows -/+ that write the stepped target; unpinned offers Pin as goal", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    const pinned = await screen.findByRole("region", { name: "Pinned goals" });
    fireEvent.click(within(pinned).getAllByRole("button", { name: /Back Squat/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Raise goal" }));
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("sq", 162.5));
    fireEvent.click(screen.getByRole("button", { name: "Lower goal" }));
    await waitFor(() => expect(setGoal).toHaveBeenLastCalledWith("sq", 160));

    fireEvent.click(screen.getByRole("button", { name: "‹ Record" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bench Press/ }));
    expect(await screen.findByRole("button", { name: "Pin as goal" })).toBeTruthy();
  });

  it("shows the empty state when nothing has been logged", async () => {
    getRecordIndex.mockResolvedValue({ data: [], fromCache: false });
    render_();
    await screen.findByText("Your record starts with your first finished session.");
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
  });
});
