import { describe, expect, it } from "vitest";
import {
  KG_PER_LB,
  kgToLb,
  lbToKg,
  stepKg,
  stepKgFor,
  toDisplay,
  fromDisplay,
  loadToKg,
  kgToEnteredLoad,
} from "./units";

describe("units", () => {
  it("kg<->lb round-trips", () => {
    for (const kg of [0, 2.5, 20, 61.7, 100, 142.5, 300]) {
      expect(lbToKg(kgToLb(kg))).toBeCloseTo(kg, 10);
    }
    for (const lb of [45, 135, 225, 315]) {
      expect(kgToLb(lbToKg(lb))).toBeCloseTo(lb, 10);
    }
  });

  it("uses the exact conversion factor", () => {
    expect(lbToKg(1)).toBeCloseTo(0.45359237, 10);
    expect(kgToLb(1)).toBeCloseTo(1 / KG_PER_LB, 10);
  });

  it("converts authored units into total-system kg without rounding", () => {
    expect(loadToKg(225, "lb", "total")).toBeCloseTo(102.05828325, 10);
    expect(loadToKg(30, "lb", "per_side")).toBeCloseTo(27.2155422, 10);
    expect(loadToKg(100, "kg", "total")).toBe(100);
  });

  it("converts canonical totals back to the authored value", () => {
    expect(kgToEnteredLoad(lbToKg(225), "lb", "total")).toBeCloseTo(225, 10);
    expect(kgToEnteredLoad(loadToKg(30, "lb", "per_side"), "lb", "per_side"))
      .toBeCloseTo(30, 10);
  });

  it("display conversion rounds to 1 decimal", () => {
    expect(toDisplay(100, "kg")).toBe(100);
    expect(toDisplay(100, "lb")).toBe(220.5);
    expect(fromDisplay(225, "lb")).toBeCloseTo(102.058, 3);
    expect(fromDisplay(102.5, "kg")).toBe(102.5);
  });

  // stepKg is settings-driven now; with no stored settings it must still
  // produce the historical defaults. Per-setting coverage lives in
  // settings.test.ts.
  it("stepper increments match the display unit", () => {
    expect(stepKg("kg", false)).toBe(2.5);
    expect(stepKg("kg", true)).toBe(0.5);
    expect(kgToLb(stepKg("lb", false))).toBeCloseTo(5, 10);
    expect(kgToLb(stepKg("lb", true))).toBeCloseTo(1, 10);
  });

  it("stepKgFor falls back to the global step with no override", () => {
    expect(stepKgFor("squat", "kg", false)).toBe(2.5);
    expect(stepKgFor(null, "kg", true)).toBe(0.5);
  });
});
