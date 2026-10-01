//   deno test --allow-env --allow-net tools/repeat_planned_workout.test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { toolHarness } from "../lib/testing.ts";
import { registerRepeatPlannedWorkout } from "./repeat_planned_workout.ts";

const DAY = "22222222-0000-4000-8000-000000000001";

const invalidStoredPair = (exercise_id: string) => ({
  exercise_id,
  position: 0,
  sets: 3,
  reps_min: 8,
  reps_max: 8,
  load_kg: null,
  load_pct_tm: null,
  load_entry: null,
  rest_seconds: null,
  notes: null,
  superset_group: 1,
  section: null,
  set_type: "working",
  tracking: "reps",
});

Deno.test(
  "repeat refuses an invalid stored superset before inserting a new day",
  async () => {
    const t = toolHarness(
      registerRepeatPlannedWorkout,
      "repeat_planned_workout",
      {
        planned_workouts: [{
          id: DAY,
          label: "Pull",
          notes: null,
          scheduled_date: "2026-09-20",
          is_template: false,
          programs: {
            id: "33333333-0000-4000-8000-000000000001",
            name: "Four Day Split",
            confirmed_at: null,
          },
          day_index: 2,
        }],
        prescriptions: [
          invalidStoredPair("Barbell_Row"),
          invalidStoredPair("Barbell_Row"),
        ],
        exercises: [{
          id: "Barbell_Row",
          source: "curated",
          exercise_owners: null,
        }],
        sessions: [],
      },
    );

    const result = await t.run({
      planned_workout_id: DAY,
      scheduled_date: "2026-09-23",
    });

    assertEquals(
      t.calls.some((call) => call.table === "planned_workouts" && call.insert),
      false,
      "the invalid stored group must be rejected before creating the repeated day",
    );
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "two distinct exercises");
  },
);

// The authored pair of a replaced load comes from lib/setLoad.ts, the one
// derivation (byte-identical to the PWA's), not from a hand division. 33 lb a
// side is 29.94 kg total; the old hand-rolled quotient wrote 33.001.
Deno.test(
  "repeat re-derives a replaced load's authored pair through buildSetLoad",
  async () => {
    const NEW_DAY = "22222222-0000-4000-8000-0000000000aa";
    const row = (load_kg: number, entered_load: number) => ({
      exercise_id: "Dumbbell_Row",
      position: 0,
      sets: 3,
      reps_min: 8,
      reps_max: 8,
      load_kg,
      load_pct_tm: null,
      load_entry: "per_side",
      entered_load,
      entered_unit: "lb",
      rest_seconds: null,
      notes: null,
      superset_group: null,
      section: null,
      set_type: "working",
      tracking: "reps",
    });
    const t = toolHarness(
      registerRepeatPlannedWorkout,
      "repeat_planned_workout",
      {
        planned_workouts: [{
          id: NEW_DAY,
          label: "Pull",
          notes: null,
          scheduled_date: "2026-09-20",
          is_template: false,
          programs: {
            id: "33333333-0000-4000-8000-000000000001",
            name: "Four Day Split",
            confirmed_at: null,
          },
          day_index: 2,
        }],
        // 30 lb a side = 27.22 kg total
        prescriptions: [row(27.22, 30)],
        exercises: [{
          id: "Dumbbell_Row",
          source: "curated",
          exercise_owners: null,
        }],
        sessions: [{
          id: "44444444-0000-4000-8000-000000000001",
          planned_workout_id: NEW_DAY,
          started_at: "2026-09-20T10:00:00Z",
          ended_at: null,
          session_rpe: null,
          notes: null,
        }],
        v_live_sets: [{
          id: "55555555-0000-4000-8000-000000000001",
          session_id: "44444444-0000-4000-8000-000000000001",
          exercise_id: "Dumbbell_Row",
          set_index: 0,
          set_type: "working",
          // 33 lb a side, as the PWA stores it
          load_kg: 29.94,
          load_entry: "per_side",
          reps: 8,
          performed_at: "2026-09-20T10:05:00Z",
          entered_load: 33,
          entered_unit: "lb",
        }],
      },
    );

    const result = await t.run({
      planned_workout_id: NEW_DAY,
      scheduled_date: "2026-09-27",
    });
    assertEquals(result.isError ?? false, false, result.content[0].text);
    const insert = t.calls.find((c) => c.table === "prescriptions" && c.insert);
    const [written] = insert!.insert as Record<string, unknown>[];
    assertEquals(written.load_kg, 29.94);
    assertEquals(written.load_entry, "per_side");
    assertEquals(written.entered_unit, "lb");
    assertEquals(written.entered_load, 33);
  },
);

Deno.test(
  "repeat keeps the kg total and drops the authored pair when no typed number reproduces it",
  async () => {
    const DAY2 = "22222222-0000-4000-8000-0000000000bb";
    const t = toolHarness(
      registerRepeatPlannedWorkout,
      "repeat_planned_workout",
      {
        planned_workouts: [{
          id: DAY2,
          label: "Pull",
          notes: null,
          scheduled_date: "2026-09-20",
          is_template: false,
          programs: {
            id: "33333333-0000-4000-8000-000000000001",
            name: "Four Day Split",
            confirmed_at: null,
          },
          day_index: 2,
        }],
        prescriptions: [{
          exercise_id: "Dumbbell_Row",
          position: 0,
          sets: 3,
          reps_min: 8,
          reps_max: 8,
          load_kg: 27.22,
          load_pct_tm: null,
          load_entry: "per_side",
          entered_load: 30,
          entered_unit: "lb",
          rest_seconds: null,
          notes: null,
          superset_group: null,
          section: null,
          set_type: "working",
          tracking: "reps",
        }],
        exercises: [{ id: "Dumbbell_Row", source: "curated", exercise_owners: null }],
        sessions: [{
          id: "44444444-0000-4000-8000-000000000002",
          planned_workout_id: DAY2,
          started_at: "2026-09-20T10:00:00Z",
          ended_at: null,
          session_rpe: null,
          notes: null,
        }],
        // a total that is not a one-decimal lb number per side
        v_live_sets: [{
          id: "55555555-0000-4000-8000-000000000002",
          session_id: "44444444-0000-4000-8000-000000000002",
          exercise_id: "Dumbbell_Row",
          set_index: 0,
          set_type: "working",
          load_kg: 30.01,
          load_entry: "total",
          reps: 8,
          performed_at: "2026-09-20T10:05:00Z",
          entered_load: null,
          entered_unit: null,
        }],
      },
    );
    const result = await t.run({ planned_workout_id: DAY2, scheduled_date: "2026-09-27" });
    assertEquals(result.isError ?? false, false, result.content[0].text);
    const insert = t.calls.find((c) => c.table === "prescriptions" && c.insert);
    const [written] = insert!.insert as Record<string, unknown>[];
    assertEquals(written.load_kg, 30.01);
    assertEquals(written.entered_load, null);
    assertEquals(written.entered_unit, null);
  },
);
