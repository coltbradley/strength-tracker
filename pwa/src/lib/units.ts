// kg is the storage unit everywhere. lb exists only at the display edge.
//
// This module imports from settings.ts and settings.ts imports `lbToKg` back.
// The cycle is safe because neither side evaluates the other at module-init
// time — see the MODULE CYCLE note in settings.ts before adding a top-level
// call here.

import { getExerciseStepKg, getLoadStepKg } from "./settings";
import { KG_PER_LB } from "./setLoad";

export type Unit = "kg" | "lb";

// One definition: setLoad.ts owns the factor the database rule uses.
export { KG_PER_LB };

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

/**
 * kg -> the number a lifter READS AND KEEPS in a load field: stepper face,
 * step label, pad prefill, a draft's typed value. Unlike `toDisplay` it does
 * not round a kg value to one decimal, because kg totals are stored at two
 * (numeric(6,2)) and the 1.25 kg step lands on them: 21.25 stays 21.25, never
 * 21.3. lb is a conversion of a 2-decimal kg total, so it reads at one
 * decimal, the finest at which that total can be recovered. Use `toDisplay`
 * for read-only quotes of a converted value; use this wherever the shown
 * number feeds a write or becomes the typed value.
 */
export function toTypedDisplay(kg: number, unit: Unit): number {
  return unit === "kg"
    ? Math.round(kg * 100) / 100
    : Math.round(kgToLb(kg) * 10) / 10;
}

/** Keep an already staged weight legible when the display unit changes.
 * Two decimals on the converted view preserve the hundredth-kg value held
 * by the draft; ordinary unstaged suggestions keep the usual one decimal. */
export function stagedDisplayLoad(
  entryKg: number,
  enteredLoad: number | undefined,
  enteredUnit: Unit | undefined,
  unit: Unit,
): number {
  if (enteredLoad !== undefined && enteredUnit === unit) return enteredLoad;
  if (enteredUnit !== undefined && enteredUnit !== unit) {
    const converted = unit === "kg" ? entryKg : kgToLb(entryKg);
    return Math.round(converted * 100) / 100;
  }
  return toTypedDisplay(entryKg, unit);
}

/** value entered/shown in the display unit -> kg (unrounded). For DISPLAY
 *  and steppers only: a stored load is derived by `buildSetLoad`, never by
 *  converting here and rounding. */
export function fromDisplay(value: number, unit: Unit): number {
  return unit === "kg" ? value : lbToKg(value);
}

/**
 * The highest bodyweight either capture path accepts, in kg.
 *
 * Lived in End.tsx while End was the only way to record one. It is a bound on
 * a COLUMN, not a property of a screen, and `numeric(5,2)` cannot hold four
 * digits and two decimals anyway — a second screen with its own ceiling is how
 * one of them ends up writing a row the database refuses.
 */
export const MAX_BODYWEIGHT_KG = 400;

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
