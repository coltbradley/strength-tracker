import { describe, expect, it } from "vitest";
import {
  ACTUALS_PAGE,
  currentTrainingMax,
  groupTrainingMaxes,
  orderLoggedExercises,
  resolveSessionSetCount,
  scanLastActuals,
  scanLoggedExercises,
  summariseAdherence,
  type ActualsRow,
} from "./data";
import type { AdherenceRow, TrainingMaxRow } from "./types";

const row = (over: Partial<ActualsRow>): ActualsRow => ({
  exercise_id: "squat",
  load_kg: 100,
  reps: 5,
  set_type: "working",
  performed_at: "2026-08-24T10:00:00.000Z",
  session_id: "s1",
  ...over,
});

/** desc-ordered rows, newest first, one second apart */
function series(specs: Array<Partial<ActualsRow>>): ActualsRow[] {
  return specs.map((sp, i) =>
    row({
      performed_at: new Date(
        Date.UTC(2026, 7, 24, 10, 0, 1000 - i),
      ).toISOString(),
      ...sp,
    }),
  );
}

/** page a fixed desc-ordered list the way the real keyset query does */
function pager(all: ActualsRow[]) {
  let calls = 0;
  const fetchPage = async (cursor: string | null) => {
    calls++;
    const rest =
      cursor === null ? all : all.filter((r) => r.performed_at < cursor);
    return rest.slice(0, ACTUALS_PAGE);
  };
  return { fetchPage, pages: () => calls };
}

describe("scanLastActuals", () => {
  it("takes the most recent working set per exercise", async () => {
    const p = pager(
      series([
        { exercise_id: "squat", load_kg: 140, reps: 3 },
        { exercise_id: "bench", load_kg: 90, reps: 5 },
        { exercise_id: "squat", load_kg: 120, reps: 5 },
      ]),
    );
    const out = await scanLastActuals(p.fetchPage);
    expect(out.squat).toEqual({ load_kg: 140, reps: 3 });
    expect(out.bench).toEqual({ load_kg: 90, reps: 5 });
  });

  it("falls back to any set type when an exercise has no working set", async () => {
    const p = pager(
      series([
        { exercise_id: "curl", set_type: "warmup", load_kg: 15, reps: 12 },
        { exercise_id: "curl", set_type: "warmup", load_kg: 12, reps: 12 },
      ]),
    );
    const out = await scanLastActuals(p.fetchPage);
    expect(out.curl).toEqual({ load_kg: 15, reps: 12 });
  });

  it("prefers a working set over a more recent warmup", async () => {
    const p = pager(
      series([
        { exercise_id: "squat", set_type: "warmup", load_kg: 60, reps: 5 },
        { exercise_id: "squat", set_type: "working", load_kg: 140, reps: 3 },
      ]),
    );
    const out = await scanLastActuals(p.fetchPage);
    expect(out.squat).toEqual({ load_kg: 140, reps: 3 });
  });

  it("skips the excluded session", async () => {
    const p = pager(
      series([
        { exercise_id: "squat", session_id: "current", load_kg: 999, reps: 1 },
        { exercise_id: "squat", session_id: "old", load_kg: 140, reps: 3 },
      ]),
    );
    const out = await scanLastActuals(p.fetchPage, "current");
    expect(out.squat).toEqual({ load_kg: 140, reps: 3 });
  });

  // the regression this replaces: a single capped read stopped at 1000 sets,
  // so anything trained longer ago than ~35 sessions vanished from prefill
  // AND from History's exercise index, with no error anywhere
  it("walks past the page size to reach an old exercise", async () => {
    const filler = Array.from({ length: ACTUALS_PAGE * 2 }, (_, i) => ({
      exercise_id: `filler${i % 40}`,
    }));
    const p = pager(series([...filler, { exercise_id: "ancient_lift" }]));
    const out = await scanLastActuals(p.fetchPage);
    expect(out.ancient_lift).toBeDefined();
    expect(p.pages()).toBeGreaterThan(1);
  });

  it("stops on a short page instead of asking again", async () => {
    const p = pager(series([{ exercise_id: "squat" }]));
    await scanLastActuals(p.fetchPage);
    expect(p.pages()).toBe(1);
  });

  it("stops rather than looping when the cursor cannot advance", async () => {
    // every row shares one timestamp: the next page could never be narrower
    const stuck = Array.from({ length: ACTUALS_PAGE }, (_, i) =>
      row({ exercise_id: `e${i}`, performed_at: "2026-08-24T10:00:00.000Z" }),
    );
    let calls = 0;
    const out = await scanLastActuals(async () => {
      calls++;
      return stuck;
    });
    expect(calls).toBe(2);
    expect(Object.keys(out)).toHaveLength(ACTUALS_PAGE);
  });

  it("returns nothing for an empty log", async () => {
    expect(await scanLastActuals(async () => [])).toEqual({});
  });
});

// Losing a real session from the End screen is unrecoverable in the UI, so
// "this session is empty" has to be a fact, not the absence of a cache.
describe("resolveSessionSetCount", () => {
  it("trusts a local count above zero without asking the server", () => {
    expect(resolveSessionSetCount(7, null)).toEqual({
      count: 7,
      authoritative: true,
    });
  });

  it("treats an unconfirmed local zero as unknown", () => {
    expect(resolveSessionSetCount(0, null)).toEqual({
      count: 0,
      authoritative: false,
    });
  });

  it("confirms empty only when the server agrees", () => {
    expect(resolveSessionSetCount(0, 0)).toEqual({
      count: 0,
      authoritative: true,
    });
  });

  it("uses the server count when the device cache is cold", () => {
    // the adopted-orphan case: real sets exist, this phone has never seen them
    expect(resolveSessionSetCount(0, 12)).toEqual({
      count: 12,
      authoritative: true,
    });
  });
});

// ---- training maxes --------------------------------------------------------

const tm = (
  id: string,
  effective_date: string,
  value_kg = 100,
  exercise_id = "squat",
): TrainingMaxRow => ({ id, exercise_id, value_kg, effective_date });

describe("currentTrainingMax", () => {
  it("takes the latest effective date, not the last row read", () => {
    // deliberately out of order: PostgREST ordering is not a guarantee the
    // resolver may lean on
    const rows = [tm("a", "2026-06-01", 130), tm("b", "2026-08-06", 137.5)];
    expect(currentTrainingMax(rows, "2026-08-27")?.id).toBe("b");
    expect(currentTrainingMax([...rows].reverse(), "2026-08-27")?.id).toBe("b");
  });

  it("ignores a future-dated value until its day arrives", () => {
    // the whole reason this is not `max(effective_date)`: a TM the user dated
    // for next Monday must not silently become today's number
    const rows = [
      tm("now", "2026-08-01", 137.5),
      tm("next", "2026-09-01", 145),
    ];
    expect(currentTrainingMax(rows, "2026-08-27")?.id).toBe("now");
    expect(currentTrainingMax(rows, "2026-09-01")?.id).toBe("next");
  });

  it("returns null when every value is still in the future", () => {
    expect(
      currentTrainingMax([tm("x", "2026-09-01")], "2026-08-27"),
    ).toBeNull();
  });

  it("returns null for an exercise with no rows", () => {
    expect(currentTrainingMax([], "2026-08-27")).toBeNull();
  });
});

describe("groupTrainingMaxes", () => {
  it("groups per exercise, newest effective date first", () => {
    const grouped = groupTrainingMaxes([
      tm("s1", "2026-06-01", 130, "squat"),
      tm("b1", "2026-07-01", 100, "bench"),
      tm("s2", "2026-08-01", 137.5, "squat"),
    ]);
    expect(grouped.get("squat")?.map((r) => r.id)).toEqual(["s2", "s1"]);
    expect(grouped.get("bench")?.map((r) => r.id)).toEqual(["b1"]);
  });
});

// ---- adherence -------------------------------------------------------------

const adh = (over: Partial<AdherenceRow>): AdherenceRow => ({
  set_id: "set-1",
  session_id: "sess-1",
  exercise_id: "squat",
  prescription_id: "rx-1",
  set_index: 0,
  performed_at: "2026-08-24T10:00:00.000Z",
  actual_load_kg: 100,
  actual_reps: 5,
  reps_min: 3,
  reps_max: 5,
  prescribed_load_kg: 100,
  load_delta_kg: 0,
  rep_outcome: "hit",
  actual_load_entry: "total",
  prescribed_load_entry: "total",
  ...over,
});

describe("summariseAdherence", () => {
  it("folds sets onto the prescription they answered", () => {
    const out = summariseAdherence({
      rows: [
        adh({ set_id: "a", set_index: 0 }),
        adh({ set_id: "b", set_index: 1 }),
      ],
      plannedSets: { "rx-1": 3 },
    });
    expect(out.get("sess-1")).toEqual([
      {
        prescriptionId: "rx-1",
        repsMin: 3,
        repsMax: 5,
        prescribedLoadKg: 100,
        prescribedEntry: "total",
        plannedSets: 3,
        loggedSets: 2,
        firstIndex: 0,
        entryAmbiguous: false,
      },
    ]);
  });

  it("orders a ramp by the set index each bracket first appeared at", () => {
    const out = summariseAdherence({
      rows: [
        adh({ set_id: "c", prescription_id: "rx-3", set_index: 5 }),
        adh({ set_id: "a", prescription_id: "rx-1", set_index: 1 }),
        adh({ set_id: "b", prescription_id: "rx-2", set_index: 3 }),
      ],
      plannedSets: {},
    });
    expect(out.get("sess-1")?.map((o) => o.prescriptionId)).toEqual([
      "rx-1",
      "rx-2",
      "rx-3",
    ]);
  });

  it("keeps sessions apart", () => {
    const out = summariseAdherence({
      rows: [adh({ session_id: "s1" }), adh({ session_id: "s2" })],
      plannedSets: {},
    });
    expect([...out.keys()].sort()).toEqual(["s1", "s2"]);
  });

  it("reports a per-side plan against an unasserted set as incomparable", () => {
    // NULL is "not asserted", never "total": the logged number may be per
    // hand, so the two loads may not be on the same scale
    const out = summariseAdherence({
      rows: [
        adh({ prescribed_load_entry: "per_side", actual_load_entry: null }),
      ],
      plannedSets: {},
    });
    expect(out.get("sess-1")?.[0].entryAmbiguous).toBe(true);
  });

  it("reports an unasserted plan against a per-side set as incomparable", () => {
    const out = summariseAdherence({
      rows: [
        adh({ prescribed_load_entry: null, actual_load_entry: "per_side" }),
      ],
      plannedSets: {},
    });
    expect(out.get("sess-1")?.[0].entryAmbiguous).toBe(true);
  });

  it("does not cry ambiguity when both sides assert the same convention", () => {
    for (const mode of ["total", "per_side"] as const) {
      const out = summariseAdherence({
        rows: [adh({ prescribed_load_entry: mode, actual_load_entry: mode })],
        plannedSets: {},
      });
      expect(out.get("sess-1")?.[0].entryAmbiguous).toBe(false);
    }
  });

  it("does not cry ambiguity when neither side asserts anything", () => {
    // both rows predate the convention; nothing is KNOWN to differ, so the
    // app says nothing rather than manufacturing a warning on every old row
    const out = summariseAdherence({
      rows: [adh({ prescribed_load_entry: null, actual_load_entry: null })],
      plannedSets: {},
    });
    expect(out.get("sess-1")?.[0].entryAmbiguous).toBe(false);
  });

  it("marks the group ambiguous if any one set in it is", () => {
    const out = summariseAdherence({
      rows: [
        adh({
          set_id: "a",
          prescribed_load_entry: "per_side",
          actual_load_entry: "per_side",
        }),
        adh({
          set_id: "b",
          set_index: 1,
          prescribed_load_entry: "per_side",
          actual_load_entry: null,
        }),
      ],
      plannedSets: {},
    });
    expect(out.get("sess-1")?.[0].entryAmbiguous).toBe(true);
  });

  it("leaves plannedSets null when the prescription's set count is unknown", () => {
    const out = summariseAdherence({ rows: [adh({})], plannedSets: {} });
    expect(out.get("sess-1")?.[0].plannedSets).toBeNull();
  });
});

// ---- logged-exercise index -------------------------------------------------
// History only ever wanted "which exercises have data". It used to get that
// by paging every set ever logged and throwing away all but the keys.

/** Page an exercise_id-ordered list the way the real keyset query does:
 *  `exercise_id > cursor`, so the cursor skips the rest of the id it ends on. */
function idPager(all: string[], pageSize = ACTUALS_PAGE) {
  const sorted = [...all].sort();
  let calls = 0;
  let rowsRead = 0;
  const fetchPage = async (cursor: string | null) => {
    calls++;
    const rest = cursor === null ? sorted : sorted.filter((id) => id > cursor);
    const page = rest
      .slice(0, pageSize)
      .map((exercise_id) => ({ exercise_id }));
    rowsRead += page.length;
    return page;
  };
  return { fetchPage, pages: () => calls, rowsRead: () => rowsRead };
}

describe("scanLoggedExercises", () => {
  it("returns each exercise once, however many sets it has", async () => {
    const p = idPager(["bench", "bench", "bench", "squat", "squat"]);
    expect((await scanLoggedExercises(p.fetchPage)).sort()).toEqual([
      "bench",
      "squat",
    ]);
  });

  it("returns nothing for an empty history", async () => {
    const p = idPager([]);
    expect(await scanLoggedExercises(p.fetchPage)).toEqual([]);
    expect(p.pages()).toBe(1);
  });

  it("reads one page when the history fits in one", async () => {
    const p = idPager(Array.from({ length: 300 }, () => "squat"));
    await scanLoggedExercises(p.fetchPage);
    expect(p.pages()).toBe(1);
  });

  it("SKIPS the rest of an exercise once seen — the point of the cursor", async () => {
    // 3 pages of squat then one deadlift: paging on exercise_id means the
    // second request starts past every squat row, not one row later
    const all = [
      ...Array.from({ length: ACTUALS_PAGE * 3 }, () => "squat"),
      "zdeadlift",
    ];
    const p = idPager(all);
    expect((await scanLoggedExercises(p.fetchPage)).sort()).toEqual([
      "squat",
      "zdeadlift",
    ]);
    expect(p.pages()).toBe(2);
    expect(p.rowsRead()).toBe(ACTUALS_PAGE + 1);
  });

  it("stops on a page that cannot advance the cursor", async () => {
    // a pathological server that keeps returning the same boundary row
    let calls = 0;
    const stuck = async () => {
      calls++;
      return Array.from({ length: ACTUALS_PAGE }, () => ({
        exercise_id: "squat",
      }));
    };
    expect(await scanLoggedExercises(stuck)).toEqual(["squat"]);
    expect(calls).toBe(2);
  });
});

describe("orderLoggedExercises", () => {
  it("puts the most recently trained lift first", async () => {
    expect(orderLoggedExercises(["bench", "row", "squat"], "squat")).toEqual([
      "squat",
      "bench",
      "row",
    ]);
  });

  it("leaves the order alone when there is no recent lift to lead with", () => {
    expect(orderLoggedExercises(["bench", "row"], null)).toEqual([
      "bench",
      "row",
    ]);
    expect(orderLoggedExercises(["bench", "row"], "curl")).toEqual([
      "bench",
      "row",
    ]);
  });
});
