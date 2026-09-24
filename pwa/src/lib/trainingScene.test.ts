import { describe, expect, it } from "vitest";
import type { PlannedWorkoutRow } from "./types";
import type { ResolvedPrescriptionRow } from "./types";
import {
  classifyTrainingScene,
  nextActionableWorkout,
  type SceneEntry,
} from "./trainingScene";

const today = "2026-09-23";
function workout(
  id: string,
  scheduled_date: string | null,
  patch: Partial<PlannedWorkoutRow> & Record<string, unknown> = {},
): PlannedWorkoutRow & Record<string, unknown> {
  return {
    id,
    program_id: "program-1",
    day_index: 1,
    label: id,
    notes: null,
    scheduled_date,
    plan_note: null,
    skipped_at: null,
    exercise_count: 3,
    ...patch,
  };
}

describe("nextActionableWorkout", () => {
  it("returns the earliest future upcoming dated workout", () => {
    const later = workout("later", "2026-09-28");
    const earlier = workout("earlier", "2026-09-25");
    expect(
      nextActionableWorkout([later, earlier], new Map([
        ["later", "UPCOMING"],
        ["earlier", "UPCOMING"],
      ]), today),
    ).toBe(earlier);
  });

  it("excludes today, undated templates, drafts, skipped and done workouts", () => {
    const candidates = [
      workout("today", today),
      workout("template", null),
      workout("draft", "2026-09-24", { exercise_count: 0 }),
      workout("skipped", "2026-09-25", { skipped_at: "2026-09-20" }),
      workout("done", "2026-09-26"),
      workout("next", "2026-09-27"),
    ];
    const states = new Map([
      ["today", "TODAY"], ["draft", "DRAFT"], ["skipped", "SKIPPED"],
      ["done", "DONE"], ["next", "UPCOMING"],
    ]);
    expect(nextActionableWorkout(candidates, states, today)).toBe(candidates[5]);
  });

  it("excludes templates and days in discarded programs even if state says upcoming", () => {
    const discarded = workout("discarded", "2026-09-24", { program_discarded: true });
    const template = workout("template", "2026-09-25", { is_template: true });
    const next = workout("next", "2026-09-26");
    const states = new Map([["discarded", "UPCOMING"], ["template", "UPCOMING"], ["next", "UPCOMING"]]);
    expect(nextActionableWorkout([discarded, template, next], states, today)).toBe(next);
  });
});

describe("classifyTrainingScene", () => {
  function sceneEntry(
    key: string,
    equipment: string | null,
    tracking: ResolvedPrescriptionRow["tracking"] = "reps",
    load_entry: ResolvedPrescriptionRow["load_entry"] = "total",
    superset_group: number | null = null,
  ): SceneEntry {
    const bracket: ResolvedPrescriptionRow = {
      id: `rx-${key}`,
      planned_workout_id: "workout-1",
      exercise_id: key,
      exercise_name: key,
      position: 0,
      sets: 1,
      reps_min: 5,
      reps_max: 5,
      rest_seconds: 60,
      notes: null,
      load_kg: 20,
      load_pct_tm: null,
      tm_kg: null,
      resolved_load_kg: 20,
      plate_load_kg: null,
      superset_group,
      tracking,
      load_entry,
    };
    return { key, exercise_id: key, name: key, equipment, brackets: [bracket] };
  }

  it("distinguishes loaded, per-side, bodyweight, time, and tick-only entries", () => {
    expect(classifyTrainingScene([sceneEntry("entry", "barbell")], "entry")).toBe("loaded");
    expect(classifyTrainingScene([sceneEntry("entry", "dumbbell", "reps", "per_side")], "entry")).toBe("per_side");
    expect(classifyTrainingScene([sceneEntry("entry", "body only")], "entry")).toBe("bodyweight");
    expect(classifyTrainingScene([sceneEntry("entry", "body only", "time")], "entry")).toBe("time");
    expect(classifyTrainingScene([sceneEntry("entry", "body only", "done")], "entry")).toBe("tick_only");
  });

  it("uses paired focus only for two members and names larger groups overview", () => {
    const a = sceneEntry("a", "barbell", "reps", "total", 1);
    const b = sceneEntry("b", "barbell", "reps", "total", 1);
    const c = sceneEntry("c", "barbell", "reps", "total", 1);
    expect(classifyTrainingScene([a, b], "a")).toBe("paired_superset");
    expect(classifyTrainingScene([a, b, c], "a")).toBe("grouped_overview");
  });
});
