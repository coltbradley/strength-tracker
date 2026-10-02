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

Deno.test("MCP-5: include_sets reads newest-first so the cap cuts the OLDEST sets, and returns each session oldest-first", async () => {
  const f = baseFixtures();
  // As a desc-ordered query would return them.
  f.v_live_sets = [
    { id: "c", session_id: SESSION_ID, exercise_id: "X", set_index: 2, performed_at: "2026-09-16T09:30:00Z" },
    { id: "b", session_id: SESSION_ID, exercise_id: "X", set_index: 1, performed_at: "2026-09-16T09:20:00Z" },
    { id: "a", session_id: SESSION_ID, exercise_id: "X", set_index: 0, performed_at: "2026-09-16T09:10:00Z" },
  ];
  const t = h(f);
  const body = payload(await t.run({ include_sets: true }));
  const setsCall = t.calls.find((c) => c.table === "v_live_sets")!;
  assertEquals(setsCall.order[0], { column: "performed_at", ascending: false });
  assertEquals(
    body.sessions[0].sets.map((s: { id: string }) => s.id),
    ["a", "b", "c"],
  );
});

Deno.test("MCP-4: include_sets chunks the set_notes id list", async () => {
  const f = baseFixtures();
  f.v_live_sets = Array.from({ length: 250 }, (_, i) => ({
    id: `set-${i}`,
    session_id: SESSION_ID,
    exercise_id: "X",
    set_index: i,
    performed_at: "2026-09-16T09:10:00Z",
  }));
  f.set_notes = [{ set_id: "set-249", note: "tweaky" }];
  const t = h(f);
  const body = payload(await t.run({ include_sets: true }));
  const noteCalls = t.calls.filter((c) => c.table === "set_notes");
  assertEquals(noteCalls.length, 3);
  for (const c of noteCalls) {
    const list = c.filters.find((x) => x.startsWith("in:"))!;
    assertEquals(list.slice(list.indexOf("=") + 1).split(",").length <= 100, true);
  }
  const last = body.sessions[0].sets.find((s: { id: string }) => s.id === "set-249");
  assertEquals(last.note, "tweaky");
});
