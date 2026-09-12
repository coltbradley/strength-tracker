import { describe, expect, it } from "vitest";
import type { ExerciseEntry } from "./entries";
import type { ResolvedPrescriptionRow } from "./types";
import {
  focusEntryKey,
  isFocusEligible,
  pinnedOverviewEntryKey,
  remainingProgress,
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

  it("counts remaining sets and exercises from incomplete canonical entries", () => {
    expect(remainingProgress(entries, isDone)).toEqual({
      setsRemaining: 4,
      exercisesRemaining: 2,
    });
  });
});
