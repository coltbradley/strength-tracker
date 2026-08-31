import { describe, expect, it } from "vitest";
import {
  blockBand,
  blockRowIds,
  canonicalRowIds,
  entryBand,
  entryKeys,
  moveEntry,
  planBlocks,
  planEntries,
  reorderBlocks,
  reorderEntries,
  sectionRank,
  sectionUnit,
} from "./sections";
import { groupRamps } from "./entries";
import type { ResolvedPrescriptionRow } from "./types";

let seq = 0;
function rx(over: Partial<ResolvedPrescriptionRow>): ResolvedPrescriptionRow {
  seq += 1;
  return {
    id: `rx${seq}`,
    planned_workout_id: "w1",
    exercise_id: "squat",
    exercise_name: "Barbell Squat",
    position: seq,
    sets: 3,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 120,
    notes: null,
    load_kg: 100,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 100,
    plate_load_kg: null,
    superset_group: null,
    section: null,
    ...over,
  };
}

const ids = (rows: ResolvedPrescriptionRow[]) => rows.map((r) => r.id);

/**
 * The demo's "Full Body · Squat Focus", which is where all three reported
 * bugs were reproduced: a three-bracket squat ramp, a percentage bench, and
 * a superset A of two exercises.
 */
function squatFocus(): ResolvedPrescriptionRow[] {
  return [
    rx({ exercise_id: "squat", reps_min: 8, reps_max: 15 }),
    rx({ exercise_id: "squat", reps_min: 6, reps_max: 8 }),
    rx({ exercise_id: "squat", reps_min: 3, reps_max: 5 }),
    rx({ exercise_id: "bench", exercise_name: "Barbell Bench Press" }),
    rx({
      exercise_id: "rdl",
      exercise_name: "Romanian Deadlift",
      superset_group: 1,
    }),
    rx({
      exercise_id: "facepull",
      exercise_name: "Face Pull",
      superset_group: 1,
    }),
  ];
}

describe("planEntries", () => {
  it("makes one entry of a ramp and one of a superset", () => {
    const rows = squatFocus();
    const entries = planEntries(rows);
    expect(entries.map((e) => e.rows.length)).toEqual([3, 1, 2]);
    expect(entries[2]!.supersetGroup).toBe(1);
    expect(entries[2]!.exercises).toBe(2);
  });

  it("keeps a non-adjacent repeat of an exercise separate, as groupRamps does", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "bench" }),
      rx({ exercise_id: "squat" }),
    ];
    expect(planEntries(rows).map((e) => ids(e.rows))).toEqual(
      groupRamps(rows).map(ids),
    );
  });

  // A superset is the coach's declaration that these alternate, so members
  // that drifted apart are still ONE thing. groupRamps stays adjacency-only
  // for the session screens, which cannot reorder anything.
  it("gathers superset members that are not adjacent", () => {
    const rows = [
      rx({ exercise_id: "curl", superset_group: 1 }),
      rx({ exercise_id: "plank" }),
      rx({ exercise_id: "pushdown", superset_group: 1 }),
    ];
    const entries = planEntries(rows);
    expect(entries.map((e) => ids(e.rows))).toEqual([
      [rows[0]!.id, rows[2]!.id],
      [rows[1]!.id],
    ]);
  });

  it("keeps a ramp inside a superset in one entry", () => {
    const rows = [
      rx({ exercise_id: "bench", superset_group: 1 }),
      rx({ exercise_id: "bench", superset_group: 1 }),
      rx({ exercise_id: "row", superset_group: 1 }),
    ];
    const entries = planEntries(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.exercises).toBe(2);
  });

  it("does not join the same exercise across a superset boundary", () => {
    const rows = [
      rx({ exercise_id: "squat", superset_group: 1 }),
      rx({ exercise_id: "squat" }),
    ];
    expect(planEntries(rows)).toHaveLength(2);
  });
});

describe("sectionUnit", () => {
  // BUG 1, as reported: open Squat Focus, set a section on the FIRST squat
  // bracket, and rows 2 and 3 stayed outside the heading.
  it("carries the whole ramp when any one of its brackets is picked", () => {
    const rows = squatFocus();
    const ramp = ids(rows.slice(0, 3));
    for (const r of rows.slice(0, 3))
      expect(ids(sectionUnit(rows, r.id))).toEqual(ramp);
  });

  // A superset straddling a heading describes a day nobody can perform: the
  // pairing IS the prescription.
  it("carries every member of a superset, not just the one edited", () => {
    const rows = squatFocus();
    expect(ids(sectionUnit(rows, rows[5]!.id))).toEqual([
      rows[4]!.id,
      rows[5]!.id,
    ]);
  });

  it("is just the row when nothing is bound to it", () => {
    const rows = squatFocus();
    expect(ids(sectionUnit(rows, rows[3]!.id))).toEqual([rows[3]!.id]);
  });

  it("is empty for a row that is not there", () => {
    expect(sectionUnit(squatFocus(), "nope")).toEqual([]);
  });
});

describe("planBlocks", () => {
  /** Every heading the editor would draw, in order. */
  const headings = (rows: ResolvedPrescriptionRow[]) =>
    planBlocks(rows)
      .flatMap((b) => [
        ...(b.section === null ? [] : [b.section]),
        ...b.entries.flatMap((e) =>
          e.supersetGroup === null ? [] : [`SS${e.supersetGroup}`],
        ),
      ])
      .filter((h) => h !== null);

  // BUG 3, section half: a name interrupted and resumed printed its heading
  // twice, which reads as two sections that happen to share a name.
  it("heads an interrupted section once", () => {
    const rows = [
      rx({ exercise_id: "crunch", section: "Abs" }),
      rx({ exercise_id: "bench" }),
      rx({ exercise_id: "plank", section: "Abs" }),
    ];
    expect(headings(rows)).toEqual(["Abs"]);
    const abs = planBlocks(rows).find((b) => b.section === "Abs");
    expect(abs!.entries).toHaveLength(2);
  });

  // BUG 3, superset half: two rows of group A with something between them
  // printed "SUPERSET A" twice.
  it("heads a scattered superset once", () => {
    const rows = [
      rx({ exercise_id: "curl", superset_group: 1 }),
      rx({ exercise_id: "plank" }),
      rx({ exercise_id: "pushdown", superset_group: 1 }),
    ];
    expect(headings(rows)).toEqual(["SS1"]);
  });

  it("cannot draw any name twice, whatever the rows do", () => {
    const rows = [
      rx({ exercise_id: "a", section: "Abs" }),
      rx({ exercise_id: "b", superset_group: 1 }),
      rx({ exercise_id: "c", section: "Abs" }),
      rx({ exercise_id: "d", superset_group: 1 }),
      rx({ exercise_id: "e", section: "Abs", superset_group: 2 }),
      rx({ exercise_id: "f", superset_group: 2 }),
    ];
    const drawn = headings(rows);
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it("puts every row in exactly one block, losing none", () => {
    const rows = squatFocus();
    expect(blockRowIds(planBlocks(rows)).sort()).toEqual(ids(rows).sort());
  });
});

describe("section order", () => {
  it("ranks warmup-ish before the main body and cooldown-ish after", () => {
    expect(sectionRank("Activations")).toBe(-1);
    expect(sectionRank("Warm-up")).toBe(-1);
    expect(sectionRank("Mobility prep")).toBe(-1);
    expect(sectionRank(null)).toBe(0);
    expect(sectionRank("Abs")).toBe(0);
    expect(sectionRank("Cooldown")).toBe(1);
    expect(sectionRank("Cool down")).toBe(1);
    expect(sectionRank("Finisher")).toBe(1);
  });

  it("sorts activations to the top and cooldown to the end", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "stretch", section: "Cooldown" }),
      rx({ exercise_id: "bench" }),
      rx({ exercise_id: "band", section: "Activations" }),
    ];
    expect(planBlocks(rows).map((b) => b.section)).toEqual([
      "Activations",
      null,
      null,
      "Cooldown",
    ]);
    expect(canonicalRowIds(rows)).toEqual([
      rows[3]!.id,
      rows[0]!.id,
      rows[2]!.id,
      rows[1]!.id,
    ]);
  });

  // A name the table does not know ranks with the main body, so it keeps the
  // place the user put it rather than being banished to one end.
  it("leaves a name it does not recognise where it is", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "carry", section: "Grip" }),
      rx({ exercise_id: "bench" }),
    ];
    expect(planBlocks(rows).map((b) => b.section)).toEqual([
      null,
      "Grip",
      null,
    ]);
  });

  it("preserves the order inside a section", () => {
    const rows = [
      rx({ exercise_id: "crunch", section: "Abs" }),
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "plank", section: "Abs" }),
    ];
    const abs = planBlocks(rows).find((b) => b.section === "Abs")!;
    expect(abs.entries.map((e) => e.rows[0]!.exercise_id)).toEqual([
      "crunch",
      "plank",
    ]);
  });
});

describe("dragging", () => {
  // BUG 2, as reported: long-press the Romanian Deadlift (a member of
  // superset A) and drag it up into the squat ramp. The ramp was cut in half
  // and "SUPERSET A" was drawn twice.
  it("moves a whole superset into the top of the day without splitting the ramp", () => {
    const rows = squatFocus();
    const blocks = planBlocks(rows);
    const keys = blocks.map((b) => b.key);
    // The drop the drag hook produces: the superset's block, first.
    const dropped = [keys[2]!, keys[0]!, keys[1]!];
    const next = reorderBlocks(blocks, dropped);
    const order = blockRowIds(next);
    expect(order).toEqual([
      rows[4]!.id,
      rows[5]!.id,
      rows[0]!.id,
      rows[1]!.id,
      rows[2]!.id,
      rows[3]!.id,
    ]);
    // ...and re-reading the moved day still finds one ramp and one superset.
    const moved = order.map((id) => rows.find((r) => r.id === id)!);
    const entries = planEntries(moved);
    expect(entries.map((e) => e.rows.length)).toEqual([2, 3, 1]);
  });

  it("has no drop that lands inside another exercise", () => {
    const rows = squatFocus();
    const blocks = planBlocks(rows);
    const keys = blocks.map((b) => b.key);
    // Every permutation of the drag list is a permutation of whole blocks, so
    // no order it can produce breaks an entry apart.
    for (const dropped of [
      [keys[1]!, keys[0]!, keys[2]!],
      [keys[2]!, keys[1]!, keys[0]!],
      [keys[0]!, keys[2]!, keys[1]!],
    ]) {
      const order = blockRowIds(reorderBlocks(blocks, dropped));
      const moved = order.map((id) => rows.find((r) => r.id === id)!);
      expect(
        planEntries(moved)
          .map((e) => e.rows.length)
          .sort(),
      ).toEqual([1, 2, 3]);
    }
  });

  it("confines a block to its rank band", () => {
    const rows = [
      rx({ exercise_id: "band", section: "Activations" }),
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "bench" }),
      rx({ exercise_id: "stretch", section: "Cooldown" }),
    ];
    const blocks = planBlocks(rows);
    expect(blockBand(blocks, blocks[0]!.key)).toEqual([0, 0]);
    expect(blockBand(blocks, blocks[1]!.key)).toEqual([1, 2]);
    expect(blockBand(blocks, blocks[3]!.key)).toEqual([3, 3]);
    expect(blockBand(blocks, "nope")).toBeNull();
  });

  it("confines an entry to its own section", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "crunch", section: "Abs" }),
      rx({ exercise_id: "plank", section: "Abs" }),
    ];
    const blocks = planBlocks(rows);
    expect(entryKeys(blocks)).toEqual([rows[0]!.id, rows[1]!.id, rows[2]!.id]);
    expect(entryBand(blocks, rows[0]!.id)).toEqual([0, 0]);
    expect(entryBand(blocks, rows[2]!.id)).toEqual([1, 2]);
  });

  it("applies a dragged entry order inside its section", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "crunch", section: "Abs" }),
      rx({ exercise_id: "plank", section: "Abs" }),
    ];
    const blocks = planBlocks(rows);
    const next = reorderEntries(blocks, [
      rows[0]!.id,
      rows[2]!.id,
      rows[1]!.id,
    ]);
    expect(blockRowIds(next)).toEqual([rows[0]!.id, rows[2]!.id, rows[1]!.id]);
  });
});

describe("moveEntry", () => {
  it("moves a whole ramp past the exercise above it", () => {
    const rows = squatFocus();
    const next = moveEntry(planBlocks(rows), rows[3]!.id, -1);
    expect(blockRowIds(next!)).toEqual([
      rows[3]!.id,
      rows[0]!.id,
      rows[1]!.id,
      rows[2]!.id,
      rows[4]!.id,
      rows[5]!.id,
    ]);
  });

  it("swaps two exercises inside a section without leaving it", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "crunch", section: "Abs" }),
      rx({ exercise_id: "plank", section: "Abs" }),
    ];
    const blocks = planBlocks(rows);
    expect(blockRowIds(moveEntry(blocks, rows[2]!.id, -1)!)).toEqual([
      rows[0]!.id,
      rows[2]!.id,
      rows[1]!.id,
    ]);
    // ...and the top of the section has nowhere further to go.
    expect(moveEntry(blocks, rows[1]!.id, -1)).toBeNull();
  });

  it("refuses to move a cooldown above the main body", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "stretch", section: "Cooldown" }),
    ];
    const blocks = planBlocks(rows);
    expect(moveEntry(blocks, rows[1]!.id, -1)).toBeNull();
    expect(moveEntry(blocks, rows[0]!.id, 1)).toBeNull();
  });

  it("returns null for an entry that is not there", () => {
    expect(moveEntry(planBlocks(squatFocus()), "nope", 1)).toBeNull();
  });
});
