import { describe, expect, it } from "vitest";
import {
  dumbbellLook,
  dumbbellText,
  plateClass,
  plateText,
  plateVisuals,
} from "./loadPicture";
import type { PlateSplit } from "./plates";
import { lbToKg } from "./units";

function split(
  plates: Array<[number, number]>,
  overrides: Partial<PlateSplit> = {},
): PlateSplit {
  return {
    plates: plates.map(([plate, count]) => ({ plate, count })),
    perSideKg: plates.reduce((sum, [p, c]) => sum + p * c, 0),
    exact: true,
    achievedKg: 0,
    ...overrides,
  };
}

describe("plateClass", () => {
  it("maps kg plates onto the competition colours", () => {
    expect(
      [25, 20, 15, 10, 5, 2.5, 1.25].map((p) => plateClass(p, "kg")),
    ).toEqual(["25", "20", "15", "10", "5", "2h", "1h"]);
  });

  it("files anything lighter than the smallest kg plate with the smallest class", () => {
    expect(plateClass(0.5, "kg")).toBe("1h");
  });

  it("maps lb plates onto the kg plate they stand in for", () => {
    expect(
      [45, 35, 25, 10, 5, 2.5].map((p) => plateClass(lbToKg(p), "lb")),
    ).toEqual(["20", "15", "10", "5", "2h", "1h"]);
  });

  it("puts a 10 lb plate in the 5 class, not with the 2.5s", () => {
    expect(plateClass(lbToKg(10), "lb")).toBe("5");
    // the raw-kg view of the same plate would be 4.5 kg, i.e. "2h"
    expect(plateClass(lbToKg(10), "kg")).toBe("2h");
  });

  it("uses the heavier class for a plate between two lb classes' floors", () => {
    expect(plateClass(lbToKg(55), "lb")).toBe("20");
    expect(plateClass(lbToKg(30), "lb")).toBe("10");
  });
});

describe("plateVisuals", () => {
  it("lists one entry per plate, heaviest first, with size growing with weight", () => {
    const visuals = plateVisuals(
      split([[25, 1], [10, 2], [2.5, 1]]),
      "kg",
    );

    expect(visuals.map((v) => v.cls)).toEqual(["25", "10", "10", "2h"]);
    expect(visuals.map((v) => v.label)).toEqual(["25", "10", "10", "2.5"]);
    for (let i = 1; i < visuals.length; i += 1) {
      expect(visuals[i]!.height).toBeLessThanOrEqual(visuals[i - 1]!.height);
      expect(visuals[i]!.width).toBeLessThanOrEqual(visuals[i - 1]!.width);
    }
  });

  it("labels lb plates in pounds", () => {
    const visuals = plateVisuals(split([[lbToKg(45), 2], [lbToKg(10), 1]]), "lb");
    expect(visuals.map((v) => v.label)).toEqual(["45", "45", "10"]);
    expect(visuals.map((v) => v.cls)).toEqual(["20", "20", "5"]);
  });

  it("is empty for a bare bar", () => {
    expect(plateVisuals(split([]), "kg")).toEqual([]);
  });
});

describe("plateText", () => {
  it("names an exact build one side at a time", () => {
    expect(plateText(split([[20, 1], [5, 1]]), 20, "kg")).toBe("20 + 5 per side");
  });

  it("says Bar only when the bar is the whole load", () => {
    expect(plateText(split([]), 20, "kg")).toBe("Bar only");
  });

  it("says Sled only, not Bar only, for an empty plate-loaded sled (L5)", () => {
    expect(plateText(split([]), lbToKg(100), "lb", "Sled")).toBe("Sled only");
    expect(plateText(split([]), 20, "kg", "Bar")).toBe("Bar only");
  });

  it("says No plates when there is no bar weight either", () => {
    expect(plateText(split([]), 0, "kg")).toBe("No plates");
  });

  it("names the closest build when the target cannot be made", () => {
    expect(
      plateText(split([[20, 1]], { exact: false, achievedKg: 60 }), 20, "kg"),
    ).toBe("20 per side · closest is 60 kg");
  });

  it("reports the closest build in pounds in lb", () => {
    expect(
      plateText(
        split([[lbToKg(45), 1]], { exact: false, achievedKg: lbToKg(135) }),
        lbToKg(45),
        "lb",
      ),
    ).toBe("45 per side · closest is 135 lb");
  });
});

describe("dumbbellLook", () => {
  const at = (lb: number) => dumbbellLook(lbToKg(lb)).cls;

  it("changes colour at 20, 35, 50 and 70 lb", () => {
    expect([19.9, 20, 34.9, 35, 49.9, 50, 69.9, 70].map(at)).toEqual([
      "5", "10", "10", "15", "15", "20", "20", "25",
    ]);
  });

  it("draws heavier bells taller, within a bounded range", () => {
    const light = dumbbellLook(lbToKg(5)).height;
    const heavy = dumbbellLook(lbToKg(100)).height;
    const huge = dumbbellLook(lbToKg(500)).height;
    expect(heavy).toBeGreaterThan(light);
    expect(huge).toBe(52);
  });

  it("treats a negative weight as zero", () => {
    expect(dumbbellLook(-5)).toEqual(dumbbellLook(0));
  });
});

describe("dumbbellText — authored numbers are quoted as authored (M13)", () => {
  it("uses the shown lb number instead of a converted-and-rounded kg one", () => {
    // 20.41 kg is a 45 lb dumbbell: the kg route gives 45, but 22.68 kg typed as
    // 50 lb must read 50, not 50.0000001 rounded differently, and 44.1 never appears
    expect(dumbbellText(lbToKg(45), true, "lb", "dumbbell", 45)).toBe("45 + 45 = 90 lb total");
    expect(dumbbellText(20, true, "lb", "dumbbell", 44.1)).toBe("44.1 + 44.1 = 88.2 lb total");
    expect(dumbbellText(20, true, "lb", "dumbbell", 45)).toBe("45 + 45 = 90 lb total");
    expect(dumbbellText(lbToKg(22.5), false, "lb", "dumbbell", 22.5)).toBe(
      "22.5 lb · one dumbbell is the total",
    );
  });
});

describe("dumbbellText", () => {
  it("adds up a pair", () => {
    expect(dumbbellText(lbToKg(50), true, "lb")).toBe("50 + 50 = 100 lb total");
    expect(dumbbellText(30, true, "kg")).toBe("30 + 30 = 60 kg total");
  });

  it("says one implement is the total for a single bell", () => {
    expect(dumbbellText(30, false, "kg")).toBe("30 kg · one dumbbell is the total");
    expect(dumbbellText(24, false, "kg", "kettlebell")).toBe(
      "24 kg · one kettlebell is the total",
    );
  });
});
