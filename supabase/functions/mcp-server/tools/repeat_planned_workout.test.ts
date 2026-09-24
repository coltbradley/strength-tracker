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
