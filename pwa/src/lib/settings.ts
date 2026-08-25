// Display unit preference. localStorage-backed, subscribable so React screens
// re-render on toggle (see hooks/useUnit).

import type { Unit } from "./units";

const KEY = "strength-log.unit";

let current: Unit = readInitial();
const listeners = new Set<() => void>();

function readInitial(): Unit {
  try {
    const v = localStorage.getItem(KEY);
    return v === "lb" ? "lb" : "kg";
  } catch {
    return "kg";
  }
}

export function getUnit(): Unit {
  return current;
}

export function setUnit(unit: Unit): void {
  current = unit;
  try {
    localStorage.setItem(KEY, unit);
  } catch {
    // storage full/unavailable: preference just won't persist
  }
  for (const fn of listeners) fn();
}

export function subscribeUnit(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
