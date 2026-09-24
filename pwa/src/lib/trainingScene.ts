import { isBodyweightEquipment } from "./loadEntry";
import { supersetGroupEntries } from "./sessionFocus";
import type { ExerciseEntry } from "./entries";
import type { PlannedWorkoutRow } from "./types";

export type TrainingSceneKind =
  | "loaded"
  | "per_side"
  | "bodyweight"
  | "time"
  | "tick_only"
  | "paired_superset"
  | "grouped_overview";

export type WorkoutState =
  | "UPCOMING"
  | "TODAY"
  | "DONE"
  | "SKIPPED"
  | "DRAFT"
  | "MISSED"
  | "PAST"
  | string;

export type ActionableWorkout = PlannedWorkoutRow & {
  /** Optional flags accepted by broader callers; v_plan_workouts already filters these. */
  is_template?: boolean;
  program_discarded?: boolean;
  discarded_at?: string | null;
  program_discarded_at?: string | null;
};

/** Earliest future workout that the same state vocabulary calls UPCOMING. */
export function nextActionableWorkout<T extends ActionableWorkout>(
  workouts: readonly T[],
  states: ReadonlyMap<string, WorkoutState>,
  today: string,
): T | null {
  return (
    workouts
      .filter(
        (workout) =>
          workout.scheduled_date !== null &&
          workout.scheduled_date > today &&
          workout.exercise_count > 0 &&
          workout.skipped_at === null &&
          workout.is_template !== true &&
          workout.program_discarded !== true &&
          (workout.discarded_at ?? null) === null &&
          (workout.program_discarded_at ?? null) === null &&
          states.get(workout.id) === "UPCOMING",
      )
      .sort(
        (a, b) =>
          a.scheduled_date!.localeCompare(b.scheduled_date!) ||
          a.day_index - b.day_index,
      )[0] ?? null
  );
}

export interface SceneEntry extends ExerciseEntry {
  equipment?: string | null;
}

/** Classifies the selected movement without changing its prescription or draft. */
export function classifyTrainingScene(
  entries: readonly SceneEntry[],
  key: string,
): TrainingSceneKind | null {
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) return null;

  const group = supersetGroupEntries(entries, key);
  if (group.length > 2) return "grouped_overview";
  if (
    group.length === 2 &&
    group.every((member) =>
      member.brackets.every((bracket) => bracket.tracking === "reps"),
    )
  )
    return "paired_superset";

  if (entry.brackets.some((bracket) => bracket.tracking === "time"))
    return "time";
  if (entry.brackets.some((bracket) => bracket.tracking === "done"))
    return "tick_only";
  if (isBodyweightEquipment(entry.equipment ?? null)) return "bodyweight";
  if (entry.brackets.some((bracket) => bracket.load_entry === "per_side"))
    return "per_side";
  return "loaded";
}
