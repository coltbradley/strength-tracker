//   deno test --allow-env --allow-net tools/get_recent_sessions.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetRecentSessions } from "./get_recent_sessions.ts";

const SESSION_ID = "44444444-0000-4000-8000-000000000001";

const h = (fixtures: Record<string, unknown[]> = {}) =>
  toolHarness(registerGetRecentSessions, "get_recent_sessions", fixtures);

const baseFixtures = (): Record<string, unknown[]> => ({
  sessions: [
    {
      id: SESSION_ID,
      started_at: "2026-09-16T09:00:00Z",
      ended_at: "2026-09-16T10:00:00Z",
      session_rpe: 7,
      bodyweight_kg: null,
      notes: null,
      planned_workouts: null,
    },
  ],
  v_session_set_counts: [
    { session_id: SESSION_ID, total_sets: 5, working_sets: 3 },
  ],
  session_skips: [],
});

Deno.test(
  "reads sessions scoped by owner, newest first, excluding discarded",
  async () => {
    const t = h(baseFixtures());
    await t.run({});
    assertEquals(t.calls[0].table, "sessions");
    assertEquals(t.calls[0].filters.includes(`eq:user_id=${TEST_USER}`), true);
    assertEquals(t.calls[0].filters.includes("is:discarded_at=null"), true);
    assertEquals(t.calls[0].order[0], {
      column: "started_at",
      ascending: false,
    });
  },
);

Deno.test(
  "every session carries its skips, empty when none were recorded",
  async () => {
    const t = h(baseFixtures());
    const body = payload(await t.run({}));
    assertEquals(body.sessions[0].skips, []);
  },
);

Deno.test(
  "skips are read from session_skips, scoped by owner and this batch of sessions",
  async () => {
    const f = baseFixtures();
    f.session_skips = [
      {
        session_id: SESSION_ID,
        exercise_id: "Barbell_Deadlift",
        scope: "exercise",
        reason: "Equipment taken",
      },
    ];
    const t = h(f);
    const body = payload(await t.run({}));
    assertEquals(body.sessions[0].skips, [
      {
        exercise_id: "Barbell_Deadlift",
        scope: "exercise",
        reason: "Equipment taken",
      },
    ]);
    const skipCall = t.calls.find((c) => c.table === "session_skips")!;
    assertEquals(skipCall.filters.includes(`eq:user_id=${TEST_USER}`), true);
    assertEquals(
      skipCall.filters.includes(`in:session_id=${SESSION_ID}`),
      true,
    );
  },
);

Deno.test("no session_skips query when there are no sessions", async () => {
  const t = h({ sessions: [] });
  await t.run({});
  assertEquals(
    t.calls.some((c) => c.table === "session_skips"),
    false,
  );
});

Deno.test(
  "total_sets and working_sets come from v_session_set_counts",
  async () => {
    const t = h(baseFixtures());
    const body = payload(await t.run({}));
    assertEquals(body.sessions[0].total_sets, 5);
    assertEquals(body.sessions[0].working_sets, 3);
  },
);

Deno.test(
  "the description explains the skip reasons and frames them as context",
  () => {
    const d = h().meta.description.toLowerCase();
    assertStringIncludes(d, "skipped");
    assertStringIncludes(d, "never a completion score");
  },
);

Deno.test("is read-only", () => {
  assertEquals(h().meta.readOnly, true);
});
