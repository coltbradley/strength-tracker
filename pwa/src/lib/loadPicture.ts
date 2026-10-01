// What the focus screen DRAWS for a load: the plates on a bar, one or two
// dumbbells. A pin stack is drawn as a generic stack icon (components/
// session/LoadPicture.tsx) and NEVER with a computed pin position: machines
// differ in what a plate weighs, and invented stack metadata would be a false
// claim. The caption ("Pin at 40 lb") is what carries the fact.
// Pure presentation — every number here is derived
// from a value the session already holds (the plate split from lib/plates.ts,
// the entered load, the unit), and nothing here ever feeds back into
// `load_kg`, which stays the total system load (AGENTS.md).
//
// Kept apart from the components so the arithmetic that decides a plate's
// colour and size, a dumbbell's colour, or where the pin sits can be tested
// without rendering anything.

import type { PlateSplit } from "./plates";
import { formatPlate } from "./format";
import { kgToLb, type Unit } from "./units";
import { formatLoad } from "./displayLoad";

/** The competition colour classes, named by their kg plate. The token for
 *  each lives in styles.css (`--plate-25` …) — this only names which one. */
export type PlateClass = "25" | "20" | "15" | "10" | "5" | "2h" | "1h";

/** An lb plate takes the colour of the kg plate it stands in for on a gym
 *  floor: 45 is the "20", 35 the "15", 25 the "10", 10 the "5". Classifying
 *  by raw kg instead filed a 10 lb plate (4.5 kg) with the 2.5s. */
const LB_CLASS: ReadonlyArray<[number, PlateClass]> = [
  [45, "20"],
  [35, "15"],
  [25, "10"],
  [10, "5"],
  [5, "2h"],
  [2.5, "1h"],
];
const KG_CLASS: ReadonlyArray<[number, PlateClass]> = [
  [25, "25"],
  [20, "20"],
  [15, "15"],
  [10, "10"],
  [5, "5"],
  [2.5, "2h"],
  [1.25, "1h"],
];

/** [height, width] in px — a plate's silhouette is what is read at arm's
 *  length, so the heavier plate is both taller and thicker. */
const SIZE: Record<PlateClass, [number, number]> = {
  "25": [56, 15],
  "20": [54, 13],
  "15": [48, 12],
  "10": [42, 10],
  "5": [32, 8],
  "2h": [26, 7],
  "1h": [20, 6],
};

export function plateClass(plateKg: number, unit: Unit): PlateClass {
  const table = unit === "lb" ? LB_CLASS : KG_CLASS;
  const value = unit === "lb" ? kgToLb(plateKg) : plateKg;
  // the first class this plate reaches, with a little slack for lb
  // equivalents stored as exact kg
  for (const [floor, cls] of table) if (value >= floor - 0.05) return cls;
  return "1h";
}

export interface PlateVisual {
  cls: PlateClass;
  height: number;
  width: number;
  label: string;
}

/**
 * One side's plates, heaviest FIRST — i.e. innermost, against the collar,
 * which is how a bar is loaded. The right side of a drawing renders this
 * as-is and the left side renders it reversed, so on both sides the small
 * plates sit on the outside.
 */
export function plateVisuals(split: PlateSplit, unit: Unit): PlateVisual[] {
  return split.plates.flatMap((p) => {
    const cls = plateClass(p.plate, unit);
    const [height, width] = SIZE[cls];
    return Array.from({ length: p.count }, () => ({
      cls,
      height,
      width,
      label: formatPlate(p.plate, unit),
    }));
  });
}

/**
 * "45 + 25 per side", "Bar only" / "Sled only", or the honest closest build.
 * `baseName` is what the base weight IS: a bar, or a plate-loaded machine's
 * sled. An empty sled is not a bar, and "Bar only" on a leg press said so
 * wrongly.
 */
export function plateText(
  split: PlateSplit,
  baseKg: number,
  unit: Unit,
  baseName: "Bar" | "Sled" = "Bar",
): string {
  const side = plateVisuals(split, unit).map((p) => p.label);
  const words =
    side.length > 0
      ? `${side.join(" + ")} per side`
      : baseKg > 0
        ? `${baseName} only`
        : "No plates";
  return split.exact
    ? words
    : `${words} · closest is ${formatLoad(split.achievedKg, unit)} ${unit}`;
}

/**
 * Dumbbell head colour, by the weight of ONE implement in pounds, on the
 * same palette as the plates: dark under 20 lb, green from 20, yellow from
 * 35, blue from 50, red from 70. Heavier bells are drawn taller too.
 */
export function dumbbellLook(implementKg: number): {
  cls: PlateClass;
  height: number;
} {
  const lb = kgToLb(Math.max(0, implementKg));
  const cls: PlateClass =
    lb >= 70 ? "25" : lb >= 50 ? "20" : lb >= 35 ? "15" : lb >= 20 ? "10" : "5";
  return { cls, height: Math.round(24 + Math.min(28, lb / 3)) };
}

/**
 * "50 + 50 = 100 lb total" for a pair; "50 lb · one dumbbell is the total".
 * `shown` is the number as the lifter reads or typed it, in the unit being
 * displayed: when an authored lb value exists the picture says THAT (225.25
 * stays 225.25) rather than re-deriving a converted-and-rounded one from kg.
 */
export function dumbbellText(
  implementKg: number,
  pair: boolean,
  unit: Unit,
  word = "dumbbell",
  shown?: number,
): string {
  const typed = shown !== undefined ? { value: shown, unit } : null;
  const one = formatLoad(implementKg, unit, { typed });
  const both = formatLoad(implementKg * 2, unit, {
    typed: shown !== undefined ? { value: Math.round(shown * 2 * 100) / 100, unit } : null,
  });
  return pair
    ? `${one} + ${one} = ${both} ${unit} total`
    : `${one} ${unit} · one ${word} is the total`;
}
