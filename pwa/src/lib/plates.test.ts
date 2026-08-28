import { describe, expect, it } from "vitest";
import { split } from "./plates";
import { lbToKg } from "./units";

const KG_INV = [25, 20, 15, 10, 5, 2.5, 1.25];

describe("plates split", () => {
  it("builds an exact stack greedily from the heaviest plate", () => {
    // 100 kg on a 20 kg bar -> 40 kg per side -> 25 + 15
    const r = split(100, 20, KG_INV);
    expect(r.plates).toEqual([
      { plate: 25, count: 1 },
      { plate: 15, count: 1 },
    ]);
    expect(r.perSideKg).toBe(40);
    expect(r.achievedKg).toBe(100);
    expect(r.exact).toBe(true);
  });

  it("rounds down when the target is not buildable", () => {
    // 101 kg on a 20 kg bar -> 40.5/side; smallest plate 1.25 -> best 40.0
    const r = split(101, 20, KG_INV);
    expect(r.perSideKg).toBe(40);
    expect(r.achievedKg).toBe(100);
    expect(r.exact).toBe(false);
  });

  it("handles bar-only targets", () => {
    const r = split(20, 20, KG_INV);
    expect(r.plates).toEqual([]);
    expect(r.perSideKg).toBe(0);
    expect(r.achievedKg).toBe(20);
    expect(r.exact).toBe(true);
    // target below the bar: nothing to load, not exact
    const under = split(15, 20, KG_INV);
    expect(under.plates).toEqual([]);
    expect(under.exact).toBe(false);
  });

  it("machine mode (barKg = 0) splits the whole target across two sides", () => {
    const r = split(50, 0, KG_INV);
    expect(r.perSideKg).toBe(25);
    expect(r.plates).toEqual([{ plate: 25, count: 1 }]);
    expect(r.achievedKg).toBe(50);
    expect(r.exact).toBe(true);
  });

  it("empty inventory yields a bar-only result", () => {
    const r = split(100, 20, []);
    expect(r.plates).toEqual([]);
    expect(r.achievedKg).toBe(20);
    expect(r.exact).toBe(false);
  });

  it("works with exact-kg lb-plate equivalents (tolerance)", () => {
    // 225 lb on a 45 lb bar with 45 lb plates = 2 plates per side, exact
    const inv = [45, 35, 25, 10, 5, 2.5].map(lbToKg);
    const r = split(lbToKg(225), lbToKg(45), inv);
    expect(r.plates).toEqual([{ plate: lbToKg(45), count: 2 }]);
    expect(r.exact).toBe(true);
  });

  // The greedy loop subtracts a plate until it cannot. Every input below used
  // to make that loop unable to stop — Infinity minus a plate is Infinity, and
  // a 1e-6 kg plate needs 1e8 passes to clear 90 kg. On the UI thread that is
  // a dead app mid-workout, with no error to report. Each must now return.
  describe("always terminates", () => {
    const INV = [25, 20, 15, 10, 5, 2.5, 1.25];
    const cases: [string, number, number, number[]][] = [
      ["infinite target", Infinity, 20, INV],
      ["infinite bar", 100, -Infinity, INV],
      ["huge finite target", 1e15, 20, INV],
      ["NaN target", NaN, 20, INV],
      ["NaN bar", 100, NaN, INV],
      ["infinitesimal plate", 200, 20, [0.000001]],
      ["non-finite plate in inventory", 100, 20, [Infinity, NaN, 20]],
    ];

    for (const [name, target, bar, inv] of cases) {
      it(name, () => {
        const started = Date.now();
        const r = split(target, bar, inv);
        expect(Date.now() - started).toBeLessThan(250);
        expect(Number.isFinite(r.perSideKg)).toBe(true);
        // whatever it returns, the stack it reports is the stack it counted
        const summed = r.plates.reduce((a, x) => a + x.plate * x.count, 0);
        expect(summed).toBeCloseTo(r.perSideKg, 9);
      });
    }

    it("a non-finite target is answered with no plates, not a guess", () => {
      const r = split(Infinity, 20, INV);
      expect(r.plates).toEqual([]);
      expect(r.perSideKg).toBe(0);
      expect(r.exact).toBe(false);
    });

    it("reports exact:false when the plate cap stops it short", () => {
      const r = split(200, 20, [0.000001]);
      expect(r.exact).toBe(false);
      expect(r.achievedKg).toBeLessThan(200);
    });
  });

  it("never loads more than the target asks for", () => {
    const INV = [25, 20, 15, 10, 5, 2.5, 1.25];
    for (let target = 20; target <= 300; target += 0.25) {
      for (const bar of [20, 15, 10, lbToKg(45)]) {
        const r = split(target, bar, INV);
        if (r.plates.length > 0)
          expect(r.achievedKg).toBeLessThanOrEqual(target + 1e-9);
      }
    }
  });
});
