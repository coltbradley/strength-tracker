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
});
