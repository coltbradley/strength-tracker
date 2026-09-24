import { describe, expect, it } from "vitest";
import { loadGridFor } from "./loadGrid";

const emptySettings = { fineStepKg: 0.5 };

describe("loadGridFor", () => {
  it("uses standard barbell plate increments and nearby values", () => {
    const grid = loadGridFor(
      { id: "squat", name: "Squat", equipment: "barbell" },
      "kg",
      "total",
      emptySettings,
    );
    expect(grid).toMatchObject({ coarseStep: 2.5, fineStep: 0.5 });
    expect(grid.nearbyStandardValues(100)).toContain(100);
  });

  it("defaults dumbbells to per-hand increments and stack work to stack increments", () => {
    const dumbbells = loadGridFor(
      { id: "db", name: "Dumbbell Press", equipment: "dumbbell" },
      "lb",
      "per_side",
      emptySettings,
    );
    const cable = loadGridFor(
      { id: "row", name: "Cable Row", equipment: "cable" },
      "kg",
      "total",
      emptySettings,
    );
    expect(dumbbells.coarseStep).toBe(5);
    expect(cable.coarseStep).toBe(5);
  });

  it("uses an exercise override before the equipment default", () => {
    const grid = loadGridFor(
      { id: "db", name: "Dumbbell Press", equipment: "dumbbell" },
      "kg",
      "per_side",
      { ...emptySettings, coarseStepKg: 5, exercisePref: { loadStepKg: 1.25 } },
    );
    expect(grid.coarseStep).toBe(1.25);
  });

  it("offers nearby standard values without changing an off-grid typed value", () => {
    const typed = 72.3;
    const grid = loadGridFor(
      { id: "bench", name: "Bench Press", equipment: "barbell" },
      "lb",
      "total",
      { ...emptySettings, typedValue: typed },
    );
    const suggestions = grid.nearbyStandardValues(typed);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(typed).toBe(72.3);
    expect(grid.typedValue).toBe(72.3);
  });
});
