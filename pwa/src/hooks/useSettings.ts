import { useSyncExternalStore } from "react";
import {
  getBarKg,
  getDefaultRestSeconds,
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
