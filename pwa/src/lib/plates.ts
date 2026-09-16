// Plate math. Pure, kg-in kg-out; display conversion happens at the edge.
//
// split() builds a per-side plate stack for a target load: greedy from the
// heaviest plate, plates loaded in pairs (the inventory lists one side's
// plates), remainder rounded DOWN — the gym answer to "what do I put on".

export interface PlateCount {
  /** plate weight in kg (one plate; it goes on both sides) */
  plate: number;
  /** count per side */
  count: number;
}

export interface PlateSplit {
  plates: PlateCount[];
  /** total plate weight per side, kg */
  perSideKg: number;
  /** achievedKg equals targetKg (within tolerance) */
  exact: boolean;
  /** bar + both sides actually loaded, kg */
  achievedKg: number;
}

// Inventory values may be exact-kg lb equivalents (45 lb = 20.41185665 kg),
// so all comparisons carry a small tolerance.
// Widened from 1e-6 (2026-09-16 postmortem): the caller rounds a typed
// value to 2 decimal PLACES OF KG before it ever reaches split()
// (Session.tsx's pad commit handlers), so a target here already carries up
// to +/-0.005 kg of rounding slop. 1e-6 was tighter than that slop, so the
// greedy loop below refused a plate that the rounded target could not
// quite reach byte-for-byte, and 135 lb (61.235089 kg, rounded to 61.24)
// came back as 130 lb. 0.01 kg absorbs the rounding without ever calling a
// genuinely unbuildable target "exact" — see the regression table in
// plates.test.ts.
const EPS = 0.01;

/**
 * Hard ceiling on plates loaded per side, so the greedy loop is bounded no
 * matter what it is handed. It is not a gym rule — 200 of the smallest real
 * plate (1.25 kg) is 250 kg a side, past any bar's rating — it is a guard.
 *
 * Without it the `while` below runs on a value it never validated: a
 * non-finite target loops FOREVER (Infinity minus a plate is still Infinity,
 * so the condition can never go false), and a merely huge one — 1e15 kg, or
 * a 0.000001 kg plate typed into the inventory — runs long enough to be
 * indistinguishable from a hang. This is the UI thread, mid-workout, with no
 * error and no way back but killing the app. Hitting the cap is reported
 * honestly: `exact` goes false, exactly as it does for any load the plates
 * on hand cannot make.
 */
const MAX_PLATES_PER_SIDE = 200;

export function split(
  targetKg: number,
  barKg: number,
  inventoryKg: number[],
): PlateSplit {
  const inv = [...inventoryKg]
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => b - a);
  // A non-finite target or bar has no plate answer; NaN already fell through
  // the `> EPS` test below, and Infinity would spin forever on it.
  const wantedPerSide =
    Number.isFinite(targetKg) && Number.isFinite(barKg)
      ? (targetKg - barKg) / 2
      : NaN;

  const plates: PlateCount[] = [];
  let perSideKg = 0;

  if (wantedPerSide > EPS) {
    let remaining = wantedPerSide;
    let loaded = 0;
    for (const p of inv) {
      let count = 0;
      while (remaining >= p - EPS && loaded < MAX_PLATES_PER_SIDE) {
        remaining -= p;
        count++;
        loaded++;
      }
      if (count > 0) {
        plates.push({ plate: p, count });
        perSideKg += p * count;
      }
    }
  }

  const achievedKg = barKg + perSideKg * 2;
  return {
    plates,
    perSideKg,
    exact: Math.abs(achievedKg - targetKg) < 0.01,
    achievedKg,
  };
}
