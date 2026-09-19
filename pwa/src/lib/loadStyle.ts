// Load-style resolution — which of the six load modes (see the spec's
// "Load modes" table) an exercise's plate/stack presentation uses.
// Orthogonal to lib/loadEntry.ts's per-side convention: that decides how a
// DUMBBELL/KETTLEBELL number is typed (one hand or the whole system); this
// decides whether a BARBELL or MACHINE/CABLE exercise shows a
// bar-and-plates calculator or a pin stack (nothing to calculate).
//
// `ExercisePref.barKg` (settings.ts) is reused as-is for BOTH styles: on a
// barbell it is the bar; on a plate-loaded machine it is the sled/carriage
// weight. Nothing new is added to `sets` or `load_kg` — this is
// presentation only, exactly like the per-side convention.

export type LoadStyle = "plates" | "stack";

/** free-exercise-db's own equipment strings for anything with a bar-and-
 *  plates OR a pin-stack concept: 'machine' and 'cable'. Everything else —
 *  barbell, dumbbell, kettlebell(s), body only, bands, and so on — never
 *  offers the toggle. Prefix match, matching lib/loadEntry.ts's own
 *  isPerSideEquipment: the seed also carries "kettlebells" (plural) and a
 *  custom exercise could type "cables". */
const MACHINE_LIKE_EQUIPMENT = ["machine", "cable"];

function isMachineLikeEquipment(
  equipment: string | null | undefined,
): boolean {
  if (equipment === null || equipment === undefined) return false;
  const e = equipment.toLowerCase();
  return MACHINE_LIKE_EQUIPMENT.some((k) => e.startsWith(k));
}

/**
 * Named plate-loaded machines. free-exercise-db and the curated seed both
 * tag these `equipment: "machine"` alongside genuinely pin-loaded machines
 * (Leg Extension, most Lat Pulldown variants' cousins, etc) — the name is
 * the only signal that distinguishes them. Leading boundary only, no
 * trailing one: "Narrow Stance Leg Press", "Hack Squats" (plural) and
 * "Smith Machine Bench Press" must all match, so the phrase's own end is
 * left open.
 */
const PLATE_MACHINE_NAME = /\b(leg press|hack squat|smith machine)/i;

/**
 * Whether this exercise offers the plates<->stack icon toggle at all.
 * False for a barbell (plates, but fixed — there is no stack version of a
 * bar) and false for anything hand-held or bodyweight, which have no
 * bar/pin concept to switch between in the first place.
 */
export function offersLoadStyle(
  equipment: string | null | undefined,
  _name: string,
): boolean {
  return isMachineLikeEquipment(equipment);
}

/**
 * The guess when nobody has asserted anything: a barbell is always plates.
 * A named plate-loaded machine (Leg Press, Hack Squat, Smith Machine *) is
 * plates with base 0, so first use asks for the real base weight. Every
 * other machine/cable exercise (Cable Row, Lat Pulldown, Leg Extension,
 * ...) is a pin stack, which is nothing for the calculator to compute.
 * Dumbbell, kettlebell, bodyweight, an unrecognised string and `null` all
 * return "stack" as an inert default: callers gate on
 * `offersLoadStyle`/`equipment === "barbell"` before ever reading this for
 * those, exactly as `defaultLoadEntry` is never consulted for a barbell.
 */
export function defaultLoadStyle(
  equipment: string | null | undefined,
  name: string,
): LoadStyle {
  const e = equipment?.toLowerCase() ?? null;
  if (e === "barbell") return "plates";
  if (isMachineLikeEquipment(equipment)) {
    return PLATE_MACHINE_NAME.test(name) ? "plates" : "stack";
  }
  return "stack";
}

/**
 * How this exercise's load is presented, most specific first: the user's
 * own device-local override, then the equipment/name guess. There is no
 * PRESCRIPTION-level assertion for load style, unlike load entry — the
 * coach writes reps and load, never a bar-vs-stack opinion — so this chain
 * is only two links long.
 */
export function resolveLoadStyle(
  override: LoadStyle | undefined,
  equipment: string | null | undefined,
  name: string,
): LoadStyle {
  return override ?? defaultLoadStyle(equipment, name);
}
