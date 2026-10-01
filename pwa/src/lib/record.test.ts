import { describe, expect, it } from "vitest";
import {
  applyPendingToIndex,
  optimisticPct,
  buildRecordIndex,
  buildRecordLists,
  defaultGoalKg,
  stepGoalKg,
  type RecordIndexEntry,
} from "./record";
import type { GoalProgressRow } from "./types";

const NOW = new Date("2026-10-01T12:00:00");
const at = (day: string, h = 10) => `${day}T${String(h).padStart(2, "0")}:00:00`;

function goal(ex: string, target: number, pct: number | null): GoalProgressRow {
  return {
    goal_id: `g-${ex}`,
    exercise_id: ex,
    exercise_name: ex,
    target_e1rm_kg: target,
    target_date: null,
    recent_best_e1rm_kg: pct === null ? null : (target * pct) / 100,
    alltime_best_e1rm_kg: null,
    pct_of_target: pct,
  };
}

const entry = (
  exerciseId: string,
  lastAt: string,
  recentSessions: number,
  e1rmKg: number | null = 100,
): RecordIndexEntry => ({ exerciseId, lastAt, recentSessions, e1rmKg });

const names = (id: string) => id.toUpperCase();

describe("buildRecordIndex", () => {
  it("takes the newest date, counts distinct sessions in 90 days, newest e1RM", () => {
    const out = buildRecordIndex(
      [
        { exercise_id: "sq", session_id: "s3", performed_at: at("2026-09-28") },
        { exercise_id: "sq", session_id: "s3", performed_at: at("2026-09-28", 11) },
        { exercise_id: "sq", session_id: "s2", performed_at: at("2026-09-20") },
        // outside the window: not counted, still the same exercise
        { exercise_id: "sq", session_id: "s1", performed_at: at("2026-03-01") },
        { exercise_id: "dl", session_id: "s2", performed_at: at("2026-09-20") },
      ],
      [
        { exercise_id: "sq", session_id: "s2", performed_at: at("2026-09-20"), best_e1rm_kg: 120 },
        { exercise_id: "sq", session_id: "s3", performed_at: at("2026-09-28"), best_e1rm_kg: 125 },
      ],
      NOW,
    );
    const sq = out.find((e) => e.exerciseId === "sq")!;
    expect(sq).toMatchObject({ lastAt: at("2026-09-28", 11), recentSessions: 2, e1rmKg: 125 });
    expect(out.find((e) => e.exerciseId === "dl")!.e1rmKg).toBeNull();
  });
});

describe("buildRecordLists ordering", () => {
  it("puts the most recently performed day first", () => {
    const { recent } = buildRecordLists(
      [entry("a", at("2026-09-01"), 9), entry("b", at("2026-09-30"), 1), entry("c", at("2026-09-15"), 5)],
      [],
      names,
      "",
    );
    expect(recent.map((r) => r.exerciseId)).toEqual(["b", "c", "a"]);
  });

  it("breaks a same-day tie by sessions in the window, then by name", () => {
    const { recent } = buildRecordLists(
      [
        entry("zed", at("2026-09-30", 9), 2),
        entry("often", at("2026-09-30", 18), 8),
        entry("alpha", at("2026-09-30", 7), 2),
        entry("older", at("2026-09-29"), 50),
      ],
      [],
      names,
      "",
    );
    expect(recent.map((r) => r.exerciseId)).toEqual(["often", "alpha", "zed", "older"]);
  });
});

describe("buildRecordLists pinning", () => {
  const index = [entry("sq", at("2026-09-30"), 6), entry("bp", at("2026-09-29"), 4)];

  it("an exercise with a goal is pinned and not repeated under recent", () => {
    const { pinned, recent } = buildRecordLists(index, [goal("sq", 160, 80)], names, "");
    expect(pinned.map((r) => r.exerciseId)).toEqual(["sq"]);
    expect(recent.map((r) => r.exerciseId)).toEqual(["bp"]);
  });

  it("pinned goals use the same recency order", () => {
    const { pinned } = buildRecordLists(index, [goal("bp", 110, 50), goal("sq", 160, 80)], names, "");
    expect(pinned.map((r) => r.exerciseId)).toEqual(["sq", "bp"]);
  });

  it("keeps a goal whose exercise has no sets, after performed ones", () => {
    const { pinned } = buildRecordLists(index, [goal("ohp", 80, null), goal("bp", 110, 50)], names, "");
    expect(pinned.map((r) => r.exerciseId)).toEqual(["bp", "ohp"]);
  });

  it("search filters both sections by name", () => {
    const { pinned, recent } = buildRecordLists(index, [goal("sq", 160, 80)], names, "b");
    expect(pinned).toEqual([]);
    expect(recent.map((r) => r.exerciseId)).toEqual(["bp"]);
  });
});

describe("goal targets", () => {
  it("steps 2.5 kg and 5 lb in the display unit and never below one step", () => {
    expect(stepGoalKg(100, 1, "kg")).toBe(102.5);
    expect(stepGoalKg(100, -1, "kg")).toBe(97.5);
    expect(stepGoalKg(2.5, -1, "kg")).toBe(2.5);
    expect(Math.round(stepGoalKg(100, 1, "lb") * 1000) / 1000).toBeCloseTo(102.27, 1);
  });

  it("defaults strictly above the current e1RM, on a step", () => {
    expect(defaultGoalKg(100, "kg")).toBe(105);
    expect(defaultGoalKg(101, "kg")).toBe(107.5);
    expect(defaultGoalKg(2, "kg")).toBe(4.5);
  });
});

describe("applyPendingToIndex (R5): unsent writes over the server index", () => {
  const server = () =>
    buildRecordIndex(
      [
        { id: "a1", exercise_id: "sq", session_id: "s2", performed_at: at("2026-09-28") },
        { id: "a2", exercise_id: "sq", session_id: "s1", performed_at: at("2026-09-20") },
        { id: "b1", exercise_id: "cu", session_id: "s2", performed_at: at("2026-09-28") },
      ],
      [
        { exercise_id: "sq", session_id: "s2", performed_at: at("2026-09-28"), best_e1rm_kg: 125 },
        { exercise_id: "sq", session_id: "s1", performed_at: at("2026-09-20"), best_e1rm_kg: 120 },
      ],
      NOW,
    );
  const none = { voidedIds: new Set<string>(), discardedSessions: new Set<string>(), sets: [] };

  it("an unsent set moves its exercise up and marks it on phone, e1RM unchanged", () => {
    const out = applyPendingToIndex(
      server(),
      {
        ...none,
        sets: [{ id: "n1", exercise_id: "sq", session_id: "s9", performed_at: at("2026-10-01") }],
      },
      NOW,
    );
    const sq = out.find((e) => e.exerciseId === "sq")!;
    expect(sq).toMatchObject({ lastAt: at("2026-10-01"), recentSessions: 3, e1rmKg: 125, onPhone: true });
  });

  it("an exercise first done on this phone appears, with no e1RM", () => {
    const out = applyPendingToIndex(
      server(),
      { ...none, sets: [{ id: "n1", exercise_id: "new", session_id: "s9", performed_at: at("2026-10-01") }] },
      NOW,
    );
    expect(out.find((e) => e.exerciseId === "new")).toMatchObject({ e1rmKg: null, onPhone: true });
  });

  it("a pending void of an exercise's only set removes it; of a newer set, the date falls back", () => {
    let out = applyPendingToIndex(server(), { ...none, voidedIds: new Set(["b1"]) }, NOW);
    expect(out.find((e) => e.exerciseId === "cu")).toBeUndefined();
    out = applyPendingToIndex(server(), { ...none, voidedIds: new Set(["a1"]) }, NOW);
    expect(out.find((e) => e.exerciseId === "sq")).toMatchObject({ lastAt: at("2026-09-20"), recentSessions: 1 });
  });

  it("a pending discard drops the session and falls back to the older e1RM from the view", () => {
    const out = applyPendingToIndex(server(), { ...none, discardedSessions: new Set(["s2"]) }, NOW);
    expect(out.find((e) => e.exerciseId === "cu")).toBeUndefined();
    expect(out.find((e) => e.exerciseId === "sq")).toMatchObject({ lastAt: at("2026-09-20"), e1rmKg: 120 });
  });

  it("an unsent set that is itself voided does nothing", () => {
    const out = applyPendingToIndex(
      server(),
      {
        ...none,
        voidedIds: new Set(["n1"]),
        sets: [{ id: "n1", exercise_id: "sq", session_id: "s9", performed_at: at("2026-10-01") }],
      },
      NOW,
    );
    expect(out.find((e) => e.exerciseId === "sq")!.onPhone).toBe(false);
  });
});

describe("optimisticPct (R3)", () => {
  it("is the view's ratio against the new target, one decimal", () => {
    expect(optimisticPct(90, 100)).toBe(90);
    expect(optimisticPct(90, 120)).toBe(75);
    expect(optimisticPct(null, 120)).toBeNull();
  });
});

describe("search (R9)", () => {
  const idx = [entry("bp", at("2026-09-30"), 1, 100), entry("cu", at("2026-09-30"), 1, 50)];
  const nm = (id: string) => (id === "bp" ? "Bench Press (Barbell)" : "Curl");
  it("matches every word in any order, ignoring case and punctuation", () => {
    expect(buildRecordLists(idx, [], nm, "press bench").recent.map((r) => r.exerciseId)).toEqual(["bp"]);
    expect(buildRecordLists(idx, [], nm, "barbell, PRESS").recent).toHaveLength(1);
    expect(buildRecordLists(idx, [], nm, "squat").recent).toHaveLength(0);
  });
});
