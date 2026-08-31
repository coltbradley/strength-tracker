import { describe, expect, it } from "vitest";
import { groupSets, snapToUnit } from "./SetSchemeSheet";

const w = (loadKg: number, warmup = false) => ({ loadKg, warmup });
const REST = 120;

describe("groupSets", () => {
  it("collapses a straight scheme into one prescription", () => {
    expect(groupSets([w(100), w(100), w(100)], 5, false, REST)).toEqual([
      {
        sets: 3,
        reps_min: 5,
        reps_max: 5,
        load_kg: 100,
        set_type: "working",
        rest_seconds: 120,
      },
    ]);
  });

  it("writes one rep number, never a range", () => {
    const [g] = groupSets([w(100)], 5, false, REST);
    expect(g!.reps_min).toBe(g!.reps_max);
  });

  it("keeps a ramp as one row per weight", () => {
    const out = groupSets([w(60), w(80), w(100), w(100)], 5, false, REST);
    expect(out.map((g) => [g.sets, g.load_kg])).toEqual([
      [1, 60],
      [1, 80],
      [2, 100],
    ]);
  });

  it("splits on set type even when the weight is identical", () => {
    // The classic "two easy sets at working weight, then the real ones".
    const out = groupSets([w(60, true), w(60, true), w(60)], 8, false, REST);
    expect(out.map((g) => [g.sets, g.set_type])).toEqual([
      [2, "warmup"],
      [1, "working"],
    ]);
  });

  it("by feel drops every load but keeps the warmup split", () => {
    const out = groupSets([w(60, true), w(80), w(90)], 5, true, REST);
    expect(out.map((g) => [g.sets, g.load_kg, g.set_type])).toEqual([
      [1, null, "warmup"],
      // 80 and 90 both become "no load", so they collapse — which is correct:
      // with no weight prescribed there is nothing left to tell them apart.
      [2, null, "working"],
    ]);
  });

  it("carries the chosen rest onto every group", () => {
    const out = groupSets([w(60, true), w(100)], 5, false, 45);
    expect(out.every((g) => g.rest_seconds === 45)).toBe(true);
  });

  it("zero rest is a real prescription, not a missing one", () => {
    expect(groupSets([w(60)], 12, false, 0)[0]!.rest_seconds).toBe(0);
  });

  it("non-consecutive repeats do not merge across a different weight", () => {
    expect(groupSets([w(100), w(60), w(100)], 5, false, REST)).toHaveLength(3);
  });

  it("an empty scheme writes nothing", () => {
    expect(groupSets([], 5, false, REST)).toEqual([]);
  });
});

describe("snapToUnit", () => {
  it("leaves a clean kg default alone", () => {
    // 20 kg is already a multiple of the 2.5 kg step.
    expect(snapToUnit(20, "kg")).toBe(20);
  });

  it("turns the kg default into a round number of pounds", () => {
    // 20 kg is 44.09 lb, which nobody has ever loaded. The lb step is 5 lb,
    // so this must land on a whole multiple of 5 lb.
    const kg = snapToUnit(20, "lb");
    const lb = kg / 0.45359237;
    expect(Math.abs(lb - Math.round(lb / 5) * 5)).toBeLessThan(0.01);
    expect(Math.round(lb)).toBe(45);
  });

  it("never snaps to zero", () => {
    expect(snapToUnit(0.1, "kg")).toBeGreaterThan(0);
    expect(snapToUnit(0, "lb")).toBeGreaterThan(0);
  });
});
