import { useSyncExternalStore } from "react";
import {
  getBarKg,
  getDefaultRestSeconds,
  getExerciseBarKg,
  getPlatesOnHand,
  subscribeSettings,
} from "../lib/settings";
import type { Unit } from "../lib/units";

export function usePlatesOnHand(unit: Unit): number[] {
  return useSyncExternalStore(subscribeSettings, () => getPlatesOnHand(unit));
}

export function useBarKg(unit: Unit): number {
  return useSyncExternalStore(subscribeSettings, () => getBarKg(unit));
}

export function useDefaultRestSeconds(): number {
  return useSyncExternalStore(subscribeSettings, getDefaultRestSeconds);
}

/** The bar this exercise loads onto (kg; 0 = no bar). */
export function useExerciseBarKg(
  exerciseId: string | null,
  unit: Unit,
  equipment: string | null,
): number {
  return useSyncExternalStore(subscribeSettings, () =>
    exerciseId === null ? 0 : getExerciseBarKg(exerciseId, unit, equipment),
  );
}
