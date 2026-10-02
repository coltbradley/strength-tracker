import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory PostgREST: enough of select/eq/order/limit/insert to watch
// what the three day-copying paths read and what they write.
type Row = Record<string, unknown>;
const { tables, from } = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  from: vi.fn(),
}));

vi.mock("./supabase", () => ({ supabase: { from } }));
vi.mock("./sync", () => ({ outbox: {} }));
vi.mock("./db", async (orig) => ({
  ...(await orig<typeof import("./db")>()),
  cacheDelete: async () => {},
}));

function builder(table: string) {
  let rows = tables[table] ?? (tables[table] = []);
  let cols: string[] | null = null;
  let single = false;
  const b = {
    select(c: string) {
      cols = c.split(",");
      return b;
    },
    eq(col: string, v: unknown) {
      rows = rows.filter((r) => r[col] === v);
      return b;
    },
    not() {
      return b;
    },
    is() {
      return b;
    },
    order(col: string, o?: { ascending?: boolean }) {
      const dir = o?.ascending === false ? -1 : 1;
      rows = [...rows].sort((x, y) =>
        (x[col] as number) < (y[col] as number) ? -dir : dir,
      );
      return b;
    },
    limit(n: number) {
      rows = rows.slice(0, n);
      return b;
    },
    single() {
      single = true;
      return b;
    },
    insert(payload: Row | Row[]) {
      const list = Array.isArray(payload) ? payload : [payload];
      calls.push({ table, rows: list });
      (tables[table] ?? (tables[table] = [])).push(...list);
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) {
      // Only the columns asked for come back, like PostgREST: a column the
      // select list forgets is a column the copy silently loses.
      const out = rows.map((r) =>
        cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r,
      );
      return Promise.resolve({
        data: single ? (out[0] ?? null) : out,
        error: null,
      }).then(resolve, reject);
    },
  };
  return b;
}
const calls: { table: string; rows: Row[] }[] = [];
from.mockImplementation((t: string) => builder(t));

import {
  applyTemplate,
  duplicatePlannedWorkout,
  ensureConfirmedProgramId,
  saveWorkoutAsTemplate,
} from "./data";
import type { PlannedWorkoutRow, ResolvedPrescriptionRow } from "./types";

const base = {
  sets: 3,
  reps_min: 5,
  reps_max: 5,
  load_kg: null,
  load_pct_tm: null,
  rest_seconds: null,
  notes: null,
  set_type: "working",
  section: null,
  tracking: "reps",
  superset_group: null,
  load_entry: null,
  entered_load: null,
  entered_unit: null,
};

/** A day with a warmup ramp, a superset, a sectioned row and a timed carry. */
const dayRows = (workoutId: string): Row[] => [
  {
    ...base,
    planned_workout_id: workoutId,
    exercise_id: "squat",
    position: 0,
    set_type: "warmup",
    load_kg: 60,
  },
  {
    ...base,
    planned_workout_id: workoutId,
    exercise_id: "squat",
    position: 1,
    load_kg: 100,
  },
  {
    ...base,
    planned_workout_id: workoutId,
    exercise_id: "row",
    position: 2,
    superset_group: 1,
  },
  {
    ...base,
    planned_workout_id: workoutId,
    exercise_id: "curl",
    position: 3,
    superset_group: 1,
  },
  {
    ...base,
    planned_workout_id: workoutId,
    exercise_id: "dead-bug",
    position: 4,
    section: "Activations",
    tracking: "done",
  },
  {
    ...base,
    planned_workout_id: workoutId,
    exercise_id: "carry",
    position: 5,
    tracking: "time",
    load_kg: 40,
    load_entry: "per_side",
    entered_load: 20,
    entered_unit: "kg",
  },
];

const STRUCTURE = [
  "position",
  "exercise_id",
  "set_type",
  "section",
  "tracking",
  "superset_group",
  "load_entry",
] as const;
const shape = (r: Row) => STRUCTURE.map((k) => r[k]);

const workout = {
  id: "w1",
  program_id: "p1",
  day_index: 0,
  label: "Lower",
  notes: null,
  plan_note: null,
  scheduled_date: "2026-10-05",
} as unknown as PlannedWorkoutRow;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  tables.planned_workouts = [
    { id: "w1", program_id: "p1", day_index: 0, label: "Lower" },
  ];
  tables.prescriptions = dayRows("w1");
});

const inserted = (table: string) =>
  calls.filter((c) => c.table === table).flatMap((c) => c.rows);

describe("PLAN-1: duplicating a day keeps its structure", () => {
  it("copies set_type, section, tracking and superset_group", async () => {
    const newId = await duplicatePlannedWorkout(workout, "2026-10-12");
    const copied = inserted("prescriptions");
    expect(copied.map(shape)).toEqual(dayRows("w1").map(shape));
    expect(copied.every((r) => r.planned_workout_id === newId)).toBe(true);
  });

  it("writes every defaulted column on every row (bulk-insert NULL union)", async () => {
    // a source row cached without the optional columns must not leave a key out
    tables.prescriptions = [
      {
        planned_workout_id: "w1",
        exercise_id: "squat",
        position: 0,
        sets: 3,
        reps_min: 5,
        reps_max: 5,
        load_kg: 100,
        load_pct_tm: null,
        rest_seconds: null,
        notes: null,
      },
      ...dayRows("w1")
        .slice(0, 1)
        .map((r) => ({ ...r, position: 1 })),
    ];
    await duplicatePlannedWorkout(workout, null);
    const copied = inserted("prescriptions");
    expect(copied[0]).toMatchObject({
      set_type: "working",
      tracking: "reps",
      section: null,
      superset_group: null,
    });
    expect(
      new Set(copied.map((r) => Object.keys(r).sort().join())),
    ).toHaveProperty("size", 1);
  });
});

describe("PLAN-2: template round trip keeps its structure", () => {
  it("save then apply reproduces superset, section, set_type and tracking", async () => {
    const rx = dayRows("w1").map((r, i) => ({
      ...r,
      id: `r${i}`,
      exercise_name: "x",
    })) as unknown as ResolvedPrescriptionRow[];
    const tplId = await saveWorkoutAsTemplate(workout, "Lower A", rx);

    const saved = tables.prescriptions!.filter(
      (r) => r.planned_workout_id === tplId,
    );
    expect(saved.map(shape)).toEqual(dayRows("w1").map(shape));

    const res = await applyTemplate(tplId, "p1", "2026-10-19", {});
    const applied = tables.prescriptions!.filter(
      (r) => r.planned_workout_id === res.workoutId,
    );
    expect(applied.map(shape)).toEqual(dayRows("w1").map(shape));
    expect(
      new Set(applied.map((r) => Object.keys(r).sort().join())),
    ).toHaveProperty("size", 1);
  });
});

describe("PLAN-4: a template needs a program, not a throwaway day", () => {
  it("creates only the program when none exists", async () => {
    tables.programs = [];
    const id = await ensureConfirmedProgramId();
    expect(inserted("programs")).toHaveLength(1);
    expect(inserted("programs")[0]).toMatchObject({ id });
    expect(inserted("planned_workouts")).toHaveLength(0);
  });

  it("reuses the newest confirmed program", async () => {
    tables.programs = [
      { id: "p9", confirmed_at: "x", discarded_at: null, created_at: "1" },
    ];
    expect(await ensureConfirmedProgramId()).toBe("p9");
    expect(inserted("programs")).toHaveLength(0);
  });
});
