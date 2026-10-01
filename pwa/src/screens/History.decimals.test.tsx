// @vitest-environment jsdom
//
// Display sweep for the Record list and a lift's detail (e1RM, goal, volume,
// session log with set rows and bodyweight): in both units, with awkward
// stored kg (lb typed beside a 2-decimal total, 1.25 kg plate, legacy
// untyped), no number carries more than one decimal unless it is typed.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../hooks/useLocalToday", () => ({ useLocalToday: () => "2026-10-01" }));
const unitNow = vi.hoisted(() => ({ unit: "kg" as "kg" | "lb" }));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => unitNow.unit }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));
const liveUser = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("../lib/currentUser", () => ({
  getCurrentUserId: () => liveUser.id,
  onUserChange: () => () => undefined,
}));
vi.mock("../lib/sync", () => ({
  outbox: {
    pendingDiscardIds: vi.fn().mockResolvedValue(new Set()),
    pendingVoidIds: vi.fn().mockResolvedValue(new Set()),
    flush: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue([]),
  },
}));
import { outbox as outboxMock } from "../lib/sync";
vi.mock("../components/BodyweightRow", () => ({ BodyweightRow: () => null }));
vi.mock("../components/CheckinWeek", () => ({ CheckinWeek: () => null }));

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



const TYPED_ALLOWED = new Set(["21.25", "225.25"]);
function scan(label: string): string[] {
  const bad: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? "");
  document.body.querySelectorAll("[aria-label]").forEach((el) => texts.push(el.getAttribute("aria-label") ?? ""));
  for (const t of texts) {
    const cleaned = t.replace(/\d{4}-\d{2}-\d{2}[T\d:.\-+Z]*/g, " ");
    for (const m of cleaned.matchAll(/\d+\.\d{2,}/g)) if (!TYPED_ALLOWED.has(m[0])) bad.push(`${label}: ${m[0]} in "${t}"`);
    for (const m of cleaned.matchAll(/\b\d+\.0\b(?!\d)/g)) bad.push(`${label}: ${m[0]} (trailing .0) in "${t}"`);
  }
  return bad;
}

const UGLY = [
  entry("sq", "2026-09-30T10:00:00", 6, 138.46),
  entry("bp", "2026-09-30T10:30:00", 9, 102.06),
  entry("dl", "2026-09-20T10:00:00", 3, 183.7),
  entry("cu", "2026-09-30T11:00:00", 2, 44.09),
];

describe("Record decimals sweep", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
    vi.clearAllMocks();
    liveUser.id = "11111111-1111-4111-8111-111111111111";
    vi.mocked(outboxMock.inspect).mockResolvedValue([]);
    vi.mocked(outboxMock.pendingDiscardIds).mockResolvedValue(new Set());
    vi.mocked(outboxMock.pendingVoidIds).mockResolvedValue(new Set());
    getRecordIndex.mockResolvedValue(idx(UGLY));
    getGoals.mockResolvedValue({
      data: [goalRow("bp", "Bench Press", 124.74, 82.2)],
      fromCache: false,
      stale: null,
    });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
  afterEach(() => cleanup());

  for (const unit of ["kg", "lb"] as const) {
    it(`list and detail in ${unit}`, async () => {
      unitNow.unit = unit;
      const data = await import("../lib/data");
      const set = (id: string, kg: number, extra: Record<string, unknown> = {}) => ({
        id, session_id: "s1", exercise_id: "bp", set_index: 0, set_type: "working",
        load_kg: kg, reps: 5, performed_at: "2026-09-30T10:30:00.000Z", rest_seconds_actual: null,
        prescription_id: null, ...extra,
      });
      vi.mocked(data.getE1rmSeries).mockResolvedValue({
        data: [
          { exercise_id: "bp", session_id: "s0", performed_at: "2026-09-10T10:00:00.000Z", best_e1rm_kg: 99.4 },
          { exercise_id: "bp", session_id: "s1", performed_at: "2026-09-30T10:00:00.000Z", best_e1rm_kg: 102.06 },
        ],
        fromCache: false, stale: null,
      } as never);
      vi.mocked(data.getWeeklyVolume).mockResolvedValue({
        data: [{ exercise_id: "bp", week_start: "2026-09-21", working_sets: 6, tonnage_kg: 3061.37 }],
        fromCache: false, stale: null,
      } as never);
      vi.mocked(data.getRecentSets).mockResolvedValue({
        data: [
          set("a", 102.06, { entered_load: 225, entered_unit: "lb", load_entry: "total" }),
          set("b", 21.25, { entered_load: 21.25, entered_unit: "kg", load_entry: "total", set_index: 1 }),
          set("c", 102.06, { set_index: 2 }),
          set("d", 99.79, { entered_load: 49.9, entered_unit: "kg", load_entry: "per_side", set_index: 3 }),
        ],
        fromCache: false, stale: null,
      } as never);
      vi.mocked(data.getSessionMeta).mockResolvedValue({
        data: { s1: { id: "s1", session_rpe: 7, notes: null, bodyweight_kg: 81.87 } },
        fromCache: false,
      } as never);
      render(<History userId="11111111-1111-4111-8111-111111111111" />);
      await screen.findByText("Bench Press", { selector: ".rec-name" });
      const bad = scan(`record list/${unit}`);
      fireEvent.click((await screen.findAllByText("Bench Press", { selector: ".rec-name" }))[0]);
      await waitFor(() => expect(document.body.textContent).toMatch(/LAST WEEK|BW /));
      await new Promise((r) => setTimeout(r, 50));
      bad.push(...scan(`record detail/${unit}`));
      expect(bad).toEqual([]);
      expect(document.body.textContent).toMatch(unit === "lb" ? /225 lb/ : /21\.25 kg/);
    });
  }
});
