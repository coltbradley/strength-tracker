import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, selects, results } = vi.hoisted(() => ({
  from: vi.fn(),
  selects: [] as { table: string; columns: string }[],
  results: new Map<
    string,
    { data: unknown[] | null; error: { message: string } | null }
  >(),
}));
vi.mock("./supabase", () => ({ supabase: { from } }));
vi.mock("./data", () => ({
  getExercises: async () => ({ data: [{ id: "carry", name: "Farmers Walk" }] }),
}));
vi.mock("./settings", () => ({ exportSettings: () => ({ v: 1, values: {} }) }));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  b.select = (columns: string) => {
    selects.push({ table, columns });
    return b;
  };
  for (const m of ["is", "order", "limit", "or"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown, rej?: (r: unknown) => unknown) =>
    Promise.resolve(results.get(table) ?? { data: [], error: null }).then(
      res,
      rej,
    );
  return b;
}
from.mockImplementation((t: string) => builder(t));

import {
  afterFilter,
  buildExport,
  fetchAllKeyset,
  toCsv,
  type ExportBundle,
  type ExportSet,
} from "./export";

beforeEach(() => {
  selects.length = 0;
  results.clear();
});

const set = (over: Partial<ExportSet> = {}): ExportSet => ({
  id: "s1",
  session_id: "sess",
  exercise_id: "carry",
  prescription_id: "rx1",
  set_index: 0,
  set_type: "working",
  load_kg: 60,
  reps: 0,
  performed_at: "2026-09-01T10:00:00+00:00",
  rest_seconds_actual: null,
  load_entry: "per_side",
  entered_load: 30,
  entered_unit: "kg",
  rpe: 8.5,
  duration_seconds: 45,
  ...over,
});

const bundle = (sets: ExportSet[]): ExportBundle => ({
  exported_at: "x",
  app_version: "t",
  settings: { v: 1, values: {} },
  exercises: { carry: "Farmers Walk" },
  sessions: [],
  sets,
  set_notes: {},
  bodyweight_log: [],
  session_skips: [],
  set_voids: [],
  checkins: [],
  programs: [],
  planned_workouts: [],
  prescriptions: [],
  training_maxes: [],
  training_plans: [],
  plan_phases: [],
  unavailable: [],
});

describe("CORE-10 / UI-04: the CSV keeps what the set actually was", () => {
  it("carries seconds, effort, and how the load was typed", () => {
    const [header, row] = toCsv(bundle([set()])).split("\n");
    const cols = header!.split(",");
    const cells = row!.split(",");
    const at = (name: string) => cells[cols.indexOf(name)];
    expect(at("duration_seconds")).toBe("45");
    expect(at("rpe")).toBe("8.5");
    expect(at("load_entry")).toBe("per_side");
    expect(at("entered_load")).toBe("30");
    expect(at("entered_unit")).toBe("kg");
    expect(at("prescription_id")).toBe("rx1");
    // canonical kg stays the TOTAL beside it
    expect(at("load_kg")).toBe("60");
  });

  it("leaves new columns empty for an old set, and keeps the old ones in place", () => {
    const [header, row] = toCsv(
      bundle([
        set({
          rpe: null,
          duration_seconds: null,
          load_entry: null,
          entered_load: null,
          entered_unit: null,
          prescription_id: null,
        }),
      ]),
    ).split("\n");
    expect(header!.startsWith("session_id,session_started_at")).toBe(true);
    expect(header!.split(",").indexOf("set_note")).toBe(15);
    expect(row!.endsWith(",,,,,,")).toBe(true);
  });

  it("neutralises a leading TAB or CR as well as = + - @", () => {
    const csv = toCsv({
      ...bundle([set()]),
      sessions: [
        {
          id: "sess",
          planned_workout_id: null,
          started_at: "t",
          ended_at: null,
          session_rpe: null,
          bodyweight_kg: null,
          notes: "\t=1+1",
        },
      ],
    });
    expect(csv).toContain("'\t=1+1");
  });
});

describe("CORE-10: keyset paging", () => {
  it("asks for the rows after the last one seen, not for an offset", async () => {
    const afters: (string | null)[] = [];
    const pages = [
      [
        { id: "a", t: "T1" },
        { id: "b", t: "T1" },
      ],
      [{ id: "c", t: "T2" }],
    ];
    const rows = await fetchAllKeyset<{ id: string; t: string }>(
      ["t", "id"],
      async (after) => {
        afters.push(after);
        return { data: pages.shift() ?? [], error: null };
      },
      2,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(afters).toEqual([null, 't.gt."T1",and(t.eq."T1",id.gt."b")']);
  });

  it("quotes values so a timestamp's colon and plus are not filter syntax", () => {
    expect(
      afterFilter(["performed_at", "id"], {
        performed_at: "2026-09-01T10:00:00+00:00",
        id: "s1",
      }),
    ).toBe(
      'performed_at.gt."2026-09-01T10:00:00+00:00",and(performed_at.eq."2026-09-01T10:00:00+00:00",id.gt."s1")',
    );
    expect(afterFilter(["set_id"], { set_id: "x" })).toBe('set_id.gt."x"');
  });

  it("surfaces a read error instead of returning a short archive", async () => {
    await expect(
      fetchAllKeyset(["id"], async () => ({
        data: null,
        error: { message: "boom" },
      })),
    ).rejects.toThrow("boom");
  });
});

describe("CORE-10 / UI-04: the bundle", () => {
  it("selects effort and duration for sets", async () => {
    await buildExport("t");
    const sel = selects.find((s) => s.table === "v_live_sets")!;
    expect(sel.columns).toContain("rpe");
    expect(sel.columns).toContain("duration_seconds");
  });

  it("includes the rest of the record", async () => {
    results.set("bodyweight_log", { data: [{ id: "b1" }], error: null });
    results.set("session_skips", { data: [{ id: "k1" }], error: null });
    results.set("set_voids", { data: [{ set_id: "v1" }], error: null });
    results.set("checkins", { data: [{ id: "c1" }], error: null });
    results.set("programs", { data: [{ id: "p1" }], error: null });
    const b = await buildExport("t");
    expect(b.bodyweight_log).toEqual([{ id: "b1" }]);
    expect(b.session_skips).toEqual([{ id: "k1" }]);
    expect(b.set_voids).toEqual([{ set_id: "v1" }]);
    expect(b.checkins).toEqual([{ id: "c1" }]);
    expect(b.programs).toEqual([{ id: "p1" }]);
    expect(b.unavailable).toEqual([]);
  });

  it("names a table it could not read and still exports the sets", async () => {
    results.set("v_live_sets", { data: [set() as never], error: null });
    results.set("checkins", { data: null, error: { message: "denied" } });
    const b = await buildExport("t");
    expect(b.sets).toHaveLength(1);
    expect(b.checkins).toEqual([]);
    expect(b.unavailable).toEqual(["checkins"]);
  });
});
