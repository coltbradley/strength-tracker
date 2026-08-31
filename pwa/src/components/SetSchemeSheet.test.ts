import { describe, expect, it } from "vitest";
import { groupSets } from "./SetSchemeSheet";

const w = (loadKg: number, warmup = false) => ({ loadKg, warmup });

describe("groupSets", () => {
  it("collapses a straight scheme into one prescription", () => {
    expect(groupSets([w(100), w(100), w(100)], 5, 5, false)).toEqual([
      { sets: 3, reps_min: 5, reps_max: 5, load_kg: 100, set_type: "working" },
    ]);
  });

  it("keeps a ramp as one row per weight", () => {
    const out = groupSets([w(60), w(80), w(100), w(100)], 5, 5, false);
    expect(out.map((g) => [g.sets, g.load_kg])).toEqual([
      [1, 60],
      [1, 80],
      [2, 100],
    ]);
  });

  it("splits on set type even when the weight is identical", () => {
    // The classic "two easy sets at working weight, then the real ones".
    const out = groupSets([w(60, true), w(60, true), w(60)], 8, 8, false);
    expect(out).toEqual([
      { sets: 2, reps_min: 8, reps_max: 8, load_kg: 60, set_type: "warmup" },
      { sets: 1, reps_min: 8, reps_max: 8, load_kg: 60, set_type: "working" },
    ]);
  });

  it("by feel drops every load but keeps the warmup split", () => {
    const out = groupSets([w(60, true), w(80), w(90)], 5, 8, true);
    expect(out).toEqual([
      { sets: 1, reps_min: 5, reps_max: 8, load_kg: null, set_type: "warmup" },
      // 80 and 90 both become "no load", so they collapse — which is correct:
      // with no weight prescribed there is nothing left to tell them apart.
      { sets: 2, reps_min: 5, reps_max: 8, load_kg: null, set_type: "working" },
    ]);
  });

  it("never emits reps_max below reps_min", () => {
    expect(groupSets([w(50)], 8, 3, false)[0]).toMatchObject({
      reps_min: 8,
      reps_max: 8,
    });
  });

  it("non-consecutive repeats do not merge across a different weight", () => {
    const out = groupSets([w(100), w(60), w(100)], 5, 5, false);
    expect(out).toHaveLength(3);
  });

  it("an empty scheme writes nothing", () => {
    expect(groupSets([], 5, 5, false)).toEqual([]);
  });
});
