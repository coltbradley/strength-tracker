import { describe, expect, it } from "vitest";
import type { ExerciseEntry } from "./entries";
import {
  applyEntryOrder,
  entryUnits,
  orderKeysAfterMove,
} from "./entryOrder";

function entry(
  key: string,
  group: number | null = null,
  section: string | null = null,
): ExerciseEntry {
  return {
    key,
    exercise_id: key,
    name: key,
    brackets: [
      { id: key, superset_group: group, section } as ExerciseEntry["brackets"][0],
    ],
  };
}
const extra = (key: string): ExerciseEntry => ({
  key,
  exercise_id: key,
  name: key,
  brackets: [],
});
const keys = (es: ExerciseEntry[]) => es.map((e) => e.key);

const day = [
  entry("squat"),
  entry("bench", 1),
  entry("row", 1),
  entry("curl"),
  entry("press"),
];

describe("applyEntryOrder", () => {
  it("is the natural order with no saved order", () => {
    expect(keys(applyEntryOrder(day, []))).toEqual(keys(day));
    expect(keys(applyEntryOrder(day, null))).toEqual(keys(day));
  });

  it("applies a saved order without mutating the input", () => {
    const before = keys(day);
    const out = applyEntryOrder(day, ["press", "squat", "bench", "row", "curl"]);
    expect(keys(out)).toEqual(["press", "squat", "bench", "row", "curl"]);
    expect(keys(day)).toEqual(before);
  });

  it("keeps a superset adjacent and in A1/A2 order even if the keys say otherwise", () => {
    const out = applyEntryOrder(day, ["row", "squat", "curl", "bench", "press"]);
    // the pair sits where its earliest-listed member ranks, A1 before A2
    expect(keys(out)).toEqual(["bench", "row", "squat", "curl", "press"]);
    const split = applyEntryOrder(day, ["curl", "row", "press", "squat", "bench"]);
    expect(keys(split)).toEqual(["curl", "bench", "row", "press", "squat"]);
  });

  it("ignores stale keys", () => {
    const out = applyEntryOrder(day, ["gone", "press", "ghost", "squat"]);
    expect(keys(out)).toEqual(["press", "bench", "row", "curl", "squat"]);
  });

  it("leaves entries the order does not name in their natural slot", () => {
    const withExtra = [...day, extra("extra:face-pull")];
    const out = applyEntryOrder(withExtra, ["press", "curl", "bench", "row", "squat"]);
    expect(keys(out)).toEqual(["press", "curl", "bench", "row", "squat", "extra:face-pull"].slice(0, 5).concat("extra:face-pull"));
    // a new extra in the MIDDLE of the natural list keeps its index
    const mid = [entry("a"), extra("extra:x"), entry("b"), entry("c")];
    expect(keys(applyEntryOrder(mid, ["c", "b", "a"]))).toEqual([
      "c",
      "extra:x",
      "b",
      "a",
    ]);
  });

  it("is idempotent", () => {
    const order = ["press", "squat", "bench", "row", "curl"];
    const once = applyEntryOrder(day, order);
    expect(keys(applyEntryOrder(once, order))).toEqual(keys(once));
  });

  it("lets an exercise cross sections and keeps its own section", () => {
    const sectioned = [
      entry("a", null, "Activation"),
      entry("m1"),
      entry("f", null, "Finisher"),
    ];
    const out = applyEntryOrder(sectioned, ["f", "a", "m1"]);
    expect(keys(out)).toEqual(["f", "a", "m1"]);
    expect(out[0].brackets[0].section).toBe("Finisher");
  });
});

describe("entryUnits / orderKeysAfterMove", () => {
  it("groups a superset run into one unit", () => {
    expect(entryUnits(day).map((u) => keys(u))).toEqual([
      ["squat"],
      ["bench", "row"],
      ["curl"],
      ["press"],
    ]);
  });

  it("moves a whole unit and reports no-ops as null", () => {
    expect(orderKeysAfterMove(day, 1, 3)).toEqual([
      "squat",
      "curl",
      "press",
      "bench",
      "row",
    ]);
    expect(orderKeysAfterMove(day, 2, 2)).toBeNull();
    expect(orderKeysAfterMove(day, 0, 9)).toBeNull();
  });
});
