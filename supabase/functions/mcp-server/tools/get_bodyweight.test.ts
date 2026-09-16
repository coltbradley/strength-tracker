//   deno test --allow-env --allow-net tools/get_bodyweight.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetBodyweight } from "./get_bodyweight.ts";

const h = (fixtures = {}) =>
  toolHarness(registerGetBodyweight, "get_bodyweight", fixtures);

const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

Deno.test(
  "reads v_bodyweight scoped by owner, newest first, 90-day default",
  async () => {
    const t = h();
    await t.run({});
    assertEquals(t.calls[0].table, "v_bodyweight");
    assertEquals(t.calls[0].filters[0], `eq:user_id=${TEST_USER}`);
    const gte = t.calls[0].filters.find((f) =>
      f.startsWith("gte:measured_at="),
    )!;
    const expected = new Date(Date.now() - 90 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assertEquals(
      gte.slice("gte:measured_at=".length, "gte:measured_at=".length + 10),
      expected,
    );
    assertEquals(t.calls[0].order[0], {
      column: "measured_at",
      ascending: false,
    });
  },
);

Deno.test(
  "filters on measured_at when from/to are given, no 90-day gte",
  async () => {
    const t = h();
    await t.run({ from: "2026-09-01", to: "2026-09-10" });
    assertEquals(
      t.calls[0].filters.includes("gte:measured_at=2026-09-01"),
      true,
    );
    assertEquals(
      t.calls[0].filters.includes("lte:measured_at=2026-09-10"),
      true,
    );
  },
);

Deno.test("from after to is a ToolError", async () => {
  const result = await h().run({ from: "2026-09-10", to: "2026-09-01" });
  assertEquals(result.isError, true);
});

Deno.test("computes 7d and 28d means, each with its own count", async () => {
  const t = h({
    v_bodyweight: [
      { measured_at: iso(1), weight_kg: 82.0, source: "log", source_id: "a" },
      { measured_at: iso(3), weight_kg: 82.5, source: "log", source_id: "b" },
      {
        measured_at: iso(20),
        weight_kg: 84.0,
        source: "session",
        source_id: "c",
      },
    ],
  });
  const body = payload(await t.run({}));
  assertEquals(body.data.latest_kg, 82.0);
  assertEquals(body.data.mean_7d, { mean_kg: 82.25, n: 2 });
  assertEquals(body.data.mean_28d, { mean_kg: 82.83, n: 3 });
});

Deno.test("no points means null means, not a divide-by-zero", async () => {
  const t = h({ v_bodyweight: [] });
  const body = payload(await t.run({}));
  assertEquals(body.data.latest_kg, null);
  assertEquals(body.data.mean_7d, { mean_kg: null, n: 0 });
});

Deno.test("the description explains where the points come from", () => {
  const d = h().meta.description.toLowerCase();
  assertStringIncludes(d, "weigh-in log");
  assertStringIncludes(d, "finish");
});

Deno.test("is read-only", () => {
  assertEquals(h().meta.readOnly, true);
});
