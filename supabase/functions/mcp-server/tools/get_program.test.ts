//   deno test --allow-env --allow-net tools/get_program.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetProgram } from "./get_program.ts";

Deno.test("MCP-13: get_program returns every prescription of a long program (past the 1000-row cap, and 100 day ids per request)", async () => {
  const days = Array.from({ length: 130 }, (_, i) => ({
    id: `d-${i}`,
    day_index: i,
    label: `Day ${i}`,
    scheduled_date: null,
    notes: null,
    plan_note: null,
  }));
  // 130 days x 8 = 1040 rows: more than one PostgREST page.
  const rx = days.flatMap((d) =>
    Array.from({ length: 8 }, (_, p) => ({
      id: `${d.id}-r${p}`,
      planned_workout_id: d.id,
      position: p,
      exercise_id: "Barbell_Squat",
    }))
  );
  const t = toolHarness(registerGetProgram, "get_program", {
    programs: [{
      id: "prog-1",
      name: "Long",
      source_note: null,
      created_at: "2026-01-01T00:00:00Z",
      confirmed_at: "2026-01-01T00:00:00Z",
      phase_id: null,
      training_plan_phases: null,
    }],
    v_plan_workouts: days,
    v_resolved_prescriptions: rx,
  });
  const body = payload(await t.run({}));
  assertEquals(body.metadata.workout_count, 130);
  assertEquals(body.metadata.prescription_count, 1040);
  const rxCalls = t.calls.filter((c) => c.table === "v_resolved_prescriptions");
  for (const c of rxCalls) {
    const f = c.filters.find((x) => x.startsWith("in:"))!;
    assertEquals(f.slice(f.indexOf("=") + 1).split(",").length <= 100, true);
    assertEquals(c.filters.includes(`eq:user_id=${TEST_USER}`), true);
  }
});
