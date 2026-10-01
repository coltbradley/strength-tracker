// THE one formatter for every load, total, e1RM, volume, goal and bodyweight a
// screen prints. Display only: nothing here feeds `load_kg`, which only
// `buildSetLoad` (setLoad.ts) derives, and nothing here changes what is stored.
//
// The product rules (docs/decisions.md, 2026-10-01 "Human-precision loads"):
//   1. What the lifter typed is shown exactly as typed, in the unit typed.
//   2. Anything CONVERTED is shown at human precision: at most one decimal,
//      a trailing ".0" dropped, no float artefacts (never 102.06000001, never
//      44.09, never 225.97). Same rule in both units.
//   3. A staged number that crosses units defaults to the nearest LOADABLE
//      value on the exercise's step grid (`loadableDefault`), with the plan's
//      own number quoted beside it by the caller.
//
// The one exception to "one decimal" is kg read in kg with nothing typed to
// quote: a stored 21.25 kg (the 1.25 kg plate) is a real, exact, loadable
// number, not a conversion artefact, so quarter-kg multiples keep their
// second decimal. Every other converted value is rounded.
//
// Dependency-free except for the unit factor and types, so settings, plates
// and format can all import it without a cycle.

import { KG_PER_LB } from "./setLoad";

export type DisplayUnit = "kg" | "lb";

export interface TypedValue {
  value: number;
  unit: DisplayUnit;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  // the epsilon keeps 1.005-style ties from sliding down on a binary float
  const r = Math.round((Math.abs(n) + 1e-9) * f) / f;
  return n < 0 ? -r : r;
};

/** A number as text with no trailing zeros and no "-0". String() of a value
 *  already rounded to <= 3 places is its shortest form, never an artefact. */
function text(n: number): string {
  const s = String(n === 0 ? 0 : n);
  return s;
}

const isQuarter = (n: number): boolean => Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;

/** kg -> the number to quote in `unit` at human precision (rule 2). */
export function convertedLoadValue(kg: number, unit: DisplayUnit): number {
  if (!Number.isFinite(kg)) return 0;
  if (unit === "kg") {
    const two = round(kg, 2);
    return isQuarter(two) ? two : round(kg, 1);
  }
  return round(kg / KG_PER_LB, 1);
}

/**
 * Format a load (or any weight-like quantity) for display, without the unit.
 * `typed` is what the lifter typed for THIS number: when it was typed in the
 * unit being shown it is quoted exactly (rule 1); otherwise `kg` is converted
 * (rule 2). Returns e.g. "102.1", "225", "21.25" (typed or on the 1.25 plate).
 */
export function formatLoad(
  kg: number,
  unit: DisplayUnit,
  opts: { typed?: TypedValue | null } = {},
): string {
  const t = opts.typed;
  if (t && t.unit === unit && Number.isFinite(t.value)) return text(round(t.value, 3));
  return text(convertedLoadValue(kg, unit));
}

/** `formatLoad` with the unit: "102.1 kg". */
export function formatLoadWithUnit(
  kg: number,
  unit: DisplayUnit,
  opts: { typed?: TypedValue | null } = {},
): string {
  return `${formatLoad(kg, unit, opts)} ${unit}`;
}

/** A typed number in its own unit: "145 lb". Rule 1 with no conversion. */
export function formatTyped(value: number, unit: DisplayUnit): string {
  return `${text(round(value, 3))} ${unit}`;
}

/** The same quantity, numerically at display precision (for arithmetic that
 *  must agree with what is printed, e.g. a seed for a number pad). */
export function displayLoadNumber(
  kg: number,
  unit: DisplayUnit,
  opts: { typed?: TypedValue | null } = {},
): number {
  return Number(formatLoad(kg, unit, opts));
}

/**
 * Rule 3: the number a lifter should find staged when a plan or last-time
 * value arrives from the OTHER unit. The nearest loadable value in `unit` on
 * the exercise's step grid (`stepKg` is that grid's step in kg, as
 * `stepKgFor(exerciseId, unit, false)` returns it: per-exercise step, else
 * 5 lb / 2.5 kg, a dumbbell's own per-hand step), so nobody has to load
 * "220.5 lb". A conversion already on the grid within the database's 0.01 kg
 * precision lands on that grid point, so 100 lb (45.36 kg) stays exactly 100.
 * Never below one step for a positive load, never negative.
 *
 * `kg` is the value that will be typed: one side for a per-hand movement.
 */
export function loadableDefault(
  kg: number,
  unit: DisplayUnit,
  stepKg: number,
): number {
  if (!Number.isFinite(kg) || kg <= 0) return 0;
  const step = unit === "kg" ? round(stepKg, 3) : round(stepKg / KG_PER_LB, 2);
  if (!(step > 0)) return convertedLoadValue(kg, unit);
  const v = unit === "kg" ? kg : kg / KG_PER_LB;
  const n = Math.max(1, Math.floor(v / step + 0.5 + 1e-9));
  return round(n * step, 3);
}

/** A stored set/prescription row's load as the lifter reads it in `unit`:
 *  exactly as typed when typed in this unit (one side for a per-side row),
 *  otherwise the human-precision conversion. The text twin of
 *  `shownLoadValue` (setLoad.ts), which returns the same number without the
 *  kg-in-kg quarter rule. */
export function formatSetLoad(
  row: {
    load_kg: number;
    load_entry?: "total" | "per_side" | null;
    entered_load?: number | null;
    entered_unit?: DisplayUnit | null;
  },
  unit: DisplayUnit,
): string {
  const typed =
    row.entered_load != null && row.entered_unit && row.load_entry != null
      ? { value: row.entered_load, unit: row.entered_unit }
      : null;
  const side = row.load_entry === "per_side" ? row.load_kg / 2 : row.load_kg;
  return formatLoad(side, unit, { typed });
}

// ---- staging a number across units (rule 3) ---------------------------------

/** The source's own number, quoted beside a staged one that crossed units:
 *  "plan 100 kg", "last 145 lb". */
export interface PlanRef {
  label: "plan" | "last";
  value: number;
  unit: DisplayUnit;
}

export interface StagedLoad {
  /** kg of ONE entry (one side when per-hand), two decimals. */
  entryKg: number;
  /** The typed number the lifter will see and log (buildSetLoad input). */
  enteredLoad?: number;
  enteredUnit?: DisplayUnit;
  planRef?: PlanRef;
}

const kgOf = (value: number, unit: DisplayUnit): number =>
  Math.round((unit === "kg" ? value : value * KG_PER_LB) * 100) / 100;

/**
 * What to stage for the next set when a prescription or an earlier set
 * supplies the starting number.
 *
 *  - `origin` is the source's typed number (a plan authored in 100 kg, a set
 *    typed as 145 lb), or null when only a stored kg total is known.
 *  - Typed in the unit being shown: stage it exactly (rule 1).
 *  - Otherwise stage the nearest loadable value in the shown unit on the
 *    exercise's step grid (rule 3) as a TYPED number, so the lifter never has
 *    to load "220.5 lb", logging it unchanged logs what they saw, and the
 *    source's own number rides along as `planRef`.
 *  - A stored kg total with no typed number, shown in kg and already a clean
 *    number (<= 1 decimal, or a quarter kg) is staged as it is, like before.
 */
export function stageLoad(a: {
  unit: DisplayUnit;
  /** The grid step in kg: stepKgFor(exerciseId, unit, false). */
  stepKg: number;
  /** kg of one entry, two decimals (already one side for per-hand). */
  sourceEntryKg: number;
  origin: TypedValue | null;
  label: "plan" | "last" | null;
}): StagedLoad {
  const { unit, stepKg, sourceEntryKg, origin, label } = a;
  if (origin && origin.unit === unit) {
    return { entryKg: kgOf(origin.value, unit), enteredLoad: origin.value, enteredUnit: unit };
  }
  if (!(sourceEntryKg > 0)) return { entryKg: 0 };
  if (!origin && unit === "kg" && convertedLoadValue(sourceEntryKg, "kg") === sourceEntryKg) {
    return { entryKg: sourceEntryKg };
  }
  const typed = loadableDefault(sourceEntryKg, unit, stepKg);
  const staged: StagedLoad = {
    entryKg: kgOf(typed, unit),
    enteredLoad: typed,
    enteredUnit: unit,
  };
  if (label && origin) staged.planRef = { label, value: origin.value, unit: origin.unit };
  else if (label === "plan" && !origin)
    staged.planRef = { label, value: convertedLoadValue(sourceEntryKg, "kg"), unit: "kg" };
  return staged;
}

/** "plan 100 kg" when the staged number is quoting a source from the other
 *  unit; null when the units agree (nothing to explain). */
export function formatPlanRef(ref: PlanRef | undefined, unit: DisplayUnit): string | null {
  if (!ref || ref.unit === unit) return null;
  return `${ref.label} ${formatTyped(ref.value, ref.unit)}`;
}
