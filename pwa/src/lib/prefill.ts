// Pure prefill logic for the set-entry steppers.
// Fallback order (spec): prescription resolved load -> last logged set this
// session (same exercise) -> last session's actual for that exercise.

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

const DEFAULT_LOAD_KG = 20; // empty barbell
const DEFAULT_REPS = 8;

export function prefillSet(input: PrefillInput): PrefillResult {
  const { prescription, lastThisSession, lastSession } = input;

  const rxLoad = prescription
    ? (prescription.plate_load_kg ?? prescription.resolved_load_kg)
    : null;

  const loadKg =
    rxLoad ??
    lastThisSession?.load_kg ??
    lastSession?.load_kg ??
    DEFAULT_LOAD_KG;

  const reps =
    prescription?.reps_max ??
    lastThisSession?.reps ??
    lastSession?.reps ??
    DEFAULT_REPS;

  return { loadKg, reps };
}
