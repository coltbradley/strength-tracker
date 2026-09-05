// The week strip swipes now, so week arithmetic has become load-bearing on a
// screen where it used to be a single derived list. The two places it can be
// silently wrong are month ends and year ends — a +7 that stays in the wrong
// month, or a range label that renders "29–4 DEC" across New Year.

import { describe, expect, it } from "vitest";
import {
  canDoWorkoutNow,
  weekPageDate,
  weekPages,
  weekRangeLabel,
  workoutStates,
} from "./Today";
import type { PlannedWorkoutRow } from "../lib/types";

describe("weekPageDate", () => {
  it("is the identity for the page already selected", () => {
    expect(weekPageDate("2026-08-30", 1)).toBe("2026-08-30");
  });

  it("steps a whole week either way", () => {
    expect(weekPageDate("2026-08-19", 0)).toBe("2026-08-12");
    expect(weekPageDate("2026-08-19", 2)).toBe("2026-08-26");
  });

  it("crosses a month end", () => {
    expect(weekPageDate("2026-09-02", 0)).toBe("2026-08-26");
    expect(weekPageDate("2026-08-26", 2)).toBe("2026-09-02");
  });

  it("crosses a year end", () => {
    expect(weekPageDate("2027-01-02", 0)).toBe("2026-12-26");
    expect(weekPageDate("2026-12-28", 2)).toBe("2027-01-04");
  });

  it("crosses a leap day", () => {
    expect(weekPageDate("2028-03-01", 0)).toBe("2028-02-23");
    expect(weekPageDate("2028-02-23", 2)).toBe("2028-03-01");
  });
});

describe("weekPages", () => {
  it("renders last week, the selected week and next week", () => {
    const [prev, current, next] = weekPages("2026-08-30", 1);
    expect(current[0]).toBe("2026-08-24");
    expect(current[6]).toBe("2026-08-30");
    expect(prev[0]).toBe("2026-08-17");
    expect(next[6]).toBe("2026-09-06");
  });

  it("honours the configured week start", () => {
    // 2026-08-30 is itself a Sunday: on a Sunday start it OPENS the week it
    // closes on a Monday start.
    expect(weekPages("2026-08-30", 0)[1][0]).toBe("2026-08-30");
    expect(weekPages("2026-08-30", 6)[1][0]).toBe("2026-08-29");
  });

  it("spans the year end without losing a day", () => {
    const [, current] = weekPages("2026-01-01", 1);
    expect(current).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });
});

describe("weekRangeLabel", () => {
  it("names one month once", () => {
    expect(weekRangeLabel(weekPages("2026-08-30", 1)[1])).toBe("24–30 AUG");
  });

  it("names both months across a month end", () => {
    expect(weekRangeLabel(weekPages("2026-09-02", 1)[1])).toBe(
      "31 AUG – 6 SEPT",
    );
  });

  it("names both months across a year end", () => {
    expect(weekRangeLabel(weekPages("2026-01-01", 1)[1])).toBe(
      "29 DEC – 4 JAN",
    );
  });
});

describe("workoutStates", () => {
  const day = (o: Partial<PlannedWorkoutRow> = {}): PlannedWorkoutRow => ({
    id: o.id ?? "w1",
    program_id: "p1",
    day_index: 0,
    label: "PUSH",
    notes: null,
    scheduled_date: "2026-08-30",
    plan_note: null,
    skipped_at: null,
    exercise_count: 5,
    ...o,
  });
  const TODAY = "2026-09-04";
  const states = (ws: PlannedWorkoutRow[], done = new Set<string>()) =>
    workoutStates(ws, done, true, TODAY);

  it("a past day with exercises is missed", () => {
    expect(states([day()]).get("w1")).toBe("MISSED");
  });

  // The bug: "Plan a workout" creates the day before its contents, so an
  // abandoned one turned into a MISSED workout the day after — a session
  // someone failed to do, that was never programmed. A real user has one of
  // these sitting next to three sessions she actually trained.
  it("a past day with NOTHING in it is a draft, not missed", () => {
    expect(states([day({ exercise_count: 0 })]).get("w1")).toBe("DRAFT");
  });

  it("an empty day is a draft on its own date too, not TODAY", () => {
    const w = day({ exercise_count: 0, scheduled_date: TODAY });
    expect(states([w]).get("w1")).toBe("DRAFT");
  });

  it("an empty FUTURE day is a draft rather than something to come", () => {
    const w = day({ exercise_count: 0, scheduled_date: "2026-12-01" });
    expect(states([w]).get("w1")).toBe("DRAFT");
  });

  it("what actually happened still outranks emptiness", () => {
    // A session logged against a day nobody programmed is still a session.
    const w = day({ exercise_count: 0 });
    expect(states([w], new Set(["w1"])).get("w1")).toBe("DONE");
    const skipped = day({
      exercise_count: 0,
      skipped_at: "2026-08-30T07:30:00Z",
    });
    expect(states([skipped]).get("w1")).toBe("SKIPPED");
  });

  it("a full day keeps every other state it had", () => {
    expect(states([day({ scheduled_date: TODAY })]).get("w1")).toBe("TODAY");
    expect(states([day({ scheduled_date: "2026-12-01" })]).get("w1")).toBe(
      "UPCOMING",
    );
    expect(states([day({ scheduled_date: null })]).get("w1")).toBe("NO DATE");
  });

  it("with no dates anywhere, the first full day is today's", () => {
    const a = day({ id: "a", scheduled_date: null });
    const b = day({ id: "b", scheduled_date: null });
    const m = workoutStates([a, b], new Set(), false, TODAY);
    expect([m.get("a"), m.get("b")]).toEqual(["TODAY", "UPCOMING"]);
  });
});

// A session used to be welded to today's planned day, so training Wednesday's
// work on Tuesday cost you either the coach's date or the targets. The state
// map is what decides which days can be trained off their own date, and every
// case that must NOT offer it is a different kind of damage, so pin them all.
describe("canDoWorkoutNow", () => {
  it("offers a day scheduled later this week", () => {
    expect(canDoWorkoutNow("UPCOMING")).toBe(true);
  });

  it("offers a day whose date has already gone by", () => {
    // The lifter is behind, not absent — the plan is still what the coach wrote.
    expect(canDoWorkoutNow("MISSED")).toBe(true);
  });

  it("does not double up on today's own card", () => {
    // TODAY already carries the primary "Start session".
    expect(canDoWorkoutNow("TODAY")).toBe(false);
  });

  it("never re-runs a day from its own card", () => {
    // "Start again" is today's card only; appending a second session to a
    // finished day from another week is not something anyone asked for.
    expect(canDoWorkoutNow("DONE")).toBe(false);
    expect(canDoWorkoutNow("SKIPPED")).toBe(false);
  });

  it("does not start a day with nothing programmed into it", () => {
    // Starting a DRAFT produces exactly the targetless, adherence-free empty
    // session this action exists to avoid.
    expect(canDoWorkoutNow("DRAFT")).toBe(false);
  });

  it("leaves an undated day to be rescheduled instead", () => {
    // "Ahead or behind" needs a schedule to be ahead of or behind.
    expect(canDoWorkoutNow("NO DATE")).toBe(false);
  });
});
