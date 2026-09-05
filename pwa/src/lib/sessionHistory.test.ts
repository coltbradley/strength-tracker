// The three things the day-shaped half of History can get wrong, and the one
// thing the weekly line must never say.
//
// A discarded session and a voided set are both hidden by SQL, but only once
// the write has landed: offline the outbox holds them for hours, and the
// cached list this screen falls back to was written before either existed. So
// the client half of that subtraction is real logic, not belt-and-braces, and
// it is what these tests pin.

import { describe, expect, it } from "vitest";
import {
  describeWeek,
  groupSetsByExercise,
  liveFinishedSessions,
  liveSets,
  sessionSeconds,
  weekStartIso,
  type RawSessionRow,
  type WeeklySummaryRow,
} from "./sessionHistory";
import type { SetInsert } from "./types";

const session = (over: Partial<RawSessionRow>): RawSessionRow => ({
  id: "s1",
  started_at: "2026-09-01T17:00:00.000Z",
  ended_at: "2026-09-01T18:12:00.000Z",
  discarded_at: null,
  session_rpe: 7,
  planned_workout_id: "d1",
  ...over,
});

const set = (over: Partial<SetInsert>): SetInsert => ({
  id: "x1",
  session_id: "s1",
  exercise_id: "squat",
  prescription_id: null,
  set_index: 0,
  set_type: "working",
  load_kg: 100,
  reps: 5,
  performed_at: "2026-09-01T17:05:00.000Z",
  rest_seconds_actual: null,
  ...over,
});

const week = (over: Partial<WeeklySummaryRow>): WeeklySummaryRow => ({
  week_start: "2026-08-31",
  sessions: 0,
  working_sets: 0,
  tonnage_kg: 0,
  avg_session_rpe: null,
  planned_days: 0,
  planned_days_done: 0,
  ...over,
});

describe("liveFinishedSessions", () => {
  it("drops a discarded session", () => {
    const out = liveFinishedSessions(
      [
        session({ id: "keep" }),
        session({ id: "gone", discarded_at: "2026-09-02T09:00:00.000Z" }),
      ],
      new Set(),
    );
    expect(out.map((s) => s.id)).toEqual(["keep"]);
  });

  it("drops a session discarded on THIS device but not yet flushed", () => {
    // the cached list offline predates the discard, so the server-side
    // `.is('discarded_at', null)` has never seen it
    const out = liveFinishedSessions(
      [session({ id: "keep" }), session({ id: "queued" })],
      new Set(["queued"]),
    );
    expect(out.map((s) => s.id)).toEqual(["keep"]);
  });

  it("drops an OPEN session entirely rather than badging it", () => {
    // Not a completed workout: the same rule that stops an open session
    // marking its planned day done. Showing it would also put a row in the
    // list that the weekly line beside it does not count.
    const out = liveFinishedSessions(
      [session({ id: "open", ended_at: null }), session({ id: "done" })],
      new Set(),
    );
    expect(out.map((s) => s.id)).toEqual(["done"]);
  });

  it("narrows ended_at to a string, so nothing downstream re-checks it", () => {
    const [only] = liveFinishedSessions([session({})], new Set());
    expect(typeof only!.ended_at).toBe("string");
  });
});

describe("liveSets", () => {
  it("drops a set voided on this device but not yet flushed", () => {
    const out = liveSets(
      [set({ id: "a" }), set({ id: "b" }), set({ id: "c" })],
      new Set(["b"]),
    );
    expect(out.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("leaves everything alone when nothing is queued", () => {
    const rows = [set({ id: "a" }), set({ id: "b" })];
    expect(liveSets(rows, new Set())).toHaveLength(2);
  });
});

describe("groupSetsByExercise", () => {
  it("groups a straight run of one movement", () => {
    const runs = groupSetsByExercise([
      set({ id: "1", exercise_id: "squat" }),
      set({ id: "2", exercise_id: "squat" }),
      set({ id: "3", exercise_id: "bench" }),
    ]);
    expect(runs.map((r) => [r.exerciseId, r.sets.length])).toEqual([
      ["squat", 2],
      ["bench", 1],
    ]);
  });

  it("keeps an alternating superset alternating", () => {
    // collecting these into "all the rows, then all the presses" would render
    // an order that never happened
    const runs = groupSetsByExercise([
      set({ id: "1", exercise_id: "row" }),
      set({ id: "2", exercise_id: "press" }),
      set({ id: "3", exercise_id: "row" }),
      set({ id: "4", exercise_id: "press" }),
    ]);
    expect(runs.map((r) => r.exerciseId)).toEqual([
      "row",
      "press",
      "row",
      "press",
    ]);
  });

  it("has nothing to say about no sets", () => {
    expect(groupSetsByExercise([])).toEqual([]);
  });
});

describe("sessionSeconds", () => {
  it("measures start to end", () => {
    expect(
      sessionSeconds({
        started_at: "2026-09-01T17:00:00.000Z",
        ended_at: "2026-09-01T18:12:00.000Z",
      }),
    ).toBe(72 * 60);
  });

  it("suppresses rather than guesses when the arithmetic is nonsense", () => {
    expect(
      sessionSeconds({ started_at: "not a date", ended_at: "2026-09-01" }),
    ).toBeNull();
    // a clock change can put the end before the start; a negative duration is
    // not a shorter workout
    expect(
      sessionSeconds({
        started_at: "2026-09-01T18:00:00.000Z",
        ended_at: "2026-09-01T17:00:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("weekStartIso", () => {
  it("is always the Monday, because date_trunc('week') is ISO", () => {
    expect(weekStartIso("2026-09-02")).toBe("2026-08-31"); // Wednesday
    expect(weekStartIso("2026-08-31")).toBe("2026-08-31"); // Monday itself
    expect(weekStartIso("2026-09-06")).toBe("2026-08-31"); // Sunday
    expect(weekStartIso("2026-09-07")).toBe("2026-09-07"); // next Monday
  });

  it("crosses a month and a year boundary", () => {
    expect(weekStartIso("2026-03-01")).toBe("2026-02-23");
    expect(weekStartIso("2027-01-01")).toBe("2026-12-28");
  });
});

describe("describeWeek", () => {
  it("counts sessions, working sets and tonnage", () => {
    const line = describeWeek(
      week({ sessions: 3, working_sets: 42, tonnage_kg: 12400 }),
      "kg",
    );
    expect(line.effort).toBe("3 SESSIONS · 42 WORKING SETS · 12,400 KG");
    expect(line.idle).toBe(false);
  });

  it("says SESSION and WORKING SET once each when there is one of each", () => {
    const line = describeWeek(
      week({ sessions: 1, working_sets: 1, tonnage_kg: 100 }),
      "kg",
    );
    expect(line.effort).toBe("1 SESSION · 1 WORKING SET · 100 KG");
  });

  it("converts tonnage for lb without touching the stored kg", () => {
    const line = describeWeek(
      week({ sessions: 1, working_sets: 1, tonnage_kg: 1000 }),
      "lb",
    );
    expect(line.effort).toContain("2,205 LB");
  });

  it("omits tonnage when nothing carried load", () => {
    // a week of mobility and bodyweight work genuinely moved no weight;
    // "0 KG" reads as a failure to load the bar
    const line = describeWeek(week({ sessions: 2, working_sets: 9 }), "kg");
    expect(line.effort).toBe("2 SESSIONS · 9 WORKING SETS");
  });

  it("a week with a plan and no training states both, as counts", () => {
    const line = describeWeek(
      week({ planned_days: 4, planned_days_done: 0 }),
      "kg",
    );
    expect(line.effort).toBe("Nothing logged yet.");
    expect(line.plan).toBe("4 PLANNED · 0 DONE");
    // there IS something here to render; it is not an untouched week
    expect(line.idle).toBe(false);
  });

  it("a week with training and no plan says nothing about adherence", () => {
    // the view reports two counts rather than a percentage precisely so this
    // case can stay silent: 0% would read as total failure where the truth is
    // that nothing was asked for
    const line = describeWeek(
      week({ sessions: 2, working_sets: 30, tonnage_kg: 8000 }),
      "kg",
    );
    expect(line.plan).toBeNull();
    expect(line.effort).toBe("2 SESSIONS · 30 WORKING SETS · 8,000 KG");
  });

  it("never renders a ratio, however tempting the numbers", () => {
    const line = describeWeek(
      week({
        sessions: 3,
        working_sets: 20,
        planned_days: 4,
        planned_days_done: 3,
      }),
      "kg",
    );
    expect(line.plan).toBe("4 PLANNED · 3 DONE");
    expect(line.plan).not.toMatch(/%/);
  });

  it("no row at all is an idle week, not a zeroed one", () => {
    const line = describeWeek(null, "kg");
    expect(line.idle).toBe(true);
    expect(line.plan).toBeNull();
  });
});
