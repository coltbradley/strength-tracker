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
}

export interface PrefillInput {
  prescription: PrefillPrescription | null;
  lastThisSession: PrefillActual | null;
  lastSession: PrefillActual | null;
}

export interface PrefillResult {
  loadKg: number;
  reps: number;
}

/** Last-resort values when a movement has no prescription and no history.
 *  The load is per display unit — 20 kg in kg mode, 45 lb in lb mode — so the
 *  suggestion is a bar someone recognises rather than a conversion of one. */
export function getPrefillFallback(): PrefillResult {
  return {
    loadKg: getSetting("fallbackLoad")[getUnit()],
    reps: getSetting("fallbackReps"),
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

  const reps =
    prescription?.reps_max ??
    lastThisSession?.reps ??
    lastSession?.reps ??
    fallback.reps;

  return { loadKg, reps };
}
