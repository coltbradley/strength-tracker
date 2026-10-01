// @vitest-environment jsdom
// The words and numbers the lifter READS must add up: bar + 2 x the plates in
// "45 + 25 per side" == the total (or, when it cannot be built, the closest
// total the screen names). Parses the rendered text of PlateSheet and
// the drawn plates rather than trusting split() — the screen is what gets loaded.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlateSheet } from "./PlateSheet";
import { plateVisuals } from "../lib/loadPicture";
import { resetAllSettings, setExerciseBarKg } from "../lib/settings";
import { split } from "../lib/plates";
import { lbToKg, type Unit } from "../lib/units";

afterEach(() => {
  cleanup();
  resetAllSettings();
});

const typedKg = (v: number, unit: Unit) =>
  Math.round((unit === "lb" ? lbToKg(v) : v) * 100) / 100;

/** "45 + 45 + 25 per side · closest is 190 lb" -> [plates, closest|null] */
function parseWords(text: string): { plates: number[]; closest: number | null } {
  const m = text.match(/^(.*?) per side/);
  const plates = m
    ? m[1]
        .split(" + ")
        .flatMap((t) => {
          const g = t.match(/^(\d+)×(.+)$/);
          return g ? Array(Number(g[1])).fill(Number(g[2])) : [Number(t)];
        })
    : [];
  const c = text.match(/closest is ([\d.]+)/);
  return { plates, closest: c ? Number(c[1]) : null };
}

const q = (sel: string) => document.querySelector(sel)?.textContent ?? "";

function sheetCases(unit: Unit, bar: number, targets: number[]) {
  const bad: string[] = [];
  for (const t of targets) {
    cleanup();
    resetAllSettings();
    setExerciseBarKg("ex", typedKg(bar, unit));
    const kg = typedKg(t, unit);
    render(
      <PlateSheet
        exerciseId="ex"
        exerciseName="Squat"
        targetKg={kg}
        unit={unit}
        equipment="barbell"
        onTypeTarget={() => {}}
        onTypeBase={() => {}}
        onClose={() => {}}
      />,
    );
    const total = Number(q(".plate-target"));
    const baseShown = Number(q(".plate-base-value").replace(/[^\d.]/g, ""));
    const words = parseWords(q(".plate-text"));
    const warn = document.querySelector(".plate-warn")?.textContent ?? "";
    const warnClosest = warn.match(/Closest is ([\d.]+)/);
    const sum = Math.round((baseShown + 2 * words.plates.reduce((a, b) => a + b, 0)) * 100) / 100;
    const expected = warn ? Number(warnClosest?.[1]) : total;
    if (sum !== expected) bad.push(`${t} ${unit} bar ${bar}: shows total ${total}, words sum ${sum}, expected ${expected}`);
    if (!!warn !== (words.closest !== null)) bad.push(`${t} ${unit}: warning and plate-text disagree`);
    if (words.closest !== null && words.closest !== expected) bad.push(`${t} ${unit}: text closest ${words.closest} vs ${expected}`);
    // the drawn plates (plateVisuals feeds the load picture), same split
    cleanup();
    const inv = unit === "lb" ? [45, 35, 25, 10, 5, 2.5].map(lbToKg) : [25, 20, 15, 10, 5, 2.5, 1.25];
    const r = split(kg, typedKg(bar, unit), inv, unit);
    const drawn = plateVisuals(r, unit).map((p) => Number(p.label));
    const s2 = Math.round((baseShown + 2 * drawn.reduce((a, b) => a + b, 0)) * 100) / 100;
    if (r.plates.length && s2 !== expected) bad.push(`${t} ${unit}: drawn plates sum ${s2}, expected ${expected}`);
  }
  return bad;
}

describe("rendered plate text adds up", () => {
  it("lb: every 5 lb from the bar to 505, plus off-grid values", () => {
    const targets: number[] = [];
    for (let v = 45; v <= 505; v += 5) targets.push(v);
    targets.push(46, 47.5, 137, 187.5, 232, 401, 44, 20, 0);
    expect(sheetCases("lb", 45, targets)).toEqual([]);
  });
  it("lb: a 35 lb bar", () => {
    expect(sheetCases("lb", 35, [35, 45, 75, 115, 135, 137.5, 225])).toEqual([]);
  });
  it("kg: every 2.5 kg from the bar to 300, plus off-grid values", () => {
    const targets: number[] = [];
    for (let v = 20; v <= 300; v += 2.5) targets.push(v);
    targets.push(21, 22.4, 61.2, 97.9, 19, 0);
    expect(sheetCases("kg", 20, targets)).toEqual([]);
  });
  it("kg: a 15 kg bar", () => {
    expect(sheetCases("kg", 15, [15, 17.5, 60, 62.5, 101, 142.5])).toEqual([]);
  });
});
