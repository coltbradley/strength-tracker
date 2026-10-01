// Property proof of the display rules in lib/displayLoad.ts: typed numbers
// come back exactly, converted numbers are human-readable, and a staged
// cross-unit number is a loadable one that logs as itself.
import { describe, expect, it } from "vitest";
import {
  convertedLoadValue,
  formatLoad,
  formatPlanRef,
  formatSetLoad,
  loadableDefault,
  stageLoad,
} from "./displayLoad";
import { buildSetLoad, isAcceptedAuthoredLoad } from "./setLoad";
import { KG_PER_LB } from "./setLoad";
import { formatAuthoredLoad, formatPlate, formatStoredTwin, formatRxTarget } from "./format";
import { stagedDisplayLoad } from "./units";

const ONE_DECIMAL = /^\d+(\.\d)?$/;
const QUARTER = /^\d+\.(25|75)$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** both unit grids, coarse and fine, up to a heavy leg press */
const KG_GRID: number[] = [];
for (let v = 0; v <= 600; v += 1.25) KG_GRID.push(r2(v));
const LB_GRID: number[] = [];
for (let v = 0; v <= 1320; v += 2.5) LB_GRID.push(v);

describe("formatLoad: converted values are human precision", () => {
  it("every kg grid value viewed in lb is at most one decimal, never x.0", () => {
    for (const kg of KG_GRID) {
      const s = formatLoad(kg, "lb");
      expect(s, `${kg} kg in lb`).toMatch(ONE_DECIMAL);
      expect(s.endsWith(".0")).toBe(false);
    }
  });
  it("every lb grid value (stored as 2-decimal kg) viewed in kg is at most one decimal", () => {
    for (const lb of LB_GRID) {
      const kg = r2(lb * KG_PER_LB);
      const s = formatLoad(kg, "kg");
      // a quarter-kg is a real, exact plate load, not a conversion artefact
      expect(/^\d+(\.\d)?$/.test(s) || QUARTER.test(s), `${lb} lb in kg: ${s}`).toBe(true);
      expect(s.endsWith(".0")).toBe(false);
    }
  });
  it("no float artefacts from arbitrary stored totals, in either unit", () => {
    for (let c = 1; c <= 60000; c += 7) {
      const kg = c / 100;
      for (const unit of ["kg", "lb"] as const) {
        const s = formatLoad(kg, unit);
        expect(/^\d+(\.\d)?$/.test(s) || (unit === "kg" && QUARTER.test(s)), `${kg} ${unit}: ${s}`).toBe(true);
      }
    }
  });
  it("the named offenders", () => {
    expect(formatLoad(102.06, "kg")).toBe("102.1");
    expect(formatLoad(20, "lb")).toBe("44.1");
    expect(formatLoad(102.5, "lb")).toBe("226");
    expect(formatLoad(61.2, "kg")).toBe("61.2");
    expect(formatLoad(100, "kg")).toBe("100");
    expect(formatLoad(21.25, "kg")).toBe("21.25");
    expect(formatLoad(0.1 + 0.2, "kg")).toBe("0.3");
  });
});

describe("formatLoad: what was typed is shown exactly", () => {
  it("every grid value in the unit it was typed in", () => {
    for (const v of KG_GRID) {
      expect(formatLoad(r2(v), "kg", { typed: { value: v, unit: "kg" } })).toBe(String(v));
    }
    for (const v of LB_GRID) {
      expect(formatLoad(r2(v * KG_PER_LB), "lb", { typed: { value: v, unit: "lb" } })).toBe(String(v));
    }
  });
  it("typed in the other unit is a conversion", () => {
    expect(formatLoad(102.06, "kg", { typed: { value: 225, unit: "lb" } })).toBe("102.1");
    expect(formatLoad(100, "lb", { typed: { value: 100, unit: "kg" } })).toBe("220.5");
  });
  it("set rows and authored lines agree", () => {
    const row = { load_kg: 21.25, load_entry: "total" as const, entered_load: 21.25, entered_unit: "kg" as const };
    expect(formatSetLoad(row, "kg")).toBe("21.25");
    expect(formatSetLoad(row, "lb")).toBe("46.8");
    const pair = { load_kg: 99.79, load_entry: "per_side" as const, entered_load: 110, entered_unit: "lb" as const };
    expect(formatSetLoad(pair, "lb")).toBe("110");
    expect(formatSetLoad(pair, "kg")).toBe("49.9");
    expect(formatAuthoredLoad(99.79, "per_side", 110, "lb", "kg")).toBe("49.9 kg/side");
    expect(formatAuthoredLoad(99.79, "per_side", 110, "lb", "lb")).toBe("110 lb/side");
  });
});

describe("loadableDefault: the nearest loadable number on the grid", () => {
  it("every kg grid value viewed in lb lands on the 5 lb grid within half a step", () => {
    for (const kg of KG_GRID) {
      if (kg === 0) continue;
      const lb = loadableDefault(kg, "lb", 5 * KG_PER_LB);
      expect(lb % 5, `${kg} kg -> ${lb} lb`).toBe(0);
      expect(Math.abs(lb - kg / KG_PER_LB)).toBeLessThanOrEqual(2.5 + 1e-6);
      expect(String(lb)).toMatch(ONE_DECIMAL);
    }
  });
  it("every lb grid value viewed in kg lands on the 2.5 kg grid within half a step", () => {
    for (const lb of LB_GRID) {
      if (lb === 0) continue;
      const kg = loadableDefault(r2(lb * KG_PER_LB), "kg", 2.5);
      expect(kg % 2.5, `${lb} lb -> ${kg} kg`).toBe(0);
      // (below half a step the floor of one step applies: a load is never rounded to nothing)
      if (lb * KG_PER_LB >= 1.25) expect(Math.abs(kg - lb * KG_PER_LB)).toBeLessThanOrEqual(1.25 + 0.01);
    }
  });
  it("a conversion already on the grid (within 0.01 kg) is kept exactly", () => {
    for (let lb = 5; lb <= 1000; lb += 5) {
      expect(loadableDefault(r2(lb * KG_PER_LB), "lb", 5 * KG_PER_LB)).toBe(lb);
    }
    for (let kg = 2.5; kg <= 500; kg += 2.5) expect(loadableDefault(kg, "kg", 2.5)).toBe(kg);
  });
  it("the named cases: 100 kg is 220 lb, never 220.5; 145 lb is 65 kg", () => {
    expect(loadableDefault(100, "lb", 5 * KG_PER_LB)).toBe(220);
    expect(loadableDefault(r2(145 * KG_PER_LB), "kg", 2.5)).toBe(65);
  });
  it("honours a per-exercise step and the dumbbell per-hand grid", () => {
    expect(loadableDefault(22.5, "lb", 5 * KG_PER_LB)).toBe(50); // 22.5 kg/hand
    expect(loadableDefault(22.5, "lb", 2.5 * KG_PER_LB)).toBe(50);
    expect(loadableDefault(27.2, "kg", 1.25)).toBe(27.5);
    expect(loadableDefault(0.4, "kg", 2.5)).toBe(2.5); // never rounds a load to nothing
    expect(loadableDefault(0, "kg", 2.5)).toBe(0);
  });
  it("what is staged logs as itself and the database accepts it", () => {
    for (const kg of KG_GRID) {
      if (kg === 0) continue;
      for (const unit of ["kg", "lb"] as const) {
        const typed = loadableDefault(kg, unit, unit === "kg" ? 2.5 : 5 * KG_PER_LB);
        const built = buildSetLoad({ typedValue: typed, typedUnit: unit, loadEntry: "total" });
        expect(isAcceptedAuthoredLoad(built).ok).toBe(true);
        // read back in the unit it was typed in: exactly the number the lifter saw
        expect(formatSetLoad(built, unit)).toBe(String(typed));
      }
    }
  });
});

describe("stageLoad and the plan reference", () => {
  const lbStep = 5 * KG_PER_LB;
  it("a kg plan viewed in lb stages 220 and says plan 100 kg", () => {
    const s = stageLoad({ unit: "lb", stepKg: lbStep, sourceEntryKg: 100, origin: { value: 100, unit: "kg" }, label: "plan" });
    expect(s).toMatchObject({ enteredLoad: 220, enteredUnit: "lb", entryKg: 99.79 });
    expect(formatPlanRef(s.planRef, "lb")).toBe("plan 100 kg");
    expect(formatPlanRef(s.planRef, "kg")).toBeNull();
  });
  it("typed in this unit is staged exactly, with no reference", () => {
    const s = stageLoad({ unit: "lb", stepKg: lbStep, sourceEntryKg: 102.17, origin: { value: 225.25, unit: "lb" }, label: "plan" });
    expect(s).toEqual({ entryKg: 102.17, enteredLoad: 225.25, enteredUnit: "lb" });
  });
  it("last time typed in lb, viewed in kg", () => {
    const s = stageLoad({ unit: "kg", stepKg: 2.5, sourceEntryKg: 65.77, origin: { value: 145, unit: "lb" }, label: "last" });
    expect(s).toMatchObject({ enteredLoad: 65, enteredUnit: "kg", entryKg: 65 });
    expect(formatPlanRef(s.planRef, "kg")).toBe("last 145 lb");
  });
  it("a clean stored kg shown in kg is staged untouched", () => {
    expect(stageLoad({ unit: "kg", stepKg: 2.5, sourceEntryKg: 21.25, origin: null, label: "last" })).toEqual({ entryKg: 21.25 });
  });
  it("a stored kg with no typed number shown in lb quotes the plan in kg", () => {
    const s = stageLoad({ unit: "lb", stepKg: lbStep, sourceEntryKg: 102.5, origin: null, label: "plan" });
    expect(s.enteredLoad).toBe(225);
    expect(formatPlanRef(s.planRef, "lb")).toBe("plan 102.5 kg");
  });
});

describe("the other display helpers follow the same rules", () => {
  it("stagedDisplayLoad quotes a cross-unit typed draft as a conversion", () => {
    expect(stagedDisplayLoad(102.06, 225, "lb", "kg")).toBe(102.1);
    expect(stagedDisplayLoad(102.06, 225, "lb", "lb")).toBe(225);
  });
  it("storage twin, plate labels and targets", () => {
    expect(formatStoredTwin(102.06, "lb")).toBe("102.1 kg stored");
    expect(formatStoredTwin(100, "kg")).toBe("220.5 lb");
    expect(formatPlate(20, "lb")).toBe("44.1");
    expect(formatPlate(1.25, "kg")).toBe("1.25");
    expect(formatPlate(2.5 * KG_PER_LB, "lb")).toBe("2.5");
    expect(convertedLoadValue(45.36, "lb")).toBe(100);
    const rx = { tracking: "reps", sets: 3, reps_min: 5, reps_max: 5, load_kg: 102.06, resolved_load_kg: 102.06,
      plate_load_kg: null, load_entry: "total", entered_load: 225, entered_unit: "lb", set_type: "working", load_pct_tm: null } as never;
    expect(formatRxTarget(rx, "kg")).toBe("3×5 @ 102.1 kg");
    expect(formatRxTarget(rx, "lb")).toBe("3×5 @ 225 lb");
  });
});
