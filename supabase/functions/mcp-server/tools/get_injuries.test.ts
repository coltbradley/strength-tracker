import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetInjuries } from "./get_injuries.ts";

Deno.test(
  "lists injuries owner-scoped with their check-ins inline",
  async () => {
    const t = toolHarness(registerGetInjuries, "get_injuries", {
      v_injury_state: [
        {
          episode_id: "ep1",
          body_region: "Knee",
          side: "left",
          state: "active",
        },
        {
          episode_id: "ep2",
          body_region: "Hip",
          side: "right",
          state: "quiet",
        },
      ],
      checkins: [
        {
          episode_id: "ep1",
          recorded_at: "2026-09-15T08:00:00Z",
          note: "stairs",
          energy: 3,
          training_impact: "modified",
        },
      ],
    });
    const body = payload(await t.run({}));
    assertEquals(t.calls[0].table, "v_injury_state");
    assertEquals(t.calls[0].filters, [`eq:user_id=${TEST_USER}`]);
    assertEquals(t.calls[1].table, "checkins");
    assertEquals(t.calls[1].filters, [
      `eq:user_id=${TEST_USER}`,
      "in:episode_id=ep1,ep2",
    ]);
    assertEquals(body.data.injuries[0].checkins.length, 1);
    assertEquals(body.data.injuries[1].checkins, []);
  },
);

Deno.test("filters by state", async () => {
  const t = toolHarness(registerGetInjuries, "get_injuries");
  await t.run({ state: "quiet" });
  assertEquals(t.calls[0].filters.includes("eq:state=quiet"), true);
  assertEquals(t.calls.length, 1, "no check-in query with no injuries");
  await assertRejects(() =>
    toolHarness(registerGetInjuries, "get_injuries").run({ state: "healed" }),
  );
});

Deno.test("explains quiet and closed, and is read-only", () => {
  const t = toolHarness(registerGetInjuries, "get_injuries");
  assertEquals(t.meta.readOnly, true);
  const d = t.meta.description.toLowerCase();
  assertStringIncludes(d, "quiet");
  assertStringIncludes(d, "only the lifter closes");
});
