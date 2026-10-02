//   deno test --allow-env --allow-net lib/lastTime.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import { lastTimeFor } from "./lastTime.ts";
import { fakeDb, TEST_USER } from "./testing.ts";

const dbWith = (fixtures: Record<string, unknown[]>) => fakeDb(fixtures);

const DAY = "day-1";
const session = (id: string, started_at: string) => ({
  id,
  planned_workout_id: DAY,
  started_at,
  ended_at: null,
  session_rpe: null,
  notes: null,
});
const set = (id: string, session_id: string, exercise_id = "Barbell_Squat") => ({
  id,
  session_id,
  exercise_id,
  set_index: 0,
  set_type: "working",
  load_kg: 100,
  load_entry: "total",
  entered_load: null,
  entered_unit: null,
  reps: 5,
  performed_at: "2026-09-10T10:00:00Z",
});

Deno.test("MCP-8: an empty newer session does not mask the real last session", async () => {
  const { db } = dbWith({
    sessions: [
      session("empty-new", "2026-09-20T09:00:00Z"),
      session("real-old", "2026-09-10T09:00:00Z"),
    ],
    v_live_sets: [set("s1", "real-old")],
    exercises: [{ id: "Barbell_Squat", name: "Barbell Squat" }],
  });
  const { byDay } = await lastTimeFor(db, [DAY]);
  const last = byDay.get(DAY);
  assertEquals(last?.session.id, "real-old");
  assertEquals(last?.sets.length, 1);
});

Deno.test("MCP-8: a day whose only sessions are empty reads as never trained", async () => {
  const { db } = dbWith({
    sessions: [session("empty-a", "2026-09-20T09:00:00Z")],
    v_live_sets: [],
  });
  const { byDay } = await lastTimeFor(db, [DAY]);
  assertEquals(byDay.has(DAY), false);
});

Deno.test("MCP-8: the newest session WITH sets wins when both have sets", async () => {
  const { db } = dbWith({
    sessions: [
      session("new", "2026-09-20T09:00:00Z"),
      session("old", "2026-09-10T09:00:00Z"),
    ],
    v_live_sets: [set("a", "new"), set("b", "old")],
    exercises: [{ id: "Barbell_Squat", name: "Barbell Squat" }],
  });
  const { byDay } = await lastTimeFor(db, [DAY]);
  assertEquals(byDay.get(DAY)?.session.id, "new");
});

Deno.test("MCP-4: lastTimeFor chunks a long day-id list", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `d-${i}`);
  const { db, calls } = dbWith({ sessions: [] });
  await lastTimeFor(db, ids);
  const sessionCalls = calls.filter((c) => c.table === "sessions");
  assertEquals(sessionCalls.length, 3);
  for (const c of sessionCalls) {
    const f = c.filters.find((x) => x.startsWith("in:"))!;
    assertEquals(f.slice(f.indexOf("=") + 1).split(",").length <= 100, true);
    assertEquals(c.filters.includes(`eq:user_id=${TEST_USER}`), true);
  }
});
