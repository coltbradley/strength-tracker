//   deno test --allow-env --allow-net tools/get_lift_history.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import { payload, toolHarness } from "../lib/testing.ts";
import { registerGetLiftHistory } from "./get_lift_history.ts";

/** Longest `in:` id list any recorded query on `table` sent. */
export function maxInList(
  calls: { table: string; filters: string[] }[],
  table: string,
): number {
  let max = 0;
  for (const c of calls) {
    if (c.table !== table) continue;
    for (const f of c.filters) {
      if (!f.startsWith("in:")) continue;
      max = Math.max(max, f.slice(f.indexOf("=") + 1).split(",").length);
    }
  }
  return max;
}

Deno.test("MCP-4: get_lift_history chunks the set_notes id list and still merges every note", async () => {
  const sets = Array.from({ length: 250 }, (_, i) => ({
    id: `set-${i}`,
    session_id: "s1",
    set_index: i,
    performed_at: `2026-09-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
  }));
  const t = toolHarness(registerGetLiftHistory, "get_lift_history", {
    exercises: [{
      id: "Barbell_Squat",
      name: "Barbell Squat",
      source: "curated",
      exercise_owners: null,
    }],
    v_live_sets: sets,
    set_notes: [
      { set_id: "set-0", note: "first" },
      { set_id: "set-249", note: "last" },
    ],
  });
  const res = await t.run({ exercise_id: "Barbell_Squat", since: "2026-01-01" });
  assertEquals(maxInList(t.calls, "set_notes") <= 100, true);
  assertEquals(t.calls.filter((c) => c.table === "set_notes").length, 3);
  const body = payload(res);
  const byId = new Map(
    body.sets.map((s: { id: string; note?: string }) => [s.id, s.note]),
  );
  assertEquals(byId.get("set-0"), "first");
  assertEquals(byId.get("set-249"), "last");
});
