// Per-side (unilateral) load convention — the client half of
// supabase/migrations/20260827160000_per_side_load.sql. Read that header
// before touching anything here; the arithmetic is easy to get backwards.
//
// THE RULE: `sets.load_kg` is ALWAYS the TOTAL system load. `load_entry`
// records only how the lifter EXPRESSED it:
//   'total'     the typed number is the whole system — a barbell, a machine
//               stack, or ONE implement moved on its own. A single-arm row is
//               'total': one 30 kg dumbbell IS the whole system for that rep.
//   'per_side'  the typed number is one side and both sides move together (a
//               pair of dumbbells). load_kg = 2 x typed.
//   null        not asserted (historic rows). Never write null for a new set,
//               and never READ null as "total" — the ambiguity is permanent.
//
// So the screen holds the number the user is typing ("entered") and converts
// to the total exactly once, at the edges: on log, and for the plate maths.

import type { LoadEntry } from "./types";
import { getExercisePref } from "./settings";

/** Equipment whose exercises MAY be loaded one implement per hand. Everything
 *  else (barbell, machine, cable, bands, bodyweight) is a single system and
 *  never gets the control — a barbell must not grow a per-side toggle. */
const PER_SIDE_EQUIPMENT = ["dumbbell", "kettlebell"];

/** `kettlebells` is the free-exercise-db spelling; `kettlebell` the curated one. */
function isPerSideEquipment(equipment: string | null): boolean {
  if (equipment === null) return false;
  const e = equipment.toLowerCase();
  return PER_SIDE_EQUIPMENT.some((k) => e.startsWith(k));
}

/**
 * Movement names that are explicitly ONE limb at a time. These are 'total':
 * the load is honest, it is the REPS that are per side (deliberately not
 * modelled — log each side as its own set).
 */
const UNILATERAL_NAME =
  /\b(?:single|one|1)[- ]?(?:arm|armed|leg|legged|side|sided|hand|handed)\b|\balternating\b|\bunilateral\b/i;

/**
 * The default when nobody has asserted anything: a dumbbell movement that is
 * not named as one-limb work is a PAIR. Everything else is total. A wrong
 * default costs one tap; `load_entry` on the row is what makes the record
 * honest. (Kettlebells default to total — a swing is one bell — but stay
 * per-side capable, so double-bell work is one tap away.)
 */
export function defaultLoadEntry(
  equipment: string | null,
  name: string,
): LoadEntry {
  if (equipment?.toLowerCase() !== "dumbbell") return "total";
  return UNILATERAL_NAME.test(name) ? "total" : "per_side";
}

export interface LoadEntryInput {
  /** the user's own per-exercise choice (device-local settings) */
  override?: LoadEntry;
  /** what the coach's prescription asserts, when it asserts anything */
  prescribed?: LoadEntry | null;
  equipment: string | null;
  name: string;
}

/**
 * How this exercise's load is expressed, most specific first:
 *   the user's own override -> the prescription -> the equipment/name guess.
 *
 * The user wins over the coach here (unlike rest, where the bracket leads)
 * because this is not a programming variable: it is a fact about what is in
 * the lifter's hands, and the person holding it is the one who can see it.
 * A toggle the prescription could shadow would be a toggle that does nothing.
 */
export function resolveLoadEntry(input: LoadEntryInput): LoadEntry {
  return (
    input.override ??
    input.prescribed ??
    defaultLoadEntry(input.equipment, input.name)
  );
}

/**
 * Whether to offer the total/per-side control at all. Quiet by default: only
 * hand-held implements, anything a prescription or the user has already
 * called per-side, and any exercise carrying an explicit override.
 */
export function offersLoadEntry(input: LoadEntryInput): boolean {
  return (
    input.override !== undefined ||
    input.prescribed === "per_side" ||
    isPerSideEquipment(input.equipment)
  );
}

/** entered value -> the TOTAL that goes in `load_kg`. */
export function totalKg(enteredKg: number, entry: LoadEntry): number {
  return entry === "per_side" ? enteredKg * 2 : enteredKg;
}

/** stored total -> the value to show and type. */
export function enteredKg(totalLoadKg: number, entry: LoadEntry): number {
  return entry === "per_side" ? totalLoadKg / 2 : totalLoadKg;
}

/**
 * The `load_entry` to WRITE for a set. Never null for a new set, and never
 * 'per_side' on a zero load — the DB check refuses it, and half of nothing is
 * still nothing.
 */
export function loadEntryForSet(
  entry: LoadEntry,
  totalLoadKg: number,
): LoadEntry {
  return entry === "per_side" && totalLoadKg > 0 ? "per_side" : "total";
}

/** The user's stored choice for one exercise, if they have made one. */
export function getLoadEntryOverride(
  exerciseId: string | null,
): LoadEntry | undefined {
  return exerciseId === null
    ? undefined
    : getExercisePref(exerciseId).loadEntry;
}
