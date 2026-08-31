import { describe, expect, it } from "vitest";
import { sectionAt, sectionUnit } from "./sections";
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

describe("sectionUnit", () => {
  it("is just the row when nothing is bound to it", () => {
    const rows = [rx({ exercise_id: "squat" }), rx({ exercise_id: "bench" })];
    expect(ids(sectionUnit(rows, 0))).toEqual([rows[0]!.id]);
  });

  // The reported bug: the demo's Squat Focus day opens with Barbell Squat as
  // three brackets. Sectioning the FIRST left the other two outside.
  it("carries the whole ramp when any one of its brackets is picked", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "bench" }),
    ];
    const all = ids(rows.slice(0, 3));
    expect(ids(sectionUnit(rows, 0))).toEqual(all);
    expect(ids(sectionUnit(rows, 1))).toEqual(all);
    expect(ids(sectionUnit(rows, 2))).toEqual(all);
  });

  it("carries every member of a superset, not just the one edited", () => {
    const rows = [
      rx({ exercise_id: "curl", superset_group: 1 }),
      rx({ exercise_id: "pushdown", superset_group: 1 }),
      rx({ exercise_id: "plank" }),
    ];
    expect(ids(sectionUnit(rows, 1))).toEqual([rows[0]!.id, rows[1]!.id]);
  });

  it("carries a ramp that lives inside a superset, whole", () => {
    const rows = [
      rx({ exercise_id: "bench", superset_group: 1 }),
      rx({ exercise_id: "bench", superset_group: 1 }),
      rx({ exercise_id: "row", superset_group: 1 }),
      rx({ exercise_id: "plank" }),
    ];
    expect(ids(sectionUnit(rows, 0))).toEqual(ids(rows.slice(0, 3)));
  });

  // Same clause groupRamps draws: the letter separates a ramp inside a
  // superset from the same exercise programmed outside one.
  it("does not reach across a superset boundary for the same exercise", () => {
    const rows = [
      rx({ exercise_id: "squat", superset_group: 1 }),
      rx({ exercise_id: "squat" }),
    ];
    expect(ids(sectionUnit(rows, 0))).toEqual([rows[0]!.id]);
    expect(ids(sectionUnit(rows, 1))).toEqual([rows[1]!.id]);
  });

  it("does not reach a non-adjacent row that shares the letter", () => {
    const rows = [
      rx({ exercise_id: "curl", superset_group: 1 }),
      rx({ exercise_id: "plank" }),
      rx({ exercise_id: "pushdown", superset_group: 1 }),
    ];
    expect(ids(sectionUnit(rows, 0))).toEqual([rows[0]!.id]);
  });

  it("agrees with groupRamps on where an exercise starts and ends", () => {
    const rows = [
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "squat" }),
      rx({ exercise_id: "bench" }),
    ];
    for (const group of groupRamps(rows)) {
      const i = rows.findIndex((r) => r.id === group[0]!.id);
      expect(ids(sectionUnit(rows, i))).toEqual(ids(group));
    }
  });

  it("is empty for an index nothing is at", () => {
    expect(sectionUnit([rx({})], 5)).toEqual([]);
  });
});

describe("sectionAt", () => {
  it("has no heading for the main body", () => {
    expect(sectionAt([rx({ section: null })], 0)).toBeNull();
    expect(sectionAt([rx({ section: "  " })], 0)).toBeNull();
  });

  it("heads a run once, at its top", () => {
    const rows = [rx({ section: "Abs" }), rx({ section: "Abs" })];
    expect(sectionAt(rows, 0)).toEqual({ name: "Abs", first: true });
    expect(sectionAt(rows, 1)).toEqual({ name: "Abs", first: false });
  });

  // A name interrupted and resumed used to print its heading twice, which
  // reads as two sections that happen to be called the same thing.
  it("heads an interrupted section once, not once per run", () => {
    const rows = [
      rx({ section: "Abs" }),
      rx({ section: null }),
      rx({ section: "Abs" }),
    ];
    expect(sectionAt(rows, 0)?.first).toBe(true);
    expect(sectionAt(rows, 1)).toBeNull();
    expect(sectionAt(rows, 2)?.first).toBe(false);
  });

  it("still heads a different name of its own", () => {
    const rows = [rx({ section: "Abs" }), rx({ section: "Cooldown" })];
    expect(sectionAt(rows, 1)).toEqual({ name: "Cooldown", first: true });
  });
});
