import { describe, expect, it } from "vitest";
import type { ExerciseEntry } from "./entries";
import type { ResolvedPrescriptionRow } from "./types";
import {
  focusEntryKey,
  isFocusEligible,
  pinnedOverviewEntryKey,
  memberFinished,
  railState,
  roundPlacement,
  supersetRoundView,
  remainingProgress,
  supersetGroupEntries,
  twoMemberSuperset,
  transitionPresentation,
} from "./sessionFocus";

function entry(
  key: string,
  sets: number,
  tracking: ResolvedPrescriptionRow["tracking"] = "reps",
): ExerciseEntry {
  const bracket: ResolvedPrescriptionRow = {
    id: `rx-${key}`,
    planned_workout_id: "workout-1",
    exercise_id: key,
    exercise_name: key,
    position: 0,
    sets,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 60,
    notes: null,
    load_kg: 20,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 20,
    plate_load_kg: null,
    superset_group: null,
    tracking,
  };
  return { key, exercise_id: key, name: key, brackets: [bracket] };
}

const entries = [entry("squat", 2), entry("deadlift", 3), entry("press", 1)];
const isDone = (candidate: ExerciseEntry) => candidate.key === "squat";

describe("session focus derivations", () => {
  it("exposes an entire superset group so larger groups can render overview explicitly", () => {
    const a = entry("a", 2);
    const b = entry("b", 2);
    const c = entry("c", 2);
    for (const item of [a, b, c]) item.brackets[0]!.superset_group = 1;
    expect(supersetGroupEntries([a, b, c], "b")).toEqual([a, b, c]);
  });

  it("does not treat a reused separated letter as a valid paired Focus group", () => {
    const a = entry("a", 2);
    const b = entry("b", 2);
    const gap = entry("gap", 2);
    const c = entry("c", 2);
    for (const item of [a, b, c]) item.brackets[0]!.superset_group = 1;

    expect(twoMemberSuperset([a, b, gap, c], "a")).toBeNull();
  });

  it("returns the first incomplete entry when no active entry is restored", () => {
    expect(focusEntryKey(entries, isDone, null)).toBe("deadlift");
  });

  it("keeps the overview selection when entering focus", () => {
    expect(transitionPresentation("overview", "focus", "press", "squat")).toEqual({
      presentation: "focus",
      focusKey: "press",
    });
  });

  it("keeps Details on the corrected entry while a correction is active", () => {
    expect(pinnedOverviewEntryKey("deadlift", "squat")).toBe("squat");
    expect(pinnedOverviewEntryKey("deadlift", null)).toBe("deadlift");
  });

  it("offers focus mode for a timed prescription", () => {
    expect(isFocusEligible([entry("plank", 3, "time")])).toBe(true);
  });

  it("keeps a superset circuit with more than two members in overview", () => {
    const a = entry("a", 2);
    const b = entry("b", 2);
    const c = entry("c", 2);
    for (const item of [a, b, c]) item.brackets[0]!.superset_group = 1;

    expect(isFocusEligible([a, b, c])).toBe(false);
  });

  it("offers focus mode when a later bracket tracks duration", () => {
    const squat = entry("squat", 2);
    squat.brackets.push({ ...squat.brackets[0]!, id: "rx-squat-time", tracking: "time" });

    expect(isFocusEligible([squat])).toBe(true);
  });

  it("counts remaining sets and exercises from incomplete canonical entries", () => {
    expect(remainingProgress(entries, isDone)).toEqual({
      setsRemaining: 4,
      exercisesRemaining: 2,
    });
  });

  it("subtracts a partial entry's canonical progress from its remaining sets", () => {
    expect(
      remainingProgress(entries, isDone, (candidate) =>
        candidate.key === "deadlift" ? 1 : 0,
      ),
    ).toEqual({
      setsRemaining: 3,
      exercisesRemaining: 2,
    });
  });
});

describe("railState", () => {
  const e = (key: string): ExerciseEntry => ({
    key,
    exercise_id: key,
    name: key,
    brackets: [],
  });
  const railEntries = [e("a"), e("b"), e("c"), e("d")];
  const noneSkipped = () => false;

  it("marks the current entry (or entries, for a live superset pair)", () => {
    expect(
      railState(railEntries, e("b"), new Set(["b"]), noneSkipped, () => false),
    ).toBe("current");
    expect(
      railState(
        railEntries,
        e("c"),
        new Set(["b", "c"]),
        noneSkipped,
        () => false,
      ),
    ).toBe("current");
  });

  it("marks a skipped entry skipped even if it would otherwise be done", () => {
    expect(
      railState(
        railEntries,
        e("a"),
        new Set(),
        (x) => x.key === "a",
        () => true,
      ),
    ).toBe("skipped");
  });

  it("marks a completed, non-current, non-skipped entry done", () => {
    expect(
      railState(
        railEntries,
        e("a"),
        new Set(["b"]),
        noneSkipped,
        (x) => x.key === "a",
      ),
    ).toBe("done");
  });

  it("marks exactly the first not-done, not-skipped, not-current entry next", () => {
    // b is current, a is done, c is the first untouched entry after it
    const isDoneRail = (x: ExerciseEntry) => x.key === "a";
    expect(
      railState(railEntries, e("c"), new Set(["b"]), noneSkipped, isDoneRail),
    ).toBe("next");
    expect(
      railState(railEntries, e("d"), new Set(["b"]), noneSkipped, isDoneRail),
    ).toBe("upcoming");
  });
});

describe("supersetRoundView — member by member", () => {
  const m = (progress: number, target = 3, skipped = false) => ({ progress, target, skipped });

  it("starts on A1: A1 NOW, A2 NEXT, round 1 of 3", () => {
    const view = supersetRoundView(m(0), m(0));
    expect(view).toEqual({
      nowIndex: 0,
      tail: false,
      states: ["now", "next"],
      roundIndex: 1,
      roundTotal: 3,
    });
  });

  it("moves to A2 once A1 is ahead; A1 reads done for this round", () => {
    const view = supersetRoundView(m(1), m(0))!;
    expect(view.nowIndex).toBe(1);
    expect(view.states).toEqual(["done", "now"]);
    expect(view.roundIndex).toBe(1);
  });

  it("returns to A1 for the next round, which is round 2", () => {
    const view = supersetRoundView(m(1), m(1))!;
    expect(view.nowIndex).toBe(0);
    expect(view.states).toEqual(["now", "next"]);
    expect(view.roundIndex).toBe(2);
  });

  it("H1: a skipped A1 is finished, so A2 is NOW and can be logged", () => {
    const view = supersetRoundView(m(0, 3, true), m(0))!;
    expect(view.nowIndex).toBe(1);
    expect(view.tail).toBe(true);
    expect(view.states).toEqual(["skipped", "now"]);
  });

  it("H1: a skipped A2 after A1 logged leaves A1 NOW, not the skipped A2", () => {
    const view = supersetRoundView(m(1), m(0, 3, true))!;
    expect(view.nowIndex).toBe(0);
    expect(view.tail).toBe(true);
    expect(view.states).toEqual(["now", "skipped"]);
    // the tail counts the member that is going on: set 2 of 3
    expect(view.roundIndex).toBe(2);
    expect(view.roundTotal).toBe(3);
  });

  it("is over when both members are finished, skipped or met", () => {
    expect(supersetRoundView(m(3), m(3))).toBeNull();
    expect(supersetRoundView(m(0, 3, true), m(3))).toBeNull();
    expect(supersetRoundView(m(0, 3, true), m(0, 3, true))).toBeNull();
  });

  it("the tail of an unequal pair: the met member is done, the other carries on", () => {
    const view = supersetRoundView(m(3, 3), m(3, 4))!;
    expect(view.tail).toBe(true);
    expect(view.nowIndex).toBe(1);
    expect(view.states).toEqual(["done", "now"]);
    expect(view.roundIndex).toBe(4);
    expect(view.roundTotal).toBe(4);
  });

  it("a level pair is not a finished pair just because progress is equal", () => {
    const view = supersetRoundView(m(3, 3), m(3, 4))!;
    expect(view.tail).toBe(true);
  });

  it("honours a tapped partner (log out of order) only while it has work left", () => {
    expect(supersetRoundView(m(0), m(0), 1)!.nowIndex).toBe(1);
    expect(supersetRoundView(m(0), m(0), 1)!.states).toEqual(["next", "now"]);
    // override pointing at a finished member is ignored
    expect(supersetRoundView(m(0), m(3), 1)!.nowIndex).toBe(0);
  });

  it("by-feel members are never met, so the round never ends by itself", () => {
    expect(memberFinished({ progress: 9, target: 0, skipped: false })).toBe(false);
    expect(memberFinished({ progress: 0, target: 0, skipped: true })).toBe(true);
    expect(supersetRoundView(m(2, 0), m(2, 0))!.roundTotal).toBe(0);
  });
});

describe("roundPlacement — what a member log means for rest", () => {
  const count = (progress: number, finished = false) => ({ progress, finished });

  it("A1 first in a round: the partner is level, so A1 carries the real rest and the round stays open", () => {
    expect(roundPlacement({ progress: 0 }, count(0))).toEqual({
      secondOfRound: false,
      roundOpenAfter: true,
    });
  });

  it("H3: A2 after A1 is the SECOND of the round — its gap is not a rest — and closes the round", () => {
    expect(roundPlacement({ progress: 0 }, count(1))).toEqual({
      secondOfRound: true,
      roundOpenAfter: false,
    });
  });

  it("the next round's A1 is a first member again, with a real rest before it", () => {
    expect(roundPlacement({ progress: 1 }, count(1))).toEqual({
      secondOfRound: false,
      roundOpenAfter: true,
    });
  });

  it("a finished or absent partner means every set is its own round: rest after each", () => {
    expect(roundPlacement({ progress: 2 }, count(3, true))).toEqual({
      secondOfRound: false,
      roundOpenAfter: false,
    });
    expect(roundPlacement({ progress: 0 }, null)).toEqual({
      secondOfRound: false,
      roundOpenAfter: false,
    });
  });

  it("logging the same member twice in a row keeps the round open", () => {
    expect(roundPlacement({ progress: 2 }, count(1))).toEqual({
      secondOfRound: false,
      roundOpenAfter: true,
    });
  });
});
