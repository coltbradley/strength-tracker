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
import { outbox as outboxMock } from "../lib/sync";
import { reportError as reportErrorMock } from "../lib/errors";
vi.mock("../components/BodyweightRow", () => ({ BodyweightRow: () => null }));
vi.mock("../components/CheckinWeek", () => ({ CheckinWeek: () => null }));

const goalsNow = vi.hoisted(() => ({ rows: [] as unknown[] }));
const setGoal = vi.fn();
const removeGoal = vi.fn();
const getRecordIndex = vi.fn();
const getGoals = vi.fn();
const restoreGoal = vi.fn();
const idx = (data: unknown[], extra: Record<string, unknown> = {}) => ({
  data: { entries: data, truncated: false },
  fromCache: false,
  stale: null,
  ...extra,
});

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
    getGoals: () => getGoals(),
    restoreGoal: (...a: unknown[]) => restoreGoal(...a),
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
    worstStale: actual.worstStale,
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
  vi.mocked(outboxMock.inspect).mockResolvedValue([]);
  setGoal.mockReset();
  removeGoal.mockReset();
  restoreGoal.mockReset();
  goalsNow.rows = [];
  getRecordIndex.mockResolvedValue(idx(INDEX));
  getGoals.mockImplementation(() => Promise.resolve({ data: goalsNow.rows, fromCache: false, stale: null }));
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
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
    expect(within(pinned).getByRole("button", { name: "Pinned goal: Back Squat" }).textContent).toContain("◆ Pinned");
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
    fireEvent.click(await screen.findByRole("button", { name: "Pinned goal: Back Squat" }));
    // 140 * 1.05 = 147 -> next 2.5 kg step
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("sq", 147.5));
    const pinned = await screen.findByRole("region", { name: "Pinned goals" });
    expect(names(pinned)).toEqual(["Back Squat"]);
  });

  it("unpins by deleting the goal and returns the row to RECENT", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Pinned goal: Back Squat" }));
    await waitFor(() => expect(removeGoal).toHaveBeenCalledWith("sq"));
    expect(screen.queryByRole("region", { name: "Pinned goals" })).toBeNull();
    expect(names(screen.getByRole("region", { name: "Recent" }))).toContain("Back Squat");
  });

  it("cannot pin an exercise with no e1RM yet", async () => {
    render_();
    const pin = (await screen.findByRole("button", { name: "Pinned goal: Curl" })) as HTMLButtonElement;
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
    fireEvent.click(await screen.findByRole("button", { name: /^Raise goal by 2.5 kg/ }));
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("sq", 162.5));
    fireEvent.click(screen.getByRole("button", { name: /^Lower goal by 2.5 kg/ }));
    await waitFor(() => expect(setGoal).toHaveBeenLastCalledWith("sq", 160));

    fireEvent.click(screen.getByRole("button", { name: "‹ Record" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bench Press/ }));
    expect(await screen.findByRole("button", { name: "Pin as goal" })).toBeTruthy();
  });

  it("pin buttons are stable-labelled toggles", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    const on = await screen.findByRole("button", { name: "Pinned goal: Back Squat" });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    const off = screen.getByRole("button", { name: "Pinned goal: Deadlift" });
    expect(off.getAttribute("aria-pressed")).toBe("false");
  });

  it("meta reads in plain words, not 'N IN 90D'", async () => {
    render_();
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(recent.textContent).toMatch(/9 sessions in 90 days/);
    expect(recent.textContent).not.toMatch(/IN 90D/);
  });

  it("R1: a failed pin is reverted to the snapshot even when the re-read also fails", async () => {
    setGoal.mockRejectedValueOnce(new Error("Failed to fetch"));
    getGoals.mockRejectedValue(new Error("Failed to fetch"));
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Pinned goal: Back Squat" }));
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned goals" })).toBeNull());
    expect(screen.getByRole("button", { name: "Pinned goal: Back Squat" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("R1/R6: a failed step reverts to the previous target and skips writes queued behind it", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 80)];
    render_();
    fireEvent.click(within(await screen.findByRole("region", { name: "Pinned goals" })).getAllByRole("button", { name: /Back Squat/ })[0]);
    setGoal.mockRejectedValueOnce(new Error("Failed to fetch"));
    const raise = await screen.findByRole("button", { name: /^Raise goal/ });
    fireEvent.click(raise);
    fireEvent.click(raise);
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("160 kg")).toBeTruthy());
    expect(setGoal).toHaveBeenCalledTimes(1);
  });

  it("R3: a step recomputes the percentage against the new target at once", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 80)]; // recent best 128
    let release!: () => void;
    setGoal.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    render_();
    fireEvent.click(within(await screen.findByRole("region", { name: "Pinned goals" })).getAllByRole("button", { name: /Back Squat/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: /^Raise goal/ }));
    // 128 / 162.5 = 78.8%
    expect(await screen.findByText("78.8% OF GOAL")).toBeTruthy();
    release();
  });

  it("R2: unpinning a goal with a target date asks first, then offers Undo that restores the exact row", async () => {
    const coach = { ...goalRow("sq", "Back Squat", 160, 87.5), target_date: "2026-12-01" };
    goalsNow.rows = [coach];
    render_();
    const btn = await screen.findByRole("button", { name: "Pinned goal: Back Squat" });
    fireEvent.click(btn);
    expect(removeGoal).not.toHaveBeenCalled();
    expect(screen.getByText(/may be your coach’s goal/)).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(removeGoal).toHaveBeenCalledWith("sq"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restoreGoal).toHaveBeenCalledWith(expect.objectContaining({ exercise_id: "sq", target_e1rm_kg: 160, target_date: "2026-12-01", goal_id: "g-sq" })));
  });

  it("a plain pinned goal unpins in one tap and still offers Undo", async () => {
    goalsNow.rows = [goalRow("sq", "Back Squat", 160, 87.5)];
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Pinned goal: Back Squat" }));
    await waitFor(() => expect(removeGoal).toHaveBeenCalledWith("sq"));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("offline: pin and step controls are disabled with a connection note", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render_();
    expect(await screen.findByText(/Needs a connection/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pinned goal: Back Squat" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("R4: a failed index read with no cache is an error, not 'Nothing matches'", async () => {
    getRecordIndex.mockRejectedValue(new Error("down"));
    render_();
    expect(await screen.findByText(/Couldn’t load your record/)).toBeTruthy();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("R5: shows the stale note and marks unsent sets as on phone", async () => {
    getRecordIndex.mockResolvedValue(idx(INDEX, { stale: "offline", fromCache: true }));
    vi.mocked(outboxMock.inspect).mockResolvedValue([
      {
        key: 1,
        table: "sets",
        state: "waiting",
        op: {
          kind: "insert",
          table: "sets",
          payload: { id: "u1", exercise_id: "dl", session_id: "s9", performed_at: "2026-10-01T09:00:00" },
        },
      },
    ] as never);
    render_();
    expect(await screen.findByText(/offline — showing cached data/)).toBeTruthy();
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(recent.textContent).toMatch(/on phone, not sent yet/);
    // the unsent set made Deadlift the most recent day
    expect(names(recent)[0]).toBe("Deadlift");
  });

  it("R4/R9: 'Nothing matches' only for a real search; words match in any order", async () => {
    render_();
    await screen.findByRole("region", { name: "Recent" });
    fireEvent.change(screen.getByLabelText("Search your exercises"), { target: { value: "press bench" } });
    expect(names(screen.getByRole("region", { name: "Recent" }))).toEqual(["Bench Press"]);
    fireEvent.change(screen.getByLabelText("Search your exercises"), { target: { value: "zzz" } });
    expect(screen.getByText(/Nothing matches “zzz”/)).toBeTruthy();
  });

  it("R7: says so when the scan hit its cap", async () => {
    getRecordIndex.mockResolvedValue({ data: { entries: INDEX, truncated: true }, fromCache: false, stale: null });
    render_();
    expect(await screen.findByText(/older ones may be missing/)).toBeTruthy();
  });

  it("shows the empty state when nothing has been logged", async () => {
    getRecordIndex.mockResolvedValue(idx([]));
    render_();
    await screen.findByText("Your record starts with your first finished session.");
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
  });
});
