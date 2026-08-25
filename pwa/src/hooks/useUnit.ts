import { useSyncExternalStore } from "react";
import { getUnit, subscribeUnit } from "../lib/settings";
import type { Unit } from "../lib/units";

export function useUnit(): Unit {
  return useSyncExternalStore(subscribeUnit, getUnit);
}
