// Pure prefill logic for the set-entry steppers.
// Fallback order (spec): prescription resolved load -> last logged set this
// session (same exercise) -> last session's actual for that exercise.
//
// The last-resort fallback (an empty bar, 8 reps) is a SETTING, and this is
// the one place it is read. Session.tsx must seed its steppers from
// `getPrefillFallback()` rather than repeating the literals.

import { getSetting, getUnit } from "./settings";

export interface PrefillPrescription {
  resolved_load_kg: number | null;
  plate_load_kg: number | null;
  reps_min: number;
  reps_max: number;
}

export interface PrefillActual {
  load_kg: number;
  reps: number;
  /** How the earlier set was typed, when recorded. */
  load_entry?: "total" | "per_side" | null;
  entered_load?: number | null;
  entered_unit?: "kg" | "lb" | null;
}

export interface PrefillInput {
  prescription: PrefillPrescription | null;
  lastThisSession: PrefillActual | null;
  lastSession: PrefillActual | null;
}

export interface PrefillResult {
  loadKg: number;
  reps: number;
  /** Set only when the load came from an EARLIER SET that recorded what was
   *  typed: the number, unit and convention to hand back unchanged. */
  entered?: { load: number; unit: "kg" | "lb"; entry: "total" | "per_side" };
  /** Where the load came from, so a staged number that crossed units can say
   *  "plan 100 kg" or "last 145 lb" beside itself. */
  source?: "plan" | "last" | "default";
}

/** Last-resort values when a movement has no prescription and no history.
 *  The load is per display unit — 20 kg in kg mode, 45 lb in lb mode — so the
 *  suggestion is a bar someone recognises rather than a conversion of one. */
export function getPrefillFallback(): PrefillResult {
  return {
    loadKg: getSetting("fallbackLoad")[getUnit()],
    reps: getSetting("fallbackReps"),
    source: "default",
  };
}

export function prefillSet(
  input: PrefillInput,
  fallback: PrefillResult = getPrefillFallback(),
): PrefillResult {
  const { prescription, lastThisSession, lastSession } = input;

  const rxLoad = prescription
    ? (prescription.plate_load_kg ?? prescription.resolved_load_kg)
    : null;

  const loadKg =
    rxLoad ??
    lastThisSession?.load_kg ??
    lastSession?.load_kg ??
    fallback.loadKg;
  const source =
    rxLoad !== null ? null : (lastThisSession ?? lastSession ?? null);
  const entered =
    source !== null &&
    source.entered_load != null &&
    source.entered_unit != null &&
    source.load_entry != null
      ? {
          load: source.entered_load,
          unit: source.entered_unit,
          entry: source.load_entry,
        }
      : undefined;

  const reps =
    prescription?.reps_max ??
    lastThisSession?.reps ??
    lastSession?.reps ??
    fallback.reps;

  const from: PrefillResult["source"] =
    rxLoad !== null
      ? "plan"
      : lastThisSession?.load_kg != null || lastSession?.load_kg != null
        ? "last"
        : "default";
  return entered
    ? { loadKg, reps, entered, source: from }
    : { loadKg, reps, source: from };
}
