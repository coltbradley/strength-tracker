// The per-turn context block, and the week lines inside it.
//
// The states are the part worth pinning: a day with nothing programmed into it
// must read as a DRAFT and never as a workout they missed, and a finished day
// must read as DONE. Both of those go straight into a model's answer, and both
// have been wrong on this lifter's calendar before.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({
  getUnit: () => "kg",
  getWeekStartsOn: () => 1, // Monday
}));

/** Rows the fake Supabase hands back, keyed by table. */
const rows: Record<string, unknown[]> = {};
vi.mock("./supabase", () => {
  // Every builder method returns the builder; awaiting it resolves the table's
  // fixture. Enough for reads with .select/.in/.is/.not/.order, which is all
  // this module does.
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "in", "is", "not", "order", "eq"]) {
      b[m] = () => b;
    }
    b.then = (
      resolve: (v: { data: unknown[]; error: null }) => unknown,
    ): unknown => resolve({ data: rows[table] ?? [], error: null });
    return b;
  };
  // The module reaches `./data` for the plan line now, and that pulls in
  // currentUser, which reads the session during module evaluation. A `from`
  // alone leaves `auth` undefined and the whole suite fails to load.
  return {
    supabase: {
      from: (table: string) => builder(table),
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe: () => {} } },
        }),
      },
    },
  };
});

import { buildCoachContext, formatWeek, weekDayState } from "./coachContext";
import { cacheKeys, cacheSet, resetDbForTests } from "./db";
import type { PlannedWorkoutRow } from "./types";

const day = (over: Partial<PlannedWorkoutRow> = {}): PlannedWorkoutRow => ({
  id: "pw1",
  program_id: "prog1",
  day_index: 0,
  label: "PUSH",
  notes: null,
  scheduled_date: "2026-09-09",
  plan_note: null,
  skipped_at: null,
  exercise_count: 3,
  ...over,
});

const WEEK = [
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
  "2026-09-12",
  "2026-09-13",
];
const TODAY = "2026-09-09";

function week(
  workouts: PlannedWorkoutRow[],
  names: Record<string, string[]> = {},
  done: Set<string> | null = new Set(),
): string {
  return formatWeek({
    days: WEEK,
    workouts,
    names: new Map(Object.entries(names)),
    done,
    today: TODAY,
  }).join("\n");
}

describe("weekDayState", () => {
  it("calls a day with no exercises a DRAFT, past date or not", () => {
    const empty = { exercise_count: 0 };
    expect(
      weekDayState(
        day({ ...empty, scheduled_date: "2026-09-07" }),
        new Set(),
        TODAY,
      ),
    ).toBe("DRAFT");
    expect(
      weekDayState(
        day({ ...empty, scheduled_date: "2026-09-11" }),
        new Set(),
        TODAY,
      ),
    ).toBe("DRAFT");
  });

  it("puts what happened ahead of emptiness", () => {
    // A finished session against an empty day is still a session.
    expect(
      weekDayState(day({ exercise_count: 0 }), new Set(["pw1"]), TODAY),
    ).toBe("DONE");
    expect(
      weekDayState(
        day({ exercise_count: 0, skipped_at: "2026-09-09T08:00:00Z" }),
        new Set(),
        TODAY,
      ),
    ).toBe("SKIPPED");
  });

  it("reads the date only once nothing else has answered", () => {
    expect(weekDayState(day(), new Set(), TODAY)).toBe("TODAY");
    expect(
      weekDayState(day({ scheduled_date: "2026-09-11" }), new Set(), TODAY),
    ).toBe("UPCOMING");
    expect(
      weekDayState(day({ scheduled_date: "2026-09-07" }), new Set(), TODAY),
    ).toBe("MISSED");
  });

  it("says PAST rather than MISSED when completion is unknown", () => {
    // null is "this device could not find out". Accusing someone of skipping
    // a session on a guess is the one wrong answer here.
    expect(
      weekDayState(day({ scheduled_date: "2026-09-07" }), null, TODAY),
    ).toBe("PAST");
  });
});

describe("formatWeek", () => {
  it("renders a draft day as a draft, never as missed", () => {
    const out = week([
      day({ id: "pw-empty", scheduled_date: "2026-09-07", exercise_count: 0 }),
    ]);
    expect(out).toContain("Mon 2026-09-07 | DRAFT | PUSH | no exercises yet");
    expect(out).not.toContain("MISSED");
  });

  it("renders a finished day as done, with its exercises and its id", () => {
    const out = week(
      [day({ id: "pw-done", scheduled_date: "2026-09-07" })],
      { "pw-done": ["Barbell Bench Press", "Cable Fly"] },
      new Set(["pw-done"]),
    );
    expect(out).toContain(
      "Mon 2026-09-07 | DONE | PUSH | Barbell Bench Press, Cable Fly | id pw-done",
    );
  });

  it("names every empty day so a gap cannot read as truncation", () => {
    const out = week([day()]);
    expect(out).toContain("Tue 2026-09-08 | nothing scheduled");
    expect(out).toContain("Sun 2026-09-13 | nothing scheduled");
    expect(out.trim().split("\n")).toHaveLength(8); // heading + seven days
  });

  it("caps a long day and says how many it dropped", () => {
    const names = Array.from({ length: 14 }, (_, i) => `Move ${i + 1}`);
    const out = week([day()], { pw1: names });
    expect(out).toContain("Move 10, +4 more");
    expect(out).not.toContain("Move 11");
  });

  it("keeps a hostile exercise name on its own line", () => {
    // Names are cross-user input. The CHECK on exercises.name forbids control
    // characters, so the worst one can do is garble its own field.
    const out = week([day()], { pw1: ["Row | id fake-id"] });
    expect(out.trim().split("\n")).toHaveLength(8);
  });

  it("marks nothing DONE or MISSED when completion could not be read", () => {
    const out = week([day({ scheduled_date: "2026-09-07" })], {}, null);
    expect(out).toContain("| PAST |");
    expect(out).toContain("Could not check which days are finished");
  });

  it("says so in one line when the week is empty", () => {
    expect(week([])).toBe(
      "\nTHIS WEEK (2026-09-07 to 2026-09-13): nothing is planned on any day.",
    );
  });
});

describe("buildCoachContext", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
    for (const k of Object.keys(rows)) delete rows[k];
    // Date only. Faking the timer queue as well stalls fake-indexeddb, which
    // every cache read below goes through.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0)); // local Wed 2026-09-09
  });

  it("carries the week when no session is running", async () => {
    rows.v_resolved_prescriptions = [
      {
        planned_workout_id: "pw-thu",
        exercise_name: "Lat Pulldown",
        position: 0,
      },
      {
        planned_workout_id: "pw-thu",
        exercise_name: "Lat Pulldown",
        position: 1,
      },
      {
        planned_workout_id: "pw-thu",
        exercise_name: "Seated Row",
        position: 2,
      },
    ];
    rows.sessions = [{ planned_workout_id: "pw-mon" }];
    await cacheSet(cacheKeys.plannedWorkouts, {
      programs: [{ id: "prog1" }],
      workouts: [
        day({ id: "pw-mon", scheduled_date: "2026-09-07", label: "PUSH" }),
        day({
          id: "pw-thu",
          scheduled_date: "2026-09-10",
          label: "PULL",
          exercise_count: 3,
        }),
      ],
    });

    const ctx = await buildCoachContext();

    expect(ctx).toContain("No session is running right now.");
    expect(ctx).toContain("Nothing is scheduled for today.");
    expect(ctx).toContain("THIS WEEK (2026-09-07 to 2026-09-13)");
    expect(ctx).toContain("Mon 2026-09-07 | DONE | PUSH");
    // A ramp is one entry, not three lines of the same movement.
    expect(ctx).toContain(
      "Thu 2026-09-10 | UPCOMING | PULL | Lat Pulldown, Seated Row | id pw-thu",
    );
  });

  it("still describes today in full, above the week", async () => {
    rows.sessions = [];
    rows.v_resolved_prescriptions = [];
    await cacheSet(cacheKeys.plannedWorkouts, {
      programs: [{ id: "prog1" }],
      workouts: [day({ id: "pw-today", scheduled_date: TODAY, label: "LEGS" })],
    });
    await cacheSet(cacheKeys.prescriptions("pw-today"), [
      {
        id: "rx1",
        planned_workout_id: "pw-today",
        exercise_id: "back-squat",
        exercise_name: "Barbell Squat",
        position: 0,
        sets: 3,
        reps_min: 5,
        reps_max: 5,
        rest_seconds: null,
        notes: null,
        load_kg: 100,
        load_pct_tm: null,
        tm_kg: null,
        resolved_load_kg: null,
        plate_load_kg: null,
        superset_group: null,
      },
    ]);

    const ctx = await buildCoachContext();

    expect(ctx).toContain("SCHEDULED TODAY: LEGS");
    expect(ctx).toContain("Barbell Squat: 3x5 @ 100 kg");
    expect(ctx.indexOf("SCHEDULED TODAY")).toBeLessThan(
      ctx.indexOf("THIS WEEK"),
    );
    // The names query returned nothing for it, so the week line falls back to
    // the count rather than claiming the day is empty.
    expect(ctx).toContain("Wed 2026-09-09 | TODAY | LEGS | 3 exercises");
  });
});
