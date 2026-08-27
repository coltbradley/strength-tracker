// React bindings for the settings registry (lib/settings.ts).
//
// `useSetting` is the general one and needs no new code when a preference is
// added. The named hooks below exist because their call sites read better and
// because a few of them fold in a resolution chain (per-exercise -> global).
//
// Snapshot identity matters here: useSyncExternalStore compares with Object.is,
// so every getter must return a memoised value for object/array settings. The
// store's parse cache guarantees that — do not wrap these in a `.map()` or a
// fresh object literal.

import { useSyncExternalStore } from "react";
import {
  getAutoStartRest,
  getBarInventory,
  getBarKg,
  getDefaultRestSeconds,
  getExerciseBarKg,
  getExercisePref,
  getExerciseRestSeconds,
  getExerciseStepKg,
  getPlatesOnHand,
  getSetting,
  getWeekStartsOn,
  listExercisePrefs,
  readSetting,
  subscribeSettings,
  type ExercisePref,
  type SettingKey,
  type SettingValue,
} from "../lib/settings";
import type { Unit } from "../lib/units";

/** Any preference, by registry key. */
export function useSetting<K extends SettingKey>(key: K): SettingValue<K> {
  return useSyncExternalStore(subscribeSettings, () => getSetting(key));
}

/** Untyped twin, for the registry-driven settings sheet renderer. */
export function useSettingRaw(key: SettingKey): unknown {
  return useSyncExternalStore(subscribeSettings, () => readSetting(key));
}

export function usePlatesOnHand(unit: Unit): number[] {
  return useSyncExternalStore(subscribeSettings, () => getPlatesOnHand(unit));
}

export function useBarInventory(unit: Unit): number[] {
  return useSyncExternalStore(subscribeSettings, () => getBarInventory(unit));
}

export function useBarKg(unit: Unit): number {
  return useSyncExternalStore(subscribeSettings, () => getBarKg(unit));
}

export function useDefaultRestSeconds(): number {
  return useSyncExternalStore(subscribeSettings, getDefaultRestSeconds);
}

/** Whether logging a set should start the rest clock by itself. */
export function useAutoStartRest(): boolean {
  return useSyncExternalStore(subscribeSettings, getAutoStartRest);
}

export function useWeekStartsOn(): number {
  return useSyncExternalStore(subscribeSettings, getWeekStartsOn);
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

/** Rest before the next set: bracket -> this movement's override -> global. */
export function useExerciseRestSeconds(
  exerciseId: string | null,
  bracketRestSeconds: number | null,
): number {
  return useSyncExternalStore(subscribeSettings, () =>
    getExerciseRestSeconds(exerciseId, bracketRestSeconds),
  );
}

/** Stepper increment in kg, honouring this movement's coarse override. */
export function useExerciseStepKg(
  exerciseId: string | null,
  unit: Unit,
  fine: boolean,
): number {
  return useSyncExternalStore(subscribeSettings, () =>
    getExerciseStepKg(exerciseId, unit, fine),
  );
}

export function useExercisePref(exerciseId: string | null): ExercisePref {
  return useSyncExternalStore(subscribeSettings, () =>
    exerciseId === null ? EMPTY_PREF : getExercisePref(exerciseId),
  );
}

// stable identity for the null case, so the snapshot never changes shape
const EMPTY_PREF: ExercisePref = {};

export function useExercisePrefs(): {
  exerciseId: string;
  pref: ExercisePref;
}[] {
  // listExercisePrefs allocates, so memoise against the cached map identity:
  // the snapshot is the map, the list is derived from it.
  const map = useSyncExternalStore(subscribeSettings, () =>
    getSetting("exercisePrefs"),
  );
  return listFor(map);
}

let listCacheKey: object | null = null;
let listCacheValue: { exerciseId: string; pref: ExercisePref }[] = [];

function listFor(
  map: Record<string, ExercisePref>,
): { exerciseId: string; pref: ExercisePref }[] {
  if (listCacheKey !== map) {
    listCacheKey = map;
    listCacheValue = listExercisePrefs();
  }
  return listCacheValue;
}
