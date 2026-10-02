//   deno test --allow-env --allow-net tools/find_similar_days.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import { payload, toolHarness } from "../lib/testing.ts";
import { registerFindSimilarDays } from "./find_similar_days.ts";

Deno.test("MCP-4: find_similar_days chunks its day-id reads and still matches across chunks", async () => {
  const days = Array.from({ length: 250 }, (_, i) => ({
    id: `d-${i}`,
    program_id: "prog-1",
    day_index: i,
    label: `Day ${i}`,
    scheduled_date: null,
    notes: null,
    exercise_count: 1,
  }));
  const t = toolHarness(registerFindSimilarDays, "find_similar_days", {
    v_plan_workouts: days,
    // The match lives in the LAST chunk, so a read that dropped later chunks
    // would find nothing.
    prescriptions: [{
      planned_workout_id: "d-249",
      exercise_id: "Barbell_Squat",
      position: 0,
    }],
    programs: [{ id: "prog-1", name: "Split", confirmed_at: null }],
    exercises: [{ id: "Barbell_Squat", name: "Barbell Squat" }],
    sessions: [],
  });
  const body = payload(await t.run({ exercise_ids: ["Barbell_Squat"] }));
  assertEquals(body.data.matches.length, 1);
  assertEquals(body.data.matches[0].planned_workout_id, "d-249");
  const rxCalls = t.calls.filter((c) => c.table === "prescriptions");
  assertEquals(rxCalls.length, 3);
  for (const c of rxCalls) {
    const f = c.filters.find((x) => x.startsWith("in:"))!;
    assertEquals(f.slice(f.indexOf("=") + 1).split(",").length <= 100, true);
  }
});
