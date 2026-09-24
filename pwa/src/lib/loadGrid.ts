import type { ExercisePref } from "./settings";
import type { ExerciseRow, LoadEntry, LoadUnit } from "./types";
import { kgToLb } from "./units";

export interface LoadGridSettings {
  /** Existing global step preferences are stored as kg. */
  coarseStepKg?: number;
  fineStepKg?: number;
  exercisePref?: Pick<ExercisePref, "loadStepKg">;
  /** Echoed for editing UIs. Suggestions never replace this typed value. */
  typedValue?: number;
}

export interface LoadGrid {
  coarseStep: number;
  fineStep: number;
  typedValue?: number;
  nearbyStandardValues(value: number): number[];
}

function equipmentKind(
  exercise: ExerciseRow,
  entry: LoadEntry,
): "plates" | "dumbbells" | "stack" {
  const equipment = exercise.equipment?.toLowerCase() ?? "";
  if (equipment.startsWith("machine") || equipment.startsWith("cable"))
    return "stack";
  if (equipment.startsWith("dumbbell") && entry === "per_side")
    return "dumbbells";
  return "plates";
}

function defaults(
  kind: "plates" | "dumbbells" | "stack",
  unit: LoadUnit,
): { coarse: number; fine: number; standard: number[] } {
  if (kind === "stack") {
    return unit === "kg"
      ? { coarse: 5, fine: 2.5, standard: [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100] }
      : { coarse: 10, fine: 5, standard: [10, 20, 30, 40, 50, 60, 80, 100, 120, 160, 200] };
  }
  if (kind === "dumbbells") {
    return unit === "kg"
      ? { coarse: 2.5, fine: 1.25, standard: [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 30, 35, 40] }
      : { coarse: 5, fine: 2, standard: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80] };
  }
  return unit === "kg"
    ? { coarse: 2.5, fine: 0.5, standard: [20, 40, 60, 80, 100, 120, 140, 160, 180, 200] }
    : { coarse: 5, fine: 1, standard: [45, 65, 95, 135, 185, 225, 275, 315, 365, 405] };
}

function asUnit(kg: number, unit: LoadUnit): number {
  return unit === "kg" ? kg : kgToLb(kg);
}

/** Equipment-aware input recommendations; this function never validates or rounds a value. */
export function loadGridFor(
  exercise: ExerciseRow,
  authoredUnit: LoadUnit,
  entry: LoadEntry,
  settings: LoadGridSettings,
): LoadGrid {
  const kind = equipmentKind(exercise, entry);
  const fallback = defaults(kind, authoredUnit);
  const coarseKg = settings.exercisePref?.loadStepKg ?? settings.coarseStepKg;
  const coarseStep = coarseKg === undefined ? fallback.coarse : asUnit(coarseKg, authoredUnit);
  const fineStep =
    settings.fineStepKg === undefined
      ? fallback.fine
      : asUnit(settings.fineStepKg, authoredUnit);

  return {
    coarseStep,
    fineStep,
    ...(settings.typedValue === undefined ? {} : { typedValue: settings.typedValue }),
    nearbyStandardValues(value) {
      return [...fallback.standard]
        .sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b)
        .slice(0, 5)
        .sort((a, b) => a - b);
    },
  };
}
