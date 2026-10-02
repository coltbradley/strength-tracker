//   deno test --allow-env --allow-net tools/update_planned_workout.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { toolHarness } from "../lib/testing.ts";
import { registerUpdatePlannedWorkout } from "./update_planned_workout.ts";

const DAY = "22222222-0000-4000-8000-000000000001";

const dayFixture = {
  planned_workouts: [
    {
      id: DAY,
      label: "Pull",
      scheduled_date: "2026-09-20",
      is_template: false,
      programs: { id: "p1", name: "Split", confirmed_at: null },
    },
  ],
};

const withRpcError = (error: {
  code: string;
  message: string;
  hint?: string;
}) =>
  toolHarness(
    registerUpdatePlannedWorkout,
    "update_planned_workout",
    dayFixture,
    undefined,
    undefined,
    {
      rpc: {
        replace_planned_workout_prescriptions: () => ({ error }),
      },
    },
  );

Deno.test(
  "MCP-3: an open-session lock (55000) is a ToolError carrying the DB hint",
  async () => {
    const t = withRpcError({
      code: "55000",
      message: "planned workout has an open session",
      hint: "Finish or discard the active session before changing the planned workout.",
    });
    const res = await t.run({ planned_workout_id: DAY, label: "Pull B" });
    assertEquals(res.isError, true);
    const text = res.content[0].text;
    assert(!text.includes("Unexpected server error"), text);
    assertStringIncludes(text, "open session");
    assertStringIncludes(text, "Finish or discard the active session");
  },
);

Deno.test(
  "MCP-3: a trained-history lock (23001) is a ToolError too",
  async () => {
    const t = withRpcError({
      code: "23001",
      message: "planned day is referenced by a session",
      hint: "Keep the planned day intact so any queued sets can sync against it, or edit a future day.",
    });
    const res = await t.run({ planned_workout_id: DAY, label: "Pull B" });
    const text = res.content[0].text;
    assert(!text.includes("Unexpected server error"), text);
    assertStringIncludes(text, "edit a future day");
  },
);

Deno.test(
  "MCP-3: an unrelated rpc error stays a generic server error",
  async () => {
    const t = withRpcError({ code: "XX000", message: "boom" });
    const res = await t.run({ planned_workout_id: DAY, label: "Pull B" });
    assertStringIncludes(res.content[0].text, "Unexpected server error");
  },
);
