// Property / fuzz proof that the plate math "adds up" in the unit the lifter
// sees. See the header of plates.ts for the invariants.
import { describe, expect, it } from "vitest";
import { split, type PlateSplit } from "./plates";
import { formatPlate } from "./format";
import { plateText, plateVisuals } from "./loadPicture";
import { KG_PER_LB, lbToKg, toDisplay, type Unit } from "./units";

export const KG_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
export const LB_PLATES = [45, 35, 25, 10, 5, 2.5];
export const KG_BARS = [20, 15, 10];
export const LB_BARS = [45, 35, 15];

const inv = (list: number[], unit: Unit) =>
  unit === "lb" ? list.map(lbToKg) : list;
/** what the pad does to a typed value: kg to 2 decimals */
const typedKg = (v: number, unit: Unit) =>
  Math.round((unit === "lb" ? lbToKg(v) : v) * 100) / 100;
const num = (s: string) => Number(s);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface Violation {
  rule: string;
  input: string;
  got: string;
}

/** every invariant that can be checked on one split() result */
export function violations(
  targetKg: number,
  barKg: number,
  inventoryKg: number[],
  unit: Unit,
  realPlates: number[] | null,
): Violation[] {
  const out: Violation[] = [];
  const input = `target=${targetKg}kg bar=${barKg}kg unit=${unit} inv=[${inventoryKg.map((p) => formatPlate(p, unit))}]`;
  const r: PlateSplit = split(targetKg, barKg, inventoryKg, unit);
  const shown = toDisplay(targetKg, unit);
  const achieved = num(formatPlate(r.achievedKg, unit));
  const bar = num(formatPlate(barKg, unit));
  const perSide = r.plates.reduce(
    (a, p) => a + num(formatPlate(p.plate, unit)) * p.count,
    0,
  );
  // (a) bar + 2 x plates == the achieved total, exactly, in display units
  if (r2(bar + 2 * perSide) !== r2(achieved))
    out.push({ rule: "a", input, got: `${bar}+2x${perSide} != ${achieved}` });
  // (b) exact flag tells the truth about the SHOWN total; never over target
  const isExact = r2(achieved) === r2(shown);
  if (r.exact !== isExact)
    out.push({ rule: "b-flag", input, got: `exact=${r.exact} shown=${shown} achieved=${achieved}` });
  if (r.plates.length > 0 && achieved > shown + 1e-9)
    out.push({ rule: "b-over", input, got: `shown=${shown} achieved=${achieved}` });
  // (c) labels are real plates
  if (realPlates) {
    for (const p of r.plates) {
      const label = num(formatPlate(p.plate, unit));
      if (!realPlates.some((x) => Math.abs(x - label) < 1e-9))
        out.push({ rule: "c", input, got: `label ${formatPlate(p.plate, unit)}` });
    }
  }
  // text the UI renders agrees
  const text = plateText(r, barKg, unit);
  const labels = plateVisuals(r, unit).map((v) => v.label);
  if (r.plates.length && !text.startsWith(labels.join(" + ")))
    out.push({ rule: "text", input, got: text });
  if (!r.exact && !text.includes(`closest is ${formatPlate(r.achievedKg, unit)}`))
    out.push({ rule: "text-closest", input, got: text });
  return out;
}

function collect(vs: Violation[][]): Violation[] {
  return vs.flat();
}

describe("plate math adds up: full grids", () => {
  for (const unit of ["kg", "lb"] as const) {
    const plates = unit === "kg" ? KG_PLATES : LB_PLATES;
    const bars = unit === "kg" ? KG_BARS : LB_BARS;
    const step = unit === "kg" ? 2.5 : 5;
    const max = unit === "kg" ? 500 : 1100;
    for (const via of ["typed", "stepped"] as const) {
      it(`${unit}: every ${step}-grid load, bar to ${max}, every bar, ${via}`, () => {
        const bad: Violation[][] = [];
        for (const bar of [...bars, 0]) {
          for (let v = 0; v <= max; v += step) {
            const kg = via === "typed" ? typedKg(v, unit) : unit === "lb" ? lbToKg(v) : v;
            const barKg = unit === "lb" ? lbToKg(bar) : bar;
            bad.push(violations(kg, barKg, inv(plates, unit), unit, plates));
          }
        }
        const all = collect(bad);
        expect(all.slice(0, 5)).toEqual([]);
      });
    }
    it(`${unit}: odd typed values (0.1 grid) with a 2dp-kg bar`, () => {
      const bad: Violation[][] = [];
      for (let v = 0; v <= 450; v += 0.1) {
        const val = Math.round(v * 10) / 10;
        bad.push(
          violations(typedKg(val, unit), typedKg(bars[0], unit), inv(plates, unit), unit, plates),
        );
      }
      expect(collect(bad).slice(0, 5)).toEqual([]);
    });
  }
});

describe("what the pad can type: every 0.01 of a unit", () => {
  for (const unit of ["kg", "lb"] as const) {
    it(`${unit}: the exact flag always agrees with the total shown`, () => {
      const plates = unit === "kg" ? KG_PLATES : LB_PLATES;
      const bar = unit === "kg" ? 20 : lbToKg(45);
      const bad: Violation[][] = [];
      for (let c = 4000; c <= 30000; c++) {
        bad.push(violations(typedKg(c / 100, unit), bar, inv(plates, unit), unit, plates));
      }
      expect(collect(bad).slice(0, 5)).toEqual([]);
    });
  }
});

describe("exactness: every buildable load is reported exact", () => {
  it("lb: any 5 lb multiple >= bar is exact with the default set, via typed kg", () => {
    for (let v = 45; v <= 1000; v += 5) {
      const r = split(typedKg(v, "lb"), lbToKg(45), inv(LB_PLATES, "lb"), "lb");
      expect(r.exact, `${v} lb`).toBe(true);
      expect(num(formatPlate(r.achievedKg, "lb")), `${v} lb`).toBe(v);
    }
  });
  it("kg: any 2.5 multiple >= bar is exact with the default set", () => {
    for (let v = 20; v <= 500; v += 2.5) {
      const r = split(v, 20, KG_PLATES, "kg");
      expect(r.exact, `${v}`).toBe(true);
    }
  });
});

describe("fewest plates, and the best achievable total", () => {
  it("matches an exhaustive search on odd inventories", () => {
    const invs = [[25, 20, 15], [20, 15, 10, 5], [25, 10], [45, 25, 10, 5, 2.5], [1.25], [20, 15, 10, 2.5]];
    for (const unit of ["kg", "lb"] as const) {
      for (const list of invs) {
        for (let want = 0; want <= 200; want += 2.5) {
          // brute force best <= want then fewest plates
          const cents = list.map((p) => Math.round(p * 100));
          const W = Math.round(want * 100);
          const best = new Array<number>(W + 1).fill(Infinity);
          best[0] = 0;
          for (let s = 1; s <= W; s++)
            for (const c of cents) if (s >= c && best[s - c] + 1 < best[s]) best[s] = best[s - c] + 1;
          let target = W;
          while (best[target] === Infinity) target--;
          const bar = unit === "lb" ? 45 : 20;
          const total = r2(bar + 2 * want);
          const kgTarget = unit === "lb" ? lbToKg(total) : total;
          const r = split(kgTarget, unit === "lb" ? lbToKg(bar) : bar, inv(list, unit), unit);
          const count = r.plates.reduce((a, p) => a + p.count, 0);
          expect(count, `${unit} ${list} want ${want}`).toBe(target === 0 ? 0 : best[target]);
          const side = r.plates.reduce((a, p) => a + num(formatPlate(p.plate, unit)) * p.count, 0);
          expect(r2(side), `${unit} ${list} want ${want}`).toBe(target / 100);
        }
      }
    }
  });
});

describe("custom inventories", () => {
  it("missing plates, extra 1.25s, lb-equivalent kg plates", () => {
    const cases: [Unit, number[], number[]][] = [
      ["kg", [20, 10, 5, 2.5, 1.25], KG_BARS],
      ["kg", [25, 20, 15, 10, 5, 2.5, 1.25, 0.5], KG_BARS],
      ["lb", [45, 25, 10, 5, 2.5, 1.25], LB_BARS],
      ["lb", [45, 10, 5], LB_BARS],
      // kg gym with lb plates labelled in kg: real kg values 20.41 etc
      ["kg", [20.41, 15.88, 11.34, 4.54, 2.27, 1.13], [20.41]],
    ];
    for (const [unit, plates, bars] of cases) {
      const bad: Violation[][] = [];
      for (const bar of bars) {
        const barKg = unit === "lb" ? lbToKg(bar) : bar;
        for (let t = 0; t <= (unit === "lb" ? 700 : 300); t += unit === "lb" ? 2.5 : 1.25) {
          bad.push(violations(typedKg(t, unit), barKg, inv(plates, unit), unit, null));
        }
      }
      expect(collect(bad).slice(0, 5), `${unit} ${plates}`).toEqual([]);
    }
  });
});

describe("base weights: sleds, bars, zero", () => {
  it("honours 34 kg / 75 lb / 0 in either unit", () => {
    const kgSled = split(34 + 2 * 25, 34, KG_PLATES, "kg");
    expect(kgSled.exact).toBe(true);
    expect(kgSled.plates).toEqual([{ plate: 25, count: 1 }]);
    // 75 lb sled, typed in lb (stored rounded to 2dp kg = 34.02)
    const lbSled = split(typedKg(75 + 2 * 45, "lb"), typedKg(75, "lb"), inv(LB_PLATES, "lb"), "lb");
    expect(lbSled.exact).toBe(true);
    expect(num(formatPlate(lbSled.achievedKg, "lb"))).toBe(165);
    // zero base
    const none = split(typedKg(90, "lb"), 0, inv(LB_PLATES, "lb"), "lb");
    expect(none.exact).toBe(true);
    expect(none.plates).toEqual([{ plate: lbToKg(45), count: 1 }]);
    // sled alone equals target
    expect(split(typedKg(75, "lb"), typedKg(75, "lb"), inv(LB_PLATES, "lb"), "lb").exact).toBe(true);
    expect(split(typedKg(45, "lb"), lbToKg(45), inv(LB_PLATES, "lb"), "lb").exact).toBe(true);
  });
  it("a 20 kg bar loaded while the display is lb is not mislabelled", () => {
    // 20 kg = 44.09 lb: honest, not "45"
    const r = split(lbToKg(135), 20, inv(LB_PLATES, "lb"), "lb");
    expect(formatPlate(20, "lb")).toBe("44.09");
    expect(violations(lbToKg(135), 20, inv(LB_PLATES, "lb"), "lb", LB_PLATES)).toEqual([]);
    expect(r.exact).toBe(false); // 44.09 + 2x45 = 134.09, and it says so
  });
});

describe("stability across unit switches", () => {
  it("a lb value typed, stored in kg, and read back in lb is the same plates", () => {
    for (let v = 45; v <= 700; v += 5) {
      const kg = typedKg(v, "lb");
      const a = split(kg, lbToKg(45), inv(LB_PLATES, "lb"), "lb");
      const b = split(lbToKg(v), lbToKg(45), inv(LB_PLATES, "lb"), "lb");
      expect(a.plates.map((p) => [formatPlate(p.plate, "lb"), p.count])).toEqual(
        b.plates.map((p) => [formatPlate(p.plate, "lb"), p.count]),
      );
      expect(a.exact).toBe(b.exact);
    }
  });
  it("a kg prescription shown in lb: total shown is the achieved total or says closest", () => {
    for (let kg = 20; kg <= 300; kg += 2.5) {
      const r = split(kg, lbToKg(45), inv(LB_PLATES, "lb"), "lb");
      const shown = toDisplay(kg, "lb");
      const ach = num(formatPlate(r.achievedKg, "lb"));
      if (r.exact) expect(ach).toBe(shown);
      else if (r.plates.length > 0) expect(ach).toBeLessThanOrEqual(shown);
      else expect(ach).toBe(num(formatPlate(lbToKg(45), "lb"))); // below the bar: the bar is what is on it
    }
    expect(KG_PER_LB).toBeGreaterThan(0);
  });
  it("kg -> lb -> kg: re-splitting the achieved total is a fixed point", () => {
    for (const unit of ["kg", "lb"] as const) {
      const plates = inv(unit === "kg" ? KG_PLATES : LB_PLATES, unit);
      const bar = unit === "kg" ? 20 : lbToKg(45);
      for (let t = 20; t <= 400; t += 0.7) {
        const first = split(t, bar, plates, unit);
        const second = split(first.achievedKg, bar, plates, unit);
        expect(second.exact, `${unit} ${t}`).toBe(true);
        expect(formatPlate(second.achievedKg, unit)).toBe(formatPlate(first.achievedKg, unit));
      }
    }
  });
});
