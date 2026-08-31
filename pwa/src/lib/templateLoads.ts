// Deciding what a template's weights become when it is applied to a new day.
//
// The rule the user asked for is "use the last numbers I actually used, not
// the ones the template was saved with". Applied naively — overwrite every
// row's load with the last actual — it destroys ramps: a squat template of
// 60 / 85 / 112.5 becomes 110 / 110 / 110, three identical sets where a
// warmup build-up used to be.
//
// So the unit of refresh is the RAMP, not the row. Consecutive prescriptions
// naming the same exercise are one ramp (CLAUDE.md), and a ramp is rescaled
// proportionally: whatever the top set becomes, the rest keep their shape
// relative to it. 60 / 85 / 112.5 against a last actual of 110 becomes
// 58.7 / 83.1 / 110.

export interface LoadRow {
  exercise_id: string;
  load_kg: number | null;
  load_pct_tm: number | null;
  set_type: string;
}

/** Prescription loads are held to the half-kilo; anything finer is invented. */
function round(kg: number): number {
  return Math.round(kg * 2) / 2;
}

/**
 * New loads for a template's rows, in order. `null` in the result means "leave
 * this row exactly as it is".
 *
 * Left alone on purpose:
 *  - %TM rows. They are already relative to a training max that moves on its
 *    own; replacing one with an absolute number severs that link silently.
 *  - Rows with no load (bodyweight, "by feel"). There is nothing to scale.
 *  - Every row of a ramp whose exercise has never been logged. Without a last
 *    actual there is no basis for a new number, and the saved one is the best
 *    guess available.
 */
export function refreshedLoads(
  rows: LoadRow[],
  lastActuals: Record<string, { load_kg: number }>,
): (number | null)[] {
  const out: (number | null)[] = new Array(rows.length).fill(null);

  let i = 0;
  while (i < rows.length) {
    // the extent of this ramp: consecutive rows naming the same exercise
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.exercise_id === rows[i]!.exercise_id)
      j += 1;

    const group = rows.slice(i, j + 1);
    const last = lastActuals[rows[i]!.exercise_id];
    // Only absolute-load rows take part; a %TM row inside a ramp keeps its
    // percentage and is excluded from the scale entirely.
    const scalable = group.filter(
      (r) => r.load_pct_tm === null && r.load_kg !== null && r.load_kg > 0,
    );
    const top = Math.max(...scalable.map((r) => r.load_kg ?? 0), 0);

    if (last !== undefined && last.load_kg > 0 && top > 0) {
      const factor = last.load_kg / top;
      for (let k = i; k <= j; k++) {
        const r = rows[k]!;
        if (r.load_pct_tm !== null || r.load_kg === null || r.load_kg <= 0)
          continue;
        // The top set lands exactly on the last actual rather than on a
        // rounded product of it — that number was really lifted and should
        // come back unchanged.
        out[k] = r.load_kg === top ? last.load_kg : round(r.load_kg * factor);
      }
    }
    i = j + 1;
  }
  return out;
}

/** How many rows the refresh actually changed, for an honest confirmation. */
export function countRefreshed(next: (number | null)[]): number {
  return next.filter((v) => v !== null).length;
}
