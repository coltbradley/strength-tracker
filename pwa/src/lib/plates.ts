// Plate math. Inputs and outputs are kg (the storage unit); the ARITHMETIC is
// done in integers on the display unit's own grid.
//
// DESIGN (2026-10, "the plate math doesn't always add up"). "Adds up" means,
// in the unit the lifter is looking at:
//   (a) bar + 2 x sum(plates per side) == the total shown, exactly;
//   (b) when the target cannot be built, `exact` is false and the achieved
//       total (never the target) is what the screen reports;
//   (c) every plate label is a real plate in that unit (45, not 44.99);
//   (d) the stack uses the fewest plates, and the heaviest on ties;
//   (e) the base weight (bar, sled, machine, 0) is honoured in that unit;
//   (g) kg -> lb -> kg and typed-in-lb vs stepped-from-kg agree.
// The old code did float kg arithmetic against a tolerance (EPS = 0.01 kg,
// widened once for the 135 lb -> 130 lb bug). A tolerance is a bet that every
// error is smaller than the smallest real difference; 0.01 kg is 0.022 lb, so
// it called 97.51 kg "exact" for 97.5 kg and refused 40.02 kg (shown "40") as
// inexact, i.e. the flag disagreed with the number on screen. There is no
// tolerance now: every kg value is converted ONCE into centi-units of the
// display unit (centi-lb or centi-kg), integers from then on. Exactness is
// integer equality with the total the lifter SEES (toDisplay, 1 decimal),
// the achieved total is the integer sum, and labels come from the same grid.
//
// lb plates and bars are stored as 2-decimal kg (45 lb = 20.41 kg). That can
// be up to 0.011 lb off, so in lb a value within 0.012 lb of a quarter-pound
// is snapped to it — absorbing storage error, never a real plate (the
// smallest real lb difference is 0.25).
//
// The per-side stack is chosen by a small unbounded-coin-change DP, not a
// greedy loop: greedy-from-heaviest is optimal on the standard sets, but on a
// custom set (25/20/15 and a 30 kg side) it gives up where 15 + 15 builds it.
// The DP finds the heaviest achievable per-side weight <= wanted, with the
// fewest plates, ties broken heaviest-first, so on every standard set it is
// exactly what greedy returns. Plates go on in pairs; the remainder rounds
// DOWN. Unbounded targets fall back to a plate-capped greedy so it always
// terminates.

import { KG_PER_LB, type Unit } from "./units";
import { convertedLoadValue } from "./displayLoad";

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

// Lb values stored as 2-decimal kg can sit up to ~0.011 lb off the plate they
// mean; anything within this of a quarter-pound IS that quarter-pound.
const LB_SNAP = 0.012;

/**
 * kg -> the value a lifter reads in `unit`, to 0.01: the real plate, not its
 * storage error (20.41 kg is "45", never "44.99"). Shared with formatPlate.
 */
export function plateDisplayValue(kg: number, unit: Unit): number {
  if (unit === "kg") return Math.round(kg * 100) / 100;
  const lb = kg / KG_PER_LB;
  const q = Math.round(lb * 4) / 4;
  return Math.abs(lb - q) < LB_SNAP ? q : Math.round(lb * 100) / 100;
}

const centi = (kg: number, unit: Unit) =>
  Math.round(plateDisplayValue(kg, unit) * 100);
const fromCenti = (c: number, unit: Unit) =>
  unit === "kg" ? c / 100 : (c / 100) * KG_PER_LB;

/** The unit a (bar, inventory) pair was written in, when the caller did not
 *  say: lb iff every non-zero value is a quarter-pound and not every one is a
 *  quarter-kilo (2.5 kg alone is 5.51 lb, so one value cannot decide). */
function inferUnit(values: number[]): Unit {
  const v = values.filter((x) => Number.isFinite(x) && x > 0);
  if (v.length === 0) return "kg";
  const fits = (x: number, per: number) => {
    const u = x / per;
    return Math.abs(u - Math.round(u * 4) / 4) < LB_SNAP;
  };
  return v.every((x) => fits(x, KG_PER_LB)) && !v.every((x) => fits(x, 1))
    ? "lb"
    : "kg";
}

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

/** Largest table the DP will build (per-side units of the plates' gcd). */
const MAX_DP_UNITS = 50_000;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function split(
  targetKg: number,
  barKg: number,
  inventoryKg: number[],
  unit?: Unit,
): PlateSplit {
  const plateList = inventoryKg.filter((p) => Number.isFinite(p) && p > 0);
  const u: Unit = unit ?? inferUnit([barKg, ...plateList]);

  // Distinct real plates, heaviest first, on the display grid.
  const byCenti = new Map<number, number>();
  for (const kg of plateList) {
    const c = centi(kg, u);
    if (c > 0 && !byCenti.has(c)) byCenti.set(c, kg);
  }
  const inv = [...byCenti.keys()].sort((a, b) => b - a);

  const finite = Number.isFinite(targetKg) && Number.isFinite(barKg);
  const barC = Number.isFinite(barKg) ? Math.max(0, centi(barKg, u)) : 0;
  // the total the lifter is shown, on the same 0.01 grid
  const targetC = finite ? Math.round(convertedLoadValue(targetKg, u) * 100) : NaN;
  const wantedSide = finite ? Math.floor((targetC - barC) / 2) : 0;

  const counts = new Map<number, number>();
  let sideC = 0;
  if (wantedSide > 0 && inv.length > 0) {
    const g = inv.reduce((a, b) => gcd(a, b));
    const units = Math.floor(wantedSide / g);
    if (units <= MAX_DP_UNITS) {
      const INF = Number.MAX_SAFE_INTEGER;
      const cost = new Array<number>(units + 1).fill(INF);
      cost[0] = 0;
      for (let s = 1; s <= units; s++)
        for (const p of inv) {
          const pu = p / g;
          if (pu <= s && cost[s - pu] + 1 < cost[s]) cost[s] = cost[s - pu] + 1;
        }
      let best = units;
      while (best > 0 && cost[best] > MAX_PLATES_PER_SIDE) best--;
      let s = best;
      while (s > 0) {
        const p = inv.find((q) => q / g <= s && cost[s - q / g] === cost[s] - 1)!;
        counts.set(p, (counts.get(p) ?? 0) + 1);
        s -= p / g;
      }
      sideC = best * g;
    } else {
      let remaining = wantedSide;
      let loaded = 0;
      for (const p of inv) {
        while (remaining >= p && loaded < MAX_PLATES_PER_SIDE) {
          remaining -= p;
          loaded++;
          counts.set(p, (counts.get(p) ?? 0) + 1);
          sideC += p;
        }
      }
    }
  }

  const plates: PlateCount[] = inv
    .filter((p) => counts.has(p))
    .map((p) => ({ plate: byCenti.get(p)!, count: counts.get(p)! }));
  const achievedC = barC + 2 * sideC;
  return {
    plates,
    perSideKg: fromCenti(sideC, u),
    exact: finite && achievedC === targetC,
    achievedKg: fromCenti(achievedC, u),
  };
}
