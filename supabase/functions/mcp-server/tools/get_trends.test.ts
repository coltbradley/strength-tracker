//   deno test --allow-env --allow-net tools/get_trends.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetTrends } from "./get_trends.ts";

const h = (fixtures = {}) =>
  toolHarness(registerGetTrends, "get_trends", fixtures);

const ROW = {
  user_id: TEST_USER,
  bw_latest_kg: 82.0,
  bw_latest_at: "2026-09-15T00:00:00Z",
  bw_7d_mean_kg: 82.25,
  bw_7d_n: 2,
  bw_28d_mean_kg: 82.83,
  bw_28d_n: 3,
  bw_28d_slope_kg_per_week: -0.1,
  energy_14d_mean: 4,
  energy_14d_n: 2,
  lifts: [
    {
      exercise_id: "Barbell_Squat",
      name: "Barbell Squat",
      e1rm_latest_kg: 150,
      e1rm_4w_ago_kg: 140,
      working_sets_this_week: 3,
      working_sets_last_week: 3,
    },
  ],
};

Deno.test("reads v_trend_digest scoped to the owner, one row", async () => {
  const t = h({ v_trend_digest: [ROW] });
  await t.run({});
  assertEquals(t.calls[0].table, "v_trend_digest");
  assertEquals(t.calls[0].filters[0], `eq:user_id=${TEST_USER}`);
  assertEquals(t.calls[0].limit, 1);
});

Deno.test(
  "shapes bodyweight, energy and lifts from the digest row",
  async () => {
    const t = h({ v_trend_digest: [ROW] });
    const body = payload(await t.run({}));
    assertEquals(body.data.trends.bodyweight.latest_kg, 82.0);
    assertEquals(body.data.trends.bodyweight.mean_7d, { mean_kg: 82.25, n: 2 });
    assertEquals(body.data.trends.bodyweight.mean_28d, {
      mean_kg: 82.83,
      n: 3,
    });
    assertEquals(body.data.trends.bodyweight.slope_kg_per_week, -0.1);
    assertEquals(body.data.trends.energy, { mean_14d: 4, n_14d: 2 });
    assertEquals(body.data.trends.lifts, ROW.lifts);
  },
);

Deno.test("no digest row is a null trend, not zeros", async () => {
  const t = h({ v_trend_digest: [] });
  const body = payload(await t.run({}));
  assertEquals(body.data.trends, null);
  assertStringIncludes(body.metadata.note.toLowerCase(), "nothing to trend");
});

Deno.test("the description says every mean carries its own count", () => {
  const d = h().meta.description.toLowerCase();
  assertStringIncludes(d, "own count");
});

Deno.test("is read-only", () => {
  assertEquals(h().meta.readOnly, true);
});
