import { describe, expect, it } from "vitest";
import type { ExerciseEntry } from "./entries";
import {
  blockMoveIndex,
  moveSessionEntry,
  orderedEntryBlocks,
  reconcileEntryOrder,
  sessionEntryMoveIndex,
} from "./sessionOrder";

function entry(
  key: string,
  options: { section?: string | null; superset?: number; exercise?: string } = {},
): ExerciseEntry {
  return {
    key,
    exercise_id: options.exercise ?? key,
    name: key,
    brackets: (options.section !== undefined || options.superset !== undefined
      ? [{ section: options.section ?? null, superset_group: options.superset ?? null }]
      : []) as ExerciseEntry["brackets"],
  };
}

const keys = (entries: readonly ExerciseEntry[]) => entries.map(({ key }) => key);

function expectEachKeyOnce(entries: readonly ExerciseEntry[], expected: string[]) {
  expect([...keys(entries)].sort()).toEqual([...expected].sort());
  expect(new Set(keys(entries)).size).toBe(expected.length);
}

describe("session-local entry order", () => {
  it("reconciles stale, duplicate, and missing keys while preserving canonical order for omitted entries", () => {
    const original = [entry("a"), entry("b"), entry("c")];
    const result = reconcileEntryOrder(original, ["missing", "c", "c", "a"]);

    expect(keys(result)).toEqual(["c", "a", "b"]);
    expectEachKeyOnce(result, ["a", "b", "c"]);
  });

  it("moves a ramp and an adjacent paired circuit as intact navigation blocks", () => {
    const ramp = entry("ramp", { exercise: "press" });
    ramp.brackets = [
      { id: "r1", exercise_id: "press" },
      { id: "r2", exercise_id: "press" },
    ] as never;
    const original = [
      ramp,
      entry("a1", { superset: 1 }),
      entry("a2", { superset: 1 }),
      entry("a3", { superset: 1 }),
      entry("solo"),
    ];

    const moved = moveSessionEntry(original, "a2", 4);

    expect(keys(moved)).toEqual(["ramp", "solo", "a1", "a2", "a3"]);
    expect(moved[0].brackets).toHaveLength(2);
    expectEachKeyOnce(moved, keys(original));
  });

  it("moves a superset inside a named section intact and keeps separate same-letter runs separate", () => {
    const original = [
      entry("warm-1", { section: "Warmup" }),
      entry("warm-2", { section: "Warmup", superset: 1 }),
      entry("warm-3", { section: "Warmup", superset: 1 }),
      entry("main"),
      entry("late-a1", { superset: 1 }),
      entry("late-a2", { superset: 1 }),
      entry("finish", { section: "Finisher" }),
    ];

    const moved = moveSessionEntry(original, "warm-2", 6);

    expect(keys(moved)).toEqual([
      "warm-1", "main", "late-a1", "late-a2", "finish", "warm-2", "warm-3",
    ]);
    expect(moved.findIndex((item) => item.key === "late-a1") + 1).toBe(
      moved.findIndex((item) => item.key === "late-a2"),
    );
    expectEachKeyOnce(moved, keys(original));
  });

  it("does not regroup same-letter runs after a move and reconciles arbitrary saved order at block boundaries", () => {
    const original = [
      entry("a1", { superset: 1 }),
      entry("a2", { superset: 1 }),
      entry("middle"),
      entry("a3", { superset: 1 }),
      entry("a4", { superset: 1 }),
    ];
    const moved = reconcileEntryOrder(original, ["a4", "a1", "middle", "a3", "a2"]);

    expect(keys(moved)).toEqual(keys(original));
    expectEachKeyOnce(moved, keys(original));
  });

  it("moves one singleton block down exactly one place", () => {
    const original = [entry("a"), entry("b"), entry("c")];
    const destination = sessionEntryMoveIndex(original, "a", "down");

    expect(destination).toBe(1);
    expect(keys(moveSessionEntry(original, "a", destination!))).toEqual(["b", "a", "c"]);
  });

  it("moves a superset one position in either direction without splitting it, and a section's exercises one by one", () => {
    const original = [
      entry("lead"),
      entry("pair-1", { superset: 1 }),
      entry("pair-2", { superset: 1 }),
      entry("section-1", { section: "Cooldown" }),
      entry("section-2", { section: "Cooldown" }),
      entry("tail"),
    ];
    const down = sessionEntryMoveIndex(original, "pair-2", "down");
    const downResult = moveSessionEntry(original, "pair-1", down!);
    const up = sessionEntryMoveIndex(original, "section-2", "up");
    const upResult = moveSessionEntry(original, "section-2", up!);

    expect(keys(downResult)).toEqual([
      "lead", "section-1", "pair-1", "pair-2", "section-2", "tail",
    ]);
    expect(up).toBe(3);
    expect(keys(upResult)).toEqual([
      "lead", "pair-1", "pair-2", "section-2", "section-1", "tail",
    ]);
    expectEachKeyOnce(downResult, keys(original));
  });

  it("still refuses a move that would join two separate same-letter superset runs, but moves the exercise between them", () => {
    const original = [
      entry("warm-a", { section: "Warmup", superset: 1 }),
      entry("warm-b", { section: "Warmup", superset: 1 }),
      entry("warm-tail", { section: "Warmup" }),
      entry("main-a", { section: "Main", superset: 1 }),
      entry("main-b", { section: "Main", superset: 1 }),
      entry("main-tail", { section: "Main" }),
      entry("end"),
    ];
    // the Warmup pair would land right against the Main pair: one superset
    expect(sessionEntryMoveIndex(original, "warm-a", "down")).toBeNull();
    expect(sessionEntryMoveIndex(original, "warm-tail", "up")).toBeNull();
    expect(sessionEntryMoveIndex(original, "warm-tail", "down")).toBeNull();
    expect(keys(moveSessionEntry(original, "warm-tail", 6))).toEqual(keys(original));
    // other exercises are free to move, across the section boundary too
    const down = sessionEntryMoveIndex(original, "main-tail", "down");
    expect(keys(moveSessionEntry(original, "main-tail", down!))).toEqual([
      "warm-a", "warm-b", "warm-tail", "main-a", "main-b", "end", "main-tail",
    ]);
  });

  it("moves one exercise of a section on its own; the section label stays with the exercise", () => {
    const original = [
      entry("s1", { section: "Strength" }),
      entry("s2", { section: "Strength" }),
      entry("s3", { section: "Strength" }),
      entry("c1", { section: "Core" }),
    ];
    expect(keys(moveSessionEntry(original, "s3", 1))).toEqual(["s1", "s3", "s2", "c1"]);
    // across the section boundary: it keeps its own section
    const crossed = moveSessionEntry(original, "s1", 3);
    expect(keys(crossed)).toEqual(["s2", "s3", "c1", "s1"]);
    expect(crossed.find((e) => e.key === "s1")!.brackets[0]!.section).toBe("Strength");
  });

  it("a split section can be put back together by moving the intruder out again", () => {
    const original = [
      entry("s1", { section: "Strength" }),
      entry("s2", { section: "Strength" }),
      entry("c1", { section: "Core" }),
    ];
    const split = moveSessionEntry(original, "c1", 1);
    expect(keys(split)).toEqual(["s1", "c1", "s2"]);
    const healed = moveSessionEntry(original, "c1", 2, keys(split));
    expect(keys(healed)).toEqual(["s1", "s2", "c1"]);
    expect(sessionEntryMoveIndex(original, "c1", "down", keys(split))).not.toBeNull();
  });

  it("refuses to join two separate runs of one section by moving the exercise between them", () => {
    const original = [
      entry("s1", { section: "Strength" }),
      entry("core", { section: "Core" }),
      entry("s2", { section: "Strength" }),
    ];
    expect(sessionEntryMoveIndex(original, "core", "down")).toBeNull();
    expect(sessionEntryMoveIndex(original, "core", "up")).toBeNull();
    expect(keys(moveSessionEntry(original, "core", 0))).toEqual(keys(original));
  });

  it("keeps a ramp with mixed section metadata in canonical order and disables its arrows", () => {
    const mixedRamp = entry("mixed-ramp");
    mixedRamp.brackets = [
      { id: "r1", exercise_id: "mixed", section: "Warmup" },
      { id: "r2", exercise_id: "mixed", section: "Main" },
    ] as never;
    const original = [mixedRamp, entry("middle"), entry("last")];

    expect(keys(reconcileEntryOrder(original, ["last", "mixed-ramp", "middle"]))).toEqual(
      keys(original),
    );
    expect(sessionEntryMoveIndex(original, "mixed-ramp", "down")).toBeNull();
    expect(keys(moveSessionEntry(original, "mixed-ramp", 2))).toEqual(keys(original));
  });

  it("returns a copy for unknown targets and clamps destination indices", () => {
    const original = [entry("a"), entry("b")];
    expect(moveSessionEntry(original, "missing", 1)).toEqual(original);
    expect(moveSessionEntry(original, "b", -4).map((item) => item.key)).toEqual(["b", "a"]);
    expect(moveSessionEntry(original, "a", 100).map((item) => item.key)).toEqual(["b", "a"]);
  });
});

describe("orderedEntryBlocks / blockMoveIndex — what the Today's workout sheet draws", () => {
  const day = () => [
    entry("squat"),
    entry("a1", { superset: 1 }),
    entry("a2", { superset: 1 }),
    entry("curl"),
    entry("w1", { section: "Cooldown" }),
    entry("w2", { section: "Cooldown" }),
  ];

  it("returns each movable unit whole: a pair is one block, a named section is one row per exercise", () => {
    expect(orderedEntryBlocks(day()).map((block) => keys(block))).toEqual([
      ["squat"],
      ["a1", "a2"],
      ["curl"],
      ["w1"],
      ["w2"],
    ]);
  });

  it("follows a saved order", () => {
    const blocks = orderedEntryBlocks(day(), ["curl", "squat"]);
    expect(blocks.map((block) => keys(block))).toEqual([
      ["curl"],
      ["squat"],
      ["a1", "a2"],
      ["w1"],
      ["w2"],
    ]);
  });

  it("converts a dragged block position into the index moveSessionEntry takes", () => {
    const entries = day();
    const blocks = orderedEntryBlocks(entries);
    // drag the pair (block 1) to the end of the main work, after "curl" (block 2)
    const index = blockMoveIndex(blocks, 1, 2);
    expect(index).toBe(2);
    expect(keys(moveSessionEntry(entries, "a1", index))).toEqual([
      "squat",
      "curl",
      "a1",
      "a2",
      "w1",
      "w2",
    ]);
    // dragging up: curl (block 2) above the pair
    expect(keys(moveSessionEntry(entries, "curl", blockMoveIndex(blocks, 2, 1)))).toEqual([
      "squat",
      "curl",
      "a1",
      "a2",
      "w1",
      "w2",
    ]);
  });

  it("clamps an out-of-range drag target instead of throwing", () => {
    const blocks = orderedEntryBlocks(day());
    expect(blockMoveIndex(blocks, 0, 99)).toBe(5);
    expect(blockMoveIndex(blocks, 3, -4)).toBe(0);
  });
});
