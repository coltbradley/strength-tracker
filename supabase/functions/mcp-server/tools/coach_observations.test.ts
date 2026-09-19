//   deno test --allow-env --allow-net tools/coach_observations.test.ts
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import { ToolError } from "../lib/errors.ts";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import {
  assertResolveShape,
  registerCoachObservations,
} from "./coach_observations.ts";

const h = (name: string, fixtures = {}) =>
  toolHarness(registerCoachObservations, name, fixtures);

// --- assertResolveShape (pure) -----------------------------------------------

Deno.test("superseded without superseded_by is refused", () => {
  const err = assertThrows(
    () => assertResolveShape("superseded", undefined),
    ToolError,
  );
  assertEquals(err.message.includes("superseded_by"), true);
});

Deno.test("resolved with a superseded_by is refused", () => {
  const err = assertThrows(
    () =>
      assertResolveShape("resolved", "11111111-1111-4111-8111-111111111111"),
    ToolError,
  );
  assertEquals(err.message.includes("only meaningful"), true);
});

Deno.test(
  "superseded with superseded_by, and resolved with none, both pass",
  () => {
    assertResolveShape("superseded", "11111111-1111-4111-8111-111111111111");
    assertResolveShape("resolved", undefined);
  },
);

// --- record_observation -------------------------------------------------------

Deno.test(
  "inserts stamped with the owner, status open, evidence defaulted to {}",
  async () => {
    const t = h("record_observation", {
      coach_observations: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          topic: "bodyweight",
          observation: "Down 1.8 kg over 28 days",
          check_back_on: "2026-10-01",
          created_at: "2026-09-16T00:00:00Z",
        },
      ],
    });
    await t.run({
      topic: "bodyweight",
      observation: "Down 1.8 kg over 28 days",
      check_back_on: "2026-10-01",
    });
    const insert = t.calls[0].insert as Record<string, unknown>;
    assertEquals(insert.user_id, TEST_USER);
    assertEquals(insert.status, "open");
    assertEquals(insert.evidence, {});
    assertEquals(insert.recommendation, null);
  },
);

Deno.test("passes evidence through untouched when given", async () => {
  const t = h("record_observation", { coach_observations: [{ id: "x" }] });
  await t.run({
    topic: "lift",
    observation: "e1RM jumped 22% in one session",
    evidence: { bw_28d_slope_kg_per_week: -0.45 },
  });
  const insert = t.calls[0].insert as Record<string, unknown>;
  assertEquals(insert.evidence, { bw_28d_slope_kg_per_week: -0.45 });
});

Deno.test("record_observation is not read-only", () => {
  assertEquals(h("record_observation").meta.readOnly, false);
});

// --- resolve_observation -------------------------------------------------------

Deno.test("resolves scoped to id and owner, stamping resolved_at", async () => {
  const t = h("resolve_observation", {
    coach_observations: [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", status: "resolved" },
    ],
  });
  await t.run({
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    status: "resolved",
    outcome: "Fueling was intentional; bodyweight stable since",
  });
  assertEquals(t.calls[0].filters.includes(`eq:user_id=${TEST_USER}`), true);
  assertEquals(
    t.calls[0].filters.includes("eq:id=aaaaaaaa-0000-4000-8000-000000000001"),
    true,
  );
  const update = t.calls[0].update as Record<string, unknown>;
  assertEquals(update.status, "resolved");
  assertEquals(update.superseded_by, null);
  assertEquals(typeof update.resolved_at, "string");
});

Deno.test(
  "no matching row is a ToolError naming get_observations",
  async () => {
    const t = h("resolve_observation", { coach_observations: [] });
    const result = await t.run({
      id: "aaaaaaaa-0000-4000-8000-000000000099",
      status: "resolved",
    });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "get_observations");
  },
);

Deno.test(
  "superseded without superseded_by is refused before any write",
  async () => {
    const t = h("resolve_observation", { coach_observations: [{ id: "x" }] });
    const result = await t.run({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      status: "superseded",
    });
    assertEquals(result.isError, true);
    assertEquals(
      t.calls.length,
      0,
      "nothing was queried before the validation failed",
    );
  },
);

// --- get_observations -----------------------------------------------------------

Deno.test(
  "reads coach_observations scoped by owner, newest first",
  async () => {
    const t = h("get_observations", {
      coach_observations: [{ id: "1", topic: "lift", status: "open" }],
    });
    await t.run({});
    assertEquals(t.calls[0].table, "coach_observations");
    assertEquals(t.calls[0].filters[0], `eq:user_id=${TEST_USER}`);
    assertEquals(t.calls[0].order[0], {
      column: "created_at",
      ascending: false,
    });
  },
);

Deno.test("filters by status when given", async () => {
  const t = h("get_observations", { coach_observations: [] });
  await t.run({ status: "open" });
  assertEquals(t.calls[0].filters.includes("eq:status=open"), true);
});

Deno.test("no status filter when omitted", async () => {
  const t = h("get_observations", { coach_observations: [] });
  await t.run({});
  assertEquals(
    t.calls[0].filters.some((f) => f.startsWith("eq:status=")),
    false,
  );
});

Deno.test("get_observations is read-only", () => {
  assertEquals(h("get_observations").meta.readOnly, true);
});
