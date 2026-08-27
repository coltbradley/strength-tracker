// kg is the storage unit everywhere. lb exists only at the display edge.
//
// This module imports from settings.ts and settings.ts imports `lbToKg` back.
// The cycle is safe because neither side evaluates the other at module-init
// time — see the MODULE CYCLE note in settings.ts before adding a top-level
// call here.

import { getExerciseStepKg, getLoadStepKg } from "./settings";

export type Unit = "kg" | "lb";

export const KG_PER_LB = 0.45359237;

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB;
}

/** kg -> value in the display unit, rounded to 1 decimal. */
export function toDisplay(kg: number, unit: Unit): number {
  const v = unit === "kg" ? kg : kgToLb(kg);
  return Math.round(v * 10) / 10;
}

/** value entered/shown in the display unit -> kg (unrounded). */
export function fromDisplay(value: number, unit: Unit): number {
  return unit === "kg" ? value : lbToKg(value);
}

/**
 * Stepper increment, in kg, for the active display unit. Settings-driven:
 * `loadStepCoarse` / `loadStepFine` (defaults 2.5 kg / 5 lb and 0.5 kg / 1 lb).
 */
export function stepKg(unit: Unit, fine: boolean): number {
  return getLoadStepKg(unit, fine);
}

/**
 * Same, honouring a per-exercise coarse override — dumbbells jump 5 lb per
 * hand, a cable stack jumps whatever the stack says. Pass null for exercise-
 * agnostic screens (the plan editor, bodyweight).
 */
export function stepKgFor(
  exerciseId: string | null,
  unit: Unit,
  fine: boolean,
): number {
  return getExerciseStepKg(exerciseId, unit, fine);
}
