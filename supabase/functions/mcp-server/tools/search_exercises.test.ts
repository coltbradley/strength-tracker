//   deno test --allow-env --allow-net tools/search_exercises.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerSearchExercises } from "./search_exercises.ts";

Deno.test(
  "MCP-6: a trained variant past the alphabetical cut is ranked in, not dropped",
  async () => {
    const library = Array.from({ length: 30 }, (_, i) => ({
      id: `Press_${String(i).padStart(2, "0")}`,
      name: `Press ${String(i).padStart(2, "0")}`,
      primary_muscles: ["chest"],
      equipment: "barbell",
      mechanic: null,
      category: "strength",
    }));
    const t = toolHarness(registerSearchExercises, "search_exercises", {
      exercise_owners: [],
      exercises: library,
      // The lifter trains the 25th variant alphabetically.
      v_live_sets: [
        { exercise_id: "Press_24", performed_at: "2026-09-30T10:00:00Z" },
      ],
      exercise_notes: [],
      set_notes: [],
    });
    const body = payload(await t.run({ query: "press", limit: 20 }));
    const exCall = t.calls.find((c) => c.table === "exercises")!;
    assertEquals((exCall.limit ?? 0) > 20, true, "ranked before the cut");
    assertEquals(body.count, 20);
    assertEquals(body.exercises[0].id, "Press_24");
    assertEquals(body.exercises[0].logged_sets, 1);
    const trainedCall = t.calls.find((c) => c.table === "v_live_sets")!;
    assertEquals(trainedCall.filters.includes(`eq:user_id=${TEST_USER}`), true);
  },
);
