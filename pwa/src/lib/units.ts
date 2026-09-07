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
 * A bodyweight as `bodyweight_log.weight_kg` stores it: numeric(5,2).
 *
 * TWO decimals, not one, and that is the whole point of the function. `lb` is
 * a display unit and `toDisplay` rounds it to 0.1 lb, which is 0.045 kg — so
 * 180.0 lb is 81.6466 kg, and rounding THAT to one decimal (81.6) reads back
 * as 179.9. Someone who weighs in lb would watch the number they typed change
 * by itself. Two decimals bound the error at 0.005 kg = 0.011 lb, comfortably
 * inside the 0.05 lb that would move the displayed figure, so what was typed
 * is what comes back — in either unit, in either direction.
 */
export function toStoredKg(kg: number): number {
  return Math.round(kg * 100) / 100;
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
