import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetCheckinBuckets } from "./get_checkin_buckets.ts";

const h = () => toolHarness(registerGetCheckinBuckets, "get_checkin_buckets");

Deno.test(
  "reads the bucket view for a date range, owner-scoped, oldest first",
  async () => {
    const t = h();
    await t.run({ from: "2026-09-01", to: "2026-09-14" });
    assertEquals(t.calls[0].table, "v_checkin_buckets");
    assertEquals(t.calls[0].filters, [
      `eq:user_id=${TEST_USER}`,
      "gte:local_date=2026-09-01",
      "lte:local_date=2026-09-14",
    ]);
    assertEquals(
      t.calls[0].order.map((o) => o.column),
      ["local_date", "bucket"],
    );
    for (const col of ["energy_mean", "energy_n", "checkins", "tags"]) {
      assertStringIncludes(t.calls[0].columns, col);
    }
  },
);

Deno.test("defaults to the last 28 days", async () => {
  const t = h();
  await t.run({});
  const from = t.calls[0].filters
    .find((f) => f.startsWith("gte:local_date="))!
    .split("=")[1];
  const to = t.calls[0].filters
    .find((f) => f.startsWith("lte:local_date="))!
    .split("=")[1];
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  assertEquals(days, 27);
  // Default `to` should be tomorrow in UTC to capture the latest local date.
  const expectedTo = new Date(Date.now() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  assertEquals(to, expectedTo);
});

Deno.test("refuses a malformed date and a range over a year", async () => {
  await assertRejects(() => h().run({ from: "Sept 1", to: "2026-09-14" }));
  const res = await h().run({ from: "2024-01-01", to: "2026-09-14" });
  assertEquals(res.isError, true);
});

Deno.test("refuses from after to", async () => {
  const res = await h().run({ from: "2026-09-20", to: "2026-09-15" });
  assertEquals(res.isError, true);
});

Deno.test("is read-only and says to compare like buckets", () => {
  const t = h();
  assertEquals(t.meta.readOnly, true);
  assertStringIncludes(t.meta.description.toLowerCase(), "same time of day");
});
