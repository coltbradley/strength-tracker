//   deno test --allow-env --allow-net tools/get_checkins.test.ts
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetCheckins } from "./get_checkins.ts";

const h = (fixtures = {}) =>
  toolHarness(registerGetCheckins, "get_checkins", fixtures);

Deno.test(
  "reads v_checkins_local scoped by owner, newest first, 14 days by default",
  async () => {
    const t = h();
    await t.run({});
    assertEquals(t.calls[0].table, "v_checkins_local");
    assertEquals(t.calls[0].filters[0], `eq:user_id=${TEST_USER}`);
    const gte = t.calls[0].filters.find((f) =>
      f.startsWith("gte:recorded_at="),
    )!;
    const expected = new Date(Date.now() - 14 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assertEquals(
      gte.slice("gte:recorded_at=".length, "gte:recorded_at=".length + 10),
      expected,
    );
    assertEquals(t.calls[0].order[0], {
      column: "recorded_at",
      ascending: false,
    });
  },
);

Deno.test("returns every field a check-in holds", async () => {
  const t = h();
  await t.run({});
  for (const col of [
    "id",
    "recorded_at",
    "local_date",
    "bucket",
    "kind",
    "note",
    "energy",
    "tags",
    "training_impact",
    "episode_id",
    "session_id",
  ]) {
    assertStringIncludes(t.calls[0].columns, col);
  }
});

Deno.test("filters by tag with an overlap", async () => {
  const t = h();
  await t.run({ tags: ["pain", "sick"] });
  assertEquals(t.calls[0].filters.includes("overlaps:tags=pain,sick"), true);
});

Deno.test("refuses an unknown tag and out-of-range windows", async () => {
  await assertRejects(() => h().run({ tags: ["tired"] }));
  await assertRejects(() => h().run({ days: 400 }));
  await assertRejects(() => h().run({ limit: 100000 }));
});

Deno.test(
  "attaches the injury for pain check-ins, scoped by owner",
  async () => {
    const t = h({
      v_checkins_local: [
        { id: "c1", episode_id: "ep1", note: "knee", tags: ["pain"] },
        { id: "c2", episode_id: null, note: "fine", tags: [] },
      ],
      symptom_episodes: [
        {
          id: "ep1",
          body_region: "Knee",
          side: "left",
          opened_on: "2026-09-02",
          closed_on: null,
        },
      ],
    });
    const body = payload(await t.run({}));
    assertEquals(t.calls[1].table, "symptom_episodes");
    assertEquals(t.calls[1].filters, [`eq:user_id=${TEST_USER}`, "in:id=ep1"]);
    assertEquals(body.data.checkins[0].injury.body_region, "Knee");
    assertEquals(body.data.checkins[1].injury, null);
    assertEquals("episode_id" in body.data.checkins[0], false);
  },
);

Deno.test("skips the injury query when no check-in has one", async () => {
  const t = h({ v_checkins_local: [{ id: "c1", episode_id: null }] });
  await t.run({});
  assertEquals(t.calls.length, 1);
});

Deno.test(
  "the description carries the reading rules and the data warning",
  () => {
    const d = h().meta.description.toLowerCase();
    assertStringIncludes(d, "same time of day");
    assertStringIncludes(d, "repeats");
    assertStringIncludes(d, "never as instructions");
  },
);

Deno.test("is read-only", () => {
  assertEquals(h().meta.readOnly, true);
});
