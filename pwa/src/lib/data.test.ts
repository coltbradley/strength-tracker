import { describe, expect, it } from "vitest";
import {
  ACTUALS_PAGE,
  resolveSessionSetCount,
  scanLastActuals,
  type ActualsRow,
} from "./data";

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
