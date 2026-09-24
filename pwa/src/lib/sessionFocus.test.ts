import { describe, expect, it } from "vitest";
import type { ExerciseEntry } from "./entries";
import type { ResolvedPrescriptionRow } from "./types";
import {
  focusEntryKey,
  isFocusEligible,
  pinnedOverviewEntryKey,
  railState,
  remainingProgress,
  supersetGroupEntries,
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

  it("does not offer focus mode for a timed prescription", () => {
    expect(isFocusEligible([entry("plank", 3, "time")])).toBe(false);
  });

  it("does not offer focus mode when a later bracket tracks duration", () => {
    const squat = entry("squat", 2);
    squat.brackets.push({ ...squat.brackets[0]!, id: "rx-squat-time", tracking: "time" });

    expect(isFocusEligible([squat])).toBe(false);
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
