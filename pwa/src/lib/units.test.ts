import { describe, expect, it } from "vitest";
import {
  KG_PER_LB,
  kgToLb,
  lbToKg,
  roundToPlate,
  stepKg,
  toDisplay,
  fromDisplay,
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

  it("rounds to 2.5 kg plates in kg mode", () => {
    expect(roundToPlate(101.2, "kg")).toBe(100);
    expect(roundToPlate(101.3, "kg")).toBe(102.5);
    expect(roundToPlate(61.7, "kg")).toBe(62.5);
    expect(roundToPlate(0, "kg")).toBe(0);
  });

  it("rounds to 5 lb plates in lb mode (result still kg)", () => {
    // 100 kg = 220.46 lb -> nearest 5 lb = 220 lb
    expect(kgToLb(roundToPlate(100, "lb"))).toBeCloseTo(220, 10);
    // 61 kg = 134.48 lb -> 135 lb
    expect(kgToLb(roundToPlate(61, "lb"))).toBeCloseTo(135, 10);
  });

  it("display conversion rounds to 1 decimal", () => {
    expect(toDisplay(100, "kg")).toBe(100);
    expect(toDisplay(100, "lb")).toBe(220.5);
    expect(fromDisplay(225, "lb")).toBeCloseTo(102.058, 3);
    expect(fromDisplay(102.5, "kg")).toBe(102.5);
  });

  it("stepper increments match the display unit", () => {
    expect(stepKg("kg", false)).toBe(2.5);
    expect(stepKg("kg", true)).toBe(0.5);
    expect(kgToLb(stepKg("lb", false))).toBeCloseTo(5, 10);
    expect(kgToLb(stepKg("lb", true))).toBeCloseTo(1, 10);
  });
});
