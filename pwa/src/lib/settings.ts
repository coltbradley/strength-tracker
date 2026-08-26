// Device-local preferences: display unit, plates on hand, bar, default rest.
// localStorage-backed, subscribable so React screens re-render on change
// (see hooks/useUnit and hooks/useSettings).
//
// UNIT DECISION (documented per handoff): everything is stored in kg — the
// codebase's canonical unit — but the app maintains TWO standard inventories,
// one per display unit system, rather than converting a single list:
//   kg mode: 25/20/15/10/5/2.5/1.25 kg plates, 20/15/10 kg bars
//   lb mode: the classic 45/35/25/10/5/2.5 lb set and 45/35/15 lb bars,
//            stored as their exact kg equivalents (45 lb = 20.4116... kg)
// This keeps chip labels clean in both modes and keeps plate math exact.

import { lbToKg, type Unit } from "./units";

const UNIT_KEY = "strength-log.unit";
const PLATES_KEY = "strength-log.plates"; // { kg: number[], lb: number[] } (kg values)
const BAR_KEY = "strength-log.bar"; // { kg: number, lb: number } (kg values)
const REST_KEY = "strength-log.defaultRest";

export const PLATE_CATALOG: Record<Unit, number[]> = {
  kg: [25, 20, 15, 10, 5, 2.5, 1.25],
  lb: [45, 35, 25, 10, 5, 2.5].map(lbToKg),
};

export const BAR_CATALOG: Record<Unit, number[]> = {
  kg: [20, 15, 10],
  lb: [45, 35, 15].map(lbToKg),
};

export const REST_CHOICES = [90, 120, 150, 180];

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// kept as an alias so existing call sites read naturally
export const subscribeUnit = subscribeSettings;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: preference just won't persist
  }
}

// ---- unit ------------------------------------------------------------------

let unit: Unit = (() => {
  try {
    return localStorage.getItem(UNIT_KEY) === "lb" ? "lb" : "kg";
  } catch {
    return "kg";
  }
})();

export function getUnit(): Unit {
  return unit;
}

export function setUnit(next: Unit): void {
  unit = next;
  try {
    localStorage.setItem(UNIT_KEY, next);
  } catch {
    // non-fatal
  }
  notify();
}

// ---- plates on hand --------------------------------------------------------

type PlateStore = Record<Unit, number[]>;

function sanitizePlates(stored: PlateStore | null): PlateStore {
  const pick = (u: Unit): number[] => {
    const cat = PLATE_CATALOG[u];
    const kept = stored?.[u]?.filter((p) =>
      cat.some((c) => Math.abs(c - p) < 1e-6),
    );
    return kept && kept.length > 0 ? [...kept].sort((a, b) => b - a) : [...cat];
  };
  return { kg: pick("kg"), lb: pick("lb") };
}

let plates: PlateStore = sanitizePlates(read<PlateStore>(PLATES_KEY));

/** enabled plates for a unit system, kg values, heaviest first */
export function getPlatesOnHand(u: Unit): number[] {
  return plates[u];
}

export function togglePlate(u: Unit, plateKg: number): void {
  const on = plates[u].some((p) => Math.abs(p - plateKg) < 1e-6);
  const next = on
    ? plates[u].filter((p) => Math.abs(p - plateKg) >= 1e-6)
    : [...plates[u], plateKg].sort((a, b) => b - a);
  plates = { ...plates, [u]: next };
  write(PLATES_KEY, plates);
  notify();
}

// ---- bar -------------------------------------------------------------------

type BarStore = Record<Unit, number>;

function sanitizeBars(stored: BarStore | null): BarStore {
  const pick = (u: Unit): number => {
    const cat = BAR_CATALOG[u];
    const v = stored?.[u];
    return v !== undefined && cat.some((c) => Math.abs(c - v) < 1e-6)
      ? v
      : cat[0];
  };
  return { kg: pick("kg"), lb: pick("lb") };
}

let bars: BarStore = sanitizeBars(read<BarStore>(BAR_KEY));

export function getBarKg(u: Unit): number {
  return bars[u];
}

export function setBarKg(u: Unit, kg: number): void {
  bars = { ...bars, [u]: kg };
  write(BAR_KEY, bars);
  notify();
}

// ---- per-exercise bar ------------------------------------------------------
// Which bar (if any) an exercise loads onto. Keyed by exercise id, kg value,
// 0 = no bar (plate-loaded machines like the leg press). Defaults: barbell
// exercises use the unit's chosen bar; everything else has no bar.

const EXERCISE_BAR_KEY = "strength-log.exerciseBar"; // Record<exercise_id, kg>

let exerciseBars: Record<string, number> =
  read<Record<string, number>>(EXERCISE_BAR_KEY) ?? {};

export function getExerciseBarKg(
  exerciseId: string,
  u: Unit,
  equipment: string | null,
): number {
  const override = exerciseBars[exerciseId];
  if (override !== undefined) return override;
  return equipment === "barbell" ? getBarKg(u) : 0;
}

/** kg value from BAR_CATALOG, or 0 for no bar; null clears the override */
export function setExerciseBarKg(exerciseId: string, kg: number | null): void {
  if (kg === null) {
    const { [exerciseId]: _dropped, ...rest } = exerciseBars;
    exerciseBars = rest;
  } else {
    exerciseBars = { ...exerciseBars, [exerciseId]: kg };
  }
  write(EXERCISE_BAR_KEY, exerciseBars);
  notify();
}

// ---- default rest ----------------------------------------------------------

let defaultRest: number = (() => {
  const v = read<number>(REST_KEY);
  // any sane stored value survives a reload (typed values aren't presets)
  return v !== null && Number.isFinite(v) && v >= 0 && v <= 3600
    ? Math.round(v)
    : 120;
})();

export function getDefaultRestSeconds(): number {
  return defaultRest;
}

export function cycleDefaultRest(): void {
  const i = REST_CHOICES.indexOf(defaultRest);
  defaultRest = REST_CHOICES[(i + 1) % REST_CHOICES.length];
  write(REST_KEY, defaultRest);
  notify();
}

/** Granular control (typed via the number pad); clamped to the DB's cap. */
export function setDefaultRestSeconds(seconds: number): void {
  defaultRest = Math.min(3600, Math.max(0, Math.round(seconds)));
  write(REST_KEY, defaultRest);
  notify();
}
